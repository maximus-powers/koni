# Graph TDD / Research regression diagnosis

- Persona: graph-tdd-research-regression
- Status: complete; read-only lease released
- Scope: diagnose the two current `research_profile.rs` failures involving ticket-worktree squash context-hash idempotence and configured review-effect promotion selection.
- Ownership: no Rust, profile, product-documentation, central-ledger, or other-mailbox edits. Findings only in this file and a report to the compiler integrator.
- Started: 2026-07-14

## Findings (2026-07-14)

Both failures reproduce independently with `CARGO_TARGET_DIR=/tmp/koni-compiler-graph-tdd-target cargo test -p koni-core --test research_profile <test> -- --exact --nocapture`. Both expectations predate the concurrent Research edits; neither failure is caused by current Research YAML/profile semantics.

1. `catalog_formulation_ticket_squash_integrates_from_ticket_worktree`
   - Observed first and second hashes: `sha256:c891...9ced` then `sha256:9d67...bbc5`.
   - Generic graph-TDD step-scope work changed `compile_context`'s `selected_step_def` source from the already-sanitized `context_ticket.workflow` to the live `ticket.workflow` (`engine.rs`, near the `let selected_step_def` block).
   - The live selected step contains the first issued `context_hash` on the second invocation. Because `selected_step_def` is serialized directly into `context_document`, the context pack becomes self-referential across issuance. The preexisting code intentionally cleared every workflow step's `context_hash` before selecting it.
   - Minimal fix owned by the compiler/graph-TDD lane: select the step from `context_ticket.workflow` again. Its new `read_nodes`/`write_nodes` and path-scope fields survive sanitization, so the effective-step-scope helpers still receive all required authority metadata while `context_hash` remains blank.

2. `configured_review_effects_own_promotion_and_bind_it_to_the_exact_pass`
   - The expected terminal diagnostic is `stale or incomplete provenance`; the actual error is `review effect promote-candidate-evidence selected 0 delta-authored nodes; expected exactly 1`.
   - This is caused by the generic exact-value replay hardening in `replay_review_effect_application`, not by Research profile changes. The tampered recorded mapping sets `spec.promoted_by=worker`, while configuration and the atomically materialized tracked graph both contain `lead`.
   - Exact comparison correctly makes `already_materialized=false`, but replay then calls `prepare_review_effect_application` against the post-effect tracked graph. The configured selector is `promotion_state absent`, so it necessarily selects zero nodes and leaks its low-level count error before `configured_ticket_review_errors` can classify the binding as stale provenance. The old presence-only branch reached the outer validator, but was too weak; restoring it would regress the security fix.
   - Minimal safe fix owned by the compiler/exact-review-replay lane: preserve exact-value comparison, but when recorded/configured mapping or materialized values disagree, return/classify the replay as `configured review step <binding.step_id> has stale or incomplete provenance` rather than rerunning an absent pre-effect selector on a tracked post-effect graph. A backend-specific variant can reserve selector replay for `GitCommonDir` (where the effect must be reconstructed) and treat a non-exact `Tracked` materialization as stale immediately. Including the underlying mismatch after the stable phrase is safe for diagnostics.

No product or implementation files were edited in this lane.
