# Rules and tickets

Make a rule a deterministic statement: for each candidate matching this predicate, derive this semantic state and optionally emit this exact kind of work.

## Gap-to-ticket example

```yaml
schema_version: "1.0"
module: {id: delivery.rules, version: "0.1.0"}

rules:
  - id: objective.plan-change
    phase: design
    priority: 80
    for_each: active-objectives
    bind: target
    when:
      all:
        - {op: edge_count, subject: $target, relation: systems, min: 1}
        - {op: edge_count, subject: $target, relation: realized_by, exact: 0}
    derive:
      - kind: obligation
        key: objective.change-plan
        severity: blocking
        reason: Objective has no bounded change plan.
    emit:
      operation: plan-change
      source_state: objective-without-change-plan
      target_state: objective-has-bounded-change-plan
      obligations: [objective.change-plan]
      target_nodes: $target
      read_scope:
        union:
          - $target
          - traverse: {from: $target, relations: [systems, contracts, flows], max_depth: 2}
      write_scope: $target
      read_paths:
        - {select: {traverse: {from: $target, relation: systems, max_depth: 1}}, field: spec.owned_paths}
      workflow: change-design
      title: "Plan changes for {{ target.title }}"
```

Selectors and predicates may use typed node/query sets, bound variables, bounded traversal, field/status tests, edge counts, set relations, quantified conditions, current checks/receipts, and boolean composition. Require static resolution of every symbol.

## Ticket identity and reconciliation

Treat emitted tickets as compiler projections, not authored records. Their identity derives from rule, targets, source state, and profile identity. Recompilation must preserve active work, avoid duplicate tickets for the same gap, and retire an unstarted ticket when its source gap disappears.

Use `priority` to order rules and operation `dispatch_priority` for eligible work. Keep human-oriented `ranking_hints` descriptive; do not expect them to execute arbitrary projections.

## Scope

- Use `target_nodes` for the semantic subjects of the operation.
- Use `read_scope` for graph context the ticket may inspect.
- Use `write_scope` for existing graph nodes it may propose changing.
- Use `read_paths` for contained project files the worker may inspect.
- Use `write_paths` for contained project files the product change may modify.

Project paths must be relative, contained, non-glob paths. Reject absolute paths, parent traversal, drive-qualified paths, NULs, and scope escapes. A path may be literal or projected from an authorized graph field.

Scope is not authority. The operation registry must separately allow every new node type, existing node type, deletion, or special contract edit. Keep those permissions minimal.

## Satisfaction test

Construct fixtures for:

1. a minimal graph that exhibits the gap and emits one ticket;
2. the same graph after the target relationship or field exists and emits none;
3. an unrelated node that must not match;
4. a malformed reference or unauthorized delta that must fail closed;
5. a stale receipt or changed file input that must reopen the obligation when freshness matters.
