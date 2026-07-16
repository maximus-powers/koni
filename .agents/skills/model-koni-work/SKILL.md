---
name: model-koni-work
description: Design or revise Köni's graph-compiled work model. Use when Codex needs to define project ontology, node and edge types, queries, structured rules, ticket emission, operations, workflows, checks, actions, receipts, reports, cockpit views, or lifecycle policy under `.codex/koni`; translate a real-world process into graph gaps and executable tickets; or debug why work is missing, duplicated, blocked, stale, or over-authorized.
---

# Model Köni Work

Model desired outcomes and their missing semantic obligations as a graph, then compile those gaps into bounded, reviewable tickets.

## Design from outcomes backward

1. State the root outcome, success evidence, and scope boundary in domain language.
2. Identify durable facts and decisions that agents must share. Represent those as typed nodes and relationships, not prompt prose.
3. Identify observable gaps between current and desired graph state. Represent those as structured rules.
4. Give each actionable gap one public operation, a narrow authority contract, and a dependency-aware workflow.
5. Attach checks, receipts, review, and integration boundaries that prove completion.
6. Add reports or cockpit views only after the underlying graph and ticket data are authoritative.
7. Validate with `koni validate-profile .codex/koni/profile.yaml` and exercise at least one positive and one already-satisfied graph state.

Read [graph-model.md](references/graph-model.md) when defining ontology. Read [rules-and-tickets.md](references/rules-and-tickets.md) when compiling gaps. Read [execution-contracts.md](references/execution-contracts.md) when granting authority or defining workflow effects.

## Preserve the paradigm

- Keep the compiler deterministic and agents creative. Put selection, predicates, scope, authority, transitions, and effects in typed configuration; put investigation and synthesis in persona instructions and workflow steps.
- Prefer a small connected ontology over a large checklist. Create a node only when its identity, lifecycle, relationships, or evidence matters independently.
- Express dependencies as edges or workflow DAG dependencies. Do not rely on ticket titles or prompt wording for ordering.
- Derive work from unmet graph conditions. Do not hand-author a permanent ticket queue that can drift from semantic state.
- Make every ticket's read scope, write scope, read paths, and write paths as narrow as the work permits.
- Separate authority from intent: a rule requests work, an operation grants graph-change authority, a workflow defines required outputs, and an action performs effects.
- Require current evidence. Bind checks and receipts to exact inputs so changed graph or filesystem state invalidates stale proof.

## Build one vertical slice first

Implement one end-to-end slice before expanding the model:

1. Define the target node and its statuses.
2. Define legal edges and a query for candidates.
3. Define a rule whose predicate distinguishes missing from satisfied state.
4. Emit a ticket with explicit target/read/write scope and paths.
5. Register the operation with only the required node authority.
6. Define a workflow with synthesis, integration, and independent review.
7. Recompile twice: expect one deterministic ticket for the gap and no duplicate after satisfaction.

## Reject weak models

- Reject node types with no authored description or meaningful lifecycle.
- Reject free-form executable expressions, unbounded traversal, cyclic dependencies, or references to unknown types, relations, queries, operations, workflows, personas, actions, or checks.
- Reject broad filesystem paths or graph permissions added merely to silence validation.
- Reject workflow success that lacks required output, current check receipts, or independent review.
- Reject agent writes to compiler-owned fields and irreversible action recipes without prior validation plus compensation or recovery.
- Reject domain vocabulary in runtime control stages when it belongs in the semantic profile.

Use `$configure-koni` when the main task is selecting configuration layers, run types, models, or native agent resources rather than designing the semantic work graph.
