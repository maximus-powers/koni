# Inactive cockpit snapshot cache

Owner: `inactive-snapshot-cache/root`

Status: `in_progress`

## 2026-07-16 lease

This lane owns only the registered-run snapshot discovery/cache seam and focused regressions in
`crates/koni-tui/src/{app,model}.rs`, plus this append-only mailbox. It will keep the selected run
and every nonterminal/live run eager while reusing a terminal, unselected run's complete cockpit
snapshot only when both its registry record and a conservative fingerprint of its compiler-owned
durable roots are unchanged. Cache entries must be pruned on registry deletion, must not absorb
provisional rows, and must not make a failed/invalid snapshot sticky.

No core, runtime, profile, template, CLI, installed binary, project configuration, live run,
process, worktree, Git ref, or cmux surface is in scope. The shared worktree is intentionally dirty;
coherent changes from other agents will be preserved. Verification will include focused reuse,
selection, invalidation, registry-change, invalid-snapshot, and provisional-row tests, then the
complete TUI library suite, formatting, diff validation, and all-target TUI Clippy.

## 2026-07-16 07:10 MST — implementation complete and lease released

Status: `ready_for_integration`

The periodic refresh worker now owns one process-local `ProjectSnapshotCache`. Every refresh carries
the currently selected durable run ID. Planning, approved, active, and paused registrations remain
eager, as does the selected row regardless of status. A terminal unselected run is reusable only
when all of the following remain true:

- its complete `RunRegistration` is byte-semantically equal to the cached registration;
- every compiler-owned sidecar entry has the same path/type/size/permissions/time identity and,
  on Unix, the same device/inode/mode/mtime/ctime identity;
- a tracked-storage profile's exact state parent, resolved from the run's immutable configuration
  snapshot, has the same recursive identity;
- the full projection succeeded, its before/after fingerprints matched, and it reported no running,
  draining, starting, active, waiting, or resuming agent activity.

Top-level `locks` trees are the only omitted paths because they are transient coordination state
and are not consumed by `cockpit_snapshot`. Fingerprint read races or permission errors simply make
that run eager. Failed `open_run` / invalid snapshot fallbacks are shown to the operator but never
cached. Registry deletion prunes entries; loss of the registry or Git identity clears the cache;
new or changed registrations miss naturally. The existing provisional-run reconciliation remains
above this durable snapshot seam, and its focused regression continues to prove a pending row is
preserved until its matching registered run appears.

The deterministic many-run regression uses 32 inactive runs plus active and paused rows. The first
refresh loads all 34, the next refresh reloads only the two live rows, selecting an inactive row
reloads exactly that row, and changing one durable marker reloads only that run. It also covers a
terminal-to-active transition, registry deletion/pruning, and a newly registered run. Separate
regressions cover non-sticky invalid projections, terminal-but-draining agents, both sidecar and
tracked-state invalidation, transient lock churn, exact tracked-state-root resolution, and selected
run identity crossing the refresh channel. This call-count proof is deterministic and avoids a
flaky wall-clock benchmark while directly bounding the expensive `Engine::open_run` plus
`cockpit_snapshot` work.

Files changed by this lane:

- `crates/koni-tui/src/app.rs` — selected-run-aware refresh commands and the long-lived cache in the
  refresh worker;
- `crates/koni-tui/src/model.rs` — conservative durable fingerprints, cache policy, error handling,
  tracked-root resolution, and focused tests;
- `docs/agent-collab/inactive-snapshot-cache.md` — append-only lease and handoff.

Verification on the final TUI source:

- focused snapshot/cache/refresh regressions: green;
- `CARGO_TARGET_DIR=/tmp/koni-inactive-snapshot-cache-target cargo test -p koni-tui --lib` —
  **311 passed, 0 failed, 0 ignored**;
- `cargo fmt --package koni-tui -- --check` — pass;
- scoped `git diff --check` for the two TUI files and this mailbox — pass;
- `CARGO_TARGET_DIR=/tmp/koni-inactive-snapshot-cache-target cargo clippy -p koni-tui
  --all-targets -- -D warnings` — pass.

Workspace-wide `cargo fmt --all --check` is not claimed by this lane: at handoff it reports only an
unformatted assertion in the concurrently owned `crates/koni-core/src/engine.rs` edit near line
84762. This lane did not format or modify that core range. Final TUI fingerprints were
`app.rs` `8eba6166b5fe1559c07e7b95b0f48efb87f29c14cdd81bc20765a7aead9d46d4` and
`model.rs` `d7cd682f2611546299e2d29b46f8af02946588b300c01407947ccda5644d2112`.

The final documentation sweep re-read the central registry, the current primary-integrator tail,
the integrated TUI findings, the TUI completion audit, and the newly completed upgrade-overlay
audit. No overlapping decision or unanswered mailbox question was found. No installed refresh or
live-state mutation was performed.

### 2026-07-16 07:13 MST — final mailbox delta

After the preceding sweep, the deterministic-Lead audit completed and the surgical-edit review
opened a read-only core lease. Both mailboxes were read through their current EOF. The former only
proposes a future driver and the latter owns core review surfaces; neither overlaps this released
TUI cache seam or changes its handoff. No question was left for this lane.
