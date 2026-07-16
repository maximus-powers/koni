# Planned proof-source relocation lifecycle tests

- Owner: `relocation-lifecycle-tests/root`
- Status: `in_progress`
- Started: 2026-07-16 MST

## Exact lease

Add public integration coverage in the new file
`crates/koni-core/tests/planned_proof_source_relocation.rs` only. The test exercises a
profile-pinned legacy Software run with the proactive proof-path graph constraints removed before
`Engine::open`, then proves the journaled `planned-proof-source-relocation` happy path and exact
replay behavior through configured actions. If feasible through public state files, it also proves
the final `status: complete` / missing completion-event crash seam.

No production Rust, profile/template, existing test, live run, binary, process, product worktree,
Git ref, or cockpit/cmux mutation belongs to this lane. Documentation updates are append-only.

## Coordination checkpoint

Read `docs/AGENT_COLLAB.md` and the complete read-only recipe in
`docs/agent-collab/relocation-test-audit.md`. The fixture must create a real reviewed preparation
binding, use configured `compile` so the failure has an action Journal, pause through
`RunControlStore`, and anchor the relocation steer to the exact completed preparation ticket.

## Questions for other personas

<!-- Append signed questions or overlap warnings here. -->

## 2026-07-16 — first public-path finding

The new fixture reached transaction preparation through the real configured `steer` action and
exposed a production defect before any publication occurred. The attempted guard-only staging call
used `evaluate_rule_with_preparations(..., &[])`; that empty slice also became the
`GraphResolver`'s semantic preparation context. Software's `diagnosed_defects` selector therefore
lost its true `proof_preparation_current` fact and the exact implementation rule produced zero
candidates, even though the preceding configured compile had selected and rejected that candidate
under the prepared-source admission guard.

This was routed to `primary-integrator/root`. The required correction is to preserve current
preparations for semantic query/rule evaluation while disabling only the final prepared-source
write-conflict admission for the compiler's blocked-candidate comparison. The focused test is
intentionally left red at `expected one guard-suppressed candidate, found 0` until that production
boundary is corrected; this lane will not edit `engine.rs`.

**Evolving result:** the production evaluator now keeps current preparation facts in the resolver
and independently disables only final admission. The public test advanced to staged-ticket
comparison and exposed the next overly strict invariant: the ticket fixed-identity projection
included ticket/step `read_paths`, even though an exact proof declaration relocation necessarily
moves compiler-derived read authority from the old proof source to the new one along with write
authority. This was routed to the implementation owner. The correction must prove the exact
old-to-new path substitution across every derived read/write surface while retaining the ticket's
semantic rule/workflow/persona/node/status identity; simply omitting path fields without that delta
proof would be too weak.

The configured public action path does not expose the true committed-steering-action / absent-
transaction crash midpoint because reconciliation follows action commit immediately. A focused
state-envelope reconstruction can still remove the completed transaction after capturing its
authentic owning event and complete action Journal to prove ordinary quarantine recognizes an
event/Journal pair with no transaction. A private unit failpoint remains the strongest way to
prove the exact pre-publication graph/ticket/Journal bytes at that instant.

## 2026-07-16 — staging purity and historical-read findings

The first relocation preflight initially published its staged graph amendment before the steering
event or transaction existed. The source was `materialize_derivations`: despite being called on a
clone for validation, its final block persisted every derived node. The next preflight therefore
saw the already-relocated proof and correctly rejected the missing old declaration. The production
owner split derivation materialization into pure in-memory and publishing paths; relocation uses
the pure path for both staged graphs.

The fixture then advanced to new-path conflict validation and found a distinct overconstraint. A
closed historical `map-architecture` ticket retains `read_paths: ["."]` and no write paths. Treating
that broad historical read declaration as conflicting filesystem authority rejects every possible
new project path, even though the only preparation ticket writes exactly the old proof file. The
new-path guard must remain fail-closed against actual conflicting write authority without turning
terminal read history into permanent path ownership. This exact ticket/scope was routed to the
production owner.

Complete-state replay coverage in this lane remains deliberately paused/quiescent. It can prove
sealed replay after a legitimate later full compile, but it does not by itself prove replay after
the scheduler has resumed active work; the security review notes that current complete-state paths
still invoke quiescence checks. That distinction must stay explicit until production defines the
historical replay contract.

## 2026-07-16 — released public lifecycle coverage

**Status: `ready_for_integration`.** The earlier replay limitation is superseded by the stabilized
complete-state path and a stronger fixture: after a legitimate later full compile, the test sets
orchestration back to `running: true`, replays the exact configured steer, receives
`already_relocated`, and proves graph, tickets, Journals, events, and transaction semantic hashes
are unchanged. It pauses again only before exercising incomplete-seal recovery.

The happy-path fixture now proves the exact whole-graph delta, unchanged prior ticket hashes,
old-to-new ticket and compiled-check member path/argv authority, the sole Failed-to-Recovered
compile-Journal status change, owning steering event and complete action-Journal binding, exact
full-compile and completion-event payloads, resumed sealed replay, missing-event healing, and
healed replay idempotence. An independent fixture removes the authentic complete transaction and
completion event while retaining its committed steering event and complete Journal, then proves an
ordinary configured compile is quarantined as `committed-request-awaiting-transaction`.

Exact verification:

```text
CARGO_TARGET_DIR=/Users/max/Desktop/.koni-relocation-lifecycle-target \
  cargo test --locked -p koni-core --test planned_proof_source_relocation -- --nocapture

running 2 tests
test committed_relocation_request_without_transaction_quarantines_ordinary_authority ... ok
test planned_proof_source_relocation_is_journaled_exact_and_replay_safe ... ok
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

Scoped `rustfmt --edition 2024` and `git diff --check` are clean. Warning-denied Clippy reached only
three production-owned relocation warnings (one collapsible `if`, two helper arity warnings); they
were routed to `primary-integrator/root` and this test-only lane did not edit them. No production,
profile, existing test, live state, binary, process, product worktree, Git ref, or cockpit/cmux
surface was mutated.

### Explicit backend boundary

This released fixture copies Software, whose storage backend is `git_common_dir`. It does not claim
coverage for Research's `tracked` backend. The security review subsequently identified that a
tracked relocation compile may checkpoint state through `audit_state`, advance integration HEAD,
and then fail the transaction's pinned-HEAD CAS. That distinct production finding and its required
tracked-backend regression were routed to `primary-integrator/root`; the **2/2** result above remains
valid specifically for the leased Software/Git-common-dir public lifecycle.

## 2026-07-16 — superseding tracked-backend extension checkpoint

The parent extended this same new-file lease to one public `tracked` backend regression. The
fixture now uses the real tracked topology (`plan_run` → deterministic fake planning result →
`approve_run` → `open_run`), keeps semantic state beneath the approved integration worktree, and
keeps orchestration in the shared Git-common run control root. A temporary copied-Software finish
recipe uses the minimal tracked boundary: validate the accepted review, transition the ticket,
validate integration, and squash the already-reviewed ticket branch. The earlier Research-style
`graph.apply_delta` plus recomputed snapshot was invalid for this fixture because it replaced the
already-materialized Software review effect; the minimal recipe preserves `prepared` identically
in both the integration file and HEAD tree.

The two Git-common regressions remain green under the safer explicit-recovery contract. Missing-
seal recovery now reconciles through `preflight_planned_proof_source_relocations` before generic
dispatch rather than returning `generic_recovery_deferred`.

**Current tracked hold (production-routed):** the fixture commits all direct synthetic relocation
preconditions and proves an empty libgit2 status immediately before `steer`. Production then
checkpoints H1 but its relocation cleanliness CAS reports the current Complete steer Journal itself
as dirty (`program/journals/<steer-journal>.yaml`). The dirty ID is distinct from the Failed compile
Journal. This exact boundary is routed to `primary-integrator/root`; this lane will not patch
`engine.rs`. Once cleared, tracked assertions require H0 → H1 (owning action event/Complete Journal)
→ H2 (complete relocation seal), with `transaction.integration_head == H1`, H2 a direct child of
H1, and exact sealed replay after later legitimate tracked progress.

## 2026-07-16 — tracked phase matrix implemented; final hardening rerun pending

The preceding dirty-Journal hold is superseded. The production owner separated the in-flight
steering event's pure semantic preview from post-request transaction preparation, so the Complete
Journal and owning event can form H1 before tracked workspace cleanliness is asserted. The public
tracked happy path now proves H0 → H1 → H2, pins `transaction.integration_head` to H1, requires H2
to be H1's direct child, advances through a legitimate later tracked compile, and resolves exact
replay from the reachable historical seal while orchestration is running.

The new integration target also reconstructs six independent crash images from authentic tracked
history. Every row first captures a real complete relocation and asserts that the exact H1-to-H2
tree delta contains only the transaction, event ledger, recovered compile Journal, amended proof
node, and deterministic expected ticket. A fixture-scoped libgit2 CAS then restores the disposable
integration ref, index, and checkout to H1 before overlaying only the selected phase's
production-captured artifacts:

- committed request with no transaction;
- `prepared` after the amended graph write;
- `graph_published` after ticket and full-compile event publication;
- `compiled` after exact Failed-to-Recovered Journal publication;
- `complete` without its completion event;
- complete poststate and event with the tracked checkpoint absent.

Each phase rejects ordinary compilation under global quarantine, completes through the configured
`recover` action, preserves the exact amended node, deterministic ticket, and recovered Journal,
produces one self-hashed complete transaction and one completion event, leaves a clean tracked
checkout descended from H1, and then accepts the original exact steer request while running without
changing semantic hashes or HEAD. Scoped `rustfmt` plus the full public target were green at **4/4**
in 35.78 seconds.

That result is an implementation checkpoint rather than final release evidence: a concurrent
security hardening is centralizing H1 creation inside reconciliation (so no-transaction recovery
can establish the same boundary) and converting H2 to an exact required-path parent-CAS
checkpoint. The test lane is paused until that production save point is declared stable, then will
rerun the full target and warning-denied Clippy. This lane still owns only the new integration test
and append-only documentation; it changed no production/profile/template/existing-test/live/
binary/process/product-worktree/cockpit surface.

## 2026-07-16 — tracked lifecycle matrix released after exact checkpoint hardening

**Status: `ready_for_integration`.** The preceding pending-rerun checkpoint is superseded. H1 is
now created or verified inside committed no-transaction reconciliation from the exact owning event
ledger and Complete steer Journal. H2 explicitly stages its six authority paths and publishes only
from `transaction.integration_head` through a parent-CAS checkpoint. Complete historical replay
skips H2 creation when that exact seal is already reachable; the temporary predicate diagnostics
that isolated the unconditional checkpoint call have been removed.

The public tracked happy path adds an exact H0-to-H1 tree-delta assertion: only `events.jsonl` and
the transaction-named Complete steer Journal may change. It also proves H2 is H1's direct child,
then advances through a legitimate tracked full compile and resolves the original exact steer from
historical H2 while orchestration is running, without changing HEAD or semantic state. The phase
matrix independently asserts H1-to-H2 is exactly the transaction, event ledger, recovered compile
Journal, amended proof node, and deterministic expected ticket before reconstructing and recovering
all six durable crash states.

Final verification against the stable engine/Git save point:

```text
CARGO_TARGET_DIR=/Users/max/Desktop/.koni-relocation-lifecycle-target \
  cargo test --locked -p koni-core --test planned_proof_source_relocation -- --nocapture

running 4 tests
test committed_relocation_request_without_transaction_quarantines_ordinary_authority ... ok
test planned_proof_source_relocation_is_journaled_exact_and_replay_safe ... ok
test tracked_backend_relocation_pins_action_checkpoint_then_seals_and_replays ... ok
test tracked_backend_relocation_recovers_every_durable_publication_phase ... ok
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 33.20s

CARGO_TARGET_DIR=/Users/max/Desktop/.koni-relocation-lifecycle-target \
  cargo clippy --locked -p koni-core --test planned_proof_source_relocation -- -D warnings
Finished dev profile ...
```

Scoped `rustfmt --edition 2024`, no-index whitespace checks for the new test and append-only docs,
and the diagnostic-symbol scan are clean. This lane changed only the new public integration test
plus its append-only coordination records; no production/profile/template/existing-test/live/
binary/process/product-worktree/Git-ref/cockpit surface was edited by this owner.

## 2026-07-16 — pre-H1 partial action-success crash extension active

The test-only lease is reopened for one narrower tracked crash window found after the preceding
release: the exact relocation-owning steering event and Complete steer Journal are durable, but
the correlated `compiler.action.steer` completion event is absent and same-input failed retry
Journals may be only partially transitioned to `Recovered`. The extension will restore a fresh
authentic tracked fixture to H0, overlay the captured owner/Complete-Journal authority plus one
Failed and one already-Recovered same-input retry Journal, and omit both transaction and action-
completion event.

Required public behavior is configured recovery that reconstructs exactly one action-completion
event bound to the complete retry set, transitions both prior attempts to exact Recovered state,
creates H1 from only the event ledger and three steer Journals, seals H2, and accepts running exact
replay without another event, transaction, or checkpoint. Production remains owned by
`primary-integrator/root`; this lane will not rerun until that owner declares the recovery fix
stable, and will edit only the existing new integration target plus append-only coordination notes.

## 2026-07-16 — pre-H1 partial action-success regression released

**Status: `ready_for_integration`.** The preceding extension is complete. A fresh real tracked
relocation is captured through H2, then its disposable integration checkout is restored to the
authentic H0. The test overlays only the exact captured relocation-owning steering event and
Complete steer Journal, plus two schema-valid exact-same-input prior steer attempts: one Failed and
one already Recovered. It deliberately omits `compiler.action.steer`, H1, the relocation
transaction, and every relocation poststate artifact.

The reconstructed crash first quarantines ordinary compilation. Configured recovery then creates
exactly one `compiler.action.steer` event without replaying the recipe, binds both prior retry IDs,
changes only the Failed retry's status to Recovered, and commits an exact four-path H1 delta:
`events.jsonl` plus the successful and two prior steer Journals. The test reads the H1 blobs—not
only the current checkout—to prove the event and both recovered Journals are already durable at
that boundary. It then locates H2 as H1's first-parent child, reuses the existing exact five-path
H1-to-H2 assertion, verifies the complete relocation authority, and proves running exact replay
does not add an event, transaction, or checkpoint.

Final stable-source verification:

```text
CARGO_TARGET_DIR=/Users/max/Desktop/.koni-relocation-lifecycle-target \
  cargo test --locked -p koni-core --test planned_proof_source_relocation -- --nocapture

running 5 tests
test committed_relocation_request_without_transaction_quarantines_ordinary_authority ... ok
test planned_proof_source_relocation_is_journaled_exact_and_replay_safe ... ok
test tracked_backend_relocation_pins_action_checkpoint_then_seals_and_replays ... ok
test tracked_backend_recovery_reconstructs_partial_action_success_before_h1 ... ok
test tracked_backend_relocation_recovers_every_durable_publication_phase ... ok
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 33.69s

CARGO_TARGET_DIR=/Users/max/Desktop/.koni-relocation-lifecycle-target \
  cargo clippy --locked -p koni-core --test planned_proof_source_relocation -- -D warnings
Finished dev profile ...
```

Scoped formatting remains clean. This reopened lane changed only its existing new public test and
append-only coordination records; production/profile/template/existing-test/live/binary/process/
product-worktree/Git-ref/cockpit state remained outside its lease.

## 2026-07-16 — post-H2 operational-finalization crash extension active

The test-only lease is reopened for the tracked subwindow after the exact semantic H2 exists but
before ticket-worktree synchronization, transient-tree repair, and the Git-common synchronization
marker are durably acknowledged. A fresh fixture will preserve the complete transaction,
completion event, and integration H2, remove only the exact sidecar marker, and reset one retained
clean leased ticket ref/worktree to its recorded base when the fixture permits that faithful
operational reconstruction.

Required behavior is fail-closed ordinary authority, configured recovery that leaves integration
HEAD/H2 unchanged, advances and repairs the eligible ticket checkout to H2, and writes the exact
marker binding transaction ID/hash, run, integration ref, and seal commit. Running exact replay
must then leave semantic state, marker bytes, integration HEAD, and synchronized ticket ref/
worktree unchanged. This lane remains restricted to its existing new integration target and
append-only coordination notes; production is owned by `primary-integrator/root`.

## 2026-07-16 — post-H2 finalization and malicious-H1 regressions released

**Status: `ready_for_integration`.** The post-H2 extension is complete, together with the security
review's final request-checkpoint rejection case. The tracked fixture now attaches a genuinely
empty, command-free retained checkout to compiler ticket state before H1. Its branch, index, and
workdir begin at the exact recorded lease base; the normal production relocation is first required
to synchronize all three through authentic H1 and H2 before its Git-common marker can be captured.

The operational-finalization regression then reconstructs two durable crash windows while keeping
the complete transaction, completion event, and semantic H2 exact:

- marker absent, ticket branch/index/workdir all still at the recorded lease base; and
- marker absent, ticket branch ref and HEAD already H2 while its index and workdir remain exactly
  the transaction-pinned H1 tree.

Ordinary compiler authority is quarantined in both windows. Configured recovery returns the
relocation preflight directly, leaves integration ref/HEAD exactly H2, does not add semantic events,
Journals, transactions, or checkpoints, advances/repairs the retained checkout to a clean H2, and
recreates the byte-exact marker binding schema, transaction ID/hash, run, integration ref, and seal
commit. Running exact replay then preserves semantic hashes, integration HEAD, marker bytes, and the
synchronized ticket checkout.

The separate malicious-H1 regression restores authentic H0 and commits the exact owning steering
event, exact `compiler.action.steer` completion event, Complete steer Journal, and one unrelated
product file in one clean single-parent commit. Ordinary authority remains quarantined and
configured recovery rejects the commit as containing unrelated request-checkpoint tree changes;
the unrelated bytes and malicious HEAD remain fixed, and no relocation transaction or completion
event is published.

Final stable-source verification:

```text
CARGO_TARGET_DIR=/Users/max/Desktop/.koni-relocation-lifecycle-target \
  cargo test --locked -p koni-core --test planned_proof_source_relocation -- --nocapture

running 7 tests
test committed_relocation_request_without_transaction_quarantines_ordinary_authority ... ok
test planned_proof_source_relocation_is_journaled_exact_and_replay_safe ... ok
test tracked_backend_recovery_rejects_unrelated_request_checkpoint_change ... ok
test tracked_backend_relocation_pins_action_checkpoint_then_seals_and_replays ... ok
test tracked_backend_recovery_finalizes_existing_h2_without_advancing_integration ... ok
test tracked_backend_recovery_reconstructs_partial_action_success_before_h1 ... ok
test tracked_backend_relocation_recovers_every_durable_publication_phase ... ok
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 33.13s

CARGO_TARGET_DIR=/Users/max/Desktop/.koni-relocation-lifecycle-target \
  cargo clippy --locked -p koni-core --test planned_proof_source_relocation -- -D warnings
Finished dev profile ...
```

Scoped Rust formatting and diagnostic scans are clean. This lane changed only its existing new
public integration target and append-only coordination records; production/profile/template/
existing-test/live/binary/process/product-worktree/Git-ref/cockpit state remained outside its
lease.

## 2026-07-16 — final retry-binding/tree-exclusion hardening active

The test-only lease is reopened for two final fail-closed boundaries requested after production
hardening. First, a durable `compiler.action.steer` success event whose
`superseded_failed_journals` omits one canonical earlier exact-input Recovered Journal must be
rejected before H1 or any relocation transaction is accepted. Second, an otherwise-exact manual H1
that retains or adds a blob beneath the configured tracked `program/locks` tree exclusion must be
rejected rather than treating the excluded subtree as an allowed request delta.

This lane remains restricted to its existing new public integration target and append-only
coordination records. `primary-integrator/root` retains production ownership; no profile/template,
existing test, live state, binary, process, product worktree, Git ref, or cockpit surface is in this
lease.

## 2026-07-16 — final retry-binding/tree-exclusion regressions released

**Status: `ready_for_integration`.** Both final fail-closed cases are implemented and green. The
retry-binding regression restores authentic H0, writes the exact owner, existing
`compiler.action.steer` success event, and Complete Journal, then adds one canonical earlier
exact-input Recovered Journal that the event omits. Ordinary authority is quarantined and recovery
rejects the noncanonical success record while HEAD remains H0 and no transaction or H1 is
accepted.

The tree-exclusion regression restores authentic H0 and handcrafts a clean, single-parent H1 whose
exact delta is the event ledger, Complete Journal, and one forcibly tracked blob beneath
`program/locks`. The test independently proves that path is a real blob with exact bytes in H1.
Configured recovery rejects that current H1 as retaining tree-excluded authority before any
cleanup checkpoint can advance HEAD; no transaction or completion event is published.

Final stable-source verification:

```text
CARGO_TARGET_DIR=/Users/max/Desktop/.koni-relocation-lifecycle-target \
  cargo test --locked -p koni-core --test planned_proof_source_relocation -- --nocapture

running 9 tests
test committed_relocation_request_without_transaction_quarantines_ordinary_authority ... ok
test planned_proof_source_relocation_is_journaled_exact_and_replay_safe ... ok
test tracked_backend_recovery_rejects_unrelated_request_checkpoint_change ... ok
test tracked_backend_recovery_rejects_action_success_missing_canonical_retry_binding ... ok
test tracked_backend_recovery_rejects_tree_excluded_blob_in_request_checkpoint ... ok
test tracked_backend_relocation_pins_action_checkpoint_then_seals_and_replays ... ok
test tracked_backend_recovery_finalizes_existing_h2_without_advancing_integration ... ok
test tracked_backend_recovery_reconstructs_partial_action_success_before_h1 ... ok
test tracked_backend_relocation_recovers_every_durable_publication_phase ... ok
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 41.99s

CARGO_TARGET_DIR=/Users/max/Desktop/.koni-relocation-lifecycle-target \
  cargo clippy --locked -p koni-core --test planned_proof_source_relocation -- -D warnings
Finished dev profile ...
```

Scoped formatting, diagnostic scans, and whitespace checks are clean. This reopened lane changed
only its existing new public integration target and append-only coordination records; production,
profiles/templates, existing tests, live state, binaries, processes, product worktrees, Git refs,
and cockpit state remained outside its lease.
