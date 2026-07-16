# Run types

Treat each run type as one complete, reusable peer. A run selects exactly one peer and pins its resolved configuration.

## Required structure

```yaml
schema_version: "1.0"
id: medium
title: Medium
description: Plan, implement, and verify a bounded change.
instructions:
  planning: |
    Surface only decisions that materially affect scope, architecture, safety, or verification.
profile:
  source: .codex/koni/profile.yaml
intake:
  fields:
    goal:
      label: Goal
      type: text
      required: true
  order: [goal]
pipeline:
  stages:
    intake:
      kind: action
      title: Validate intake
      config: {compiler_owned: true, action: planning.intake}
    plan:
      kind: planning
      title: Plan the work
      config: {persona: run-planner, prompt: Produce an implementation-ready plan.}
    approval: {kind: approval, title: Approve the plan}
    initialize: {kind: initialize, title: Initialize semantic work}
    orchestrate: {kind: orchestration, title: Execute compiled tickets}
    verify: {kind: checkpoint, title: Verify completion}
    report:
      kind: action
      title: Build the report
      config: {action: report, automatic: true}
  order: [intake, plan, approval, initialize, orchestrate, verify, report]
questions:
  policy: high_impact_only
  default_scope: run
git:
  branch_template: "koni/runs/{{ run.slug }}-{{ run.short_id }}"
  ticket_branch_template: "koni/runs/{{ run.id }}/tickets/{{ ticket.id }}"
run_card:
  sections: [goal, pipeline, graph, tickets, checks, report]
agents:
  roles:
    planner: {model: gpt-5.6-sol, reasoning_effort: xhigh}
    lead: {model: gpt-5.6-sol, reasoning_effort: xhigh}
    ticket_worker: {model: gpt-5.6-terra, reasoning_effort: high}
    reviewer: {model: gpt-5.6-terra, reasoning_effort: xhigh}
  personas: {}
orchestration:
  auto_start: true
  max_parallel: 3
  compile_action: compile
  lead_action: spawn-lead
  report_action: report
```

## Authoring rules

- Include every field exactly once in `intake.order`. Supported field types are `string`, `text`, `boolean`, `integer`, `number`, `choice`, `multi_choice`, `path`, and `json`. Give choice types a nonempty duplicate-free `options` list.
- Include every stage exactly once in `pipeline.order`. Use `action`, `planning`, `orchestration`, `agent_review`, `external_loop`, `question`, `manual`, or `checkpoint`; compatibility aliases may exist, but prefer canonical kinds in new configuration.
- Place planning stages only in the safe pre-approval prefix after compiler-owned intake and before an ordinary action or manual boundary.
- Use `interactive`, `high_impact_only`, or `autonomous` for question policy. Use the run scope unless a project explicitly needs ticket-scoped intake decisions.
- Include `run.id` or `run.short_id` in run branches. Include `ticket.id` in ticket branches.
- Resolve model policy by intent: stage override, run-type persona override, run-type role, profile persona, then native Codex/default policy.
- Set positive parallelism. Keep it low for narrow changes and increase it only when ticket scopes can be disjoint.
- Preserve explicit approval before automatic execution.

Inheritance exists for compatibility and expert authoring, but prefer complete standalone peers. Do not make users reason about runtime layering.
