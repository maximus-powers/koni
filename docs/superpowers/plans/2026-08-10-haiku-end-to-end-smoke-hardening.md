# End-to-End Haiku Smoke Testing and Koni Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Apply superpowers:systematic-debugging and superpowers:test-driven-development
> to every harness defect.

**Goal:** Complete one Research and one Coding Haiku smoke run through orchestration, target
synchronization, verification, reporting, and merge readiness while hardening Koni from durable
failures.

**Architecture:** Resume the authenticated Research run, then create a replacement Coding run
because the historical Coding receipt cannot be safely reinterpreted. Run sequentially with the
active TUI in the left cmux panel. Preserve immutable run history and fix only demonstrated Koni
defects through focused red-green tests.

**Tech Stack:** TypeScript, Vitest, Node.js, Pi sessions, Anthropic Claude Haiku 4.5, Git worktrees,
pnpm, Python research commands, Ink TUI.

## Global Constraints

- Pin every Koni persona and attempt to `anthropic/claude-haiku-4-5` with medium thinking and no
  fallback.
- Preserve all unrelated changes in the shared Koni worktree; inspect status and relevant diffs
  before each hardening task.
- Do not manually implement MUAT or Updog product work.
- Permit compiler-authorized Research commands to use their configured timeout, but never access the
  sealed holdout.
- Stop both runs at `merge_ready`; do not run `koni merge`, push, or open a PR.
- Commit only isolated, complete Koni fixes whose focused tests pass; otherwise leave changes
  unstaged.

---

### Task 1: Establish the durable baseline and TUI

- Record Git state, runtime generation, run records, target OIDs, compiled model assignments, and
  pre-existing verification failures for Koni, MUAT, and Updog.
- Keep one TUI in the left cmux panel and point it at whichever sequential smoke run is active.
- Verify every compiled role is Haiku medium before resuming or approving work.

### Task 2: Complete Research run `run-69b251cf-056f-4923-88f1-39a05dd3e43b`

- Resume the existing authenticated planning attempt, Pi session, approved revision, and target.
- Follow orchestration through asset preparation, gates, empirical runtime, evidence, target sync,
  verification, report, and promotion readiness.
- Require reuse of existing `model_zoo`, stored-probe assets, development splits, scripts, results,
  and negative evidence. Allow only narrow protocol adapters, not replacement algorithms or
  datasets.
- Inspect questions and proposals deliberately. Reject sealed-holdout access, external effects, and
  scope expansion.
- At promotion, inspect the candidate diff and bound OIDs, then stop at `merge_ready`.

### Task 3: Create and complete a replacement Coding run

- Preserve historical run `run-a9b634b6-b09b-47a7-9287-e1c1446d1317` as immutable failure evidence.
- In `/Users/max/Desktop/updog-haiku-acceptance-v3`, create a new run from baseline `04e2dc...`
  targeting `smoke/haiku-coding-feature-20260810-v4`.
- Implement the Customer Analysis Overview tab through existing Updog layout, filter, component, and
  testing conventions without unrelated refactors.
- Approve revision 0 if complete; steer only for a material repository-integration, scope, testing,
  or risk defect.
- Let a missing ticket-worktree dependency produce typed infrastructure evidence, hydrate that exact
  worktree from the locked pnpm store, and explicitly resume. Never rewrite a historical receipt.
- Continue through target sync, verification, report, and promotion readiness; inspect the candidate
  and stop at `merge_ready`.

### Task 4: Harden each demonstrated Koni defect test-first

- Capture the exact run, ticket, attempt, check, transcript, TUI state, and Git evidence.
- Classify the failure as environment, product, prompt, compiler, scheduler, provider/session, Git,
  evidence, or TUI behavior.
- Find the root cause before proposing a fix.
- Write a focused failing test and verify the expected red.
- Implement the smallest Koni fix, verify focused green, and install the verified generation.
- Resume the same run only when immutable-state rules permit; otherwise preserve it and create a
  replacement run.
- Recheck the dirty Koni worktree before staging. Never include unrelated changes.

### Task 5: Verify the TUI and end-to-end architecture

- Confirm Authored Facts show values and list entries, not only field names.
- Confirm a selected ticket has no Plan tab.
- Confirm focused ticket steps expose useful status, attempt, check, blocker, timing, summary, and
  progress information.
- Audit planning continuity, cumulative provider accounting, scheduling priorities, questions,
  change control, worktree infrastructure handling, configured checks, evidence binding, target
  sync, reporting, and promotion safety.

### Task 6: Run final verification and invariant audits

```bash
npm exec --workspace @koni/core -- vitest run test/planning-artifact.test.ts test/pi-launch-spec.test.ts test/pi-managed-session.test.ts test/pi-attempt-process.test.ts test/native-run-program.test.ts test/run-lifecycle.test.ts test/run-authority-engine.test.ts test/run-provider-authority.test.ts test/monitor-protocol.test.ts test/control-center-surfaces.test.ts
npm run check --workspace @koni/core
npm run test:docs
npm run test:architecture
npm run test:profiles
npm run test:pi-host-boundary
npm run test:pi-package
npm run check
```

- Classify repository failures against the recorded baseline; no new failure is acceptable.
- Audit stable planning IDs, immutable revision checkpoints, cumulative usage and transcripts,
  Haiku-only attempts, durable terminal evidence, Koni-authored product changes,
  graph/Git/check/report binding, unchanged promotion targets, and absence of unresolved effects.
- Report run IDs and OIDs, changes, tests, pre-existing failures, deviations, token/runtime usage,
  defect classifications, architectural follow-ups, and final invariants.
