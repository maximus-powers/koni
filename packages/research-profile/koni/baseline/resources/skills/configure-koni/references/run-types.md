# Run types

Treat each run type as one complete, reusable peer. A run selects exactly one peer and pins its resolved configuration.

The example below is schema 2. In an unmigrated schema-1 project, preserve its `schema_version`,
`.codex/koni` profile source, and `reasoning_effort` fields until explicit migration; never mix
current and legacy fields.

> **Evolving to — Software default 0.4.0 (2026-07-14):** Complete standalone peers remain the safest default for independent complexity envelopes such as Small, Medium, and Large. A focused intent preset may instead inherit one stable parent through explicit JSON-Pointer overrides when the intent should receive future parent fixes. The bundled `new-feature` and `bug-fix` presets inherit Medium and override only intake, planning language, and intentional parallelism.

> **Shared-profile clarification — 2026-07-17:** This reference is published for both bundled
> profiles. Coding includes the focused `new-feature` and `bug-fix` presets described above;
> Research intentionally includes only Small, Medium, and Large. A project-owned profile may add
> intent presets with the same explicit inheritance rules.

## Required structure

```yaml
schema_version: "2.0"
id: medium
title: Medium
description: Plan, implement, and verify a bounded change.
instructions:
  planning: |
    Surface only decisions that materially affect scope, architecture, safety, or verification.
profile:
  source: .koni/profile.yaml
intake:
  objective_field: goal
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
    sync:
      kind: target_sync
      title: Synchronize the selected target
    report:
      kind: action
      title: Build the report
      config: {action: report, automatic: true}
    promote:
      kind: promotion
      title: Authorize promotion to the selected target
  order: [intake, plan, approval, initialize, orchestrate, sync, verify, report, promote]
questions:
  policy: high_impact_only
  default_scope: run
git:
  # Keep this on a literal sibling of the ticket namespace to avoid Git leaf/prefix collisions.
  branch_template: "koni/runs/{{ run.id }}/integration"
  ticket_branch_template: "koni/runs/{{ run.id }}/tickets/{{ ticket.id }}/cycles/{{ cycle.id }}"
run_card:
  sections: [goal, pipeline, graph, tickets, checks, report]
agents:
  roles:
    planner: {model: gpt-5.6-sol, thinking_level: max}
    lead: {model: gpt-5.6-sol, thinking_level: xhigh}
    ticket_worker: {model: gpt-5.6-terra, thinking_level: high}
    reviewer: {model: gpt-5.6-sol, thinking_level: max}
  personas: {}
orchestration:
  auto_start: true
  max_parallel: 3
  compile_action: compile
  lead_action: spawn-lead
  report_action: report
promotion:
  conflict_operation: resolve-target-integration
```

## Authoring rules

- Name one required `string` or `text` field explicitly with `intake.objective_field`. Include every field exactly once in `intake.order`. Supported field types are `string`, `text`, `boolean`, `integer`, `number`, `choice`, `multi_choice`, `path`, and `json`. Give choice types a nonempty duplicate-free `options` list.
- Include every stage exactly once in `pipeline.order`. Use canonical `action`, `planning`, `approval`, `initialize`, `orchestration`, `checkpoint`, `target_sync`, `promotion`, `manual`, `handoff`, or `external_loop` kinds.
- Place planning stages only in the safe pre-approval prefix after compiler-owned intake and before an ordinary action or manual boundary.
- Use `interactive`, `high_impact_only`, or `autonomous` for question policy. Use the run scope unless a project explicitly needs ticket-scoped intake decisions.
- Include `run.id`, or both `run.slug` and `run.short_id`, in run branches. Ticket branches must include `run.id`, `ticket.id`, and `cycle.id` so retries and reissues cannot collide.
- Resolve model policy by intent: stage override, run-type persona override, run-type role, profile persona, then provider-neutral agent/default policy.
- Set positive parallelism. Keep it low for narrow changes and increase it only when ticket scopes can be disjoint.
- Preserve explicit approval before automatic execution.
- For a Git-enabled run that publishes product or research artifacts, synchronize the current target after orchestration, rerun verification and reporting against that composed head, and leave promotion as the final explicit operator boundary. Configure a conflict operation whose workflow forbids semantic graph mutation.

Inheritance exists for compatibility and expert authoring, but prefer complete standalone peers. Do not make users reason about runtime layering.

> **Superseded in part — Software default 0.4.0 (2026-07-14):** Keep the sentence above as the historical default, but do not duplicate a stable Medium pipeline merely to express feature or defect intent. For a derived preset, set `extends` and put every behavior change in ordered `overrides`; do not mix inline behavior with inheritance. Prefer one parent, a small override surface, and tests proving resolved ancestry plus exact inherited behavior. Use a standalone peer when lifecycle, approval topology, assurance, or execution policy differs materially.
