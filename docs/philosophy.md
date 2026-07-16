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

One semantic fact should normally have one stored edge. When both directions
matter, the profile declares a canonical relation and an inverse alias rather
than asking agents to maintain reciprocal copies. Independent directed facts
remain separate only when they can truthfully diverge.

> **Evolving to — 2026-07-14:** The original graph-first contract above made
> typed relationships authoritative but did not constrain reciprocal storage.
> Canonical one-fact storage plus an inverse traversal alias now prevents two
> agent-authored copies of one relationship from drifting apart while retaining
> genuinely independent directed facts.

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

> **Pi/schema 2 locality transition in progress — 2026-07-14 (`pi_product_docs_transition`):**
> Native Codex resources remain the executable schema-1 realization of this locality principle and
> the historical-reader contract. Schema 2 keeps agent policy project-local but expresses it as
> provider-neutral `.koni/agents` consumed by the direct Pi host in
> [Direct Pi runtime](pi-runtime.md). A migrated project has no Codex fallback. The philosophical
> boundary is not a shipping claim: field-scoped migration, historical readers, and the unresolved
> credential-TCB choice between a Rust-owned allowlisted auth proxy and a signed/pinned host
> dependency closure remain gates, alongside artifact/teardown/protocol/token security and the
> frozen matrix.

> **Release-candidate supersession — 2026-07-14 (`pi_product_docs_transition`):** The preceding
> unshipped/undecided status is historical. Current source is the schema-2/direct-Pi release
> candidate for macOS, with no production Codex fallback. Its accepted first-cut credential TCB is
> the exact Köni Rust binary, bundled Pi host, pinned Pi SDK 0.80.7 dependency closure, and official
> pinned Node 22.19.0 runtime; Node remains non-authoritative for compiler tools, graph, receipts,
> Git, and project files. Linux login/inference fail closed pending destination-allowlisted egress.
> Installation and live migration remain separate guarded operator actions, and protected forensic
> Updog state authorizes neither.

Local policy makes configuration comprehensible and limits the blast radius of
change. It also makes context packs smaller: a worker can receive the target,
its relevant neighborhood, its operation, and its workflow rather than the
entire project history.

> **Evolving to — 2026-07-14:** The bounded context-pack model above remains
> the baseline. Approved-plan seeding now makes that neighborhood a durable
> living specification, and ticket packs add a bounded authoritative spec
> slice, explicit steering, and advisory graph-bound working memory. A worker
> may request another bounded neighborhood when needed, but that read still
> cannot enlarge its semantic or filesystem authority.

## The graph is a living specification

> **Evolving to — 2026-07-14:** Earlier runs began from a typed root plus
> durable planning prose, and later accepted deltas grew the graph. Repeated
> reconstruction in live ticket work showed that implementation boundaries,
> risks, and proof intent also need a reviewed typed starting state. The seed
> and advisory-memory authority model below extends the original graph-first
> contract without turning prose notes into semantic state.

> **Transition in progress — 2026-07-14:** Compiler validation and publication
> of the seed are implemented. The ordinary Review Plan is gaining a bounded
> semantic seed section so operators can inspect node type/title/purpose and
> relationships without seeing internal IDs, hashes, paths, or raw schema
> payloads. Until that focused UI regression lands, the full visibility side of
> the approval contract is not yet claimed as shipped.

> **Transition completed — 2026-07-14:** The visibility side has landed.
> Review Plan exposes a bounded semantic summary before approval, and the
> approved Plan preserves that same summary afterward; seedless plans keep the
> original three sections. The view is capped at six root facts, twelve nodes,
> and sixteen relationships with omitted counts, and later adversarial tests
> close hidden-node, raw-spec/schema, embedded-key, wrapped hash/UUID, and
> post-approval payload-substitution leaks. Internal keys and IDs, hashes,
> paths, schema/storage metadata, and raw `spec` remain outside the human
> approval surface. The hardened approval suite passed 25/25; the earlier
> visibility handoff's full TUI suite passed 279/279. The integrated tree
> after adversarial projection and unrelated evidence/runtime truthfulness
> follow-ups passes the full TUI suite 288/288.

An approved plan should not disappear into prose that every later worker must
reinterpret. A run type may designate one planning pass to produce a typed
graph seed. The profile bounds that seed with a compiler-only operation, the
operator reviews it with the plan, and initialization validates and publishes
the root plus its implementation-ready nodes and relations atomically. Later
accepted graph deltas keep the same specification current as work proceeds.

Agents can also attach graph-bound observations, implementation details,
rationale, nits, and open questions. These notes are durable working memory,
not a second semantic graph. They retain run, ticket, step, persona, and time
provenance; corrections supersede earlier records instead of erasing them.
Even a `confirmed` note remains advisory until its meaning is expressed through
an authorized, reviewed graph transition or explicit user steering.

Context therefore has an authority order:

1. the pinned profile contracts and reviewed typed graph, including the
   approved seed and accepted graph deltas;
2. current explicit user or Lead steering within those contracts;
3. graph-bound working notes, which may explain the state but cannot override
   scope, acceptance, or a semantic fact.

Receipts bind accepted outputs and evidence to the state they support; they do
not turn an advisory note into project intent.

A normal ticket context projects the relevant typed `spec_slice`, recent
`intent_updates`, and bounded `working_memory` alongside the existing ticket,
operation, workflow, dependency-output, and review contracts. A worker may
request a small additional graph neighborhood when a concrete dependency is
missing, but that read neither expands its write authority nor changes the
specification.

> **Evolving to — 2026-07-15:** “Alongside the existing contracts” remains the
> conservative schema `1.0` rule whenever an agent must author or analyze graph
> semantics. For a compiler-proven file/check execution step with graph mutation
> forbidden and no selected gate/query contract, schema `1.1` instead presents a
> step-relevant projection: one copy of typed graph state, the exact selected
> execution boundary and outputs, and hashes committing to omitted authority.
> This changes transport volume, not selection, scope, acceptance, receipt, or
> context-hash authority. Ambiguity falls back to the full document.

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

The proof topology is domain-specific. Software changes may use a meaningful
red → green boundary, a passing characterization that must remain stable, or an
already-sufficient current check; manufacturing a failure is not evidence.
Empirical research instead binds claims to predeclared metrics, baselines,
ablations, gates, run receipts, and bounded interpretations. In both cases the
profile makes the chosen strategy and its limitations inspectable before a
model can claim completion.

> **Evolving to — 2026-07-14:** The earlier receipt contract above established
> that evidence must bind state transitions, but it did not prescribe a single
> proof topology. Live Software and Research work exposed the cost of treating
> expected-red testing as universal, so profiles now declare domain-appropriate
> proof strategies while retaining compiler-owned receipts as the evidence
> boundary.

> **Graph-native proof compilation — 2026-07-14:** The locality principle now
> distinguishes model context from compiler closure. A worker still receives a
> bounded context pack, while an opt-in composite check may compile the complete
> finite proof neighborhood selected from the ticket target through configured
> canonical or inverse relations. Repository filepaths are metadata on those
> selected proof nodes, not a replacement graph inferred from filenames.
> `source_paths` name the exact test/harness bytes that make the receipt causal;
> `covered_paths` name the product subject and neither grant writes nor pretend
> to be observed coverage. The compiler pins the selected nodes, registered
> child checks, argv, working directories, path sets, and semantic hashes on the
> workflow step. A later topology or contract change fails closed instead of
> silently changing what an active ticket means.

> A red-to-green workflow may additionally name its causal baseline with
> `preserve_source_paths_from`. The baseline and green checks may classify
> different accepted exit sets, but they must resolve the same source node,
> command, working directory, source paths, and covered paths. Immediately
> before green execution, the compiler compares the current exact source bytes
> to the historical baseline receipt; product bytes may change. This builds the
> non-test-churn part of test-driven development into the graph and receipt
> model without making expected-red universal.

> **Proof-closure hardening — 2026-07-14:** “Immediately before” above now
> means inside the exact read-only execution binding, not an earlier workflow
> preflight. The compiler compares the baseline manifest to the manifest bound
> into the green pre/post execution snapshots. It also separates the rule's one
> semantic anchor from a ticket's broader target/authority closure, unions
> graph-set selection per anchor, and prevents traversal through nodes outside
> the effective step-readable graph. These refinements preserve the original
> principle: models explain proof meaning, while the compiler owns the complete
> deterministic evidence closure and its repository file identities.

> **Command-path closure refinement — 2026-07-14:** Exact argv is meaningful
> only when it cannot conceal another command language. Graph-selected members
> therefore bind directly named project-local interpreter scripts as
> `source_paths` even without executable mode or a shebang, and reject shell
> command strings and `env` wrappers. This is intentionally scoped to the
> graph-native proof compiler: the graph declares causal repository files, the
> compiler verifies those declarations against the executable form, and no
> heuristic filename graph replaces the semantic topology.

> **Software delivery evolution — 2026-07-14:** Software 0.4 applies that principle through
> Evidence-Guided Vertical Delivery. One ticket should normally own one cohesive objective-facing
> claim and the smallest useful executable evidence, not one ontology node or human-role handoff.
> Architecture and contract mapping are conditional, assurance scales with material risk, adverse
> or stale proof fails closed, and independent review judges behavior rather than transcribing an
> upstream graph proposal. The detailed rationale and alternatives remain in
> [Software Profile Engineering](software-profile-engineering.md).

> **Evidence topology finalized — 2026-07-14:** The Software principle now distinguishes three
> proof roles without turning them into universal ceremony. A focused proof belongs to exactly one
> implementation subject and runs its historical baseline plus compiler-owned green set inside the
> implementation workflow. A diagnostic or risk-boundary proof may first need one source-only
> preparation and oracle review; boundary green waits for all governed changes and controls.
> Independent review owns semantic acceptance, residual-risk acceptance remains human-approved,
> and exact current delivery reopens when its closure changes. This preserves causal evidence while
> keeping routine work to baseline, cohesive implementation with compiler proof, and review.

> **Implementation-oracle refinement — Software 0.6 (2026-07-16):** The topology above remains the
> causal design checkpoint, but a focused red-green or characterization oracle is now prepared and
> independently reviewed before product implementation as well. This moves semantic oracle
> completeness upstream: incomplete consumer routing fails before production bytes are writable,
> and later product review can request code rework without reopening trusted proof-source
> authoring. Current-verification remains a read-only existing-proof path, so the refinement adds
> no artificial authoring ceremony to already-current evidence.

> **Integration-status boundary — 2026-07-14:** The paragraph above is the accepted Software
> design, not a claim that every enforcing primitive has shipped. Scoped graph-TDD is released,
> while cross-ticket preparation identity, exact pinned-member selection, source/write
> disjointness, pre-merge checkout currentness, review-effect provenance, the expanded Software
> re-review, and the Pi/schema-2 frozen matrix remain active. The harness should describe an
> unenforced guarantee as a gate or trust gap, never promote it to philosophy-as-fact.

> **Gate narrowing — 2026-07-14 (`pi_product_docs_transition`):** Preserve the broad boundary
> above as the causal checkpoint. Current source has since closed review-effect P1 provenance,
> exact pinned-member selection, canonical ticket-worktree/root evaluation, and same-ticket
> proof-source/write separation. Cross-ticket preparation provenance and emission/lease admission,
> the full Software and Pi/schema-2 matrices, and the final immutable fingerprint remain active;
> those remaining trust gaps still cannot be promoted into philosophy-as-shipped fact.

> **Final-matrix supersession — 2026-07-14 (`pi_product_docs_transition`):** The later compiler,
> Software, Pi/schema-2, and locked whole-workspace endpoint closes those source gates and establishes
> the current release candidate. The philosophical rule still holds: that source evidence does not
> install a binary, migrate a project, use credentials, or authorize live work; each is a separate
> operator boundary.

> **Authenticated-history currentness transition — 2026-07-14 (`compiler-graph-tdd`):** The
> cross-ticket preparation gap above is now source-wired around one philosophical rule: currentness
> follows authenticated causal history, not whichever live value would make a predicate favorable.
> The compiler chooses one shared newest preparation attempt before target filtering and accepts
> later effect-owned values only through chronological, exact configured-review links. Manual
> drift, future evidence, archived deterministic-ticket cycles, and A→B→A value recycling fail
> closed; returning to the prepared value requires a new reviewed preparation. Full compilation
> reuses one authenticated typed slice for both predicate truth and write authority, preserving one
> answer across all consumers without caching projected or prospective semantic results. The
> frozen release ledger remains pending beside this source transition.

> **Evidence reuse follows authority identity — 2026-07-14 (`compiler-graph-tdd`):** “One answer”
> means one answer for one exact graph and immutable evidence source, not reuse merely because a
> field was labeled non-semantic. A profile selector may observe such a field, so graph truth is
> keyed by the complete normalized graph. The compiler gets efficiency from the safer layer: it
> snapshots and indexes tickets and receipts once across the derivation pass, then starts a new
> source epoch after reconciliation. This keeps causal authentication deterministic and bounded
> without making performance depend on an unenforced claim about what profile expressions read.

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

> **Session-identity transition in progress — 2026-07-14 (`pi_product_docs_transition`):** The
> durable question/context identity remains authoritative. Schema-1 questions resume their pinned
> Codex sessions; schema-2 questions will resume Köni-owned Pi sessions and canonical event logs.
> Codex-backed active runs are archived rather than resumed across migration, and historical
> session readers remain available. Exactly-one terminal events, request/turn correlation,
> cancellation teardown, and token accounting must pass before that target is executable.

> **Session-identity supersession — 2026-07-14 (`pi_product_docs_transition`):** Those identity,
> terminal, teardown, accounting, and history-reader contracts now pass at the release-candidate
> endpoint. Schema-2 questions resume Pi sessions only; migrated Codex sessions are permanent
> historical records, never executable fallback.

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

> **Authoring-runtime transition in progress — 2026-07-14 (`pi_product_docs_transition`):** Codex
> skills and chats remain the schema-1 authoring surface described by the paragraphs above. Schema
> 2 retains repository-owned `.agents/skills` and the same approval-first semantic workflow, but
> Köni invokes the pinned Pi SDK host directly and cannot fall back to Codex after migration.
> Migration ownership/recovery, historical readers, credential/containment trust, exact broker and
> terminal behavior, and one frozen CLI/TUI/profile matrix must be green before this becomes the
> current product surface.

> **Authoring-runtime supersession — 2026-07-14 (`pi_product_docs_transition`):** Those source
> gates are now green for the current release candidate. Schema-2 authoring and execution use
> `.koni`, repository skills, provider-neutral agents, and the contained direct-Pi path; Codex
> remains only the schema-1/historical-reader surface. Existing projects transition only through a
> separately authorized guarded migration.

> **Evolving to — 2026-07-14:** The original contract above allowed an informed
> agent to edit project-owned resources directly from a natural-language
> request. Repository evidence showed that convenient defaults can misstate a
> project's architecture or proof commands, so substantial customization now
> begins with repository inspection and an explicit semantic-design approval;
> the agent still edits only the same validated project-owned resources.

Customization therefore begins from the installed profile and the repository's
actual evidence. Codex inspects boundaries, interfaces, CI and verification—or
experimental methods, datasets, metrics, and publication rules—then proposes
the graph and compiler behavior for explicit approval. This keeps project
semantics deliberate instead of letting a convenient default quietly become a
false description of the work.
