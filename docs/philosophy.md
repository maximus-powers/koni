# Philosophy

Köni is named for the Königsberg bridge problem. Euler's breakthrough was to stop treating the city
map as a route-finding picture and represent it as a graph. Land masses became nodes and bridges
became edges. Once the structure was explicit, the important property became easy to reason about.

Agentic engineering has the same trap. A long prompt encourages a model to invent a route too early.
The system has not yet represented the obligations, dependencies, and proof boundaries that make the
route valid. Köni makes the topology first.

## Graph before itinerary

A Köni project defines semantic node and edge types for its domain. A coding profile might model
systems, packages, interfaces, decisions, risks, and verification obligations. A research profile
might model claims, methods, experiments, evidence, and gates.

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

Rules inspect that graph and identify missing or invalid relationships. Ticket constructors turn
those gaps into bounded work. Agents do not decide what counts as complete after the fact. The
profile defines the target state before work starts.

The graph is not a project-management decoration. It is the typed state from which work is compiled
and against which results are reviewed.

One semantic fact should normally have one stored edge. When both directions matter, the profile
declares a canonical relation and an inverse traversal alias. It does not ask agents to maintain
reciprocal copies. Independent directed facts stay separate only when they can truthfully diverge.
Canonical one-fact storage prevents two agent-authored copies of one relationship from drifting
apart.

## Deterministic spine, creative leaves

Köni divides responsibility deliberately:

| Deterministic engine                    | Bounded agents                         |
| --------------------------------------- | -------------------------------------- |
| Load and validate configuration         | Interpret an ambiguous goal            |
| Resolve graph selectors and rules       | Propose architecture or experiments    |
| Derive ticket identity and dependencies | Implement a scoped ticket              |
| Enforce workflow and Git boundaries     | Review qualitative trade-offs          |
| Run checks and verify receipts          | Explain risks and unresolved decisions |
| Publish accepted state atomically       | Produce structured candidate output    |

Models are strongest where judgment is required. They are weakest as the authority for IDs, paths,
state transitions, permissions, or whether their own work passed. Köni keeps those decisions in
compiler-owned data and narrow interfaces.

An agent may propose a graph delta, but it cannot silently redefine the graph schema. It may report
a check result, and the engine records the command, status, artifacts, and hashes. It may ask a
question, and Köni adds the durable run, session, policy, and pause metadata.

## Maximum locality

An obligation should live next to the thing it constrains:

- Node requirements belong to node types and rules.
- Allowed changes belong to operations and ticket scopes.
- Execution order belongs to workflows.
- Acceptance belongs to checks, review contracts, and gate policies.
- Agent behavior belongs to personas and provider-neutral `.koni/agents` resources.
- Run-wide trade-offs belong to run types.

Local policy makes configuration comprehensible and limits the blast radius of change. It also makes
context packs smaller. A worker can receive the target, its relevant neighborhood, its operation,
and its workflow rather than the entire project history.

Approved-plan seeding makes that neighborhood a durable living specification. Ticket packs add a
bounded authoritative spec slice, explicit steering, and advisory graph-bound working memory. A
worker may request another bounded neighborhood when needed, but that read cannot enlarge its
semantic or filesystem authority.

## The graph is a living specification

An approved plan should not disappear into prose that every later worker must reinterpret. A run
type may designate one planning pass to produce a typed graph seed. The profile bounds that seed
with a compiler-only operation. The operator reviews it with the plan, and initialization validates
and publishes the root plus its implementation-ready nodes and relations atomically. Later accepted
graph deltas keep the same specification current as work proceeds.

Review Plan exposes a bounded semantic summary before approval, and the approved plan preserves that
same summary afterward. Seedless plans keep the original three sections. The view is capped at six
root facts, twelve nodes, and sixteen relationships, with omitted counts shown. Internal keys and
IDs, hashes, paths, schema and storage metadata, and raw `spec` stay outside the human approval
surface. Operators inspect node type, title, purpose, and relationships without seeing internal IDs
or raw schema payloads.

Agents can also attach graph-bound observations, implementation details, rationale, nits, and open
questions. These notes are durable working memory, not a second semantic graph. They retain run,
ticket, step, persona, and time provenance. Corrections supersede earlier records instead of erasing
them. Even a `confirmed` note stays advisory until its meaning is expressed through an authorized,
reviewed graph transition or explicit user steering.

Context therefore has an authority order:

1. The pinned profile contracts and reviewed typed graph, including the approved seed and accepted
   graph deltas.
2. Current explicit user or Lead steering within those contracts.
3. Graph-bound working notes, which may explain the state but cannot override scope, acceptance, or
   a semantic fact.

Receipts bind accepted outputs and evidence to the state they support. They do not turn an advisory
note into project intent.

A normal ticket context projects the relevant typed `spec_slice`, recent `intent_updates`, and
bounded `working_memory` alongside the existing ticket, operation, workflow, dependency-output, and
review contracts. A worker may request a small additional graph neighborhood when a concrete
dependency is missing. That read neither expands its write authority nor changes the specification.

Presenting the pack alongside existing contracts is the conservative schema `1.0` rule. It applies
whenever an agent must author or analyze graph semantics. Schema `1.1` instead presents a
step-relevant projection. It applies to a compiler-proven file or check execution step with graph
mutation forbidden and no selected gate or query contract. That projection carries one copy of typed
graph state, the exact selected execution boundary and outputs, and hashes committing to omitted
authority. This changes transport volume, not selection, scope, acceptance, receipt, or context-hash
authority. Ambiguity falls back to the full document.

## Receipts before interpretation

A state transition should be supported by durable evidence. Köni records receipts for commands,
graph changes, review outcomes, checkpoints, and integration. Receipts bind results to the inputs
that made them meaningful: the run snapshot, semantic graph, ticket target, context, output, and
command where applicable.

```text
candidate output
      │
      ├── command receipt ─┐
      ├── graph receipt ───┼──► review ─► accepted transition
      └── context hash ────┘
```

Human-readable reports are projections of those records, not substitutes for them. A polished
summary cannot turn stale or missing evidence into success.

The proof topology is domain-specific. Coding changes may use a meaningful red-to-green boundary, a
passing characterization that must remain stable, or an already-sufficient current check.
Manufacturing a failure is not evidence. Empirical research instead binds claims to predeclared
metrics, baselines, ablations, gates, run receipts, and bounded interpretations. In both cases the
profile makes the chosen strategy and its limitations inspectable before a model can claim
completion. Treating expected-red testing as universal proved costly in live work, so profiles
declare domain-appropriate proof strategies while compiler-owned receipts stay the evidence
boundary.

### Graph-native proof compilation

Locality distinguishes model context from compiler closure. A worker still receives a bounded
context pack. An opt-in composite check may compile the complete finite proof neighborhood selected
from the ticket target through configured canonical or inverse relations. Repository filepaths are
metadata on those selected proof nodes, not a replacement graph inferred from filenames.
`source_paths` name the exact test and harness bytes that make the receipt causal. `covered_paths`
name the product subject, and they neither grant writes nor pretend to be observed coverage.

The compiler pins the selected nodes, registered child checks, argv, working directories, path sets,
and semantic hashes on the workflow step. A later topology or contract change fails closed instead
of silently changing what an active ticket means.

A red-to-green workflow may also name its causal baseline with `preserve_source_paths_from`. The
baseline and green checks may classify different accepted exit sets. They must still resolve the
same source node, command, working directory, source paths, and covered paths. The compiler compares
the current exact source bytes to the historical baseline receipt inside the exact read-only
execution binding, not in an earlier workflow preflight. It compares the baseline manifest to the
manifest bound into the green pre-execution and post-execution snapshots. Product bytes may change.
This builds the non-test-churn part of test-driven development into the graph and receipt model
without making expected-red universal.

The compiler also separates the rule's one semantic anchor from a ticket's broader target and
authority closure. It unions graph-set selection per anchor and prevents traversal through nodes
outside the effective step-readable graph. Models explain proof meaning, while the compiler owns the
complete deterministic evidence closure and its repository file identities.

Exact argv is meaningful only when it cannot conceal another command language. Graph-selected
members therefore bind directly named project-local interpreter scripts as `source_paths`. They do
so even without executable mode or a shebang. They reject shell command strings and `env` wrappers.
This is intentionally scoped to the graph-native proof compiler. The graph declares causal
repository files, the compiler verifies those declarations against the executable form, and no
heuristic filename graph replaces the semantic topology.

### Evidence-guided delivery

The Coding profile applies that principle through Evidence-Guided Vertical Delivery. One ticket
should normally own one cohesive objective-facing claim and the smallest useful executable evidence.
It should not own one ontology node or one human-role handoff. Architecture and contract mapping are
conditional. Assurance scales with material risk. Adverse or stale proof fails closed. Independent
review judges behavior rather than transcribing an upstream graph proposal. The detailed rationale
and alternatives remain in [Software Profile Engineering](software-profile-engineering.md).

Three proof roles follow from this, without becoming universal ceremony. A focused proof belongs to
exactly one implementation subject. It runs its historical baseline plus the compiler-owned green
set inside the implementation workflow. A diagnostic or risk-boundary proof may first need one
source-only preparation and an oracle review. Its boundary green waits for all governed changes and
controls. Independent review owns semantic acceptance. Residual-risk acceptance stays
human-approved, and exact current delivery reopens when its closure changes.

A focused red-green or characterization oracle is prepared and independently reviewed before product
implementation. This moves semantic oracle completeness upstream. Incomplete consumer routing fails
before production bytes are writable, and later product review can request code rework without
reopening trusted proof-source authoring. Current-verification remains a read-only existing-proof
path, so this adds no artificial authoring ceremony to already-current evidence.

### Currentness follows authenticated history

Currentness follows authenticated causal history, not whichever live value would make a predicate
favorable. The compiler chooses one shared newest preparation attempt before target filtering. It
accepts later effect-owned values only through chronological, exact configured-review links. Manual
drift, future evidence, archived deterministic-ticket cycles, and value recycling all fail closed.
Returning to a prepared value requires a new reviewed preparation.

Full compilation reuses one authenticated typed slice for both predicate truth and write authority.
That preserves one answer across all consumers without caching projected or prospective semantic
results. One answer means one answer for one exact graph and immutable evidence source. It does not
mean reuse merely because a field was labeled non-semantic. A profile selector may observe such a
field, so graph truth is keyed by the complete normalized graph. The compiler gets efficiency from
the safer layer instead. It snapshots and indexes tickets and receipts once across the derivation
pass. It then starts a new source epoch after reconciliation. This keeps causal authentication
deterministic and bounded without making performance depend on an unenforced claim about what
profile expressions read.

## Review before transaction

Ticket work stays isolated until its configured checks and review contract succeed. Semantic changes
are proposed in the ticket worktree, inspected against the ticket scope, and then integrated through
one engine-owned transaction.

The ordering matters:

1. Establish a bounded target and context.
2. Produce a candidate change.
3. Execute deterministic checks.
4. Review the code and semantic delta.
5. Integrate as one squash commit.
6. Reconcile the graph and derive the next work.

Review is therefore a boundary, not a final comment pass on already-published state.

## Isolated parallelism

Parallel agents are useful only when their authority is disjoint. Köni gives each approved run its
own integration branch and worktree, and each ticket its own branch and worktree. Ticket scopes,
single-flight groups, graph targets, and workflow dependencies constrain what may run together.

The configured `max_parallel` value is a ceiling, not a promise. The compiler may schedule fewer
workers when work overlaps or prerequisites are incomplete. Parallel results are composed through
Git trees and semantic validation. Agents never share a mutable checkout.

## Questions are state transitions

A question is not loose chat. It records:

- the concrete decision and why it matters
- two or more choices and exactly one recommendation
- whether it pauses a ticket or the whole run
- how and when a non-pausing decision resolves
- the Pi session and context that must resume

Questions resume Pi sessions only.

Run types choose the question posture. Small work can proceed conservatively. Medium can stop only
for high-impact decisions. Large can actively surface architecture and risk choices. Approval is
always explicit regardless of that question policy.

## Configuration is the product surface

The engine stays generic. Domain vocabulary belongs in the project profile. That is why Köni
installs configuration skills into the repository. Users should be able to describe their desired
graph, workflow, roles, or gates in plain language. An informed agent then edits the project-owned
contract safely.

Authoring and execution use `.koni`, repository skills under `.agents/skills`, provider-neutral
agents, and the contained direct-Pi path.

The TUI is the complementary surface for inspection and touch-up. Both edit the same validated
resources. Neither creates an untracked shadow configuration.

Convenient defaults can misstate a project's architecture or proof commands. Substantial
customization therefore begins with repository inspection and an explicit semantic-design approval.
The agent still edits only the same validated project-owned resources.

Customization begins from the installed profile and the repository's actual evidence. The agent
inspects boundaries, interfaces, CI, and verification, or in research work the experimental methods,
datasets, metrics, and publication rules. It then proposes the graph and compiler behavior for
explicit approval. This keeps project semantics deliberate instead of letting a convenient default
quietly become a false description of the work.
