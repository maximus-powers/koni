# Rules and tickets

Make a rule a deterministic statement: for each candidate matching this predicate, derive this
semantic state and optionally emit this exact kind of work.

The examples use schema 3. Preserve `schema_version: "1.0"` only when the active catalog is an
unmigrated `.koni` profile; do not mix versions inside one profile.

## Gap-to-ticket example

```yaml
schema_version: "3.0"
module: { id: delivery.rules, version: "0.1.0" }

rules:
  - id: objective.plan-change
    phase: design
    priority: 80
    for_each: active-objectives
    bind: target
    when:
      all:
        - { op: edge_count, subject: $target, relation: systems, min: 1 }
        - { op: edge_count, subject: $target, relation: realized_by, exact: 0 }
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
          - traverse: { from: $target, relations: [systems, contracts, flows], max_depth: 2 }
      write_scope: $target
      read_paths:
        - {
            select: { traverse: { from: $target, relation: systems, max_depth: 1 } },
            field: spec.owned_paths,
          }
      workflow: change-design
      title: "Plan changes for {{ target.title }}"
```

Selectors and predicates may use typed node/query sets, bound variables, bounded traversal,
field/status tests, edge counts, set relations, quantified conditions, current checks/receipts, and
boolean composition. Require static resolution of every symbol.

## Ticket identity and reconciliation

Treat emitted tickets as compiler projections, not authored records. Their identity derives from
rule, targets, source state, and profile identity. Recompilation must preserve active work, avoid
duplicate tickets for the same gap, and retire an unstarted ticket when its source gap disappears.

Model progressive closure from the current executable frontier. State each progressive closure chain
in the supplied plan and tickets so a Lead need not infer hidden compiler facts: identify the unmet
obligation, the supported effect of current work, and the later work that effect can make eligible.
The partial frontier with a supported safe operation must proceed when every operation that may
dispatch now is also supported, safe, and within the approved plan. An absent downstream ticket that
supported current work can unlock must proceed rather than being mistaken for a missing path. A
closed frontier with no supported closure path must block. A mixed frontier with any potentially
dispatchable unsafe operation must block even when a safe sibling would advance closure. Preserve
these four cases in profile contract tests and pressure scenarios.

Include compiler-managed publication in the frontier model. A ticket in review with every required
step complete and no supplied blocker can advance closure through publication even when it has no
worker assignment. Keep its dependents waiting until the ticket becomes completed, but do not model
the transient review status itself as a deadlock. An incomplete or blocked review remains
nonpassing.

Ticket dependencies are the ordering authority for the current executable frontier; narrative
milestones do not create exclusive sequencing. Independent safe preparation obligations form one
concurrent frontier when no typed dependency makes one wait for another. Keep prose and graph
consistent: remove unsupported ordering language or model the genuine dependency.

Use `priority` to order rules and operation `dispatch_priority` for eligible work. Keep
human-oriented `ranking_hints` descriptive; do not expect them to execute arbitrary projections.

## Scope

- Use `target_nodes` for the semantic subjects of the operation.
- Use `read_scope` for graph context the ticket may inspect.
- Use `write_scope` for existing graph nodes it may propose changing.
- Use `read_paths` for contained project files the worker may inspect.
- Use `write_paths` for contained project files the product change may modify.

Project paths must be relative, contained, non-glob paths. Reject absolute paths, parent traversal,
drive-qualified paths, NULs, and scope escapes. A path may be literal or projected from an
authorized graph field.

Scope is not authority. The operation registry must separately allow every new node type, existing
node type, deletion, or special contract edit. Keep those permissions minimal.

Existing-node write scope does not govern new-node creation. An operation's `allowed_new_node_types`
and positive `max_new_nodes` grant the bounded authority to create those nodes, subject to the graph
schema and relationship checks. The absence of an authorized new node from the current graph or
`write_scope` is not scope broadening. Request change control only when the required node type,
count, relationship, existing-node edit, or special contract edit exceeds the issued operation
grant.

## Satisfaction test

Construct fixtures for:

1. a minimal graph that exhibits the gap and emits one ticket;
2. the same graph after the target relationship or field exists and emits none;
3. an unrelated node that must not match;
4. a malformed reference or unauthorized delta that must fail closed;
5. a stale receipt or changed file input that must reopen the obligation when freshness matters.
