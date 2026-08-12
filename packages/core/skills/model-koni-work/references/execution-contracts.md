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

Use the public `operation` name in rule emission and workflow applicability. Use the registry `id`
for a stable project-owned definition. Allow only node types the operation genuinely needs. Add
deletion, gate-contract, edge-addition-only, receipt-coverage, or review-effect authority only for a
concrete invariant.

### Evidence-derived repository scope

Every pre-existing repository input or mutation target must appear verbatim in accepted repository
evidence. A successful parent-directory listing does not authenticate a guessed child, and a failed
lookup never authenticates the attempted path. A planned new output path is different: declare it as
new beneath an authenticated ownership or implementation root. Reconcile every path-bearing field
against that distinction before submission; resolve a missing exact target with one bounded lookup
or report the modeling gap.

Planning must materialize each discovered dependency in the exact graph field from which downstream
authority is projected. Bind the provider relationship and populate its typed path field before
approval. For example, a Research asset that consumes authenticated repository inputs records those
files in `spec.support_paths`, and each resolved prerequisite links to its provider through
canonical `satisfied_by`. A prose promise to resolve an already-discovered input later is not an
authority binding and leaves the deterministic fallback unable to recover the omitted scope.

Classify a missing resource against the owning result contract before requesting authority. If the
contract admits absence as a typed negative, incomplete, or inconclusive result, preserve that
result inside the issued boundary; do not convert it into a required dependency. Treat it as an
authority gap only when successful completion requires an existing resource outside the grant and
the contract has no valid absence branch. A lookup that establishes nonexistence supports absence
only at its authenticated boundary. A permission, scope, or transient failure establishes neither
absence nor that wider authority contains the resource.

Graph write authority does not make grant-affecting fields mutable within the current ticket. Once
an attempt is issued, fields that derive its read paths, write paths, working directory, command, or
workflow grant are frozen even when their containing node is writable. If current evidence
contradicts one, keep valid in-grant work and use the configured upstream-change route without a
graph delta. Target the existing causal node and request dynamic scope for any correction to the
grant-derived field; the replacement path's membership in the old grant does not make the field
mutable.

Separate repository effects from graph effects at the workflow boundary. A filesystem-only step must
declare graph mutation forbidden and omit the graph delta. Do not reconstruct or echo an existing
node merely to report unchanged authored fields: a complete-node upsert can silently alter an
unrelated field and therefore changes semantic authority. A later semantic integration step owns the
required graph mutation, reads the current node, and publishes only the intended authored contract
after the repository effect is verified.

## Workflow DAG

The following is the shipped Software 0.3 composition pattern, retained as historical context:

```yaml
workflows:
  - id: change-design
    version: 1.0.0
    applies_to: [plan-change]
    steps:
      - id: analyze-impact
        agent: change-designer
        expected_output: Current-to-target deltas and affected architecture
      - id: model-risk
        agent: risk-analyst
        depends_on: [analyze-impact]
        expected_output: Risks, migrations, and proof requirements
      - id: integrate
        kind: integration
        agent: integrator
        depends_on: [model-risk]
        expected_output: Coherent dependency-ordered graph delta
      - id: review
        kind: review
        agent: reviewer
        depends_on: [integrate]
        expected_output: Feasibility, scope, and completeness verdict
        validation_action: review
```

> **Superseded by — Software default 0.4.0 (2026-07-14):** Do not copy this four-step pattern as the
> universal Software workflow. It forced a risk agent and an Integrator to transcribe a delta even
> when one specialist could author it completely. Use the current direct pattern below, and compile
> malformed risk disposition into its own narrow repair ticket.

```yaml
workflows:
  - id: change-design
    version: 2.0.0
    applies_to: [plan-change]
    review_failure_reopen_from: design-change
    steps:
      - id: design-change
        agent: change-designer
        graph_mutation: required
        expected_output: Cohesive vertical changes with adaptive proof and material risk
      - id: review
        kind: review
        agent: reviewer
        graph_mutation: forbidden
        depends_on: [design-change]
        expected_output: Feasibility, scope, risk, and proof verdict
        validation_action: review
  - id: risk-treatment
    version: 1.0.0
    applies_to: [plan-risk-treatment]
    review_failure_reopen_from: plan-treatment
    steps:
      - id: plan-treatment
        agent: risk-analyst
        graph_mutation: required
        expected_output: One structural mitigate or accept disposition for the targeted risk
      - id: review
        kind: review
        agent: reviewer
        graph_mutation: forbidden
        depends_on: [plan-treatment]
        expected_output: Treatment feasibility and residual-risk verdict
        validation_action: review
```

Make step IDs stable. Declare dependencies, agent, expected output, checks, required receipts, and
review/rework boundaries explicitly. Require independent review for product-affecting or
semantic-acceptance work. Require integration only when the workflow composes genuinely independent
outputs or prepares an exact delivery set; do not use it as a universal transcription hop. Do not
accept an output for an undeclared step or wrong agent.

At a rework review boundary, the current authenticated predecessor execution and receipts are the
execution evidence for that review cycle. A prior failed-review blocker is repair history, not
current execution evidence. Re-evaluate its findings against the current candidate and current
receipts. Carry forward only a finding that the current candidate and current receipts still
establish; never describe a current receipt as stale merely because an earlier cycle used different
bytes or evidence.

For implementation, prefer one strategy-specific baseline step, implementation, independent
verification, then independent review. Keep tests and production behavior in the same vertical
ticket. Do not add separate testing, documentation, integration-assessment, or file-layer tickets
unless they carry an independently valuable outcome, authority boundary, evidence environment,
rollback path, or disjoint ownership scope.

> **Superseded for the Software default — 0.4.0 (2026-07-14):** Preserve the vertical-ticket and
> independent-review principles above, but do not copy its routine independent-Verifier hop. The
> proof node is the sole executable evidence authority: it owns the exact argv, source and covered
> paths, working directory, conditions, expected signal, rationale, and limits. The compiler derives
> the strategy-specific baseline and complete promotion set from those proof nodes, runs promotion
> before the implementation output can advance, and then sends the same candidate to read-only
> semantic review. Add a separate Verifier only for an independently valuable environment, authority
> boundary, recovery path, or evidence gap. See `software-projects.md` for the current Software
> lifecycle and proof topology.

## Checks and freshness

Use `kind: command` for deterministic argv-only verification and `kind: agent` only when semantic
observation cannot be reduced to a command. Declare applicable operations, contained working
directory, timeout, effect, environment allowlist, receipt type, and typed result protocol when
needed.

Bind receipts to exact graph targets, command contract, argv inputs, relevant file hashes, and
profile identity. Treat input mutation during a check as an invalid contract. Permit a nonpassing
receipt only when failure is useful durable evidence rather than transaction failure.

For a software change whose approved proof strategy is `red_green`, make the focused argv part of
the graph-backed change contract. Run it once from a test-only workflow step whose configured
`expected_exit_codes` accepts the project's ordinary assertion-failure code and requires a distinct
expected-red receipt with `receipt_freshness: historical`. That receipt remains causal only when its
integrity, ticket binding, exact command, accepted exit code, and explicit test-step reference
survive; later product edits are allowed to stale its old filesystem snapshot. Run the same bound
argv later with the conventional `[0]` acceptance and current freshness, and require its green
receipt before review. Record the behavior conditions, expected red signal, why the failure proves
the missing behavior, and what the focused test does not prove. A nonzero process alone is not
semantic red evidence: review must reject environment failures, unrelated regressions, vacuous
assertions, and tests weakened between receipts.

> **Authority clarification — Software 0.4.0 (2026-07-14):** The proof node, not a duplicate
> focused-check definition, now owns that argv and evidence contract. `baseline_check_id` selects
> how the compiler interprets the pre-change observation; compiler-derived baseline and promotion
> graph sets execute the selected proof commands. Require at least one genuinely expected-red proof
> for a `red_green` implementation subject. Additional focused proofs are allowed only when each
> covers a distinct evidence gap, remains scoped to that same single implementation subject, and
> uses its honest strategy—for example, a current integration baseline may supplement, but never
> substitute for, the causal expected-red proof.

> **Evolving to — Software 0.5.0 (2026-07-15):** The proof node now also owns structured
> `oracle_cases`. Each case binds condition and claim to the callable production seam or real
> consumer, exact `seam_paths`, action, assertions, and material environment/recipe. Every seam path
> must resolve to the same normalized project-relative identity present in read-only
> `covered_paths`; the compiler rejects the graph before dispatch otherwise. Do not derive proof
> capability from a linked system's broader `owned_paths`, and do not use a test-local
> implementation as the named production seam.

> **Evolving to — Software 0.6.0 (2026-07-16):** A red-green or characterization focused proof now
> authors and records its honest historical result in a separate source-only `proof.prepare` ticket,
> then crosses independent oracle-completeness review before product-write authority exists. The
> implementation baseline re-confirms those exact reviewed bytes read-only; final-review rework
> returns to product implementation and cannot revise the oracle. `current_verification` still uses
> its existing proof read-only and does not manufacture an authoring-preparation pass.

Mark the expected-red and focused implementation checks `composed_replay: never`: they are
ticket-local causal and correctness evidence, not necessarily safe or meaningful after target
composition. Give promotion-grade graph proof its own read-only registered command and current
receipt. A local green check may close the implementation ticket without pretending to establish the
whole composed run.

For `characterization`, preserve the reviewed pre-change observation as causal context but require
fresh post-change proof; do not treat a stale passing receipt as current. Use `current_verification`
only for a mechanical edit or already-correct behavior directly exercised by the exact focused check
both before and after the change. It cannot prove genuinely new behavior merely because an existing
suite stays green. Require an explicit explanation of why expected red or characterization is not
the honest strategy. Never manufacture a failure to make the history look test-driven.

Risk treatment is graph structure, not prose or a trusted status. A `mitigate` disposition must name
an actual change or migration and a proof that verifies the risk. An `accept` disposition must name
exactly one independently reviewed decision and no mitigation edge. Keep the two forms disjoint and
make implementation readiness and delivery evaluate the relationships directly.

## Actions and effects

Define actions as ordered recipes over supported engine primitives. Validate before durable or
irreversible effects. Add compensation for reversible partial work and a recovery action for
irreversible work. Avoid validation-invalidating writes after the last validation boundary.

Keep these roles distinct:

| Mechanism   | Responsibility                                             |
| ----------- | ---------------------------------------------------------- |
| Rule        | Detect a gap and request work                              |
| Operation   | Authorize graph and product scope                          |
| Workflow    | Define agent steps and evidence dependencies               |
| Check       | Produce current typed proof                                |
| Action      | Perform audited state, process, filesystem, or Git effects |
| Review      | Independently accept or reject work                        |
| Report/view | Project authoritative state for people                     |
