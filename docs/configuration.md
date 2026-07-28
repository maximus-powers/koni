# Configuration reference

A Köni project has three configuration layers:

1. The **project catalog** lists selectable run types.
2. A **run type** defines how one kind of run is planned and supervised.
3. The **profile** defines the graph, rules, tickets, workflows, and evidence model shared by every
   run type.

All Köni-native configuration is YAML beneath `.koni/`. Repository skills remain `SKILL.md` bundles
beneath `.agents/skills/`.

Core installs one verified immutable profile baseline beneath `.koni`. It treats the materialized
project tree as an upgrade-safe overlay, and it exposes source-SHA compare-and-swap structured YAML
edits to the shared control center. It never edits Pi's settings, credentials, or ambient resources.
See [Pi-native profile lifecycle](profile-lifecycle.md) and
[Pi community resource bindings](pi-community-resource-bindings.md).

## Directory contract

```text
.koni/
├── project.yaml
├── run-types/
│   ├── small.yaml
│   ├── medium.yaml
│   └── large.yaml
├── profile.yaml
├── graph.yaml
├── rules.yaml
├── operations.yaml
├── workflows.yaml
├── actions.yaml
├── checks.yaml
├── lifecycle.yaml
├── agents/
│   ├── lead.yaml
│   └── reviewer.yaml
├── resources/
│   └── pi-packages.yaml
└── .managed/
.agents/
└── skills/
    └── configure-koni/
```

Files may be split by directory instead of consolidated. `profile.yaml` declares every imported
module. Paths must stay within the configuration root after canonical resolution. Duplicate IDs,
dangling references, unknown fields, invalid cycles, and unsafe action ordering all fail validation.

`resources/pi-packages.yaml` is part of the authenticated compiled configuration rather than a side
catalog. Enabled autonomous entries require exact `select.skills`, `select.prompts`, or Koni-owned
`select.tools` values, plus stage and persona eligibility. Selected bytes are copied and hash-bound
per run and per launch. Ambient Pi files and extension code are never inherited. Existing Pi
settings and package state are read-only and stay user-owned.

## Project catalog

`.koni/project.yaml` answers one question: which kinds of runs can this project create?

```yaml
schema_version: "2.0"
project:
  id: software
  title: Software project
  description:
    Evidence-guided vertical software delivery with selectable complexity and intent presets.
default_run_type: continuous-improvement
run_types:
  - id: small
    path: run-types/small.yaml
  - id: medium
    path: run-types/medium.yaml
  - id: large
    path: run-types/large.yaml
  - id: new-feature
    path: run-types/new-feature.yaml
  - id: bug-fix
    path: run-types/bug-fix.yaml
  - id: continuous-improvement
    path: run-types/continuous-improvement.yaml
```

`default_run_type` and every catalog ID must resolve to exactly one run-type document. The `id`
inside that document must match its catalog entry. Catalog order is the presentation order in the
control center.

Every listed run type is a complete peer. Large does not layer on Medium at run time, and a custom
`ui-feature` type is not a modifier applied to another type.

The bundled Coding profile ships six run types. Small, Medium, and Large are complexity envelopes.
`new-feature` and `bug-fix` are source-level derivatives of `medium`: ordered JSON-Pointer overrides
specialize intake, planning instructions, and concurrency. Catalog compilation then resolves each
one into a complete immutable run type. They are selectable alternatives, never stackable modifiers.
Research ships Small, Medium, and Large only.

## Run types

A run type owns intake, pipeline, question policy, Git namespace, role policy, and orchestration
behavior:

```yaml
schema_version: "2.0"
id: medium
title: Medium
description: A standard multi-component change with one combined semantic plan.

instructions:
  planning: |
    Begin with a lightweight decision scan before broad repository inspection.
    Ask one focused batch of one to three questions early when the answers would
    materially change scope, architecture, safety, user experience, or
    verification. Never ask for facts the repository can answer.

planning:
  max_repository_tool_calls: 16
  token_budget:
    metric: new_tokens
    limit: 120000
    synthesis_reserve: 30000
    on_exhausted: force_synthesis

profile:
  source: .koni/profile.yaml

intake:
  objective_field: goal
  fields:
    goal:
      label: Goal
      description: Describe the outcome Koni should deliver.
      type: text
      required: true
  order: [goal]

pipeline:
  stages:
    intake:
      kind: action
      title: Validate intake
      config: { compiler_owned: true, action: planning.intake }
    combined-plan:
      kind: planning
      title: Plan implementation, architecture, and risk
      config:
        { persona: run-planner, prompt: Produce one implementation-ready plan and graph seed. }
    approval:
      kind: approval
      title: Approve the plan
    initialize:
      kind: initialize
      title: Initialize the run
    orchestrate:
      kind: orchestration
      title: Execute compiled work
    verify:
      kind: checkpoint
      title: Verify the completed run
      config: { checkpoint: verification }
    report:
      kind: action
      title: Compile final report
      config: { action: report, automatic: true }
  order: [intake, combined-plan, approval, initialize, orchestrate, verify, report]

questions:
  policy: high_impact_only
  default_scope: run

git:
  branch_template: "koni/runs/{{ run.id }}/integration"
  ticket_branch_template: "koni/runs/{{ run.id }}/tickets/{{ ticket.id }}/cycles/{{ cycle.id }}"

run_card:
  sections: [goal, pipeline, graph, tickets, checks, report]

agents:
  roles:
    planner: { model: gpt-5.6-sol, thinking_level: xhigh }
    lead: { model: gpt-5.6-sol, thinking_level: xhigh }
    ticket_worker: { model: gpt-5.6-terra, thinking_level: high }
    reviewer: { model: gpt-5.6-terra, thinking_level: xhigh }
  personas: {}

orchestration:
  auto_start: true
  max_parallel: 3
  compile_action: compile
  lead_action: spawn-lead
  report_action: report
```

Compilation requires literal sibling Git ref leaves, such as `integration` and `tickets`. It rejects
any run and ticket pair that could render as a leaf or prefix collision.

### Intake

`intake.fields` is keyed by a stable field ID, and `intake.order` must name every field exactly
once. `intake.objective_field` names the field that carries the operator-facing Objective. Supported
types are:

- `string`, `text`, and `path`
- `boolean`, `integer`, and `number`
- `choice` and `multi_choice`, with a non-empty duplicate-free `options` list
- `json`

Defaults must match their declared type. The common `goal` field appears once in the new-run dialog.
Additional fields render in configured order.

### Pipeline

`pipeline.stages` is keyed by stable stage ID, and `pipeline.order` must name every stage exactly
once. Supported stage kinds are:

| Kind                 | Meaning                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `action`             | Execute a configured or compiler-owned action                      |
| `planning`           | Run a bounded planning pass                                        |
| `ai`                 | Run a provider-neutral model step                                  |
| `approval`           | Require explicit operator approval                                 |
| `initialize`         | Seed pinned semantic state                                         |
| `orchestration`      | Compile and supervise ticket work                                  |
| `checkpoint`         | Verify or confirm a durable boundary                               |
| `target_sync`        | Merge the current target head into the isolated run branch         |
| `promotion`          | Await exact operator authorization, then advance the target branch |
| `manual` / `handoff` | Wait for explicit operator completion                              |
| `external_loop`      | Drive a configured external provider state machine                 |

The `ai` stage lets a profile use the model primitive without naming a transport. Planner, Lead,
Worker, and Reviewer intents compile into the same typed Pi runtime request with compiler-owned
cumulative output budgeting.

Only the consecutive compiler-owned intake and planning prefix may execute before approval. A
planning stage beyond that boundary is rejected. A run type may designate its final planning stage
as the sole producer of an approved typed graph seed. That adds a reviewed semantic artifact without
moving planning or graph publication past the approval boundary.

### Planning runtime

`planning.max_repository_tool_calls` accepts 1 through 256. The compiler counts read, list, and
search calls together. The final allowed result terminates exploration, and a second
schema-constrained turn synthesizes in the same live Pi session with repository tools closed.
Omission is a legacy-compatible 32 calls. Bundled Coding Small, Medium, and Large use 16, 24,
and 48.

Direct-Pi planning bounds complete plan prose to 24,000 characters. It bounds the complete visible
JSON artifact to 96 KiB, and it reserves 32,768 local output tokens for visible content plus hidden
reasoning. These are compiler and runtime bounds, not provider request parameters. The model must
return a dense plan without repeating the goal, supplied source material, repository excerpts, or
schema. An overrun preserves the completed transcript and exact billed usage, then pauses with the
fixed `runtime_output_limit` diagnosis.

The token budget is compiler-owned and cumulative for that planning session. `new_tokens` counts
`input - cached_input + output`. Reasoning tokens are already included in output and are not added
twice. `processed_tokens` counts the full input-plus-output total. At `limit - synthesis_reserve`,
Köni steers the planner to stop investigation and synthesize. If it continues spending,
`force_synthesis` interrupts that turn and resumes the same thread with tools disabled.

The full planning text stays durable for compilation and ticket execution. The approval modal shows
the planner-authored concise `review` items, which are individual headings plus descriptions. It
does not replace, truncate, or synthesize headings from the full artifact. After approval, the Plan
tab renders every successful full planning-pass body as scrollable Markdown and retains the bounded,
redacted Graph Seed. Compilation and execution always consume the full durable plan.

The Pi-native runtime launches exactly one fresh, contained Pi session for each compiler-issued
planning attempt. Retry and rework are authenticated attempt lineage rather than a configurable
reuse mode.

### Graph seed

The final planning stage returns a typed `graph_seed` alongside its complete prose plan. Every other
planning stage returns no seed. The seed uses `$root` for the existing run root, stable plan-local
keys for proposed nodes, and separate `root_spec`, `nodes`, and `edges` collections.

Köni assigns persistent IDs, resolves the local references, and validates the result against the
pinned graph schema and the profile's `initialization.planning_seed_operation`. All of that happens
before approval can succeed. Initialization publishes the validated root and seed as one atomic
state change, so tickets begin from the reviewed specification.

Review Plan conditionally adds a bounded Graph Seed section, and the approved plan reuses the same
projection. Seedless plans keep the earlier three-section view. It shows at most six root facts,
twelve semantic nodes, and sixteen titled relationships, with exact omitted counts. Relationships
cannot reveal omitted nodes. Local keys, IDs, hashes, UUIDs, paths, storage and schema metadata, and
raw `spec` content are suppressed, including wrapped, prefixed, and embedded forms.

### Questions

Question policies are:

- `autonomous`: select the recommendation for agent-raised questions
- `high_impact_only`: pause for high-impact decisions and auto-select routine recommendations
- `interactive`: pause for valid questions

The planning instructions control what the model should ask. The structured policy controls pause
behavior. Questions require at least two unique choices and exactly one recommendation. Non-pausing
resolution never invents an answer.

### Agent resolution

The supported role keys are `planner`, `lead`, `ticket_worker`, and `reviewer`. Effective model,
reasoning, instructions, and permissions resolve in this order:

1. One-run overrides.
2. Pipeline-stage overrides.
3. Run-type persona overrides.
4. Run-type role defaults.
5. Profile persona values.
6. Referenced agent resource values.
7. Runtime defaults.

The resolved result is pinned. A future edit cannot silently change an active run.

In the control center, reusable role defaults belong to the Run Types domain. The Agents domain
shows shared personas, prompts, permissions, and skills without duplicating per-run-type model rows.

Agent files are YAML under `.koni/agents/`. They express instructions, `model`, `thinking_level`,
capabilities, and skills. They cannot carry provider-native config overrides. `thinking_level: max`
is canonical. `ultra` is accepted only while reading a pre-migration historical snapshot.

The provider is intentionally not configurable. It is the pinned Pi provider authenticated through
Pi's own credentials. Core owns graph, Git, and receipt effects and issues exact tool capabilities.
Pi supplies only the model loop, streaming, structured output, and provider integration.

### Target-branch promotion

A Git-enabled delivery run normally places `target_sync` after orchestration and `promotion` last.
The run type's promotion policy names the configured operation used when target synchronization
conflicts:

```yaml
promotion:
  conflict_operation: resolve-target-integration
```

That operation should use a workflow whose steps cannot mutate the semantic graph. Its job is to
compose the product trees, preserve functionality from both sides, and provide fresh verification.

Promotion itself is compiler owned. It requires durable operator authorization bound to the run
head, target branch, and observed target head. A moved target reopens sync. A dirty checked-out
target blocks without moving the ref.

### Orchestration

`max_parallel` is a positive upper bound. Dependencies, overlapping scope, single-flight groups, and
change-control barriers may reduce actual parallelism. `auto_start` allows supervision to begin
after approval. It does not remove the approval boundary.

## Customize from the installed profile

Every project starts from its selected Coding, Research, or explicit custom profile. Core installs
that baseline as an immutable package tree plus a project-owned `.koni` overlay. Customize the
overlay. Do not recreate the default from memory.

Use the installed `configure-koni` skill for substantial changes. Before it writes, it should
inspect repository instructions, manifests, CI, tests, architecture and interfaces, verification
commands, and Git and promotion behavior. For research work it should also inspect datasets,
metrics, baselines, ablations, seed policy, and artifact reporting. It classifies important facts as
observed, inferred, or missing. It asks only questions whose answers change ontology, ticket scope,
authority, proof, or publication.

The agent then presents one approval packet. That packet contains the retained baseline, proposed
nodes and canonical relations, the rule-to-operation-to-workflow mapping, proof and receipt policy,
run and agent changes, exact files, assumptions, and a validation plan. Explicit approval of that
design is required before project configuration is edited. Profile changes affect future resolved
snapshots. They do not rewrite an active run.

The shipped skills discover `.koni/project.yaml` first, resolve each run type's actual
`profile.source`, validate the resolved manifest, and configure `.koni/agents/*.yaml` through
`agent`, `thinking_level`, and `capabilities`. `operate-koni` treats an existing `.koni` as
initialized rather than as a fresh install.

### Bundled semantic foundations

The Coding profile starts from an `objective` root. It maps the repository into `system`,
`interface`, `data_model`, `contract`, and end-to-end `flow` nodes. It then compiles missing work
into dependency-ordered `change`, `migration`, `decision`, `risk`, and `proof` nodes. Reviewed
`delivery` nodes compose the accepted work.

The profile does not emit architecture and contract work unconditionally. The approved seed records
the smallest sufficient existing boundary. Missing material boundaries compile focused mapping
tickets, while known local work proceeds as one objective-facing vertical claim. Routine changes
need focused proof. Elevated and critical changes add boundary proof and structural risk
disposition.

A change selects `red_green`, `characterization`, or `current_verification`. The selected rule pins
a distinct operation and workflow. The compiler determines the baseline kind, command and exit
contract, write scope, receipts, and review boundary. A proof's `baseline_check_id`, exact argv
`command`, `source_paths`, read-only `covered_paths`, contained working directory, conditions,
expected signal, `why`, and `not_proven` are the sole executable and evidence authority.

Every red-green and characterization focused proof goes through source-only preparation and an
independent oracle-completeness review before its change or migration becomes implementation-ready.
The implementation ticket can re-run that baseline but cannot write the reviewed proof source, so
ordinary final-review rework stays at the product `implement` step. Current-verification stays
read-only and emits no authoring preparation ticket.

Routine implementation is `establish-baseline`, then implement with the compiler-run promotion set,
then independent review. There is no duplicate Verifier or Integrator hop. Diagnostic and
risk-boundary proofs use the conditional `proof.prepare` lane, and boundary green execution waits
for every introducing subject and control.

An unresolved defect first receives one defect-only diagnostic proof, source-only preparation, and
reviewed diagnosis. No speculative addressing change is seeded. Bug fixes carry expected and
observed behavior. Reviewed delivery is `candidate_ready`. Target sync, composed verification, and
promotion stay compiler-owned.

Repository-specific setup, test, typecheck, lint, integration, and smoke commands are discovered
during project customization rather than assumed by the default.

The Research profile is deliberately empirical. It decomposes a `hypothesis` into falsifiable
`claim` nodes, prior `literature`, executable `experiment` and `ablation` designs, explicit `method`
and `metric` contracts, versioned `prerequisite` and `asset` inputs, predeclared `gate` checks,
immutable `run` attempts, receipt-backed `evidence`, and reviewed `report` conclusions. Small,
Medium, and Large all synchronize with the selected target, verify and report the composed head, and
require explicit promotion. Literature-only synthesis or theorem proving needs a different
customized semantic model.

## Profile manifest

`.koni/profile.yaml` is the semantic entry point. The bundled Coding baseline declares:

```yaml
schema_version: "2.0"
engine: ">=0.1,<0.2"

profile:
  id: software
  version: 0.8.0
  description: Evidence-guided vertical software delivery with risk-adaptive, compiler-current proof

initialization:
  root_node_type: objective
  goal_field: outcome
  planning_context_field: planning_context
  planning_seed_operation: initialization.objective.seed-approved-plan
  root_status: active

git:
  enabled: true
  backend: git_cli
  integration_branch: current
  ticket_branch_template: koni/runs/{{ run.id }}/tickets/{{ ticket.id }}/cycles/{{ cycle.id }}
  worktree_root: .koni-worktrees
  integration_strategy: squash
  commit_template: "{{ ticket.operation }}: {{ ticket.title }}"

orchestration:
  max_parallel: 5
  max_boundaries_per_lead: 1
  disjoint_scope_parallelism: true

context:
  expansion_max_depth: 2
  expansion_max_nodes: 32
  expansion_max_calls_per_step: 4
  expansion_max_response_bytes: 65536
  note_max_bytes: 4096
  note_max_calls_per_step: 16
  notes_max_bundle_bytes: 32768

reporting:
  bundle_kind: report-bundle

imports:
  graph: [graph.yaml]
  rules: [rules.yaml]
  operations: [operations.yaml]
  workflows: [workflows.yaml]
  actions: [actions.yaml]
  checks: [checks.yaml]
  personas: [personas.yaml]
  reports: [reports.yaml]
  cockpit: [cockpit.yaml]
  lifecycles: [lifecycle.yaml]
```

Authority state is always owner-only control-plane data beneath the authenticated Git common
directory. Artifact paths are fixed parts of the native authority and compiler protocol. Profiles do
not configure storage. See [Runtime and Git](runtime-and-git.md).

Profile orchestration retains `max_parallel`, `disjoint_scope_parallelism`, and the currently fixed
`max_boundaries_per_lead: 1` qualitative-judgment bound. Starting and stopping the authority, and
pausing and resuming runs, are explicit operator and lifecycle actions. Stale process ownership is
proved by native process identity rather than elapsed profile time. Compiler convergence is an exact
native protocol rather than a configurable pass count.

`reporting.bundle_kind` names the profile's compiled report bundle and is part of its stable report
identity. It defaults to the domain-neutral `report-bundle`. Domain profiles can choose an explicit
contract name such as `research-ledger-bundle` without teaching the engine about that domain.

`initialization.planning_seed_operation` names a compiler-only operation. Its existing-root and
new-node allowances are the complete authority envelope for an approved planning seed. It cannot
carry a workflow, checks, review or receipt effects, deletion, gates, change control, or recovery
behavior. The presence of planning stages plus their terminal typed output determines whether the
profile must provide this operation. Profiles that omit it keep the ordinary root-only
initialization path. Planners still cannot set lifecycle status or compiler-owned fields.

### Context policy

`context` owns hard runtime limits for graph-backed agent context. The values shown above are the
defaults:

| Field                          | Bounds                                                        |
| ------------------------------ | ------------------------------------------------------------- |
| `expansion_max_depth`          | Maximum traversal depth for one graph expansion               |
| `expansion_max_nodes`          | Maximum nodes selected for one expansion                      |
| `expansion_max_calls_per_step` | Maximum distinct `graph_context` calls by one worker step     |
| `expansion_max_response_bytes` | Maximum serialized expansion response                         |
| `note_max_bytes`               | Maximum UTF-8 body size for one note                          |
| `note_max_calls_per_step`      | Maximum distinct `record_note` calls by one worker step       |
| `notes_max_bundle_bytes`       | Maximum advisory note material included in one context bundle |

Agents may request less than these limits but cannot raise them. The compiler also enforces absolute
safety caps when validating a profile.

## Primitive families

Every imported definition has a stable `id`. IDs are public interfaces within the profile. Rules
refer to selectors and checks, tickets refer to operations, operations refer to workflows, workflow
steps refer to personas and actions, and reports refer to state surfaces.

### Graph

Graph modules define:

- **node types**: required fields, statuses, descriptions, and allowed edges
- **edge types**: source and target types, cardinality, canonical or bidirectional traversal,
  inverse display aliases, and ownership meaning
- **state machines**: states, terminal states, allowed transitions, and actors

Descriptions are part of the agent contract. Explain what a node represents, what it does not
represent, and which evidence changes its state.

A bidirectional edge stores one fact. Author only the configured canonical direction and expose the
reverse through `inverse`. Do not persist a second reciprocal edge. Use two directed relations only
when they are genuinely independent facts that may diverge. Canonical and bidirectional metadata
defines when one stored fact may be traversed from either side.

#### Collection constraints

Node fields can declare three compiler-enforced collection relationships. They are optional, so
profiles that omit them keep their existing behavior.

```yaml
fields:
  covered_paths:
    type: list
    items: { type: path }
  source_paths:
    type: list
    items: { type: path }
    disjoint_from: spec.covered_paths
  oracle_cases:
    type: list
    unique_by: id
    items:
      type: object
      properties:
        id: { type: string, required: true }
        seam_paths:
          type: list
          items: { type: path }
          subset_of: spec.covered_paths
```

- `subset_of` applies to a list of `string` or `path` values and names a compatible root field on
  the same node. String membership is exact. Path membership uses normalized project-relative
  spelling. Constraints may be declared on nested object or list fields while still referring to the
  node's root field.
- `disjoint_from` has the same declaration shape. String identity is exact. Path authority overlaps
  on equality, on ancestor or descendant containment, and when existing paths resolve to the same
  filesystem object. Symlinked components fail closed. Missing descendants under one existing
  directory are compared conservatively across case and Unicode normalization, so an alias cannot
  gain authority before it is materialized.
- `unique_by` applies to a list of objects and names one direct, declared, required scalar property
  on each item. Duplicate values are rejected. The diagnostic reports a count without echoing
  potentially sensitive values.

Validation consults live filesystem identity for existing paths and conservatively protects
unresolved case and normalization aliases. The same rule is reapplied before ticket admission, so a
path alias materialized after compilation revokes stale authority instead of reaching a worktree
lease.

### Ticket context and graph notes

The compiled ticket document retains its graph closure, ticket, contracts, dependency outputs,
review data, persona, and steering. It also includes three living-spec projections:

- `spec_slice`: the reviewed typed nodes and relations relevant to the ticket
- `intent_updates`: applicable user and Lead steering
- `working_memory`: bounded advisory notes attached to visible graph nodes

These projections are additive, bounded context layers. They do not replace dependency outputs,
workflow or review contracts, or the ticket's compiler-issued authority.

Ticket target, read, and write node IDs are mandatory anchors. A missing anchor fails context
compilation instead of disappearing from a smaller slice. Anchors consume the budget first. The run
root stays visible when space permits but is not expanded into unrelated root siblings. Raw approved
`graph_seed` input is replaced in model context by its materialized marker, hash, and node and edge
counts, because the typed graph is the durable specification.

The intact compiled document is the schema `1.0` compatibility path. It applies to graph authors,
gate analysis, reviewers, unscoped Lead and observer reads, and any ambiguous step. A selected
schema `1.1` `product_execution` step may use compact JSON only when graph mutation is forbidden, no
gate-policy or gate-query contract was selected, and the compiler issued concrete file or
compiled-check authority. Pending compiler-transition rework also falls back to `1.0`, because its
repair instruction requires the complete graph mutation intent.

The compiler validates and hashes the complete mandatory-anchor spec slice before presentation.
Duplicate graph bodies, materialized planner prose, graph-authoring schemas, operational lease
state, and raw review bindings may be projected away. Selected step and check scope, exact
dependency outputs, steering, rework and acceptance, typed graph state, and source hashes remain. A
required exact section that exceeds the inline budget pages rather than being truncated.

The authority order is the pinned contracts and reviewed typed graph, then applicable explicit
steering, then advisory working memory. Receipt-bound accepted outputs remain evidence under those
contracts. Working memory does not change a node, ticket scope, operation, acceptance condition, or
gate.

Note kinds are `observation`, `implementation_detail`, `rationale`, `nit`, and `open_question`.
Records carry `working`, `confirmed`, `superseded`, or `invalidated` state, plus run, ticket, step,
persona, and time provenance. New agent and CLI notes begin as `working`. `supersedes` preserves the
prior record while marking that record superseded. Note state alone never promotes prose into
semantic authority.

Working-memory bundles prioritize newest `working` and `confirmed` records. They do not spend their
byte budget on superseded or invalidated history. Each included record reports whether its captured
node revision is current, stale, missing, or from a legacy unbound note. Stale notes stay visible as
advisory history, never as current graph fact.

Ticket workers receive two bounded runtime broker tools:

- `graph_context` reads a relation-filtered, direction-filtered, type-filtered, and depth-filtered
  neighborhood anchored inside the compiler-issued ticket scope.
- `record_note` appends one advisory note to a node in the bounded ticket neighborhood.

Neither capability expands filesystem or graph-write scope. Each successful call creates a compiler
receipt, and the broker binds those supplement receipts to the worker's eventual structured output.

The context-first and receipt-binding contracts are enforced at the broker compare-and-swap
boundary, not only stated in the worker prompt. A new non-context worker call is rejected until
`context` succeeds. A successful output submission closes new supplement calls, so no later receipt
can fall outside its frozen output. Exact durable receipt replay stays available without repeating
an effect.

### Selectors and rules

Selectors identify graph targets through node type, status, fields, traversal, policy applicability,
receipt state, or set operations. Predicates use structured operators such as:

- `all`, `any`, and `not`
- field presence or equality, and edge counts
- `exists` and `for_all` over a bound selector
- set equality, subset, and disjointness
- current receipt and filesystem-manifest checks
- gate-policy selection and satisfaction

Rules combine a selector and predicate with an effect. Common effects derive a ticket, update
program state, or reconcile a terminal condition. Configuration cannot embed arbitrary executable
expressions.

### Ticket constructors and operations

A ticket constructor defines the deterministic title, operation, target, dependencies, and context
scope for an unmet rule. Operations define what that ticket may change:

```yaml
operations:
  - id: architecture.package.define-interface
    operation: define-interface
    stage: architecture
    target_types: [package]
    workflow: architecture-change
    allowed_new_node_types: [interface, decision]
    allowed_existing_node_types: [package]
    allow_node_deletion: false
    change_control_barrier: false
    review_contract: pre-commit architecture transition review
    output_contract: bounded interface graph delta and structured outputs
    dispatch_priority: 700
    ranking_hints: [stage, package-id, interface-gap]
```

Keep allowed node types and filesystem scope as narrow as the transition permits. Use a
`single_flight_group` or a change-control barrier for work that must not overlap.

Upstream change control is an operation role, not an untyped extension. The safe default is an
ordinary operation that cannot request upstream work. A profile opts ordinary operations in and
routes them to exactly one proposal operation. That proposal names its contract-producing step and
the only application and disposition operations it may select:

```yaml
operations:
  - id: delivery.ordinary
    operation: deliver
    change_control:
      role: ordinary
      allow_upstream_requests: true
      proposal_operation: change-request

  - id: lifecycle.change-request
    operation: change-request
    workflow: change-request
    allowed_new_node_types: []
    allowed_existing_node_types: []
    change_control:
      role: proposal
      proposal_step: propose-change
      application_operations: [apply-change-request, no-op]

  - id: lifecycle.apply-change-request
    operation: apply-change-request
    change_control: { role: application }

  - id: lifecycle.no-op
    operation: no-op
    allowed_new_node_types: []
    allowed_existing_node_types: []
    change_control: { role: disposition, outcome: no_op }
```

An enabled ordinary output may submit `upstream_change_request: {target_nodes, summary, reason}` for
existing nodes inside its complete ticket scope. The configured proposal step submits
`change_application: {operation, target_nodes, summary}` and must emit no graph or filesystem delta.

A passed review binds the exact proposal output. The compiler then records its approval hash and
deterministically creates either one application ticket or a terminal no-op disposition. Application
agents receive the bound request and approval in their compiler-issued context. The approval binds
the exact Lead or human steering event, including ID, normalized event hash, actor, and time, plus
the proposal output and passed review. A later approval before work starts invalidates the earlier
review. Once a proposal worktree is active, a later approval is audit-only and cannot replace its
authority.

Change-control authority stays in typed operation roles, compiled workflow and ticket state,
approvals, and barriers. `change_control.working_spec_owner` remains supported, because run
compilation resolves it to exactly one managed persona. No display label may rename lifecycle
authority.

Set `change_control_barrier: true` on ordinary operations whose complete context must not overlap an
active proposal or application write scope. The scheduler and every guarded action recheck those
barriers against canonical integration state, including from already-issued ticket worktrees.

On terminal rejection, no-op, or application, a tracked source worktree is not discarded. The
compiler validates dirty paths against its ticket scope, checkpoints the superseded attempt, records
the exact commit under a deterministic run-owned archive ref, and retires the old checkout and
branch. It then issues the same source ticket fresh if its deriving gap remains. Run deletion
preserves or deletes those archive refs according to its selected branch mode.

### Workflows and personas

Workflows are step DAGs:

```yaml
workflows:
  - id: architecture-change
    applies_to: [define-interface]
    review_failure_reopen_from: work
    steps:
      - id: work
        persona: architect
        depends_on: []
        expected_output: interface decision and bounded graph delta
        graph_mutation: required
        validation_action: compile-ticket
        required_receipts: [context-pack, structured-output, scoped-compile]
      - id: integrate
        kind: integration
        persona: integrator
        depends_on: [work]
        expected_output: integrated bounded transition
      - id: review
        kind: review
        persona: reviewer
        depends_on: [integrate]
        required_receipts: [review-receipt]
```

The scalar `review_failure_reopen_from` is the legacy one-domain compatibility form. New workflows
that need to distinguish selected-step correction from an upstream authority defect declare
`review_failure_routes` instead. The two forms cannot be combined.

Each domain includes a nonempty `description` and either
`{disposition: reopen, reopen_from: <non-review-step>}` or
`{disposition: block, recovery: replan_from_clean_integration, recovery_instructions: <text>}`. The
compiler publishes only those domain IDs to the Reviewer. It requires schema-1.1 output with
`failure_domain: none` on pass, or one advertised domain on failure, and it persists the choice in
review provenance. A block route preserves the rejected candidate and never turns its mutated
worktree into the baseline for upstream replanning. Persisted schema-1.0 reviewer history stays
readable and keeps the older bounded rework behavior.

`graph_mutation` is a compiler-enforced step boundary, not a prompt hint. It is `allowed` by default
for compatibility, `forbidden` for analysis-only steps, or `required` when the step must submit a
nonempty semantic delta. This lets a workflow keep inspection and authoring separate even when both
use the same persona. The compiler does not retroactively reinterpret pinned workflows.

Personas connect domain roles to instructions, agent resources, skills, model policy, and capability
policy:

```yaml
personas:
  - id: reviewer
    agent: koni-reviewer
    skills: [model-koni-work]
    model_role: reviewer
```

The direct Pi host receives only compiler-issued tools. It cannot load ambient extensions.

### Actions and effects

Actions are named recipes made from engine primitives. They may create or remove worktrees, issue
context, run a persona, validate output, reconcile a scoped graph, request review, checkpoint state,
integrate, and report. Each primitive declares its effect, and compilation rejects unsafe sequences.

Configured command invocations are argv arrays, never shell strings. Declare the working directory,
environment allowlist, timeout, result protocol, retry policy, accepted exit codes, and receipt
type.

`expected_exit_codes` defaults to `[0]` when omitted, which preserves the exact historical contract
for old and pinned profiles. Declare a nonzero code only for an intentional outcome such as an
expected-red test. The configured set and the actual exit are compiler-bound receipt data, not an
agent assertion that any failure was acceptable.

A configured command runs inside one owned Unix process group, and its evidence is finite by
construction. Stdout and stderr each retain a bounded diagnostic prefix with a full-stream hash,
observed-byte count, retained-byte count, and explicit truncation state. Their cumulative retained
bytes are bounded as well. A truncated expected-nonzero attempt cannot qualify as intentional
evidence. Typed stdout and configured result files are limited to 1 MiB and reject oversize input
explicitly. Timeout, stop, output-read failure, setup failure, wait failure, and a leader that exits
while same-group helpers remain all converge on bounded TERM and KILL cleanup before the receipt or
error returns.

### Checks and gates

`command` checks execute an explicit argv, or a command resolved from an authorized ticket or node
field. `graph` checks evaluate a structured predicate. Results can be validated with JSON Schema and
an acceptance field:

```yaml
checks:
  - id: unit-tests
    kind: command
    applies_to: [implement-package]
    argv: [npm, run, test]
    cwd: .
    timeout_seconds: 900
    expected_exit_codes: [0]
    result_protocol: process-exit.v1
    receipt_type: test.receipt
    effect: read_only
    environment:
      inherit: [PATH, HOME, TMPDIR]
    retry_policy:
      max_attempts: 1
      transient_exit_codes: []
      backoff_seconds: []
```

Commands in a project profile must come from that repository's CI, task runners, manifests, or
maintained instructions. The bundled Coding profile does not assume a package manager, dependency
install command, typecheck, or lint command. Add those checks during customization only when the
project owns them. Keep setup and dependency mutation out of read-only verification.

Expected-red checks are one proof strategy, not a universal prerequisite. They should resolve their
argv from a graph-backed change or proof contract, use a distinct receipt type, and be required by
the workflow step that authors the test.

Set `receipt_freshness: historical` on that read-only command. Its integrity, ticket binding, exact
command, accepted exit code, and explicit step-output reference stay mandatory, while later
intentional product edits may make its filesystem snapshot stale. Historical receipts cannot carry
result-protocol or artifact evidence and are never treated as current graph evidence. A later green
check should resolve the same argv with exit code `0` and keep the default
`receipt_freshness: current`. This makes command identity, ordering, exit class, and receipt
freshness a compiler-verifiable causal chain rather than an agent-authored claim.

Review reads the selected proof's `baseline_check_id`, `expected_signal`, `why`, conditions, and
explicit `not_proven` limits. The compiler binds its exact command, working directory, source
manifest, covered paths, and receipt. Custom profiles migrating to this model must remove every
duplicate command and oracle field coherently rather than letting two authorities drift.

A characterization strategy binds a passing pre-change observation and proves it stays intact. A
current-verification strategy records why an existing check already covers the bounded outcome, runs
it before the edit without test churn, and requires a fresh passing result afterward.

#### Graph-selected proof sets

An opt-in composite `graph_set` check resolves every relevant proof member deterministically through
a finite target-anchored selector:

```yaml
checks:
  - id: promotion-proof-set
    kind: composite
    applies_to: [implement-package]
    receipt_type: proof_set
    graph_set:
      members:
        traverse:
          from: $target
          relation: verified_by
          min_depth: 1
          max_depth: 1
          node_types: [proof]
      member_node_types: [proof]
      member_check: proof-command # xor member_check_field
      source_paths_field: spec.source_paths
      covered_paths_field: spec.covered_paths
      working_directory_field: spec.working_directory
      status_excluding: [superseded]
      min_members: 1
```

The selector must be target-anchored, relation-explicit, and finite. Set operations are permitted
only when every branch retains that anchor. Global node, query, ID, and policy selectors are
rejected. `member_check_field`, when used, must be a typed nonempty enum of registered read-only
command checks. Literal and field-selected children must cover every parent operation. Selected
members must already be ticket-readable, and both path lists must fit the effective step read
authority.

Multi-target selection is the deduplicated union of the same selector evaluated once per target
anchor. Explicit workflow-step `read_scope` and `write_scope` selectors compile to step-local node
authority. Proof traversal, including intermediate nodes, cannot leave the effective step read
scope.

`source_paths` identify the exact proof, test, and harness bytes that make the receipt causal.
`covered_paths` identify the product subject. They do not grant write authority and are not a claim
of observed coverage. Compilation persists the sorted source and check members, plus parent,
selector, anchors, semantic node, child check, argv, working directory, and path hashes. Todo
tickets may refresh. Active tickets retain their set, and runtime currentness requires exact
reselection.

A directly named project-local interpreter script is causal source even when it is mode `0644` and
has no shebang. It must appear in that member's `source_paths` as well as its read authority.
Graph-set members reject `env` command wrappers and shell `-c` or `--command` strings, because those
forms can hide repository dependencies from the exact argv and path contract. Inline programs for
non-shell interpreters stay permitted, because their bytes are already bound directly in argv.

A green workflow step may declare `preserve_source_paths_from: baseline-step`. The baseline must be
a transitive dependency, and both sides must expose one compatible set. Different child check IDs
are allowed for expected-red versus green exit classification only when source node, resolved argv,
working directory, source paths, covered paths, and execution policy otherwise match. Runtime
compares only the exact source-file manifest. Covered product bytes are expected to change.

Rules name the composite parent:

```yaml
{op: check_passed, subject: $proof, check: promotion-proof-set}
{op: check_has_current_terminal, subject: $proof, check: promotion-proof-set,
 statuses: [failed, timed_out, invalid_result]}
```

The newest exact terminal is authoritative and never falls back to an older pass. Mechanical command
status stays receipt evidence. Semantic node status still requires the profile's reviewed effect.

Composite `receipt_type` readiness is non-vacuous, so all exact latest members must qualify.
Historical baseline checks must declare `historical`, and preserving green checks must declare
`current`. The common submit-then-compile worker ordering binds a generated historical receipt to
the already-durable step output ID and hash. Receipt-dependent target-state leaves may be deferred
only at that output boundary. Graph facts stay strict, and the complete predicate is re-evaluated
before review and acceptance.

#### Cross-ticket preparation binding

A profile may ask whether an exact reviewed proof-only preparation stays current without freezing
the covered product bytes:

```yaml
op: proof_preparation_current
subject: $proof
check: baseline-proof-set
preparation_operation: assurance.proof.prepare
preparation_targets:
  union:
    - $proof
    - { traverse: { from: $proof, relation: verifies, max_depth: 1 } }
```

The predicate binds the configured operation, exact target universe, review, composite member, proof
semantics and oracle, argv, working directory, profile, and compiler-recorded `source_paths`
manifest. It intentionally permits `covered_paths` to change. Proof-source or semantic drift returns
false and should re-emit preparation.

For a preparation or establishment ticket that already pins the exact proof plus contextual
subjects, a composite selector may use `members: $target` with `member_node_types: [proof]`. Global,
query, and ID selector roots stay forbidden, and all normal cardinality and read-scope checks still
apply. This direct form prevents a shared subject from pulling an unpinned sibling proof into the
set.

Within one emitted workflow, a writable graph-set proof source must come from the exact selected
member's configured `source_paths_field` projection. Ticket emission rejects equality or containment
in either direction between that source authority and any other write grant. It also rejects
ambiguous and invalid projections. `covered_paths` stay read-only metadata.

An operation declaring `proof_source_preparation_check` may emit only exact compiler-selected
`source_paths_field` projections for that declared check. Literal, broad, root, disjoint product,
sibling, undeclared-source, and different-check writes are all refused. The compiler persists that
capability, and lease admission revalidates it against the complete ticket plus explicit step write
scopes before an existing lease can be reused. Exact same operation, check, source, and path
re-preparation is the sole overlap exception.

Review admission does not claim the currentness fact early, because that fact cannot exist until the
independent review is durable. It first proves that the matching declared preparation leaf is the
only deferred target-state dependency. It then separately proves the exact operation, check, and
target universe, one required compiled baseline set, current step output, every historical member
execution and source-only manifest, the independent reviewer dependency, and the prospective
configured review effect. Any missing, substituted, stale, or extra component fails closed. Failed
review creates no preparation binding. Ordinary target evaluation stays mandatory after the passed
review is persisted, and again at finish.

Current source selects the newest reviewed attempt by exact preparation operation registry ID plus
compiled source node, before any caller-specific target filter. The predicate and the global source
lock consume the same choice, so a newer failed, stale, or differently targeted attempt cannot
reveal an older pass to only one consumer.

A preparation may stay current after a later review changes one of its effect-owned values, but only
through a strictly ordered, value-acyclic chain of exact configured review-effect applications. Each
link replays its stable review boundary, canonical historical input and raw receipts, actor,
candidates, pre-snapshots and post-snapshots, application hash, and durable reviewer result.
Disjoint effects are not successor links. An overlapping missing, forged, manually drifted, cyclic,
future, or archived link fails closed. `prior_cycles` stay audit-only, and returning to an earlier
projection requires a new preparation attempt.

A full compile authenticates that typed preparation and successor set once against its immutable
graph and ticket epoch. It then shares the exact slice between every rule predicate and
prepared-source write-admission check. Graph-dependent preparation truth is cached only by the
graph's complete normalized identity, because generic selectors may read an excluded field. Every
exact derived graph gets its own binding scan.

The immutable ticket and receipt source evidence beneath those scans is indexed once across the
whole derivation pass, under the exact state-root, tickets-directory, and receipts-directory
identity. Change-control reconciliation ends that source epoch. Final emission and prepared-source
write admission then share a fresh post-reconciliation slice. Projected, prospective, and historical
resolver boundaries use their own local reentrant evidence epoch, including the strict replay
cutoff, without sharing graph results.

#### Gates and composed replay

Gate policies select an applicable verifier deterministically and bind its receipt to the exact
target and current inputs. A model's assertion that a check passed is never equivalent to a gate
receipt.

Target-bound runs replay every current read-only command check selected by a closed ticket after
target synchronization. A side-effecting or intentionally non-repeatable command must declare
`composed_replay: never`. Otherwise the composed-verification stage fails closed rather than
executing it implicitly. That opt-out does not make its receipt stale or historical. The workflow
must also select a distinct repository-owned read-only currentness and integrity check, so promotion
stays bound to fresh proof of the composed tree.

### Reports and cockpit views

Reports project runs, tickets, graph nodes, receipts, and state into JSON, YAML, Markdown, or CSV
artifacts. Cockpit views define human-facing graph hierarchy, preferred parent relationships,
reverse-edge labels, run-card sections, actions, and orchestration bindings.

Presentation configuration may choose what to show, but it cannot alter the underlying runtime
state.

## Retired configuration keys

Current profiles reject the following keys. Upgrades archive the old value, then remove it.
Already-admitted runs keep their immutable historical snapshots.

| Retired key                                                          | Reason                                                                                  |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `planning.session_scope`                                             | One fresh contained Pi session per planning attempt. Reuse is not configurable          |
| `planning.graph_seed_stage`                                          | The ordered planning prefix and its terminal output already determine the seed producer |
| `storage` and all of its paths                                       | Authority state is always owner-only data beneath the Git common directory              |
| `semantic_hash_excludes`                                             | Exact normalized graph identity is the only graph cache authority                       |
| `filesystem_scope_excludes`                                          | Never implemented by the native authority                                               |
| `orchestration.running`                                              | Starting and stopping the authority is an explicit operator action                      |
| `orchestration.lease_stale_seconds`                                  | Stale ownership is proved by native process identity                                    |
| `orchestration.max_fixpoint_passes`                                  | Compiler convergence is an exact native protocol                                        |
| `change_control.awaiting_approval_state`                             | Change-control authority lives in typed operation roles                                 |
| `change_control.held_source_state`                                   | Same as above                                                                           |
| `proposal_only`, `requires_approved_change_hash`, `disposition_only` | Legacy untyped extension keys                                                           |
| `baseline_signal`, `proof.owned_paths`                               | The proof contract is the sole executable and evidence authority                        |

Persona transport fields also changed. `codex_agent` became `agent`, `reasoning_effort` became
`thinking_level`, and sandbox fields became capabilities.

## Authoring workflow

The recommended workflow is:

1. Describe the desired behavior using the `configure-koni` skill.
2. Review and explicitly approve its repository-grounded semantic proposal.
3. Let the skill apply the approved project-resource changes.
4. Run `koni config validate --root .`.
5. Open Configure with `koni tui`, inspect the guided fields, and make small adjustments.
6. Save the draft with `Ctrl-S`, then validate and publish the complete set with `Ctrl-P`.

Configure keeps saved drafts distinct from publication. It publishes all staged edits only after
complete catalog and profile validation. Raw YAML edits may normalize formatting and do not preserve
comments. Renaming an ID does not automatically rewrite references. Stage those reference edits in
the same transaction.

Authoring and execution use `.koni`, provider-neutral agents, repository skills, and the contained
direct-Pi path.

Validate from automation with:

```sh
koni config validate --root . --json
```

## Compatibility

`schema_version: '2.0'` and the declared engine range are required boundaries. Public package and
profile protocols are versioned, and profile upgrades preserve project overlays. Pin the executable
version in CI and review release notes before upgrading.

Fresh initialization establishes the current schema. Historical readers remain for older snapshots.
Production never falls back to a retired transport.
