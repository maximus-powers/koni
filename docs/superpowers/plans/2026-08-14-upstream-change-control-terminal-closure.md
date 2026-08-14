# Upstream Change-Control Terminal Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authenticated rejected configured check close through its exact compiled upstream
change-control route without weakening ordinary terminal receipt enforcement.

**Architecture:** Extend the durable terminal-policy union with a hash-bound upstream-change-control
semantic mode. Select it only from an exact compiled `upstream_request` result during
configured-action settlement; retain terminal replay, receipt evaluation, source preservation, and
atomic proposal/source-hold publication.

**Tech Stack:** TypeScript, Vitest, Koni RunAuthorityEngine, ProjectAuthorityStore.

## Global Constraints

- Do not weaken ordinary completed-output receipt closure.
- Do not treat a rejected check as a passing receipt.
- Bind the exception to the exact compiler-produced upstream change-control digest.
- Preserve legacy terminal-policy records without migration.
- Use test-first development and stage only files in this task.

---

### Task 1: Authenticate upstream terminal closure

**Files:**

- Modify: `packages/core/src/state/run-record.ts`
- Modify: `packages/core/src/authority/run-engine.ts`
- Test: `packages/core/test/run-authority-engine.test.ts`
- Test: `packages/core/test/change-control-authority-integration.test.ts`

**Interfaces:**

- Consumes: `RuntimeAssignmentChangeControlCompilation` and the configured action's exact
  `changeControlSha256`.
- Produces: a durable `AgentTerminalPolicyRecord` variant whose mode and hash bind the upstream
  change-control digest.

- [x] **Step 1: Write the failing production-shaped regression**

  Exercise a current rejected configured check followed by a schema-valid upstream request. Assert
  that the attempt completes with the new terminal-policy mode, a proposal is published, the source
  is held, and the run does not acquire an operator blocker. Retain negatives proving ordinary
  completion and foreign/missing check results fail.

- [x] **Step 2: Run the focused test and verify RED**

  Run the exact new Vitest case. Expect the current failure:
  `terminal closure is missing required receipt(s)`.

- [x] **Step 3: Add the durable policy variant**

  Extend `AgentTerminalPolicyRecord` and `assertAgentTerminalPolicyRecord` with exact-key and
  canonical-hash validation for an upstream-change-control semantic mode containing
  `changeControlSha256`, `projectionSha256`, `replayCompilationSha256`, `receiptEvaluationSha256`,
  `sourcePreservationSha256s`, and `acceptedAt`.

- [x] **Step 4: Select it only from exact compiled authority**

  Pass the recompiled upstream request into `#settleAssignmentTerminalPolicy`. Permit a nonempty
  missing-receipt set only for `kind === "upstream_request"`; bind its digest in the
  record/evidence. Keep ordinary calls unchanged. Use the same path in live finalization and cold
  recovery.

- [x] **Step 5: Run focused tests and verify GREEN**

  Run the new integration case, terminal-policy unit/integration cases, and configured-validation
  tests. Expect all to pass with no warnings.

- [x] **Step 6: Run Core checks and review**

  Run Core typecheck, lint/format checks for changed files, `git diff --check`, and a structured
  code review. Fix any Critical or Important findings before committing.

- [x] **Step 7: Commit the completed task**

  Stage only the two design documents, the two production files, and focused test files. Commit with
  `fix(core): close rejected checks through change control`.
