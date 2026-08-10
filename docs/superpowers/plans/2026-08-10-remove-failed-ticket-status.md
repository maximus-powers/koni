# Simplify Ticket Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and superpowers:test-driven-development. Complete tasks in order and do not write production code before the task's focused test has failed for the expected reason.

**Goal:** Replace the ticket-specific `todo` and `ready` states with one `queued` state, remove ticket-level `failed`, and delete the five disposable smoke runs that can contain the legacy values.

**Architecture:** `TicketStatus` is the fail-closed durable boundary and contains exactly `proposed | queued | running | review | blocked | completed | cancelled`. Profile lifecycle configuration, compilation, scheduling, authority, protocol, and TUI presentation all use the same vocabulary. Assignment failure remains a failed step inside a blocked ticket. There are no compatibility aliases or migrations.

**Tech Stack:** TypeScript 5.9, Node.js 22+, Vitest, YAML profile bundles, Koni authority RPC/TUI, Git managed worktrees and refs.

## Global Constraints

- Preserve `failed` for ticket steps, attempts, provider outcomes, checks, actions, journals, settlements, planning revisions, and run lifecycle phases.
- Preserve unrelated `ready` vocabularies such as Git lifecycle, authority readiness, provider/session readiness, transcript state, and graph/domain fields that are not ticket statuses.
- Delete only the five named smoke runs and their Koni-owned resources. Do not resume, merge, push, or publish them.
- Do not add a loader fallback, record migration, deprecated union member, protocol alias, or schema-version branch.
- Inspect `git status --short` and relevant diffs before every task. Preserve pre-existing changes and stage only task-owned hunks. Leave overlapping changes unstaged when safe isolation is impossible.
- Keep the Koni TUI visible in the left cmux panel.

---

### Task 1: Finish the clean-slate smoke-state reset

**State roots:**

- `/Users/max/Desktop/muat-haiku-acceptance-v8/.git/koni`
- `/Users/max/Desktop/updog-haiku-acceptance-v3/.git/koni`
- `/Users/max/Desktop/.koni-worktrees/muat-haiku-acceptance-v8-480379ca17ae9bd0/.koni-worktrees/runs`
- `/Users/max/Desktop/.koni-worktrees/updog-haiku-acceptance-v3-d93712837d35a807/.koni-worktrees/runs`

**Exact run IDs:**

- `run-6723c8fc-e17b-412c-a8c6-434c24d3e5af`
- `run-69b251cf-056f-4923-88f1-39a05dd3e43b`
- `run-6dd651cd-35d5-416e-8042-9376352fcae8`
- `run-851c1688-8ec3-4492-9d75-c538d6b22b91`
- `run-a9b634b6-b09b-47a7-9287-e1c1446d1317`

- [ ] Confirm all five authority deletions settled as `deleted`.
- [ ] Inventory exact run directories, Koni refs, and registered/managed worktrees before cleanup.
- [ ] Stop only the smoke-root TUI/authority process when necessary to reset its runtime namespace.
- [ ] Remove only worktrees and refs bound to the five exact run IDs. Preserve target branches and ordinary repository state.
- [ ] Move retained `.git/koni` runtime state to a recoverable backup location, recreate only the empty runtime layout required by Koni, and leave working-tree `.koni` profile configuration untouched.
- [ ] Restart the visible left-panel TUI and prove neither smoke root has a run record, Koni run ref, or managed run worktree for any of the five IDs.

No code commit is created for this operator-state task.

---

### Task 2: Contract the durable and configured lifecycle boundary test-first

**Files:**

- Modify: `packages/core/test/run-store-scheduler.test.ts`
- Modify: `packages/core/test/configured-lifecycle.test.ts`
- Modify: `packages/core/src/state/run-record.ts`
- Modify: `packages/core/src/authority/configured-lifecycle.ts`
- Modify: `packages/coding-profile/koni/baseline/lifecycle.yaml`
- Modify: `packages/research-profile/koni/baseline/rules/lifecycle.yaml`
- Modify: profile tests that assert lifecycle state names

- [ ] Add a durable-boundary test proving that `todo`, `ready`, and ticket-level `failed` are rejected, `queued` is accepted, and a blocked ticket with a failed step remains valid.
- [ ] Change configured-lifecycle tests to require `queued` as the initial state, the approval destination, the runnable semantic state, the unblock/interrupt/reopen destination, and a retiring state.
- [ ] Run only those new assertions and verify RED against the legacy vocabulary.
- [ ] Make `TicketStatus` and its parser allow-list exactly `proposed | queued | running | review | blocked | completed | cancelled`; keep the ticket-step allow-list unchanged.
- [ ] Rename only the profile-configured ticket lifecycle state `todo` to `queued`, including transitions and retirement rules. Update configured lifecycle mapping and validation accordingly.
- [ ] Run the focused store, configured-lifecycle, coding-profile, and research-profile tests and verify GREEN.
- [ ] Commit only isolated task-owned hunks when safe.

---

### Task 3: Preserve queued admission and compilation semantics test-first

**Files:**

- Modify: `packages/core/test/scheduler-change-control.test.ts`
- Modify: `packages/core/test/run-store-scheduler.test.ts`
- Modify: `packages/core/test/native-run-program.test.ts`
- Modify: `packages/core/src/state/scheduler.ts`
- Modify: `packages/core/src/state/change-control.ts`
- Modify: `packages/core/src/authority/project-store.ts`
- Modify: `packages/core/src/compiler/run-program.ts`
- Modify additional compiler/scheduler fixtures identified by typecheck

- [ ] Convert representative admission tests from both legacy waiting states to `queued`, and assert that queued tickets remain dependency-, grant-, and concurrency-gated exactly as before.
- [ ] Add or update compiler assertions proving executable, control, integration, proposal-approved, retry, rework, and reopened tickets are emitted or returned as `queued`.
- [ ] Run the focused assertions and verify RED before production edits.
- [ ] Replace ticket-specific `todo`/`ready` predicates and assignments with `queued` across scheduler, change control, project-store ticket snapshots, and compiler output.
- [ ] Remove ticket-level `failed` from terminal/source predicates; terminal failure evidence is a blocked ticket with a failed step.
- [ ] Preserve projection property names such as `ReadyAssignment` and `.ready` when they mean scheduler output rather than durable ticket status.
- [ ] Run focused scheduler, change-control, compiler, graph-rule, and typecheck checks and verify GREEN.
- [ ] Commit only isolated task-owned hunks when safe.

---

### Task 4: Update authority execution and recovery semantics test-first

**Files:**

- Modify: `packages/core/test/run-authority-engine.test.ts`
- Modify: `packages/core/test/change-control-authority-integration.test.ts`
- Modify: `packages/core/test/control-ticket-authority.test.ts`
- Modify: `packages/core/test/run-provider-authority.test.ts`
- Modify: `packages/core/src/authority/run-engine.ts`
- Modify: `packages/core/src/compiler/run-program.ts` if authority compilation paths overlap

- [ ] Update representative tests to prove approval, retry, bounded rework, resolver release, compiler revalidation, and interruption return tickets to `queued`.
- [ ] Prove failed assignment settlement remains `{ ticket.status: "blocked", step.status: "failed" }` and terminal recovery consumes that evidence.
- [ ] Run those focused assertions and core typecheck to verify RED from remaining legacy ticket comparisons/assignments.
- [ ] Replace ticket-specific waiting-state reads/writes with `queued` and remove ticket-level failed branches throughout run authority.
- [ ] Preserve attempt/provider/action/planning/run `failed` and Git/promotion `ready` state machines.
- [ ] Run focused authority integration tests and core typecheck; verify GREEN.
- [ ] Commit only isolated task-owned hunks when safe.

---

### Task 5: Rename operator protocol and TUI presentation test-first

**Files:**

- Modify: `packages/core/test/monitor-protocol.test.ts`
- Modify: `packages/core/test/control-center-view-model.test.ts`
- Modify: `packages/core/test/control-center-surfaces.test.ts`
- Modify: `packages/core/test/operator-surface.test.ts`
- Modify: `packages/core/src/authority/run-summary-page.ts`
- Modify: `packages/core/src/control-center/protocol.ts`
- Modify: `packages/core/src/control-center/view-model.ts`
- Modify: `packages/core/src/control-center/cockpit-config.ts`
- Modify: `packages/core/src/pi/interactive-tools.ts`
- Modify public docs only where they name a ticket state

- [ ] Add/update protocol tests proving `queued` is accepted and `todo`, `ready`, and ticket-level `failed` are rejected.
- [ ] Update surface tests to require a `queued` ticket tab and prove there is no `todo` tab option.
- [ ] Represent failure attention as a blocked ticket and failed step, retaining recovery/error presentation.
- [ ] Run the focused assertions and verify RED.
- [ ] Update ticket-only parsing, summary counts, view-model filters, tab IDs/defaults/labels, interactive tools, and public ticket-state documentation.
- [ ] Preserve transcript/controller/Git uses of `ready` and all non-ticket failure presentation.
- [ ] Run focused protocol, summary, control-center, and operator tests and verify GREEN.
- [ ] Commit only isolated task-owned hunks when safe.

---

### Task 6: Complete repository verification and the invariant audit

- [ ] Search production and tests for ticket-status comparisons, assignments, parser lists, lifecycle states, TUI tabs, and fixtures containing `todo`, `ready`, or `failed`.
- [ ] Classify every remaining match. Fix only matches that are ticket-status vocabulary; preserve unrelated state machines and ordinary prose.
- [ ] Run all focused tests from Tasks 2-5.
- [ ] Run:

```bash
npm run typecheck --workspace @koni/core
npm run test --workspace @koni/core
npm run test --workspace @koni/coding-profile
npm run test --workspace @koni/research-profile
npm run typecheck
npm run build
git diff --check
```

- [ ] Repeat the two smoke-root inventories and prove no deleted run or owned resource reappeared; confirm `/Users/max/Desktop/updog` was untouched.
- [ ] Report the following invariant audit explicitly:

```text
TicketStatus is exactly proposed|queued|running|review|blocked|completed|cancelled: PASS/FAIL
Durable parser rejects todo, ready, and failed ticket states: PASS/FAIL
Configured profile lifecycle uses queued end to end: PASS/FAIL
Compiler emits queued for executable/control/integration work: PASS/FAIL
Scheduler admits queued tickets with existing gates preserved: PASS/FAIL
Failed assignment settles blocked ticket + failed step: PASS/FAIL
Terminal recovery consumes blocked-ticket failure evidence: PASS/FAIL
Protocol and TUI expose queued and no todo tab: PASS/FAIL
Non-ticket ready and failed vocabularies remain intact: PASS/FAIL
Five smoke runs and owned resources are absent: PASS/FAIL
No migration or compatibility alias was added: PASS/FAIL
```

- [ ] Commit any isolated audit-only correction when safe; otherwise leave overlapping changes unstaged and report them.
