# Codex agents and skills

Köni uses Codex's native project extension points rather than inventing a
second agent and skill format:

```text
.codex/
├── config.toml
├── agents/
│   └── reviewer.toml
└── koni/
    └── personas.yaml
.agents/
└── skills/
    └── model-koni-work/
        ├── SKILL.md
        ├── agents/openai.yaml
        └── references/
```

`.codex/koni/` contains Köni semantics. `.codex/agents/` contains native
Codex custom agents. Repository skills live in `.agents/skills/`, the
project-scoped discovery location Codex reads for chat sessions.

## Installed skills

The bundled software profile installs three complementary skills:

| Skill | Use it for |
| --- | --- |
| `configure-koni` | Turn a natural-language request into valid catalogs, run types, roles, permissions, and model/question policy |
| `model-koni-work` | Design graph types, rules, ticket constructors, operations, workflows, actions, checks, and reports |
| `operate-koni` | Validate, plan, approve, inspect, supervise, and recover runs safely |

Skills use progressive disclosure. Their `SKILL.md` files explain routing and
the normal workflow; focused references hold schemas, invariants, and examples.
This keeps an ordinary Codex chat concise while making the full configuration
contract available when needed.

After `koni init`, start a new Codex chat from the repository root so Codex
discovers the installed project skills. You can then ask, for example:

> Use configure-koni to add an Infrastructure Change run type. Require an
> architecture and rollback planning pass, pause only for high-impact
> questions, allow two parallel workers, and keep independent review.

Or:

> Use model-koni-work to model API compatibility as a first-class node and
> compile a ticket whenever a public interface lacks a compatibility decision
> and verification gate.

The agent should edit only project resources, validate the complete profile,
and explain the resulting behavior. Use Configure in the TUI for review and
small adjustments.

## Native custom agents

Every `.codex/agents/*.toml` resource used by Köni contains:

```toml
name = "koni-reviewer"
description = "Reviews bounded ticket and graph transitions."
developer_instructions = """
Review the candidate against the operation scope, configured checks,
required receipts, and semantic transition. Never publish Git state.
"""

model = "gpt-5.6-terra"
model_reasoning_effort = "xhigh"
sandbox_mode = "read-only"
nickname_candidates = ["Reviewer"]
```

`name` is the stable identity and does not need to match the filename.
Köni understands the native model, reasoning, sandbox, nickname, MCP, and skill
configuration it needs, while preserving unknown TOML values for forward
compatibility.

Persona configuration references the agent by name:

```yaml
personas:
  - id: reviewer
    codex_agent: koni-reviewer
    skills: [model-koni-work]
    model_role: reviewer
```

`prompt` remains available for profile-source authoring and compatibility. A
persona may combine `codex_agent` with explicit values; explicit persona
instructions, description, model, reasoning, or sandbox values specialize the
native agent.

## Resolution and authority

Effective agent policy resolves from the most specific layer to the least
specific:

1. one-run override;
2. pipeline-stage override;
3. run-type persona override;
4. run-type role default;
5. explicit profile persona value;
6. referenced native agent value;
7. runtime default.

Köni retains final authority over model, reasoning, sandbox, approval, and
runtime broker settings for a launch. A project agent may provide
`developer_instructions`, MCP servers, and native skill settings, but it
cannot replace the compiler-injected `koni_runtime` broker.

The broker exposes narrow capabilities required by a bounded workflow. It does
not grant an agent ownership of authoritative question metadata, state
transitions, receipts, or Git publication.

## Skill bundles

Each direct `.agents/skills/*/SKILL.md` has YAML frontmatter:

```yaml
---
name: model-koni-work
description: Model graph-first Köni work as typed rules, tickets, and workflows.
---
```

The complete directory is one bundle. Scripts, references, assets, and agent
metadata are hashed with `SKILL.md`. A directory may be a symlink for normal
Codex discovery; when Köni captures a run it resolves the selected bundle into
regular files so the snapshot is immutable.

Keep skills instructional. They should explain how an agent edits and validates
configuration; executable engine behavior belongs in the global `koni`
binary, not in copied skill scripts.

## Ownership and initialization

`koni init` records a hash for every native file it installs. On a later
initialization:

- unrelated `.codex` and `.agents` resources are preserved;
- unchanged Köni-owned resources may be refreshed;
- locally modified or unowned colliding files cause a conflict;
- `--replace` is required for an intentional replacement.

Publication is staged and atomic. If native resources and the semantic profile
do not validate together, no partial installation becomes active.

The repository authoring profile and an installed project are not necessarily
byte-identical. Installation may transform profile-side Markdown prompts into
native agents and update resource locators. The installed project tree is the
runnable contract.

## Validation and pinning

Compilation validates every referenced native agent and skill. Native agent
names must be unique, required strings must be non-empty, contained files must
be regular, and persona references must resolve.

The run snapshot binds:

- `.codex/koni/**`;
- `.codex/config.toml`;
- referenced `.codex/agents/**`;
- referenced `.agents/skills/**`.

User-level Codex configuration is not copied into the run. This makes project
behavior reviewable and prevents a later user configuration change from
silently altering an approved run.
