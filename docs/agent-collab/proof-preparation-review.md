# Cross-Ticket Proof Preparation Review

- Owner: `/root/review_effect_semantics` acting as `proof-preparation-review`
- Status: active — protocol-15 documentation sweep before read-only adversarial review
- Exact lease: `docs/agent-collab/proof-preparation-review.md` only
- Product/source/test/profile/central-ledger authority: none; inspection only
- Started: 2026-07-14 America/Phoenix

## Protocol-15 prerequisite sweep — 2026-07-14

Before substantive source review, read `docs/AGENT_COLLAB.md`, every current top-level
`docs/*.md` product/design document, and all 50 current `docs/agent-collab/*.md` mailboxes in
full. Re-read the moving preparation, path-disjointness, compiler/review-effect, Software YAML,
Software regression/design-review, Pi, and integration records after their latest appended
handoffs. No source, test, profile, product document, central row, installed resource, process,
Git ref, cockpit/cmux surface, credential, or live/forensic run state was changed.

Current review boundary: the preparation owner reports a compiling library checkpoint and focused
predicate/direct-target evidence, but the complete shared test tree and adjacent schema-2/runtime
work are still moving. This lane will distinguish source defects from incomplete integration,
avoid duplicate Cargo while that condition persists, and will not publish a final current-tree
verdict until the owner/integrator declares the candidate stable and the relevant source is
re-read.

## Moving-source adversarial checkpoint — 2026-07-14

The former boolean-only cross-ticket path-authority residual is now causal history, not the
current target. Re-read the preparation owner's new global-immutability lease together with the
released same-ticket path-disjointness record and compiler/integration tails. The current source
has begun the new closure with optional, omission-compatible
`OperationDef.proof_source_preparation_check` and structural validation of the declared composite,
workflow scheduling, historical read-only child checks, required receipt, and independent review
(`crates/koni-core/src/config.rs:1093-1104`, `5106-5240` at this moving save point). The typed
binding, pre-ticket enforcement, pre-lease revalidation, persisted exception provenance, and their
adversarial matrix are still actively landing. This review therefore continues to treat the
same-ticket equality/two-way-containment guard as released and the new cross-ticket closure as
incomplete integration until its owner publishes a stable checkpoint.

Current positive source observations for the original predicate, subject to final stable-line
refresh:

- Candidate lookup binds current profile hash, exact public operation plus registry entry, and an
  equality/dedup check on the complete selected target set before choosing the newest reviewed
  exact attempt (`engine.rs:24777-24818`). Choosing the newest exact attempt and failing closed if
  that attempt is stale is consistent with the newly documented rule that a superseded/noncurrent
  preparation releases protection; an older valid attempt must not silently revive. Preserve this
  with an explicit old-valid/new-failed-or-stale regression.
- The ticket binding requires one required independent review, its current output hash and durable
  accepted reviewer record, a unique matching compiled member for the proof, a historical
  integrity-valid receipt tied to the exact baseline output, exact recompilation of the persisted
  graph-set contract, current profile/check/cwd/target/member/source semantic bindings, and a
  recomputed source-only manifest. Covered product/read-manifest bytes are intentionally absent
  from the final comparison (`engine.rs:26392-26588`). The refactor also correctly narrowed the
  post-review timestamp rule to the newest matching baseline member receipt; unrelated later
  finish/integration receipts no longer invalidate preparation (`engine.rs:26496-26529`).
- Git-common integration evaluation now supplies the canonical ticket lease worktree to the rule
  resolver, while `canonical_ticket_agent_worktree` verifies an absolute canonical worktree root,
  common Git directory, and exact leased branch (`engine.rs:14744-14768`, `45506-45558`).
- The new predicate inputs are optional with `serde(default, skip_serializing_if =
  "Option::is_none")`, and the operation declaration is likewise optional, so omission preserves
  legacy YAML/profile serialization shape by inspection (`expr.rs:537-593`;
  `config.rs:1093-1104`). A legacy-profile/hash regression is still required evidence rather than
  inferred green.

### Provisional release findings / required adversarial tests

1. **P1 evidence gap — no runtime predicate regression yet.** The only occurrences of
   `proof_preparation_current` outside engine dispatch are the two expression
   serialization/unknown-symbol tests (`expr.rs:1152-1195`). The frozen Software rules still do
   not consume the predicate, so the reported Software product-mutation and sibling results cannot
   prove this generic predicate's accept/reject behavior. Before release, add a real state-store /
   Git-common test that reaches true, then independently falsifies exact profile, operation,
   target closure, proof semantics, subject semantics, parent/child check, argv, cwd, review,
   reviewed output, member/receipt origin, source bytes, and post-review matching receipt while
   keeping covered-product-only mutation true. Include two sibling proofs, shared preparation,
   duplicate targets/receipts, and newest stale/failed attempt behavior.

2. **P1 semantic candidate — historical review-input drift is not independently checked by the
   preparation helper.** `durable_review_agent_result_matches` proves that the ticket binding,
   accepted common-dir record, output file, and parsed verdict agree, but it never reconstructs or
   otherwise authenticates that `binding.input_hash` remains the canonical reviewed ticket input
   (`engine.rs:26645-26696`). `review_effect_application_matches_preparation` validates the stored
   application's shape/mappings but likewise does not bind that input hash or prove the recorded
   pre/post graph hashes (`engine.rs:26698-26799`). The ordinary configured-review path does both
   through `ticket_review_input_hash_for_graph` and reconstructed pre-effect state
   (`engine.rs:14152`, `14244`). Adversarially mutate a preparation ticket's review-visible
   workflow/scope/receipt boundary after verdict while leaving the exact baseline set, output,
   durable reviewer record, current semantic graph member, and source manifest unchanged. The
   predicate must return false. If ticket/workflow immutability is the intended reason this cannot
   occur, the owner must cite and test that invariant at load/currentness time; the preparation
   helper currently does not establish it locally.

   The sharper exploit is post-review receipt rebinding: change proof-source bytes, replace the
   recorded compiled-member source manifest with the new manifest, and consistently recompute the
   execution/post-execution/receipt self-hashes while retaining the original timestamp and durable
   reviewer record. The helper's source comparison then sees the new bytes as current, while the
   reviewer actually saw the old raw receipt. Recomputing or durably decomposing the canonical
   review input would reject that replay. The same test should mutate the recorded resolved argv:
   the helper compares `recorded.cwd` to the compiled member but does not directly compare the
   recorded executable request/semantic argv to `member.argv`; a matching member-contract label is
   not itself proof that the recorded command executed that contract. This is exactly the
   source/command/review-provenance boundary the predicate is intended to add. For operations with
   review effects, also alter the stored pre-effect nodes/hash and nonempty post-effect hash: the
   preparation-specific matcher checks configured effect shape and that one effect names the
   subject, but unlike `validate_recorded_review_effect_application` it proves neither graph hash.

3. **New global closure remains unreviewable until both admission points exist.** Exact tests must
   show ordinary later tickets are rejected before emission and again before lease acquisition for
   equality, prepared-source ancestor, production-grant ancestor, root/broad/literal grants, a
   preparation that becomes current after ticket emission, and an existing-lease/retry path. Exact
   selected source-only re-preparation for the same declared registry operation may pass; a public
   operation label, literal grant, unrelated declared operation, unselected sibling, stale or
   superseded binding, and forged/stale persisted exception may not. Multiple current bindings and
   shared paths must not let one exception launder an ordinary production grant. Run each case
   from a linked Git worktree so current source manifests are read from the intended common-repo
   checkout.

   Two current moving-byte defects must be closed in that implementation. First,
   `proof_preparation_current` accepts any existing operation/check pair, while global enumeration
   protects only `operation.proof_source_preparation_check`; an undeclared second composite can
   therefore satisfy the boolean without placing its source under global authority. Require exact
   declaration equality at config and runtime. Second, the emitted authority binding gathers exact
   declared-source grants but does not reject the same declared preparation operation's disjoint
   literal/production or undeclared-source grants. The same-ticket alias guard permits such
   disjoint grants, and with no older current binding there is no cross-ticket conflict, so a
   nominally source-only first preparation can carry product-write authority. Every write grant on
   a declared preparation operation must be an exact compiler-selected source grant for that
   declaration (or the ticket must fail before emission and again on persisted lease admission).

4. **Configuration compatibility/hardening coverage is incomplete.** Add profile failures for an
   unknown/non-composite declaration, a parent/child check that does not apply to the exact public
   operation, non-historical or write-capable child, absent/duplicate baseline scheduling,
   missing required receipt, absent/multiple/non-independent/non-dependent review, and a predicate
   whose `preparation_operation` / `check` disagrees with the operation's declaration. Also prove a
   legacy profile omitting both predicate fields and `proof_source_preparation_check` compiles to
   its prior serialized/profile hash.

These are preliminary findings against moving bytes. A transient `Result<Option<_>>` guard type
error appeared and was corrected during the refactor before this note was finalized; it is not a
current defect and will not be part of the stable verdict. No Cargo command was run by this review
lane.

### Later moving-source provenance update — 2026-07-14

The owner has now source-addressed the receipt/command replay half of finding 2. The preparation
consumer recomputes a cutoff-aware canonical review input, rejects effect-envelope drift through
the generic v1.2 validator, and directly binds resolved/requested argv plus receipt
`semantic_argv` to the compiled member (`engine.rs:26986-27215` at this save point). Exact negative
tests and a stable checkpoint are still pending, so this is source-addressed rather than released.
The configuration half of finding 3 is also now source-addressed by recursive
`validate_proof_preparation_predicate_declarations` and its mismatch regression
(`config.rs:3177-3252`, test near `10000`); the runtime predicate still needs a local declaration
equality guard for fail-closed defense in depth.

That reuse exposes a separate **P1 whole-graph revocation defect**. For an effect-bearing
preparation, `reviewed_proof_preparation_ticket_binding` calls
`validate_recorded_review_effect_application_at_review_boundary`. The generic validator requires
today's complete semantic graph hash to equal the historical post-effect hash, reconstructs the
pre graph by replacing only recorded candidate nodes and requires that complete current graph to
equal the historical pre-effect hash, then recomputes a review input which itself contains the
complete current graph hash (`engine.rs:14634-14734`, `14800-14935`, `27016-27031`). Therefore an
unrelated later semantic node or edge change makes an unchanged prepared proof noncurrent and
releases its global source-path authority. This contradicts the preparation contract and the
owner's recorded design constraint that unrelated semantic growth must not revoke historical
preparation.

The preparation-specific consumer must keep exact live candidate-neighborhood equality with the
v1.2 post snapshots while authenticating stable ticket/workflow/scope/output/receipt inputs against
the review boundary. One viable construction is to recompute the canonical input with the
application's already reviewer-bound historical `pre_effect_graph_hash` in the graph-hash slot,
rather than today's whole graph; changing that recorded hash would then also require forging the
durable reviewer input/result binding. Release evidence needs both a positive unrelated-graph-
growth case which remains current/locked and negative relevant candidate, target, scope, receipt,
and source drift cases which fail closed.

### Corrected declaration-validator disposition — 2026-07-14

The declaration/check cross-pass is security-complete for the predicate owners which can drive
compiler behavior: it scans edges, queries, rules, checks, and gate execution readiness. An
earlier moving-tree concern about action-step guards was incorrect and is withdrawn: action guards
validate with `ExpressionSymbols::default()`, whose empty operation/check registries reject
`proof_preparation_current` before execution. Report and view filters use the full profile symbol
table but are not scanned by the declaration cross-pass; that is a presentation/semantic
consistency omission, not a write-admission escape. The runtime declaration-equality check remains
the smallest useful defense-in-depth closure.

A separate configuration-hardening defect remains at this checkpoint. The cross-pass runs before
`validate_checks` yet scans `check.predicate` and uses `expect()` for the preparation operation and
check fields. A malformed proof-preparation leaf in a check can therefore panic profile
compilation before normal expression-shape validation returns a typed error. Replace the expects
with `ok_or_else`/`profile_error`, or reorder the pass after all scanned predicate owners have been
shape-validated, and add a malformed-check no-panic regression. Keep this distinct from the
source-only `other_grants` P1 and the whole-graph historical-review availability/integrity P1,
which remain the prominent release gates while source is moving.

### Software consumer circularity — 2026-07-14

The newly wired Software predicate exposes a profile-level semantic cycle which the prior 14/15
checkpoint could not exercise. `proof.prepare` emits a preparation ticket whose `target_nodes`
contain both the proof and its verified defect/risk subject, and every corresponding
`preparation_targets` selector expects that same union
(`crates/koni-cli/templates/software/rules.yaml:88-119`; graph queries near `300-323` and
`472-484`). Composite compilation records semantic hashes for every target anchor
(`engine.rs:43198-43223`), and preparation currentness requires exact recompilation of that set.

The bug-fix workflow, however, reviews preparation before diagnosis and then intentionally adds
`root_cause`, `causal_chain`, and `ruled_out_alternatives` to the verified defect in the diagnosis
ticket (`software_proof_gate.rs`, test
`software_bug_fix_bootstraps_prepares_diagnoses_then_plans_the_causal_change`). The Software
`defect` type has no narrowed `semantic_fields`, so its complete non-compiler-owned node body is
the semantic anchor (`graph.yaml:95-114`). The diagnosis therefore changes the preparation's
recorded subject hash; `proof_preparation_current` becomes false exactly when the
`diagnosed_defects` query requires it, risking a circular failed review/re-emitted preparation.

Keep generic subject-semantic currentness intact. The bounded profile options are to make the
preparation target exactly the proof while retaining verified subjects in read scope/topology, or
to define an explicit stable subject projection which binds the oracle-relevant pre-diagnosis
contract without pretending later causal analysis was already reviewed. The exact bug-fix
regression must run through preparation, causal diagnosis, planning, product mutation, and final
no-reprepare assertion on the stable source fingerprint; a helper-only predicate test cannot close
this consumer defect.

### Moving-source closure update — 2026-07-14 19:06 MST

The two defense-in-depth items above are now source-addressed. Runtime predicate dispatch calls
`declared_proof_preparation_operation`, which returns an operation only when its typed
`proof_source_preparation_check` exactly equals the predicate's parent check; the focused unit
`runtime_preparation_lookup_requires_exact_operation_declaration_and_check` covers a wrong check
and unknown operation (`engine.rs` near `25494`, helper/test near `27119`/`56020` at this save
point). The configuration cross-pass has also replaced both `expect()` calls with bounded profile
errors, and `malformed_check_preparation_predicate_returns_profile_error_without_panicking` wraps
compilation in `catch_unwind` and asserts the missing-operation diagnostic (`config.rs` near
`3177`/`10015`). These require stable green evidence before release but are no longer current
source defects.

The Software Bug Fix cycle is likewise source-addressed at this moving checkpoint. Diagnostic
proof preparation no longer includes the mutable defect: every affected selector retains only the
proof plus an optional verified `risk`, while the proof's read scope still retains verified
subject topology. The expanded
`software_bug_fix_bootstraps_prepares_diagnoses_then_plans_the_causal_change` regression now
asserts the exact compiled diagnostic member, completes preparation and causal diagnosis, asserts
no re-emitted preparation, plans and implements the repair, mutates covered product bytes, and
promotes the proof. This is the bounded profile fix requested above; retaining a risk target keeps
risk-boundary semantic currentness deliberate rather than weakening the generic predicate. Do not
call the consumer released until this exact test and the surrounding Software suite pass on the
stable shared fingerprint.

### Current P1 — predicate/global supersession keys disagree

The requested newest-failed/stale trace exposes a current source defect, not merely a missing
test. `GraphResolver::proof_preparation_current` filters tickets to the caller's exact
`preparation_targets` universe and only then chooses the newest reviewed candidate (`engine.rs`
near `25512-25537`). `current_proof_preparation_bindings`, however, chooses the newest reviewed
ticket per `(operation registry ID, source node ID)` regardless of target universe and validates
only that one (`engine.rs` near `27361-27430`).

Consequently an older valid `[proof]` preparation can be followed by a newer reviewed failed or
stale `[proof, subject]` attempt. If subject topology later resolves the predicate selector back to
`[proof]` (or another predicate owner uses that narrower selector), boolean lookup excludes the
newer attempt and can return the older ticket true. Global enumeration still lets the newer
attempt suppress the older binding, returns no source lock, and ordinary overlapping writes can be
admitted. The compiler then simultaneously claims the preparation current to downstream rules
and unprotected to global write admission.

Use one supersession key/order for both consumers. The cleanest fail-closed shape is to select the
latest reviewed ticket per declared operation/source first, then require its exact target universe
to equal the predicate's expected selector before validating it; alternatively key both paths by
the exact same target-universe identity and retain the corresponding older lock. Add a real
old-valid `[proof]` / newer failed-or-stale `[proof, subject]` regression which proves predicate
currentness and global lock admission cannot diverge. This P1 reopens source status until fixed and
green; the prior 19:06 source-addressed items remain accurately classified.

## Final read-only verdict for the 2026-07-14 19:21 MST save point

**Verdict: one definite P1; do not release the prepared-source contract at this save point.** The
predicate/global supersession mismatch immediately above remains present in the final re-read:
`proof_preparation_current` filters exact target identity before ordering candidates
(`engine.rs:25635-25660`), while `current_proof_preparation_bindings` orders per declared
operation/source and validates only that winner (`engine.rs:27583-27653`). This violates the
accepted design that the public boolean delegate to the typed current binding and permits trusted
predicate truth without the corresponding immutable-source authority.

The exact repair is to make one newest-reviewed-attempt selector, keyed and ordered identically by
declared operation registry ID plus compiled source node. The boolean path must consume that
winner, then require its target set to equal `preparation_targets`; it must not prefilter away a
newer attempt. A compact implementation is to add the ticket's exact target universe to
`CurrentProofPreparationBinding`, have `proof_preparation_current` consume
`current_proof_preparation_bindings`, and match operation/check/source/targets. An extracted shared
latest-ticket map is equivalent. Merely moving the target comparison later across every operation
ticket is insufficient because an unrelated source must not supersede this subject.

The mandatory regression is a real persisted sequence: (1) older passed/current preparation for
source `proof` with targets `[proof]`; (2) newer reviewed failed or semantically stale preparation
for the same declared operation/source with targets `[proof, subject]`; (3) resolve a predicate
owner back to `[proof]`. Assert the older ticket is not revived, the predicate is false, and no
prepared-gated downstream ticket is emitted. Repeat with a newer valid broader attempt: the narrow
predicate remains false while its current source binding still rejects equality and both path-
containment directions. Exercise both topology growth/reversion and two predicate owners so the
test proves shared supersession semantics rather than one hardcoded selector.

Everything else in this audit is **source-closed but shared-fingerprint/test-pending**, not a
current defect:

- schema-1.3 stable historical review boundaries, raw receipt/causal binding, candidate-local
  effect reconstruction, exact argv/cwd/executable request/semantic argv, and source-manifest
  currentness;
- exact runtime operation/check declaration equality and typed malformed-predicate errors without
  panic;
- declared preparation-operation purity rejecting all `other_grants`, plus exact persisted ticket
  and step authority, emission-time overlap, late lease admission, and existing-lease retry;
- the Software diagnostic proof-only target correction and its expanded Bug Fix path through
  preparation, diagnosis, planning, covered-product mutation, no re-preparation, and promotion.

The owner-reported isolated authority evidence (preparation 8/8, exact conflict 1/1, graph-source
authority 2/2) remains useful but predates later shared edits and does not close the P1. After its
repair, one frozen run must still map the historical unrelated-growth/relevant-drift cases, exact
receipt/argv/source path, full Software consumer suite, multiple-current/shared-path behavior, and
newest failed/stale behavior to named nonzero results. This review lane ran no Cargo command and
made no source/profile/test/runtime/live-state change; its only edit is this mailbox.
