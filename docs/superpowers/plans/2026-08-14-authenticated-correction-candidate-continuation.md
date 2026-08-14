# Authenticated Correction Candidate Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and
> superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continue a correction ticket from its exact archived in-scope candidate without weakening
Git, compiler, or store authority.

**Architecture:** Add an append-only source-correction seed authority at the source-release CAS.
Bind it to the exact retired cycle, proposal/release, current compiler projection, and next epoch.
Teach ticket-cycle materialization to consume that seed only after archive, scope, and clean-merge
validation, and persist the consumed digest in the Git lifecycle.

**Tech Stack:** TypeScript, Vitest, Koni RunAuthorityEngine, ProjectAuthorityStore,
GitLifecycleAuthority.

## Global constraints

- Preserve blank run-head materialization for legacy and ineligible releases.
- Never continue repository bytes outside the successor's current write grant.
- Never use an unresolved merge or an unverified archive ref as a worker checkout.
- Keep compiler rules and profile instructions unchanged.
- Commit only the bounded lifecycle task after focused and full checks pass.

### Task 1: Bind source correction authority

**Files:**

- Modify: `packages/core/src/state/run-record.ts`
- Test: `packages/core/test/change-control-store-authority.test.ts`

- [x] Write RED transition tests for an eligible planned repair and for forged request, epoch,
      projection, release, and archive bindings.
- [x] Add the exact-key, canonical-hash source-correction authority and append-only mutation guard.
- [x] Re-run the focused store tests GREEN.

The exact pre/post-release transition and forgery matrix lives in the production-shaped authority
engine test, where both sides of the insertion CAS are available. The unchanged broader store suite
provides the surrounding transition-boundary coverage.

### Task 2: Materialize an authenticated candidate seed

**Files:**

- Modify: `packages/core/src/git/lifecycle.ts`
- Test: `packages/core/test/isolated-git-lifecycle.test.ts`

- [x] Write RED lifecycle tests for clean continuation plus archive mismatch, out-of-scope change,
      and merge conflict.
- [x] Validate the archive and candidate diff, create a clean seed commit on the current run head,
      and bind the authority digest in the Git intent and cycle.
- [x] Add crash-recovery coverage and run the focused lifecycle tests GREEN.

### Task 3: Release, replay, and preserve compatibility

**Files:**

- Modify: `packages/core/src/authority/run-engine.ts`
- Test: `packages/core/test/run-authority-engine.test.ts`

- [x] Write a production-shaped RED regression that archives one candidate, routes planned repair,
      releases to a new epoch, cold-restarts, and proves the successor workspace contains the prior
      candidate before the next provider attempt.
- [x] Install the correction authority in the existing release CAS and consume only the exact
      current-epoch seed in `#ensureTicketCycle`.
- [x] Keep rejected/generic cancellation and legacy releases on the existing blank path.
- [x] Run focused recovery, store, lifecycle, and authority-engine tests GREEN.

### Task 4: Review, verify, and replay MUAT

- [x] Run Core typecheck, lint, format, diff integrity, full affected suites, and independent
      review.
- [ ] Commit only the design, plan, production files, and focused tests.
- [ ] Install the sealed development bundle, restart both authorities, and immediately replay the
      MUAT correction flow while both TUIs remain visible.
