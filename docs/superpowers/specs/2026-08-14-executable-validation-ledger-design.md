# Executable Validation Ledger Design

## Problem

A Coding plan may describe a repository check or observation as a required completion gate without
representing it as a graph proof or configured check. Approval then makes that prose binding, while
the compiled implementation workflow has no authority to execute it or produce its receipt. Review
correctly rejects the missing evidence, but bounded rework cannot repair an authority gap and the
run deadlocks.

## Design

Planning must close one executable validation ledger across the complete artifact. Every mandatory
verification, risk treatment, success condition, or approval claim must resolve to a graph proof
whose compiled lifecycle can issue a current receipt or to an already-applicable configured check.
Configured checks remain profile-owned; a planning graph patch cannot create or edit them. Narrative
sections may summarize that authority but may not add another gate.

Small models need the invariant at the terminal boundary as well as in the general modeling method.
Immediately before submission, the planner scans every full and concise narrative section for
imperative validation language. Each obligation must identify its exact graph proof or
already-applicable configured check. An unbound discretionary instruction is deleted or moved to an
explicit nonbinding proof limit; an unbound mandatory instruction becomes an exact modeling gap.
Repository custom and familiar quality practices do not create executable authority by themselves.

Useful validation without executable authority has two valid dispositions:

1. Model the smallest graph proof covered by existing configured authority before dependent product
   work.
2. If and only if the validation is discretionary, record it as a nonbinding residual limit outside
   the approval claim.

A requirement from intake, the objective, a repository contract, a risk disposition, or an approval
contract may not be downgraded. When no existing configured check can issue its receipt, planning
must report the exact profile-modeling gap.

Change-control requests and application selections preserve the same invariant. They may carry
existing graph-backed obligations, but may not convert a recommendation into a mandatory prose-only
check. If a newly discovered validation obligation is necessary, the semantic correction must model
its graph proof under already-applicable configured authority or report an exact upstream modeling
gap.

## Placement

This is a profile-authoring invariant, not compiler scheduling policy. The reusable rule belongs in
`model-koni-work`; the Coding planner repeats the high-salience submission check for small models.
Compiler, reviewer, and ticket authority remain unchanged.

## Invariants

- Approval never binds a mandatory validation that deterministic orchestration cannot execute.
- Review continues to require current authenticated receipts for every binding obligation.
- Prose and terminal summaries never substitute for graph proof or configured-check authority.
- The rule is ecosystem-, language-, command-, and repository-neutral.
- Existing schema-3 Pi ownership remains unchanged.
- Terminal serialization cannot reintroduce an unbound gate after the graph ledger is closed.
