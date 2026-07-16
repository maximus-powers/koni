# Init-project destructive-target safety fix

## Lease

- **Owner:** `context_spawn_preflight_fix/root`
- **Status:** active
- **Claimed at:** 2026-07-16 12:28 MST
- **Source scope:** `crates/koni-cli/src/main.rs`, exact `InitProject` dispatch, a narrowly named
  target-preparation helper, and focused inline CLI tests.
- **Documentation scope:** this mailbox and append-only `docs/AGENT_COLLAB.md`; directly necessary
  CLI help text only.
- **Out of scope:** TUI configuration publication, upgrade/overlay behavior, packaging, profiles,
  runtime/Pi state, binaries, cmux, live runs, product/acceptance repositories, and unrelated
  source formatting.

## Contract

`koni init-project` may initialize a missing directory or an already-empty real directory. An
existing nonempty target is never recursively removed, including when the deprecated compatibility
flag `--force` is present. It must fail before initialization, retain the target byte-for-byte, and
direct the operator to run `koni init` inside an existing project. A target symlink is rejected
without following it.

## Verification plan

- Focused inline CLI tests for missing and empty targets.
- Nonempty ordinary target plus root/home/cwd/repository-root/ancestor-shaped paths retain sentinel
  bytes even with `--force`.
- Direct target symlink is rejected and its referent remains unchanged.
- Focused `koni-cli` tests, exact-file Rustfmt, and scoped whitespace check.

## Coordination

No overlapping active claim was found for the exact `InitProject` dispatch/helper/tests. Preserve
all other agents' existing changes in the shared dirty `main.rs`.

## 2026-07-16 12:36 MST — implementation checkpoint

The direct `remove_dir_all` path is gone. Dispatch now calls one preparation helper before opening
the profile: missing directories are created, empty real directories pass, nonempty directories
fail with `koni init` guidance regardless of `--force`, and direct target symlinks fail without
following them. Temporary root/home/ancestor/repository/cwd/ordinary fixtures are snapshotted
recursively before and after rejection; a direct parsed-CLI regression also proves rejection occurs
before a deliberately missing profile can be opened.

Verification so far:

- `rustfmt --edition 2024 --check crates/koni-cli/src/main.rs` — **clean**.
- Initial focused CLI safety run — **3/3 passed** before the direct dispatch case was added.
- Current four-test rerun is temporarily blocked by the separately owned
  `check_runner_containment_fix/root` edit: `process.rs` is mid-expansion and its existing
  `AttemptReceipt` initializer does not yet populate the new capture fields. That owner was
  notified; this lane will rerun without touching their source once the shared tree compiles.
- Scoped `git diff --check` — **clean**.

## 2026-07-16 12:43 MST — ready for integration

The separately owned Core source returned to a compileable checkpoint and the composed focused
rerun is green:

- `CARGO_TARGET_DIR=/tmp/koni-init-project-safety-target cargo test -p koni-cli init_project_ -- --nocapture`
  — **4/4 passed**.
- `rustfmt --edition 2024 --check crates/koni-cli/src/main.rs` — **clean**.
- Scoped `git diff --check` and destructive-call grep — **clean**; no
  `remove_dir_all(&path)` remains.

The final tests cover missing/empty success, parsed legacy `--force` dispatch failing before a
missing profile is opened, recursive byte/structure preservation for temporary
root/home/ancestor/repository-root/cwd/ordinary target roles, and symlink/referent preservation.
No new cross-domain question appeared in the latest mailbox sweep. This source lease is released
to `primary-integrator/root`; no binary, live state, cmux, runtime, profile, or product repository
was changed.

## 2026-07-16 13:25 MST — descriptor-stable safety correction

An independent post-fix review found that the earlier direct-path preparation still followed a
final symlink when the caller supplied a trailing separator, followed a symlinked ancestor while
creating a missing child, and did not retain the validated directory identity across profile and
run publication. This note appends the stronger contract without replacing the earlier historical
checkpoint.

The legacy `init-project` path now walks from filesystem root with descriptor-relative
`openat(O_DIRECTORY | O_NOFOLLOW)` and creates missing components with `mkdirat`. It rejects direct
and trailing-separator target symlinks, ordinary files, and any symlinked existing ancestor. The
final missing or empty directory remains open, becomes the process cwd through `fchdir`, and is
enumerated as `.` for the emptiness proof; no pathname is reopened for that proof. The original cwd
descriptor is restored and its device/inode identity verified on every ordinary success or error.

Profile installation and `Engine::initialize_run` execute from `.` while the exact target fd/cwd
anchor remains held. The requested absolute path is reopened no-follow and compared by device and
inode immediately before and after engine work. A replacement therefore either fails before any
engine effect or yields an explicit post-init error stating that initialization stayed on the
original held inode and never followed the replacement. Koni does not recursively clean that
original inode on mismatch: this preserves the no-recursive-deletion contract and leaves only
Koni-created evidence on the directory identity the caller originally authorized.

Focused tests now include full git-backed Engine initialization for missing and empty targets,
nonempty/file preservation, direct and trailing target symlinks, a missing child below a symlinked
ancestor, and deterministic target/ancestor replacement after `fchdir`. Both replacement tests
prove compiler profile and run state land only in the renamed original inode, victim bytes remain
unchanged, the requested replacement path is rejected, and cwd identity is restored. No runtime,
installed binary, live run, process, cmux surface, product checkout, or Git ref was touched.

### Descriptor-stable verification closure

- `CARGO_TARGET_DIR=/tmp/koni-init-project-anchor-target cargo test -p koni-cli init_project_ --
  --nocapture --test-threads=1` — **8/8 passed**.
- `CARGO_TARGET_DIR=/tmp/koni-init-project-anchor-target cargo test -p koni-cli -- --nocapture`
  — **77/77 passed**, including the replacement tests under the normal parallel test runner.
- `CARGO_TARGET_DIR=/tmp/koni-init-project-anchor-target cargo clippy -p koni-cli --all-targets
  -- -D warnings` — **passed cleanly**.
- Exact-file Rustfmt check and scoped `git diff --check` — **passed cleanly**.

The source and inline-test lease is complete and released for independent review. No
`remove_dir_all` was introduced; post-mismatch state is retained only on the originally held inode
rather than deleting through any path. No live/global state or separately owned source was
modified.
