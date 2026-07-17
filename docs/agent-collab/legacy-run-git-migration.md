# Legacy run Git migration

Owner: `isolated_git_lifecycle/root`

Status: proof-only adapter and journaled relocation/deletion executor complete.

## Decision

The pre-isolation runtime persisted a flat Git object:

```ts
{
  targetRef,
  targetBaseOid,
  runBranch,
  runWorktree,
  candidateOid?,
  promotionTargetOid?,
  mergeReadyAt?,
  mergedOid?,
  namespaceStatus?,
  materializedAt?,
}
```

`ProjectAuthorityStore.open()` now recognizes only that exact legacy discriminator after ordinary
`RunRecord` validation fails. It discovers the repository and common directory, hashes the
canonical source object, inspects refs and registered worktrees without mutation, constructs a
strict `RunGitLifecycleRecord`, validates the complete new `RunRecord`, and atomically writes all
migrated run bytes plus one authority-state revision. Reopening is idempotent. Malformed new
lifecycle records never enter this path.

Startup classifies evidence as follows:

- A draft `planned` record with no run ref, registration, or path becomes an ordinary detached-
  planning lifecycle plan. No Git resource is created.
- A terminal `cleaned` record with no remaining resources becomes a retired lifecycle namespace.
- A clean, exact, nonterminal legacy checkout is not called resumable. The run is durably blocked,
  the Git lifecycle is marked preserved, and a `LegacyRunRelocationPlan` is retained.
- Dirty, moved, unregistered, cross-repository, noncanonical, partially materialized, missing-OID,
  missing-target, contradictory-promotion, or occupied-destination evidence remains preserved with
  an explicit reason. The adapter does not delete, reset, move, relink, checkout, or create refs.

The original flat object and its canonical SHA-256 remain in `RunRecord.legacyGitMigration`, so a
preserved record never loses the only pointer to ambiguous user work.

## Exact relocation handoff

The public type is exported from `@koni/core` and defined in
`packages/core/src/state/legacy-run-git-migration.ts`:

```ts
interface LegacyRunRelocationPlan {
  protocol: "koni.legacy-run-relocation.v1";
  runId: string;
  sourceGitSha256: Sha256Digest;
  projectRoot: string;
  commonDirectory: string;
  target: {
    ref: string;
    selectedOid: string;
    observedOid: string | undefined;
  };
  source: {
    branchRef: string;
    worktree: string;
    expectedHeadOid: string;
    registered: true;
    clean: true;
  };
  destination: {
    namespaceRoot: string;
    stagingWorktree: string;
    planningWorktree: string;
    runWorktree: string;
    ticketRoot: string;
  };
  expectedAbsentPaths: string[];
  ticketProjectionIds: string[];
  priorPhase: RunPhase;
  plannedAt: string;
}
```

For legacy run `R`, the source is exactly
`<common>/koni/worktrees/runs/R`, the staging checkout is exactly
`<common>/koni/worktrees/migrations/R/integration`, and the destination is exactly
`<common>/koni/worktrees/runs/R/integration`. The expected-absent set is the planning,
integration, ticket-root, and staging paths. A staging move is necessary because the destination
is a child of the old checkout path.

`LegacyRunGitMigrationRecord.status` supports `relocation_required` and the executor settlement
state `relocated`. A settled record must retain the plan and add both `relocationIntentId` and
`relocatedAt`; the validator rejects a purported completion without those fields.

## Executor release gate

The run must remain token-idle and blocked until a separate authority-owned executor does all of
the following:

1. Hold the run mutation/admission barrier and stop or durably interrupt old attempts.
2. Re-read the record and re-prove the source object hash, selected/observed target, exact run ref
   OID, worktree registration, repository common directory, clean index/worktree, and every absent
   destination.
3. Persist a dedicated crash-forward Git intent before the first effect. Never model relocation as
   an ordinary metadata commit.
4. Move the registered checkout from source to staging, create only proof-owned namespace
   directories, move staging to the integration destination, apply the compiler worktree lock,
   and verify the same ref/HEAD/index/common-directory identity after each recoverable boundary.
5. Atomically settle the intent with the destination lifecycle, clear obsolete ticket checkout
   projections so new ticket cycles are compiler-issued, mark migration status `relocated`, bind
   the settlement intent ID/time, and resume only the recorded prior phase through the lifecycle
   reducer.
6. On any mismatch, settle blocked/preserved without reset, delete, forced checkout, ref movement,
   or recursive filesystem removal.

Deletion is also gated: a run with `relocation_required` or `preserved` compatibility state may
not be passed to ordinary new-layout cleanup as if relocation had completed. Explicit deletion
must either finish the journaled relocation first or use a legacy-source-aware, whole-namespace
preflight and its own durable deletion intent. The target ref is never a cleanup target.

## Evidence

- `test/legacy-run-git-migration.test.ts`: **6/6**
- Migration plus authority store: **9/9**
- Composed Git/store focus: **33/33**
- `@koni/core` strict TypeScript: green
- Scoped `git diff --check`: green

The tests cover direct planned upgrade with zero Git effects, idempotent reopening, exact live
relocation handoff, ticket projection binding, dirty-work preservation, missing-base preservation,
already-cleaned terminal migration, and rejection of malformed new lifecycle state.

## 2026-07-16 executor completion transition

`legacy_git_relocation/root` closed the release gate without changing the proof adapter's source of
truth. `LegacyRunGitExecutor` consumes only the retained hash-bound plan and the single authority
journal. Before preparation it re-proves the source object hash, project/common-directory identity,
selected and observed target commits, exact run ref/HEAD, unique worktree registration, cleanliness,
and destination absence. After preparation it moves the registered checkout source -> staging ->
canonical `integration`, creates only checked real directories beneath the Git common directory,
and applies/verifies the exact compiler lock. Startup quiesces the supervisor and durably interrupts
old active attempts before invoking that effect.

Recovery recognizes source, staging, unlocked destination, and locked destination as distinct
boundaries. It never repeats an earlier hop, and a foreign lock or changed proof settles preserved.
The authority settlement atomically replaces the lifecycle path projection, marks the compatibility
record `relocated`, clears only the plan-bound legacy ticket checkout projections, removes the
pending intent, appends its receipt/activity, and restores the recorded prior phase through the
lifecycle reducer. A prior paused run remains paused.

Unrelocated deletion now uses `legacy_run_retire`, not ordinary new-layout cleanup. It performs a
whole compatibility-namespace preflight, journals the exact source location/ref/OID, removes the
registered clean checkout, and deletes only the Koni run ref by CAS. Recovery completes after either
boundary. Dirty, redirected, missing, ambiguously registered, or foreign-locked data is preserved;
the user target is never mutated.

Focused evidence at completion:

- legacy adapter/executor/authority recovery: **13/13**;
- composed Git/client/lifecycle/store focus: **41/41** across the final split runs;
- strict `@koni/core` TypeScript: green.

All Git effects were exercised only in disposable temporary repositories. No live project,
installed binary, Pi home, process, ref, credential, or terminal pane was touched.

## 2026-07-16 planning-resume compatibility closure

The native compiler program now projects a planning attempt onto the canonical run worktree only
when `LegacyRunGitMigrationRecord.status` is exactly `relocated` and the settled run checkout is
ready with a bound HEAD. This preserves a clean legacy run whose restored lifecycle schedules
planning, including a paused run whose resume phase is planning: the pre-isolation runtime had no
detached planner to restore after relocation. The ordinary native path is unchanged and continues
to require a ready detached planning checkout.

The focused native-program regression proves both outcomes in one fixture: the same retired
planning lifecycle is first rejected without settled legacy evidence, then admitted at the exact
canonical integration path after the valid relocation record is attached. `native-run-program` is
**6/6** with this closure; the final composed native/legacy/Git/store gate is **47/47**.
