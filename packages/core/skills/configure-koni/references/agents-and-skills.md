# Agents and Pi resources

Koni agents are Pi-native resource selections plus Koni authority policy. There is no separate
persona binding.

## Agent document

Create `.koni/agents/reviewer.yaml`:

```yaml
schema_version: "3.0"
id: reviewer
description: Independently reviews completed work and its proof.
instructions: |
  Review the candidate against the complete issued contract. Ground every finding in evidence.

pi:
  provider: openai-codex
  model: gpt-5.6-terra
  thinking_level: xhigh
  settings:
    skills:
      - skills/using-superpowers/**
      - skills/verification-before-completion/**
  tools:
    include: [read, grep, find, ls]

koni:
  role: reviewer
  capabilities:
    workspace_access: read_only
    commands: read_only
    network_access: false
    writable_roots: []
```

The `id` must match the file name. Provider, model, and thinking level are selected together. Keep
instructions role-stable; put reusable procedures in skills.

When authoring or changing a Lead, follow the progressive-frontier policy in `run-types.md`. Keep
the judgment grounded in facts the attempt receives, and make planning and ticket contracts expose
the closure chain the Lead must assess.

An agent inherits the complete Pi repository environment when `pi.settings` is omitted. Filters only
narrow resources Pi already resolved. Positive globs must match. A package filter must name an
already configured Pi package.

## Skill selection inside contained attempts

Keep Pi as the resource source of truth. Use an agent filter only when the role consistently needs a
smaller resource surface, not to compensate for an ordinary skill whose interactive lifecycle would
conflict with one compiler-issued phase. Koni's contained skill adapter treats an attempt as a
dispatched task: Koni already owns scope, approval, orchestration, worktrees, and promotion, while
skills contribute applicable techniques inside the issued step.

Do not copy lifecycle policy into every agent, remove general skills from every profile, or add
language- and task-specific warnings to stop a repeated agent mistake. Diagnose the owning layer:

- If the skill is useful but part of its workflow would restart planning, approval, or another
  lifecycle, preserve the Pi resource and fix the general contained-applicability contract.
- If agents repeatedly lack a reusable software or research technique, select, create, or improve a
  proven Pi skill at the repository or package layer.
- If one role genuinely must never receive a resource class, narrow that agent through
  `pi.settings`; do not create a second resource registry under `.koni`.

One optional `extends` parent is allowed. Parent chains are rejected. A child's settings and tools
replace those parent filters; capability fields merge with child values taking precedence.

## Manage resources through Pi

Use Pi's normal project structure and commands:

```text
.pi/settings.json
.pi/skills/<name>/SKILL.md
.pi/extensions/
.pi/prompts/
.pi/themes/
.agents/skills/<name>/SKILL.md
AGENTS.md
```

Do not copy package skills under `.koni`. Do not create a Koni package registry. Koni resolves the
same global, project, and package inventory ordinary Pi sees, then pins the selected bytes for a
run.

Unknown extensions are excluded from autonomous attempts unless Core has a named containment
adapter. Safe tool filters use `read`, `grep`, `find`, `ls`, `write`, and `edit`; shell and ambient
lifecycle tools are not agent configuration options.

Verify with:

```sh
koni config validate --root .
koni config resolve-agent reviewer --run-type medium --root . --json
```
