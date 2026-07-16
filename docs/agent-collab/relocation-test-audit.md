# Planned proof-source relocation test audit

- Owner: `relocation-test-audit/root`
- Status: `in_progress` (read-only)
- Started: 2026-07-16 01:22 MST

## Exact lease

Read-only inspection of the proposed `planned-proof-source-relocation` transaction in
`crates/koni-core/src/engine.rs`. This lane may map reusable action/event/journal replay helpers,
transaction invariants, fixture construction, and focused regressions. Its only writes are this
append-only mailbox and the bounded central-registry claim.

No Rust, profile, fixture, installed-project, live-run, binary, process, product worktree, Git ref,
or cockpit/cmux mutation belongs to this lane. The implementation lease remains with
`primary-integrator/root`; overlapping source will not be formatted or edited.

## Coordination checkpoint

Read the central registry and current mailbox status, with special attention to the primary
integration, semantic read-scope rebind, prepared-proof source, generic path-disjointness, and
Software profile lanes. The active design must preserve the compiler's file-level authority model:
relocation repairs one still-planned proof source, never weakens the prepared-source collision
guard, and becomes visible only through a hash-bound replay-safe compiler transaction.

## Questions for other personas

<!-- Append signed questions or overlap warnings here. -->

## 2026-07-16 01:31 MST — early replay findings routed

Two implementation-affecting boundaries were sent directly to `primary-integrator/root`:

1. The bundled Software `steer` action cannot produce a ticketless event. Its recipe references
   `${params.ticket}` and action dispatch resolves any supplied ticket before the event primitive.
   Omitting the optional parameter fails template resolution; supplying the still-unpublished
   expected candidate ID fails ticket lookup. The narrow live-compatible authority is therefore
   the existing conflicting preparation ticket: require the event's ticket binding to equal that
   exact preparation binding while `target_nodes` names only the still-planned proof being moved.
   The transaction should retain the full conflicting preparation binding (or equivalent explicit
   ticket/source/check/path fields), not only its opaque hash.
2. Exact expected-ticket presence is not a successful full-compile boundary. Full compilation
   publishes tickets incrementally and appends `compiler.compile.full` only after all rule,
   retirement, and change-control work succeeds. A crash or later-rule failure may therefore leave
   the expected candidate present without a completed compile. The transaction must bind the
   pre-compile event baseline and the exact new full-compile event ID/hash; recovery reruns the
   compiler unless that success boundary and an audit-valid poststate are both present.

Recovery must also detect a committed relocation steering event whose transaction file is not yet
created. Detecting only an unfinished transaction leaves a crash window in which generic recovery
can mark the relocation's failed compile journal `recovered` before the semantic correction is
prepared. Generic recovery should defer while any committed relocation request is absent or
non-complete, then let the post-action reconciler run after the non-reentrant locks are released.

## 2026-07-16 02:18 MST — final read-only implementation and test map

The current implementation closes the two earlier publication defects:

- `planned_proof_source_relocation_full_compile_event` now resolves an already sealed full-compile
  event by its exact ID and hash and therefore ignores legitimate later full compiles. Before a
  seal exists it still requires exactly one post-baseline candidate with the prepared semantic
  graph hash and complete derived-ticket set.
- `publish_planned_proof_source_relocation_transaction` checks the relocation completion-event
  namespace before publishing the graph amendment, so a conflicting audit event cannot turn into
  a post-mutation failure.

### Smallest faithful fixture

Use `SoftwareFixture` in `crates/koni-core/tests/software_proof_gate.rs` (currently near line 2534)
for the real lifecycle test. Its `complete_preparation_ticket` helper (near line 2779) creates the
actual reviewed preparation receipt and source binding required by
`current_proof_preparation_bindings`; do not synthesize only a ticket or receipt. The prepared
source collision at the end of
`software_bug_fix_bootstraps_prepares_diagnoses_then_plans_the_causal_change` (test starts near line
592; collision near line 793) is the closest existing scenario.

Add a constructor variant which removes the two current proactive `graph_constraints` beginning at
`crates/koni-cli/templates/software/graph.yaml:1092` from the copied temporary profile *before*
`Engine::open`. This intentionally models a profile-pinned legacy run whose persisted graph can
contain the declaration collision that the new default profile now prevents. The production
profile must remain unchanged. Run the failing compile through configured
`engine.execute_action("compile", ...)`, not `SoftwareFixture::compile`, because the relocation
contract requires the real failed action `Journal`. Pause the fixture with public
`RunControlStore` and `OrchestrationState::new(false, 1)`, and anchor the structured `steer` event to
the exact completed preparation ticket.

For private crash-phase injection, copy the shape of `ReadScopeRecoveryFixture` and
`prepare_read_scope_rebind_without_publication` in `engine.rs` (currently near lines 68848 and
69208). Those helpers already demonstrate how to commit a compiler steering event and correlated
complete action Journal, persist a prepared transaction directly, force a publication midpoint,
assert ordinary-action quarantine, and recover idempotently.

### Required invariants and focused cases

1. Happy path moves only the still-planned proof's `spec.source_paths` and exact resolving command
   argument. The reviewed preparation node, source identity, ticket, review, receipt, and source
   bytes remain hash-identical. The deterministic expected ticket moves all write authority from
   the old path to the new path; the failed compile Journal becomes the exact `Recovered` image;
   exactly one bound `compiler.compile.full`, complete transaction, and completion event exist.
2. A committed request with no transaction and a `graph_published`/`compiled` midpoint both defer
   generic recovery and quarantine ordinary compile/report/start paths until reconciliation.
3. Presence of the expected ticket without the exact post-baseline full-compile event is not
   success: recovery invokes the compiler and seals only its completion event.
4. A conflicting completion event fails before graph, ticket, preparation, or Journal mutation.
5. Exact replay after later legitimate graph/ticket/Git progress and later full-compile events
   returns `already_relocated` from sealed historical identity rather than revalidating mutable
   current authority.
6. Reject no/ambiguous preparation conflict; a live scheduler, agent, Lead slice, worker lease, or
   broker grant; existing proof ticket/evidence; existing/protected/symlink/aliased/overlapping new
   paths; no or multiple old command arguments; a new path outside the working directory; the
   wrong failed Journal; graph/head/ticket/preparation CAS drift; and a tampered transaction.

### Remaining P0 crash seam

Publication currently writes `status: complete` and its final transaction hash before appending
the completion event (currently near `engine.rs:25549-25552`). Both
`committed_planned_proof_source_relocation_pending` (near line 60966) and global quarantine (near
line 66765) classify every complete transaction as finished without verifying that exact event.
A crash between those two durable writes therefore permits ordinary actions and generic recovery,
while exact completed-action replay fails historical validation for the missing event before its
replay branch can invoke reconciliation.

Treat a complete transaction with a missing, duplicated, or mismatched completion event as pending
and quarantined, while allowing the relocation reconciler's existing complete branch to append the
missing exact event and validate history. Add a midpoint test that persists the final transaction
and recovered Journal but omits the event, proves ordinary action quarantine/generic-recovery
deferral, and then proves one recovery append plus idempotent replay.

## Status transition

This audit is complete and the read-only lease is released. No Rust, profile, test fixture, live
state, installed binary, process, worktree, Git ref, or cockpit/cmux surface was changed. Only this
mailbox and the central append-only coordination ledger were updated.
