# Graph-TDD compiler boundary audit

Owner: `graph-tdd-boundary-audit/root`

Status: `complete` — read-only product-code audit; this mailbox is the only owned write.

Last checked: 2026-07-14 America/Phoenix

## Scope and coordination

This lane adversarially reviewed the compiler-owned boundaries in
`crates/koni-core/src/engine.rs` for graph-selected source preservation and writable-path
separation, review-effect preparation/replay/provenance, canonical Git-common ticket-root
evaluation, integration/acceptance transitions, and the valid configured Software two-effect
regression. Product-code ownership remained with `compiler-graph-tdd/root`,
`proof-preparation-binding/root`, and `proof-path-disjointness/root`; this lane made no source
edit. Findings were routed to the primary compiler owner before disposition, and the final source
was re-read after each correction.

## Findings and transitions

### Closed — complete immutable review input

Both pre-effect and already-post replay now validate the reviewer's canonical input against the
reconstructed pre-effect graph before accepting the bound application. The input hash binds the
profile and operation registry identity, optional rule anchor, title/rule/source/target/obligation
identity, ordered targets, complete scope, workflow, blockers, change control, prior failed review,
outputs, causal receipts, decorated non-review receipts, semantic graph, review step/action, and
operation review contract. Target-order, scope, and rule-anchor drift regressions reject without
mutating either replay state.

The v1.1 application records the exact sorted candidate universe, complete pre-effect candidate
snapshots, pre-effect semantic graph hash, ordered configured effects, exact selected members and
mappings, configured actor, and bound post hash. Preparation is clone/swap atomic at production
callers; an exact post-state replay is byte-stable and performs no durable write. Omitting one
eligible member fails in both pre- and post-effect states.

### Closed — valid configured/runtime regression

The focused regression uses the existing profile-validated Software operation
`implementation.change.verify-current`, its real three-step workflow and configured review action,
and valid objective/system/change/proof nodes. It creates the leased Git-common checkout and real
proof-source files, compiles both configured graph-selected check sets against that checkout,
persists the semantic pre-graph, and exercises normal `projected_ticket_graph` replay. It proves
the two disjoint effects, exact multi-member selection, target/scope/anchor and actor drift
rejection, first application, byte-for-byte idempotent replay, zero durable writes, and strict
member-omission rejection. This replaces the earlier synthetic post-validation fixture; the older
review notes remain causal history rather than being rewritten.

### Closed — canonical Git-common review and acceptance root

`canonical_ticket_root_engine` now redirects review-effect selector/coverage preparation to the
leased ticket checkout whenever a Git-common caller is on another checkout.
`validate_graph_at_ticket_root` is used for review-transition preflight, acceptance preflight, and
the recorded passing-review candidate. Projection materialization, scoped manifest replay, final
graph validation, review-input filesystem/receipt decoration, target-state evaluation,
review-transition evaluation, ticket acceptance, and `integration.validate` all use the same
canonical lease root while retaining the shared sidecar store and supplied semantic graph.

This closes the concrete audit finding that a general review-effect coverage selector may contain
receipt/proof/currentness predicates and therefore cannot safely run against the integration
checkout merely because the selector starts from semantic graph nodes.

### Closed for the documented same-ticket contract — graph-selected source authority

Ticket emission waits until every workflow step has compiled its exact graph sets. The compiler
then retains each configured write-path definition's provenance: only a nonempty projection of the
configured graph-set `source_paths_field` whose selected nodes are within that step's compiled
members is classified as source-write authority. Literals, covered-path projections, nonmember
projections, and other grants remain separate. Normalized equality and containment in either
direction between any selected proof source and any non-source grant fail closed. Read-only
sources and non-graph-set profiles remain compatible, while source member/execution/freshness
identity stays independently enforced by the preservation validator.

The intentionally separate cross-ticket residual remains open: a preparation ticket can establish
a diagnostic source before a later production ticket exists, and the current boolean
`proof_preparation_current` interface does not expose a typed rule-to-preparation binding with
exact source identities for the later ticket's authority comparison. No review of the same-ticket
validator changes that documented boundary.

## Nonblocking hardening note

`projected_ticket_graph` currently replays a passed review effect before it materializes current
filesystem manifests and replays scoped manifest snapshots. Review recording, by contrast,
prepares the effect from the already materialized projection. A future Git-common profile that
combines a filesystem-manifest output on an effect candidate with review effects could therefore
produce different full pre-node snapshots even when the semantic hash excludes compiler
projections. The current Software profile configures no filesystem manifests, so this is a P2
generic ordering hardening item, not a release blocker for the active configured regression.

## Verification at final audit snapshot

- The compiler owner reported the strengthened focused review-effect regression **1/1 passed**
  after adding the explicit Software profile manifest to the helper and the canonical-root review
  routing.
- This lane's first independent focused run compiled and reached the test, but was blocked before
  review semantics by the concurrently incomplete Software project manifest. After that fixture
  was corrected, the final independent rerun was prevented at crate compilation by active foreign
  work: two `deterministic-ticket-reopen` borrow/lifetime errors in `engine.rs` and two Pi runtime
  process errors. No failure from the audited review/source/root symbols was emitted.
- The separately owned source-authority handoff records **2/2 passed** focused authority tests and
  the generic graph-check-set suite **6/6 passed**.

## Disposition

`review_input_and_replay_p1_closed; canonical_ticket_root_p1_closed; valid_two_effect_regression_closed; same_ticket_source_authority_closed; cross_ticket_preparation_alias_explicitly_open; no_remaining_p1_in_this_audited_boundary`

### 2026-07-14 post-disposition compile transition

The source-shape verdict above remains unchanged after the final canonical-root patch re-read:
there is no remaining P1 in this lane's review/input/replay/root or same-ticket authority boundary.
The independent command
`cargo test -p koni-core --lib review_effect_replay_binds_complete_two_effect_selection_and_is_idempotent -- --nocapture`
was compile-blocked after waiting for the shared target lock. At that snapshot it reported active
deterministic-ticket-reopen and Pi errors before executing the test; it emitted no error from an
audited symbol.

The primary integrator's immediately newer shared check confirms the deterministic-ticket-reopen
errors are now resolved. The current compile blockade is only the foreign Pi runtime-process work
at `pi_runtime_process.rs:361` and `pi_runtime_process.rs:405`. This transition narrows the earlier
snapshot rather than rewriting it, and it does not weaken the explicit cross-ticket alias or P2
filesystem-manifest/effect-ordering residuals.
