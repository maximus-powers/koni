# Configuration reference

> **Pi-native lifecycle evolution — 2026-07-16 (`profile_lifecycle_migration`):** The schema-1
> paths and historical transition notes below remain valuable migration context. Current
> TypeScript Core installs one verified immutable profile baseline beneath `.koni`, treats the
> materialized project tree as an upgrade-safe overlay, and exposes source-SHA-CAS structured YAML
> edits to the shared control center. It never edits Pi's settings, credentials, or ambient
> resources. See [Pi-native profile lifecycle](profile-lifecycle.md) and
> [Pi community resource bindings](pi-community-resource-bindings.md).

> **Community-resource compiler binding — 2026-07-16 (`community_resource_integration`):**
> `resources/pi-packages.yaml` is now part of the authenticated compiled configuration rather than
> a side catalog. Enabled autonomous entries require exact `select.skills`, `select.prompts`, or
> Koni-owned `select.tools` values plus stage/persona eligibility. Selected bytes are copied and
> hash-bound per run and per launch; ambient Pi files and extension code are never inherited.
> Existing Pi settings and package state are read-only and remain user-owned. See the linked
> binding reference for the fail-closed modes and network rule.

A Köni project has three configuration layers:

1. the **project catalog** lists selectable run types;
2. a **run type** defines how one kind of run is planned and supervised;
3. the **profile** defines the graph, rules, tickets, workflows, and evidence
   model shared by every run type.

All Köni-native configuration is YAML beneath `.codex/koni/`. Codex project
settings and custom agents remain TOML, and repository skills remain
`SKILL.md` bundles.

> **Pi/schema 2 transition in progress — 2026-07-14 (`pi_product_docs_transition`):** The
> configuration contract below remains executable for schema-1 projects and readable for pinned
> historical runs. The unreleased schema-2 target moves live configuration and provider-neutral
> agent YAML beneath `.koni/`, retains `.agents/skills/`, and uses the direct Pi host described in
> [Direct Pi runtime](pi-runtime.md). A migrated project has no Codex fallback. Cutover remains
> gated by exact schema-field migration, ancestor-symlink and publication/crash safety,
> compiler-issued active-run archival, historical readers, and the unresolved credential-TCB
> decision between a Rust-owned allowlisted auth proxy and a signed/pinned host dependency closure.
> Pi artifact/teardown/protocol/token security and one frozen cross-project verification matrix
> also remain gates.

> **Release-candidate supersession — 2026-07-14 (`pi_product_docs_transition`):** The preceding
> unreleased/undecided status is historical. Current source is the schema-2/direct-Pi release
> candidate for macOS, with `.koni` as its live root and no production Codex fallback. The accepted
> first-cut credential TCB is the exact Köni Rust binary, bundled Pi host, pinned Pi SDK 0.80.7
> dependency closure, and official pinned Node 22.19.0 runtime; Node has no compiler-tool, graph,
> Git, receipt, or project-file authority. Linux login/inference fail closed until a destination-
> allowlisted egress broker exists. Installation and live migration remain separate guarded
> operator actions, and protected forensic Updog state authorizes neither.

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

> **Directory transition in progress — 2026-07-14 (`pi_product_docs_transition`):** The tree
> above is the schema-1 layout, not a second live layout that will coexist after migration. Schema
> 2 publishes one complete `.koni/` tree only after its staged catalog/profile and provider-neutral
> agents compile. It must preserve unrelated `.codex` content and old snapshot readers, reject
> redirected ancestors, and recover every interrupted rename before this directory transition may
> be called shipped; see [Direct Pi runtime](pi-runtime.md).

> **Directory-transition supersession — 2026-07-14 (`pi_product_docs_transition`):** Current
> release-candidate source closes the staged-compilation, no-follow publication, recovery,
> archival, and historical-reader matrix above. `.koni/` is the one live schema-2 tree; unrelated
> `.codex` content remains untouched. Publishing it into an existing project still requires the
> explicit guarded migration transaction rather than an implicit refresh.

## Project catalog

`.codex/koni/project.yaml` answers: “Which kinds of runs can this project
create?”

> **Catalog-path transition in progress — 2026-07-14 (`pi_product_docs_transition`):** That path
> remains authoritative for schema 1. The schema-2 catalog lives under `.koni/` and is activated
> only by the explicit migration transaction; historical schema-1 catalogs remain readable but
> cannot start new work after cutover, and no Codex execution fallback exists. Catalog discovery,
> ownership conversion, active-run archival, and rollback/recovery fixtures remain release gates
> in [Direct Pi runtime](pi-runtime.md).

> **Catalog-path supersession — 2026-07-14 (`pi_product_docs_transition`):** Those catalog,
> conversion, archival, and recovery gates are now green for the current release candidate.
> `.koni/project.yaml` is the schema-2 live catalog root; schema-1 catalogs remain historical
> readers after migration and cannot supply a Codex fallback. Existing projects change roots only
> through the separately authorized migration command.

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

> **Software catalog evolution — 2026-07-14:** The statement above describes the original three
> base types and remains the rule for combining behaviors at run time. Software 0.4 additionally
> ships `new-feature` and `bug-fix` as source-level derivatives of `medium`: ordered JSON-Pointer
> overrides specialize intake, planning instructions, and concurrency, then catalog compilation
> resolves each into one complete immutable run type. They are selectable alternatives, never
> stackable modifiers. Research retains only Small, Medium, and Large.

> **Software 0.4 transition status — 2026-07-14:** “Ships” above records the accepted catalog
> contract and staged templates, not a completed integration handoff. The five types resolve and
> the bundled profile compiles in isolation; final release still waits for the focused Software
> behavior gate and the generic graph-set authority review. Existing installed and pinned
> profiles remain unchanged until installation or a separately approved coherent migration.

> **Current integration-status transition — 2026-07-14:** The sentence above remains the staged
> pre-review checkpoint. The scoped graph-TDD contract has since passed its generic 6/6 suite and
> independent review, but that does not release the whole compiler or Software profile. Current
> gates are review-effect input/configured-runtime provenance, proof-source/production-write
> separation, cross-ticket preparation identity, exact ticket-pinned member selection, pre-merge
> ticket-worktree currentness, the expanded Software matrix and independent design disposition,
> the Pi/schema-2 cutover matrix, and one final immutable fingerprint. Installed/pinned projects
> remain unchanged until an explicit migration transaction.

> **Gate narrowing — 2026-07-14 (`pi_product_docs_transition`):** The broad active-gates list
> above remains the causal snapshot. Current source closes the review-effect P1s, exact pinned-
> member selection, canonical ticket-worktree/root evaluation, and same-ticket proof-source/write
> separation. Cross-ticket preparation provenance and emission/lease admission remain under
> adversarial review, and the complete Software matrix, Pi/schema-2 matrix, and final immutable
> fingerprint remain active. These narrower closures do not authorize installation or migration.

## Run types

A run type owns intake, pipeline, question policy, Git namespace, role policy,
and orchestration behavior:

> **Bounded direct-Pi planning transition — 2026-07-15:** The original example below records the
> token-only shape. Current run types may additionally set
> `planning.max_repository_tool_calls` from 1 through 256. The compiler counts read, list, and
> search calls together; the final allowed result terminates exploration and a second
> schema-constrained turn synthesizes in the same live Pi session with repository tools closed.
> Omission remains a legacy-compatible 32 calls, while newly installed Software
> Small/Medium/Large profiles use 16/24/48. Direct-Pi planning also bounds complete plan prose to
> 24,000 characters and the local output allowance to 16,384 tokens. These are compiler/runtime
> bounds, not an unsupported provider request parameter; the model must return a dense plan without
> repeating the goal, supplied source material, repository excerpts, or schema.

> **Reasoning-aware output transition — 2026-07-15:** Live Medium acceptance showed that the
> 16,384-token local allowance above also counted hidden reasoning, so a compliant visible plan
> could be discarded after several minutes of synthesis. Current source keeps the 24,000-character
> plan bound, adds a 96 KiB bound over the complete visible JSON artifact, and reserves 32,768 local
> output tokens for visible content plus hidden reasoning. This does not add an unsupported provider
> parameter or invite longer plans; it separates the user-visible artifact bound from provider
> reasoning accounting. An overrun now preserves the completed transcript and exact billed usage,
> then pauses with the fixed `runtime_output_limit` diagnosis.

```yaml
schema_version: "1.0"
id: medium
title: Medium
description: Plan, implement, and verify normal project work.

instructions:
  planning: |
    Surface at most two decisions that materially change scope,
    architecture, safety, or verification. Record assumptions otherwise.

planning:
  session_scope: run
  graph_seed_stage: plan
  token_budget:
    metric: new_tokens
    limit: 1000000
    synthesis_reserve: 200000
    on_exhausted: force_synthesis

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
| `target_sync` | Merge the current target head into the isolated run branch |
| `promotion` | Await exact operator authorization, then advance the target branch |
| `manual` / `handoff` | Wait for explicit operator completion |
| `external_loop` | Drive a configured external provider state machine |

> **AI-stage transport transition in progress — 2026-07-14 (`pi_product_docs_transition`):** The
> `planning`/Codex wording above remains the schema-1 executable behavior. Schema 2 introduces the
> provider-neutral `ai` stage and compiles existing Planner, Lead, Worker, and Reviewer intents to
> the same direct Pi runtime without weakening their compiler policies. This is not shipped until
> the Rust session/turn/tool state machine, exactly-one terminal handling, fail-closed teardown,
> enforceable token contract, and complete host/CLI/TUI/profile matrix pass; see
> [Direct Pi runtime](pi-runtime.md).

> **AI-stage supersession — 2026-07-14 (`pi_product_docs_transition`):** The current source
> release candidate passes the named runtime and frozen integration matrix. `ai`, Planner, Lead,
> Worker, and Reviewer all use the single contained Pi path with compiler-owned cumulative output
> budgeting and no production Codex fallback. Networked execution is supported on macOS; the same
> stages fail closed on Linux until allowlisted outbound egress is available.

Only the consecutive compiler-owned intake and planning prefix may execute
before approval. A planning stage beyond that boundary is rejected.

> **Evolving to — 2026-07-14:** The pre-approval prefix rule above is retained.
> A run type may now designate its final planning stage as the sole producer of
> an approved typed graph seed; this adds a reviewed semantic artifact without
> moving planning or graph publication past the approval boundary.

### Planning runtime

`planning.session_scope` controls Codex context reuse. `run` keeps consecutive
planning stages and question resumes in one thread, so architecture, risk, and
verification passes reuse the same repository evidence. `stage` is supported
for a run type with one planning stage; a multi-stage planning prefix must use
`run` to avoid disconnected or double-counted context.

> **Planning-session transition in progress — 2026-07-14 (`pi_product_docs_transition`):** The
> session semantics and durable reuse rule remain part of the target contract, but schema 2 owns
> the conversation/event log in the Köni Pi host rather than a Codex session. Pinned schema-1
> sessions stay readable and are never resumed under Pi. Release still requires canonical event
> ordering, request/turn correlation, cancellation/terminal cleanup, honest token accounting, and
> historical transcript projection on one frozen fingerprint.

> **Planning-session supersession — 2026-07-14 (`pi_product_docs_transition`):** Those event,
> lifecycle, budget, reader, and frozen-fingerprint requirements are now closed in the release
> candidate. Schema-2 planning uses a Köni-owned Pi session; migrated Codex sessions are archived
> history and are never resumed or used as fallback. This source status alone does not migrate an
> installed project.

The token budget is compiler-owned and cumulative for that planning session.
`new_tokens` counts `input - cached_input + output`; reasoning tokens are
already included in output and are not added twice. `processed_tokens` counts
the full input-plus-output total. At `limit - synthesis_reserve`, Köni steers
the planner to stop investigation and synthesize. If it continues spending,
`force_synthesis` interrupts that turn and resumes the same thread with tools
disabled. The full planning text remains durable for compilation and ticket
execution; the TUI approval dialog presents a short operator-facing projection.

> **Superseded by — 2026-07-14:** “Short operator-facing projection” described
> the former condensed approval surface. Review Plan now keeps the complete
> human-readable plan reachable through wrapping and scrolling, while still
> excluding raw transcript noise and internal runtime metadata.

> **Projection correction — 2026-07-16:** The previous note collapsed approval review and durable
> plan inspection into one surface. The approval modal intentionally shows the planner-authored
> concise `review` items (individual headings plus descriptions). It does not replace, truncate,
> or synthesize headings from the full artifact. After approval, Details' Plan tab renders every
> successful full planning-pass body as scrollable Markdown for continued inspection and retains
> the bounded/redacted Graph Seed. Compilation and execution always consume the full durable plan.

`planning.graph_seed_stage` optionally names the final planning stage. That
stage must return a typed `graph_seed` alongside its complete prose plan; every
other planning stage returns no seed. The seed uses `$root` for the existing
run root, stable plan-local keys for proposed nodes, and separate `root_spec`,
`nodes`, and `edges` collections. Köni assigns persistent IDs, resolves the
local references, and validates the result against the pinned graph schema and
the profile's `initialization.planning_seed_operation` before approval can
succeed. Initialization publishes the validated root and seed as one atomic
state change, so tickets begin from the reviewed specification rather than
reconstructing it from planning prose.

> **Transition in progress — 2026-07-14:** Seed publication is compiler-backed,
> but the ordinary Review Plan does not yet render its bounded semantic
> projection. The accepted UI contract shows root enrichment, node
> type/title/purpose, titled relationships, counts, and omitted counts without
> internal IDs, hashes, paths, or raw `spec` payloads.

> **Transition completed — 2026-07-14:** Review Plan now conditionally adds the
> bounded Graph Seed section, and the approved Plan reuses the same projection;
> seedless plans retain the earlier three-section view. It shows at most six
> root facts, twelve semantic nodes, and sixteen titled relationships with
> exact omitted counts. Adversarial coverage also prevents relationships from
> revealing omitted nodes and suppresses local keys, IDs, hashes, UUIDs,
> paths, storage/schema metadata, and raw `spec` content, including wrapped,
> prefixed, or embedded forms. The released approval suite passed 25/25 after
> that hardening; the earlier visibility handoff's full TUI suite passed
> 279/279. The integrated tree after the adversarial projection and unrelated
> evidence/runtime truthfulness follow-ups passes the full TUI suite 288/288.

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

In the control center, reusable role defaults belong to the Run Types domain.
The Agents domain intentionally shows shared Codex personas, prompts,
permissions, and skills without duplicating Small/Medium/Large model rows.

> **Persona-resolution transition in progress — 2026-07-14 (`pi_product_docs_transition`):** The
> seven-layer resolution and Codex-persona editor remain authoritative for schema-1 projects.
> Schema 2 replaces `codex_agent`/`reasoning_effort`/sandbox transport fields with provider-neutral
> `agent`/`thinking_level`/capabilities while retaining the same override precedence and compiler
> authority. Field conversion is limited to schema-owned locations, and cutover remains gated by
> migration preservation fixtures, historical readers, Pi containment/credential intent, and the
> frozen CLI/TUI/profile matrix; see [Direct Pi runtime](pi-runtime.md).

> **Persona-resolution supersession — 2026-07-14 (`pi_product_docs_transition`):** The current
> release candidate closes those preservation, containment, credential-intent, and frozen-matrix
> gates. Schema-2 resolution uses provider-neutral agent fields and the same compiler precedence;
> its pinned host/SDK/Node credential TCB gains no graph, Git, receipt, or project-file authority.
> Existing schema-1 persona resources remain unchanged until guarded migration.

### Target-branch promotion

A Git-enabled delivery run normally places `target_sync` after orchestration
and `promotion` last. The run type's promotion policy names the configured
operation used when target synchronization conflicts:

```yaml
promotion:
  conflict_operation: resolve-target-integration
```

That operation should use a workflow whose steps cannot mutate the semantic
graph. Its job is to compose the product trees, preserve functionality from
both sides, and provide fresh verification. Promotion itself is compiler
owned: it requires durable operator authorization bound to the run head,
target branch, and observed target head. A moved target reopens sync; a dirty
checked-out target blocks without moving the ref.

### Orchestration

`max_parallel` is a positive upper bound. Dependencies, overlapping scope,
single-flight groups, and change-control barriers may reduce actual
parallelism. `auto_start` allows supervision to begin after approval; it does
not remove the approval boundary.

## Customize from the installed profile

Every project starts from its selected Software, Research, or explicit custom
profile. Customize that installed profile in place; it is the baseline for the
project's semantic language. Köni does not currently layer a generated project
overlay over a hidden bundled baseline, and customization should not recreate
the default from memory.

> **Transition proposed — 2026-07-14:** In-place customization is the current
> shipped contract and remains the compatibility path for existing installs and
> pinned runs. A queued design would retain a versioned bundled baseline plus a
> project-owned overlay so upgrades and local intent can be compared explicitly;
> no generated overlay or migration behavior is implemented yet.

Use the installed `configure-koni` skill for substantial changes. Before it
writes, it should inspect repository instructions, manifests, CI, tests,
architecture and interfaces, verification commands, Git/promotion behavior,
and—when relevant—datasets, metrics, baselines, ablations, seed policy, and
artifact reporting. It classifies important facts as observed, inferred, or
missing and asks only questions whose answers change ontology, ticket scope,
authority, proof, or publication.

The agent then presents one approval packet containing the retained baseline,
proposed nodes and canonical relations, rule → operation → workflow mapping,
proof and receipt policy, run/agent changes, exact files, assumptions, and
validation plan. Explicit approval of that design is required before project
configuration is edited. Profile changes affect future resolved snapshots;
they do not rewrite an active run.

> **Customization-skill schema-2 correction — 2026-07-14:** The proposal/approval contract above
> is unchanged, but the shipped skills now discover `.koni/project.yaml` first, resolve each run
> type's actual `profile.source`, validate the resolved manifest, and configure provider-neutral
> `.koni/agents/*.yaml` through `agent`, `thinking_level`, and `capabilities`. They inspect
> `.codex/koni`, `.codex/agents`, `reasoning_effort`, and `sandbox` only for an unmigrated schema-1
> project and refuse to mix two live roots. `operate-koni` likewise treats `.koni` as initialized
> instead of mistaking every schema-2 project for a fresh install.

### Bundled semantic foundations

The Software profile starts with an `objective`, maps the repository into
`system`, `interface`, `data_model`, `contract`, and end-to-end `flow` nodes,
then compiles missing work into dependency-ordered `change`, `migration`,
`decision`, `risk`, and `proof` nodes. Reviewed `delivery` nodes compose the
accepted work. A change selects `red_green`, `characterization`, or
`current_verification`; the selected rule pins a distinct operation and
workflow. The compiler determines the baseline kind, command/exit contract,
write scope, receipts, and review boundary. The authored `baseline_signal`
still carries domain meaning, so independent review must reject a failure or
pass produced for the wrong reason unless the project configures a structured
result protocol for that meaning. Repository-specific setup, test, typecheck,
lint, integration, and smoke commands are discovered during project
customization rather than assumed by the default.

> **Software foundation evolution — 2026-07-14:** The ontology above is retained, but Software
> 0.4 no longer emits architecture and contract work unconditionally. The approved seed records
> the smallest sufficient existing boundary; missing material boundaries compile focused mapping
> tickets, while known local work proceeds as one objective-facing vertical claim. Routine changes
> need focused proof; elevated and critical changes add boundary proof and structural risk
> disposition. Bug fixes carry expected/observed behavior and may compile one diagnosis ticket
> before implementation when localization is honestly unresolved. Reviewed delivery is
> `candidate_ready`; target sync, composed verification, and promotion remain compiler-owned.

> **Software 0.4 proof-path transition — 2026-07-14:** The implementation profile is still under
> final integration review. Its current direction makes linked proof nodes the sole executable
> baseline/promotion authority and lets the implementation verifier plus independent review close
> those exact proofs, avoiding a second routine proof ticket. Standalone, stale, legacy, and
> recovery proof work still uses `proof.establish`. Treat this as in progress until the focused
> behavior suite and generic receipt/source-authority gates are green.

> **Software 0.4 final profile contract — 2026-07-14:** The two paragraphs above remain the
> historical design and integration checkpoints. The frozen profile removes authored
> `baseline_signal`, change/migration test-command duplicates, and `proof.owned_paths`; a proof's
> `baseline_check_id`, exact argv `command`, `source_paths`, read-only `covered_paths`, contained
> working directory, conditions, expected signal, `why`, and `not_proven` are the sole executable
> and evidence authority. An unresolved defect first receives one defect-only diagnostic proof,
> source-only preparation, and reviewed diagnosis; no speculative addressing change is seeded.
> Routine implementation is now `establish-baseline -> implement with compiler-run promotion set
> -> independent review`, with no duplicate Verifier or Integrator hop. Diagnostic and
> risk-boundary proofs use the conditional `proof.prepare` lane; boundary green execution waits
> for every introducing subject and control. `prepared` records reviewed preparation-time evidence,
> while cross-ticket source-byte currentness remains a separately recorded generic compiler gate.

> **Software 0.6 implementation-proof preparation — 2026-07-16:** The 0.4 paragraph above remains
> design history. The bundled default now sends every red-green and characterization focused proof
> through the same source-only preparation and independent oracle-completeness review before its
> change or migration becomes implementation-ready. The implementation ticket can re-run that
> baseline but cannot write the reviewed proof source, so ordinary final-review rework stays at the
> product `implement` step. Current-verification remains read-only and emits no authoring
> preparation ticket; diagnostic and risk-boundary routing is unchanged.

The Research profile is deliberately empirical. It decomposes a `hypothesis`
into falsifiable `claim` nodes, prior `literature`, executable `experiment` and
`ablation` designs, explicit `method` and `metric` contracts, versioned
`prerequisite`/`asset` inputs, predeclared `gate` checks, immutable `run`
attempts, receipt-backed `evidence`, and reviewed `report` conclusions. Small,
Medium, and Large all synchronize with the selected target, verify and report
the composed head, and require explicit promotion. Literature-only synthesis
or theorem proving needs a different customized semantic model rather than an
unearned empirical conclusion.

## Profile manifest

`.codex/koni/profile.yaml` is the semantic entry point:

> **Manifest-path transition in progress — 2026-07-14 (`pi_product_docs_transition`):** This is
> the schema-1 semantic entry point and remains valid for its pinned readers. Schema 2 uses the
> corresponding `.koni` manifest and refuses ambiguous catalog/profile discovery; it is published
> only after full staged compilation, authoritative active-run archival, ownership-safe retirement
> of legacy resources, and recoverable atomic migration. A migrated project executes Pi only.

> **Manifest-path supersession — 2026-07-14 (`pi_product_docs_transition`):** Full staged
> compilation, active-run archival, ownership-safe retirement, and recoverable publication now pass
> for current release-candidate source. `.koni` is authoritative only after fresh schema-2 init or
> explicit migration; an installed schema-1 project is not silently converted, and a migrated
> project has no Codex fallback.

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
  planning_seed_operation: initialization.project.seed-approved-plan
  root_status: active

context:
  expansion_max_depth: 2
  expansion_max_nodes: 32
  expansion_max_calls_per_step: 4
  expansion_max_response_bytes: 65536
  note_max_bytes: 4096
  note_max_calls_per_step: 16
  notes_max_bundle_bytes: 32768

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

> **Illustrative manifest history — clarified 2026-07-14.** The block above is a broad schema
> walkthrough retained from an earlier architecture-first Software sketch; its `project` root,
> `1.0.0` version, and example import names are not the bundled Software 0.3 or evolving 0.4
> baseline and should not be copied as that profile. The installed profile's compiled source is
> authoritative for its current `objective` root, version, modules, and seed operation. The field
> explanations below remain valid for profiles that declare those fields.

`storage.backend` controls where mutable semantic state lives. Use `tracked`
when graph and ticket records are product artifacts; use `git_common_dir`
when they are control-plane state that should stay out of the product tree. See
[Runtime and Git](runtime-and-git.md).

`reporting.bundle_kind` names the profile's compiled report bundle and is
included in its stable report identity. It defaults to the domain-neutral
`report-bundle`; domain profiles can choose an explicit contract name such as
`research-ledger-bundle` without teaching the engine about that domain.

`initialization.planning_seed_operation` is optional. When present, it names a
compiler-only operation whose existing-root and new-node allowances are the
complete authority envelope for an approved planning seed. It cannot carry a
workflow, checks, review or receipt effects, deletion, gates, change control,
or recovery behavior. A run type that sets `planning.graph_seed_stage` must use
a profile with this operation; profiles and run types that omit both retain the
ordinary root-only initialization path.

> **Evolving to — 2026-07-14:** Earlier profiles initialized only their root
> node. That path remains the compatibility behavior when both seed settings
> are absent. Seed-enabled profiles extend initialization with the exact
> operator-reviewed, profile-bounded semantic seed; planners still cannot set
> lifecycle status or compiler-owned fields.

### Context policy

`context` owns hard runtime limits for graph-backed agent context. The values
shown above are the defaults:

| Field | Bounds |
| --- | --- |
| `expansion_max_depth` | Maximum traversal depth for one graph expansion |
| `expansion_max_nodes` | Maximum nodes selected for one expansion |
| `expansion_max_calls_per_step` | Maximum distinct `graph_context` calls by one worker step |
| `expansion_max_response_bytes` | Maximum serialized expansion response |
| `note_max_bytes` | Maximum UTF-8 body size for one note |
| `note_max_calls_per_step` | Maximum distinct `record_note` calls by one worker step |
| `notes_max_bundle_bytes` | Maximum advisory note material included in one context bundle |

Agents may request less than these limits but cannot raise them. The compiler
also enforces absolute safety caps when validating a profile.

## Primitive families

Every imported definition has a stable `id`. IDs are public interfaces within
the profile: rules refer to selectors and checks, tickets refer to operations,
operations refer to workflows, workflow steps refer to personas and actions,
and reports refer to state surfaces.

### Graph

Graph modules define:

- **node types**: required fields, statuses, descriptions, and allowed edges;
- **edge types**: source and target types, cardinality, canonical or
  bidirectional traversal, inverse display aliases, and ownership meaning;
- **state machines**: states, terminal states, allowed transitions, and actors.

Descriptions are part of the agent contract. Explain what a node represents,
what it does not represent, and which evidence changes its state.

A bidirectional edge stores one fact. Author only the configured canonical
direction and expose the reverse through `inverse`; do not persist a second
reciprocal edge. Use two directed relations only when they are genuinely
independent facts that may diverge.

> **Evolving to — 2026-07-14:** The former general contract said edge types
> define “source and target types, cardinality, inverse display, and ownership
> meaning.” That remains the compatibility baseline. Canonical/bidirectional
> metadata now additionally defines when one stored fact may be traversed from
> either side, preventing reciprocal copies from diverging.

#### Collection constraints

Node fields can declare three compiler-enforced collection relationships. They
are optional, so profiles that omit them retain their existing behavior.

```yaml
fields:
  covered_paths:
    type: list
    items: {type: path}
  source_paths:
    type: list
    items: {type: path}
    disjoint_from: spec.covered_paths
  oracle_cases:
    type: list
    unique_by: id
    items:
      type: object
      properties:
        id: {type: string, required: true}
        seam_paths:
          type: list
          items: {type: path}
          subset_of: spec.covered_paths
```

- `subset_of` applies to a list of `string` or `path` values and names a
  compatible root field on the same node. String membership is exact. Path
  membership uses normalized project-relative spelling. Constraints may be
  declared on nested object/list fields while still referring to the node's
  root field.
- `disjoint_from` has the same declaration shape. String identity is exact.
  Path authority overlaps on equality or ancestor/descendant containment and
  also when existing paths resolve to the same filesystem object. Symlinked
  components fail closed. Missing descendants under one existing directory
  are compared conservatively across case and Unicode normalization so an
  alias cannot gain authority before it is materialized.
- `unique_by` applies to a list of objects and names one direct, declared,
  required scalar property on each item. Duplicate values are rejected; the
  diagnostic reports a count without echoing potentially sensitive values.

> **Filesystem-identity hardening — 2026-07-15 (`oracle_final_review`):** Earlier
> Software contracts described path disjointness only as normalized
> project-relative identity. That remains the lexical baseline. Current
> validation additionally consults live filesystem identity for existing paths
> and conservatively protects unresolved case/normalization aliases. The same
> rule is reapplied before ticket admission, so a path alias materialized after
> compilation revokes stale authority instead of reaching a worktree lease.

### Ticket context and graph notes

The compiled ticket document retains its graph closure, ticket, contracts,
dependency outputs, review data, persona, and steering. By default it also
includes three living-spec projections:

> **Evolving to — 2026-07-14:** The existing compiled ticket document remains
> intact. The projections below are additive, bounded context layers; they do
> not replace dependency outputs, workflow/review contracts, or the ticket's
> compiler-issued authority.

- `spec_slice`: the reviewed typed nodes and relations relevant to the ticket;
- `intent_updates`: applicable user and Lead steering;
- `working_memory`: bounded advisory notes attached to visible graph nodes.

> **Resolved default-profile parity — 2026-07-14:** The initial living-spec
> compiler default was additive as described above, but Research still carried
> an explicit pre-transition `include` list and therefore did not inherit the
> three new sections. New bundled Research installs now preserve every legacy
> section (including the separate `steering` alias) and explicitly add all
> three living-spec layers. Existing runs retain their pinned profile snapshot.

> **Spec-slice integrity completion — 2026-07-14:** Ticket target, read, and
> write node IDs are mandatory anchors. A missing anchor now fails context
> compilation instead of disappearing from a smaller slice. Anchors consume
> the budget first; the run root remains visible when space permits but is not
> expanded into unrelated root siblings. Raw approved `graph_seed` input is
> replaced in model context by its materialized marker, hash, and node/edge
> counts because the typed graph is the durable specification.

> **Step-relevant context transport — 2026-07-15:** The intact compiled document
> above remains the schema `1.0` compatibility path for graph authors, gate
> analysis, reviewers, unscoped Lead/observer reads, and any ambiguous step. A
> selected schema `1.1` `product_execution` step may use compact JSON only when
> graph mutation is forbidden, no gate-policy or gate-query contract was
> selected, and the compiler issued concrete file or compiled-check authority.
> Pending compiler-transition rework also falls back to `1.0` because its
> repair instruction requires the complete graph mutation intent.
> The compiler still validates and hashes the complete mandatory-anchor spec
> slice before presentation: duplicate graph bodies, materialized planner prose,
> graph-authoring schemas, operational lease state, and raw review bindings may
> be projected away, while selected step/check scope, exact dependency outputs,
> steering, rework/acceptance, typed graph state, and source hashes remain.
> Seedless legacy planning prose remains because no typed replacement is proven;
> a required exact section that exceeds the inline budget still pages rather
> than being truncated.

The authority order is the pinned contracts and reviewed typed graph, then
applicable explicit steering, then advisory working memory. Receipt-bound
accepted outputs remain evidence under those contracts; working memory does
not change a node, ticket scope, operation, acceptance condition, or gate.
Its note kinds are `observation`, `implementation_detail`, `rationale`, `nit`,
and `open_question`; records carry `working`, `confirmed`, `superseded`, or
`invalidated` state plus run/ticket/step/persona/time provenance. New agent and
CLI notes begin as `working`. `supersedes` preserves the prior record while
marking that record superseded. Note state alone never promotes prose into
semantic authority.

Working-memory bundles prioritize newest `working`/`confirmed` records and do
not spend their byte budget on superseded or invalidated history. Each included
record reports whether its captured node revision is current, stale, missing,
or from a legacy unbound note; stale notes remain visible as advisory history,
never as current graph fact.

Ticket workers receive two bounded runtime broker tools:

- `graph_context` reads a relation-, direction-, type-, and depth-filtered
  neighborhood anchored inside the compiler-issued ticket scope;
- `record_note` appends one advisory note to a node in the bounded ticket
  neighborhood.

Neither capability expands filesystem or graph-write scope. Each successful
call creates a compiler receipt, and the broker automatically binds those
supplement receipts to the worker's eventual structured output.

> **Runtime ordering completion — 2026-07-14:** The context-first and receipt
> binding contracts above are now enforced at the broker CAS boundary, not
> only stated in the worker prompt. A new non-context worker call is rejected
> until `context` succeeds, and a successful legacy `submit_output` closes new
> supplement calls so no later receipt can fall outside its frozen output.
> Exact durable receipt replay remains available without repeating an effect.

Operators can use the same validation paths from the CLI:

```sh
koni graph-context TK-123 \
  --anchor ND-123 --relation depends_on --direction both \
  --max-depth 1 --node-type contract

koni record-note TK-123 \
  --step implement --persona operator --node-id ND-123 \
  --kind implementation_detail --body "The adapter owns retry translation."
```

`graph-context` also accepts repeated `--anchor`, `--relation`, and
`--node-type` values. `record-note` accepts `--supersedes NOTE_ID` for an
append-only correction. The runtime MCP variants omit run, ticket, step, and
persona identity because the compiler pins those values into the worker grant.

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

> **Structured review-failure routing — 2026-07-16:** The scalar
> `review_failure_reopen_from` above remains the legacy one-domain compatibility form. New
> workflows that need to distinguish selected-step correction from an upstream authority defect
> declare `review_failure_routes` instead; the two forms cannot be combined. Each domain includes
> a nonempty `description` and either `{disposition: reopen, reopen_from: <non-review-step>}` or
> `{disposition: block, recovery: replan_from_clean_integration, recovery_instructions: <text>}`.
> The compiler publishes only those domain IDs to the Reviewer, requires schema-1.1 output with
> `failure_domain: none` on pass or one advertised domain on failure, and persists the choice in
> review provenance. A block route preserves the rejected candidate and never turns its mutated
> worktree into the baseline for upstream replanning. Persisted schema-1.0 reviewer history remains
> readable; it retains the older bounded rework behavior.

`graph_mutation` is a compiler-enforced step boundary, not a prompt hint. It is
`allowed` by default for compatibility, `forbidden` for analysis-only steps,
or `required` when the step must submit a nonempty semantic delta. This lets a
workflow keep inspection and authoring separate even when both use the same
persona.

> **Graph-mutation authority transition — 2026-07-14:** Before this field existed, graph-delta
> expectations were implicit in workflow shape and persona instructions; the compiler did not
> distinguish an analysis-only empty result from a missing required mutation. That historical
> prompt/implicit boundary remains the compatibility meaning of an omitted field, which resolves
> to `allowed`. Profiles opt into `forbidden` or `required` explicitly; the compiler does not
> retroactively reinterpret pinned workflows.

Personas connect domain roles to instructions, native Codex agents, skills,
model policy, and sandbox policy. Prefer `codex_agent` for installed projects:

> **Persona-authoring transition in progress — 2026-07-14 (`pi_product_docs_transition`):**
> Prefer `codex_agent` only for the executable schema-1 layout described here. Schema-2 projects
> author provider-neutral agent references beneath `.koni/agents/`; the direct Pi host receives
> only compiler-issued tools and cannot load ambient Codex/Pi extensions. The migration must
> preserve prompt/schema data verbatim outside known fields, and runtime release still depends on
> artifact trust, exact broker wiring, credential intent, and teardown tests.

> **Persona-authoring supersession — 2026-07-14 (`pi_product_docs_transition`):** The artifact,
> broker, credential-intent, teardown, and migration-preservation requirements now pass for the
> release candidate. Schema-2 authoring uses `.koni/agents` and the contained pinned host; ambient
> extensions and Codex fallback remain unavailable. Applying that contract to an installed project
> still requires a separately approved migration.

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
policy, accepted exit codes, and receipt type. `expected_exit_codes` defaults
to `[0]` when omitted. Declare a nonzero code only for an intentional outcome
such as an expected-red test; the receipt records that acceptance contract and
the actual process result.

> **Accepted-exit compatibility transition — 2026-07-14:** Historically every configured command
> accepted exit zero only. Omitting `expected_exit_codes` deliberately preserves that exact `[0]`
> contract for old and pinned profiles. Explicit nonzero acceptance is a later opt-in used for an
> intentional semantic result such as an expected-red proof; the configured set and actual exit
> are compiler-bound receipt data, not an agent assertion that any failure was acceptable.

> **Bounded command-evidence transition — 2026-07-16:** The accepted-exit contract remains, but a
> configured command now runs inside one owned Unix process group and its evidence is finite by
> construction. Stdout and stderr each retain a bounded diagnostic prefix with full-stream hash,
> observed-byte count, retained-byte count, and explicit truncation state; their cumulative
> retained bytes are bounded as well. A truncated expected-nonzero attempt cannot qualify as
> intentional evidence. Typed stdout and configured result files are limited to 1 MiB and reject
> oversize input explicitly. Timeout, stop, output-read/setup/wait failure, and a leader that exits
> while same-group helpers remain all converge on bounded TERM/KILL cleanup before the receipt or
> error returns.

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

Commands in a project profile must come from that repository's CI, task
runners, manifests, or maintained instructions. The bundled Software profile
does not assume a package manager, dependency-install command, typecheck, or
lint command. Add those checks during customization only when the project owns
them, and keep setup or dependency mutation out of read-only verification.

Expected-red checks are one proof strategy, not a universal prerequisite. They
should resolve their argv from a graph-backed change or proof contract, use a
distinct receipt type, and be required by the workflow step that authors the
test. Set `receipt_freshness: historical` on that
read-only command: its integrity, ticket binding, exact command, accepted exit
code, and explicit step-output reference remain mandatory, while later
intentional product edits may make its filesystem snapshot stale. Historical
receipts cannot carry result-protocol or artifact evidence and are never
treated as current graph evidence. A later green check should resolve the same
argv with exit code `0` and retain the default `receipt_freshness: current`.
This makes command identity, ordering, exit class, and receipt freshness a
compiler-verifiable causal chain instead of an agent-authored claim. The
reviewer still judges whether the observed process result has the exact
domain-specific meaning declared in `baseline_signal`. A characterization
strategy instead binds a passing pre-change observation and proves it remains
intact. A current-verification strategy records why an existing check already
covers the bounded outcome, runs it before the edit without test churn, and
requires a fresh passing result afterward.

> **Sole proof-oracle authority — 2026-07-14:** The `baseline_signal` sentence above is retained as
> the earlier ticket-local contract. Current Software does not declare that field. Review reads the
> selected proof's `baseline_check_id`, `expected_signal`, `why`, conditions, and explicit
> `not_proven` limits, while the compiler binds its exact command, working directory, source
> manifest, covered paths, and receipt. Custom profiles migrating to this model must remove every
> duplicate command/oracle field coherently rather than letting two authorities drift.

> **Graph-local proof evolution — 2026-07-14:** The command mapping above remains the compatible
> path for existing profiles and ticket-local baselines. The generic compiler is adding an opt-in
> composite `graph_set` check whose finite target-anchored selector resolves every relevant proof
> member deterministically. Each member binds a registered child check, exact semantic argv,
> project-relative working directory, byte-causal `source_paths`, claimed product
> `covered_paths`, semantic hashes, and the selector/check contract. Runtime must reproduce the
> exact persisted set; current passing and adverse terminal predicates name the composite parent,
> and composed verification safely replays required read-only members after target sync. Software
> 0.4 adopts this contract. Research, Updog, pinned runs, and profiles that omit `graph_set` retain
> the earlier workflow-history behavior.

> **Graph-local proof implementation completed — 2026-07-14:** The transition
> above is now implemented in the generic compiler. A minimal literal-child
> contract is:

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

The selector must be target-anchored, relation-explicit, and finite. Set
operations are permitted only when every branch retains that anchor; global
node, query, ID, and policy selectors are rejected. `member_check_field`, when
used, must be a typed nonempty enum of registered read-only command checks.
Literal and field-selected children must cover every parent operation.
Selected members must already be ticket-readable, and both path lists must fit
the effective step read authority.

`source_paths` identify the exact proof/test/harness bytes that make the
receipt causal. `covered_paths` identify the product subject; they do not grant
write authority and are not a claim of observed coverage. Compilation persists
the sorted source/check members plus parent, selector, anchors, semantic node,
child check, argv, cwd, and path hashes. Todo tickets may refresh; active
tickets retain their set, and runtime/currentness requires exact reselection.

A green workflow step may declare
`preserve_source_paths_from: baseline-step`. The baseline must be a transitive
dependency and both sides must expose one compatible set. Different child
check IDs are allowed for expected-red versus green exit classification only
when source node, resolved argv, cwd, source paths, covered paths, and execution
policy otherwise match. Runtime compares only the exact source-file manifest;
covered product bytes are expected to change.

Rules name the composite parent:

```yaml
{op: check_passed, subject: $proof, check: promotion-proof-set}
{op: check_has_current_terminal, subject: $proof, check: promotion-proof-set,
 statuses: [failed, timed_out, invalid_result]}
```

The newest exact terminal is authoritative and never falls back to an older
pass. Mechanical command status remains receipt evidence; semantic node status
still requires the profile's reviewed effect.

Gate policies select an applicable verifier deterministically and bind its
receipt to the exact target and current inputs. A model's assertion that a
check passed is never equivalent to a gate receipt.

Target-bound runs replay every current read-only command check selected by a
closed ticket after target synchronization. A side-effecting or intentionally
non-repeatable command must declare `composed_replay: never`; otherwise the
composed-verification stage fails closed rather than executing it implicitly.
That opt-out does not make its receipt stale or historical. The workflow must
also select a distinct repository-owned read-only currentness/integrity check,
so promotion is still bound to fresh proof of the composed tree.

> **Graph-local proof hardening transition — 2026-07-14:** The “implementation
> completed” heading above records the first source-complete checkpoint; the
> subsequent integration audit found authority and lifecycle details that are
> now part of the contract. Multi-target selection is the deduplicated union of
> the same selector evaluated once per target anchor. Explicit workflow-step
> `read_scope` and `write_scope` selectors compile to step-local node authority,
> and proof traversal—including intermediate nodes—cannot leave the effective
> step read scope. A project-local executable or shebang script named by a
> member command must appear in that member's `source_paths` as well as its read
> authority.

> **Executable-authority refinement — 2026-07-14:** The “executable or shebang
> script” wording above records the first enforcement boundary. The current
> contract also treats a directly named project-local interpreter script as
> causal source even when it is mode `0644` and has no shebang. Opt-in graph-set
> members reject `env` command wrappers and shell `-c`/`--command` strings,
> because those forms can hide repository dependencies from the exact argv/path
> contract. Inline programs for non-shell interpreters remain permitted: their
> bytes are already bound directly in argv, while separately named project
> scripts must appear in `source_paths`.

> Composite `receipt_type` readiness is non-vacuous: all exact latest members
> must qualify. Historical baseline checks must declare `historical`, preserving
> green checks must declare `current`, and the common submit-then-compile worker
> ordering binds a generated historical receipt to the already-durable step
> output ID and hash. Receipt-dependent target-state leaves may be deferred only
> at that output boundary; graph facts remain strict and the complete predicate
> is re-evaluated before review and acceptance. This note remains marked as a
> transition until the final full-core and independent-review evidence is
> recorded beside it.

> **Cross-ticket preparation binding — 2026-07-14:** A profile may now ask whether an exact
> reviewed proof-only preparation remains current without freezing the covered product bytes:

```yaml
op: proof_preparation_current
subject: $proof
check: baseline-proof-set
preparation_operation: assurance.proof.prepare
preparation_targets:
  union:
    - $proof
    - {traverse: {from: $proof, relation: verifies, max_depth: 1}}
```

> The predicate binds the configured operation, exact target universe, review, composite member,
> proof semantics/oracle, argv, working directory, profile, and compiler-recorded `source_paths`
> manifest. It intentionally permits `covered_paths` to change. Proof-source or semantic drift
> returns false and should re-emit preparation. For a preparation/establishment ticket that already
> pins the exact proof plus contextual subjects, a composite selector may use `members: $target`
> with `member_node_types: [proof]`; global/query/ID selector roots remain forbidden and all normal
> cardinality/read-scope checks still apply. This direct form prevents a shared subject from pulling
> an unpinned sibling proof into the set.

> **Proof-source write separation — 2026-07-14:** Within one emitted workflow, a writable
> graph-set proof source must come from the exact selected member's configured
> `source_paths_field` projection. Ticket emission rejects equality or containment in either
> direction between that source authority and any other write grant, plus ambiguous/invalid
> projections. `covered_paths` remain read-only metadata. The generic compiler does not yet expose
> a typed later-ticket enumeration of earlier preparation bindings, so early rejection of a later
> production grant that aliases a separately prepared source remains an explicit open gate; graph
> status and domain-edge inference are not substitutes.

> **Prepared-source global binding transition in progress — 2026-07-14
> (`pi_product_docs_transition`):** The “does not yet expose” sentence above preserves the first
> released boundary. A typed enumeration of current preparation bindings plus emission- and
> lease-admission overlap checks is now being implemented, but it is not released and Software has
> not consumed it. Release still requires a stable canonical review boundary that survives
> unrelated graph growth, runtime predicate/declaration equality with no-panic validation,
> source-only authority for every preparation operation, the real tracked and Git-common predicate
> matrix, and the complete Software consumer matrix. `prepared` status, profile edges, or prompt
> policy remain insufficient substitutes for compiler-owned provenance and admission.

> **Software consumption status — 2026-07-14:** “Software has not consumed it” above is retained as
> the checkpoint that opened the consumer work. Current bundled Software now exercises typed
> preparation currentness and prepared-source admission through its Bug Fix lifecycle, including
> authenticated `prepared` → `passing` succession and a later overlapping-write rejection. Whole-
> lane release remains held on bounded operation-scoped successor/receipt evaluation and one frozen
> current matrix; mutable proof status or prompt policy still grants no authority.

> **Prepared-source exact-write authority sub-gate — 2026-07-14
> (`proof-preparation-binding`):** The transition above remains unreleased as a whole, but its
> operation-write boundary is now source-closed. An operation declaring
> `proof_source_preparation_check` may emit only exact compiler-selected `source_paths_field`
> projections for that declared check—never literal, broad/root, disjoint product, sibling,
> undeclared-source, or different-check writes. The compiler persists that capability and lease
> admission revalidates it against the complete ticket plus explicit step write scopes before an
> existing lease can be reused. Exact same operation/check/source/path re-preparation is the sole
> overlap exception. Focused evidence is 8/8 preparation, 1/1 cross-ticket conflict, and 2/2
> same-ticket graph-source authority; the historical-review and tracked/Git-common predicate
> matrices named above remain required.

> **Typed preparation first-review admission — 2026-07-14
> (`proof-preparation-binding`):** The cross-ticket transition above creates one intentional
> temporal dependency: its currentness fact cannot exist until the independent review is durable.
> Review admission therefore does not claim that fact early. It first proves that the matching
> declared preparation leaf is the only deferred target-state dependency, then separately proves
> the exact operation/check/target universe, one required compiled baseline set, current step
> output, every historical member execution and source-only manifest, independent reviewer
> dependency, and the prospective configured review effect. Any missing, substituted, stale, or
> extra component fails closed. Failed review creates no preparation binding, and ordinary target
> evaluation remains mandatory after the passed review is persisted and again at finish.

> **Preparation succession and shared-authority transition — 2026-07-14
> (`compiler-graph-tdd`):** The pending global-binding language above remains the history that
> opened this seam. Current source now selects the newest reviewed attempt by exact preparation
> operation registry ID plus compiled source node *before* any caller-specific target filter; the
> predicate and global source lock consume the same choice, so a newer failed, stale, or differently
> targeted attempt cannot reveal an older pass to only one consumer. A preparation may remain
> current after a later review changes one of its effect-owned values only through a strictly
> ordered, value-acyclic chain of exact configured review-effect applications. Each link replays
> its stable review boundary, canonical historical input and raw receipts, actor, candidates,
> pre/post snapshots, application hash, and durable reviewer result. Disjoint effects are not
> successor links; an overlapping missing, forged, manually drifted, cyclic, future, or archived
> link fails closed. `prior_cycles` remain audit-only, and returning to an earlier projection
> requires a new preparation attempt rather than an A→B→A value cycle.

> **Preparation evidence epoch transition — 2026-07-14 (`compiler-graph-tdd`):** A full compile
> authenticates that typed preparation/successor set once against its immutable graph-and-ticket
> epoch, then shares the exact slice between every rule predicate and prepared-source write-
> admission check. Projected ticket, prospective review, integration, and historical replay paths
> remain uncached and retain their ticket-local/cutoff semantics. This closes the sampled repeated
> per-rule receipt scan in source; the final release record still requires the compile-epoch count
> regression and frozen fingerprint to pass after the concurrently moving Pi runtime test target
> compiles.

> **Exact graph/source evidence epoch correction — 2026-07-14
> (`compiler-graph-tdd`):** Preserve the “once” wording above as the first optimization checkpoint,
> but do not interpret `semantic_hash_excludes` as a preparation-cache authority. Generic selectors
> may still read an excluded field. Current source therefore caches graph-dependent preparation
> truth only by the graph's complete normalized identity; every exact derived graph gets its own
> binding scan. The immutable ticket/receipt source evidence beneath those scans is indexed once
> across the whole derivation pass under the exact state-root, tickets-directory, and receipts-
> directory identity. Change-control reconciliation ends that source epoch, and final emission plus
> prepared-source write admission share a fresh post-reconciliation slice. Projected, prospective,
> and historical resolver boundaries use their own local reentrant evidence epoch, including the
> strict replay cutoff, without sharing graph results. Deterministic regressions now prove exact-
> graph invalidation, different-ticket-store separation, one receipt-directory parse per source
> epoch, and the initial Software compile's bounded three graph scans/two source indexes. These
> structural counters, not a wall-clock threshold, close the sampled YAML-rescan failure mode.

### Reports and cockpit views

Reports project runs, tickets, graph nodes, receipts, and state into JSON,
YAML, Markdown, or CSV artifacts. Cockpit views define human-facing graph
hierarchy, preferred parent relationships, reverse-edge labels, run-card
sections, actions, and orchestration bindings.

Presentation configuration may choose what to show, but it cannot alter the
underlying runtime state.

## Authoring workflow

> **Earlier workflow — retained 2026-07-14:** “Describe the desired behavior to
> Codex using an installed Köni skill; review the proposed resource changes; run
> `koni validate-profile .`; open Configure and make small adjustments; save once
> to publish the whole validated draft.”

> **Evolving to — 2026-07-14:** Repository inspection and explicit semantic-
> design approval now precede edits, and Configure separates draft save from
> validated publication. The current six-step workflow below preserves the old
> validate-and-refine intent while making those authority boundaries explicit.

The recommended workflow is:

1. describe the desired behavior to Codex using `configure-koni`;
2. review and explicitly approve its repository-grounded semantic proposal;
3. let the skill apply the approved project-resource changes;
4. run `koni validate-profile .`;
5. open Configure with `koni`, inspect the guided fields, and make small
   adjustments;
6. save the draft with `Ctrl-S`, then validate and publish the complete set
   with `Ctrl-P`.

> **Authoring-surface transition in progress — 2026-07-14 (`pi_product_docs_transition`):** The
> Codex-skill workflow remains the pre-cutover schema-1 authoring path. Schema 2 keeps the same
> repository-owned semantic configuration and `.agents/skills` guidance, but the Köni control
> plane invokes the direct Pi host and provider-neutral agents; it does not start a Codex chat or
> fall back to one after migration. Do not migrate an installed project until field-scoped
> conversion, historical-reader compatibility, security re-review, and the frozen matrix are
> green in [Direct Pi runtime](pi-runtime.md).

> **Authoring-surface supersession — 2026-07-14 (`pi_product_docs_transition`):** Those source
> gates are now green at the release-candidate endpoint. Schema-2 authoring and execution use
> `.koni`, provider-neutral agents, repository skills, and the direct Pi path; Codex remains only a
> schema-1/historical-reader concern. Migration is nevertheless a distinct guarded operator action,
> not a side effect of building or installing the candidate.

Configure keeps saved drafts distinct from publication and publishes all staged
edits only after complete catalog/profile validation. Raw YAML edits may
normalize formatting and do not preserve comments. Renaming an ID does not
automatically rewrite references; stage those reference edits in the same
transaction.

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

> **Compatibility transition in progress — 2026-07-14 (`pi_product_docs_transition`):** The
> schema-1 compatibility boundary above remains live before cutover. Schema 2 is an explicit,
> one-way execution migration with retained audit readers, not a dual-runtime compatibility mode.
> The current Pi implementation is source-in-progress and may not replace installed resources
> until migration recovery/archival and all runtime security and frozen-fingerprint gates pass.

> **Compatibility supersession — 2026-07-14 (`pi_product_docs_transition`):** Current source has
> reached that release-candidate endpoint: migration recovery/archival, runtime security, and the
> locked frozen matrix pass for the documented macOS boundary. There is still no automatic project
> replacement. Fresh initialization or explicit guarded migration establishes schema 2; historical
> schema-1 readers remain, active Codex runs archive permanently, and production never falls back
> to Codex.

## Schema 2 provider-neutral runtime configuration — 2026-07-14

The implemented candidate resolves live project configuration from `.koni/`. Agent files are YAML
under `.koni/agents/` and express instructions, `model`, `thinking_level`, capabilities, and skills;
they cannot carry Codex-native config overrides. Existing planning, ticket-worker, Lead, and
independent-review blocks compile into one typed Pi runtime request, while the generic `ai` stage
allows a profile to use that same primitive without naming a CLI transport.

The provider is intentionally not configurable in schema 2: it is the pinned Pi
`openai-codex` provider authenticated through the ChatGPT subscription OAuth path. Rust continues
to own graph/Git/receipt effects and issues exact tool capabilities; Pi supplies only model loop,
streaming, structured output, and provider integration. `thinking_level: max` is canonical;
`ultra` is accepted only while reading a pre-migration historical snapshot.

Use `koni migrate-pi --dry-run` to inspect the field-scoped conversion before publishing. The
transaction changes known fields such as `codex_agent` → `agent` and `reasoning_effort` →
`thinking_level`; prompt text and unrelated `.codex` resources are not search-and-replaced.
