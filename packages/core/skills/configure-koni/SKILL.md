---
name: configure-koni
description:
  Use when configuring or extending an installed Koni project, changing run types or agents,
  adapting graph and proof semantics, or diagnosing Koni configuration validation failures.
---

# Configure Koni

Adapt the installed project without creating a second agent-resource system. Pi owns packages,
skills, extensions, prompts, themes, and repository instructions. Koni owns orchestration and
authority policy beneath `.koni/`.

## Workflow

1. Find the repository root and read `.koni/project.yaml`, every listed run type,
   `.koni/profile.yaml`, its imports, and `.koni/agents/`.
2. Read [discovery-and-approval.md](references/discovery-and-approval.md). Inspect repository
   instructions, manifests, CI, tests, architecture, and domain artifacts before asking questions.
3. Separate observed facts, safe inferences, and unresolved high-impact choices. Ask only questions
   that could change ontology, ticket boundaries, authority, proof, or promotion.
4. Use `$model-koni-work` for graph, rule, operation, workflow, and proof design. Choose the owning
   layer with [configuration-layers.md](references/configuration-layers.md).
5. Present the complete proposal and request approval before writing.
6. After approval, use Koni's Configure surface for `.koni` semantics. Use ordinary Pi commands and
   repository paths for Pi resources.
7. Run `koni config validate --root . --json`. Inspect affected agents with
   `koni config resolve-agent <id> --root . --json`.
8. Report changed files, validation, tests, assumptions, and future-run impact. Do not start or
   approve a run unless separately requested.

For a read-only explanation or diagnosis, inspect the same evidence and stop after the explanation.

## Placement rules

- Put project identity and the ordered run-type catalog in `.koni/project.yaml`.
- Put intake, pipelines, questions, branches, concurrency, and role model defaults in run types.
- Put graph, rule, operation, workflow, action, check, report, cockpit, and lifecycle semantics in
  profile modules.
- Put stable role instructions, Pi resource filters, model defaults, safe tool filters, and Koni
  capabilities in `.koni/agents/<id>.yaml`.
- Put packages and Pi settings in `.pi/settings.json`; put project skills/extensions/prompts/themes
  in Pi's ordinary `.pi/` or `.agents/` locations.
- Put repository-wide instructions in `AGENTS.md`.

Read [run-types.md](references/run-types.md) before changing run behavior and
[agents-and-skills.md](references/agents-and-skills.md) before changing an agent or Pi resources.

## Safety boundaries

- Use schema `3.0` and `agent`/`agents.overrides`. Retired persona documents and Koni-vendored skill
  catalogs are not accepted.
- Do not edit `.koni/.managed` or substitute live changes into an already pinned run.
- An agent's Pi settings may only narrow Pi's resolved inventory. Install or remove resources
  through Pi first.
- Keep reusable, general guidance in skills. Keep agent instructions short and role-stable.
- Grant the least workspace, command, network, graph, and tool authority the role needs.
- Preserve useful IDs and module boundaries. Change every reference together when an approved
  semantic migration changes an ID.
- Never compensate for a missing operation contract with broad graph or filesystem authority.
