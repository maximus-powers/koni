# Configured-check independent-audit fixes

Owner: `check_runner_containment_fix/root`

Status: `complete`

Started: 2026-07-16

## Exact lease

This follow-up owns the four independent-audit P1 corrections in
`crates/koni-core/src/process.rs`, the bounded retry-policy validation in
`crates/koni-core/src/config.rs`, directly necessary inline Core tests, and this new mailbox only.
It does not own other Core symbols, profiles, CLI/TUI, live state, binaries, runtime bundles, cmux,
acceptance repositories, or Git refs. Both source files are already shared/dirty, so existing
changes outside the exact configured-check symbols and tests remain authoritative.

## Required contract

1. Preserve `stdout_hash`/`stderr_hash` as hashes of the retained serialized strings. Add
   serde-default optional observed-stream hashes for all drained raw bytes; old receipts remain
   readable and existing consumers retain their historical meaning.
2. Open result and artifact files exactly once through a component-wise descriptor-rooted Unix
   `openat` traversal. Every component is no-follow/nonblocking; the final descriptor is `fstat`ed
   and must be regular. Hash/read that same descriptor, never a pathname reopened after validation.
3. Stream artifact SHA-256 in fixed buffers under an explicit size ceiling and postprocessing
   deadline. Sparse, growing, FIFO, symlink, and oversized evidence fail closed without unbounded
   allocation or blocking.
4. Validate a small configured-attempt ceiling and enforce it again in `CommandRunner` before
   spawn. One command invocation also has aggregate retained-output and total-wall budgets, while
   individual attempts may retain their existing 24-hour timeout contract.

Verification will include deterministic descriptor-swap/FIFO and sparse/growing evidence tests,
hash compatibility, extreme retry validation/pre-spawn rejection, cumulative output/wall limits,
ordinary command compatibility, exact-file formatting, focused tests, and warning-denied Core
Clippy.

## Implemented contract

- `stdout_hash` and `stderr_hash` remain SHA-256 hashes of the exact lossy-UTF-8 strings retained
  in the serialized receipt. New `stdout_observed_hash` and `stderr_observed_hash` fields are
  optional, serde-defaulted, omitted when absent, and hash every raw byte drained from the child.
  Existing currentness consumers therefore retain their historical meaning, and old receipts
  without the optional fields still deserialize and validate by the legacy hashes.
- Command specs are rejected before interpolation or process spawn when they request more than
  three attempts or more than 86,400 configured aggregate execution seconds. A single attempt may
  still use the full 86,400-second research-check timeout. All attempts share a 2 MiB retained
  output budget while their complete raw streams continue to be counted and hashed.
- Result documents and artifacts use one Unix descriptor-rooted `openat` traversal. The root,
  every ancestor, and the final component are opened no-follow/nonblocking; the final descriptor
  must be regular. Reads and hashes use that same descriptor. Device, inode, size, mtime+nsec, and
  ctime+nsec must remain unchanged through the stream.
- Result documents retain at most 1 MiB. Artifact hashes stream through a 64 KiB buffer, reject an
  initial or observed size above 64 MiB, and share one 30-second postprocessing deadline with
  result loading/parsing. Growth, same-size mutation, FIFO, symlink, sparse oversize, and path-swap
  cases fail closed.

## Verification completed

- `cargo check -p koni-core --lib` — pass.
- `cargo test -p koni-core --lib process::tests:: -- --nocapture` — 32 passed, 0 failed.
- `cargo test -p koni-core --lib config::tests::command_retry_attempts_and_aggregate_wall_time_are_bounded -- --nocapture` — 1 passed, 0 failed.
- `cargo test -p koni-core --lib` — 701 passed, 0 failed, 3 ignored.
- `cargo clippy -p koni-core --lib --tests -- -D warnings` — pass.
- `git diff --check -- crates/koni-core/src/process.rs crates/koni-core/src/config.rs docs/agent-collab/configured-check-audit-fix.md` — pass.

## Follow-up lease: shared evidence audits

Status: `in_progress` (2026-07-16)

An independent re-review found two remaining P1 consumers. This follow-up additionally owns the
narrowly necessary command-evidence issuance/currentness functions in `crates/koni-core/src/engine.rs`:

- replace `command_result_source_current` pathname reopening with the descriptor-rooted same-FD
  reader;
- introduce one `EvidenceAudit` per issuance/currentness batch with a single absolute deadline,
  maximum unique-file count, aggregate observed-byte allowance, and normalized-path digest/error
  cache;
- pass that audit across runner result/static artifacts, dynamic result/artifacts, and all three
  currentness manifests; reject oversized manifest arrays before walking them and short-circuit
  structurally invalid receipts before evidence I/O;
- statically validate configured artifact counts and enforce the same bound before spawn and on
  runtime-declared dynamic paths.

No other Engine, profile, CLI/TUI, runtime, live-state, or installation symbols are leased.
