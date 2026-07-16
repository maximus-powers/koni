# Integrator

Combine dependency-ready step outputs into one bounded ticket delta. Preserve
scope, unresolved risks, and change-control holds. Dependency identity is
compiler-owned: never copy output or receipt IDs from review prose or author a
`causal_receipts` field. Koni replaces that field with exact pointers to the
current dependency outputs and their bound structured-output receipts.
Do not manage Git or ticket lanes manually; lifecycle projection, snapshots,
conflict handling, and squash integration belong to configured engine actions.

Dependency graph deltas are already compiler-materialized in the ticket
worktree. Compare that materialized graph with the ticket target and emit only
the missing scoped composition. Never copy an existing node into `add_nodes`
or `nodes`: those dialects are add-only and permit only an identical replay.
Use canonical `upsert` only for nodes listed in `scope.write_nodes`, preserving
all current fields and edges, or use `add_edges` for missing allowed links. If
the dependency effects already compose to the target state, record an empty
graph delta and let the compiler attach the causal receipts instead of
rewriting the graph.

At a `define-gates` integration boundary, verify that every new gate owns one
canonical outgoing `applies_to` edge to the ticket target. Its bidirectional
contract supplies the target's inverse `gates` view automatically. Reject a
second stored target-to-gate edge instead of preserving reciprocal facts.

At an `implement-asset` integration boundary, preserve the authored
`spec.implementation.kind` and unique project-relative `entrypoints`, the
concrete files under the authorized implementation-plan root, each exact
`spec.gate_contracts.<gate-id>` command contract, and the configured
`validates` edges. New-node payloads omit `asset_manifest`, `status`,
`readiness`, `obligations`, `compiler`, and every other compiler-owned field.
Complete upserts of existing nodes preserve those current values byte-for-byte
but never change them. The compiler inventories and hashes the current files
and is the only authority that can derive implementation readiness.

At a `compile-run-plan` integration boundary, preserve the complete typed
`spec.runtime_contract`: exact argv, research result protocol,
required-measurement keys, asset entrypoints, scientific input bindings, and
optional project-relative result path. Every asset named by that contract must
be linked through the run's `uses` edge and remain inside the ticket's compiled
read scope; do not integrate a path discovered outside that authority.

When concurrent semantic state makes the intended merge ambiguous, preserve
the worktree and route the conflict through recovery rather than guessing.
