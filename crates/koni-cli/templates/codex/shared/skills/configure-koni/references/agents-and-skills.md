# Agents and skills

Separate provider-neutral agent identity from Köni's run-specific assignment. This page describes
current schema 2 first; the final section covers schema-1 compatibility.

## Provider-neutral agent

Create `.koni/agents/reviewer.yaml`:

```yaml
schema_version: "2.0"
id: reviewer
description: Reviews completed work for correctness, safety, and missing proof.
instructions:
  source: inline
  text: |
    Review the change like an owner. Ground every finding in concrete evidence.
provider: openai-codex
model: gpt-5.6-terra
thinking_level: xhigh
capabilities:
  workspace_access: read_only
  commands: read_only
  network_access: false
skills: [review-changes]
```

Require the schema, identity, description, instruction source, pinned provider, and capabilities.
Keep reusable role instructions here. `openai-codex` is the only schema-2 provider; do not add a
project-level provider or Codex CLI override.

## Köni persona binding

Bind the provider-neutral resource from the profile's persona module:

```yaml
personas:
  - id: reviewer
    agent: reviewer
    model_role: reviewer
    skills: [review-changes]
    capabilities:
      workspace_access: read_only
      commands: read_only
      network_access: false
      writable_roots: []
```

Keep worktree-aware capability narrowing on the persona because Köni projects it into the correct
run or ticket checkout. Grant network only to roles that need external access. Give planning and
review agents read-only workspace and command access; give implementing roles workspace-write
access constrained by compiled ticket authority.

Use `prompt` only for deliberate profile-local specialization. If both `agent` and `prompt` exist,
the prompt specializes the provider-neutral agent instructions.

## Repository skills

Store skills at `.agents/skills/<skill-name>/SKILL.md`. Give each skill lowercase hyphenated identity, a precise trigger description, concise imperative procedures, and focused one-level references. Add the skill name to a persona only when that role consistently needs it.

Validate that every referenced agent and skill exists. Köni includes `.koni` configuration,
provider-neutral agent files, and referenced skills in configuration identity and run snapshots.
Explain that edits affect future runs only; never imply that live edits alter an active pinned run.

## Schema-1 compatibility

When `.koni/project.yaml` is absent and the active catalog is `.codex/koni/project.yaml`, preserve
that profile's `.codex/agents/*.toml`, `codex_agent`, `reasoning_effort`, and `sandbox` fields. Do not
copy the schema-2 example into schema 1 or create a dual runtime. Offer explicit migration when the
user wants current provider-neutral configuration.
