# Configuration layers

Use the layer that owns the requested decision.

First identify the active schema. Current schema 2 uses `.koni/`, `schema_version: "2.0"`,
provider-neutral YAML agents, and `agent` / `thinking_level` / `capabilities`. Schema 1 uses
`.codex/koni/` plus historical Codex resources and legacy field names. Never mix the two roots or
vocabularies. The examples below use schema 2 unless explicitly labeled legacy.

## Contents

- [Catalog contract](#catalog-contract)
- [Profile contract](#profile-contract)
- [Change placement examples](#change-placement-examples)
- [Coherence chain](#coherence-chain)

| Layer | Location | Owns |
| --- | --- | --- |
| Project catalog | `.koni/project.yaml` | Project identity, default run type, ordered run-type registry |
| Run type | `.koni/run-types/*.yaml` | Intake, planning guidance, pipeline, question policy, run branches, run card, role models, run parallelism |
| Profile manifest | `.koni/profile.yaml` | Semantic initialization, state storage, ticket Git policy, semantic orchestration defaults, module imports |
| Profile modules | Paths imported by `profile.yaml` | Graph, rules, operations, workflows, actions, checks, personas, reports, cockpit views, lifecycles |
| Provider-neutral agents | `.koni/agents/*.yaml` | Reusable instructions, pinned provider/model policy, thinking level, capabilities, and skills |
| Repository skills | `.agents/skills/*` | Reusable agent procedures and references |

For a detected schema-1 project, substitute `.codex/koni` for the first three rows and preserve its
`.codex/agents/*.toml` resources until explicit migration. Do not author new `.codex` runtime
resources for schema 2.

The installed profile is the semantic baseline. Extend it in place after approval: retain useful default ontology, compiler rules, proof boundaries, and run types, then specialize only what repository evidence justifies. Do not regenerate the profile from memory or create a baseline-plus-overlay upgrade system. A future upgrade mechanism is a separate product concern.

Choose by responsibility:

- Put durable domain meaning and gap detection in profile modules, not run prompts.
- Put intake, planning depth, approval, target synchronization, promotion, model policy, and concurrency in a complete run type.
- Put reusable role identity and instructions in provider-neutral agents; put worktree-aware authority on profile personas.
- Put deterministic selection and authorization in configuration. Leave investigation, judgment, and synthesis to agents inside those boundaries.
- Treat IDs as public interfaces. Preserve them when meaning is stable; change every reference together when a semantic migration is approved.

## Catalog contract

Keep the catalog small and explicit:

```yaml
schema_version: "2.0"
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
schema_version: "2.0"
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

Keep imports ordered, unique, project-relative, and contained beneath the profile root. Keep authored source paths out of `filesystem_scope_excludes`; reserve it for transient or generated trees. Unknown keys, duplicated definitions, dangling IDs, invalid cycles, and authority or path escapes must fail closed rather than become ignored intent.

Choose `git_common_dir` when semantic state should remain outside the product tree and be shared by linked worktrees. Choose `tracked` only when graph and ticket state intentionally belongs in repository history.

### Graph collection constraints

Use collection relationships when a graph invariant is structural rather than
prompt guidance:

```yaml
covered_paths: {type: list, items: {type: path}}
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

- `subset_of` and `disjoint_from` require compatible `list<string>` or
  `list<path>` fields and reference one declared root field on the same node.
  Nested constrained fields may still reference that root field.
- String comparison is exact. Path subsets use normalized project-relative
  identity. Path disjointness rejects equality, containment, existing
  same-filesystem-object aliases, symlink components, and conservative
  case/Unicode aliases for missing descendants beneath one existing identity.
- `unique_by` requires a list of objects and one direct, declared, required
  scalar item property. It rejects duplicates without echoing their values.
- Omitting these keywords preserves the prior profile behavior. Do not replace
  a deterministic relationship with prose instructions.

## Change placement examples

- “Ask for an environment and target region on deployment runs” → run-type intake.
- “Use a stronger reviewer on large changes” → Large run type's reviewer role.
- “Make every change identify affected services” → graph node/edge schema plus rules.
- “Let implementers edit `packages/api`” → rule-emitted ticket paths and operation authority, not a global sandbox grant.
- “Use a security-specialist agent” → provider-neutral agent plus persona binding, then workflow step.
- “Show open risks in the TUI” → cockpit view over graph data.

## Coherence chain

For every project-specific obligation, trace one complete chain:

1. a graph type and lifecycle make the durable fact representable;
2. a query and structured rule detect the exact missing state;
3. the rule derives an obligation and emits a deterministic ticket;
4. an operation grants only the graph and product authority that ticket needs;
5. a workflow orders creative work, any genuinely necessary composition, checks, and independent review;
6. current receipts or explicit gates prove the terminal state;
7. reports and cockpit views project the authoritative result without inventing it.

> **Superseded by — Software default 0.4.0 (2026-07-14):** The earlier coherence chain required “creative work, integration, checks, and independent review” for every obligation. Independent review remains a trust boundary; an Integrator step is now reserved for real multi-output or delivery composition rather than mandatory transcription.

If a proposed setting cannot be placed on this chain or in a run-control layer, it may be prompt decoration rather than enforceable configuration.
