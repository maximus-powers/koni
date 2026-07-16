//! Operating-system containment for the Koni-owned agent runtime host.
//!
//! Pi intentionally does not provide a permission system. Koni therefore
//! wraps the small Node host at the process boundary and continues to expose
//! product mutations only through compiler-owned tools.

use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use sha2::{Digest, Sha256};

use crate::error::{KoniError, Result, io_error};

const PI_BWRAP_BUILD_PATH: &str = env!("KONI_PINNED_BWRAP_PATH");
const PI_BWRAP_BUILD_CHECKSUM: &str = env!("KONI_PINNED_BWRAP_SHA256");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeContainmentPlatform {
    MacOs,
    Linux,
}

#[derive(Debug, Clone)]
pub struct RuntimeContainmentRequest {
    pub platform: RuntimeContainmentPlatform,
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub working_directory: PathBuf,
    /// Exact runtime/package roots the transport process may read. Product,
    /// control-state, credential, and home-directory roots must never appear
    /// here merely because the model host needs outbound network access.
    pub readable_roots: Vec<PathBuf>,
    pub writable_roots: Vec<PathBuf>,
    pub network_access: bool,
    /// Allow the short-lived OAuth control host to accept Pi's browser PKCE
    /// callback on localhost:1455. This is independent from outbound network
    /// access and must remain false for inference and model discovery.
    pub oauth_callback_access: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeContainmentCommand {
    pub executable: PathBuf,
    pub args: Vec<String>,
}

impl RuntimeContainmentRequest {
    pub fn for_current_platform(
        executable: impl Into<PathBuf>,
        working_directory: impl Into<PathBuf>,
    ) -> Result<Self> {
        let platform = if cfg!(target_os = "macos") {
            RuntimeContainmentPlatform::MacOs
        } else if cfg!(target_os = "linux") {
            RuntimeContainmentPlatform::Linux
        } else {
            return Err(KoniError::Process(
                "the Pi runtime is supported only with macOS Seatbelt or Linux bubblewrap containment"
                    .to_owned(),
            ));
        };
        Ok(Self {
            platform,
            executable: executable.into(),
            args: Vec::new(),
            working_directory: working_directory.into(),
            readable_roots: Vec::new(),
            writable_roots: Vec::new(),
            network_access: false,
            oauth_callback_access: false,
        })
    }

    pub fn compile(&self) -> Result<RuntimeContainmentCommand> {
        let executable = canonical_file(&self.executable, "Pi runtime executable")?;
        let working_directory =
            canonical_directory(&self.working_directory, "Pi runtime working directory")?;
        let mut readable_roots = self
            .readable_roots
            .iter()
            .map(|root| canonical_directory(root, "Pi runtime readable root"))
            .collect::<Result<Vec<_>>>()?;
        readable_roots.sort();
        readable_roots.dedup();
        let mut writable_roots = self
            .writable_roots
            .iter()
            .map(|root| canonical_directory(root, "Pi runtime writable root"))
            .collect::<Result<Vec<_>>>()?;
        writable_roots.sort();
        writable_roots.dedup();

        match self.platform {
            RuntimeContainmentPlatform::MacOs => compile_macos(
                &executable,
                &self.args,
                &working_directory,
                &readable_roots,
                &writable_roots,
                self.network_access,
                self.oauth_callback_access,
            ),
            RuntimeContainmentPlatform::Linux => compile_linux(
                &executable,
                &self.args,
                &working_directory,
                &readable_roots,
                &writable_roots,
                self.network_access,
                self.oauth_callback_access,
            ),
        }
    }
}

fn compile_macos(
    executable: &Path,
    args: &[String],
    working_directory: &Path,
    readable_roots: &[PathBuf],
    writable_roots: &[PathBuf],
    network_access: bool,
    oauth_callback_access: bool,
) -> Result<RuntimeContainmentCommand> {
    let sandbox_exec = PathBuf::from("/usr/bin/sandbox-exec");
    if !sandbox_exec.is_file() {
        return Err(KoniError::Process(
            "macOS Seatbelt launcher /usr/bin/sandbox-exec is unavailable".to_owned(),
        ));
    }
    let mut policy = String::from("(version 1)\n(deny default)\n(import \"system.sb\")\n");
    policy.push_str("(allow process-exec (literal \"");
    policy.push_str(&seatbelt_escape(executable)?);
    policy.push_str("\"))\n");
    // Node resolves its entrypoint before loading it. Seatbelt's `subpath`
    // grant does not authorize metadata reads of that path's ancestors, so a
    // canonical `/private/var/...` bundle would otherwise fail at `lstat
    // /private`. Grant only metadata on the exact ancestor directories; file
    // contents remain covered by the narrower literal/subpath rules below.
    let mut metadata_ancestors = BTreeSet::new();
    for path in std::iter::once(executable)
        .chain(std::iter::once(working_directory))
        .chain(readable_roots.iter().map(PathBuf::as_path))
        .chain(writable_roots.iter().map(PathBuf::as_path))
    {
        metadata_ancestors.extend(path.ancestors().skip(1).map(Path::to_path_buf));
    }
    if !metadata_ancestors.is_empty() {
        policy.push_str("(allow file-read-metadata");
        for ancestor in metadata_ancestors {
            policy.push_str(" (literal \"");
            policy.push_str(&seatbelt_escape(&ancestor)?);
            policy.push_str("\")");
        }
        policy.push_str(")\n");
    }
    // The already-open stdio/socket descriptors need no pathname authority.
    // Node does need its image, package bundle, random devices, and the
    // isolated cwd. TLS certificate roots are granted only when networking is
    // enabled below.
    policy.push_str("(allow file-read* (literal \"");
    policy.push_str(&seatbelt_escape(executable)?);
    policy.push_str("\") (literal \"/dev/null\") (literal \"/dev/urandom\")");
    for root in readable_roots {
        policy.push_str(" (subpath \"");
        policy.push_str(&seatbelt_escape(root)?);
        policy.push_str("\")");
    }
    policy.push_str(" (subpath \"");
    policy.push_str(&seatbelt_escape(working_directory)?);
    policy.push_str("\"))\n");
    for root in writable_roots {
        policy.push_str("(allow file-write* (subpath \"");
        policy.push_str(&seatbelt_escape(root)?);
        policy.push_str("\"))\n");
    }
    if network_access {
        for certificates in [Path::new("/private/etc/ssl"), Path::new("/etc/ssl")] {
            if certificates.exists() {
                policy.push_str("(allow file-read* (subpath \"");
                policy.push_str(&seatbelt_escape(certificates)?);
                policy.push_str("\"))\n");
            }
        }
        policy.push_str("(allow network-outbound)\n");
    }
    if oauth_callback_access {
        if !network_access {
            return Err(KoniError::Process(
                "the Pi OAuth callback requires explicit outbound network access".to_owned(),
            ));
        }
        // Pi's pinned OpenAI Codex browser flow binds 127.0.0.1:1455. Seatbelt
        // accepts `localhost`, rather than a numeric loopback address, in an
        // address filter. The exact TCP port keeps this narrower than a
        // general network-inbound grant.
        policy.push_str("(allow network-inbound (local tcp \"localhost:1455\"))\n");
    }

    let mut wrapped = vec!["-p".to_owned(), policy, "--".to_owned()];
    wrapped.push(path_string(executable)?);
    wrapped.extend(args.iter().cloned());
    Ok(RuntimeContainmentCommand {
        executable: sandbox_exec,
        args: wrapped,
    })
}

fn compile_linux(
    executable: &Path,
    args: &[String],
    working_directory: &Path,
    readable_roots: &[PathBuf],
    writable_roots: &[PathBuf],
    network_access: bool,
    oauth_callback_access: bool,
) -> Result<RuntimeContainmentCommand> {
    if oauth_callback_access {
        return Err(KoniError::Process(
            "Linux Pi browser OAuth requires a dedicated loopback callback broker; sharing the host network namespace is refused"
                .to_owned(),
        ));
    }
    if network_access {
        return Err(KoniError::Process(
            "Linux Pi inference requires a dedicated outbound-only egress broker; sharing the host network namespace is refused"
                .to_owned(),
        ));
    }
    let bwrap = discover_pinned_bwrap().ok_or_else(|| {
        KoniError::Process(
            "Linux Pi runtime requires Koni's build-pinned bubblewrap and refuses PATH-selected containment"
                .to_owned(),
        )
    })?;
    let bwrap = stage_pinned_bwrap(&bwrap, working_directory)?;
    compile_linux_with_launcher(
        bwrap,
        executable,
        args,
        working_directory,
        readable_roots,
        writable_roots,
        network_access,
    )
}

fn stage_pinned_bwrap(source_path: &Path, scratch: &Path) -> Result<PathBuf> {
    let destination = scratch.join("koni-bwrap");
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
    let mut staged = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&destination)
        .map_err(|error| io_error(&destination, error))?;
    std::io::copy(&mut source, &mut staged).map_err(|error| io_error(&destination, error))?;
    #[cfg(unix)]
    fs::set_permissions(&destination, fs::Permissions::from_mode(0o500))
        .map_err(|error| io_error(&destination, error))?;
    staged
        .sync_all()
        .map_err(|error| io_error(&destination, error))?;
    if file_sha256(&destination)? != PI_BWRAP_BUILD_CHECKSUM {
        let _ = fs::remove_file(&destination);
        return Err(KoniError::Process(
            "the pinned bubblewrap image changed while it was staged for execution".to_owned(),
        ));
    }
    fs::File::open(scratch)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| io_error(scratch, error))?;
    Ok(destination)
}

fn compile_linux_with_launcher(
    bwrap: PathBuf,
    executable: &Path,
    args: &[String],
    working_directory: &Path,
    readable_roots: &[PathBuf],
    writable_roots: &[PathBuf],
    network_access: bool,
) -> Result<RuntimeContainmentCommand> {
    let mut wrapped = vec![
        "--die-with-parent".to_owned(),
        "--unshare-all".to_owned(),
        "--tmpfs".to_owned(),
        "/".to_owned(),
        "--dev".to_owned(),
        "/dev".to_owned(),
        "--proc".to_owned(),
        "/proc".to_owned(),
        "--tmpfs".to_owned(),
        "/tmp".to_owned(),
    ];
    for system_root in ["/usr", "/bin", "/lib", "/lib64"] {
        let root = Path::new(system_root);
        if root.exists() {
            wrapped.extend([
                "--ro-bind".to_owned(),
                system_root.to_owned(),
                system_root.to_owned(),
            ]);
        }
    }
    let mut explicit_reads = readable_roots.to_vec();
    if let Some(parent) = executable.parent() {
        explicit_reads.push(parent.to_path_buf());
    }
    if !writable_roots
        .iter()
        .any(|root| working_directory.starts_with(root))
    {
        explicit_reads.push(working_directory.to_path_buf());
    }
    debug_assert!(
        !network_access,
        "networked Linux containment is rejected above"
    );
    explicit_reads.sort();
    explicit_reads.dedup();
    for root in explicit_reads {
        let root = path_string(&root)?;
        wrapped.extend(["--ro-bind".to_owned(), root.clone(), root]);
    }
    for root in writable_roots {
        let root = path_string(root)?;
        wrapped.extend(["--bind".to_owned(), root.clone(), root]);
    }
    wrapped.extend([
        "--chdir".to_owned(),
        path_string(working_directory)?,
        "--".to_owned(),
        path_string(executable)?,
    ]);
    wrapped.extend(args.iter().cloned());
    Ok(RuntimeContainmentCommand {
        executable: bwrap,
        args: wrapped,
    })
}

fn canonical_file(path: &Path, label: &str) -> Result<PathBuf> {
    let canonical = fs::canonicalize(path).map_err(|error| io_error(path, error))?;
    if !canonical.is_file() {
        return Err(KoniError::Process(format!(
            "{label} is not a regular file: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf> {
    let canonical = fs::canonicalize(path).map_err(|error| io_error(path, error))?;
    if !canonical.is_dir() {
        return Err(KoniError::Process(format!(
            "{label} is not a directory: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

fn path_string(path: &Path) -> Result<String> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        KoniError::Process(format!(
            "Pi runtime containment path is not valid Unicode: {}",
            path.display()
        ))
    })
}

fn seatbelt_escape(path: &Path) -> Result<String> {
    Ok(path_string(path)?
        .replace('\\', "\\\\")
        .replace('"', "\\\""))
}

fn discover_pinned_bwrap() -> Option<PathBuf> {
    if PI_BWRAP_BUILD_PATH.is_empty() || PI_BWRAP_BUILD_CHECKSUM.is_empty() {
        return None;
    }
    let mut candidates = Vec::new();
    if let Ok(current_exe) = env::current_exe()
        && let Some(bin) = current_exe.parent()
    {
        candidates.extend([
            bin.join("koni-pi-host/bwrap"),
            bin.join("../libexec/koni/pi-runtime/bwrap"),
            bin.join("../lib/koni/pi-runtime/bwrap"),
        ]);
    }
    // Prefer the archive/formula sibling so release smoke cannot silently
    // exercise a matching launcher left on the build machine.
    candidates.push(PathBuf::from(PI_BWRAP_BUILD_PATH));
    candidates.extend(["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].map(PathBuf::from));
    let mut seen = std::collections::BTreeSet::new();
    candidates
        .into_iter()
        .filter(|candidate| seen.insert(candidate.clone()))
        .find_map(|candidate| {
            let canonical = fs::canonicalize(candidate).ok()?;
            (canonical.is_file()
                && file_sha256(&canonical).ok().as_deref() == Some(PI_BWRAP_BUILD_CHECKSUM))
            .then_some(canonical)
        })
}

fn file_sha256(path: &Path) -> Result<String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_policy_is_read_only_until_roots_and_network_are_explicit() {
        let temp = tempfile::tempdir().unwrap();
        let writable = temp.path().join("write");
        fs::create_dir(&writable).unwrap();
        let command = RuntimeContainmentRequest {
            platform: RuntimeContainmentPlatform::MacOs,
            executable: PathBuf::from("/bin/sh"),
            args: vec!["-c".to_owned(), "true".to_owned()],
            working_directory: temp.path().to_path_buf(),
            readable_roots: Vec::new(),
            writable_roots: vec![writable.clone()],
            network_access: false,
            oauth_callback_access: false,
        }
        .compile()
        .unwrap();

        assert_eq!(command.executable, Path::new("/usr/bin/sandbox-exec"));
        assert_eq!(command.args[0], "-p");
        assert!(command.args[1].contains("(deny default)"));
        assert!(command.args[1].contains("(allow process-exec (literal \"/bin/sh\"))"));
        let canonical_working = fs::canonicalize(temp.path()).unwrap();
        let canonical_parent = canonical_working.parent().unwrap();
        assert!(command.args[1].contains(&format!("(literal \"{}\")", canonical_parent.display())));
        assert!(command.args[1].contains("(allow file-read-metadata"));
        assert!(!command.args[1].contains("(allow process*)"));
        assert!(command.args[1].contains(writable.to_str().unwrap()));
        assert!(!command.args[1].contains("(allow network-outbound)"));
        assert_eq!(command.args[2], "--");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_network_capability_is_explicit() {
        let temp = tempfile::tempdir().unwrap();
        let command = RuntimeContainmentRequest {
            platform: RuntimeContainmentPlatform::MacOs,
            executable: PathBuf::from("/bin/sh"),
            args: Vec::new(),
            working_directory: temp.path().to_path_buf(),
            readable_roots: Vec::new(),
            writable_roots: Vec::new(),
            network_access: true,
            oauth_callback_access: false,
        }
        .compile()
        .unwrap();
        assert!(command.args[1].contains("(allow network-outbound)"));
        assert!(!command.args[1].contains("network-inbound"));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_oauth_callback_is_exactly_scoped_and_requires_outbound_access() {
        let temp = tempfile::tempdir().unwrap();
        let command = RuntimeContainmentRequest {
            platform: RuntimeContainmentPlatform::MacOs,
            executable: PathBuf::from("/bin/sh"),
            args: Vec::new(),
            working_directory: temp.path().to_path_buf(),
            readable_roots: Vec::new(),
            writable_roots: Vec::new(),
            network_access: true,
            oauth_callback_access: true,
        }
        .compile()
        .unwrap();
        assert!(command.args[1].contains("(allow network-inbound (local tcp \"localhost:1455\"))"));
        assert!(!command.args[1].contains("(allow network-inbound)"));

        let error = RuntimeContainmentRequest {
            platform: RuntimeContainmentPlatform::MacOs,
            executable: PathBuf::from("/bin/sh"),
            args: Vec::new(),
            working_directory: temp.path().to_path_buf(),
            readable_roots: Vec::new(),
            writable_roots: Vec::new(),
            network_access: false,
            oauth_callback_access: true,
        }
        .compile()
        .unwrap_err();
        assert!(error.to_string().contains("requires explicit outbound"));
    }

    #[test]
    fn linux_namespace_does_not_bind_the_machine_root() {
        let temp = tempfile::tempdir().unwrap();
        let host = temp.path().join("host");
        let scratch = temp.path().join("scratch");
        fs::create_dir(&host).unwrap();
        fs::create_dir(&scratch).unwrap();
        let command = compile_linux_with_launcher(
            PathBuf::from("/usr/bin/bwrap"),
            Path::new("/bin/sh"),
            &["-c".to_owned(), "true".to_owned()],
            &scratch,
            std::slice::from_ref(&host),
            std::slice::from_ref(&scratch),
            false,
        )
        .unwrap();

        assert_eq!(command.executable, Path::new("/usr/bin/bwrap"));
        assert!(command.args.windows(2).any(|pair| pair == ["--tmpfs", "/"]));
        assert!(
            command
                .args
                .windows(2)
                .any(|pair| pair == ["--dev", "/dev"])
        );
        assert!(!command.args.iter().any(|arg| arg == "--dev-bind"));
        assert!(!command.args.iter().any(|arg| arg == "--new-session"));
        assert!(
            !command
                .args
                .windows(3)
                .any(|parts| { parts == ["--ro-bind", "/", "/"] })
        );
        assert!(command.args.iter().any(|arg| arg == host.to_str().unwrap()));
        assert!(
            command
                .args
                .iter()
                .any(|arg| arg == scratch.to_str().unwrap())
        );
        assert!(!command.args.iter().any(|arg| arg == "--share-net"));
    }

    #[test]
    fn linux_refuses_host_network_namespace_for_inference() {
        let temp = tempfile::tempdir().unwrap();
        let error = compile_linux(
            Path::new("/bin/sh"),
            &[],
            temp.path(),
            &[],
            &[],
            true,
            false,
        )
        .unwrap_err();
        assert!(error.to_string().contains("outbound-only egress broker"));
    }

    #[test]
    fn missing_paths_fail_before_a_runtime_can_start() {
        let error = RuntimeContainmentRequest {
            platform: RuntimeContainmentPlatform::MacOs,
            executable: PathBuf::from("/definitely/missing/koni-pi-host"),
            args: Vec::new(),
            working_directory: PathBuf::from("/definitely/missing/koni-workspace"),
            readable_roots: Vec::new(),
            writable_roots: Vec::new(),
            network_access: false,
            oauth_callback_access: false,
        }
        .compile()
        .unwrap_err();
        assert!(error.to_string().contains("No such file"));
    }
}
