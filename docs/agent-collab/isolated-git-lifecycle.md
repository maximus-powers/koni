# Isolated Git lifecycle — pure TypeScript transition note

Owner: `isolated_git_lifecycle`

Status: implemented and focused tests green on 2026-07-16. This note is append-only coordination
material; it does not erase the Rust implementation or the historical design that supplied the
parity oracle.

## Decision

The Pi-native port now has a compiler-owned Git lifecycle in
`packages/core/src/git/lifecycle.ts`. Git remains an effect of the single Koni authority. Pi
sessions receive a working directory and bounded file tools; they never receive branch, worktree,
commit, merge, reset, cleanup, or promotion authority.

The lifecycle preserves these smoke-tested rules:

1. Intake pins a local, non-Koni target ref to an immutable commit.
2. Planning uses a locked detached checkout at that commit. No run ref exists during planning.
3. Approval is the first operation that creates a permanent run ref/worktree. The operation is
   idempotent and covered by one crash-forward intent.
4. Every semantic ticket execution/reissue receives a unique cycle ID, branch, and worktree. All
   steps and attempts in that cycle share the same checkout; a reissue never silently reuses it.
5. The authority checks live and committed changed paths against explicit exact/prefix/glob rules.
   Compiler-owned paths override allow rules. Git content-filtered changed paths are refused.
6. The authority checkpoints the candidate ticket tree, then uses `git merge-tree --write-tree`
   without touching either checkout. A successful composition becomes one single-parent squash
   commit on the run ref under compare-and-swap. A conflict is data for an integration ticket and
   leaves both checkouts clean.
7. Target promotion is separately prepared and only published by an explicit operator action. The
   target update is a compare-and-swap. A moved target is rejected; a tree conflict becomes
   integration work. A dirty checked-out target is preserved and blocks publication.
8. Cleanup is allowed only for exact compiler paths/refs whose recorded heads, repository common
   directory, cleanliness, and integration ancestry are proven. There is no `rm -rf` fallback.

## Public TypeScript surface

`packages/core/src/git/index.ts` exports:

- `IsolatedGitLifecycle`
- `RunGitLifecycleRecord`
- `TicketGitCycleRecord`
- `TargetPromotionRecord`
- `GitLifecycleIntent` / `GitIntentJournal` / `GitIntentSettlement`
- `GitConflictReport`
- `GitPathRule` / `GitPathScope` / `inspectGitPathScope`
- the bounded exact-argv `GitClient`

The primary call order is:

```text
planRun
  -> authority persists lifecycle
materializePlanning
  -> planning attempt cwd = lifecycle.planning.worktree (read-only grant)
approveRun
  -> ticket compilation/scheduling may begin
openTicketCycle
  -> every attempt for this ticket cycle cwd = cycle.worktree
commitTicketCandidate
publishTicketCandidate
  -> conflict => compiler creates an integration ticket/cycle
prepareTargetPromotion
  -> ready indicator only; no target mutation
publishTargetPromotion
  -> explicit operator action
retireTicketCycle(s)
retireRunNamespace
```

Deletion before publication calls `retireAbandonedRun(lifecycle, journal)`. It returns either
`{status: "retired", lifecycle}` or `{status: "preserved", lifecycle, reason}`. The method
preflights every planning/run/ticket checkout and ref before the first deletion, accepts clean
unintegrated compiler refs because deletion is explicit, never passes `target.ref` to a mutation,
and journals one `abandoned_run_retire` intent across worktree and ref retirement. Dirty,
unregistered, moved, or otherwise ambiguous resources are preserved as a unit. Recovery uses the
same `recoverIntent` entry point. The caller must persist the returned lifecycle even when no
intent was prepared: a no-resource retirement and a preflight-preserved result are intentionally
pure state transitions.

`recoverIntent(lifecycle, intent, journal)` handles every effect boundary. It rolls forward only
when the exact expected ref/tree/index/worktree identity is provable. If a checkout has additional
work or a ref/path is ambiguous, it settles the intent as blocked and marks the relevant namespace
`preserved`; it never resets or deletes that work.

## Authority state integration contract

The current small `RunGitRecord` is not sufficient. Replace/adapt it with the following fields
(prefer embedding `RunGitLifecycleRecord` as `RunRecord.git`; duplicating these fields creates a
second source of truth):

- `protocol`, `runId`, `projectRoot`, `commonDirectory`
- `target.ref`, `target.selectedOid`
- `namespace.root`, `namespace.runRef`, `namespace.planningWorktree`,
  `namespace.runWorktree`, `namespace.ticketRoot`
- `planning.{status,baseOid,worktree,createdAt,retiredAt,blocker}`
- `run.{status,branchRef,worktree,headOid,materializedAt,retiredAt,blocker}`
- `ticketCycles: Record<cycleId, TicketGitCycleRecord>` and ordered `ticketCycleOrder`
- `promotion: TargetPromotionRecord | undefined`
- `pendingGitIntents: Record<intentId, GitLifecycleIntent>`

The `GitIntentJournal` adapter belongs in the existing authority transaction/store, not in a
second sidecar database:

- `prepare(intent)` must atomically insert the exact intent into `pendingGitIntents` and fsync the
  authority transaction before returning.
- `settle(intentId, settlement)` must atomically replace `RunRecord.git` with
  `settlement.lifecycle`, remove that intent, append Git activity/receipt data, and fsync before
  returning.
- Startup recovery iterates pending intents before scheduling or launching any Pi session and calls
  `recoverIntent` serially under the authority mutation lane.

The authority should hash-bind a ticket attempt's `cycleId`, `branchRef`, `worktree`,
`baseRunOid`, and current `ticketHeadOid` in `AgentLaunchSpec`. Attempts for planning bind the
planning checkout and target OID instead. No agent-authored value may choose either cwd.

## Existing manager transition

`RunGitManager` remains temporarily source-compatible for the current run engine, and its cleanup
was made fail-closed (ownership + cleanliness + target ancestry; no recursive deletion). It should
not be expanded. These methods should retire as soon as the authority stores the full lifecycle:

- `planNamespace` -> `IsolatedGitLifecycle.planRun`
- `materializeNamespace` / `createNamespace` -> `materializePlanning`, then `approveRun`
- `preparePromotion` -> `prepareTargetPromotion`
- `publishPromotion` -> `publishTargetPromotion`
- `cleanup` -> `retireAbandonedRun` for pre-publication deletion, or explicit
  `retireTicketCycle` and `retireRunNamespace` after publication

The old manager creates a run branch/worktree too early and has no semantic ticket-cycle or intent
state; retaining it as the final implementation would regress planning isolation and crash recovery.

## Attempt cwd switching

- `run.create`: call `planRun`, persist, then `materializePlanning`.
- planning/revision launch: `cwd = run.git.planning.worktree`; grants are read-only.
- plan approval transaction: call `approveRun` before changing lifecycle to executable.
- scheduler ticket lease: call `openTicketCycle` once, persist the returned cycle, then set
  `TicketRecord.worktreePath`/`branch` from that cycle as a compatibility projection.
- every Planner/Worker/Reviewer attempt for all steps of that semantic ticket cycle uses the same
  `cycle.worktree`.
- a compiler-directed reissue supplies a new authority-generated `cycleId`; never reuse the old
  branch/path even if the deterministic ticket ID is unchanged.
- verification that is run-wide and read-only uses the run checkout; integration repair is itself a
  compiler ticket and therefore gets a ticket cycle.

## Evidence

Focused suite:

```text
test/git-client.test.ts
test/run-git-manager.test.ts
test/isolated-git-lifecycle.test.ts

3 files, 24 tests green
```

Adversarial coverage includes detached planning/no-ref, approval replay, scope and compiler-owned
path rejection, parallel-ticket conflicts, moving run and target refs, dirty target/ticket
worktrees, auditable reissue namespaces, crash after run-ref creation, crash after run publication
CAS, explicit promotion replay, conflict-to-integration-work behavior, and ownership-proven cleanup
that leaves a user worktree untouched.

### 2026-07-16 19:00 MST — final verification

The complete focused Git suite is **24/24** across the three files above. `@koni/core` strict
TypeScript checking is green with the lifecycle embedded in authority state, and scoped
`git diff --check` is clean. This is now the stable Git integration contract; remaining work is
limited to the main runtime's use of these APIs and any guarded legacy-state adapter it chooses to
place at the state boundary.
