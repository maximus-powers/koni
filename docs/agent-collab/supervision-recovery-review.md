# Supervision and recovery independent review

Owner: `supervision-recovery-independent-review/root`

Status: `complete_with_p1_blockers`

Reviewed: 2026-07-16 America/Phoenix

## Scope

Read-only independent review of:

- the exact-live automatic-supervision fast path in `Engine::supervise_run_once_with` and
  `exact_live_worker_supervision_*`; and
- durable dead ticket-agent recovery through `recover_agent_runtime_state`,
  `reconcile_dead_ticket_agent_records`, the shared terminal-receipt predicate, and focused tests.

No production source, live run, binary, process, cmux surface, Git ref, profile, or worktree was
changed. No Cargo command was run.

## Verdict

No P0 was found. Two P1 blockers must be corrected before these changes are treated as ready for a
guarded live refresh. The provisional dead-agent transition itself is conservative: it is limited
to identity-bound ticket records, never signals a PID, never invents exit zero, excludes
stage-owned records, and preserves prior result evidence. The fast path is also read-only and its
post-snapshot TOCTOU exposure can produce at most one stale `Waiting` observation. The blockers are
in the surrounding production integration paths described below.

## P1 — direct-Pi late exit publication bypasses failed authority and currentness

Evidence:

- `crates/koni-core/src/engine.rs:59315` converts
  `acquire_run_authority_barrier_at(&spec.sidecar_root, &spec.run_id)` to `.ok()` and continues
  regardless of whether the five-second authority acquisition succeeded.
- `crates/koni-core/src/engine.rs:59316-59356` then reads and rewrites the raw agent record without
  checking the run tombstone, the in-run deletion journal, registry membership/status, or current
  control-root identity.
- A successful outcome continues into ticket-worktree cleanup at
  `crates/koni-core/src/engine.rs:59357-59362`, so this is not limited to a cosmetic TUI row.
- The generic detached waiter at `crates/koni-core/src/engine.rs:59532-59567` already demonstrates
  the correct fail-closed boundary: authority is mandatory, tombstones and deletion journals are
  refused, and registry state must remain live.
- `recover_agent_runtime_state` runs while the enclosing action holds the run authority barrier and
  compiler lock (`crates/koni-core/src/engine.rs:12580-12665`, with recovery dispatched at
  `18359-18363`). Recovery can take longer than the direct-Pi waiter's five-second control timeout
  while it cleans/checkpoints ticket worktrees. A Pi waiter may therefore time out, continue
  unguarded, race recovery's read/write, and either have its exact receipt overwritten by
  `exited_without_receipt` or overwrite the provisional record concurrently.
- The same optional-authority path can race deletion and recreate or mutate control state after the
  deletion/current-registration boundary. It can also publish after conclusion because no live
  registration check precedes either the raw record write or successful ticket cleanup.
- `late_reaper_overwrites_provisional_missing_receipt_status` exercises only
  `reconcile_reaped_agent_exit(..., authority = None)` in an isolated temporary control directory;
  it does not exercise the production direct-Pi function, authority contention, deletion, paused
  currentness, or result preservation.

Minimal repair:

1. Factor one shared exit-publication authority guard used by both generic and direct-Pi waiters.
   It must require successful acquisition before any read/write, refuse the sidecar tombstone and
   run-local deletion journal, require the control root to remain present, and require the exact
   registry run to remain live. Keep diagnostic exit publication valid while orchestration is
   paused or awaiting a question; those states drain existing owned agents and must not be treated
   as new execution authority.
2. For direct Pi, use a bounded action-length wait/retry that retains the exact outcome while an
   explicit recovery boundary is publishing. If that bound is exhausted, fail closed without a
   control or ticket write; never fall through without the barrier.
3. Under the acquired authority, re-read the exact agent and require run ID, process identity, and
   a receipt-accepting status before replacement. Preserve the provisional recovery object when
   adding the exact turn/error result.

Required regressions:

- hold run authority while the direct-Pi exit path starts; prove it cannot write concurrently and
  that, after release, an exact receipt replaces `exited_without_receipt`;
- prove a tombstoned, unregistered, and concluded run cannot receive a raw record or ticket cleanup;
- prove a paused live run may receive its exact diagnostic exit receipt;
- prove an open question does not grant new work but does not suppress the already-owned process's
  exact exit receipt; and
- prove the prior `compiler_owned_recovery` result plus unrelated result fields survive both a
  successful and failed late correction.

## P1 — fast path ignores additional transitional agent records

Evidence:

- `crates/koni-core/src/engine.rs:37602-37611` rejects any `reaping` record, then constructs the
  complete candidate set from only records whose status is exactly `running`.
- Durable `starting` is a real compiler state written before process identity/ticket activation by
  both the legacy worker launcher (`engine.rs:28512-28543`) and production direct Pi
  (`engine.rs:58903-58938`). Process or cockpit loss can strand that record.
- If one correctly bound worker remains live and the passive aggregate count still matches the
  `running` subset, an additional stranded `starting` record is absent from the binding hash. The
  double snapshot can therefore remain identical and return exact-live `Waiting` forever instead
  of entering the full supervision/recovery path needed to diagnose the startup boundary.
- The same omission applies to other nonterminal transition states such as `active`, `waiting`, or
  `boundary_committed`; a stale stage-owned startup must not coexist invisibly with an allegedly
  complete passive-worker binding.
- The lifecycle regression at `crates/koni-core/tests/run_lifecycle.rs:2794-3196` covers pause,
  pending question, attempt mismatch, ticket blocker, deletion journal, dead process, and terminal
  pipeline state, but does not add a second transitional record or prove terminal history is
  intentionally ignored.

Minimal repair:

1. Before selecting exact `running` workers, reject every additional nonterminal/transitional
   agent record (`starting`, `reaping`, `active`, `waiting`, and `boundary_committed`, plus any
   canonical equivalent). Exact `running` records continue through the existing ticket/step/lease/
   worktree/process validation. The compiler aggregate's exact `waiting_workers` record is the one
   explicit exception.
2. Do not reject historical terminal rows (`completed`, `failed`, `supervision_failed`,
   `exited_without_receipt`, and other canonical terminal review states); they are audit history,
   not mutable current authority.

Required regressions:

- add a stranded ticket-bound `starting` record beside the valid live worker and prove the fast
  counter does not advance while the full-preflight counter does;
- repeat for a stage-owned `starting` record and `boundary_committed` ticket record; and
- add completed/failed historical rows and prove the otherwise exact fast path still applies.

## P2 — recovery proof is helper-level rather than action-integrated

The focused recovery tests establish object/non-object result preservation, other-run exclusion,
aggregate-stage exclusion, live owned-PID safety, and generic late correction. They do not invoke
the configured `recover` action and assert its `reconciled_ticket_agents` result, nor cover malformed
PID/identity combinations, missing ticket/step identity, repeated idempotent recovery, or exact
result preservation after direct-Pi correction. Add a small action-level recovery regression after
the P1 authority repair so the production lock/currentness envelope—not only the private helper—is
under test.

## P2 — fast-path binding clauses lack focused negative coverage

The implementation checks profile/run-type/pipeline/aggregate, common Git directory, worktree,
ticket state, blockers/change control, step/persona/attempt/input, PID/PGID/birth identity,
active-worker binding, broker marker, and absence of a step output. The current test directly
mutates only the attempt and blocker portions of that matrix. Add table-driven helper-level negative
cases for missing/mismatched lease, active-worker identity, output publication, worktree/common-dir,
broker marker, and profile/run-type currentness so future refactoring cannot silently weaken the
fast-path predicate while the large lifecycle test remains green.

## Accepted properties after blockers are repaired

- The fast path performs no durable write and does not mint broker or model authority.
- Deletion, pause, questions, a dead PID, ticket blockers, and terminal pipeline state already fall
  through in the present regression.
- Double-read equality plus a final process-birth check limits unavoidable post-check TOCTOU to one
  harmless stale wait; the following poll re-enters full supervision.
- `reconcile_dead_ticket_agent_records` requires an exact run ID, ticket and step, PID equal to the
  recorded process identity, process-group leadership, a nonempty birth marker, and both owned and
  bare-PID absence. It does not signal anything.
- The recovery marker retains an object result directly and wraps legacy scalar/array results under
  `prior_result`; no successful OS exit is fabricated.
- `ticket_id.is_some()` plus `stage_id.is_some()` excludes planning and aggregate orchestration
  records from this generic recovery transition.

## 2026-07-16 implementation response — `supervision_exit_guard_fix/root`

The two P1 findings above remain the causal review record. Current source now implements their
requested corrections:

- direct-Pi and generic process waiters share one action-length run-authority guard; after acquiring
  it they require a normal exact control namespace, an existing validated project registry, a live
  matching registration, and absence of both deletion markers before reading or writing an agent;
- direct Pi then re-reads and matches run, agent, ticket, stage, persona, attempt, input, worktree,
  PID, process birth identity, started boundary, and a receipt-accepting status. Acquisition or
  currentness failure performs no record, PID, or ticket cleanup;
- paused registration and an open question deliberately do not invalidate this diagnostic receipt,
  while tombstoned, unregistered, concluded, and missing-control cases do;
- exact turn/error projection merges into the existing result object (or wraps a legacy scalar),
  preserving `compiler_owned_recovery` and unrelated evidence; and
- the exact-live snapshot now permits only internally complete, dead-process terminal history and
  rejects every other non-`running` row except its own already-validated aggregate marker.

Focused private-target verification passes direct-Pi currentness/race/result tests **3/3**, shared
generic reaper **1/1**, transitional classifier **1/1**, the production passive-supervisor lifecycle
matrix **1/1**, existing explicit recovery **3/3**, late provisional receipt correction **1/1**,
and a production Core library check. No live state or runtime artifact was touched. The original P2
coverage recommendations remain follow-up hardening rather than part of this P1 correction.
