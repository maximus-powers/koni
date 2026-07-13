//! Stable, symlink-safe filesystem lock rendezvous.
//!
//! Lock files are deliberately never unlinked. On Unix, every pathname
//! component is traversed relative to an already-open directory descriptor
//! with `O_NOFOLLOW`; missing lock-directory components are created with
//! `mkdirat` and then opened the same way. This avoids both inode replacement
//! after unlock and check-then-open symlink races.

use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

use fs2::FileExt;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LockMode {
    Blocking,
    Try,
}

#[derive(Debug)]
pub(crate) struct PersistentFileLock {
    file: File,
    path: PathBuf,
}

impl PersistentFileLock {
    /// Acquire one persistent advisory lock below a trusted absolute root.
    ///
    /// `trusted_root` must be compiler-owned and unavailable to agents for
    /// rename/unlink writes. Directory-relative no-follow traversal and the
    /// post-lock inode check close ordinary in-flight replacement, but no
    /// advisory-lock protocol can stop a malicious same-UID process that may
    /// rename the trusted namespace immediately after verification.
    pub(crate) fn acquire(
        trusted_root: &Path,
        relative_lock_path: &Path,
        mode: LockMode,
    ) -> io::Result<Self> {
        Self::acquire_with_after_lock(trusted_root, relative_lock_path, mode, |_| Ok(()))
    }

    fn acquire_with_after_lock(
        trusted_root: &Path,
        relative_lock_path: &Path,
        mode: LockMode,
        mut after_lock: impl FnMut(&Path) -> io::Result<()>,
    ) -> io::Result<Self> {
        validate_paths(trusted_root, relative_lock_path)?;
        let path = trusted_root.join(relative_lock_path);
        // A directory-FD walk prevents symlink traversal during each attempt.
        // Reopen through a fresh walk after taking the advisory lock and bind
        // the result by device/inode, so an ordinary in-flight rename cannot
        // leave us holding an obsolete rendezvous inode.
        for _ in 0..8 {
            let file = securely_open_persistent_file(trusted_root, relative_lock_path, true)?;
            match mode {
                LockMode::Blocking => file.lock_exclusive()?,
                LockMode::Try => file.try_lock_exclusive()?,
            }
            after_lock(&path)?;
            match securely_open_persistent_file(trusted_root, relative_lock_path, false) {
                Ok(current) if same_file_identity(&file, &current)? => {
                    return Ok(Self { file, path });
                }
                Ok(_) | Err(_) => {
                    let _ = FileExt::unlock(&file);
                }
            }
        }
        Err(io::Error::other(
            "persistent lock namespace changed repeatedly during acquisition",
        ))
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for PersistentFileLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

/// Read one stable regular file through the same no-follow directory walk as
/// lock acquisition. The file must already exist and retain one hard link.
pub(crate) fn read_persistent_file(
    trusted_root: &Path,
    relative_path: &Path,
    max_bytes: usize,
) -> io::Result<Vec<u8>> {
    validate_paths(trusted_root, relative_path)?;
    let file = securely_open_persistent_file(trusted_root, relative_path, false)?;
    let length = usize::try_from(file.metadata()?.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "persistent file is too large"))?;
    if length > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "persistent file exceeds its size bound",
        ));
    }
    let mut bytes = Vec::with_capacity(length);
    file.take((max_bytes as u64).saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "persistent file exceeds its size bound",
        ));
    }
    Ok(bytes)
}

/// Replace a bounded compiler-owned file in place beneath a trusted root.
///
/// Callers serialize writers with a separate persistent lock. Keeping the
/// data inode stable avoids rename/symlink substitution; an abrupt crash may
/// leave a truncated file, which higher-level integrity hashes must reject
/// fail-closed on restart.
pub(crate) fn write_persistent_file(
    trusted_root: &Path,
    relative_path: &Path,
    bytes: &[u8],
    max_bytes: usize,
) -> io::Result<()> {
    validate_paths(trusted_root, relative_path)?;
    if bytes.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "persistent file exceeds its size bound",
        ));
    }
    let mut file = securely_open_persistent_file(trusted_root, relative_path, true)?;
    file.set_len(0)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Hash a canonical filesystem identity without lossy Unicode conversion.
pub(crate) fn exact_path_identity(path: &Path) -> String {
    let mut digest = Sha256::new();
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        digest.update(path.as_os_str().as_bytes());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        for unit in path.as_os_str().encode_wide() {
            digest.update(unit.to_le_bytes());
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        // The lock opener below fails closed on these targets. Keep this
        // deterministic for compilation without pretending a lossy path is a
        // safe identity.
        digest.update(path.as_os_str().as_encoded_bytes());
    }
    hex::encode(digest.finalize())
}

fn validate_paths(trusted_root: &Path, relative_lock_path: &Path) -> io::Result<()> {
    if !trusted_root.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "persistent lock trusted root must be absolute",
        ));
    }
    let mut components = relative_lock_path.components().peekable();
    if components.peek().is_none()
        || components.any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "persistent lock path must contain only nonempty relative components",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn securely_open_persistent_file(
    trusted_root: &Path,
    relative_lock_path: &Path,
    create_missing: bool,
) -> io::Result<File> {
    use rustix::fd::OwnedFd;
    use rustix::fs::{FileType, Mode, OFlags, fstat, mkdirat, open, openat};
    use rustix::io::Errno;

    const DIRECTORY_FLAGS: OFlags = OFlags::RDONLY
        .union(OFlags::DIRECTORY)
        .union(OFlags::NOFOLLOW)
        .union(OFlags::CLOEXEC)
        .union(OFlags::NONBLOCK);
    const EXISTING_FILE_FLAGS: OFlags = OFlags::RDWR
        .union(OFlags::NOFOLLOW)
        .union(OFlags::CLOEXEC)
        .union(OFlags::NONBLOCK);

    fn errno(error: Errno) -> io::Error {
        error.into()
    }

    fn open_directory_at(parent: &OwnedFd, name: &std::ffi::OsStr) -> io::Result<OwnedFd> {
        openat(parent, name, DIRECTORY_FLAGS, Mode::empty()).map_err(errno)
    }

    fn open_or_create_directory_at(
        parent: &OwnedFd,
        name: &std::ffi::OsStr,
    ) -> io::Result<OwnedFd> {
        match open_directory_at(parent, name) {
            Ok(directory) => Ok(directory),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                match mkdirat(parent, name, Mode::RWXU) {
                    Ok(()) | Err(Errno::EXIST) => open_directory_at(parent, name),
                    Err(error) => Err(errno(error)),
                }
            }
            Err(error) => Err(error),
        }
    }

    fn validate_regular_lock(fd: OwnedFd) -> io::Result<File> {
        let stat = fstat(&fd).map_err(errno)?;
        if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile || stat.st_nlink != 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "persistent lock path is not a single-link regular file",
            ));
        }
        Ok(fd.into())
    }

    fn open_lock_at(
        parent: &OwnedFd,
        name: &std::ffi::OsStr,
        create_missing: bool,
    ) -> io::Result<File> {
        match openat(parent, name, EXISTING_FILE_FLAGS, Mode::empty()) {
            Ok(fd) => validate_regular_lock(fd),
            Err(Errno::NOENT) if create_missing => {
                let create_flags = EXISTING_FILE_FLAGS | OFlags::CREATE | OFlags::EXCL;
                match openat(parent, name, create_flags, Mode::RUSR | Mode::WUSR) {
                    Ok(fd) => validate_regular_lock(fd),
                    Err(Errno::EXIST) => openat(parent, name, EXISTING_FILE_FLAGS, Mode::empty())
                        .map_err(errno)
                        .and_then(validate_regular_lock),
                    Err(error) => Err(errno(error)),
                }
            }
            Err(error) => Err(errno(error)),
        }
    }

    // Open the filesystem root once, then traverse the trusted absolute root
    // component-by-component. `O_NOFOLLOW` applies to every hop, not just the
    // final pathname.
    let mut directory = open(Path::new("/"), DIRECTORY_FLAGS, Mode::empty()).map_err(errno)?;
    for component in trusted_root.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => directory = open_directory_at(&directory, name)?,
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "persistent lock trusted root is not a normalized absolute path",
                ));
            }
        }
    }

    let mut relative = relative_lock_path.components().peekable();
    while let Some(component) = relative.next() {
        let Component::Normal(name) = component else {
            unreachable!("validated above")
        };
        if relative.peek().is_none() {
            return open_lock_at(&directory, name, create_missing);
        }
        directory = if create_missing {
            open_or_create_directory_at(&directory, name)?
        } else {
            open_directory_at(&directory, name)?
        };
    }
    unreachable!("validated nonempty path")
}

#[cfg(not(unix))]
fn securely_open_persistent_file(
    _trusted_root: &Path,
    _relative_lock_path: &Path,
    _create_missing: bool,
) -> io::Result<File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "symlink-safe persistent locks are unavailable on this platform",
    ))
}

#[cfg(unix)]
fn same_file_identity(left: &File, right: &File) -> io::Result<bool> {
    use std::os::unix::fs::MetadataExt;

    let left = left.metadata()?;
    let right = right.metadata()?;
    Ok(left.file_type().is_file()
        && right.file_type().is_file()
        && left.nlink() == 1
        && right.nlink() == 1
        && left.dev() == right.dev()
        && left.ino() == right.ino())
}

#[cfg(not(unix))]
fn same_file_identity(_left: &File, _right: &File) -> io::Result<bool> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    use std::os::unix::fs::{MetadataExt, symlink};

    #[cfg(unix)]
    #[test]
    fn persistent_lock_reuses_one_inode_and_excludes_concurrent_owner() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let relative = Path::new("locks/compiler.lock");
        let first = PersistentFileLock::acquire(&root, relative, LockMode::Try).unwrap();
        let path = root.join(relative);
        let inode = path.metadata().unwrap().ino();
        let error = PersistentFileLock::acquire(&root, relative, LockMode::Try).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        drop(first);
        assert!(path.exists());
        let second = PersistentFileLock::acquire(&root, relative, LockMode::Try).unwrap();
        assert_eq!(path.metadata().unwrap().ino(), inode);
        drop(second);
        assert_eq!(path.metadata().unwrap().ino(), inode);
    }

    #[cfg(unix)]
    #[test]
    fn ancestor_and_final_symlinks_never_touch_their_targets() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(outside.join("nested")).unwrap();
        std::fs::create_dir(&root).unwrap();
        symlink(&outside, root.join("redirected")).unwrap();

        let error = PersistentFileLock::acquire(
            &root.canonicalize().unwrap(),
            Path::new("redirected/nested/state.lock"),
            LockMode::Try,
        )
        .unwrap_err();
        assert_ne!(error.kind(), io::ErrorKind::WouldBlock);
        assert!(!outside.join("nested/state.lock").exists());

        std::fs::create_dir(root.join("safe")).unwrap();
        let sentinel = outside.join("sentinel");
        std::fs::write(&sentinel, "unchanged").unwrap();
        symlink(&sentinel, root.join("safe/state.lock")).unwrap();
        PersistentFileLock::acquire(
            &root.canonicalize().unwrap(),
            Path::new("safe/state.lock"),
            LockMode::Try,
        )
        .unwrap_err();
        assert_eq!(std::fs::read_to_string(sentinel).unwrap(), "unchanged");
    }

    #[cfg(unix)]
    #[test]
    fn persistent_data_io_rejects_redirected_directories_and_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let sentinel = outside.join("sentinel.yaml");
        std::fs::write(&sentinel, "unchanged").unwrap();

        symlink(&outside, root.join("broker-grants")).unwrap();
        assert!(
            write_persistent_file(
                &root.canonicalize().unwrap(),
                Path::new("broker-grants/grant.yaml"),
                b"forged",
                1024,
            )
            .is_err()
        );
        assert_eq!(std::fs::read_to_string(&sentinel).unwrap(), "unchanged");

        std::fs::remove_file(root.join("broker-grants")).unwrap();
        std::fs::create_dir(root.join("broker-grants")).unwrap();
        symlink(&sentinel, root.join("broker-grants/grant.yaml")).unwrap();
        assert!(
            write_persistent_file(
                &root.canonicalize().unwrap(),
                Path::new("broker-grants/grant.yaml"),
                b"forged",
                1024,
            )
            .is_err()
        );
        assert!(
            read_persistent_file(
                &root.canonicalize().unwrap(),
                Path::new("broker-grants/grant.yaml"),
                1024,
            )
            .is_err()
        );
        assert_eq!(std::fs::read_to_string(sentinel).unwrap(), "unchanged");
    }

    #[cfg(unix)]
    #[test]
    fn opened_directory_fd_cannot_be_redirected_by_a_path_swap() {
        use rustix::fs::{Mode, OFlags, open};

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let original = root.join("original");
        let retired = root.join("retired");
        let outside = root.join("outside");
        std::fs::create_dir(&original).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let directory = open(
            &original,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .unwrap();
        std::fs::rename(&original, &retired).unwrap();
        symlink(&outside, &original).unwrap();

        // Exercise the same final-component opener against the pinned FD.
        let fd = rustix::fs::openat(
            &directory,
            Path::new("state.lock"),
            OFlags::RDWR | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        )
        .unwrap();
        let file: File = fd.into();
        drop(file);
        assert!(retired.join("state.lock").is_file());
        assert!(!outside.join("state.lock").exists());
    }

    #[cfg(unix)]
    #[test]
    fn post_lock_identity_check_retries_a_replaced_rendezvous_inode() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let relative = Path::new("locks/compiler.lock");
        let retired = root.join("retired.lock");
        let mut replaced = false;

        let lock =
            PersistentFileLock::acquire_with_after_lock(&root, relative, LockMode::Try, |path| {
                if !replaced {
                    std::fs::rename(path, &retired)?;
                    std::fs::write(path, [])?;
                    replaced = true;
                }
                Ok(())
            })
            .unwrap();

        let current = root.join(relative).metadata().unwrap();
        let held = lock.file.metadata().unwrap();
        assert_ne!(retired.metadata().unwrap().ino(), current.ino());
        assert_eq!((held.dev(), held.ino()), (current.dev(), current.ino()));
    }

    #[cfg(unix)]
    #[test]
    fn exact_path_identity_distinguishes_non_utf8_names() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let first = PathBuf::from(OsString::from_vec(vec![b'r', 0x80]));
        let second = PathBuf::from(OsString::from_vec(vec![b'r', 0x81]));
        assert_eq!(first.to_string_lossy(), second.to_string_lossy());
        assert_ne!(exact_path_identity(&first), exact_path_identity(&second));
    }
}
