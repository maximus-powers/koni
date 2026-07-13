# Philosophy

Köni is named for the Königsberg bridge problem. Euler's breakthrough was to
stop treating the city map as a route-finding picture and represent it as a
graph: land masses became nodes and bridges became edges. Once the structure
was explicit, the important property became easy to reason about.

Agentic engineering has the same trap. A long prompt encourages a model to
invent a route before the system has represented the obligations, dependencies,
and proof boundaries that make the route valid. Köni makes the topology first.

## Graph before itinerary

A Köni project defines semantic node and edge types for its domain. A software
profile might model systems, packages, interfaces, decisions, risks, and
verification obligations. A research profile might model claims, methods,
experiments, evidence, and gates.

```text
              ┌────────────┐
              │  decision  │
              └─────┬──────┘
                    │ constrains
                    ▼
┌─────────┐ uses ┌─────────┐ verifies ┌──────────────┐
│ package ├─────►│ service ├─────────►│ acceptance   │
└─────────┘      └────┬────┘          │ criterion    │
                      │                └──────────────┘
                      │ exposes
                      ▼
                 ┌───────────┐
                 │ interface │
                 └───────────┘
```

Rules inspect that graph and identify missing or invalid relationships. Ticket
constructors turn those gaps into bounded work. Agents do not decide what
counts as complete after the fact; the profile defines the target state before
work starts.

The graph is not a project-management decoration. It is the typed state from
which work is compiled and against which results are reviewed.

## Deterministic spine, creative leaves

Köni divides responsibility deliberately:

| Deterministic engine | Bounded agents |
| --- | --- |
| Load and validate configuration | Interpret an ambiguous goal |
| Resolve graph selectors and rules | Propose architecture or experiments |
| Derive ticket identity and dependencies | Implement a scoped ticket |
| Enforce workflow and Git boundaries | Review qualitative trade-offs |
| Run checks and verify receipts | Explain risks and unresolved decisions |
| Publish accepted state atomically | Produce structured candidate output |

Models are strongest where judgment is required. They are weakest as the
authority for IDs, paths, state transitions, permissions, or whether their own
work passed. Köni keeps those decisions in compiler-owned data and narrow
interfaces.

An agent may propose a graph delta; it cannot silently redefine the graph
schema. It may report a check result; the engine records the command, status,
artifacts, and hashes. It may ask a question; Köni adds the durable run,
session, policy, and pause metadata.

## Maximum locality

An obligation should live next to the thing it constrains:

- node requirements belong to node types and rules;
- allowed changes belong to operations and ticket scopes;
- execution order belongs to workflows;
- acceptance belongs to checks, review contracts, and gate policies;
- agent behavior belongs to personas and native Codex resources;
- run-wide trade-offs belong to run types.

Local policy makes configuration comprehensible and limits the blast radius of
change. It also makes context packs smaller: a worker can receive the target,
its relevant neighborhood, its operation, and its workflow rather than the
entire project history.

## Receipts before interpretation

A state transition should be supported by durable evidence. Köni records
receipts for commands, graph changes, review outcomes, checkpoints, and
integration. Receipts bind results to the inputs that made them meaningful:
the run snapshot, semantic graph, ticket target, context, output, and command
where applicable.

```text
candidate output
      │
      ├── command receipt ─┐
      ├── graph receipt ───┼──► review ─► accepted transition
      └── context hash ────┘
```

Human-readable reports are projections of those records, not substitutes for
them. A polished summary cannot turn stale or missing evidence into success.

## Review before transaction

Ticket work stays isolated until its configured checks and review contract
succeed. Semantic changes are proposed in the ticket worktree, inspected
against the ticket scope, and then integrated through one engine-owned
transaction.

The ordering matters:

1. establish a bounded target and context;
2. produce a candidate change;
3. execute deterministic checks;
4. review the code and semantic delta;
5. integrate as one squash commit;
6. reconcile the graph and derive the next work.

Review is therefore a boundary, not a final comment pass on already-published
state.

## Isolated parallelism

Parallel agents are useful only when their authority is disjoint. Köni gives
each approved run its own integration branch/worktree and each ticket its own
branch/worktree. Ticket scopes, single-flight groups, graph targets, and
workflow dependencies constrain what may run together.

The configured `max_parallel` value is a ceiling, not a promise. The compiler
may schedule fewer workers when work overlaps or prerequisites are incomplete.
Parallel results are composed through Git trees and semantic validation rather
than by allowing agents to share a mutable checkout.

## Questions are state transitions

A question is not loose chat. It records:

- the concrete decision and why it matters;
- two or more choices and exactly one recommendation;
- whether it pauses a ticket or the whole run;
- how and when a non-pausing decision resolves;
- the Codex session and context that must resume.

Run types choose the question posture. Small work can proceed conservatively,
Medium can stop only for high-impact decisions, and Large can actively surface
architecture and risk choices. Approval is always explicit regardless of that
question policy.

## Configuration is the product surface

The engine stays generic. Domain vocabulary belongs in the project profile.
That is why Köni installs configuration skills for Codex: users should be able
to describe their desired graph, workflow, roles, or gates in plain language
and have an informed agent edit the project-owned contract safely.

The TUI is the complementary surface for inspection and touch-up. Both edit
the same validated resources. Neither creates an untracked shadow
configuration.
