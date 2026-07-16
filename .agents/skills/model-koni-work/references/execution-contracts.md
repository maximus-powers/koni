# Execution contracts

Connect emitted intent to bounded execution through operations, workflows, checks, and actions.

## Operation authority

```yaml
operations:
  - id: design.objective.plan-change
    operation: plan-change
    stage: design
    target_types: [objective]
    workflow: change-design
    allowed_new_node_types: [change, migration, risk, proof, decision]
    allowed_existing_node_types: [objective, system, interface, contract, flow]
    review_contract: Every delta has ownership, risk, dependencies, and proof obligations.
    output_contract: Bounded current-to-target plan linked to affected architecture.
    dispatch_priority: 20
```

Use the public `operation` name in rule emission and workflow applicability. Use the registry `id` for a stable project-owned definition. Allow only node types the operation genuinely needs. Add deletion, gate-contract, edge-addition-only, receipt-coverage, or review-effect authority only for a concrete invariant.

## Workflow DAG

```yaml
workflows:
  - id: change-design
    version: 1.0.0
    applies_to: [plan-change]
    steps:
      - id: analyze-impact
        persona: change-designer
        expected_output: Current-to-target deltas and affected architecture
      - id: model-risk
        persona: risk-analyst
        depends_on: [analyze-impact]
        expected_output: Risks, migrations, and proof requirements
      - id: integrate
        kind: integration
        persona: integrator
        depends_on: [model-risk]
        expected_output: Coherent dependency-ordered graph delta
      - id: review
        kind: review
        persona: reviewer
        depends_on: [integrate]
        expected_output: Feasibility, scope, and completeness verdict
        validation_action: review
```

Make step IDs stable. Declare dependencies, persona, expected output, checks, required receipts, and review/rework boundaries explicitly. Require integration and independent review for product-affecting or semantic-acceptance work. Do not accept an output for an undeclared step or wrong persona.

## Checks and freshness

Use `kind: command` for deterministic argv-only verification and `kind: agent` only when semantic observation cannot be reduced to a command. Declare applicable operations, contained working directory, timeout, effect, environment allowlist, receipt type, and typed result protocol when needed.

Bind receipts to exact graph targets, command contract, argv inputs, relevant file hashes, and profile identity. Treat input mutation during a check as an invalid contract. Permit a nonpassing receipt only when failure is useful durable evidence rather than transaction failure.

For test-driven implementation, make the focused argv part of the graph-backed
change contract. Run it once from a test-only workflow step whose configured
`expected_exit_codes` accepts the project's ordinary assertion-failure code and
requires a distinct expected-red receipt with `receipt_freshness: historical`.
That receipt remains causal only when its integrity, ticket binding, exact
command, accepted exit code, and explicit test-step reference survive; later
product edits are allowed to stale its old filesystem snapshot. Run the same
bound argv later with the conventional `[0]` acceptance and current freshness,
and require its green receipt before review.
Record the behavior conditions, expected red signal, why the failure proves the
missing behavior, and what the focused test does not prove. A nonzero process
alone is not semantic red evidence: review must reject environment failures,
unrelated regressions, vacuous assertions, and tests weakened between receipts.

## Actions and effects

Define actions as ordered recipes over supported engine primitives. Validate before durable or irreversible effects. Add compensation for reversible partial work and a recovery action for irreversible work. Avoid validation-invalidating writes after the last validation boundary.

Keep these roles distinct:

| Mechanism | Responsibility |
| --- | --- |
| Rule | Detect a gap and request work |
| Operation | Authorize graph and product scope |
| Workflow | Define agent steps and evidence dependencies |
| Check | Produce current typed proof |
| Action | Perform audited state, process, filesystem, or Git effects |
| Review | Independently accept or reject work |
| Report/view | Project authoritative state for people |
