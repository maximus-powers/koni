---
name: configure-koni
description: Inspect a repository and configure, customize, or extend its installed Köni project from natural-language requirements. Use when a Pi agent needs to adapt a default Coding or Research profile to the project's real architecture or empirical method; design graph structure, compiler rules, tickets, proof, or run behavior; edit current `.koni` configuration, provider-neutral agents, repository skills, or a detected legacy `.codex/koni` profile; tune models, capabilities, orchestration, storage, or Git policy; or diagnose a configuration validation failure. Only use this skill when the operator is explicitly working with Köni configuration in this project; it is not for ordinary chat or non-Köni tasks.
---

# Configure Köni

Adapt the project's installed profile so the graph makes important work unavoidable and the compiler turns real semantic gaps into bounded, provable tickets.

## Follow the customization protocol

1. Find the repository root and identify exactly one active configuration root. Prefer current schema 2 at `.koni/project.yaml`; use `.codex/koni/project.yaml` only when no `.koni` catalog exists and the project is still on schema 1. If both live roots exist, stop and request reconciliation instead of guessing. Resolve every cataloged run type's profile and imports. Treat Koni's immutable installed baseline plus the current project overlay as the only configuration lineage; never edit `.koni/.managed`, create a second overlay, or substitute live changes into a pinned run.
2. Read [discovery-and-approval.md](references/discovery-and-approval.md) completely. Inspect repository instructions, manifests, CI, tests, architecture, and domain artifacts before asking questions.
3. Apply the sufficiency rubric. Separate facts observed in the repository from reasonable inferences and unresolved high-impact choices. Ask only the smallest question batch that could materially change ontology, ticket boundaries, authority, proof, or promotion.
4. Use `$model-koni-work` to prepare an ontology/rules/tickets/proof proposal based on the current profile. Choose the owning layer with [configuration-layers.md](references/configuration-layers.md).
5. Present the complete proposal and explicitly request approval. Stop before writing configuration. A general request to customize is not approval of the proposed design.
6. After approval, use `/koni` or `koni tui --root .` and its guided Configure surface whenever the domain is exposed there. For an approved source-level extension not yet represented by a guided field, edit only the project-owned semantic source and preserve useful IDs, paths, module boundaries, and unrelated settings.
7. Validate the whole effective candidate with `koni config validate --root . --json`. Exercise positive, satisfied, and malformed states through the repository's existing fixture harness or an isolated temporary profile copy; add a permanent project harness only when the approved scope justifies it.
8. Report the approved behavior, changed files, validation and test results, assumptions, and any future-run migration concern. Do not start, approve, resume, or promote a run unless separately requested.

For a read-only explanation or diagnosis, inspect the same evidence but stop after the explanation; do not force an approval ceremony when no write is proposed.

## Configure run behavior

Read [run-types.md](references/run-types.md) before changing intake, planning passes, questions, branches, run cards, model policy, or parallelism.

- Add a standalone run type when lifecycle or assurance behavior is independently meaningful. For a focused intent preset, explicit single-parent inheritance with a small override surface is allowed when the resolved run remains complete and should receive future parent fixes. Do not treat selected run types as composable runtime layers.
- Keep every catalog ID unique and equal to the referenced document's `id`.
- Keep every run type pointed at the active contained profile path—normally `.koni/profile.yaml` for schema 2. Retain `.codex/koni/profile.yaml` only in a detected schema-1 project; never mix schema roots or field vocabularies.
- Put model and reasoning policy on `planner`, `lead`, `ticket_worker`, and `reviewer` roles; use persona overrides only for a named exception.
- Put durable control boundaries in `pipeline.order`. Keep approval explicit before orchestration.

> **Superseded in part — Software default 0.4.0 (2026-07-14):** Earlier guidance said, “Add a new complete peer run type when users need a reusable workflow choice.” Keep Small, Medium, and Large as standalone complexity peers, but prefer a narrow derived preset for intent-only differences such as New Feature or Bug Fix. Inheritance is compile-time resolution, not runtime layer composition.

## Configure project semantics

- Use the profile manifest to select initialization, storage, ticket Git behavior, orchestration defaults, and imported semantic modules.
- Keep selectors and predicates as structured YAML. Never embed executable expressions.
- Add or change node, edge, query, rule, operation, workflow, action, check, persona, report, view, or lifecycle definitions in the matching imported module.
- Preserve the safety chain: graph gaps derive tickets; operations grant authority; workflows define required steps; actions perform audited effects; checks and receipts prove results.
- Discover project-owned verification commands from CI, task runners, manifests, and documentation. Do not copy package-manager or test commands from the baseline when the repository does not use them.
- Use `$model-koni-work` for substantial graph, rule, operation, or workflow design and load its profile-specific reference for Software or empirical Research.
- When adopting a newer baseline paradigm, audit the whole coherence chain: graph schema, rules, operations, workflows, checks, run-type planning prompts, native agents, persona permissions, reports/cockpit views, fixtures, and active-run compatibility. A partial upgrade is not a safe customization.

## Configure agent resources

Read [agents-and-skills.md](references/agents-and-skills.md) before changing agent bindings or permissions.

- In schema 2, define provider-neutral agent instructions in `.koni/agents/*.yaml`, bind them from profile personas with `agent`, use `thinking_level`, and express compiler-enforced authority through `capabilities`. Select models/providers only from Pi's available model catalog; do not recreate `.codex/config.toml` or `.codex/agents` as an execution fallback.
- In a detected schema-1 project only, preserve its historical `.codex/agents/*.toml`, `codex_agent`, `reasoning_effort`, and `sandbox` vocabulary until an explicit migration. Never mix current and legacy fields in one profile.
- Keep worktree-specific capability narrowing on the Köni persona. Grant the least network, command, and filesystem access that the role needs.
- Keep reusable repository skills in `.agents/skills/<skill>/`; reference installed skill names explicitly when a persona requires them.
- Treat project settings, native agents, and referenced skills as part of run identity: active runs use pinned snapshots, not later live edits.

## Avoid unsafe shortcuts

- Do not edit compiler-owned graph fields through agent-authored deltas.
- Do not grant broad graph or filesystem scope to compensate for a missing operation contract.
- Do not publish a configuration with unresolved IDs, escaping paths, duplicated imports, ambiguous run types, or an action whose irreversible effect precedes validation.
- Do not silently rewrite an existing semantic language when a focused run type or module change satisfies the request.
- Do not replace the installed default with a generated profile from memory, edit immutable baseline history, or imply that project-overlay edits mutate an active run's pinned snapshot.
