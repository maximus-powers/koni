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

Keep approval before orchestration. Use literal sibling Git ref leaves. Validate every cataloged run
type, not only the default.
