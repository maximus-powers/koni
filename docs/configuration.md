# Configuration reference

Koni uses Pi’s normal repository configuration as its agent environment. Koni adds orchestration
policy beneath `.koni/`; it does not create a second package, skill, extension, prompt, theme, or
repository-instruction system.

## Repository layout

```text
AGENTS.md                         # ordinary Pi repository instructions
.agents/
└── skills/                       # ordinary cross-agent skills
.pi/
├── settings.json                 # Pi packages and project settings
├── skills/                       # Pi project skills
├── extensions/                   # Pi project extensions
├── prompts/                      # Pi project prompts
└── themes/                       # Pi project themes
.koni/
├── project.yaml                  # selectable run types
├── run-types/
│   ├── small.yaml
│   ├── medium.yaml
│   └── large.yaml
├── agents/                       # Koni overlays for Pi-native agents
│   ├── run-planner.yaml
│   ├── implementer.yaml
│   └── reviewer.yaml
├── profile.yaml                  # graph and orchestration entry point
├── graph.yaml
├── rules.yaml
├── operations.yaml
├── workflows.yaml
├── actions.yaml
├── checks.yaml
├── reports.yaml
├── cockpit.yaml
├── lifecycle.yaml
└── .managed/                     # Koni lifecycle provenance; do not edit
```

Use Pi’s own commands and file conventions to add or remove packages, skills, extensions, prompts,
themes, and repository instructions. Those resources remain immediately usable by ordinary Pi. Koni
resolves that same environment when it creates a run.

`koni init` and `koni update` have one narrow Pi-settings responsibility: they ensure the official
`git:github.com/obra/superpowers` package source is present in `.pi/settings.json`. They preserve
all other settings and package entries. Koni records whether it added that entry. If a Koni-owned
entry is later pinned, filtered, removed, or replaced, update fails with a conflict instead of
overwriting the user’s change.

## Resolution model

Pi remains the source of truth. Koni asks Pi to resolve:

- user and project settings;
- configured Pi packages;
- user, project, and package skills;
- prompts, themes, and extensions;
- `AGENTS.md` repository context.

Koni then applies one agent document as a narrowing overlay. An agent can select a subset of the
resolved packages or resources, but it cannot install a package or introduce a path that Pi did not
resolve. A missing package or unmatched positive filter is a configuration error.

At run creation Koni pins the selected skill bundles, repository context, and configuration hashes.
Later Pi changes affect future runs only. Existing runs continue with their authenticated snapshot.

Extensions need a Koni-owned containment adapter before an autonomous attempt can execute them.
Resolved extensions without an adapter stay visible in diagnostics as `interactive_only / excluded`.
Koni never imports unknown extension code into its authority process.

## Agent documents

Each `.koni/agents/<id>.yaml` file combines a Pi selection with Koni’s orchestration policy:

```yaml
schema_version: "3.0"
id: implementer
description: Implements one compiler-issued ticket.

instructions: |
  Implement the smallest complete change that satisfies the issued contract.
  Verify the result using the checks available in the attempt.

pi:
  provider: openai-codex
  model: gpt-5.6-terra
  thinking_level: high
  tools:
    include: [read, grep, find, ls, write, edit]

koni:
  role: ticket_worker
  capabilities:
    workspace_access: workspace_write
    network_access: false
```

The file name, `id`, and registry key must match. `instructions` is a scalar prompt, not a list of
task-specific rules. Put reusable workflows and expertise in Pi skills; keep the agent instructions
focused on stable role behavior.

The model fields are Pi provider and model identifiers. `provider`, `model`, and `thinking_level`
must be selected together. Run-type role settings and one-run overrides may replace that default.

The safe Pi tool vocabulary is:

```text
read  grep  find  ls  write  edit
```

An agent can exclude tools or select a subset. `bash`, ambient shell tools, lifecycle tools, and
unknown extension tools are rejected. Koni maps admitted work to its contained authority tools; an
agent never receives ambient process or filesystem authority.

### Inheritance

One optional parent is supported:

```yaml
schema_version: "3.0"
id: reviewer
extends: read-only-base
description: Independently reviews one candidate.
instructions: |
  Review the candidate against the complete issued contract and return a precise verdict.

pi:
  settings:
    skills:
      - skills/using-superpowers/**
      - skills/verification-before-completion/**
  tools:
    include: [read, grep, find, ls]

koni:
  role: reviewer
```

The child inherits its parent’s Pi model and Koni capabilities. Child Pi settings and tool filters
replace the corresponding parent filters; child capability fields override matching parent fields.
Inheritance cannot be chained beyond one parent. This keeps the effective configuration readable and
avoids hidden policy composition.

Omitting `pi.settings` inherits Pi’s complete resolved repository environment. This is the normal
default and makes newly installed general-purpose skills available without editing every agent. Use
filters only when an agent genuinely needs a smaller surface.

### Pi settings filters

An agent can narrow any Pi resource class:

```yaml
pi:
  settings:
    packages:
      - source: git:github.com/obra/superpowers
        skills:
          - skills/using-superpowers/**
          - skills/systematic-debugging/**
        extensions: []
    skills:
      - skills/using-superpowers/**
      - skills/systematic-debugging/**
    prompts: []
    extensions: []
    themes: []
```

Filters use Pi package paths and `*`/`**` globs. Positive patterns must match the resolved
inventory. `!pattern` and `-pattern` exclude matches; `+pattern` adds a match back. Package entries
must refer to sources already configured in Pi.

Repository context is not filterable per agent. `AGENTS.md` remains a repository-wide instruction
boundary, as it is in ordinary Pi.

## Run types

`.koni/project.yaml` lists run types and a default:

```yaml
schema_version: "3.0"
project:
  id: software
  title: Software project
  description: Evidence-guided software delivery.
default_run_type: small
run_types:
  - id: small
    path: run-types/small.yaml
  - id: medium
    path: run-types/medium.yaml
```

A run type defines intake, planning, pipeline stages, question policy, Git naming, concurrency, and
model overrides. Agent references use `agent`:

```yaml
schema_version: "3.0"
id: small
title: Small
description: One bounded change.

profile:
  source: .koni/profile.yaml

pipeline:
  stages:
    focused-plan:
      kind: planning
      title: Plan the change
      config:
        agent: run-planner
        prompt: Produce one implementation-ready plan and graph seed.
    approval:
      kind: approval
      title: Approve the plan
    orchestrate:
      kind: orchestration
      title: Execute compiled work
  order: [focused-plan, approval, orchestrate]

agents:
  roles:
    planner:
      provider: openai-codex
      model: gpt-5.6-terra
      thinking_level: high
  overrides:
    run-planner:
      thinking_level: xhigh
```

`agents.roles` applies a model selection to every configured agent with that Koni role.
`agents.overrides` applies a more specific selection to one agent. A one-run operator override has
the highest precedence. These fields select models only; skills, extensions, tools, instructions,
and capabilities remain in the agent document and Pi environment.

Workflows and action recipes also use `agent` and `agent_from`. Schema 3 does not accept the old
`persona`, `personas`, or profile-vendored skill forms.

## Profile modules

`.koni/profile.yaml` imports Koni’s semantic modules:

```yaml
schema_version: "3.0"
engine: ">=0.1,<0.2"

profile:
  id: software
  version: 1.0.0
  description: Evidence-guided software delivery.

imports:
  graph: [graph.yaml]
  rules: [rules.yaml]
  operations: [operations.yaml]
  workflows: [workflows.yaml]
  actions: [actions.yaml]
  checks: [checks.yaml]
  reports: [reports.yaml]
  cockpit: [cockpit.yaml]
  lifecycles: [lifecycle.yaml]
```

Agent files are discovered from `.koni/agents/`; they are not imported as a profile module. Pi
resources are resolved from Pi; they are not copied into `.koni/resources/` or declared in a Koni
package catalog.

The graph, rule, operation, workflow, check, report, lifecycle, and cockpit schemas remain
profile-owned domain semantics. They determine what work exists and what evidence closes it. Agent
documents determine which Pi-backed role executes that work.

## Inspect and validate

Validate the complete Koni configuration:

```sh
koni config validate --root .
```

Inspect one agent after Pi package and resource resolution:

```sh
koni config resolve-agent run-planner --root .
koni config resolve-agent reviewer --run-type medium --root . --json
```

The resolved view reports ancestry, effective model, selected skills, extension compatibility,
tools, capabilities, and the configuration hash. Use it before a run when a package filter or
project-level Pi change could alter an agent’s environment.

Use ordinary Pi tooling to manage Pi resources. Use Koni’s Configure view or guarded configuration
APIs to edit `.koni` semantics. Do not edit `.koni/.managed` files directly.
