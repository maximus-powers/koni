# Configuration reference

A Köni project has three configuration layers:

1. the **project catalog** lists selectable run types;
2. a **run type** defines how one kind of run is planned and supervised;
3. the **profile** defines the graph, rules, tickets, workflows, and evidence
   model shared by every run type.

All Köni-native configuration is YAML beneath `.codex/koni/`. Codex project
settings and custom agents remain TOML, and repository skills remain
`SKILL.md` bundles.

## Directory contract

```text
.codex/
├── config.toml
├── agents/
│   ├── lead.toml
│   └── reviewer.toml
└── koni/
    ├── project.yaml
    ├── run-types/
    │   ├── small.yaml
    │   ├── medium.yaml
    │   └── large.yaml
    ├── profile.yaml
    ├── graph/
    ├── lifecycle/
    ├── rules/
    ├── operations/
    ├── workflows/
    ├── actions/
    ├── checks/
    ├── personas/
    ├── reports/
    └── cockpit/
.agents/
└── skills/
    └── configure-koni/
```

Files may be consolidated instead of split by directory; `profile.yaml`
declares every imported module. Paths must remain within the configuration
root after canonical resolution. Duplicate IDs, dangling references, unknown
fields, invalid cycles, and unsafe action ordering fail validation.

## Project catalog

`.codex/koni/project.yaml` answers: “Which kinds of runs can this project
create?”

```yaml
schema_version: "1.0"
project:
  id: my-project
  title: My project
  description: Graph-first software delivery
default_run_type: medium
run_types:
  - id: small
    path: run-types/small.yaml
  - id: medium
    path: run-types/medium.yaml
  - id: large
    path: run-types/large.yaml
```

`default_run_type` and every catalog ID must resolve to exactly one run-type
document. The `id` inside that document must match its catalog entry. Catalog
order is the presentation order in the TUI.

Every listed run type is a complete peer. Large does not layer on Medium at
runtime, and a custom `ui-feature` type is not a modifier applied to another
type.

## Run types

A run type owns intake, pipeline, question policy, Git namespace, role policy,
and orchestration behavior:

```yaml
schema_version: "1.0"
id: medium
title: Medium
description: Plan, implement, and verify normal project work.

instructions:
  planning: |
    Surface at most two decisions that materially change scope,
    architecture, safety, or verification. Record assumptions otherwise.

profile:
  source: .codex/koni/profile.yaml

intake:
  fields:
    goal:
      label: Goal
      description: Describe the outcome Köni should deliver.
      type: text
      required: true
  order: [goal]

pipeline:
  stages:
    intake:
      kind: action
      title: Validate intake
      config: {compiler_owned: true, action: planning.intake}
    plan:
      kind: planning
      title: Plan architecture, implementation, and risk
      config: {persona: run-planner, prompt: Produce a bounded plan.}
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
      config: {checkpoint: verification}
    report:
      kind: action
      title: Compile final report
      config: {action: report, automatic: true}
  order: [intake, plan, approval, initialize, orchestrate, verify, report]

questions:
  policy: high_impact_only
  default_scope: run

git:
  branch_template: "koni/runs/{{ run.slug }}-{{ run.short_id }}"
  ticket_branch_template: "koni/runs/{{ run.id }}/tickets/{{ ticket.id }}"

run_card:
  sections: [goal, pipeline, graph, tickets, checks, report]

agents:
  roles:
    planner: {model: gpt-5.6-sol, reasoning_effort: xhigh}
    lead: {model: gpt-5.6-sol, reasoning_effort: xhigh}
    ticket_worker: {model: gpt-5.6-terra, reasoning_effort: high}
    reviewer: {model: gpt-5.6-terra, reasoning_effort: xhigh}
  personas: {}

orchestration:
  auto_start: true
  max_parallel: 3
  compile_action: compile
  lead_action: spawn-lead
  report_action: report
```

### Intake

`intake.fields` is keyed by a stable field ID, and `intake.order` must name
every field exactly once. Supported types are:

- `string`, `text`, and `path`;
- `boolean`, `integer`, and `number`;
- `choice` and `multi_choice`, with a non-empty duplicate-free
  `options` list;
- `json`.

Defaults must match their declared type. The common `goal` field appears once
in the new-run dialog; additional fields render in configured order.

### Pipeline

`pipeline.stages` is keyed by stable stage ID, and `pipeline.order` must name
every stage exactly once. Supported stage kinds are:

| Kind | Meaning |
| --- | --- |
| `action` | Execute a configured or compiler-owned action |
| `planning` | Run a bounded Codex planning pass |
| `approval` | Require explicit operator approval |
| `initialize` | Seed pinned semantic state |
| `orchestration` | Compile and supervise ticket work |
| `checkpoint` | Verify or confirm a durable boundary |
| `manual` / `handoff` | Wait for explicit operator completion |
| `external_loop` | Drive a configured external provider state machine |

Only the consecutive compiler-owned intake and planning prefix may execute
before approval. A planning stage beyond that boundary is rejected.

### Questions

Question policies are:

- `autonomous`: select the recommendation for agent-raised questions;
- `high_impact_only`: pause for high-impact decisions and auto-select routine
  recommendations;
- `interactive`: pause for valid questions.

The planning instructions control what the model should ask; the structured
policy controls pause behavior. Questions require at least two unique choices
and exactly one recommendation. Non-pausing resolution never invents an
answer.

### Agent resolution

The supported role keys are `planner`, `lead`, `ticket_worker`, and
`reviewer`. Effective model, reasoning, instructions, and permissions resolve
in this order:

1. one-run overrides;
2. pipeline-stage overrides;
3. run-type persona overrides;
4. run-type role defaults;
5. profile persona values;
6. referenced native Codex agent values;
7. runtime defaults.

The resolved result is pinned. A future edit cannot silently change an active
run.

### Orchestration

`max_parallel` is a positive upper bound. Dependencies, overlapping scope,
single-flight groups, and change-control barriers may reduce actual
parallelism. `auto_start` allows supervision to begin after approval; it does
not remove the approval boundary.

## Profile manifest

`.codex/koni/profile.yaml` is the semantic entry point:

```yaml
schema_version: "1.0"
engine: ">=0.1.0,<0.2.0"

profile:
  id: software
  version: "1.0.0"
  description: Architecture-first software delivery.

initialization:
  root_node_type: project
  goal_field: goal
  planning_context_field: planning_context
  root_status: active

storage:
  backend: git_common_dir
  graph_dir: graph
  tickets_dir: tickets
  work_dir: work
  state_path: state.yaml
  reports_dir: reports
  receipts_dir: receipts
  semantic_hash_excludes: [annotations]
  filesystem_scope_excludes: [node_modules, target, .next, coverage]

git:
  enabled: true
  backend: libgit2
  integration_branch: main
  ticket_branch_template: "koni/ticket/{{ ticket.id }}"
  worktree_root: .worktrees
  integration_strategy: squash
  commit_template: "{{ ticket.operation }}: {{ ticket.title }}"
  commit_trailers:
    Koni-Ticket: "{{ ticket.id }}"
    Koni-Profile: "{{ profile.hash }}"
    Koni-Review: "{{ review.id }}"

orchestration:
  running: true
  max_parallel: 8
  lease_stale_seconds: 1800
  max_fixpoint_passes: 8
  max_boundaries_per_lead: 1
  disjoint_scope_parallelism: true

reporting:
  bundle_kind: report-bundle

imports:
  graph: [graph/nodes.yaml, graph/edges.yaml]
  rules: [rules/software.yaml]
  operations: [operations/software.yaml]
  workflows: [workflows/software.yaml]
  actions: [actions/software.yaml]
  checks: [checks/software.yaml]
  personas: [personas/software.yaml]
  reports: [reports/software.yaml]
  cockpit: [cockpit/software.yaml]
  lifecycles: [lifecycle/tickets.yaml]
```

`storage.backend` controls where mutable semantic state lives. Use `tracked`
when graph and ticket records are product artifacts; use `git_common_dir`
when they are control-plane state that should stay out of the product tree. See
[Runtime and Git](runtime-and-git.md).

`reporting.bundle_kind` names the profile's compiled report bundle and is
included in its stable report identity. It defaults to the domain-neutral
`report-bundle`; domain profiles can choose an explicit contract name such as
`research-ledger-bundle` without teaching the engine about that domain.

## Primitive families

Every imported definition has a stable `id`. IDs are public interfaces within
the profile: rules refer to selectors and checks, tickets refer to operations,
operations refer to workflows, workflow steps refer to personas and actions,
and reports refer to state surfaces.

### Graph

Graph modules define:

- **node types**: required fields, statuses, descriptions, and allowed edges;
- **edge types**: source and target types, cardinality, inverse display, and
  ownership meaning;
- **state machines**: states, terminal states, allowed transitions, and actors.

Descriptions are part of the agent contract. Explain what a node represents,
what it does not represent, and which evidence changes its state.

### Selectors and rules

Selectors identify graph targets through node type, status, fields, traversal,
policy applicability, receipt state, or set operations. Predicates use
structured operators such as:

- `all`, `any`, and `not`;
- field presence/equality and edge counts;
- `exists` and `for_all` over a bound selector;
- set equality/subset/disjointness;
- current receipt and filesystem-manifest checks;
- gate-policy selection and satisfaction.

Rules combine a selector and predicate with an effect. Common effects derive a
ticket, update program state, or reconcile a terminal condition. Configuration
cannot embed arbitrary executable expressions.

### Ticket constructors and operations

A ticket constructor defines the deterministic title, operation, target,
dependencies, and context scope for an unmet rule. Operations define what that
ticket may change:

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

Keep allowed node types and filesystem scope as narrow as the transition
permits. Use a `single_flight_group` or change-control barrier for work that
must not overlap.

Upstream change control is an operation role, not an untyped extension. The
safe default is an ordinary operation that cannot request upstream work. A
profile opts ordinary operations in and routes them to exactly one proposal
operation; that proposal names its contract-producing step and the only
application/disposition operations it may select:

```yaml
change_control:
  awaiting_approval_state: awaiting_decision
  held_source_state: waiting_upstream

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
    change_control: {role: application}

  - id: lifecycle.no-op
    operation: no-op
    allowed_new_node_types: []
    allowed_existing_node_types: []
    change_control: {role: disposition, outcome: no_op}
```

An enabled ordinary output may submit
`upstream_change_request: {target_nodes, summary, reason}` for existing nodes
inside its complete ticket scope. The configured proposal step submits
`change_application: {operation, target_nodes, summary}` and must emit no graph
or filesystem delta. A passed review binds the exact proposal output; the
compiler then records its approval hash and deterministically creates either
one application ticket or a terminal no-op disposition. Application agents
receive the bound request and approval in their compiler-issued context. The
approval binds the exact Lead/human steering event (ID, normalized event hash,
actor, and time), proposal output, and passed review. A later approval before
work starts invalidates the earlier review; once a proposal worktree is active,
a later approval is audit-only and cannot replace its authority.

Both configured state names must be distinct nonterminal states in the ticket
state machine. Compiler-authorized transitions must connect awaiting approval
to the initial state, active work to the held-source state, and held source back
to initial. The engine never requires those states to be named `proposed` or
`blocked`.

Set `change_control_barrier: true` on ordinary operations whose complete
context must not overlap an active proposal/application write scope. The
scheduler and every guarded action recheck those barriers against canonical
integration state, including from already-issued ticket worktrees. Legacy
extension keys `proposal_only`, `requires_approved_change_hash`, and
`disposition_only` are rejected.

On terminal rejection, no-op, or application, a tracked source worktree is not
discarded. The compiler validates dirty paths against its ticket scope,
checkpoints the superseded attempt, records the exact commit under a
deterministic run-owned archive ref, retires the old checkout/branch, and then
issues the same source ticket fresh if its deriving gap remains. Run deletion
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

Personas connect domain roles to instructions, native Codex agents, skills,
model policy, and sandbox policy. Prefer `codex_agent` for installed projects:

```yaml
personas:
  - id: reviewer
    codex_agent: koni-reviewer
    skills: [model-koni-work]
    model_role: reviewer
```

### Actions and effects

Actions are named recipes made from engine primitives. They may create or
remove worktrees, issue context, run a persona, validate output, reconcile a
scoped graph, request review, checkpoint state, integrate, and report. Each
primitive declares its effect; compilation rejects unsafe sequences.

Configured command invocations are argv arrays, never shell strings. Declare
the working directory, environment allowlist, timeout, result protocol, retry
policy, and receipt type.

### Checks and gates

`command` checks execute an explicit argv or a command resolved from an
authorized ticket/node field. `graph` checks evaluate a structured predicate.
Results can be validated with JSON Schema and an acceptance field:

```yaml
checks:
  - id: unit-tests
    kind: command
    applies_to: [implement-package]
    argv: [cargo, test, --workspace]
    cwd: .
    timeout_seconds: 900
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

Gate policies select an applicable verifier deterministically and bind its
receipt to the exact target and current inputs. A model's assertion that a
check passed is never equivalent to a gate receipt.

### Reports and cockpit views

Reports project runs, tickets, graph nodes, receipts, and state into JSON,
YAML, Markdown, or CSV artifacts. Cockpit views define human-facing graph
hierarchy, preferred parent relationships, reverse-edge labels, run-card
sections, actions, and orchestration bindings.

Presentation configuration may choose what to show, but it cannot alter the
underlying runtime state.

## Authoring workflow

The recommended workflow is:

1. describe the desired behavior to Codex using an installed Köni skill;
2. review the proposed resource changes;
3. run `koni validate-profile .`;
4. open Configure with `koni`, inspect the guided fields, and make small
   adjustments;
5. save once to publish the whole validated draft.

Configure publishes all staged edits only after complete catalog/profile
validation. Raw YAML edits may normalize formatting and do not preserve
comments. Renaming an ID does not automatically rewrite references; stage
those reference edits in the same transaction.

Validate from automation with:

```sh
koni validate-profile .
koni validate --root .
```

The first validates configuration. The second also validates the selected
run's current graph, tickets, and receipts without deriving new work.

## Compatibility

The `schema_version: "1.0"` and engine range are required boundaries, but Köni
is pre-1.0. Pin the executable version in CI and review release notes before
upgrading. Legacy configuration is handled through the explicit
[migration flow](migration.md); do not maintain two live layouts.
