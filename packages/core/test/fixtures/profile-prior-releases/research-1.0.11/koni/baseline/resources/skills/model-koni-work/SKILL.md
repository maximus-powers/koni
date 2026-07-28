---
name: model-koni-work
description: Design or revise Köni's graph-compiled work model from a repository's actual domain. Use when a Pi agent needs to define project ontology, node and edge types, queries, structured rules, ticket emission, operations, workflows, checks, actions, receipts, reports, views, or lifecycle policy under current `.koni` configuration or a detected legacy `.codex/koni` profile; specialize the Coding profile around code domains, interfaces, and adaptive proof; specialize the empirical Research profile around claims, metrics, baselines, ablations, gates, and evidence; translate a real-world process into graph gaps and executable tickets; or debug missing, duplicated, blocked, stale, or over-authorized work.
---

# Model Köni Work

Model desired outcomes and their missing semantic obligations as a graph, then compile those gaps into bounded, reviewable tickets.

## Design from outcomes backward

1. Start from the installed profile selected for the project. Retain useful default semantics and specialize them from repository evidence rather than generating an unrelated ontology.
2. State the root outcome, success evidence, and scope boundary in domain language.
3. Identify durable facts and decisions that agents must share. Represent those as typed nodes and relationships, not prompt prose.
4. Identify observable gaps between current and desired graph state. Represent those as structured rules.
5. Give each actionable gap one public operation, a narrow authority contract, and a dependency-aware workflow.
6. Attach checks, receipts, and review that prove completion. For Git-enabled delivery, add target synchronization and explicit promotion boundaries.
7. Add reports or cockpit views only after the underlying graph and ticket data are authoritative.
8. Validate the complete effective configuration with `koni config validate --root . --json`, and exercise at least one positive, one already-satisfied, and one malformed state through existing fixtures or an isolated temporary profile copy. Never mix schema-2 `agent`/`thinking_level`/`capabilities` fields with schema-1 `codex_agent`/`reasoning_effort`/`sandbox` fields.

Read [graph-model.md](references/graph-model.md) when defining ontology. Read [rules-and-tickets.md](references/rules-and-tickets.md) when compiling gaps. Read [execution-contracts.md](references/execution-contracts.md) when granting authority or defining workflow effects.

- For a coding repository based on Software, also read [software-projects.md](references/software-projects.md).
- For executable empirical work based on Research, also read [empirical-research.md](references/empirical-research.md). Do not silently force literature-only or purely theoretical work into an empirical receipt model.
- When `$configure-koni` delegates design, return an explicit ontology/rule/ticket/proof proposal and wait for its approval boundary before editing files.

## Preserve the paradigm

- Keep the compiler deterministic and agents creative. Put selection, predicates, scope, authority, transitions, and effects in typed configuration; put investigation and synthesis in persona instructions and workflow steps.
- Prefer a small connected ontology over a large checklist. Create a node only when its identity, lifecycle, relationships, or evidence matters independently.
- Store each semantic fact once. Use a canonical bidirectional edge with an inverse alias when both endpoints need natural traversal; never require reciprocal stored edges for the same fact.
- Express dependencies as edges or workflow DAG dependencies. Do not rely on ticket titles or prompt wording for ordering.
- Derive work from unmet graph conditions. Do not hand-author a permanent ticket queue that can drift from semantic state.
- Make every ticket's read scope, write scope, read paths, and write paths as narrow as the work permits.
- Separate authority from intent: a rule requests work, an operation grants graph-change authority, a workflow defines required outputs, and an action performs effects.
- Require current evidence. Bind checks and receipts to exact inputs so changed graph or filesystem state invalidates stale proof.
- Discover commands and paths from the repository. Never preserve a baseline command, package manager, or directory assumption that the project does not own.

## Build one vertical slice first

Implement one end-to-end slice before expanding the model:

1. Define the target node and its statuses.
2. Define legal edges and a query for candidates.
3. Define a rule whose predicate distinguishes missing from satisfied state.
4. Emit a ticket with explicit target/read/write scope and paths.
5. Register the operation with only the required node authority.
6. Define the smallest workflow that can author and independently review the result. Use a direct specialist producer followed by review when one agent can submit the complete typed delta; add integration only for genuine multi-producer composition.
7. Recompile twice: expect one deterministic ticket for the gap and no duplicate after satisfaction.

> **Superseded by — Software default 0.4.0 (2026-07-14):** Earlier guidance required every vertical slice to use “synthesis, integration, and independent review.” The current Software default retains independent review but removes mandatory synthesis and Integrator transcription. This keeps semantic acceptance independent while avoiding extra model boundaries that add no authority or evidence. Profiles with genuinely independent producer outputs may still require an Integrator explicitly.

## Reject weak models

- Reject node types with no authored description or meaningful lifecycle.
- Reject free-form executable expressions, unbounded traversal, cyclic dependencies, or references to unknown types, relations, queries, operations, workflows, personas, actions, or checks.
- Reject broad filesystem paths or graph permissions added merely to silence validation.
- Reject workflow success that lacks required output, current check receipts, or independent review.
- Reject agent writes to compiler-owned fields and irreversible action recipes without prior validation plus compensation or recovery.
- Reject domain vocabulary in runtime control stages when it belongs in the semantic profile.

Use `$configure-koni` when the main task is selecting configuration layers, run types, models, or native agent resources rather than designing the semantic work graph.
