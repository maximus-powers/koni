# Upstream Change-Control Terminal Closure Design

## Problem

A configured check can return an authenticated current rejection that proves an assignment cannot
complete under its issued contract. The compiler can validly turn that evidence into an
`upstreamChangeRequest`, but the configured-action finalizer currently applies ordinary successful
terminal receipt closure before publishing the request. Because the rejected check intentionally
does not emit a passing success receipt, the run blocks at the authority boundary instead of opening
the configured proposal and holding the source ticket.

## Design

Keep ordinary completion fail-closed. A terminal policy may tolerate nonpassing required receipts
only when all of the following are true:

- the accepted output compiles to an exact `upstream_request` change-control result;
- the configured validation action records the exact change-control digest in its semantic result;
- every missing receipt type is backed by an integrity-valid failed configured-check result whose
  check identity, receipt type, execution-policy binding, configuration/catalog identity, current
  attempt, and current-output linkage exactly match the pinned assignment;
- terminal replay, source preservation, and all other terminal-policy integrity checks pass; and
- the terminal policy, its evidence, and the non-evictable terminal success proof all bind the exact
  upstream change-control digest.

Represent this as a distinct durable semantic policy mode rather than pretending rejected evidence
is a passing receipt. The ordinary `semantic` mode continues to require an empty missing-receipt
set. The new mode records the receipt evaluation, including its nonpassing result, and the exact
upstream change-control digest. Proposal publication and source hold remain in the existing atomic
assignment-settlement transaction.

## Recovery and compatibility

Recovery recompiles the immutable terminal artifact and must reproduce the same change-control
digest before selecting the new closure mode. Existing records remain valid without migration.
Direct assignments and configured assignments without an upstream request keep their current receipt
requirements.

## Verification

Add a production-shaped regression that submits a current rejected configured-check result with a
valid upstream request and proves the run publishes a proposal and holds the source rather than
blocking. Keep negative coverage for ordinary completion and foreign/missing check results. Add
record-validation coverage for the new exact-key, hash-bound terminal policy variant.
