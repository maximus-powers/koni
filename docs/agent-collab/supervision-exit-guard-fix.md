# Supervision exit-publication guard repair

Owner: `supervision_exit_guard_fix/root`

Status: `ready_for_integration`

Started: 2026-07-16 America/Phoenix

## Exact lease

- `crates/koni-core/src/engine.rs`: the direct-Pi/generic exit-publication authority guard,
  receipt-currentness helpers, exact-live supervision transitional-row predicate, and narrowly
  related focused tests only.
- `crates/koni-core/tests/run_lifecycle.rs`: focused exact-live fast-path lifecycle regressions only.
- Append-only coordination/evolution notes in this mailbox, `docs/AGENT_COLLAB.md`, and the
  independent review mailbox.

No live state, installed binary/runtime bundle, cmux surface, fixture/acceptance project, Git ref,
profile, TUI, or product worktree mutation is in scope. Preserve every concurrent shared-tree edit.

## Accepted review contract

1. An OS-exit receipt is diagnostic completion of already-owned work, not authority to start new
   work. It remains publishable while a live registered run is paused or awaiting a question.
2. Publication requires the action-length run-authority barrier. After acquisition it fails closed
   on either deletion marker, an absent control root, absent/unparseable registry, non-live
   registration (including concluded), a different run identity, or an exact agent record that no
   longer accepts the same process identity's receipt.
3. A late exact receipt may replace compiler-owned provisional `exited_without_receipt` state and
   must preserve its recovery marker and unrelated result fields. It must never recreate a deleted
   or concluded control namespace.
4. The exact-live supervision optimization accepts historical terminal agent rows but refuses any
   additional nonterminal/transitional row outside the one exact set of validated `running`
   workers and the compiler's `waiting_workers` aggregate marker.

## Coordination checkpoint

Read `docs/AGENT_COLLAB.md`, `docs/agent-collab/primary-integrator.md`, the full independent
`supervision-recovery-review.md`, the shared dirty status, and the current exact source ranges
before editing. The parent integrator assigned this exact overlapping `engine.rs` slice; other
concurrent edits remain authoritative outside these symbols.

## Verification

All commands used the private `/tmp/koni-supervision-exit-guard` target where applicable:

- `cargo check -p koni-core --lib` — passed;
- `cargo test -p koni-core direct_pi_exit_ --lib -- --nocapture` — **3/3 passed**;
- `cargo test -p koni-core generic_reaper_uses_the_same_live_exit_publication_guard --lib -- --nocapture` — **1/1 passed**;
- `cargo test -p koni-core exact_live_history_classifier_ --lib -- --nocapture` — **1/1 passed**;
- `cargo test -p koni-core --test run_lifecycle supervisor_passively_waits_for_a_live_worker_without_spawning_a_lead -- --exact --nocapture` — **1/1 passed**;
- `cargo test -p koni-core explicit_recovery_ --lib -- --nocapture` — **3/3 passed**;
- `cargo test -p koni-core late_reaper_overwrites_provisional_missing_receipt_status --lib -- --nocapture` — **1/1 passed**; and
- `cargo clippy -p koni-core --lib -- -D warnings` — passed; and
- scoped `git diff --check` — clean. Rustfmt's check reports only concurrently owned foreign
  ranges; none of this lane's source/test ranges differ from rustfmt output.

Implementation details: the shared guard uses the action timeout, performs no optional-authority
fallthrough, rejects registry/control redirection or absence, and checks both deletion generations.
The direct-Pi publisher returns a test-observable boolean but production callers continue to treat
the receipt as best-effort diagnostics; a false result leaves durable recovery responsible for the
unchanged state. Broad composed gates, independent re-review, and any guarded runtime refresh remain
the parent integrator's boundary.

## Release checkpoint

Re-read the central registry and all coordination mailboxes changed during implementation. The
context-observation and proof-rework lanes explicitly own disjoint symbols; their concurrent edits
were preserved. Exact source/test/doc symbols in this mailbox are released to `primary-integrator`.
