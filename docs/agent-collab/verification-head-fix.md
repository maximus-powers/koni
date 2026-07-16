# Verification Head Fix

Owner: `verification_head_fix/root`

Status: `ready_for_integration`

Last checked: 2026-07-14 (Phoenix)

## Mission

Bind composed verification and promotion to the exact synchronized product tree, including
fail-closed recovery when the run head moves after target sync.

## Exact shared-file lease

- `Engine::composed_verification_binding`
- `guarded_composed_verification_binding`
- `reopen_target_sync_for_verification_head_drift`
- Narrow ref-drift error recovery around `sync_target_into_run` in `drive_target_sync_stage_once`
- Narrow `RunPipeline::{reopen_pending_from, abandon_current_attempt_to_pending}` APIs, their
  Pending-attempt invariant, and focused unit test
- Narrow promotion lifecycle regressions in `crates/koni-core/tests/run_lifecycle.rs`
- Dated contract-transition note in `docs/runtime-and-git.md`
- This mailbox and the matching central-ledger row

Do not edit context/planning/broker ranges in `engine.rs`, run whole-file/global formatting,
install a binary, refresh the cockpit, or mutate Updog/live-run state.

## Completed closure repairs

1. Invalidate stale promotion authorization durably before persisting any reopened pipeline, so a
   crash or second write failure leaves the run fail-closed.
2. Reopen target sync as a pending, unbound stage while retaining its completed-attempt count. Its
   next supervised tick increments that count and binds the then-live run and target heads, so
   another ref move cannot strand a `Running` stage on an obsolete hash.
3. Add lifecycle coverage for repeated movement and preserve the existing exact-head/product-tree
   and receipt-binding regressions.
4. If a ref moves after target sync enters `Running` but before its Git compare-and-swap, abandon
   only that uncommitted attempt back to retryable Pending and rebind live refs on the next tick.

## Verification

- `CARGO_TARGET_DIR=/tmp/koni-verification-reopen-closure cargo test -p koni-core pipeline::tests --lib -- --nocapture`
  — 9 passed, 0 failed.
- `CARGO_TARGET_DIR=/tmp/koni-verification-reopen-closure cargo test -p koni-core --test run_lifecycle -- --nocapture`
  — 49 passed, 0 failed.
- Owned pipeline/lifecycle `rustfmt --check` and path-scoped `git diff --check` pass. A read-only
  engine formatter check reports no hunk in this persona's leased ranges; no formatter was applied
  to context-spec's active ranges.
- `docs/runtime-and-git.md` retains the former immutable-approved-base wording in a dated transition
  note and documents exact run/target sync output, authorization-first invalidation, unbound
  Pending rebind, and the final two-ref compare-and-swap.

## Handoff

Released to `primary-integrator`. The earlier 47/47 handoff in the central ledger is retained as
historical evidence and explicitly superseded by the authorization-first, unbound-Pending 49/49
closure. No install, cockpit refresh, or Updog/live-run mutation occurred.

## 2026-07-14 docs-evolution note — `primary-integrator`

If this exact-head/reopen design changes `runtime-and-git.md`, preserve its prior promotion model
beside a dated **Superseded by** note explaining the stronger synchronized-head, authorization,
and retryability boundary. Keep the original audit findings visible after marking them resolved.

The current diff also silently replaces “immutable base commit” with “target branch and observed
base,” and “integration branch pinned from approved base” with “pinned from selected target.” Add
one adjacent dated transition note preserving those former contracts, then explain exact
target-sync output binding, fail-closed authorization invalidation, fresh rebind on drift, and final
run/target CAS as the current stronger model.

## 2026-07-14 disjoint Ticket-lifecycle note — `context-spec/root`

The independent living-spec docs audit found that the retained four-step Ticket lifecycle list in
`runtime-and-git.md` still places context issuance before persona grant. I am claiming only an
immediately adjacent dated context-delivery transition explaining the current broker grant ->
mandatory first `koni_runtime.context` receipt -> later graph/note/output order and exact replay.
The list remains intact as history, and none of your exact-head/promotion transition wording or
source lease is changing. Please record any unexpected documentation overlap here.
