---
name: configure-koni
description: Configure and extend a Köni project from natural-language requirements. Use when Codex needs to create or edit `.codex/koni` catalogs, run types, profiles, imports, native `.codex/agents` resources, `.codex/config.toml`, or repository skills; tune planning, questions, models, permissions, orchestration, storage, or Git policy; or diagnose a configuration validation failure.
---

# Configure Köni

Translate the user's desired work process into the smallest coherent change to the project's Köni configuration.

## Work safely

1. Find the project root and inspect `.codex/koni/project.yaml`, every cataloged run type, `.codex/koni/profile.yaml`, and its imports before editing.
2. Inspect `.codex/agents`, `.codex/config.toml`, and `.agents/skills` when the request affects agents, models, permissions, tools, or skills.
3. Preserve existing IDs, domain vocabulary, module boundaries, ordering, and unrelated settings. Ask only when a product decision would materially change the result.
4. Choose the owning layer before editing. Read [configuration-layers.md](references/configuration-layers.md) for the ownership rules.
5. Make the requested behavior explicit and declarative. Keep domain semantics in the profile; keep run-size or run-purpose choices in standalone run types.
6. Validate every cross-reference and path. Run `koni validate-profile .codex/koni/profile.yaml`; if initialized run state exists, also run `koni validate --root .`.
7. Report changed behavior, affected files, validation results, and any assumptions. Do not start or approve a run unless requested.

## Configure run behavior

Read [run-types.md](references/run-types.md) before changing intake, planning passes, questions, branches, run cards, model policy, or parallelism.

- Add a new complete peer run type when users need a reusable workflow choice. Do not treat Small, Medium, Large, or custom types as composable runtime layers.
- Keep every catalog ID unique and equal to the referenced document's `id`.
- Keep every run type pointed at `.codex/koni/profile.yaml` unless the project deliberately uses another contained profile path.
- Put model and reasoning policy on `planner`, `lead`, `ticket_worker`, and `reviewer` roles; use persona overrides only for a named exception.
- Put durable control boundaries in `pipeline.order`. Keep approval explicit before orchestration.

## Configure project semantics

- Use the profile manifest to select initialization, storage, ticket Git behavior, orchestration defaults, and imported semantic modules.
- Keep selectors and predicates as structured YAML. Never embed executable expressions.
- Add or change node, edge, query, rule, operation, workflow, action, check, persona, report, view, or lifecycle definitions in the matching imported module.
- Preserve the safety chain: graph gaps derive tickets; operations grant authority; workflows define required steps; actions perform audited effects; checks and receipts prove results.
- Use `$model-koni-work` for substantial graph, rule, operation, or workflow design.

## Configure native Codex resources

Read [agents-and-skills.md](references/agents-and-skills.md) before changing agent bindings or permissions.

- Define reusable agent instructions in `.codex/agents/*.toml` and bind them from profile personas with `codex_agent`.
- Keep worktree-specific sandbox policy on the Köni persona. Grant the least network and filesystem access that the role needs.
- Keep reusable repository skills in `.agents/skills/<skill>/`; reference installed skill names explicitly when a persona requires them.
- Treat project settings, native agents, and referenced skills as part of run identity: active runs use pinned snapshots, not later live edits.

## Avoid unsafe shortcuts

- Do not edit compiler-owned graph fields through agent-authored deltas.
- Do not grant broad graph or filesystem scope to compensate for a missing operation contract.
- Do not publish a configuration with unresolved IDs, escaping paths, duplicated imports, ambiguous run types, or an action whose irreversible effect precedes validation.
- Do not silently rewrite an existing semantic language when a focused run type or module change satisfies the request.
