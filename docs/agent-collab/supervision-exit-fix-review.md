# Supervision exit-publication post-fix review

Owner: `supervision-exit-fix-reviewer/root`

Status: `approved_no_p0_p1`

Reviewed: 2026-07-16 10:04 America/Phoenix

## Scope

Independent post-fix review of the two P1 findings in
[`supervision-recovery-review.md`](supervision-recovery-review.md):

- direct-Pi and generic process-exit publication authority/currentness; and
- the exact-live passive-supervision treatment of additional agent rows.

The exact current `engine.rs` and `run_lifecycle.rs` implementations, their concurrent diff, the
implementation mailbox, and the focused/composed verification evidence were inspected. No
production source, binary, runtime bundle, process, cmux surface, run, fixture, worktree, or Git ref
was changed. This review changed only review/coordination documentation.

## Verdict

**Approved. No P0 or P1 release blocker remains in this lane.** Both former P1s are closed without
minting new model or mutation authority. The source is ready for the parent integrator's guarded
runtime refresh. The residual items below are P2 hardening and do not change this verdict.

## Former P1 closure — exact exit publication

`acquire_agent_exit_publication_authority` now establishes the correct serialization and
currentness envelope:

- the stable run-authority lock is mandatory and uses the 30-second action timeout; acquisition
  failure returns before the agent, ticket, or PID record is touched;
- while that barrier is held, both the global tombstone and run-local deletion journal are checked
  before and after currentness discovery;
- the project registry must already exist as a regular non-symlink file, parse and validate, point
  back to the same Git-common sidecar, retain the exact run as a live registration, and match the
  direct-Pi profile hash when one is pinned;
- sidecar, `runs`, and exact control roots must exist as regular directories rather than symlinks,
  and the supplied control root must equal the registry-derived run root; and
- direct Pi then re-reads the exact agent under the barrier and binds run, agent, ticket, step,
  persona, attempt, input, canonical worktree, PID, process-group/birth identity, started boundary,
  and a receipt-accepting status before replacement.

This preserves the intentional diagnostic distinction: `Paused` registrations and open questions
do not suppress the exact receipt of a process that already existed, but stopped, concluded,
unregistered, deleted, redirected, profile-mismatched, replaced, or missing-control state does.
The path starts no new work.

The late correction is evidence-preserving. `exited_without_receipt` remains receipt-accepting; an
exact success or failure replaces only its provisional status/exit boundary. Existing object
fields—including `compiler_owned_recovery` and unrelated evidence—survive, while a legacy scalar
is wrapped as `prior_result`. Successful deterministic ticket-worker cleanup occurs only after the
exact raw record write and under the same run barrier. The generic reaper uses the same authority
guard and exact process identity.

The earlier grant teardown call is a separate monotonic capability-revocation path. It may mark an
existing grant revoked before raw exit publication, but it cannot publish an agent, ticket, or PID
receipt, is serialized by the grant lock, and broker ingress independently requires live run
authority. It therefore does not reopen the former P1; documentation should continue to avoid the
broader claim that literally no sidecar teardown write can precede the receipt guard.

## Former P1 closure — exact-live passive supervision

The snapshot now uses a closed rule instead of selecting only the visible `running` subset:

- the one exact `waiting_workers` aggregate is validated separately;
- every `running` row is included and must pass the complete worker/ticket/lease/worktree/process
  binding checks, so an extra running Lead or worker cannot hide outside the binding hash;
- every other row must satisfy the closed terminal-history predicate, which requires an explicit
  terminal status, a finished boundary, and no matching or bare live process; and
- all unknown or unfinished statuses therefore fall through to ordinary compiler supervision.

The unit matrix rejects `starting`, `reaping`, `active`, `waiting`, `boundary_committed`, and the
known compilation/review/recovery transitions. The production lifecycle regression separately
places ticket-bound and stage-owned `starting` rows plus a ticket-bound `boundary_committed` row
beside a valid worker and proves the exact-live counter does not advance while full preflight does.
Completed and failed dead history proves the inverse: valid historical rows retain the fast path.
The existing double snapshot plus final birth-identity check still bounds a last-instant external
change to one read-only stale `Waiting` observation; the following poll re-enters full supervision.

## Verification evidence

The implementation lane's private-target checks passed:

- direct-Pi exit currentness/race/result preservation: **3/3**;
- shared generic reaper authority: **1/1**;
- exact-live transition classifier: **1/1**;
- exact passive-supervisor lifecycle regression: **1/1**;
- explicit provisional recovery: **3/3**; and
- generic late provisional correction: **1/1**.

On the exact reviewed integrated snapshot, the parent integrator's serialized gates passed Core
library **680/680** with three intentional ignores and `run_lifecycle` **51/51**. The broader
research/graph/Updog integrations were green. The only composed integration failure was the
separately owned planned-proof-relocation fixture guard, outside every symbol and behavior in this
review. Scoped `git diff --check` for the reviewed source/test/docs paths is clean.

## P2 hardening — not release blockers

1. Add an explicit 30-second-timeout exhaustion test proving no raw record, ticket cleanup, or PID
   removal occurs. The implementation is structurally fail-closed, while the current contention
   test covers successful publication after a shorter held barrier.
2. Extend path-negative coverage to a missing/symlinked registry, `runs` directory, control root,
   tombstone, and deletion journal. Current `symlink_metadata`/persistent-lock checks reject these,
   but only the missing-control case is exercised directly.
3. Add a ticket-bound direct-Pi fixture. Current direct tests use a stage-owned Lead, so the tests
   infer rather than directly observe that deleted/concluded state cannot checkpoint ticket cleanup
   and that paused/questioned success may clear only the exact existing worker lease.
4. Make terminal-history validation take the expected run ID and optionally enforce stronger
   status/exit-code consistency. A malformed or cross-run terminal audit row is harmless to current
   mutation authority because all live workers are independently bound, but falling through on
   corrupt history would be the stricter diagnostic posture.
5. Retain the original review's action-integrated recovery/idempotence cases and table-driven
   fast-path negative binding matrix as future regression depth. The P1 correction covers the
   causal failures without pretending these broader P2 matrices are complete.

## Release handoff

The exact source/test symbols are released to `primary-integrator`. The guarded refresh need not
wait on any supervision/exit-publication change from this reviewer.
