# Graph model

Use graph nodes for durable, independently meaningful project facts. Use edges for typed relationships whose direction and cardinality affect planning or validation.

## Node types

```yaml
schema_version: "1.0"
module: {id: delivery.graph, version: "0.1.0"}

node_types:
  - id: objective
    description: A desired outcome that gives a run its scope and success criteria.
    stage: framing
    required_any: [[outcome]]
    statuses: [draft, active, satisfied, superseded]
    compiler_owned_fields: [spec.planning_context]
    fields:
      outcome: {type: string, required: true}
      success_signals: {type: list}
      planning_context:
        type: object
        required: false
        description: Compiler-owned approved plan and resolved decisions.
  - id: change
    description: A bounded transition from current system behavior to a defined target state.
    stage: implementation
    required_any: [[target_state]]
    statuses: [planned, active, implemented, verified, superseded]
    fields:
      current_state: {type: string, required: true}
      target_state: {type: string, required: true}
      owned_paths: {type: list, required: true}
      blast_radius: {type: string, required: true}
```

Give every maintained node type a concise nonempty description explaining what it represents and when to create or update it. Declare fields, required alternatives, legal statuses, and compiler-owned fields explicitly. Keep agent-authored semantic fields distinct from readiness, receipts, manifests, acceptance stamps, and other compiler-owned state.

## Edge types

```yaml
edge_types:
  - {source: objective, relation: realized_by, targets: [change], min: 0}
  - {source: change, relation: realizes, targets: [objective], min: 1}
  - {source: change, relation: depends_on, targets: [change], acyclic: true}
  - {source: change, relation: affects, targets: [system, interface, contract], min: 1}
```

Use cardinality for real invariants. Mark dependency or containment relations acyclic. Define inverse relationships when both directions must remain consistent. Avoid decorative edges that never affect a query, rule, scope, report, or agent context.

## Queries

Name reusable candidate sets:

```yaml
queries:
  - id: active-objectives
    node_types: [objective]
    status_excluding: [satisfied, superseded]
  - id: planned-changes
    node_types: [change]
    statuses: [planned]
```

Use structured selectors to filter node types, statuses, fields, or predicates; reference bound variables; traverse typed relations with explicit depth and direction; and combine sets. Keep traversal bounded and cycle-safe. Keep selectors as YAML data, never code.

## Modeling test

For each type, answer:

- What stable identity distinguishes two nodes?
- Which statuses describe its lifecycle?
- Which relationships are required for validity?
- Which query finds nodes needing attention?
- Which evidence proves the terminal state?
- Who may create or update it, and through which operation?

Collapse the type into a field or workflow output if these answers do not justify independent lifecycle and relationships.
