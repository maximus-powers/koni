//! Koni-owned per-user credentials for the direct Pi runtime.
//!
//! Secret material is deliberately kept out of the public runtime/event
//! model. The Node host receives it only on the private credential-store
//! protocol and never through argv, environment variables, project state, or
//! durable logs. Persistence is anchored to the operating-system account's
//! conventional application-state location rather than a project or
//! executable path, so upgrades reuse one login without colliding with
//! project configuration.

use std::fmt;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::thread;
#[cfg(unix)]
use std::time::{Duration, Instant};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(unix)]
use std::ffi::{CStr, OsString};
#[cfg(unix)]
use std::os::unix::ffi::OsStringExt;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};

use crate::error::{KoniError, Result, io_error};

pub const PI_OAUTH_PROVIDER_ID: &str = "openai-codex";
#[cfg(target_os = "macos")]
const CREDENTIAL_DIRECTORY_NAME: &str = "Koni";
#[cfg(not(target_os = "macos"))]
const CREDENTIAL_DIRECTORY_NAME: &str = "koni";
const CREDENTIAL_FILE_NAME: &str = "auth.json";
const CREDENTIAL_TEMP_PREFIX: &str = ".auth.json.tmp-";
const MAX_CREDENTIAL_BYTES: usize = 64 * 1024;
#[cfg(unix)]
const CREDENTIAL_LOCK_TIMEOUT: Duration = Duration::from_secs(5);

/// Non-secret status data that can safely be shown in the CLI and TUI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PiCredentialMetadata {
    pub provider: String,
    pub credential_type: String,
    pub expires_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

const FILE_ENVELOPE_SCHEMA_VERSION: u16 = 1;

/// Validated OAuth JSON destined for Pi's private `CredentialStore` bridge.
///
/// Debug output is always redacted, and the allocation is overwritten on
/// drop. This type is intentionally not serializable by serde: callers must
/// opt into the narrowly scoped `expose_bytes` method.
pub(crate) struct PiCredentialMaterial {
    bytes: Vec<u8>,
    metadata: PiCredentialMetadata,
}

impl fmt::Debug for PiCredentialMaterial {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PiCredentialMaterial")
            .field("provider", &self.metadata.provider)
            .field("credential_type", &self.metadata.credential_type)
            .field("expires_at_ms", &self.metadata.expires_at_ms)
            .field("secret", &"<redacted>")
            .finish()
    }
}

impl Drop for PiCredentialMaterial {
    fn drop(&mut self) {
        self.bytes.fill(0);
    }
}

impl PiCredentialMaterial {
    pub(crate) fn from_json_bytes(provider: &str, bytes: Vec<u8>) -> Result<Self> {
        validate_provider(provider)?;
        if bytes.is_empty() || bytes.len() > MAX_CREDENTIAL_BYTES {
            return Err(auth_error("OAuth credential has an invalid encoded size"));
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| auth_error("OAuth credential is not valid JSON"))?;
        let object = value
            .as_object()
            .ok_or_else(|| auth_error("OAuth credential must be a JSON object"))?;
        if object.get("type").and_then(Value::as_str) != Some("oauth") {
            return Err(auth_error(
                "Koni accepts only subscription OAuth credentials for the Pi runtime",
            ));
        }
        for field in ["access", "refresh"] {
            if object
                .get(field)
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                return Err(auth_error(format!(
                    "OAuth credential is missing its {field} field"
                )));
            }
        }
        let expires_at_ms = object
            .get("expires")
            .and_then(Value::as_u64)
            .ok_or_else(|| auth_error("OAuth credential has no valid expiry"))?;
        let account_id = object
            .get("accountId")
            .or_else(|| object.get("account_id"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        Ok(Self {
            bytes,
            metadata: PiCredentialMetadata {
                provider: provider.to_owned(),
                credential_type: "oauth".to_owned(),
                expires_at_ms,
                account_id,
            },
        })
    }

    pub(crate) fn expose_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub(crate) fn metadata(&self) -> &PiCredentialMetadata {
        &self.metadata
    }
}

/// Per-user credential broker backed by Koni's owner-only account file.
///
/// Production deliberately has no environment or project path override. A
/// private injected path exists only for focused storage tests.
#[derive(Debug, Clone, Default)]
pub struct PiCredentialBroker {
    credential_path: Option<PathBuf>,
}

impl PiCredentialBroker {
    pub fn status(&self) -> Result<Option<PiCredentialMetadata>> {
        let transaction = self.begin_modify(PI_OAUTH_PROVIDER_ID)?;
        Ok(transaction.current().map(|value| value.metadata().clone()))
    }

    pub fn delete(&self) -> Result<()> {
        let mut transaction = self.begin_modify(PI_OAUTH_PROVIDER_ID)?;
        transaction.delete()
    }

    pub(crate) fn read_revisioned(
        &self,
        provider: &str,
    ) -> Result<(u64, Option<PiCredentialMaterial>)> {
        let transaction = self.begin_modify(provider)?;
        let revision = transaction.revision();
        Ok((revision, transaction.into_current()?))
    }

    /// Begin Pi's serialized read-modify-write operation. The returned value
    /// holds a per-user, cross-process lock until commit, abort, or drop, so
    /// two runtime hosts cannot refresh the same rotating token concurrently.
    pub(crate) fn begin_modify(&self, provider: &str) -> Result<PiCredentialTransaction> {
        validate_provider(provider)?;
        let lock = credential_lock(provider)?;
        let path = self.resolved_credential_path()?;
        // Every conforming writer holds this UID-global lock. Therefore any
        // exact Koni temporary file still present after acquisition is a
        // crash remnant rather than an in-flight concurrent write.
        cleanup_stale_credential_temps(&path)?;
        let (revision, current) = read_file_envelope(provider, &path)?;
        Ok(PiCredentialTransaction {
            provider: provider.to_owned(),
            path,
            _lock: lock,
            revision,
            current,
            finished: false,
        })
    }

    fn resolved_credential_path(&self) -> Result<PathBuf> {
        self.credential_path
            .clone()
            .map(Ok)
            .unwrap_or_else(default_credential_path)
    }

    #[cfg(test)]
    fn at_path(path: PathBuf) -> Self {
        Self {
            credential_path: Some(path),
        }
    }
}

/// One cross-process serialized Pi `CredentialStore.modify` transaction.
pub(crate) struct PiCredentialTransaction {
    provider: String,
    path: PathBuf,
    _lock: File,
    revision: u64,
    current: Option<PiCredentialMaterial>,
    finished: bool,
}

impl fmt::Debug for PiCredentialTransaction {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PiCredentialTransaction")
            .field("provider", &self.provider)
            .field("has_current", &self.current.is_some())
            .field("revision", &self.revision)
            .field("finished", &self.finished)
            .finish()
    }
}

impl PiCredentialTransaction {
    pub(crate) fn revision(&self) -> u64 {
        self.revision
    }

    pub(crate) fn current(&self) -> Option<&PiCredentialMaterial> {
        self.current.as_ref()
    }

    pub(crate) fn into_current(mut self) -> Result<Option<PiCredentialMaterial>> {
        self.finished = true;
        Ok(self.current.take())
    }

    pub(crate) fn commit(
        &mut self,
        expected_revision: u64,
        next: PiCredentialMaterial,
    ) -> Result<u64> {
        if self.finished {
            return Err(auth_error("OAuth credential transaction is already closed"));
        }
        if next.metadata.provider != self.provider {
            return Err(auth_error(
                "OAuth credential transaction changed provider identity",
            ));
        }
        if expected_revision != self.revision {
            return Err(auth_error(format!(
                "OAuth credential revision changed: expected {expected_revision}, current {}",
                self.revision
            )));
        }
        // The UID-global lock is the primary serialization boundary. Re-read
        // the persistent envelope as a second fail-closed CAS guard so a
        // stale transaction can never overwrite a rotated refresh token.
        let persisted_revision = read_file_envelope(&self.provider, &self.path)?.0;
        validate_persisted_revision(self.revision, persisted_revision)?;
        let next_revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| auth_error("OAuth credential revision counter is exhausted"))?;
        let mut encoded = encode_file_envelope(next_revision, &next)?;
        let result = write_credential_file(&self.path, &encoded);
        encoded.fill(0);
        result?;
        self.current = Some(next);
        self.revision = next_revision;
        self.finished = true;
        Ok(next_revision)
    }

    pub(crate) fn abort(&mut self) {
        self.finished = true;
    }

    pub(crate) fn delete(&mut self) -> Result<()> {
        if self.finished {
            return Err(auth_error("OAuth credential transaction is already closed"));
        }
        let persisted_revision = read_file_envelope(&self.provider, &self.path)?.0;
        validate_persisted_revision(self.revision, persisted_revision)?;
        delete_credential_file(&self.path)?;
        self.current = None;
        self.finished = true;
        Ok(())
    }
}

fn decode_file_envelope(
    provider: &str,
    mut encoded: Vec<u8>,
) -> Result<(u64, Option<PiCredentialMaterial>)> {
    if encoded.is_empty() || encoded.len() > MAX_CREDENTIAL_BYTES {
        encoded.fill(0);
        return Err(auth_error(
            "stored OAuth credential has an invalid encoded size",
        ));
    }
    let value = serde_json::from_slice::<Value>(&encoded)
        .map_err(|_| auth_error("stored OAuth credential envelope is not valid JSON"));
    encoded.fill(0);
    let value = value?;
    let object = value
        .as_object()
        .ok_or_else(|| auth_error("stored OAuth credential envelope must be an object"))?;
    if object.get("schema_version").and_then(Value::as_u64)
        != Some(u64::from(FILE_ENVELOPE_SCHEMA_VERSION))
    {
        return Err(auth_error(
            "stored OAuth credential envelope has an unsupported schema",
        ));
    }
    let revision = object
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or_else(|| auth_error("stored OAuth credential envelope has no revision"))?;
    let Some(credential) = object.get("credential") else {
        return Ok((revision, None));
    };
    let bytes = serde_json::to_vec(credential)
        .map_err(|_| auth_error("stored OAuth credential could not be decoded"))?;
    Ok((
        revision,
        Some(PiCredentialMaterial::from_json_bytes(provider, bytes)?),
    ))
}

fn encode_file_envelope(revision: u64, credential: &PiCredentialMaterial) -> Result<Vec<u8>> {
    let credential = serde_json::from_slice::<Value>(credential.expose_bytes())
        .map_err(|_| auth_error("OAuth credential could not be encoded for file storage"))?;
    let encoded = serde_json::to_vec(&serde_json::json!({
        "schema_version": FILE_ENVELOPE_SCHEMA_VERSION,
        "revision": revision,
        "credential": credential,
    }))
    .map_err(|_| auth_error("OAuth credential envelope could not be encoded"))?;
    if encoded.len() > MAX_CREDENTIAL_BYTES {
        return Err(auth_error(
            "OAuth credential envelope exceeds its secure bound",
        ));
    }
    Ok(encoded)
}

fn validate_persisted_revision(expected: u64, current: u64) -> Result<()> {
    if current != expected {
        return Err(auth_error(format!(
            "OAuth credential revision changed in Koni storage: expected {expected}, current {current}"
        )));
    }
    Ok(())
}

fn validate_provider(provider: &str) -> Result<()> {
    if provider != PI_OAUTH_PROVIDER_ID {
        return Err(auth_error(format!(
            "unsupported Pi credential provider {provider:?}"
        )));
    }
    Ok(())
}

fn default_credential_path() -> Result<PathBuf> {
    Ok(credential_path_for_account_home(&account_home_directory()?))
}

fn credential_path_for_account_home(account_home: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        account_home
            .join("Library")
            .join("Application Support")
            .join(CREDENTIAL_DIRECTORY_NAME)
            .join(CREDENTIAL_FILE_NAME)
    }
    #[cfg(not(target_os = "macos"))]
    {
        account_home
            .join(".local")
            .join("state")
            .join(CREDENTIAL_DIRECTORY_NAME)
            .join(CREDENTIAL_FILE_NAME)
    }
}

#[cfg(unix)]
fn account_home_directory() -> Result<PathBuf> {
    const INITIAL_BUFFER_BYTES: usize = 16 * 1024;
    const MAX_BUFFER_BYTES: usize = 1024 * 1024;

    let uid = rustix::process::getuid().as_raw();
    let configured = unsafe { libc::sysconf(libc::_SC_GETPW_R_SIZE_MAX) };
    let mut capacity = usize::try_from(configured)
        .ok()
        .filter(|size| *size > 0)
        .unwrap_or(INITIAL_BUFFER_BYTES)
        .clamp(INITIAL_BUFFER_BYTES, MAX_BUFFER_BYTES);
    loop {
        let mut record = unsafe { std::mem::zeroed::<libc::passwd>() };
        let mut result = std::ptr::null_mut();
        let mut buffer = vec![0_u8; capacity];
        let status = unsafe {
            libc::getpwuid_r(
                uid,
                &raw mut record,
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &raw mut result,
            )
        };
        if status == libc::ERANGE && capacity < MAX_BUFFER_BYTES {
            capacity = capacity.saturating_mul(2).min(MAX_BUFFER_BYTES);
            continue;
        }
        if status != 0 {
            return Err(auth_error(format!(
                "could not resolve the operating-system account home: {}",
                std::io::Error::from_raw_os_error(status)
            )));
        }
        if result.is_null() || record.pw_dir.is_null() {
            return Err(auth_error(
                "the operating-system account has no credential home directory",
            ));
        }
        let bytes = unsafe { CStr::from_ptr(record.pw_dir) }.to_bytes();
        if bytes.is_empty() {
            return Err(auth_error(
                "the operating-system account has an empty credential home directory",
            ));
        }
        let home = PathBuf::from(OsString::from_vec(bytes.to_vec()));
        if !home.is_absolute() {
            return Err(auth_error(
                "the operating-system account credential home is not absolute",
            ));
        }
        return Ok(home);
    }
}

#[cfg(not(unix))]
fn account_home_directory() -> Result<PathBuf> {
    Err(auth_error(
        "Pi subscription OAuth currently requires macOS or Linux",
    ))
}

#[cfg(unix)]
struct CredentialDirectory {
    descriptor: rustix::fd::OwnedFd,
    path: PathBuf,
    file_name: OsString,
    uid: u32,
}

fn read_file_envelope(provider: &str, path: &Path) -> Result<(u64, Option<PiCredentialMaterial>)> {
    #[cfg(not(unix))]
    {
        let _ = (provider, path);
        Err(auth_error(
            "Pi subscription OAuth currently requires macOS or Linux",
        ))
    }
    #[cfg(unix)]
    {
        use rustix::fs::{FileType, Mode, OFlags, fstat, openat};
        use rustix::io::Errno;

        let directory = open_credential_directory(path)?;
        let descriptor = match openat(
            &directory.descriptor,
            &directory.file_name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        ) {
            Ok(descriptor) => descriptor,
            Err(Errno::NOENT) => return Ok((0, None)),
            Err(error) => {
                return Err(credential_file_error(
                    "open",
                    path,
                    std::io::Error::from(error),
                ));
            }
        };
        let stat = fstat(&descriptor)
            .map_err(|error| credential_file_error("inspect", path, std::io::Error::from(error)))?;
        validate_credential_stat(&stat, directory.uid, path, FileType::RegularFile, 0o600)?;
        let length = usize::try_from(stat.st_size)
            .ok()
            .filter(|length| *length <= MAX_CREDENTIAL_BYTES)
            .ok_or_else(|| auth_error("stored OAuth credential exceeds its 64 KiB bound"))?;
        let file = File::from(descriptor);
        let mut encoded = Vec::with_capacity(length);
        file.take((MAX_CREDENTIAL_BYTES as u64).saturating_add(1))
            .read_to_end(&mut encoded)
            .map_err(|error| credential_file_error("read", path, error))?;
        if encoded.len() > MAX_CREDENTIAL_BYTES {
            encoded.fill(0);
            return Err(auth_error(
                "stored OAuth credential exceeds its 64 KiB bound",
            ));
        }
        decode_file_envelope(provider, encoded)
    }
}

fn write_credential_file(path: &Path, encoded: &[u8]) -> Result<()> {
    if encoded.is_empty() || encoded.len() > MAX_CREDENTIAL_BYTES {
        return Err(auth_error(
            "OAuth credential envelope exceeds its 64 KiB bound",
        ));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err(auth_error(
            "Pi subscription OAuth currently requires macOS or Linux",
        ))
    }
    #[cfg(unix)]
    {
        use rustix::fs::{
            AtFlags, FileType, Mode, OFlags, fchmod, fstat, fsync, openat, renameat, statat,
            unlinkat,
        };

        let directory = open_credential_directory(path)?;
        validate_named_credential(&directory, path)?;
        let temporary_name = credential_temporary_name(uuid::Uuid::now_v7());
        let temporary_path = directory.path.join(&temporary_name);
        let result = (|| -> Result<()> {
            let descriptor = openat(
                &directory.descriptor,
                &temporary_name,
                OFlags::WRONLY
                    | OFlags::CREATE
                    | OFlags::EXCL
                    | OFlags::NOFOLLOW
                    | OFlags::CLOEXEC
                    | OFlags::NONBLOCK,
                Mode::RUSR | Mode::WUSR,
            )
            .map_err(|error| {
                credential_file_error("create temporary", &temporary_path, error.into())
            })?;
            fchmod(&descriptor, Mode::RUSR | Mode::WUSR).map_err(|error| {
                credential_file_error("set permissions on", &temporary_path, error.into())
            })?;
            let original = fstat(&descriptor)
                .map_err(|error| credential_file_error("inspect", &temporary_path, error.into()))?;
            validate_credential_stat(
                &original,
                directory.uid,
                &temporary_path,
                FileType::RegularFile,
                0o600,
            )?;
            let mut file = File::from(descriptor);
            file.write_all(encoded)
                .and_then(|()| file.sync_all())
                .map_err(|error| credential_file_error("write", &temporary_path, error))?;

            // Reject an unsafe destination rather than silently replacing it.
            // This is repeated immediately before publication to narrow the
            // validation/rename boundary.
            validate_named_credential(&directory, path)?;
            renameat(
                &directory.descriptor,
                &temporary_name,
                &directory.descriptor,
                &directory.file_name,
            )
            .map_err(|error| credential_file_error("publish", path, error.into()))?;
            fsync(&directory.descriptor)
                .map_err(|error| credential_file_error("sync directory for", path, error.into()))?;

            let published = statat(
                &directory.descriptor,
                &directory.file_name,
                AtFlags::SYMLINK_NOFOLLOW,
            )
            .map_err(|error| credential_file_error("inspect published", path, error.into()))?;
            validate_credential_stat(
                &published,
                directory.uid,
                path,
                FileType::RegularFile,
                0o600,
            )?;
            if original.st_dev != published.st_dev || original.st_ino != published.st_ino {
                return Err(auth_error(
                    "published OAuth credential does not match the atomically written file",
                ));
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = unlinkat(&directory.descriptor, &temporary_name, AtFlags::empty());
        }
        result
    }
}

fn credential_temporary_name(id: uuid::Uuid) -> std::ffi::OsString {
    std::ffi::OsString::from(format!("{CREDENTIAL_TEMP_PREFIX}{}", id.hyphenated()))
}

fn is_exact_credential_temporary_name(name: &std::ffi::OsStr) -> bool {
    let Some(encoded) = name.to_str() else {
        return false;
    };
    let Some(id_text) = encoded.strip_prefix(CREDENTIAL_TEMP_PREFIX) else {
        return false;
    };
    let Ok(id) = uuid::Uuid::parse_str(id_text) else {
        return false;
    };
    id.get_version_num() == 7 && id.hyphenated().to_string() == id_text
}

fn cleanup_stale_credential_temps(path: &Path) -> Result<()> {
    #[cfg(not(unix))]
    {
        let _ = path;
        Err(auth_error(
            "Pi subscription OAuth currently requires macOS or Linux",
        ))
    }
    #[cfg(unix)]
    {
        use rustix::fs::{AtFlags, Dir, FileType, fsync, statat, unlinkat};
        use rustix::io::Errno;

        let directory = open_credential_directory(path)?;
        let entries = Dir::read_from(&directory.descriptor).map_err(|error| {
            credential_file_error("scan temporary files in", &directory.path, error.into())
        })?;
        let mut removed_any = false;
        for entry in entries {
            let entry = entry.map_err(|error| {
                credential_file_error("scan temporary files in", &directory.path, error.into())
            })?;
            let name = OsString::from_vec(entry.file_name().to_bytes().to_vec());
            if !is_exact_credential_temporary_name(&name) {
                continue;
            }

            let candidate_path = directory.path.join(&name);
            let stat = match statat(&directory.descriptor, &name, AtFlags::SYMLINK_NOFOLLOW) {
                Ok(stat) => stat,
                Err(Errno::NOENT) => continue,
                Err(error) => {
                    return Err(credential_file_error(
                        "inspect stale temporary",
                        &candidate_path,
                        error.into(),
                    ));
                }
            };
            if !credential_stat_matches(&stat, directory.uid, FileType::RegularFile, 0o600) {
                // A lookalike with unsafe ownership, type, mode, or link
                // count is not ours to reinterpret or remove.
                continue;
            }
            match unlinkat(&directory.descriptor, &name, AtFlags::empty()) {
                Ok(()) => removed_any = true,
                Err(Errno::NOENT) => {}
                Err(error) => {
                    return Err(credential_file_error(
                        "remove stale temporary",
                        &candidate_path,
                        error.into(),
                    ));
                }
            }
        }
        if removed_any {
            fsync(&directory.descriptor).map_err(|error| {
                credential_file_error(
                    "sync after stale temporary cleanup in",
                    &directory.path,
                    error.into(),
                )
            })?;
        }
        Ok(())
    }
}

fn delete_credential_file(path: &Path) -> Result<()> {
    #[cfg(not(unix))]
    {
        let _ = path;
        Err(auth_error(
            "Pi subscription OAuth currently requires macOS or Linux",
        ))
    }
    #[cfg(unix)]
    {
        use rustix::fs::{AtFlags, fsync, unlinkat};
        use rustix::io::Errno;

        let directory = open_credential_directory(path)?;
        if !validate_named_credential(&directory, path)? {
            return Ok(());
        }
        match unlinkat(
            &directory.descriptor,
            &directory.file_name,
            AtFlags::empty(),
        ) {
            Ok(()) => {}
            Err(Errno::NOENT) => return Ok(()),
            Err(error) => {
                return Err(credential_file_error("delete", path, error.into()));
            }
        }
        fsync(&directory.descriptor)
            .map_err(|error| credential_file_error("sync directory for", path, error.into()))?;
        Ok(())
    }
}

#[cfg(unix)]
fn open_credential_directory(path: &Path) -> Result<CredentialDirectory> {
    use rustix::fs::{FileType, Mode, OFlags, fchmod, fstat, fsync, mkdirat, open, openat};
    use rustix::io::Errno;
    use std::path::Component;

    const DIRECTORY_FLAGS: OFlags = OFlags::RDONLY
        .union(OFlags::DIRECTORY)
        .union(OFlags::NOFOLLOW)
        .union(OFlags::CLOEXEC)
        .union(OFlags::NONBLOCK);

    if !path.is_absolute() || path.file_name() != Some(std::ffi::OsStr::new(CREDENTIAL_FILE_NAME)) {
        return Err(auth_error(
            "Koni credential storage path must be an absolute auth.json path",
        ));
    }
    let directory_path = path
        .parent()
        .ok_or_else(|| auth_error("Koni credential storage path has no parent"))?;
    if directory_path.file_name() != Some(std::ffi::OsStr::new(CREDENTIAL_DIRECTORY_NAME)) {
        return Err(auth_error(
            "Koni credential storage must use its owner-only platform state directory",
        ));
    }
    let base_path = directory_path
        .parent()
        .ok_or_else(|| auth_error("Koni credential directory has no platform-state parent"))?;
    ensure_credential_base_directory(base_path, path)?;
    let canonical_base = fs::canonicalize(base_path).map_err(|error| {
        credential_file_error("resolve platform state directory for", path, error)
    })?;
    let mut base = open(Path::new("/"), DIRECTORY_FLAGS, Mode::empty())
        .map_err(|error| credential_file_error("open filesystem root for", path, error.into()))?;
    for component in canonical_base.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                base = openat(&base, name, DIRECTORY_FLAGS, Mode::empty()).map_err(|error| {
                    credential_file_error("open account directory for", path, error.into())
                })?;
            }
            _ => {
                return Err(auth_error(
                    "Koni credential account directory is not a normalized absolute path",
                ));
            }
        }
    }

    let directory_name = directory_path
        .file_name()
        .expect("validated credential directory name");
    let descriptor = match openat(&base, directory_name, DIRECTORY_FLAGS, Mode::empty()) {
        Ok(descriptor) => descriptor,
        Err(Errno::NOENT) => {
            match mkdirat(&base, directory_name, Mode::RWXU) {
                Ok(()) | Err(Errno::EXIST) => {}
                Err(error) => {
                    return Err(credential_file_error(
                        "create",
                        directory_path,
                        error.into(),
                    ));
                }
            }
            fsync(&base).map_err(|error| {
                credential_file_error("sync account directory for", path, error.into())
            })?;
            openat(&base, directory_name, DIRECTORY_FLAGS, Mode::empty())
                .map_err(|error| credential_file_error("open", directory_path, error.into()))?
        }
        Err(error) => {
            return Err(credential_file_error("open", directory_path, error.into()));
        }
    };
    let uid = rustix::process::getuid().as_raw();
    let stat = fstat(&descriptor)
        .map_err(|error| credential_file_error("inspect", directory_path, error.into()))?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::Directory || stat.st_uid != uid {
        return Err(auth_error(format!(
            "unsafe Koni credential directory: {}",
            directory_path.display()
        )));
    }
    if stat.st_mode & 0o7777 != 0o700 {
        fchmod(&descriptor, Mode::RWXU)
            .map_err(|error| credential_file_error("secure", directory_path, error.into()))?;
        fsync(&descriptor)
            .map_err(|error| credential_file_error("sync", directory_path, error.into()))?;
        let secured = fstat(&descriptor)
            .map_err(|error| credential_file_error("reinspect", directory_path, error.into()))?;
        if secured.st_mode & 0o7777 != 0o700 {
            return Err(auth_error(format!(
                "Koni credential directory is not owner-only: {}",
                directory_path.display()
            )));
        }
    }
    Ok(CredentialDirectory {
        descriptor,
        path: directory_path.to_path_buf(),
        file_name: OsString::from(CREDENTIAL_FILE_NAME),
        uid,
    })
}

#[cfg(unix)]
fn ensure_credential_base_directory(base_path: &Path, credential_path: &Path) -> Result<()> {
    use rustix::fs::{FileType, Mode, OFlags, fstat, fsync, mkdirat, open, openat};
    use rustix::io::Errno;
    use std::path::Component;

    const DIRECTORY_FLAGS: OFlags = OFlags::RDONLY
        .union(OFlags::DIRECTORY)
        .union(OFlags::NOFOLLOW)
        .union(OFlags::CLOEXEC)
        .union(OFlags::NONBLOCK);

    let mut ancestor = base_path;
    let mut missing = Vec::new();
    let canonical_ancestor = loop {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => {
                break fs::canonicalize(ancestor).map_err(|error| {
                    credential_file_error(
                        "resolve existing platform state ancestor for",
                        credential_path,
                        error,
                    )
                })?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = ancestor.file_name().ok_or_else(|| {
                    auth_error("Koni credential platform state path has no existing ancestor")
                })?;
                missing.push(name.to_os_string());
                ancestor = ancestor.parent().ok_or_else(|| {
                    auth_error("Koni credential platform state path has no existing ancestor")
                })?;
            }
            Err(error) => {
                return Err(credential_file_error(
                    "inspect platform state directory for",
                    credential_path,
                    error,
                ));
            }
        }
    };

    let mut descriptor = open(Path::new("/"), DIRECTORY_FLAGS, Mode::empty()).map_err(|error| {
        credential_file_error("open filesystem root for", credential_path, error.into())
    })?;
    for component in canonical_ancestor.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                descriptor =
                    openat(&descriptor, name, DIRECTORY_FLAGS, Mode::empty()).map_err(|error| {
                        credential_file_error(
                            "open platform state ancestor for",
                            credential_path,
                            error.into(),
                        )
                    })?;
            }
            _ => {
                return Err(auth_error(
                    "Koni credential platform state path is not a normalized absolute path",
                ));
            }
        }
    }

    let uid = rustix::process::getuid().as_raw();
    for name in missing.iter().rev() {
        let next = match openat(&descriptor, name, DIRECTORY_FLAGS, Mode::empty()) {
            Ok(next) => next,
            Err(Errno::NOENT) => {
                match mkdirat(&descriptor, name, Mode::RWXU) {
                    Ok(()) | Err(Errno::EXIST) => {}
                    Err(error) => {
                        return Err(credential_file_error(
                            "create platform state directory for",
                            credential_path,
                            error.into(),
                        ));
                    }
                }
                fsync(&descriptor).map_err(|error| {
                    credential_file_error(
                        "sync platform state parent for",
                        credential_path,
                        error.into(),
                    )
                })?;
                openat(&descriptor, name, DIRECTORY_FLAGS, Mode::empty()).map_err(|error| {
                    credential_file_error(
                        "open platform state directory for",
                        credential_path,
                        error.into(),
                    )
                })?
            }
            Err(error) => {
                return Err(credential_file_error(
                    "open platform state directory for",
                    credential_path,
                    error.into(),
                ));
            }
        };
        let stat = fstat(&next).map_err(|error| {
            credential_file_error(
                "inspect platform state directory for",
                credential_path,
                error.into(),
            )
        })?;
        if FileType::from_raw_mode(stat.st_mode) != FileType::Directory || stat.st_uid != uid {
            return Err(auth_error(format!(
                "unsafe Koni credential platform state directory: {}",
                base_path.display()
            )));
        }
        descriptor = next;
    }
    Ok(())
}

#[cfg(unix)]
fn validate_named_credential(directory: &CredentialDirectory, path: &Path) -> Result<bool> {
    use rustix::fs::{AtFlags, FileType, statat};
    use rustix::io::Errno;

    match statat(
        &directory.descriptor,
        &directory.file_name,
        AtFlags::SYMLINK_NOFOLLOW,
    ) {
        Ok(stat) => {
            validate_credential_stat(&stat, directory.uid, path, FileType::RegularFile, 0o600)?;
            Ok(true)
        }
        Err(Errno::NOENT) => Ok(false),
        Err(error) => Err(credential_file_error("inspect", path, error.into())),
    }
}

#[cfg(unix)]
fn validate_credential_stat(
    stat: &rustix::fs::Stat,
    uid: u32,
    path: &Path,
    expected_type: rustix::fs::FileType,
    expected_mode: u32,
) -> Result<()> {
    if !credential_stat_matches(stat, uid, expected_type, expected_mode) {
        return Err(auth_error(format!(
            "unsafe Koni credential file: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn credential_stat_matches(
    stat: &rustix::fs::Stat,
    uid: u32,
    expected_type: rustix::fs::FileType,
    expected_mode: u32,
) -> bool {
    rustix::fs::FileType::from_raw_mode(stat.st_mode) == expected_type
        && stat.st_uid == uid
        && stat.st_nlink == 1
        && u32::from(stat.st_mode & 0o7777) == expected_mode
}

fn credential_file_error(action: &str, path: &Path, error: std::io::Error) -> KoniError {
    auth_error(format!(
        "could not {action} Koni credential storage {}: {error}",
        path.display()
    ))
}

fn credential_lock(provider: &str) -> Result<File> {
    #[cfg(not(unix))]
    {
        let _ = provider;
        return Err(auth_error(
            "Pi subscription OAuth currently requires macOS or Linux",
        ));
    }
    #[cfg(unix)]
    {
        let uid = rustix::process::getuid().as_raw();
        let root = credential_lock_root(uid)?;
        match fs::symlink_metadata(&root) {
            Ok(metadata) => validate_lock_directory(&root, &metadata, uid)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut builder = fs::DirBuilder::new();
                builder.mode(0o700);
                match builder.create(&root) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(io_error(&root, error)),
                }
                let metadata =
                    fs::symlink_metadata(&root).map_err(|error| io_error(&root, error))?;
                validate_lock_directory(&root, &metadata, uid)?;
            }
            Err(error) => return Err(io_error(&root, error)),
        }
        let path = root.join(format!("{provider}.lock"));
        let descriptor = rustix::fs::open(
            &path,
            rustix::fs::OFlags::RDWR
                | rustix::fs::OFlags::CREATE
                | rustix::fs::OFlags::CLOEXEC
                | rustix::fs::OFlags::NOFOLLOW,
            rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
        )
        .map_err(|error| io_error(&path, std::io::Error::from(error)))?;
        let file = File::from(descriptor);
        let metadata = file.metadata().map_err(|error| io_error(&path, error))?;
        if !metadata.is_file()
            || metadata.uid() != uid
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(auth_error(format!(
                "unsafe Pi credential lock file: {}",
                path.display()
            )));
        }
        let deadline = Instant::now() + CREDENTIAL_LOCK_TIMEOUT;
        loop {
            match FileExt::try_lock_exclusive(&file) {
                Ok(()) => break,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    return Err(auth_error(
                        "timed out waiting for another Pi credential transaction",
                    ));
                }
                Err(error) => return Err(io_error(&path, error)),
            }
        }
        Ok(file)
    }
}

#[cfg(unix)]
fn credential_lock_root(uid: u32) -> Result<PathBuf> {
    // Never derive this namespace from TMPDIR, HOME, XDG_RUNTIME_DIR, or any
    // other mutable process environment: every Koni process for one UID must
    // contend on the same kernel inode while updating the account credential.
    let system_tmp = fs::canonicalize("/tmp").map_err(|error| io_error("/tmp", error))?;
    let metadata = fs::metadata(&system_tmp).map_err(|error| io_error(&system_tmp, error))?;
    if !metadata.is_dir() {
        return Err(auth_error("the system temporary root is not a directory"));
    }
    Ok(system_tmp.join(format!("koni-credentials-{uid}")))
}

#[cfg(unix)]
fn validate_lock_directory(path: &Path, metadata: &fs::Metadata, uid: u32) -> Result<()> {
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != uid
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(auth_error(format!(
            "unsafe Pi credential lock directory: {}",
            path.display()
        )));
    }
    Ok(())
}

fn auth_error(message: impl Into<String>) -> KoniError {
    KoniError::Process(format!("Pi authentication failed: {}", message.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::fs::OpenOptions;
    #[cfg(unix)]
    use std::os::unix::fs::{OpenOptionsExt, symlink};
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    fn credential() -> PiCredentialMaterial {
        PiCredentialMaterial::from_json_bytes(
            PI_OAUTH_PROVIDER_ID,
            br#"{"type":"oauth","access":"access-secret","refresh":"refresh-secret","expires":42,"accountId":"acct-7"}"#
                .to_vec(),
        )
        .unwrap()
    }

    #[test]
    fn validates_subscription_oauth_and_exposes_only_safe_metadata() {
        let credential = credential();
        assert_eq!(credential.metadata().provider, PI_OAUTH_PROVIDER_ID);
        assert_eq!(credential.metadata().expires_at_ms, 42);
        assert_eq!(credential.metadata().account_id.as_deref(), Some("acct-7"));
        let debug = format!("{credential:?}");
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains("access-secret"));
        assert!(!debug.contains("refresh-secret"));
    }

    #[test]
    fn rejects_api_keys_and_malformed_credentials() {
        let api_key = PiCredentialMaterial::from_json_bytes(
            PI_OAUTH_PROVIDER_ID,
            br#"{"type":"api_key","key":"forbidden"}"#.to_vec(),
        )
        .unwrap_err();
        assert!(api_key.to_string().contains("only subscription OAuth"));

        let missing_refresh = PiCredentialMaterial::from_json_bytes(
            PI_OAUTH_PROVIDER_ID,
            br#"{"type":"oauth","access":"a","expires":1}"#.to_vec(),
        )
        .unwrap_err();
        assert!(missing_refresh.to_string().contains("refresh"));
    }

    #[test]
    fn provider_is_fixed_to_openai_codex() {
        let error = PiCredentialMaterial::from_json_bytes(
            "openai",
            br#"{"type":"oauth","access":"a","refresh":"r","expires":1}"#.to_vec(),
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("unsupported Pi credential provider")
        );
    }

    #[test]
    fn file_envelope_preserves_revision_without_exposing_api_keys() {
        let credential = credential();
        let mut encoded = encode_file_envelope(7, &credential).unwrap();
        let (revision, decoded) =
            decode_file_envelope(PI_OAUTH_PROVIDER_ID, encoded.clone()).unwrap();
        encoded.fill(0);
        assert_eq!(revision, 7);
        let decoded = decoded.unwrap();
        assert_eq!(decoded.metadata(), credential.metadata());
        assert!(
            PiCredentialMaterial::from_json_bytes(
                PI_OAUTH_PROVIDER_ID,
                br#"{"type":"api_key","key":"forbidden"}"#.to_vec(),
            )
            .is_err()
        );
    }

    #[test]
    fn persistent_revision_cas_rejects_a_stale_rotating_token_writer() {
        validate_persisted_revision(9, 9).unwrap();
        let error = validate_persisted_revision(9, 10).unwrap_err().to_string();
        assert!(error.contains("expected 9, current 10"));
    }

    #[test]
    #[cfg(unix)]
    fn account_file_round_trip_is_owner_only_atomic_and_deletable() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp
            .path()
            .join(CREDENTIAL_DIRECTORY_NAME)
            .join(CREDENTIAL_FILE_NAME);
        let broker = PiCredentialBroker::at_path(path.clone());

        let mut transaction = broker.begin_modify(PI_OAUTH_PROVIDER_ID).unwrap();
        assert_eq!(transaction.revision(), 0);
        assert!(transaction.current().is_none());
        assert_eq!(transaction.commit(0, credential()).unwrap(), 1);
        drop(transaction);

        let directory_mode = fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let file_mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(directory_mode, 0o700);
        assert_eq!(file_mode, 0o600);
        let temporary_files = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(std::result::Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .count();
        assert_eq!(temporary_files, 0);

        let (revision, stored) = broker.read_revisioned(PI_OAUTH_PROVIDER_ID).unwrap();
        assert_eq!(revision, 1);
        assert_eq!(stored.unwrap().metadata(), credential().metadata());
        broker.delete().unwrap();
        assert!(!path.exists());
        assert!(broker.status().unwrap().is_none());
    }

    #[test]
    #[cfg(unix)]
    fn account_store_rejects_file_and_directory_symlinks() {
        let file_case = tempfile::tempdir().unwrap();
        let file_directory = file_case.path().join(CREDENTIAL_DIRECTORY_NAME);
        fs::create_dir(&file_directory).unwrap();
        fs::set_permissions(&file_directory, fs::Permissions::from_mode(0o700)).unwrap();
        let target = file_case.path().join("target.json");
        write_raw_credential_file(&target, br#"{}"#);
        let file_path = file_directory.join(CREDENTIAL_FILE_NAME);
        symlink(&target, &file_path).unwrap();
        let error = PiCredentialBroker::at_path(file_path)
            .status()
            .unwrap_err()
            .to_string();
        assert!(error.contains("credential storage") || error.contains("unsafe"));

        let directory_case = tempfile::tempdir().unwrap();
        let real_directory = directory_case.path().join("real-koni");
        fs::create_dir(&real_directory).unwrap();
        fs::set_permissions(&real_directory, fs::Permissions::from_mode(0o700)).unwrap();
        symlink(
            &real_directory,
            directory_case.path().join(CREDENTIAL_DIRECTORY_NAME),
        )
        .unwrap();
        let error = PiCredentialBroker::at_path(
            directory_case
                .path()
                .join(CREDENTIAL_DIRECTORY_NAME)
                .join(CREDENTIAL_FILE_NAME),
        )
        .status()
        .unwrap_err()
        .to_string();
        assert!(error.contains("credential storage") || error.contains("unsafe"));
    }

    #[test]
    #[cfg(unix)]
    fn account_store_rejects_malformed_and_oversized_state() {
        let malformed_case = tempfile::tempdir().unwrap();
        let malformed_path = prepare_raw_store(malformed_case.path(), b"not-json");
        let malformed = PiCredentialBroker::at_path(malformed_path)
            .status()
            .unwrap_err()
            .to_string();
        assert!(malformed.contains("not valid JSON"));

        let oversized_case = tempfile::tempdir().unwrap();
        let oversized_path =
            prepare_raw_store(oversized_case.path(), &vec![b'x'; MAX_CREDENTIAL_BYTES + 1]);
        let oversized = PiCredentialBroker::at_path(oversized_path)
            .status()
            .unwrap_err()
            .to_string();
        assert!(oversized.contains("64 KiB"));
    }

    #[test]
    #[cfg(unix)]
    fn account_file_commit_revalidates_persistent_revision() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp
            .path()
            .join(CREDENTIAL_DIRECTORY_NAME)
            .join(CREDENTIAL_FILE_NAME);
        let broker = PiCredentialBroker::at_path(path.clone());
        let mut transaction = broker.begin_modify(PI_OAUTH_PROVIDER_ID).unwrap();
        let external = encode_file_envelope(9, &credential()).unwrap();
        write_credential_file(&path, &external).unwrap();

        let error = transaction.commit(0, credential()).unwrap_err().to_string();
        assert!(error.contains("expected 0, current 9"));
        drop(transaction);
        let (revision, _) = broker.read_revisioned(PI_OAUTH_PROVIDER_ID).unwrap();
        assert_eq!(revision, 9);
    }

    #[test]
    #[cfg(unix)]
    fn default_store_uses_platform_state_and_is_disjoint_from_home_projects() {
        let path = default_credential_path().unwrap();
        let home = account_home_directory().unwrap();
        #[cfg(target_os = "macos")]
        assert_eq!(
            path,
            home.join("Library/Application Support/Koni/auth.json")
        );
        #[cfg(not(target_os = "macos"))]
        assert_eq!(path, home.join(".local/state/koni/auth.json"));
        assert!(!path.starts_with(home.join(".koni")));
        assert!(!path.starts_with(home.join(".codex/koni")));
        assert!(!path.starts_with(home.join(".pi")));
    }

    #[test]
    #[cfg(unix)]
    fn stale_temp_cleanup_removes_only_exact_safe_koni_remnants() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp
            .path()
            .join(CREDENTIAL_DIRECTORY_NAME)
            .join(CREDENTIAL_FILE_NAME);
        let broker = PiCredentialBroker::at_path(path.clone());
        assert!(broker.status().unwrap().is_none());

        let directory = path.parent().unwrap();
        let stale = directory.join(credential_temporary_name(uuid::Uuid::now_v7()));
        write_raw_credential_file(&stale, b"stale-secret");

        let nonmatching = directory.join(format!(
            "{CREDENTIAL_TEMP_PREFIX}{}-copy",
            uuid::Uuid::now_v7().hyphenated()
        ));
        write_raw_credential_file(&nonmatching, b"not-koni-contract");

        let wrong_version = directory.join(".auth.json.tmp-67e55044-10b1-426f-9247-bb680e5fe0c8");
        write_raw_credential_file(&wrong_version, b"not-uuid-v7");

        let unsafe_match = directory.join(credential_temporary_name(uuid::Uuid::now_v7()));
        write_raw_credential_file(&unsafe_match, b"unsafe-mode");
        fs::set_permissions(&unsafe_match, fs::Permissions::from_mode(0o640)).unwrap();

        let symlink_target = directory.join("unrelated-target");
        write_raw_credential_file(&symlink_target, b"not-a-koni-temporary");
        let symlink_match = directory.join(credential_temporary_name(uuid::Uuid::now_v7()));
        symlink(&symlink_target, &symlink_match).unwrap();

        assert!(broker.status().unwrap().is_none());
        assert!(!stale.exists(), "validated stale Koni temporary survived");
        assert!(nonmatching.exists(), "similar nonmatching name was removed");
        assert!(wrong_version.exists(), "non-v7 temporary name was removed");
        assert!(unsafe_match.exists(), "unsafe lookalike was reinterpreted");
        assert!(
            fs::symlink_metadata(&symlink_match)
                .unwrap()
                .file_type()
                .is_symlink(),
            "symlink lookalike was followed or removed"
        );
        assert!(symlink_target.exists());
    }

    #[test]
    #[cfg(unix)]
    fn missing_platform_state_parents_are_created_owner_only() {
        let temp = tempfile::tempdir().unwrap();
        let state_root = temp.path().join("missing").join("state");
        let path = state_root
            .join(CREDENTIAL_DIRECTORY_NAME)
            .join(CREDENTIAL_FILE_NAME);
        let broker = PiCredentialBroker::at_path(path.clone());

        assert!(broker.status().unwrap().is_none());
        for directory in [
            temp.path().join("missing"),
            state_root,
            path.parent().unwrap().to_path_buf(),
        ] {
            let metadata = fs::symlink_metadata(&directory).unwrap();
            assert!(metadata.is_dir());
            assert!(!metadata.file_type().is_symlink());
            assert_eq!(metadata.uid(), rustix::process::getuid().as_raw());
            assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
        }
    }

    #[test]
    #[cfg(unix)]
    fn uid_lock_serializes_processes_with_distinct_tmpdir_values() {
        if let Some(mode) = std::env::var_os("KONI_PI_LOCK_TEST_MODE") {
            let acquired = PathBuf::from(
                std::env::var_os("KONI_PI_LOCK_TEST_ACQUIRED").expect("child acquired path"),
            );
            let release = PathBuf::from(
                std::env::var_os("KONI_PI_LOCK_TEST_RELEASE").expect("child release path"),
            );
            let _lock = credential_lock(PI_OAUTH_PROVIDER_ID).unwrap();
            fs::write(&acquired, b"acquired").unwrap();
            if mode == "hold" {
                let deadline = Instant::now() + Duration::from_secs(10);
                while !release.exists() && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(10));
                }
                assert!(release.exists(), "parent did not release child lock");
            }
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let first_tmp = temp.path().join("tmp-a");
        let second_tmp = temp.path().join("tmp-b");
        fs::create_dir(&first_tmp).unwrap();
        fs::create_dir(&second_tmp).unwrap();
        let first_acquired = temp.path().join("first-acquired");
        let second_acquired = temp.path().join("second-acquired");
        let release = temp.path().join("release");
        let executable = std::env::current_exe().unwrap();
        let exact =
            "pi_credentials::tests::uid_lock_serializes_processes_with_distinct_tmpdir_values";

        let mut first = Command::new(&executable)
            .args(["--exact", exact, "--nocapture"])
            .env("TMPDIR", &first_tmp)
            .env("KONI_PI_LOCK_TEST_MODE", "hold")
            .env("KONI_PI_LOCK_TEST_ACQUIRED", &first_acquired)
            .env("KONI_PI_LOCK_TEST_RELEASE", &release)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        wait_for_test_path(&first_acquired);

        let mut second = Command::new(&executable)
            .args(["--exact", exact, "--nocapture"])
            .env("TMPDIR", &second_tmp)
            .env("KONI_PI_LOCK_TEST_MODE", "probe")
            .env("KONI_PI_LOCK_TEST_ACQUIRED", &second_acquired)
            .env("KONI_PI_LOCK_TEST_RELEASE", &release)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        thread::sleep(Duration::from_millis(200));
        assert!(
            !second_acquired.exists(),
            "distinct TMPDIR values split the UID credential lock"
        );

        fs::write(&release, b"release").unwrap();
        assert!(first.wait().unwrap().success());
        assert!(second.wait().unwrap().success());
        assert!(second_acquired.exists());
    }

    #[cfg(unix)]
    fn wait_for_test_path(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !path.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(path.exists(), "timed out waiting for {}", path.display());
    }

    #[cfg(unix)]
    fn prepare_raw_store(root: &Path, bytes: &[u8]) -> PathBuf {
        let directory = root.join(CREDENTIAL_DIRECTORY_NAME);
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.join(CREDENTIAL_FILE_NAME);
        write_raw_credential_file(&path, bytes);
        path
    }

    #[cfg(unix)]
    fn write_raw_credential_file(path: &Path, bytes: &[u8]) {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .unwrap();
        file.write_all(bytes).unwrap();
        file.sync_all().unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
}
