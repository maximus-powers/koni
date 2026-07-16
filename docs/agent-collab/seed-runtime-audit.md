# Planning Seed / Spec-Slice Runtime Audit

Owner: `seed-runtime-audit/root`

Status: `complete` (read-only verdict; scoped blocker resolved 2026-07-14)

Last checked: 2026-07-14 (Phoenix)

## Mission and boundary

Independently audit approved planning-seed materialization and recovery plus
ticket `spec_slice` compilation against the living-spec decisions in
[`context-spec.md`](context-spec.md). This lane owns no product source or
product documentation. It may append findings only here and report them to the
integration owner; `context-spec/root` owns any corrective implementation.

The audit preserves the active generic proof-compiler and Software-profile
leases. It did not install a binary, edit a profile, or mutate a live or
forensic run.

## 2026-07-14 initial verdict

One release blocker was reported to `context-spec/root`: the first
`build_ticket_spec_slice` implementation filtered missing target/read/write
IDs out of the anchor set. That made a corrupt mandatory anchor disappear from
model context instead of failing closed.

The remaining inspected seed boundary was sound:

- The newly issued planning schema is closed (`additionalProperties: false`),
  bounded, and has a typed seed shape. Runtime decoding rejects unknown seed,
  node, and edge members; no node-level lifecycle `status` is authorable.
- Only the configured final executable pre-approval planning stage may return
  a seed. The same binding check covers ordinary completion and forced budget
  synthesis recovery.
- Seed shape validation enforces a nonempty semantic mutation, bounded bytes,
  node and edge counts, safe unique local keys, known endpoints, unique edges,
  and undirected reachability from `$root`; full profile graph validation then
  enforces typed fields, statuses, relations, cardinality, and predicates.
- The compiler derives run-scoped deterministic node IDs, owns the effective
  goal and approved-planning fields, rejects declared compiler-owned seed
  fields, and applies each node type's configured initial status.
- The configured seed operation is profile-validated as an initialization-only
  compiler authority with one root target and no workflow, rule emission,
  checks, receipts, review effects, deletion, gates, change control, terminal
  resolution, or recovery behavior.
- Approval validates the complete expected graph before worktree publication.
  Initialization persists the graph before its receipt, detects an exact
  receipt replay, reconstructs a missing seed only before ticket state exists,
  recovers a missing initialization receipt, and refuses a partial seed once
  tickets exist.
- Model-facing graph projections remove the raw approved `graph_seed` and keep
  only materialization, hash, and node/edge-count cues. The semantic graph
  remains the durable authority.
- `spec_slice` selection is stable-sorted, anchor-first, depth/node-bounded,
  and traverses in both directions only from ticket anchors. The run root may
  remain visible but is not a traversal seed, so unrelated root siblings do
  not consume the ticket neighborhood.
- Context carries semantic graph, exact slice, steering, and working-memory
  hashes; the outer compiler-issued context hash additionally binds the full
  ticket, contracts, outputs, reviews, persona, and selected step.

Compatibility note: the parser intentionally keeps older top-level planning
artifacts readable and normalizes omitted empty seed containers through serde
defaults. Newly launched agents still receive the exact required JSON schema,
and every accepted seed still crosses stage binding, seed-shape validation,
materialization authority, and full graph validation. This is not an authority
bypass.

## 2026-07-14 resolved verdict

Accepted for integration with no remaining blocker in this audit's scope.

`context-spec/root` changed `build_ticket_spec_slice` to deduplicate the
requested ticket anchors first and reject any ID absent from the selected
graph before applying the profile node budget. Direct regressions now prove:

1. missing target/read/write anchors fail closed;
2. every valid ticket anchor wins the budget before optional context;
3. adding the run root does not expand unrelated root siblings; and
4. raw planning seed input is replaced by its bounded hash/count projection.

The stricter check initially exposed one stale manual review-rework fixture:
it predeclared a future `interface-a` ID in read/write scope before that node
existed in either the canonical or superseded candidate graph. The fixture now
keeps only the objective and actual superseded candidate as pre-context
anchors; fresh-node authority remains governed by the operation contract and
is reconciled when output is recorded. This preserves production fail-closed
behavior rather than adding a missing-anchor exception.

## Verification record

Commands use an isolated target directory and do not touch installed or live
runtime state.

- `CARGO_TARGET_DIR=/tmp/koni-seed-runtime-audit-target cargo test -p koni-core seed --lib -- --nocapture`
  — 7 passed, 0 failed.
- Exact `ticket_spec_slice_rejects_missing_anchors_and_never_expands_root_siblings`
  — 1 passed, 0 failed.
- Exact `model_context_replaces_raw_planning_seed_with_bounded_projection`
  — 1 passed, 0 failed (also included in the seed group).
- Exact `graph_context_and_notes_are_ticket_scoped_advisory_supplements`
  — 1 passed, 0 failed.
- `CARGO_TARGET_DIR=/tmp/koni-seed-runtime-audit-target cargo test -p koni-core context --lib -- --nocapture`
  — 9 passed, 0 failed.
- The integration owner recorded the corrected
  `git_common_rework_validates_edge_only_corrections_against_superseded_candidates`
  regression at 1 passed, 0 failed. Later local reruns crossed incomplete save
  points in the separately leased graph-set proof compiler and are not treated
  as context failures.
- `git diff --check -- crates/koni-core/src/engine.rs crates/koni-core/src/config.rs crates/koni-core/src/catalog.rs docs/AGENT_COLLAB.md`
  — clean.

No source, profile, product-doc, install, cockpit, or live-run mutation was
performed by this audit lane.
