# Compiler-Owned Asset Grants Design

## Problem

Research-profile `plan-build-asset` tickets currently advertise permission to add an
`asset`, but the operation omits `max_new_nodes`. The compiler therefore emits
`maxNewNodes: 0`. Gate-derived tickets also begin with only the gate in their node
scope and no filesystem paths.

An agent can map the missing capability, but cannot produce the output contract:
one compatible asset with an implementation plan and a validation link. It finishes
the ordinary workflow, requests broader authority, and causes the compiler to park
the source ticket behind a change proposal. A run with several independent gates
therefore displays many "blocked" tickets even though Git integration is healthy.

## Design

Koni retains its existing two-phase asset protocol:

1. `plan-build-asset` authors graph-only asset intent: a new asset node, its
   capability, implementation plan, and gate link.
2. After that graph delta integrates, the compiler derives `implement-asset` from
   the asset's exact `spec.implementation_plan.root` and files. That second ticket
   receives the exact filesystem grant.

The first operation will authorize exactly one new asset node. It will not receive
a speculative filesystem grant because planning does not write project files. This
keeps the grant narrow and lets the compiler derive paths from durable graph data.

The upstream change-control path remains available when an attempt truly needs
nodes, types, or paths outside this envelope. Koni will not auto-approve arbitrary
scope broadening.

## Deterministic Git Ownership

Agents continue to submit semantic graph deltas or project changes; they never run
merge or rebase policy. The compiler owns:

- immutable ticket worktree bases;
- exact node and path grants;
- commits and integration receipts;
- disjoint sibling graph rebasing;
- strict conflict detection for overlapping agent-authored node fields and paths;
- derivation of the implementation ticket after planning integrates.

Compiler-owned field evolution is handled by its ownership projection and must not
weaken per-node CAS for agent-authored content.

## Operator Projection

A source ticket parked behind its exact `executionControl.sourceHold` is waiting for
compiler change control, not an independently actionable failure. Durable state may
remain fail-closed as `blocked`, but operator surfaces will:

- label it `Waiting for compiler grant`;
- exclude it from blocked/failed attention counts;
- place it with pending work rather than actionable blocked work;
- continue to expose the associated proposal as the operator decision surface.

Real ticket failures and blocked tickets without a source hold remain attention.

## Existing Runs

Compiled run configuration is immutable. The active medium MUAT run will not have
its pinned operation envelope rewritten. Its existing proposals will proceed through
the current durable change-control protocol. New runs compiled after installation
receive the corrected grant and avoid this proposal pattern.

## Verification

Focused tests must prove:

1. the research profile compiles `plan-build-asset` with `maxNewNodes: 1`;
2. the operation still grants no speculative filesystem path;
3. a held source is labeled as waiting and excluded from blocked attention;
4. an ordinary blocked ticket remains actionable;
5. existing change-control and graph-CAS tests continue to pass;
6. the installed TUI shows accurate attention while the existing medium run resumes.

