# Core Architecture Renovation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Finish the TypeScript migration with clearer ownership around authority, durable state,
compiler construction, Pi process supervision, Git transactions, and terminal presentation while
preserving public and durable behavior.

**Architecture:** Large facade classes retain orchestration. Pure validation, serialization,
projection, and transition logic move to cohesive internal modules with explicit input/output types.
Extracted modules depend on contracts and leaf utilities, never on their former facade.

**Tech Stack:** TypeScript 5.9 strict mode, Node.js 22, Vitest 4, npm workspaces.

## Global Constraints

- Invoke `superpowers:test-driven-development` before each extraction group.
- A move is complete only when focused characterization tests, type-check, and lint pass.
- Preserve public exports unless a repository-wide consumer audit proves an export is internal.
- Preserve durable JSON/YAML shapes, hashes, error codes, and path policy.
- Avoid generic `utils.ts` modules and circular imports.

---

## Task 1: Establish architectural guardrails

**Files:**

- Create: `scripts/architecture-budget.test.mjs`
- Modify: `package.json`

**Step 1: Add a failing module-budget test**

The test reads authored production TypeScript and rejects:

- new production files above 2,500 lines;
- growth in grandfathered facades above their recorded baseline;
- imports from leaf modules back into their owning facade.

Represent grandfathered limits explicitly. Record the limits after the one-time Prettier
normalization, because physical line counts depend on formatting:

```js
const grandfathered = new Map([
  ["packages/core/src/authority/run-engine.ts", 19864],
  ["packages/core/src/compiler/configuration.ts", 2749],
  ["packages/core/src/compiler/run-program.ts", 13139],
  ["packages/core/src/control-center/component.ts", 4433],
  ["packages/core/src/control-center/controller.ts", 5957],
  ["packages/core/src/git/lifecycle.ts", 4517],
  ["packages/core/src/pi/attempt-process-supervisor.ts", 2584],
  ["packages/core/src/pi/managed-session.ts", 3799],
  ["packages/core/src/state/run-record.ts", 6134],
]);
```

Run:

```sh
node --test scripts/architecture-budget.test.mjs
```

Expected: FAIL until every newly extracted module stays beneath the budget and forbidden reverse
imports are removed.

**Step 2: Add `test:architecture`**

```json
"test:architecture": "node --test scripts/architecture-budget.test.mjs"
```

**Step 3: Commit guardrails**

```sh
git add scripts/architecture-budget.test.mjs package.json
git commit -m "test(architecture): guard core module boundaries"
```

---

## Task 2: Complete authority action and configuration seams

**Files:**

- Modify: `packages/core/src/authority/run-engine.ts`
- Modify: `packages/core/src/authority/action-execution.ts`
- Modify: `packages/core/src/authority/config-documents.ts`
- Modify: `packages/core/src/authority/configured-lifecycle.ts`
- Modify: `packages/core/src/authority/execution-policy.ts`
- Modify: `packages/core/src/authority/monitor-methods.ts`
- Modify: `packages/core/src/authority/monitor-projection.ts`
- Test: `packages/core/test/action-execution-authority.test.ts`
- Test: `packages/core/test/config-document-authority.test.ts`
- Test: `packages/core/test/configured-lifecycle.test.ts`
- Test: `packages/core/test/execution-policy-authority.test.ts`
- Test: `packages/core/test/monitor-authority-projection.test.ts`

**Step 1: Characterize each facade/extracted-module pair**

For every extracted function, assert equal output and equal structured error code for a valid case
and a rejected boundary case. Keep construction inputs immutable with `Readonly` types.

**Step 2: Remove duplicate implementations from `run-engine.ts`**

The facade may adapt RPC inputs and persist results. It must call the extracted modules for action
admission, configuration document mutation, configured lifecycle selection, execution-policy
binding, and monitor projection. No extracted module may import `run-engine.ts`.

**Step 3: Verify**

```sh
npm exec --workspace @koni/core -- vitest run \
  test/action-execution-authority.test.ts \
  test/config-document-authority.test.ts \
  test/configured-lifecycle.test.ts \
  test/execution-policy-authority.test.ts \
  test/monitor-authority-projection.test.ts \
  test/run-authority-engine.test.ts
npm run typecheck --workspace @koni/core
npm run lint
node --test scripts/architecture-budget.test.mjs
```

Expected: PASS; `run-engine.ts` does not grow.

**Step 4: Commit**

```sh
git add packages/core/src/authority packages/core/test
git commit -m "refactor(authority): isolate run policy and projections"
```

---

## Task 3: Localize durable run-state transitions

**Files:**

- Modify: `packages/core/src/state/run-record.ts`
- Modify: `packages/core/src/state/change-control.ts`
- Modify: `packages/core/src/state/effective-status.ts`
- Modify: `packages/core/src/state/question-batch.ts`
- Modify: `packages/core/src/state/question-policy.ts`
- Modify: `packages/core/src/state/stage-capability.ts`
- Test: `packages/core/test/change-control-store-authority.test.ts`
- Test: `packages/core/test/question-batch.test.ts`
- Test: `packages/core/test/question-policy.test.ts`
- Test: `packages/core/test/stage-capability.test.ts`
- Test: `packages/core/test/run-lifecycle.test.ts`

**Step 1: Add transition characterization tests**

For each extracted state operation, test valid transition, rejected stale revision, rejected
terminal mutation, and deterministic serialization.

**Step 2: Make `run-record.ts` the schema/compatibility facade**

Move state decision logic to the named state modules. Keep record types, parsing, compatibility
normalization, and durable serialization in `run-record.ts`. Each state module receives a record and
returns a new record or explicit patch; it must not perform filesystem I/O.

**Step 3: Verify**

```sh
npm exec --workspace @koni/core -- vitest run \
  test/change-control-store-authority.test.ts \
  test/question-batch.test.ts \
  test/question-policy.test.ts \
  test/stage-capability.test.ts \
  test/run-lifecycle.test.ts \
  test/run-store-scheduler.test.ts
npm run typecheck --workspace @koni/core
npm run lint
```

Expected: PASS.

**Step 4: Commit**

```sh
git add packages/core/src/state packages/core/test
git commit -m "refactor(state): localize durable run transitions"
```

---

## Task 4: Separate compiler graph and execution semantics

**Files:**

- Modify: `packages/core/src/compiler/run-program.ts`
- Modify: `packages/core/src/compiler/action-recipes.ts`
- Modify: `packages/core/src/compiler/execution-semantics.ts`
- Modify: `packages/core/src/compiler/graph-constraints.ts`
- Modify: `packages/core/src/compiler/ticket-dependencies.ts`
- Test: `packages/core/test/action-recipes.test.ts`
- Test: `packages/core/test/execution-semantics.test.ts`
- Test: `packages/core/test/graph-constraint-authority.test.ts`
- Test: `packages/core/test/native-run-program.test.ts`

**Step 1: Characterize compiled artifacts**

Compile the same fixture through the facade and leaf functions and compare canonical output hashes,
not object identity. Include invalid cycles, dangling dependencies, and conflicting action recipes.

**Step 2: Keep orchestration in `run-program.ts`**

The facade loads domain documents and assembles the final program. Recipe compilation, execution
semantics, graph constraints, and ticket dependency closure remain in their named modules. Leaf
modules may import contracts and canonical helpers but not `run-program.ts`.

**Step 3: Verify**

```sh
npm exec --workspace @koni/core -- vitest run \
  test/action-recipes.test.ts \
  test/execution-semantics.test.ts \
  test/graph-constraint-authority.test.ts \
  test/native-run-program.test.ts \
  test/rule-compiler.test.ts
npm run typecheck --workspace @koni/core
npm run lint
```

Expected: PASS; canonical compiled hashes are unchanged.

**Step 4: Commit**

```sh
git add packages/core/src/compiler packages/core/test
git commit -m "refactor(compiler): separate graph execution semantics"
```

---

## Task 5: Harden Pi supervision and terminal rendering boundaries

**Files:**

- Modify: `packages/core/src/pi/attempt-process-supervisor.ts`
- Modify: `packages/core/src/pi/interactive-tools.ts`
- Modify: `packages/core/src/pi/tool-renderer.ts`
- Modify: `packages/core/src/pi/transcript-page.ts`
- Modify: `packages/core/src/pi/managed-session.ts`
- Test: `packages/core/test/pi-attempt-process.test.ts`
- Test: `packages/core/test/pi-interactive-tools.test.ts`
- Test: `packages/core/test/pi-transcript-page.test.ts`
- Test: `packages/core/test/pi-managed-session.test.ts`

**Step 1: Add boundary tests**

Cover malformed child frames, duplicate terminal messages, timeout cleanup, oversized text,
unauthorized tools, provider settlement mismatch, and interrupted-session transcript recovery.

**Step 2: Move pure protocol and rendering logic out of supervisors**

Process supervisors retain child ownership, timers, and settlement sequencing. Input validation,
tool interaction normalization, renderer selection, and transcript pagination live in leaf modules.
Cleanup paths must be idempotent and awaited.

**Step 3: Verify**

```sh
npm exec --workspace @koni/core -- vitest run \
  test/pi-attempt-process.test.ts \
  test/pi-interactive-tools.test.ts \
  test/pi-transcript-page.test.ts \
  test/pi-managed-session.test.ts \
  test/pi-production-session.test.ts
npm run typecheck --workspace @koni/core
npm run lint
```

Expected: PASS with no open handles.

**Step 4: Commit**

```sh
git add packages/core/src/pi packages/core/test
git commit -m "refactor(pi): isolate supervision protocol boundaries"
```

---

## Task 6: Preserve Git and control-center facade boundaries

**Files:**

- Modify: `packages/core/src/git/lifecycle.ts`
- Modify: `packages/core/src/git/behavior-policy.ts`
- Modify: `packages/core/src/control-center/controller.ts`
- Modify: `packages/core/src/control-center/component.ts`
- Modify: `packages/core/src/control-center/view-model.ts`
- Test: `packages/core/test/git-behavior-policy.test.ts`
- Test: `packages/core/test/isolated-git-lifecycle.test.ts`
- Test: `packages/core/test/control-center-view-model.test.ts`
- Test: `packages/core/test/control-center-surfaces.test.ts`

**Step 1: Characterize policy and presentation**

Test Git lifecycle decisions independently from process execution. Snapshot stable control-center
view models and graph layouts independently from terminal color/style output.

**Step 2: Keep effect ownership in facades**

`git/lifecycle.ts` owns Git process execution and atomic lifecycle sequencing while
`behavior-policy.ts` owns pure decisions. `controller.ts` owns event coordination while view-model
and component helpers own projections and rendering.

**Step 3: Verify**

```sh
npm exec --workspace @koni/core -- vitest run \
  test/git-behavior-policy.test.ts \
  test/isolated-git-lifecycle.test.ts \
  test/control-center-view-model.test.ts \
  test/control-center-surfaces.test.ts
npm run typecheck --workspace @koni/core
npm run lint
node --test scripts/architecture-budget.test.mjs
```

Expected: PASS.

**Step 4: Commit**

```sh
git add packages/core/src/git packages/core/src/control-center packages/core/test
git commit -m "refactor(core): clarify git and control center facades"
```
