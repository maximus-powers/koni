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

## Workspace readiness

Fresh managed worktrees do not inherit ignored repository toolchains. When configured checks need
repository-local tooling, configure `workspace.bootstrap` on the common run type with one
repository-native, noninteractive, lock-bound setup command. The authority runs its direct `argv`
once after materializing the run worktree and each new ticket worktree.

Treat manifests, continuous-integration configuration, and existing worktree setup scripts as
authoritative evidence. When they identify one safe canonical setup path, select it without asking
the operator to restate the repository's own convention. Require the command to be idempotent,
bounded by a timeout, and limited to local workspace readiness. It must not prompt, acquire secrets,
publish, deploy, or perform unrelated external effects.

Do not put ecosystem-specific setup advice in an agent's instructions, and do not widen worker
filesystem, command, network, or graph authority to compensate for an unprepared worktree. If the
repository has no safe native setup command, keep workspace preparation an explicit configuration
boundary instead of teaching ticket agents to improvise one.

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

A reviewed ticket with all required steps complete and no supplied blocker is a compiler-managed
publication frontier. Require the Lead to count safe publication as closure-advancing even when no
worker assignment is ready. Its dependents still wait until publication makes the ticket completed;
the Lead must neither dispatch them early nor block merely because publication has not run yet.

For the current executable frontier, ticket dependencies are the ordering authority. Narrative
milestones do not create exclusive sequencing. Require planners to model a real wait as a typed
dependency and to describe independent safe preparation obligations as one concurrent frontier.
Require Leads to allow that safe frontier while retaining the all-dispatchable-work safety judgment.

Keep approval before orchestration. Use literal sibling Git ref leaves. Validate every cataloged run
type, not only the default.
