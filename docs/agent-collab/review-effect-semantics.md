# Review Effect Semantics

- Owner: `/root/review_effect_semantics`
- Status: active — read-only adversarial review
- Current status transition (2026-07-14): complete — signed verdict published; the original
  active line above is retained as start-state history.
- In-flight engine 1.1 note: the compiler-owned candidate is not yet stable and has not been
  re-reviewed by this lane. The two signed P1 gates below remain its acceptance criteria until the
  compiler owner declares a stable save point and assigns a final current-tree review.
- Exact lease: `docs/agent-collab/review-effect-semantics.md` (this file only)

## 2026-07-14 adversarial semantic review

### Scope and current result

I read `docs/AGENT_COLLAB.md`, every current persona mailbox, the review-effect config/state/engine
paths, and the Research, generic graph-set, and Software focused regressions. I modified no file
outside this mailbox. The original field-presence failure remains recorded in
`compiler-graph-tdd.md` as history.

The current narrow correction at `engine.rs:13469-13505` is sound for that observed failure:
the post-effect fast path resolves every configured value (including `$review.id` and `$actor`),
requires the recorded `set` map to equal that resolved map, and requires each destination value
on each recorded node to equal it. A merely present `status: planned` can no longer satisfy
`set: {status: passing}`. There is no remaining raw `eprintln!` in `engine.rs`.

I independently ran:

- `CARGO_TARGET_DIR=/tmp/koni-review-effect-semantics-target cargo test --locked -p koni-core --test software_proof_gate software_delivery_requires_current_proof_and_exact_nonvacuous_coverage -- --exact --nocapture`
  — passed 1/1.

The later owner results are also now visible: Software passes 6/6, including the new one-change +
one-proof implementation review, and generic `graph_check_set` passes 5/5. The latter suite is
about graph-selected command sets and contains no review effects; it is not the requested generic
review-effect replay regression.

### Release blockers for the generic review-effect contract

1. **P1 — the recorded node list is validated as a subset, not the exact selected set.**
   Preparation computes all selected candidate IDs (`engine.rs:13337-13357`), but post-effect
   validation only checks that every *recorded* ID is a current candidate of an allowed type,
   satisfies the surviving predicates, and meets the configured count
   (`engine.rs:13548-13596`). It never recomputes the complete selected candidate set and compares
   it to `applied.node_ids`. A `min: 1` effect can therefore validate a strict subset; an eligible
   unrecorded target with an already-materialized destination is invisible. This is particularly
   relevant to multi-target graph-free operations, whose candidate universe comes from mutable
   ticket target state. Effect-bearing review validation also skips the current
   `ticket_review_input_hash == binding.input_hash` check used by the no-effect branch
   (`engine.rs:13867-13884`), while `Review.ticket_hash` is not revalidated. Consequently target-set
   drift is not covered by the post-effect graph hash. Before generic release, validation must bind
   and compare the complete sorted candidate/selection set (and revalidate the current review
   input or an equivalent immutable target-universe hash).

2. **P1 test gate — the explicitly requested generic two-effect replay proof is still absent.**
   The new Software test at `software_proof_gate.rs:350-450` usefully proves that one pinned change
   and one pinned proof receive their two different status effects while sibling nodes remain
   unchanged. It is product-specific, and it does not explicitly assert a second replay is a
   zero-write/zero-hash-change no-op. The Research test
   `configured_review_effects_own_promotion_and_bind_it_to_the_exact_pass` is a false-positive for
   the original defect: tracked review recording materializes the effect before finish, so even
   the old field-presence fast path encountered the correct value. Add a small generic fixture
   with two disjoint target types/effects and explicit first-apply + second-replay observations.
   Include at least two members for a `min` effect so an omitted member is rejected.

No P0 finding was identified in the corrected ordinary Software path.

### Correct idempotence/replay contract

The durable application should bind one immutable transition, not merely a bag of writes:

- review/config/profile/actor identity;
- an immutable pre-effect semantic graph hash and immutable candidate/target-universe hash;
- effects in declared order, each with the exact sorted unique selected IDs and exact resolved
  destination map;
- exact coverage evidence (required and actual sets per selected node), or a statically enforced
  rule that coverage/select/precondition inputs cannot be changed by this or a later effect; and
- the exact post-effect semantic graph hash.

Replay should then be a two-state transition performed on a clone:

- At the exact pre-effect hash, revalidate the bound selection and coverage, apply every recorded
  mapping, require the exact post-effect hash, then replace the caller's graph.
- At the exact post-effect hash, validate the full envelope, complete selection, coverage, and
  every destination, then return a true no-op.
- At any other hash, or on any mismatch, fail closed with the caller's graph unchanged. Do not
  infer success from a partially materialized graph. Recovery of a partial durable publication
  is a separate, explicit transaction protocol.

For multiple effects, declaration order must be normative. Current config rejects overlapping
selector node types (`config.rs:5130-5139`), which makes write ownership disjoint, but it does not
prevent one effect from changing fields/edges consumed by another effect's coverage. Either select
and validate all effects from one immutable pre-effect snapshot or formally record sequential
coverage snapshots and reject backward dependencies.

### Important hardening, distinguished from the blockers above

1. **P2 local failure atomicity.** When the graph is not already materialized,
   `replay_review_effect_application` calls the mutating preparation routine and only afterward
   compares the result with the recorded application (`engine.rs:13507-13514`). A mismatch returns
   with the supplied in-memory graph modified. The current sole projection caller owns a disposable
   local graph and does not persist it after error (`engine.rs:17949-17971`), so I do not classify
   this as a current durable-release blocker. It should nevertheless apply to a clone and swap only
   on equality; add a regression asserting the semantic hash is unchanged after wrong IDs, set,
   coverage, and stale-graph failures.

2. **P2 validation centralization.** The fast no-op path itself checks neither schema version,
   configured actor, sorted/unique IDs, coverage, nor `post_effect_graph_hash`; those checks occur
   later in configured-review validation. Because projection is also a reusable read path, replay
   should call one complete envelope validator rather than depend on a downstream caller to make
   the projection authoritative.

3. **Crash recovery is not implemented.** `persist_review_effects_atomically`
   (`engine.rs:40886-40994`) stages graph and ticket separately, then performs four renames with
   best-effort in-process rollback. No journal or startup recovery recognizes its
   `.review-staging-*` / `.review-backup-*` siblings. A process or power loss between publication
   renames can leave graph/ticket split or missing. This is not caused by the value-exact replay
   patch, so it is separate storage hardening rather than a blocker for that narrow correction;
   however any release claim of *crash-safe atomic* review effects must remain blocked until a
   journal/recovery protocol and rename-boundary fault-injection tests exist. Recovery must converge
   to old/old or new/new, never bless an unbound partial state.

4. **Coverage provenance is recomputed, not recorded.** `AppliedReviewEffect` binds only
   `effect_id`, `node_ids`, and `set` (`engine.rs:2583-2598`). Coverage is evaluated during prepare
   and later recomputed against the final graph and current ticket targets
   (`engine.rs:13420-13435`, `13556-13557`). The post-effect graph hash makes ordinary final-graph
   drift fail closed, so this is not independently an ordinary-path release blocker. Exact audit
   provenance and cross-effect semantics still require recorded required/actual sets or the static
   noninterference rule above.

### Missing regression shapes

- Generic Git-common-dir pre-effect replay with two effect types, literal plus `$review.id` /
  `$actor` values, first application changing both, and an exact second replay preserving graph
  hash and bytes.
- Tracked already-post-effect no-op with the same envelope.
- One effect selecting multiple candidates: omission, duplicate, unsorted IDs, wrong effect order,
  wrong mapping, and extra materialized-but-unrecorded candidate all reject.
- Ticket target-set drift, selector/type/status/precondition drift, unrelated semantic graph drift,
  and wrong post hash all reject without changing the caller graph.
- Field/list/object-key/relation coverage: missing and extra required/actual members reject, and a
  later effect cannot retroactively change an earlier effect's coverage meaning.
- Fault injection before/after each tracked graph/ticket rename, followed by deterministic recovery.

### Final verdict

**Narrow defect fixed; generic semantic contract not released.** Exact destination comparison is
correct and the Software 6/6 path is real, not a workaround. Release still needs exact complete
selection/target provenance and the requested generic two-effect/idempotent-no-op regression.
Mutation-before-mismatch is contained today and classified P2. Crash recovery is a separate P1
reliability requirement only if crash-safe atomicity is part of the release claim; otherwise it
must remain explicitly documented hardening rather than being implied by the helper name/comment.

Status transition: `complete — review signed; source remains untouched`.

### 2026-07-14 superseded current-source disposition — `primary-integrator/root`

The signed verdict above remains the correct audit of its original source snapshot. It is
superseded for current review-effect status by the later independent, line-by-line disposition in
`graph-tdd-boundary-audit.md`:

- both pre-effect and already-post replay recompute the canonical review input from reconstructed
  pre-effect state and reject target order, scope, rule-anchor, actor, and related drift without
  mutation;
- v1.1 binds the complete candidate universe, snapshots/pre-hash, ordered effects, exact mappings,
  and post hash, rejecting omissions in both replay states;
- the replacement regression compiles the real Software profile/operation and reaches the normal
  Git-common projection path for two configured effects, byte-idempotent replay, zero durable
  writes, and omission/drift rejection; and
- review transition, acceptance, projection, and `integration.validate` use the canonical leased
  ticket root.

Accordingly, the former `complete-selection/target-provenance` and `valid generic two-effect`
release gates are closed in current source. The same-ticket source-authority contract is also
closed. Cross-ticket preparation binding remains a separately owned active gate, filesystem-
manifest/effect replay order remains documented P2 hardening, and tracked multi-file crash recovery
remains a reliability gate wherever crash-safe atomicity is claimed. Owner-reported focused
review-effect evidence is 1/1; the independent rerun was compile-blocked only by foreign moving Pi
and deterministic-ticket source, so the final frozen matrix must rerun it on one stable
fingerprint. This transition changes documentation status only and does not claim whole-project
release or authorize live state.
