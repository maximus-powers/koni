# Executable Validation Ledger Implementation Plan

1. Add failing Coding-profile and shared-skill contract tests for the closed executable validation
   ledger and change-control preservation rule.
2. Add the smallest domain-neutral policy to the Coding planner, Software modeling reference, and
   execution-contract reference.
3. Publish a Coding patch release with coherent manifest, bundle digest, upgrade, package, and
   migration pins.
4. Run focused profile/skill tests, release checks, formatting, typecheck, and diff integrity.
5. Install the reviewed release and start a fresh Updog Coding smoke run. Confirm the approved plan
   either models every mandatory validation as a graph proof covered by already-applicable
   configured authority or reports a modeling gap; only discretionary validation may be marked
   nonbinding. Then observe the complete run through review and closure.

Do not modify Core compiler/runtime semantics or weaken reviewer evidence requirements.
