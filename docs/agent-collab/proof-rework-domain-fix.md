# Structured review-failure routing

Owner: `proof-rework-domain-fix/root`

Status: `in_progress`

Last checked: 2026-07-16 America/Phoenix

## Lease and safety boundary

This lane closes the P1 in
[`implementation-proof-preparation-review.md`](implementation-proof-preparation-review.md): a
final implementation Reviewer may discover that the independently prepared proof/oracle itself
is incomplete, while the old flat failed verdict could only reopen a product-write Implementer.

Owned source is limited to the generic workflow/reviewer-result/state/routing seam in
`crates/koni-core/src/{config,state,engine}.rs`, the bundled Software workflow declarations,
focused configuration and Software proof-gate regressions, static reviewer fixtures that must
obey the new invocation schema, and append-only adjacent documentation. Live projects, runs,
worktrees, Git refs, processes, binaries, installed profiles, acceptance fixtures, and cmux are
excluded.

## Intended contract

- A new compiler-launched reviewer returns schema 1.1 with `failure_domain: none` on pass or one
  compiler-advertised profile domain on failure. Persisted schema-1.0 results remain readable but
  cannot satisfy a new invocation.
- Workflows may declare `review_failure_routes`. A `reopen` route names the exact earliest step;
  a `block` route must name `replan_from_clean_integration` and give nonempty recovery
  instructions. A workflow cannot combine the route map with the legacy scalar boundary.
- `ticket_rework` is appropriate only when every finding is correctable inside the selected
  review-subject step and its write/graph authority. Its existing bounded one-revision circuit is
  retained.
- An upstream route preserves every rejected candidate output and worktree, opens a typed blocker
  on the first failure, clears runtime ownership normally, and makes no reopened step eligible.
  Its durable recovery record explicitly forbids proof preparation against the mutated candidate:
  replan from clean integration, independently complete the corrected upstream preparation, and
  issue fresh product work only afterward.
- The route map, reviewer result, durable agent binding, ticket review boundary, and model-facing
  packet are compiler-bound. Prose is never parsed into routing authority.

## Active verification matrix

Focused coverage is being added for route configuration validation, new-versus-legacy reviewer
schemas, generic first-failure hold semantics, ordinary product-only rework, and adversarial
Software change, migration, and multiple-proof candidates. Cargo checks will use a private target
directory and remain narrow until all concurrent source lanes settle.

## 2026-07-16 09:54 MST — source released for independent integration

Status transition: `ready_for_integration`; the original active marker above remains the lane's
start-state history.

The implemented generic contract is now source-closed:

- `WorkflowDef.review_failure_routes` carries profile-declared domain descriptions and typed
  `reopen`/`block` disposition. Validation rejects mixed legacy/new forms, unknown/review reopen
  steps, unsafe block routes, empty descriptions, and missing clean-integration instructions.
- New review invocations require schema 1.1. The output schema exposes only `none` plus the exact
  ticket-snapshotted domain IDs; validation and process-local authorization reject schema-1.0,
  invented, pass-with-failure, or fail-with-`none` results. Historical schema-1.0 records still
  deserialize and revalidate under their prior bounded policy.
- The exact selected domain persists in `ReviewAgentBinding`, participates in durable agent/result
  matching and ticket review boundary provenance, and appears in bounded execution context.
- A `reopen` route feeds the existing transitive rework boundary and two-failure circuit. A
  `block` route bypasses output supersession on its first failure, preserves the rejected
  candidate, opens `review-failure-recovery-required`, marks the ticket blocked when the state
  machine permits, and records the exact review/output plus clean-integration recovery policy.
- Software red-green and characterization workflows declare `ticket_rework → implement` and
  `upstream_proof → block/replan_from_clean_integration`. Current-verification and legacy
  workflows retain their existing scalar route behavior.

Private-target focused evidence on the stable lane snapshot:

- generic route configuration validation — **1/1 passed**;
- schema-1.1 advertised-domain validation — **1/1 passed**;
- generic first-upstream-failure preservation/hold policy — **1/1 passed**;
- real Software change + migration + two-proof upstream hold matrix — **1/1 passed** (three
  independent fixture lifecycles);
- existing ordinary product-only rework lifecycle — **1/1 passed**;
- embedded Software template tests — **4/4 passed**;
- all modified Rust paths pass targeted `rustfmt --check`; scoped `git diff --check` is clean.

All Cargo commands used `CARGO_TARGET_DIR=/tmp/koni-proof-rework-domain-target`. No broad suite,
binary build/install, live state, project, run, process, worktree, Git ref, acceptance fixture, or
cmux surface was touched. The parent integrator owns serialized composed gates and independent
review.

Residual compatibility boundary: the safe recovery is deliberately an explicit compiler hold and
machine-readable clean-integration replan path, not an automatic mutation of preparation evidence
or a rollback of the rejected worktree. Automating that later would require its own journaled
transaction and lifecycle design. Existing installed profiles and already compiled tickets remain
pinned to their historical route snapshots.
