# Run types

A run type is one complete selectable behavior, not a runtime mixin. One optional compile-time
parent is appropriate for a narrow intent preset; the resolved child must remain complete.

```yaml
schema_version: "3.0"
id: medium
title: Medium
description: A standard multi-component change.

profile:
  source: .koni/profile.yaml

intake:
  objective_field: goal
  fields:
    goal: { label: Goal, type: text, required: true }
  order: [goal]

pipeline:
  stages:
    plan:
      kind: planning
      title: Plan the change
      config:
        agent: run-planner
        prompt: Produce an implementation-ready plan.
    approval: { kind: approval, title: Approve the plan }
    orchestrate: { kind: orchestration, title: Execute compiled work }
  order: [plan, approval, orchestrate]

questions:
  policy: high_impact_only
  default_scope: run

agents:
  roles:
    planner: { model: gpt-5.6-sol, thinking_level: max }
    lead: { model: gpt-5.6-sol, thinking_level: xhigh }
    ticket_worker: { model: gpt-5.6-terra, thinking_level: high }
    reviewer: { model: gpt-5.6-sol, thinking_level: max }
  overrides:
    run-planner: { thinking_level: xhigh }

orchestration:
  auto_start: true
  max_parallel: 3
  compile_action: compile
  lead_action: spawn-lead
  report_action: report
```

Use `agents.roles` for all agents sharing a Koni role and `agents.overrides` for one named
exception. These are model selections, not skill or capability bindings. Skills and capabilities
belong to the agent document.

Lead instructions must judge a progressively compiled board from its current executable frontier.
Require the planner to state each progressive closure chain in the supplied plan and tickets: which
current effect satisfies an obligation directly or makes later compiler work eligible. Require the
Lead to use only supplied plan, ticket, and evidence facts instead of inferring hidden graph, rule,
scheduler, or operation state. Define potentially dispatchable conservatively from supplied ticket
statuses and dependencies, including uncertain tickets in the safety judgment. The Lead may proceed
only when at least one current operation advances a stated closure chain and every operation that
deterministic authority could dispatch now is supported, safe, and within the approved plan. It must
block a closed frontier and any mixed frontier containing potentially dispatchable unsafe or
materially ambiguous work. Do not require the current board to contain an eventual downstream ticket
that supported current work can cause reconciliation to derive.

For the current executable frontier, ticket dependencies are the ordering authority. Narrative
milestones do not create exclusive sequencing. Require planners to model a real wait as a typed
dependency and to describe independent safe preparation obligations as one concurrent frontier.
Require Leads to allow that safe frontier while retaining the all-dispatchable-work safety judgment.

Keep approval before orchestration. Use literal sibling Git ref leaves. Validate every cataloged run
type, not only the default.
