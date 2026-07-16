# Credential storage P2 hardening

## Ownership

- Owner: `credential_storage_p2/root`
- Exact lease: `crates/koni-core/src/pi_credentials.rs`, its focused unit tests in the same file,
  and this mailbox.
- Goal: move production OAuth state out of the project namespace and safely reap validated stale
  atomic-write remnants while the UID credential lock is held.
- Exclusions: no live credential/auth/install/project/run/process action; no changes to the Pi
  service bridge or other source files.

## Decisions

- Production state follows an OS-account-resolved platform convention with no environment
  override: macOS `~/Library/Application Support/Koni/auth.json`; Linux
  `~/.local/state/koni/auth.json`.
- Cleanup recognizes only Koni's exact `.auth.json.tmp-<UUIDv7>` contract, validates a candidate
  as a same-owner, single-link, regular `0600` file through directory-relative no-follow metadata,
  and unlinks it only under the already-held UID-global credential transaction lock.
- Similar names and unsafe matching objects are preserved rather than reinterpreted.

## Status

- Released to `primary/root` for integration.
- Production storage is disjoint from project-local `~/.koni` and `~/.codex/koni` namespaces. The
  platform-state ancestors are created with owner-only permissions when absent; the existing
  hardened leaf-directory, file, atomic-replace, CAS, and fsync contracts remain intact.
- Stale cleanup executes after the UID-global lock is acquired and before the envelope is read.
  Only canonical lowercase UUIDv7 names and validated same-owner, single-link, regular `0600`
  files are unlinked; similar names, other UUID versions, unsafe modes, and symlinks are retained.

## Verification

- `cargo test -p koni-core pi_credentials::tests --lib`: 13 passed, 0 failed.
- `cargo clippy -p koni-core --lib --tests -- -D warnings`: passed.
- Scoped formatting and whitespace checks passed.
- No authentication command was run and no live credential, install, project, run, or process
  state was read or mutated.
