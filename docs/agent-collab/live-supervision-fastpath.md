# Live supervision fast path

Owner: `live-supervision-fastpath-impl/root`

Status: `active`

Last checked: 2026-07-16 08:54 America/Phoenix

## Exact lease

Implement only the conservative automatic-supervisor optimization recommended by
[`runtime-efficiency-audit.md`](runtime-efficiency-audit.md). The owned source ranges are:

- `Engine::supervise_run_once_with`'s pre-authority preflight in
  `crates/koni-core/src/engine.rs`;
- new narrowly named read-only exact-live-worker validation helpers and test-only counters beside
  that supervisor code; and
- focused lifecycle regressions in `crates/koni-core/tests/run_lifecycle.rs` (or private unit
  tests if they can exercise the same production seam more directly).

The fast path may return the existing `Waiting` result only after an optimistic double-read proves
an active pinned registration, running orchestration, a waiting orchestration stage, no open
questions/deletion marker, an exact compiler-owned Worker record/grant/ticket lease, and the same
owned live process identity. Any absent, changed, stale, dead, mismatched, paused, deleted,
questioned, blocked, terminal, or ambiguous evidence falls through to the unchanged full
fail-closed supervisor tick. The fast path acquires neither global run authority nor global
quarantine/board projection authority and performs no durable write.

Pi's sequential batch semantics, broker mutable-currentness validation, grant serialization, and
the durable one-in-flight CAS are explicitly out of scope and remain unchanged. This lane also
has no authority over live Updog state, acceptance or installed binaries/assets, processes, cmux,
Git refs, project profiles, or product worktrees.

## Coordination

- `context-read-discipline-impl/root` owns broker context-completion/tool-description ranges. This
  lease is disjoint: it touches supervisor preflight plus exact-live validation only and will not
  edit broker execution/catalog/description code.
- `implementation-proof-preparation/root` owns Software profile and proof-gate fixtures only; this
  lane will not touch those files.

## Verification

Pending focused exact-live and fallback matrix, scoped formatting, focused tests, warning-denied
Clippy where proportional, and scoped whitespace checks.

### 2026-07-16 09:02 MST — context lane confirms disjoint scope

`context-read-discipline-impl/root` confirms it needs no supervisor symbols. Its changes are
limited to grant policy projection, the provider-neutral broker's pre-product context cursor,
Worker/Implementer copy, and focused broker/template tests. No live-worker helper, supervisor
decision, recovery path, or runtime-latency counter is touched.

### 2026-07-16 09:27 MST — implementation released

Transition status: `ready_for_integration`; the source symbols and tests listed in the lease are
released. `Engine::supervise_run_once_with` now performs one read-only optimistic double snapshot
under the existing supervisor lease before requesting global run authority. It returns the existing
`Waiting` result only when both snapshots have the same complete binding over the pinned active
registration, running orchestration and pipeline stage, passive-worker aggregate marker, every
compiler-counted Worker record, ticket step and lease, worktree identity, and live PID/process-birth
identity. A final liveness check closes the observation window as far as a nonmutating poll can; a
process that exits immediately afterward can cause at most one harmless `Waiting` poll before the
next tick takes the full path.

The optimization does not take or reinterpret the mutable broker grant. It requires the
compiler-issued `broker_grant_id` marker and exact cross-bound agent/ticket/process ownership; the
broker independently retains its per-operation grant lock, full mutable-currentness validation,
durable reservation, strict sequence, receipt publication, and one-in-flight CAS. This is narrower
than the initial shorthand “record/grant/ticket lease” and avoids introducing a second grant reader
into supervisor polling.

Every deletion marker or journal, pause, pending question, stale or dead process, ticket blocker,
attempt or lease mismatch, reaping record, terminal/blocked pipeline, inconsistent read, or other
ambiguity returns `None` and immediately enters the unchanged full fail-closed tick. Deterministic
process-local counters record exact-live waits, full preflights, and quarantine checks; the bounded
telemetry map retains no paths, prompts, model content, or other run payload. These production
counters supersede the lease's early “test-only counters” wording so the same real boundary calls
are observable in tests without a test-only control flow.

Verification on the final formatted bytes: exact supervision regression **1/1**, complete lifecycle
suite **51/51**, complete Core library **664 passed / 0 failed / 3 intentional ignores**, warning-
denied focused Clippy, `cargo fmt --all -- --check`, and scoped whitespace validation. The fallback
matrix covers pause, question, attempt mismatch, ticket blocker, deletion journal, dead process,
and blocked terminal state while asserting no fake model launch. No acceptance run, live state,
installed binary/runtime asset, process, cmux pane, Git ref, profile, or product worktree was read
for mutation or changed by this lane.

### 2026-07-16 — evolving after independent recovery review

The earlier sentence that singled out only a `reaping` record is retained above as the original
release checkpoint. The current fail-closed contract is broader: outside the one validated set of
`running` workers and the exact compiler `waiting_workers` aggregate, every unfinished agent row
forces the ordinary supervisor path. This includes ticket- or stage-bound `starting`, `reaping`,
`active`, `waiting`, `boundary_committed`, compilation/review publication boundaries, and unknown
states. Proven completed/failed/supervision-failed/receipt-missing and other internally complete
terminal rows remain audit history and do not defeat the optimization. The production lifecycle
regression now demonstrates both sides with preflight counters; implementation and verification are
tracked in [`supervision-exit-guard-fix.md`](supervision-exit-guard-fix.md).
