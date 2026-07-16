# Agents and skills

Separate native Codex identity from Köni's run-specific assignment.

## Native agent

Create `.codex/agents/reviewer.toml`:

```toml
name = "reviewer"
description = "Reviews completed work for correctness, safety, and missing proof."
model = "gpt-5.6-terra"
model_reasoning_effort = "xhigh"
sandbox_mode = "read-only"
developer_instructions = """
Review the change like an owner. Ground every finding in concrete evidence.
"""
```

Require `name`, `description`, and `developer_instructions`. Keep reusable role instructions here. Use native optional settings only when the project needs them.

## Köni persona binding

Bind the native resource from the profile's persona module:

```yaml
personas:
  - id: reviewer
    codex_agent: reviewer
    model_role: reviewer
    skills: [review-changes]
    sandbox:
      mode: read-only
      approval_policy: never
      network_access: false
      writable_roots: []
```

Keep worktree-aware permissions on the persona because Köni projects them into the correct run or ticket checkout. Grant network only to roles that need external access. Give planning and review agents read-only access; give implementing roles workspace write access constrained by compiled ticket authority.

Use `prompt` only for legacy or deliberate specialization. If both `codex_agent` and `prompt` exist, the prompt specializes the native agent instructions.

## Repository skills

Store skills at `.agents/skills/<skill-name>/SKILL.md`. Give each skill lowercase hyphenated identity, a precise trigger description, concise imperative procedures, and focused one-level references. Add the skill name to a persona only when that role consistently needs it.

Validate that every referenced agent and skill exists. Köni includes `.codex/config.toml`, native agent files, and referenced skills in configuration identity and run snapshots. Explain that edits affect future runs only; never imply that live edits alter an active pinned run.
