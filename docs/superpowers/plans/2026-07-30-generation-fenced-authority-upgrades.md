# Generation-Fenced Authority Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop obsolete Koni authorities and their agents on activation change while preserving
resumable, durably paused run state.

**Architecture:** Treat the atomically replaced installed launcher as the active generation. Bind
versioned runtimes to that target, reject stale launches, and route a detected generation change
through the existing durable authority quiesce operation.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Vitest, Koni authority RPC.

## Global Constraints

- Preserve all existing uncommitted Koni and MUAT changes.
- Do not weaken run-record anchors, authority lease exclusion, or per-node CAS.
- Do not add a second run-state store or a second shutdown transaction.
- Source/test installations outside Koni's versioned prefix remain supported.

---

### Task 1: Active installation binding

**Files:**

- Create: `packages/core/src/runtime/active-installation.ts`
- Create: `packages/core/test/active-installation.test.ts`

**Interfaces:**

- Produces:
  `bindVersionedActiveInstallation(candidateLauncher: string): Promise<ActiveInstallationBinding | undefined>`
- Produces: `assertActiveInstallationCurrent(binding: ActiveInstallationBinding): Promise<void>`
- Produces: `waitForActiveInstallationChange(binding, options): Promise<void>`

- [ ] **Step 1: Write failing discovery and supersession tests**

Create two content-addressed fixture launchers under
`<prefix>/share/koni/versions/<bundle>/package-root/node_modules/@koni/core/bin/koni.js` and point
`<prefix>/bin/koni` at the first. Assert that discovery binds the first launcher, then replacing the
symlink with the second makes `assertActiveInstallationCurrent()` reject with
`code: "core_install_superseded"`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test --workspace @koni/core -- active-installation.test.ts`

Expected: FAIL because `runtime/active-installation.ts` does not exist.

- [ ] **Step 3: Implement the smallest binding**

Walk the candidate launcher's ancestors to the exact `share/koni/versions/<bundle>` layout, derive
`<prefix>/bin/koni`, resolve both targets with `realpath`, and compare exact paths. Return
`undefined` when the candidate is not in that versioned layout.

- [ ] **Step 4: Add and run the change-monitor test**

Replace the active symlink after monitoring starts and assert that
`waitForActiveInstallationChange()` resolves. Abort a second monitor and assert that it exits
without reporting a generation change.

- [ ] **Step 5: Run the focused test and typecheck**

Run: `npm test --workspace @koni/core -- active-installation.test.ts`

Run: `npm run typecheck --workspace @koni/core`

Expected: PASS.

### Task 2: Launch and daemon handoff wiring

**Files:**

- Modify: `packages/core/src/operator/authority-bootstrap.ts`
- Modify: `packages/core/src/runtime/active-installation.ts`
- Test: `packages/core/test/operator-surface.test.ts`
- Test: `packages/core/test/active-installation.test.ts`

**Interfaces:**

- Consumes the Task 1 binding and guard.
- Produces a daemon environment binding and a supersession watcher that invokes the existing
  compatibility quiesce operation.

- [ ] **Step 1: Write a failing stale-launch admission test**

Inject a versioned candidate whose active launcher points at another bundle. Assert that authority
launch preflight rejects before the daemon launcher is called and reports `core_install_superseded`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test --workspace @koni/core -- operator-surface.test.ts`

Expected: FAIL because launch preflight does not inspect active installation.

- [ ] **Step 3: Bind launch and daemon runtime guards**

In `launchAuthorityDaemon()`, discover and assert the binding before spawning, then pass its active
and expected launcher paths through dedicated environment variables. In `serveProjectAuthority()`,
parse and assert the binding before opening the engine and compose the active-install assertion with
`assertRuntimeClosureCurrent()`.

- [ ] **Step 4: Route supersession through durable quiescence**

After `engine.start()`, start an abortable active-install monitor. On change, connect through
compatibility control and invoke `authority.quiesce`. Retry only retryable revision or
non-interruptible lifecycle races. Let the existing `requestAuthorityShutdown` hook end the daemon
after settlement.

- [ ] **Step 5: Verify focused authority behavior**

Run:
`npm test --workspace @koni/core -- active-installation.test.ts operator-surface.test.ts run-authority-engine.test.ts`

Run: `npm run typecheck --workspace @koni/core`

Expected: PASS.

### Task 3: Install and live smoke

**Files:**

- No new source files.
- Preserve `/Users/max/Desktop/muat/.git/koni` until the authority settles.

**Interfaces:**

- Consumes the verified Core package.
- Produces one current installed Koni generation and a resumable MUAT run.

- [ ] **Step 1: Install the verified build**

Run: `KONI_DEV_FAST_INSTALL=1 ./scripts/install-dev.sh`

- [ ] **Step 2: Perform the one-time pre-fix handoff**

Use the current launcher to quiesce the authority that was started by the pre-fix TUI. Confirm the
run is paused and no attempt process remains before starting the current authority.

- [ ] **Step 3: Validate stale-TUI behavior**

Leave an older TUI process open, stop the current authority, and confirm that the stale session
reports a superseded-install warning instead of launching its bundled daemon.

- [ ] **Step 4: Resume from durable state**

Start the current authority through the MUAT TUI and resume the smoke run. Confirm the lifecycle
begins from its recorded `resumePhase` with no duplicate live attempt.

- [ ] **Step 5: Continue the medium smoke**

Monitor the run through completion or the next genuine bounded blocker. Do not launch a large run
and do not read sealed holdout artifacts.
