# Independent post-fix review: structured review-failure routing

Owner: `proof-rework-fix-reviewer/root`

## 2026-07-16 10:09 MST — approved for integration

Status: `approved_for_integration`

This was a read-only production review of the correction described in
[`implementation-proof-preparation-review.md`](implementation-proof-preparation-review.md) and
[`proof-rework-domain-fix.md`](proof-rework-domain-fix.md). No production source, profile, test,
live project, run, fixture, worktree, Git ref, process, binary, runtime asset, installed profile,
or cmux surface was changed. The only writes from this lane are this review and the adjacent
central-ledger entry.

### Verdict

No P0 or P1 remains in the structured review-failure routing lane. The former P1 is closed:

- `WorkflowDef.review_failure_routes` is profile-declared, validated, included in the compiled
  profile hash, and copied into each emitted ticket as a durable route snapshot. Mixed legacy and
  structured configuration, reserved `none`, unknown/review reopen steps, incomplete reopen
  routes, and non-clean-integration block routes fail profile compilation.
- Every new compiler-launched Reviewer uses result schema 1.1. Its output JSON Schema enumerates
  only `none` plus the exact effective ticket-domain set, and post-parse validation enforces
  pass-with-`none`, fail-with-an-advertised-non-`none` domain. A schema-1.0 or invented-domain
  result cannot publish through a new invocation.
- The route snapshot is included in `ticket_review_boundary_hash`; that boundary participates in
  `ReviewInputBinding`, the durable agent input hash, and the revalidated authorization at
  `review.record`. The selected `failure_domain` is copied into `ReviewAgentBinding`, compared
  against the exact durable agent result, and thereby participates in the review and enclosing
  ticket hashes. A route or review-input change while the Reviewer is running makes the
  authorization stale.
- Persisted schema-1.0 results and bindings remain readable because `failure_domain` is optional
  only for historical data and omitted from serialization when absent. New invocations cannot
  use that compatibility path. A historical failure without a domain retains the prior bounded
  behavior.
- `ticket_rework` resolves to the profile-snapshotted `implement` boundary and enters the existing
  one-revision circuit. The first failure supersedes only the configured step and its transitive
  dependents; a second failure preserves the replacement candidate and blocks further automatic
  work.
- `upstream_proof` resolves to `block` on the first failure. `review.record` applies no review
  effects on a failed verdict, preserves all candidate outputs and the leased worktree, clears the
  finished Reviewer's PID/active-worker ownership, records a typed blocker and recovery object,
  and exposes no reopened step. Ticket status plus the blocker excludes it from both board
  eligibility and the next-worker boundary, so no replacement Implementer is produced.
- Missing, unknown, or malformed route metadata cannot make the route-aware policy fall through
  to product work after a typed failure: an unadvertised new result is rejected before recording;
  a persisted unknown domain or an invalid route resolves to the conservative hold path.

The bundled Software workflows apply the split symmetrically to red-green and characterization
implementation for both changes and migrations. The real lifecycle matrix independently proves a
red-green change, migration, and two-proof change all preserve the rejected candidate and expose
no eligible replacement worker. The ordinary product-correction lifecycle independently proves
that `ticket_rework` still permits one product-only correction against the immutable prepared
oracle and can then pass review and finish.

### Clean-integration recovery boundary

The hold is safely honest. It records `replan_from_clean_integration`,
`clean_integration_required: true`, `rejected_candidate_preserved: true`, the failed review ID,
the rejected output hash, and explicit instructions forbidding proof preparation from the mutated
candidate worktree. It does **not** claim to have revoked preparation evidence, rolled back a
worktree, emitted a replacement preparation ticket, or completed recovery. The open blocker is
the executable safety mechanism; automatic clean-state rollback/re-preparation remains a future
journaled lifecycle transaction rather than an implicit side effect of review.

### Non-blocking hardening notes

- P2: `review_ticket_with` adds a duplicate top-level `review_failure_routes` field to the
  model-facing evidence packet after `model_facing_review_evidence_packet` computes its local
  `packet_hash`. The same exact route map is already inside the hashed
  `operation_acceptance.workflow`, and the authoritative route snapshot is independently covered
  by `ReviewInputBinding.review_boundary_hash`, so this is not a routing or currentness escape.
  Still, constructing the top-level field before the packet hash would make the packet's local
  self-hash semantically complete and easier to audit.
- P2: add one real characterization upstream-failure lifecycle and direct malformed persisted-map
  regression. Current source is symmetric and fails closed, while the existing real matrix covers
  change, migration, and multiple red-green proofs; the extra cases would make that parity
  executable rather than inspection-backed.
- Automatic recovery from the explicit hold is intentionally out of scope. If added later, it
  needs its own transaction, exact clean-integration binding, preparation supersession, and
  candidate quarantine tests; it must not reinterpret this hold as evidence that those mutations
  already occurred.

### Independent executable evidence

All commands used lane-private targets and were run on unchanged reviewed source fingerprints:

- `cargo test -p koni-core validates_structured_review_failure_routes --lib -- --nocapture` —
  **1 passed / 0 failed**;
- `cargo test -p koni-core new_ticket_review_result_requires_an_advertised_failure_domain --lib -- --nocapture` —
  **1 passed / 0 failed**;
- `cargo test -p koni-core upstream_review_failure_blocks_first_and_preserves_rejected_candidate --lib -- --nocapture` —
  **1 passed / 0 failed**;
- `cargo test -p koni-core review_rework_circuit_allows_one_revision_then_preserves_the_second_candidate --lib -- --nocapture` —
  **1 passed / 0 failed**;
- `cargo test -p koni-core --test software_proof_gate software_review_rework_keeps_prepared_oracle_immutable_and_reopens_product_only -- --exact --nocapture` —
  **1 passed / 0 failed**;
- `cargo test -p koni-core --test software_proof_gate software_upstream_oracle_review_failure_holds_change_migration_and_multi_proof_candidates -- --exact --nocapture` —
  **1 passed / 0 failed** across three independent fixture lifecycles;
- `cargo test -p koni-cli templates::tests::software_change_design_defaults_emit_one_reviewed_vertical_candidate -- --exact --nocapture` —
  **1 passed / 0 failed**;
- `cargo test -p koni-cli templates::tests::software_proof_defaults_are_adaptive_graph_selected_and_repository_owned -- --exact --nocapture` —
  **1 passed / 0 failed**.

Scoped `git diff --check` is clean. The reviewed config/state/engine/profile/test fingerprints were
identical before and after the executable checks.
