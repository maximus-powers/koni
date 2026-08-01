# Compiler-Owned Asset Grants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make missing gate assets resolvable within their compiled operation envelope and stop presenting compiler-held source tickets as actionable failures.

**Architecture:** Keep Koni's existing graph-plan then filesystem-implementation protocol. Correct the research operation to authorize one graph asset, and make control-center/summary projections recognize a durable source hold as compiler waiting while preserving fail-closed state and strict Git/CAS ownership.

**Tech Stack:** TypeScript, Vitest, YAML research profile, Koni durable run records, Ink TUI view models

## Global Constraints

- Medium smoke runs only; never launch a large run.
- Preserve strict per-node CAS for agent-authored fields.
- Do not grant speculative project paths during graph-only asset planning.
- Do not rewrite immutable compiled configuration in an existing run.
- Do not read sealed MUAT holdout artifacts.
- Keep all changes uncommitted in the current Koni workspace.

---

### Task 1: Correct the compiled asset-planning envelope

**Files:**
- Modify: `packages/research-profile/koni/baseline/operations/research.yaml`
- Test: `packages/core/test/profile-package.test.ts`

**Interfaces:**
- Consumes: `assignmentMutationContract()` defaulting an absent `max_new_nodes` to zero.
- Produces: operation `asset-resolution.prerequisite.plan-build-asset` with `max_new_nodes: 1`.

- [ ] **Step 1: Write the failing profile test**

Load the built-in research profile and assert that
`asset-resolution.prerequisite.plan-build-asset.max_new_nodes` equals `1`, while
the operation defines no static read/write filesystem paths.

- [ ] **Step 2: Run the focused test and verify the zero-node envelope fails**

Run:
`pnpm --filter @koni/core test -- --run packages/core/test/profile-package.test.ts`

Expected: FAIL because `max_new_nodes` is absent.

- [ ] **Step 3: Add the minimal operation setting**

Add:

```yaml
  max_new_nodes: 1
```

to `asset-resolution.prerequisite.plan-build-asset`. Do not add path grants.

- [ ] **Step 4: Run the focused profile test**

Run:
`pnpm --filter @koni/core test -- --run packages/core/test/profile-package.test.ts`

Expected: PASS.

### Task 2: Project source holds as compiler waiting

**Files:**
- Modify: `packages/core/src/control-center/view-model.ts`
- Modify: `packages/core/src/authority/run-summary-page.ts`
- Test: `packages/core/test/control-center-surfaces.test.ts`
- Test: `packages/core/test/monitor-authority-projection.test.ts`

**Interfaces:**
- Consumes: `TicketRecord.executionControl.sourceHold`.
- Produces: `isCompilerGrantWait(ticket: TicketRecord): boolean`, waiting row labels,
  non-actionable overview counts, and summary blocked counts.

- [ ] **Step 1: Add failing surface assertions**

Create a blocked ticket with an exact `sourceHold` and matching proposal. Assert:

```ts
expect(overview.evidence.lines).not.toContain("1 blocked ticket");
expect(row.status).toBe("Waiting for compiler grant");
expect(row.recovery).toBe(false);
```

Also retain a separate ordinary blocked ticket assertion that remains in attention.

- [ ] **Step 2: Run the focused tests and verify the old blocked projection fails**

Run:
`pnpm --filter @koni/core test -- --run packages/core/test/control-center-surfaces.test.ts packages/core/test/monitor-authority-projection.test.ts`

Expected: FAIL because every durable blocked ticket is currently counted and labeled
as actionable.

- [ ] **Step 3: Implement the projection helper and use it consistently**

Add a small predicate based only on the durable source hold. Exclude matching tickets
from blocked attention and summary counts, label their row `Waiting for compiler
grant`, set `recovery: false`, and include them in the todo tab. Do not change durable
ticket status or proposal visibility.

- [ ] **Step 4: Run the focused surface tests**

Run:
`pnpm --filter @koni/core test -- --run packages/core/test/control-center-surfaces.test.ts packages/core/test/monitor-authority-projection.test.ts`

Expected: PASS.

### Task 3: Regression verification and live installation

**Files:**
- Verify: `packages/core/test/change-control-authority-integration.test.ts`
- Verify: `packages/core/test/native-run-program.test.ts`
- Verify: `packages/core/test/typed-graph.test.ts`

**Interfaces:**
- Consumes: corrected profile and projection behavior.
- Produces: installed generation used by the MUAT TUI.

- [ ] **Step 1: Run focused authority and graph regressions**

Run:
`pnpm --filter @koni/core test -- --run packages/core/test/change-control-authority-integration.test.ts packages/core/test/native-run-program.test.ts packages/core/test/typed-graph.test.ts`

Expected: PASS with strict graph/CAS behavior unchanged.

- [ ] **Step 2: Typecheck and build**

Run:
`pnpm --filter @koni/core typecheck && pnpm --filter @koni/core build`

Expected: both commands succeed.

- [ ] **Step 3: Install the verified development generation**

Run:
`KONI_DEV_FAST_INSTALL=1 ./scripts/install-dev.sh`

Expected: the generation fence durably pauses the active run and stops active
attempts without losing its `resumePhase`.

- [ ] **Step 4: Resume the same medium run through the TUI**

Start or reconnect the left-panel TUI, choose `Actions`, then `Resume run`. Verify
the run returns to `executing`, no large run is created, held source tickets no
longer inflate blocked attention, and the exact prior durable state continues.

