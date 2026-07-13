# Configuration layers

Use the layer that owns the requested decision.

| Layer | Location | Owns |
| --- | --- | --- |
| Project catalog | `.codex/koni/project.yaml` | Project identity, default run type, ordered run-type registry |
| Run type | `.codex/koni/run-types/*.yaml` | Intake, planning guidance, pipeline, question policy, run branches, run card, role models, run parallelism |
| Profile manifest | `.codex/koni/profile.yaml` | Semantic initialization, state storage, ticket Git policy, semantic orchestration defaults, module imports |
| Profile modules | Paths imported by `profile.yaml` | Graph, rules, operations, workflows, actions, checks, personas, reports, cockpit views, lifecycles |
| Native Codex project resources | `.codex/config.toml`, `.codex/agents/*.toml` | Codex settings and reusable agent instructions/defaults |
| Repository skills | `.agents/skills/*` | Reusable agent procedures and references |

## Catalog contract

Keep the catalog small and explicit:

```yaml
schema_version: "1.0"
project:
  id: my-project
  title: My Project
  description: Graph-compiled work for this repository.
default_run_type: medium
run_types:
  - id: small
    path: run-types/small.yaml
  - id: medium
    path: run-types/medium.yaml
```

Require the default to name exactly one entry. Require each contained path to resolve beneath the catalog directory and each referenced document's `id` to equal its entry ID. Reject duplicate IDs, duplicate paths, unknown fields, and ambiguous definitions.

## Profile contract

Use one shared semantic profile for the cataloged peer run types:

```yaml
schema_version: "1.0"
engine: ">=0.1,<0.2"
profile:
  id: my-project-work
  version: "0.1.0"
  description: Project-owned work semantics
initialization:
  root_node_type: objective
  goal_field: outcome
  root_status: active
storage:
  backend: git_common_dir
  graph_dir: program/graph
  tickets_dir: program/tickets
  state_path: program/state.yaml
  work_dir: program/work
  receipts_dir: program/receipts
  reports_dir: program/reports
  filesystem_scope_excludes: [node_modules, target, .next, coverage]
git:
  enabled: true
  backend: libgit2
  integration_branch: current
  integration_strategy: squash
orchestration:
  running: true
  max_parallel: 3
  lease_stale_seconds: 1800
  max_fixpoint_passes: 8
  max_boundaries_per_lead: 1
  disjoint_scope_parallelism: true
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

Keep imports ordered, unique, project-relative, and contained beneath the profile root. Keep authored source paths out of `filesystem_scope_excludes`; reserve it for transient or generated trees.

Choose `git_common_dir` when semantic state should remain outside the product tree and be shared by linked worktrees. Choose `tracked` only when graph and ticket state intentionally belongs in repository history.

## Change placement examples

- “Ask for an environment and target region on deployment runs” → run-type intake.
- “Use a stronger reviewer on large changes” → Large run type's reviewer role.
- “Make every change identify affected services” → graph node/edge schema plus rules.
- “Let implementers edit `packages/api`” → rule-emitted ticket paths and operation authority, not a global sandbox grant.
- “Use a security-specialist agent” → native agent plus persona binding, then workflow step.
- “Show open risks in the TUI” → cockpit view over graph data.
