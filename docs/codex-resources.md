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

> **Pi/schema 2 transition in progress — 2026-07-14 (`pi_product_docs_transition`):** This is the
> executable schema-1/Codex resource contract and remains the reader contract for pinned historical
> runs. The unreleased schema-2 target keeps `.agents/skills/`, moves live Köni configuration and
> provider-neutral agent YAML beneath `.koni/`, and replaces Codex execution with the direct Pi
> host in [Direct Pi runtime](pi-runtime.md). A migrated project has no Codex fallback. Cutover is
> gated by exact ownership-aware migration, historical-reader compatibility, the unresolved
> credential-TCB decision (Rust-owned allowlisted auth proxy versus signed/pinned host dependency
> closure), the remaining Pi security review, and one frozen host/Rust/CLI/TUI/profile fingerprint.

> **Release-candidate supersession — 2026-07-14 (`pi_product_docs_transition`):** The preceding
> unreleased/undecided status is historical. Current source is the schema-2/direct-Pi release
> candidate for macOS, with no production Codex fallback. The accepted first-cut credential TCB is
> the exact Köni Rust binary, bundled Pi host, pinned Pi SDK 0.80.7 dependency closure, and official
> pinned Node 22.19.0 runtime; Node retains no compiler-tool, graph, Git, receipt, or project-file
> authority. Linux login and inference fail closed until destination-allowlisted egress exists.
> Installing or migrating remains a separate guarded operator action, never authority inferred
> from protected forensic Updog state.

## Installed skills

The bundled software profile installs three complementary skills.

> **Evolving to — 2026-07-14:** That original Software contract now applies to
> every bundled profile. The table below also evolves `configure-koni` from a
> direct natural-language editor into a repository-grounded, approval-first
> configuration workflow, and extends `model-koni-work` to canonical relations
> and repository-native proof.

> **Earlier skill contract — retained 2026-07-14:** `configure-koni` turned a
> natural-language request into valid catalogs, run types, roles, permissions,
> and model/question policy. `model-koni-work` designed graph types, rules,
> ticket constructors, operations, workflows, actions, checks, and reports.
> Those capabilities remain; the current descriptions add the evidence and
> approval boundaries above.

| Skill | Use it for |
| --- | --- |
| `configure-koni` | Inspect the repository, interview only for material gaps, propose a project model for approval, then configure the installed profile |
| `model-koni-work` | Design canonical graph types, rules, ticket constructors, operations, workflows, actions, repository-native proof, and reports |
| `operate-koni` | Validate, plan, approve, inspect, supervise, and recover runs safely |

Skills use progressive disclosure. Their `SKILL.md` files explain routing and
the normal workflow; focused references hold schemas, invariants, and examples.
This keeps an ordinary Codex chat concise while making the full configuration
contract available when needed.

After `koni init`, start a new Codex chat from the repository root so Codex
discovers the installed project skills. You can then ask, for example:

> **Pre-cutover guidance — 2026-07-14 (`pi_product_docs_transition`):** Starting a new Codex chat
> is still the correct workflow for the installed schema-1 layout described here. It is not the
> schema-2 runtime interface. After a successful explicit migration, Köni invokes its pinned Pi SDK
> host directly and does not discover or execute Codex agents as a fallback; historical Codex
> resources remain readable only for audit and old snapshots. That migration is not yet released;
> see the migration, containment, credential, protocol, and frozen-matrix gates in
> [Direct Pi runtime](pi-runtime.md).

> **Pre-cutover supersession — 2026-07-14 (`pi_product_docs_transition`):** The “not yet released”
> status above is superseded for current source. Fresh schema-2 projects and explicitly migrated
> projects use the pinned Pi host directly; schema-1 Codex resources remain executable only for an
> as-yet-unmigrated installation and readable for historical snapshots. No migration or installed-
> project replacement occurs merely because the release candidate exists.

> Use configure-koni to add an Infrastructure Change run type. Require an
> architecture and rollback planning pass, pause only for high-impact
> questions, allow two parallel workers, and keep independent review.

Or:

> Use model-koni-work to model API compatibility as a first-class node and
> compile a ticket whenever a public interface lacks a compatibility decision
> and verification gate.

Or, for empirical work:

> Use configure-koni to adapt the installed Research profile to this
> experiment repository. Model claims, primary metrics, baselines, ablations,
> seed policy, receipt-backed evidence, target synchronization, and explicit
> promotion. Show me the design before editing anything.

> **Earlier editing contract — retained 2026-07-14:** “The agent should edit
> only project resources, validate the complete profile, and explain the
> resulting behavior. Use Configure in the TUI for review and small
> adjustments.”

> **Evolving to — 2026-07-14:** The same project-resource boundary remains, but
> substantial changes now require repository inspection and explicit approval
> of the semantic proposal before any edit.

The agent first reads the installed profile and repository evidence, then shows
the proposed ontology, rule/operation/workflow mapping, proof policy, file plan,
and assumptions. It must receive explicit approval before editing. Afterward it
edits only project resources, validates the complete profile, and explains the
resulting behavior. Use Configure in the TUI for review and small adjustments.

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

> **Agent-definition transition in progress — 2026-07-14 (`pi_product_docs_transition`):** The
> TOML and `codex_agent` resolution above remain authoritative for schema-1 and pinned runs. Schema
> 2 uses provider-neutral `.koni/agents/*.yaml`, `agent`, `thinking_level`, and capabilities; the
> explicit migrator converts only manifest-owned, schema-defined references. Release requires
> preservation fixtures for prompt/schema data, ancestor-symlink safety, atomic recovery, and
> authoritative active-run archival. Until those checks and the Pi security matrix are green,
> source-in-progress schema-2 definitions must not replace an installed project.

> **Agent-definition supersession — 2026-07-14 (`pi_product_docs_transition`):** The current
> release candidate closes those conversion, archival, recovery, runtime, and frozen-matrix gates.
> `.koni/agents/*.yaml` is the live schema-2 agent contract, and a migrated project has no Codex
> fallback. Existing schema-1 installations keep their current resources until an explicit guarded
> migration; unrelated `.codex` resources and historical readers remain preserved.

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

> **Evolving to — 2026-07-14:** The authority boundary above remains unchanged.
> The graph context and note capabilities below are narrow brokered resources:
> reads stay inside the ticket neighborhood, notes remain advisory, and neither
> capability grants graph mutation, state-transition, receipt, or publication
> authority.

## Runtime context and working memory

The first `koni_runtime.context` call returns the existing ticket, operation,
workflow, dependency-output, persona, and review contracts. It also projects a
typed `spec_slice`, applicable user/Lead `intent_updates`, and bounded
graph-bound `working_memory`. The reviewed graph and explicit steering are
authoritative; notes are advisory even when their lifecycle state is
`confirmed`.

> **Context-first enforcement — 2026-07-14:** The statement above originally
> described the required worker interaction, but ordering was enforced only by
> the assignment prompt. The runtime broker now refuses every new graph or
> output action until `context` has succeeded. Exact already-recorded receipt
> replay remains available for crash and pinned compatibility recovery.

When the issued slice omits a concrete dependency needed for the assigned
step, a worker may call read-only `koni_runtime.graph_context`. Its anchors must
come from the ticket scope, and its relation, direction, node-type, depth,
node-count, response-size, and per-step call limits come from the pinned
profile. The result can clarify the specification but cannot expand graph or
filesystem write authority.

> **Model context versus proof closure — 2026-07-14:** The bounded worker view
> above remains intentionally incomplete. It is not the authority boundary for
> configured verification. When a workflow uses a composite `graph_set`, the
> compiler evaluates its finite selector independently at each ticket target
> over the effective step-readable induced graph and persists the complete,
> deterministic member closure—including repository-relative proof and covered
> filepaths—on the step. The model need not receive every proof node in prose,
> and `graph_context` cannot add a member or enlarge the set. Execution,
> currentness, source preservation, aggregate readiness, and composed replay all
> use the compiler-pinned closure.

`koni_runtime.record_note` stores a bounded observation,
`implementation_detail`, rationale, nit, or open question against a visible
node. It preserves run/ticket/step/persona/time provenance and may supersede an
earlier note without deleting history. Agents must submit intended decisions,
contracts, scope changes, and acceptance changes through the authorized typed
graph delta instead of treating a note as semantic state.

The returned working-memory view prefers newest current records, omits retired
history from the bounded payload, and labels each note's node-revision binding
as current, stale, missing, or legacy-unbound. A stale label is a reason to
re-check the typed node, not authority to restore the older note.

Both tools are compiler-brokered. Successful calls produce supplement receipts
that are automatically bound to the step's eventual structured output, so an
agent cannot selectively omit the additional context it used.

> **Resolved legacy-alias closure — 2026-07-14:** The automatic binding above
> was already atomic for `submit_and_compile`. In the retained two-call flow,
> `submit_output` now closes new graph supplement requests because its accepted
> `StepOutput` has frozen the receipt list; exact supplement replay remains
> safe, and workers gather any additional graph context before resubmitting a
> complete revision.

> **Earlier worker boundary — retained:** Workers historically called
> `koni_runtime.context`, submitted one structured candidate through
> `koni_runtime.submit_output`, and then invoked the separate scoped
> `koni_runtime.compile` boundary. Those submission and compile aliases remain
> available to immutable pinned snapshots that advertise the older tool set.

> **Transition source-complete — 2026-07-14:** Current worker prompts and broker
> contracts prefer two calls: `context`, then one replay-safe
> `submit_and_compile` carrying the complete structured payload. The composite
> boundary validates and materializes the output and performs its scoped
> compile without another model turn, while preserving the same compiler-owned
> receipts and authority checks. Focused broker tests cover composite replay
> and compatibility aliases; the separate live-smoke requirement to measure
> token savings with a fresh comparable worker remains pending.

> **Same-session check-feedback transition — 2026-07-15:** The source-complete
> boundary above remains the successful-path contract. A live Medium worker
> showed that a newly failed scoped check could persist an actionable receipt
> while `submit_and_compile` returned only a generic nonretryable error. Current
> workers now run every step-assigned `validation_check` after their last edit
> and before terminal submission. If the compiler's own rerun still fails, the
> broker selects only a valid receipt created after that exact compile began,
> reuses the bounded secret-redacted configured-check projection, and keeps the
> terminal call nonconsuming so the same session can repair, rerun the exact
> configured check, and resubmit. Three rejected terminal attempts retain the
> existing circuit breaker; an unrelated compiler failure still stops without
> exposing raw internals. Focused broker regressions and the full Software
> direct submit/compile regression cover both outcomes.

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

Project customization uses that installed tree as its baseline and edits it in
place. A second generated overlay/baseline scheme is not part of the current
contract. Approved changes apply to future run snapshots; already planned or
approved runs retain their pinned resources.

> **Transition proposed — 2026-07-14:** This in-place model remains shipped and
> authoritative. A queued versioned-baseline plus project-overlay design would
> make local intent and bundled upgrades independently inspectable, but its
> storage, migration, and compatibility behavior are not implemented yet.

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

> **Snapshot-reader transition — 2026-07-14 (`pi_product_docs_transition`):** The list above is
> intentionally retained for schema-1 snapshots. Schema-2 snapshots will bind the `.koni` catalog,
> profile, provider-neutral agents, and referenced `.agents/skills` instead. Migration must keep
> the old snapshot and transcript readers intact while refusing new schema-1 execution after
> cutover; a migrated project cannot fall back to Codex. That reader/migration contract and the
> runtime trust, teardown, credential-intent, protocol, and token-accounting gates remain pending
> in [Direct Pi runtime](pi-runtime.md).

> **Snapshot-reader supersession — 2026-07-14 (`pi_product_docs_transition`):** The release
> candidate now passes the named runtime and historical-reader matrix. New schema-2 snapshots bind
> `.koni`, provider-neutral agents, and Pi events; schema-1 snapshots remain read-only history and
> active Codex-backed runs are permanently archived during migration. There is no executable Codex
> fallback after cutover, and applying that cutover remains an explicit operator action.
