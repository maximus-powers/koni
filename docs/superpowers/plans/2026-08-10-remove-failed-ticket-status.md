# Remove Failed Ticket Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `failed` from Koni's durable ticket status vocabulary after deleting the five disposable smoke-test runs that can contain the legacy value.

**Architecture:** Koni will represent assignment failure only as a failed ticket step inside a blocked ticket. The durable record parser is the fail-closed boundary, while scheduler, authority, protocol, and TUI projections consume the reduced `TicketStatus` union without compatibility aliases or migrations.

**Tech Stack:** TypeScript 5.9, Node.js 22+, Vitest, Koni authority RPC/TUI, Git managed worktrees and refs.

## Global Constraints

- Preserve `failed` for ticket steps, attempts, provider outcomes, checks, actions, journals, settlements, planning revisions, and run lifecycle phases.
- Delete only the five named smoke runs and their Koni-owned run resources; do not resume, merge, push, or publish a smoke run.
- Do not add a loader fallback, record migration, deprecated union member, protocol alias, or schema version branch.
- Inspect `git status --short` and the relevant file diffs before every task.
- Preserve all pre-existing worktree changes. Stage only files whose task-owned hunks can be isolated; if overlapping pre-existing edits make that unsafe, leave the task changes unstaged and report the overlap.
- Do not use destructive Git commands.
- Keep the Koni TUI visible in the left cmux panel while operator actions run.

---

### Task 1: Retire the disposable smoke-run state

**Files:**
- Delete through authority: `/Users/max/Desktop/muat-haiku-acceptance-v8/.git/koni/runs/run-6723c8fc-e17b-412c-a8c6-434c24d3e5af`
- Delete through authority: `/Users/max/Desktop/muat-haiku-acceptance-v8/.git/koni/runs/run-69b251cf-056f-4923-88f1-39a05dd3e43b`
- Delete through authority: `/Users/max/Desktop/muat-haiku-acceptance-v8/.git/koni/runs/run-6dd651cd-35d5-416e-8042-9376352fcae8`
- Delete through authority: `/Users/max/Desktop/updog-haiku-acceptance-v3/.git/koni/runs/run-851c1688-8ec3-4492-9d75-c538d6b22b91`
- Delete through authority: `/Users/max/Desktop/updog-haiku-acceptance-v3/.git/koni/runs/run-a9b634b6-b09b-47a7-9287-e1c1446d1317`
- Verify managed namespace: `/Users/max/Desktop/.koni-worktrees/muat-haiku-acceptance-v8-480379ca17ae9bd0/.koni-worktrees/runs`
- Verify managed namespace: `/Users/max/Desktop/.koni-worktrees/updog-haiku-acceptance-v3-d93712837d35a807/.koni-worktrees/runs`

**Interfaces:**
- Consumes: `run.deletion.inspect({ runId })` and `run.delete({ runId, mode: "delete_owned_branches", previewToken })` through the supported Koni operator surface.
- Produces: both smoke roots with zero durable run records, zero Koni refs containing any of the five exact run IDs, and zero managed run worktrees for those IDs.

- [ ] **Step 1: Capture the exact pre-delete inventory without mutating it**

```bash
git status --short
for root in /Users/max/Desktop/muat-haiku-acceptance-v8 /Users/max/Desktop/updog-haiku-acceptance-v3; do
  find "$root/.git/koni/runs" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | sort
  git -C "$root" for-each-ref --format='%(refname)' 'refs/koni/**'
  git -C "$root" worktree list --porcelain
done
```

Expected: the inventory contains only the five named run IDs in scope plus their Koni-owned refs/worktrees; ordinary branches and the main Updog checkout are recorded but not selected for deletion.

- [ ] **Step 2: Delete each Updog smoke run through the visible TUI**

In the left cmux panel, attach Koni to `/Users/max/Desktop/updog-haiku-acceptance-v3`. For each of these run IDs, select the run, press `d`, inspect the authority preview, choose `delete_owned_branches`, and confirm:

```text
run-851c1688-8ec3-4492-9d75-c538d6b22b91
run-a9b634b6-b09b-47a7-9287-e1c1446d1317
```

Expected: the authority accepts each preview token, retires any live provider process, removes owned run worktrees/branches/refs, and settles the run deletion.

- [ ] **Step 3: Delete each MUAT smoke run through the visible TUI**

Reattach the left-panel TUI to `/Users/max/Desktop/muat-haiku-acceptance-v8`. Repeat the same inspect-and-confirm flow with `delete_owned_branches` for:

```text
run-6723c8fc-e17b-412c-a8c6-434c24d3e5af
run-69b251cf-056f-4923-88f1-39a05dd3e43b
run-6dd651cd-35d5-416e-8042-9376352fcae8
```

Expected: all three authority deletions settle without resuming, merging, pushing, or publishing any run.

- [ ] **Step 4: Prove the legacy state is gone**

```bash
for root in /Users/max/Desktop/muat-haiku-acceptance-v8 /Users/max/Desktop/updog-haiku-acceptance-v3; do
  find "$root/.git/koni/runs" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | sort
  git -C "$root" for-each-ref --format='%(refname)' 'refs/koni/**'
  git -C "$root" worktree list --porcelain
done
find /Users/max/Desktop/.koni-worktrees/muat-haiku-acceptance-v8-480379ca17ae9bd0/.koni-worktrees/runs -mindepth 1 -print 2>/dev/null
find /Users/max/Desktop/.koni-worktrees/updog-haiku-acceptance-v3-d93712837d35a807/.koni-worktrees/runs -mindepth 1 -print 2>/dev/null
```

Expected: no run directory, Koni ref, or managed worktree names any of the five IDs. Any unrelated non-run Git state is unchanged.

No code commit is created for this operator-state task.

---

### Task 2: Contract the durable ticket model test-first

**Files:**
- Modify: `packages/core/test/run-store-scheduler.test.ts`
- Modify: `packages/core/src/state/run-record.ts`
- Modify: `packages/core/src/authority/configured-lifecycle.ts`

**Interfaces:**
- Consumes: `DurableRunStore.create(record: RunRecord)` and `TicketRecord.status: TicketStatus`.
- Produces: `TicketStatus = "proposed" | "todo" | "ready" | "running" | "review" | "blocked" | "completed" | "cancelled"`; the record validator rejects a ticket-level `failed`, while `TicketStepStatus` still accepts `failed`.

- [ ] **Step 1: Write the failing durable-boundary test**

Add this test to `packages/core/test/run-store-scheduler.test.ts`:

```ts
it("rejects failed tickets while preserving failed-step evidence on blocked tickets", async () => {
  const root = await temporaryRoot();
  const store = await DurableRunStore.open(root);
  const legacy = runRecord();
  const legacyTicket = ticket("ticket-legacy-failed", 0, []);
  legacyTicket.status = "failed" as unknown as TicketRecord["status"];
  legacy.tickets[legacyTicket.id] = legacyTicket;

  await expect(store.create(legacy)).rejects.toThrow(/invalid ticket status/u);

  const current = runRecord();
  const blocked = ticket("ticket-blocked", 0, []);
  blocked.status = "blocked";
  blocked.blocker = "The boundary case is missing.";
  blocked.steps[0]!.status = "failed";
  current.tickets[blocked.id] = blocked;

  await expect(store.create(current)).resolves.toBeUndefined();
  expect((await store.get(current.id)).tickets[blocked.id]).toMatchObject({
    status: "blocked",
    blocker: "The boundary case is missing.",
    steps: [expect.objectContaining({ status: "failed" })],
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npx vitest run packages/core/test/run-store-scheduler.test.ts -t "rejects failed tickets"
```

Expected: FAIL because the current durable parser still accepts `legacyTicket.status === "failed"`.

- [ ] **Step 3: Remove `failed` from the durable type, parser, and lifecycle projection**

In `packages/core/src/state/run-record.ts`, make the union and parser allow-list exactly:

```ts
export type TicketStatus =
  | "proposed"
  | "todo"
  | "ready"
  | "running"
  | "review"
  | "blocked"
  | "completed"
  | "cancelled";
```

```ts
if (
  ![
    "proposed",
    "todo",
    "ready",
    "running",
    "review",
    "blocked",
    "completed",
    "cancelled",
  ].includes(value.status)
)
  throw new Error(`invalid ticket status: ${id}`);
```

Keep the step validator's exact list unchanged:

```ts
["pending", "running", "completed", "failed", "skipped"]
```

In `packages/core/src/authority/configured-lifecycle.ts`, remove only the ticket-level case:

```ts
case "blocked":
  return "blocked";
```

- [ ] **Step 4: Run the focused model and lifecycle tests and verify GREEN**

```bash
npx vitest run packages/core/test/run-store-scheduler.test.ts packages/core/test/configured-lifecycle.test.ts
```

Expected: PASS, including the new rejection/acceptance boundary and the existing failed-assignment assertions that require `ticket.status === "blocked"` and `step.status === "failed"`.

- [ ] **Step 5: Review and commit only task-owned hunks when safe**

```bash
git status --short
git diff -- packages/core/test/run-store-scheduler.test.ts packages/core/src/state/run-record.ts packages/core/src/authority/configured-lifecycle.ts
git add packages/core/test/run-store-scheduler.test.ts packages/core/src/state/run-record.ts packages/core/src/authority/configured-lifecycle.ts
git diff --cached --check
git commit -m "refactor: remove failed ticket status"
```

Expected: commit only if every staged hunk belongs to this task. If any file contains inseparable pre-existing edits, unstage the task and record the overlap for final reporting.

---

### Task 3: Remove ticket-level failure from scheduling and authority semantics

**Files:**
- Modify: `packages/core/src/state/scheduler.ts`
- Modify: `packages/core/src/authority/run-engine.ts`
- Modify: `packages/core/src/compiler/run-program.ts`
- Modify: `packages/core/test/change-control-authority-integration.test.ts`
- Test: `packages/core/test/run-store-scheduler.test.ts`
- Test: `packages/core/test/run-authority-engine.test.ts`
- Test: `packages/core/test/native-run-program.test.ts`

**Interfaces:**
- Consumes: blocked tickets with failed steps and `terminalFailureBinding(run, ticket)` evidence.
- Produces: terminal ticket predicates limited to `completed | cancelled`; terminal-recovery source predicates limited to `blocked`; failed assignment settlement remains `{ ticket.status: "blocked", step.status: "failed" }`.

- [ ] **Step 1: Record the scheduler and authority mutations the focused tests must catch**

The behavior under test is:

```ts
expect(ticket.status).toBe("blocked");
expect(ticket.steps.find((step) => step.id === failedStepId)?.status).toBe("failed");
expect(terminalFailureBindingForBlockedTicket).toBeDefined();
```

Use the existing failed-assignment tests in `run-store-scheduler.test.ts` and terminal-resolver tests in `run-authority-engine.test.ts`. Replace any ticket fixture whose `TicketRecord.status` is `failed` with this concrete representation before running production edits:

```ts
ticket.status = "blocked";
ticket.blocker = "Resolver failure requires operator attention";
ticket.steps.at(-1)!.status = "failed";
```

Do not change attempt, outcome, journal, semantic-result, planning-revision, run-phase, or step-level `status: "failed"` fixtures.

- [ ] **Step 2: Run focused authority tests and verify RED from the reduced type**

```bash
npx vitest run packages/core/test/run-authority-engine.test.ts packages/core/test/native-run-program.test.ts packages/core/test/change-control-authority-integration.test.ts
npm run typecheck --workspace @koni/core
```

Expected: the tests or typecheck fail at production branches that still compare a `TicketStatus` with `"failed"`.

- [ ] **Step 3: Remove ticket-level `failed` branches from scheduler/compiler/authority code**

Apply these exact semantic reductions wherever the operand is a `TicketRecord.status`:

```ts
source.status === "blocked"
source.status !== "blocked"
ticket.status === "completed" || ticket.status === "cancelled"
ticket.status !== "completed" && ticket.status !== "cancelled"
ticket.status === "blocked"
```

Specifically update:

- `scheduler.ts`: terminal-resolver source validation and `ticketIsTerminal`.
- `run-engine.ts`: resolver candidates, resolver source release, rearm eligibility, scheduler nonterminal selection, inapplicable-ticket retirement, and resolver reconciliation terminal projection.
- `run-program.ts`: durable-ticket target deduplication terminal filtering.

Preserve every `step.status === "failed"`, failed assignment outcome, failed action/semantic result, failed attempt, and failed planning revision.

- [ ] **Step 4: Run focused scheduler/compiler/authority tests and verify GREEN**

```bash
npx vitest run packages/core/test/run-store-scheduler.test.ts packages/core/test/run-authority-engine.test.ts packages/core/test/native-run-program.test.ts packages/core/test/change-control-authority-integration.test.ts
npm run typecheck --workspace @koni/core
```

Expected: PASS with blocked-ticket terminal recovery and failed-step evidence intact.

- [ ] **Step 5: Review and commit only task-owned hunks when safe**

```bash
git status --short
git diff -- packages/core/src/state/scheduler.ts packages/core/src/authority/run-engine.ts packages/core/src/compiler/run-program.ts packages/core/test/change-control-authority-integration.test.ts packages/core/test/run-store-scheduler.test.ts packages/core/test/run-authority-engine.test.ts packages/core/test/native-run-program.test.ts
git add packages/core/src/state/scheduler.ts packages/core/src/authority/run-engine.ts packages/core/src/compiler/run-program.ts packages/core/test/change-control-authority-integration.test.ts packages/core/test/run-store-scheduler.test.ts packages/core/test/run-authority-engine.test.ts packages/core/test/native-run-program.test.ts
git diff --cached --check
git commit -m "refactor: use blocked tickets for assignment failures"
```

Expected: commit only isolated task-owned changes; otherwise leave them unstaged.

---

### Task 4: Remove ticket-level failure from operator projections and protocol parsing

**Files:**
- Modify: `packages/core/src/authority/run-summary-page.ts`
- Modify: `packages/core/src/control-center/protocol.ts`
- Modify: `packages/core/src/control-center/view-model.ts`
- Modify: `packages/core/src/pi/interactive-tools.ts`
- Modify: `packages/core/test/monitor-protocol.test.ts`
- Modify: `packages/core/test/control-center-view-model.test.ts`
- Test: `packages/core/test/run-summary-page.test.ts`
- Test: `packages/core/test/control-center-surfaces.test.ts`

**Interfaces:**
- Consumes: the reduced `TicketStatus` union and blocked ticket records.
- Produces: proposal protocol parsing rejects `failed`; summaries count ordinary blocked tickets; TUI recovery styling derives from blocked ticket state or failed steps.

- [ ] **Step 1: Add the failing protocol test**

Extend the existing proposal parser test in `packages/core/test/monitor-protocol.test.ts`:

```ts
expect(() =>
  parseControlProposalInspection({
    ...monitorProposalFixture(),
    status: "failed",
  }),
).toThrow(/proposal ticket status is invalid/u);
```

- [ ] **Step 2: Convert the failed-ticket view-model fixture to the current representation**

In `packages/core/test/control-center-view-model.test.ts`, replace the ticket-level failure fixture and expectation with:

```ts
proven.tickets["ticket-one"]!.status = "blocked";
proven.tickets["ticket-one"]!.blocker = "Verification failed";
proven.tickets["ticket-one"]!.steps[0]!.status = "failed";
expect(viewFor(proven).selectedRun?.overviewSections.at(-1)).toMatchObject({
  tone: "error",
  lines: ["Attention", "1 blocked ticket"],
});
```

- [ ] **Step 3: Run the protocol test and verify RED**

```bash
npx vitest run packages/core/test/monitor-protocol.test.ts -t "rejects invented proposal fields"
```

Expected: FAIL because `PROPOSAL_TICKET_STATUSES` still accepts `"failed"`.

- [ ] **Step 4: Remove ticket-level `failed` from projections and parsing**

Make `PROPOSAL_TICKET_STATUSES` exactly:

```ts
const PROPOSAL_TICKET_STATUSES = new Set<TicketStatus>([
  "proposed",
  "todo",
  "ready",
  "running",
  "review",
  "blocked",
  "completed",
  "cancelled",
]);
```

Reduce ticket projections to the current model:

```ts
ticket.status === "blocked" && !ticketWaitingForCompilerGrant(ticket)
```

Keep recovery presentation true when a blocked ticket or any failed step exists:

```ts
recovery:
  (ticket.status === "blocked" && !waitingForCompilerGrant) ||
  ticket.steps.some((step) => step.status === "failed") ||
  (halted && running)
```

Apply the same ticket-only reduction in `run-summary-page.ts` and `interactive-tools.ts`. Preserve failed check, attempt, run, and step presentation.

- [ ] **Step 5: Run focused projection/protocol tests and verify GREEN**

```bash
npx vitest run packages/core/test/monitor-protocol.test.ts packages/core/test/control-center-view-model.test.ts packages/core/test/run-summary-page.test.ts packages/core/test/control-center-surfaces.test.ts packages/core/test/operator-surface.test.ts
```

Expected: PASS; a blocked ticket with a failed step remains visible as recoverable attention, and `failed` is rejected only when parsed as a ticket status.

- [ ] **Step 6: Review and commit only task-owned hunks when safe**

```bash
git status --short
git diff -- packages/core/src/authority/run-summary-page.ts packages/core/src/control-center/protocol.ts packages/core/src/control-center/view-model.ts packages/core/src/pi/interactive-tools.ts packages/core/test/monitor-protocol.test.ts packages/core/test/control-center-view-model.test.ts packages/core/test/run-summary-page.test.ts packages/core/test/control-center-surfaces.test.ts packages/core/test/operator-surface.test.ts
git add packages/core/src/authority/run-summary-page.ts packages/core/src/control-center/protocol.ts packages/core/src/control-center/view-model.ts packages/core/src/pi/interactive-tools.ts packages/core/test/monitor-protocol.test.ts packages/core/test/control-center-view-model.test.ts packages/core/test/run-summary-page.test.ts packages/core/test/control-center-surfaces.test.ts packages/core/test/operator-surface.test.ts
git diff --cached --check
git commit -m "refactor: remove failed ticket presentation"
```

Expected: commit only isolated task-owned changes; otherwise leave them unstaged.

---

### Task 5: Complete the reference and invariant audit

**Files:**
- Modify only if audit finds a ticket-level fixture: `packages/core/test/**/*.ts`
- Verify: `packages/core/src/**/*.ts`
- Verify: `packages/core/test/**/*.ts`

**Interfaces:**
- Consumes: all changes from Tasks 1-4.
- Produces: a typechecked, built core package and an explicit classification of every remaining production `failed` reference.

- [ ] **Step 1: Inspect status and all remaining candidate references**

```bash
git status --short
rg -n 'ticket\.status === "failed"|ticket\.status !== "failed"|source\.status === "failed"|source\.status !== "failed"|currentSource\.status === "failed"|currentSource\.status !== "failed"' packages/core/src packages/core/test --glob '*.ts'
rg -n '"failed"' packages/core/src packages/core/test --glob '*.ts'
```

Expected: the ticket-specific query returns no matches. Classify every general match as step, attempt/provider, check/action/journal/settlement, planning revision, or run lifecycle. If a match is a `TicketRecord.status`, first convert its fixture to `status: "blocked"` plus a failed step, then rerun its focused test.

- [ ] **Step 2: Run all focused tests**

```bash
npx vitest run packages/core/test/run-store-scheduler.test.ts packages/core/test/configured-lifecycle.test.ts packages/core/test/run-authority-engine.test.ts packages/core/test/native-run-program.test.ts packages/core/test/change-control-authority-integration.test.ts packages/core/test/monitor-protocol.test.ts packages/core/test/control-center-view-model.test.ts packages/core/test/run-summary-page.test.ts packages/core/test/control-center-surfaces.test.ts packages/core/test/operator-surface.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run core repository checks**

```bash
npm run typecheck --workspace @koni/core
npm run test --workspace @koni/core
npm run build --workspace @koni/core
git diff --check
```

Expected: PASS. Any pre-existing failure must be rerun against the untouched baseline or tied to a pre-existing diff before it is reported as unrelated.

- [ ] **Step 4: Repeat the smoke-state proof after the new build**

```bash
for root in /Users/max/Desktop/muat-haiku-acceptance-v8 /Users/max/Desktop/updog-haiku-acceptance-v3; do
  find "$root/.git/koni/runs" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | sort
  git -C "$root" for-each-ref --format='%(refname)' 'refs/koni/**'
  git -C "$root" worktree list --porcelain
done
```

Expected: none of the five deleted run IDs has reappeared, and the main `/Users/max/Desktop/updog` checkout remains untouched.

- [ ] **Step 5: Produce the final invariant audit**

Report these results explicitly:

```text
TicketStatus excludes failed: PASS/FAIL
Durable parser rejects failed ticket status: PASS/FAIL
Blocked ticket with failed step is accepted: PASS/FAIL
Failed assignment settles blocked ticket + failed step: PASS/FAIL
Terminal recovery consumes blocked ticket failure evidence: PASS/FAIL
Control protocol rejects failed ticket status: PASS/FAIL
Ticket summaries and TUI use blocked/failed-step evidence: PASS/FAIL
Step/attempt/check/action/planning/run failed vocabularies remain: PASS/FAIL
Five smoke runs and owned resources are absent: PASS/FAIL
No migration or compatibility alias was added: PASS/FAIL
```

- [ ] **Step 6: Commit any isolated audit-only fixture correction when safe**

```bash
git status --short
git diff --check
git add packages/core/test/change-control-authority-integration.test.ts packages/core/test/control-center-view-model.test.ts packages/core/test/monitor-protocol.test.ts packages/core/test/native-run-program.test.ts packages/core/test/run-authority-engine.test.ts packages/core/test/run-store-scheduler.test.ts
git diff --cached --check
git commit -m "test: align ticket failure fixtures with blocked state"
```

Expected: omit this commit when no audit correction is needed or when pre-existing overlapping changes prevent safe staging. Never stage unrelated files.
