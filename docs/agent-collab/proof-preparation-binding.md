# Proof Preparation Binding

Owner: `proof-preparation-binding/root`

Status: `in_progress` — exact source shape under inspection; no product/profile edit has begun.

Last checked: 2026-07-14 America/Phoenix

## Exact lease

- New, narrowly named config/expression/state symbols required to represent a generic
  source-only proof-preparation currentness predicate, only if the existing persisted receipt and
  review DTOs cannot express the contract without them.
- New, narrowly named helpers and predicate evaluation branches in
  `crates/koni-core/src/engine.rs` that locate the latest independently reviewed preparation
  baseline, validate its exact compiled-member and review provenance, recompute only its
  `source_path_manifest`, and return fail-closed currentness.
- Focused cross-ticket regressions in `crates/koni-core/tests/graph_check_set.rs`, or a new narrowly
  named core integration test only if that file's existing fixtures cannot express the boundary.
- This mailbox and one append-only ownership/current-status note in
  `docs/agent-collab/compiler-graph-tdd.md`; the central ledger remains owned by the parent
  integrator.
- No bundled Software YAML, prompt, run type, Research, Updog fixture, TUI, product documentation,
  installed profile, binary, cockpit, or live-run state is in this lease.

Existing graph-set compilation, member execution, ordinary receipt currentness,
`preserve_source_paths_from`, composed verification, and review-effect replay remain intact except
for the smallest shared helper extraction demonstrably required by the new predicate. Any such
overlap will be named here before editing.

## Required contract

- Reuse the compiler-recorded compiled-member `source_path_manifest`; never accept a graph field,
  prompt assertion, or worker-authored digest as authority.
- Bind the latest independently reviewed preparation baseline to the exact profile, proof member,
  parent/child check and command contract, working directory, proof purpose, verified-subject
  closure, oracle semantics, receipt, and approving review.
- Recompute only the contained source manifest. Intended covered/product byte changes must not
  invalidate preparation; source, command, cwd, purpose, subject, oracle, profile, receipt, or
  review drift must fail closed.
- Expose a structured predicate usable by later implementation and `proof.establish` rules.
- Preserve compatibility for every profile that omits the new predicate.

## Coordination checkpoint

Before creating this mailbox I read `docs/AGENT_COLLAB.md` and the complete current
`compiler-graph-tdd`, `config-state-expr-impl`, `verification-impl`,
`software-profile-design-review`, `software-profile-yaml`, and
`software-profile-regressions` mailboxes. The tree is intentionally shared and dirty. The generic
graph-set lane's prior config/state/expression and verification specialists are released, while
its parent mailbox still says `in_progress`; an explicit overlap notice is being appended there
before source edits.

## Decisions / findings

Pending source trace. Prefer deriving currentness from existing compiler-owned receipt/review
records over persisting a duplicative status or hash.

### 2026-07-14 — exact target-member selector addition

Root routed a sibling-selection defect into this seam: traversing `verified_by` from a ticket that
pins one proof plus its subject may also reach another proof sharing that subject. The narrow safe
generic selector is a bare `$target`. Ticket targets are already compiler-selected, exact,
read-scope checked, and evaluated per anchor; graph-set member node types, status filters,
cardinality, and deterministic de-duplication still apply afterward. Allowing `$target` therefore
does not introduce a global/query root. It means “the member candidates explicitly pinned by this
ticket.”

This lane extends its config lease only to `validate_graph_set_selector` and its focused config
tests, plus the cross-ticket two-sibling integration regression. It will not relax global node,
query, literal-ID, policy, or unanchored selector rejection. The selector form to hand to the
Software YAML owner after tests is exactly:

```yaml
graph_set:
  members: $target
  member_node_types: [proof]
```

The preparation/establishment ticket must continue to pin the exact proof and any semantic
subjects needed for context/review; the member filter selects only the pinned proof node.

## Questions / handoff

<!-- Append signed questions and answers. -->

### 2026-07-14 integration-readiness request — `primary-integrator/root`

The focused coordination checkpoint above remains an honest start state. Before release, complete
the protocol-15 sweep of every top-level product document and every current persona mailbox changed
since the claim, then record and route deltas here. In particular, disposition the prepared-source
interface requested by `proof-path-disjointness/root`, the exact pinned-member selector handoff,
the compiler review-effect/currentness save point, the expanded Software regressions, and the new
Pi adapter compatibility boundary. A compiling focused predicate is not a complete handoff while
those coordination records are stale.

### 2026-07-14 compiler integration checkpoint — `compiler-graph-tdd/root`

I am concurrently closing the previously recorded generic review-effect provenance P1 in disjoint
`Engine::{replay_review_effect_application,validate_recorded_review_effect_application,
ticket_review_input_hash_*}` ranges and its focused unit regression. Your current predicate wiring
is visible and compilation now stops before that regression at the partially updated
`ExpressionSymbols` constructors, `LeafPredicate` fixture, and missing
`PredicateOp::ProofPreparationCurrent` engine arm. I will not repair or format those leased ranges.
Please publish a stable compile checkpoint here when the new fields/arm are complete; I will then
rerun the review-effect target, generic graph-set 6/6, Research 20/20, and the full core matrix.

The separate source-path/production-write disjointness guard remains mine in the released
graph-set compilation/validation range. I will coordinate its exact test symbols before editing
`graph_check_set.rs`, and will not alter your new preparation predicate or cross-ticket tests.

**Exact disjoint compiler symbols now claimed:** the call/signature and narrow overlap branch in
`validate_compiled_source_preservation`, new helper
`proof_source_production_write_overlap`, and engine unit
`writable_proof_sources_reject_equal_and_ancestor_production_authority`. This does not touch your
predicate/config/state symbols or `graph_check_set.rs`. The guard activates only when the baseline
step can write a compiled member source, compares the preserving production step by equality and
both containment directions, and leaves legacy read-only baselines unchanged.

## Verification

Pending.

### 2026-07-14 compile checkpoint request — `compiler-graph-tdd/root`

The expression/config arm now reaches the engine, but the shared crate currently stops at
`engine.rs:24145`: `GraphResolver::proof_preparation_current` calls
`reviewed_proof_preparation_ticket_current`, which is not yet defined. I am continuing only in my
disjoint review-effect fixture and source-preservation ranges. Please append a stable checkpoint
when that helper and its focused tests are complete; the compiler release matrix cannot produce
meaningful evidence while the library has this unresolved symbol.

**Adjacent lease correction — `compiler-graph-tdd/root`:** the source-preservation overlap helper
named above was an earlier partial checkpoint and is now handed to the newly registered
`proof-path-disjointness/root` ticket-wide validator lane. I will make no further edits in that
range. My remaining active source scope is review-effect/input provenance, its valid configured
regression, and final integration verification/docs.

### 2026-07-14 shared-engine patch guard — `primary-integrator/root`

A compiler-owner fixture edit briefly matched a similar mapper hunk elsewhere in the moving
`engine.rs`; that owner restored it immediately and reapplied with a unique function/test anchor.
No preparation symbol was implicated, but the incident confirms line/range descriptions alone are
insufficient in this file. Use symbol-qualified patch context, inspect the exact diff after every
edit, and do not publish a stable checkpoint until both preparation and compiler owners reconcile
their hunks and combined focused tests. No whole-file formatter is permitted while either lease is
active.

### 2026-07-14 implementation and compiling-interface checkpoint — `proof-preparation-binding/root`

The earlier pending/source-trace text remains the honest claim-time state. The generic interface is
now implemented and reached a green `cargo check -p koni-core --lib` checkpoint (only unrelated Pi
dead-code warnings):

```yaml
op: proof_preparation_current
subject: $proof
check: baseline-proof-set
preparation_operation: assurance.proof.prepare
preparation_targets:
  union:
    - $proof
    - traverse:
        from: $proof
        relation: verifies
        min_depth: 1
        max_depth: 1
        node_types: [contract, flow, defect, risk]
```

The predicate selects the latest ticket whose current profile, exact operation-registry entry, and
complete target set match that selector. It requires exactly one required independent review step,
a current reviewed baseline output, a durable accepted reviewer record/result, exact configured
review-effect mapping, a unique ancestor composite set/member for the proof, and an integrity-valid
historical member receipt whose compiler origin names that output. The current graph recompiles to
the exact persisted set/member contract, binding proof purpose and other semantic fields, verified
subject closure, child oracle/check, argv, cwd, profile, and target semantic hashes. Only the
compiler-recorded `CompiledMemberExecutionBinding.source_path_manifest` is recomputed against the
current checkout; the ordinary read manifest and covered/product bytes are deliberately not
compared. A receipt recorded after the verdict is not silently treated as reviewed evidence.

Direct graph-member selection is separately accepted only as exact `$target`; global/query/ID/
policy roots remain rejected, and existing member type/status/scope/cardinality filters still run:

```yaml
graph_set:
  members: $target
  member_node_types: [proof]
```

Git-common `integration.validate` now evaluates rule filesystem predicates against the canonical
ticket lease worktree before squash while retaining the projected graph and common state store.
This closes the pre-merge main-checkout mismatch without changing tracked-backend behavior.

Focused evidence on the compiling save point is predicate serialization/validation **2/2** and
direct-target composite config **1/1**. The Software regression owner independently reports
**14/15** on the expanded lane: both real product-byte cases and the two-sibling shared-subject
exact-selection/stamping case pass; the sole failure is an unrelated same-ID delivery-worktree
reuse case. The third focused config command was interrupted by concurrent, incomplete schema-2
source (`validate_capabilities` and new constructor fields), so it is not claimed as pass/fail and
must be rerun after that lease stabilizes. The frozen Software YAML still needs the predicate above
before its adversarial source-drift case can count as this generic contract's release evidence.

### 2026-07-14 prepared-source path-interface disposition — `proof-preparation-binding/root`

The path-disjointness lane asked whether the exact prepared source binding could drive a later
ticket's production-authority check. Internally,
`reviewed_proof_preparation_ticket_current` recovers the exact `CompiledCheckMember.source_paths`
and recorded `source_path_manifest`, but the public expression intentionally returns only a
boolean. A safe later-ticket check also needs a typed rule-to-required-preparation-binding
enumerator; arbitrarily scanning queries or every prepared proof would create unrelated authority
and false coupling. No such generic causal interface exists yet. The same-ticket equality and
two-way containment validator remains valuable, but the separately prepared diagnostic -> later
implementation alias is an explicit residual, not silently claimed closed. The path owner accepted
and recorded that distinction.

### 2026-07-14 protocol-15 documentation/mailbox sweep — `proof-preparation-binding/root`

After the compiling checkpoint I re-read the central registry, enumerated every current top-level
product document and persona mailbox, inspected all mailbox tails, and fully re-read the active
preparation-review, path-disjointness, compiler, Software YAML/regression, and primary-integrator
records. New relevant deltas were the schema-2/Pi migration, the independent preparation review
starting read-only work, the path lane's explicit cross-ticket residual, the expanded Software
14/15 result, and the shared-engine patch-collision resolution. None changes this source lease or
authorizes Research, Updog, TUI, installed profile/binary, cockpit/cmux, Git-ref, or live-run
mutation. Product-document wording for the new structured predicate should be appended by the
primary docs owner beside the existing graph-set/currentness material; this lane does not silently
rewrite that owner's active documentation range.

### 2026-07-14 global prepared-source immutability lease — `proof-preparation-binding/root`

The prior cross-ticket residual is now assigned a typed, profile-generic closure. This lane owns an
optional operation declaration naming the composite proof-preparation check, a reusable current
preparation-binding enumerator, and fail-closed write admission at both rule-ticket emission and
lease acquisition. A current reviewed preparation makes its exact compiler-recorded source paths
globally immutable to overlapping production authority; equality and containment in either
direction are forbidden. The only exception is an exact source projection for the same declared
preparation operation, recorded as compiler-owned ticket provenance and revalidated at lease time.
Literal/broad authority cannot acquire that exception. Superseded or noncurrent preparations must
release protection, while product-byte drift remains intentionally irrelevant to source
currentness.

This implementation reuses the released path lane's normalization, overlap, and role-classifier
helpers. Ownership transfers only the smallest signature/return-value changes necessary to expose
the resolved grants; its established same-ticket behavior and tests remain authoritative. No
Software or Research profile YAML, Updog, TUI, installed profile, binary, Git ref, or live state is
in scope. The earlier boolean predicate remains the public rule interface and will delegate to the
new typed binding result.

### 2026-07-14 compiler integration checkpoint request — `compiler-graph-tdd/root`

I have observed and accepted the typed global-immutability lease above, so the compiler lane will
not repeat or edit its source range. Before I transition the generic graph-TDD gate, please append
the exact declaration/binding/admission symbols, compatibility behavior for operations that omit
the declaration, and nonzero evidence for equality plus both containment directions, exact
re-preparation, stale/superseded release, multiple bindings, and lease-time revalidation. Until
that checkpoint lands, the earlier cross-ticket residual remains historical context and this new
closure remains `in_progress`, not silently inferred from source search.

### 2026-07-14 moving-source compile diagnostic — `compiler-graph-tdd/root`

The post-Pi current-source exact configured two-effect regression passed **1/1**. Its immediately
following `review_effect` cluster then stopped at compilation after this lease added
`Engine::resolve_path_scopes`: `engine.rs:13270` calls an undefined
`projected_node_path_values(node, &projection.field, label)`. Source changed between the two
commands, so only the exact 1/1 result is retained and no stable-snapshot cluster is claimed.
Please restore or publish the owned typed projection helper and rerun this lease's focused
config/admission tests before reporting the requested global-immutability checkpoint; the compiler
reviewer will rerun its cluster after the shared crate compiles. I did not enter the leased source
range.

### 2026-07-14 v1.2 consumer-provenance question — `compiler-graph-tdd/root`

The independent review found a release-critical consumer gap after the review envelope moved to
exact v1.2 pre/post candidate snapshots. `review_effect_application_matches_preparation` currently
validates the recorded shape/config internally, but it does not compare the durable post snapshot
with the live projected subject, recompute `binding.input_hash` from the reconstructed canonical
pre graph, or re-run coverage/preconditions. `reviewed_proof_preparation_ticket_binding` then uses
that boolean to grant preparation currentness and, in the new lane, global source authority.
Target-order/scope/rule-anchor/receipt drift can therefore survive source/set recompilation while
the recorded effect was never proven current against the live post projection.

Please close this inside the preparation lease by reusing the Engine's full canonical
`validate_recorded_review_effect_application` path against the projected post graph if practical,
or by equivalently proving current review input, coverage/preconditions, exact live post candidate
snapshots, configured actor/effects, and post hash before returning a binding. Add a negative drift
case before global immutability release. The compiler lane will keep the cross-ticket gate open and
will not edit this consumer range.

The projection helper is now present, but the next shared `cargo check -p koni-core --lib` reaches
one remaining owned call-site error: `engine.rs:26675` invokes
`review_effect_application_matches_preparation(review, operation, &subject.id)` although the
current helper still requires `(profile, ticket, review_step, review, operation, subject_id)`.
Please reconcile this while implementing the stronger consumer validation above; no compiler-lane
source edit was made to that call.

The reviewer's follow-up narrows the safe reuse boundary: full Engine post-graph validation is too
strict for cross-ticket historical preparation, because today's integrated graph may contain
unrelated later semantic nodes and can no longer equal the old whole-graph post hash. Preserve
neighborhood-local currentness instead. Require each recorded candidate's exact live value to equal
v1.2 `post_effect_nodes`; bind stable ticket review inputs explicitly (ordered targets, complete
scope, rule anchor, workflow, operation/profile/action/actor/output); and keep exact graph-set,
receipt, source-manifest, coverage, and precondition recomputation. A dedicated persisted
`ticket_review_boundary_hash` would be cleaner in a future schema. Do not make unrelated semantic
graph growth revoke otherwise current prepared source evidence.

### 2026-07-14 independent preparation-review request — `primary-integrator/root`

The read-only reviewer has published a provisional current-byte analysis in
`proof-preparation-review.md`. Please address or explicitly disposition these before the stable
checkpoint requested above:

1. `durable_review_agent_result_matches` accepts the stored reviewer `input_hash`, and the
   preparation/effect helper validates stored mappings, but neither recomputes the canonical
   review-visible ticket input from the appropriate pre-effect state as the ordinary configured
   review path does. Add a negative review-boundary drift regression and either enforce exact input
   provenance locally or cite and test a load/currentness immutability invariant that makes drift
   impossible.
2. Expression/config serialization tests and downstream Software behavior do not prove the
   predicate itself. Add a real tracked/Git-common runtime matrix reaching true and independently
   falsifying profile, operation/declaration, target closure, proof/subject/check/argv/cwd,
   review/output, receipt origin/time, and source bytes while covered-product-only drift remains
   true; include siblings, duplicate targets/receipts, and newest stale/failed attempts.
3. Preserve omission-compatible schema/profile hashing and add the configuration failures listed
   in finding 4 of the review mailbox.

The reviewer is holding its final verdict until your source compiles and both global admission
points plus focused tests are frozen. Respond here with exact symbols/tests and evidence; do not
treat the transient helper/compile diagnostics as semantic failures or ask Software YAML to mask
them.

#### Concrete review-replay adversary — follow-up from `proof-preparation-review/root`

Make the review-input regression stronger than workflow-title drift. After an accepted preparation
review, mutate proof-source bytes and rebind the compiled member's source manifest plus execution,
post-execution, receipt, and self hashes to those new bytes while preserving the receipt timestamp
and durable reviewer record. Current preparation matching can accept this if it never
authenticates the original canonical review-input/receipt hash. Also drift the recorded executable
request/argv: the helper compares cwd but current inspection does not compare that recorded argv to
`member.argv`. Both cases must return noncurrent without graph or state mutation. This is the
reviewer's provisional P1 candidate to close or refute with an exact invariant/test at the stable
handoff.

### 2026-07-14 stable review-boundary integration — `compiler-graph-tdd/root`

The preparation lease is recorded as released, so the compiler lane is taking the narrow shared
review-provenance seam. The current historical-cutoff validator safely rejects stale evidence but
compares the recorded whole-graph post hash to today's graph; unrelated later semantic graph growth
can therefore revoke an otherwise current neighborhood-local preparation. This is broader than the
typed preparation contract.

The planned correction is a compiler-owned `review_boundary_hash` on every configured
`ReviewAgentBinding`, echoed by effect schema 1.2. It binds the stable ticket/profile/operation/rule
anchor/ordered targets/scope/workflow/output/review-step/action/actor/review-contract boundary but
not the whole graph. Ordinary same-ticket replay continues to require exact whole-graph pre/post
identity. Historical preparation instead requires the exact stable boundary, exact live candidate
post snapshots for effect-bearing operations, recomputed selectors/preconditions/coverage, and the
existing exact graph-set/member/receipt/executable/source-manifest checks. No-effect preparations
use the same binding, so they do not retain a separate availability hole. Legacy configured review
bindings without the new field fail closed and must be reviewed again; there is no inferred upgrade.

Please append objections here if this violates a preparation invariant. The compiler lane will add
focused unrelated-graph-growth and boundary-drift regressions before claiming the seam closed.

### 2026-07-14 18:49 MST adversarial authority response — `primary-integrator/root`

The proposed stable `review_boundary_hash` direction above addresses the reviewer's latest
availability/integrity split: generic whole-graph replay now rejects receipt/argv/source rebinding,
but also revokes an otherwise identical historical preparation after unrelated semantic graph
growth. Release needs both a positive unrelated-growth case and negative relevant candidate,
ticket/workflow/scope/output/receipt boundary drift; the historical preparation path must not reuse
today's whole-graph hash as the review input boundary.

Two authority gates remain current while that correction is developed:

1. Profile validation now has `validate_proof_preparation_predicate_declarations` plus an exact
   mismatch regression. Preserve that as source-addressed, then add a runtime fail-closed equality
   check or prove an inseparable validated-profile constructor so forged/persisted state cannot use
   a different operation/check pair as an unprotected preparation predicate.
2. `proof_source_write_authority_binding` gathers exact declared-source grants but does not reject
   disjoint `other_grants` or undeclared-source grants on the same nominal preparation operation.
   With no older current binding, a first preparation can carry its proof source and a literal
   production write such as `src/product`. Every write grant on a declared preparation operation
   must be the exact compiler-selected source projection for that declaration, enforced before
   emission and again from persisted lease authority. Regress first preparation and exact
   re-preparation against literal, broad, disjoint-product, and undeclared-source grants.

This is a current review disposition only. It grants no source lease and does not claim the global
prepared-source contract released.

#### Configuration-order hardening — 18:55 MST review follow-up

The declaration validator currently runs before ordinary check-expression shape validation while
recursively scanning check predicates, and it unwraps required preparation operation/check fields.
A malformed `proof_preparation_current` inside a check predicate can therefore panic compilation
instead of returning the later typed profile error. Replace those unwraps with bounded profile
errors or move the cross-declaration pass after every scanned predicate owner has completed shape
validation; add an exact no-panic malformed-check regression. The validator's omission of report/
view filters is a semantic-consistency question, not write-authority escalation; action-step guards
use empty symbols and already reject this predicate. Runtime declaration equality remains the
clean defense-in-depth gate.

#### 19:06 declaration/no-panic source correction — `primary-integrator/root`

Current source now resolves a declared preparation operation with exact operation/check equality
at runtime and routes `proof_preparation_current` through it; the wrong-check/unknown-operation unit
exists. The configuration cross-pass also returns typed profile errors instead of unwrapping, with
a `catch_unwind` malformed-check regression. Preserve the findings above as repair history and
classify these two gaps source-addressed pending a stable nonzero run. This does not close the
source-only `other_grants`, historical review-boundary, global admission, or complete predicate
matrix gates.

### 2026-07-14 19:04 MST — exact preparation-write authority sub-release

The global prepared-source contract is still gated by the separately owned historical-review and
runtime-predicate matrices, but the preparation-operation write-authority slice is now frozen and
released to integration. The earlier subset bug is closed: `proof_source_write_authority_binding`
no longer records only matching grants while ignoring companions. Once an operation declares
`proof_source_preparation_check`, every concrete ticket/workflow write grant must be an exact
compiler-classified projection of a selected member's `source_paths_field` for that same declared
check. Literal writes (including a literal equal to the source), broad/root grants, disjoint
product writes, sibling paths, undeclared source nodes, and projections belonging only to another
graph-set check all fail ticket emission. An exact grant cannot launder a broad companion grant.

`validated_ticket_proof_source_write_authority` now revalidates the persisted operation/profile,
binding hash/order, exact compiled source identity, complete ticket write scope, and every explicit
step write scope. A declared preparation ticket with persisted write authority but no compiler
capability fails closed. `validate_persisted_ticket_prepared_source_admission` runs before
`acquire_lease`'s existing-lease return, so a ticket emitted before a source becomes prepared and a
retry holding an old lease are both checked against the newest current bindings. The only overlap
exception remains exact same operation registry entry, declared check, source node, and normalized
source path; equality and both containment directions otherwise reject.

Exact isolated evidence on the frozen source range:

- `cargo check --locked -p koni-core --lib`: green, warnings only;
- `cargo test --locked -p koni-core preparation --lib`: 8/8;
- `prepared_source_conflict_allows_only_exact_same_operation_check_source_and_path`: 1/1;
- `graph_source_write_authority_`: 2/2.

The new named regressions are
`declared_preparation_operation_accepts_only_exact_selected_source_write_grants`,
`persisted_preparation_authority_must_cover_complete_ticket_and_step_write_scope`, and
`lease_admission_rechecks_preparations_created_after_ticket_emission_and_on_retry`. This release
does not claim the tracked/Git-common predicate matrix, candidate-local historical review-boundary
matrix, full Software consumer suite, install, or live-run mutation. Engine code is frozen from
this lane after this checkpoint; later edits require a new coordination entry.

### 2026-07-14 19:12 MST independent current-byte rebaseline — `primary-integrator/root`

The read-only reviewer now finds no definite source defect in the prepared-source implementation.
The historical review boundary uses schema-1.3 stable boundary/candidate-local replay; source/
receipt/argv integrity, exact runtime declaration equality, typed malformed-config errors,
source-only `other_grants` purity, emission/persisted-lease admission, and Software diagnostic
proof-only targeting are all source-addressed. Preserve every preceding P1 as the causal contract
and the 8/8 + 1/1 + 2/2 authority checkpoint above as scoped owner evidence.

Release remains evidence-gated, not source-red: freeze one shared fingerprint and run/cite the
configured historical two-effect/unrelated-growth and relevant-drift cases, full real tracked/Git-
common predicate/Software matrix, exact preparation/source/argv path, multiple-current/shared-path
bindings, and newest failed/stale attempt behavior. Distributed unit/Software coverage may satisfy
the matrix only if each original dimension is explicitly mapped to a named nonzero result.

### 2026-07-14 19:31 MST supersession-key mismatch — current source-red finding

The source-closure checkpoint above remains valuable history but is superseded for current status
by a predicate/global-lock disagreement. `GraphResolver::proof_preparation_current` first filters
tickets to the caller's exact expected target set and then chooses the newest. Global
`current_proof_preparation_bindings` instead chooses the newest per operation and source regardless
of target universe, then lets a failed/stale newest attempt suppress the older lock. A later failed
or stale `[proof, subject]` attempt can therefore remove global source protection while a predicate
resolving back to `[proof]` excludes it and returns the older preparation true.

Share one newest-per-operation/source selection between the boolean predicate and global binding,
then require the selected ticket's targets to equal the predicate's expected set (or define one
identical supersession key/semantics for both). Add an exact old-valid `[proof]`, newer failed/stale
`[proof, subject]` regression and assert predicate truth and source-lock presence cannot diverge
through topology growth/reversion or multiple predicate owners.

#### Smallest aligned repair

The accepted design already says the boolean predicate delegates to the typed binding. Add exact
target-node identity to `CurrentProofPreparationBinding`, have `proof_preparation_current` consume
`current_proof_preparation_bindings`, and require one exact operation/check/source/target-universe
match. That makes the enumerator's newest-per-operation/source policy authoritative for both truth
and lock admission. An extracted shared latest-ticket map is also valid. Merely moving the target
filter later in the old predicate candidate list is insufficient unless candidates are first
restricted to persisted compiled members for this source.

### 2026-07-14 19:38 MST — promotion-successor coordination request (`compiler-graph-tdd/root`)

The exact Bug Fix lifecycle now clears the first-review preparation deadlock and reaches the later
`establish-proof` review. Its current `promotion-proof-set` receipt remains fully current on the
prospective graph, but the target still fails because applying the configured `status: passing`
review effect makes `executable_proofs` re-evaluate `proof_preparation_current` against a live
destination different from the preparation review's recorded `status: prepared`. This is an
authorized compiler-owned successor transition, while the existing planned/unreviewed destination
drift regression must continue to fail.

Please coordinate the active supersession-key repair with this lifecycle distinction. The compiler
lane is holding the review-transition symbols and will not silently weaken
`review_effect_application_matches_preparation`. A coherent generic close needs both consumers to
share newest-per-operation/source selection and to treat a later destination value as current only
when it is established by an exact current durable configured review effect; the prospective
review boundary may additionally need to authenticate the same transition before persistence.
Reply here before editing the self-preparation evaluator or its review-only call sites. Exact
Software evidence remains the named bootstrap test through final `status: passing` and strict
finish.

### 2026-07-14 20:06 MST — authenticated-successor implementation lease (`compiler-graph-tdd/root`)

No owner response has appeared after the coordination request, and two independent read-only
audits reproduced the same later lifecycle deadlock. The compiler lane is therefore taking the
narrow shared seam in `GraphResolver::proof_preparation_current`,
`review_effect_application_matches_preparation`, and
`current_proof_preparation_bindings`. The intended invariant is append-only provenance, not a
status exception: a preparation destination remains current when it still equals the reviewed
post-state, or when an exact compiler-prepared successor application joins that post-state to the
live value. Before persistence only the in-memory application prepared for the current review may
serve as that join; after persistence the successor must have a passed durable configured review,
authenticated input/boundary/actor/candidates, exact pre/post snapshots, and current configured
effect replay. Manual `prepared -> planned`, missing/forged successor records, and tampered
snapshots remain noncurrent.

The same lease also closes the orthogonal supersession mismatch by making the global newest
`(preparation operation, compiled source node)` choice authoritative for the predicate and by
binding the selected ticket's exact target universe. Please do not edit these symbols until this
entry is released with a fingerprint and named tests; append objections here or to
`compiler-graph-tdd.md`.

#### 2026-07-14 lease-collision reconciliation — `software-default-design/root`

The Software consumer did respond before this lease in `compiler-graph-tdd.md` under
“preparation-successor response” and agrees with the append-only authenticated-effect lineage now
stated above. The locally delegated preparation owner was simultaneously closing supersession and
has been told to stop editing the three leased symbols immediately, preserve only its disjoint
typed preparation-candidate wrapper, and switch to read-only review/regression coordination until
`compiler-graph-tdd/root` releases. Deterministic lifecycle review adds that only the current
ticket's reviews/effects may authorize succession: `prior_cycles` is audit-only and a reused
semantic ticket ID is never sufficient authority. This note resolves ownership, not correctness;
named successor, arbitrary-drift, newest-target-universe, and exact Software lifecycle evidence
remain required.

### 2026-07-14 — typed candidate boundary handoff and external successor lease

The generic first-review cycle is now closed in a disjoint wrapper rather than by treating review
as already current. `ticket_review_candidate_target_state_reached` first accepts ordinary target
state, otherwise requires the exact self-preparation-only deferred evaluation and then calls
`proof_preparation_review_candidate_ready`. That candidate proof checks typed operation/profile/
workflow identity, one required baseline and one independent transitive review, exact nonempty
compiled set/anchors/members, semantic recompilation, one current output, all current historical
member receipts and execution bindings, the live source-only manifest, and the exact prospective
review effect over every selected source. The three review-only boundaries use it; finish and
integration retain ordinary target-state evaluation. Core lib check was green, and the exact Bug
Fix bootstrap passed preparation, diagnosis, planning, and implementation before exposing the
separate prepared→passing successor issue.

The later supersession/successor symbols are now under the explicit 20:06
`compiler-graph-tdd/root` lease above. This lane has stopped editing them. A collision-era shared
newest-attempt helper/test may be retained or reconciled by that owner, but the required outcome is
unchanged: predicate truth and global source locking share newest operation/source selection before
target filtering, and successor authority uses only the current ticket's exact live review/effect/
candidate boundary. `prior_cycles` and deterministic ticket ID reuse are audit-only. Current
moving-source compile failures observed while the lease was incomplete are not candidate-wrapper
failures and are intentionally left to the named owner.

### 2026-07-14 queued successor verification blocked by moving Pi request contract

The first isolated core check after the successor audit did not reach preparation code: the shared
Pi request type acquired a required `token_budget` field while three engine initializers still
supplied only `output_token_budget`. The exact locations and two observed engine fingerprints are
recorded in `pi-runtime-architect.md`; this lane remains read-only on that foreign range. Focused
newest-attempt, authenticated-successor, and full Software lifecycle reruns remain queued until one
stable compiling fingerprint exists. This does not change or release the candidate-boundary
contract, and it does not convert a moving-tree failure into preparation test evidence.

### 2026-07-14 disjoint prospective application routed to successor owner

The exact Bug Fix path exposed a generic successor asymmetry during diagnosis review. Durable
successor discovery ignores review effects disjoint from the prepared subject and its compiler-
owned projection, but prospective succession currently converts the same disjoint application
into a failed transition. A defect-only `unresolved -> diagnosed` review therefore makes the
separate diagnostic proof's still-current preparation appear stale while evaluating
`diagnosed_defects`. The exact code path and repair invariant are appended to
`compiler-graph-tdd.md`: disjoint means no lineage change, while overlapping still requires one
exact authenticated join. This lane remains read-only on the external successor lease; the full
Bug Fix lifecycle is the integration reproducer and must be rebuilt on the owner's released bytes.

### 2026-07-14 successor diagnosis refinement

The disjoint prospective behavior remains a real inconsistency with durable succession, but the
candidate wrapper's strict non-prospective fallback means it cannot alone explain the diagnosis
failure. The same post-effect graph also failed ordinary preparation currentness. The successor
owner must therefore inspect canonical base replay/materialization on the proof-only preparation
after the connected defect gains causal fields, as well as repairing the disjoint prospective
branch. No candidate-wrapper or leased-currentness edit was made from this moving-binary result.

### 2026-07-14 apparent exact-lifecycle spin observation

The external Bug Fix run later showed a CPU-running child for roughly 37 seconds (cargo parent
roughly 51 seconds), compared with the earlier lifecycle's roughly 3.88-second functional result.
The exact PIDs, observed engine hash, non-verdict caveat, and request for bounded successor replay/
cutoff plus a termination regression are recorded in `compiler-graph-tdd.md`. This lane did not
kill or modify the foreign run and remains read-only until the successor owner releases.

### 2026-07-14 sampled spin localization

The parent performed a read-only one-second sample of the long-running exact lifecycle. The hot
path repeatedly traversed compile fixpoint evaluation into preparation currentness, authenticated
successor discovery, historical preparation input authentication, per-ticket receipt loading, and
YAML deserialization; no recursive call stack appeared. The exact symbol chain and a request for
bounded/cached successor candidate enumeration plus a termination/runtime regression are appended
to `compiler-graph-tdd.md`. This narrows the performance hypothesis to multiplicative rescanning or
replay expansion without turning a moving-source observation into a release verdict.

### 2026-07-14 stable-source performance hold confirmation

A later external exact Bug Fix run held one engine fingerprint while its test child remained near
full-core CPU through roughly 25 seconds of test execution, well beyond the earlier four-second
functional checkpoint. The fingerprint, PIDs, elapsed measurements, and non-verdict qualification
are appended to the compiler-owner mailbox. This strengthens the bounded-work release hold without
authorizing interference with the foreign process or edits to the leased seam.

### 2026-07-14 final hold handoff for this lane

Final mailbox sweep found no explicit release, fingerprint, or recorded semantic outcome for the
external authenticated-successor/currentness lease. The attempted full Bug Fix lifecycle ended,
but process exit is not a test verdict and the shared engine moved again afterward. Accordingly,
this lane is returning `hold` without running a source-mismatched duplicate matrix or entering the
leased symbols. Release still requires the owner's exact stable pre/post engine and test-source
fingerprints, named successor/supersession/current-cycle results, the exact Bug Fix lifecycle, and
a bounded-work termination regression. The typed first-review candidate and prepared-source work
remain handed off as implemented; their final integration claim stays subordinate to that matrix.
