# Lead cognition audit

## Status and lease

- Persona/work type: `lead-cognition-audit/root`
- Status: read-only audit complete; design proposed; no implementation lease claimed
- Source ownership: none
- Live-state ownership: none
- Allowed documentation: this mailbox and one append-only central-registry checkpoint
- Explicit exclusions: no source, profile, test, acceptance-run, binary, global install, cockpit,
  cmux, or Updog mutation

This audit asks one narrow question: when automatic orchestration has already compiled one exact
next effect, does launching a Lead model add judgment or merely translate a deterministic packet
back into its prescribed tool call?

## Evidence from the preserved Medium run

The read-only snapshot is run `019f66a9-df5a-7302-a3e1-00482d37a7ab` under
`/Users/max/Desktop/updog-koni-acceptance-1`. The run remained live-owned by the primary integrator
throughout this audit. Counts below came only from its durable `lead-slices/*.yaml` and one terminal
`pi.turn_usage` record per Lead log. Because the run was progressing concurrently, generation 52
appeared after the originally reported 51-generation checkpoint; it failed provider admission with
zero tokens, so all nonzero accounting below was already present in generations 1 through 51.

| Boundary | Durable slices | Recorded Pi turns | Nonzero turns | Uncached input | Output | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `dispatch_batch` | 3 | 0 | 0 | 0 | 0 | 0 |
| `wait_workers` | 7 | 2 | 2 | 7,645 | 285 | 7,930 |
| `spawn_worker` | 19 | 18 | 18 | 19,837 | 1,309 | 21,146 |
| `recover` | 19 | 19 | 18 | 18,830 | 1,326 | 20,156 |
| `review` | 4 | 4 | 4 | 3,553 | 245 | 3,798 |
| **Total** | **52** | **43** | **42** | **49,865** | **3,165** | **53,030** |

`reasoning_tokens` are a subset of provider output in these records, not an additional amount;
they total 1,583. Every Lead turn had zero cached input, as expected from fresh one-boundary
sessions. The already-released passive-worker-wait repair removes the historical 7,930-token wait
class from future runs. The remaining deterministic spawn/recover/review wrappers still account
for **45,100 avoidable tokens** in this one run, plus process startup, authentication, containment,
transcript, and supervision overhead.

The assistant transcripts confirm that the tokens did not produce a semantic decision. Across the
logs, model tool calls were exactly 18 `recover`, 18 `spawn_worker`, 4 `review`, 13 `wait_worker`,
and 34 `yield_lead` calls. Representative reasoning summaries are “Planning recover then yield,”
“Planning worker spawning and yielding,” and “Calling review function before yield.” The unusual
eight-call wait slice spent 6,620 tokens repeating the prescribed poll. The Lead protocol itself
forbids discovery, questions, a verdict, a second boundary, or any action outside the packet.

## Boundary taxonomy

The current compiler function selects every durable routing fact before inference:

| Current `LeadSliceBoundary` | What is already decided | Cognition needed? |
| --- | --- | --- |
| `DispatchBatch { tickets }` | ranked ticket set, order, and capacity | No |
| `WaitWorkers { tickets }` | exact owned processes to observe | No; already passive |
| `Recover` | exact configured zero-argument recovery action | No |
| `SpawnWorker { ticket }` | exact ticket, step resolution, persona, prompt contract | No |
| `Review { ticket }` | exact ticket and dependency-ready review step | No Lead cognition; the independently launched Reviewer still requires a model |
| `Finish { ticket }` | exact reviewed ticket and configured integration action | No |

Therefore none of today's Lead boundary variants is semantic Lead work. Planning, implementation,
configured independent review, explicit agent-review pipeline stages, and compiler-emitted repair
tickets remain genuine model work. A future coordinator model is justified only by a new explicit
`Decision` boundary containing two or more compiler-authorized alternatives that cannot be ranked
by configured policy. Such a model should return one schema-valid choice or a question/steering
proposal. It must never perform the chosen effect itself. Ambiguous recovery should normally
compile a repair ticket or stop for an operator rather than give an unscoped Lead effect authority.

## Proposed generic execution path

Evolve the orchestration stage from “model calls an exact compiler tool” to “compiler executes an
exact compiled boundary.” Keep the deterministic selector, but rename its product to a generic
`OrchestrationBoundary`. Factor the effect implementations currently inside the Lead broker into
one internal `OrchestrationBoundaryExecutor` used by:

1. the new compiler driver for ordinary operation; and
2. the legacy Lead broker while old pinned runs drain.

The compiler driver should call the existing authoritative engine APIs (`execute_action`, the
ticket-review launcher/publication path, and compiler inspection) rather than mutating tickets,
Git, or graph state directly. Removing an untrusted model hop does not remove authority checks:
the supervisor and run barrier remain the principal, action journals remain the effect log, worker
and Reviewer model processes retain exact process-bound grants, and Git integration remains a
reviewed compiler transaction.

Add a small durable boundary journal rather than synthesizing a fake Lead or broker grant. Its
identity binds at least:

- run ID and repository identity;
- pipeline stage ID and attempt;
- pinned profile and run-type hashes;
- orchestration input hash;
- canonical boundary payload and ranked ticket order;
- pre-boundary board/recovery fingerprint;
- ordered operation receipts, action-journal IDs, process/agent IDs when applicable;
- result hash, terminal status, and timestamps.

Suggested states are `prepared`, `executing`, `waiting`, `committed`, and `blocked`. The current
Lead slice and broker receipts remain valid compatibility evidence; the new journal should not
rewrite them.

## Replay, pause, and no-progress invariants

1. **Write intent before effects.** Persist the exact hashed boundary before the first operation.
2. **One operation receipt per step.** A dispatch batch records `start(ticket)` before
   `spawn_worker(ticket)` and records each completion before advancing. Restart derives the next
   missing operation; it never repeats a committed spawn or lease.
3. **Existing action authority stays canonical.** An action journal or stronger semantic proof is
   required before marking an operation committed. The boundary journal is an orchestration index,
   not a competing effect authority.
4. **Pause before each new effect.** Re-read operator play/pause intent and parallel capacity before
   every start, spawn, review launch, recovery, and finish. Already-started workers/reviewers may
   drain to their durable boundary; pause never creates a new effect.
5. **Stale input fails closed.** A changed run registration, pipeline attempt, profile/run-type
   hash, board fingerprint, ticket lease, or target state invalidates an unstarted boundary.
6. **Passive waits have no boundary process.** Live workers yield `Waiting` with no Lead record,
   provider session, or token event.
7. **Recovery must prove progress.** Bind recovery to a canonical recovery-cause fingerprint. Run
   it once for that fingerprint, then compare board/cause and the recovery result. If the same
   cause remains and no authoritative state changed, return `AwaitingOperator` with the recovery
   advisory. Do not spin, relaunch a model, or create unlimited no-op recovery journals. New
   steering, a new failed journal, a changed worker identity, or another exact compiler-state
   transition produces a new fingerprint and may authorize another recovery.
8. **Reviewer inference remains independent and singular.** `Review` directly launches the
   configured Reviewer, but its stable input hash must reconcile `starting`, `running`, completed
   output, and publication-after-restart states. A restart cannot create a second reviewer for the
   same current input merely because the orchestration wrapper died.
9. **Finish is exactly once.** Reconcile a committed squash/integration journal before any retry;
   never create a second integration commit for one boundary.
10. **No fake agent accounting.** Compiler boundaries emit compiler activity and boundary receipts,
    not a Lead transcript, Lead agent row, or Lead token usage. Actual worker and Reviewer agents
    remain visible.
11. **Deletion and conclusion dominate.** A retired/concluded registration or lost repository
    membership prevents every further boundary effect even if an older prepared record exists.
12. **Future cognition is separate from effects.** A structured `Decision` result is validated and
    committed first; only a later compiler boundary can execute its selected operation.

## Required tests

### Selector and zero-cognition matrix

- Existing board fixtures produce the same ranked dispatch, recovery, spawn, review, and finish
  boundaries after the generic rename.
- Every current boundary is classified compiler-executable; only a future explicit `Decision`
  boundary can request a coordinator launcher.
- A complete automatic Software and Research fixture records zero Lead launches, zero Lead slices,
  and zero Lead tokens while preserving ticket/review/integration outcomes.

### Operation and interruption matrix

- Dispatch crash before start, after start, after spawn, and between two tickets; exact ordered
  replay and capacity changes are covered.
- Spawn sees a live worker and becomes passive waiting; a committed spawn with a missing final
  boundary write reconciles rather than duplicates.
- Recovery changes state once; identical no-progress recovery becomes `AwaitingOperator`; an exact
  new steering/cause fingerprint permits one new attempt.
- Review interruption covers `starting`, live process, completed output before publication, and
  published verdict before final boundary write. Exactly one Reviewer result applies per input.
- Failed review still reopens the configured worker/rework circuit without a Lead wrapper.
- Finish interruption after Git commit and before semantic/audit publication reconciles the one
  transaction without another commit.
- Pause races at every pre-effect seam, deletion during a long Reviewer, target/config/input drift,
  and supervisor overlap all fail closed or drain according to the invariants above.

### Authority and audit matrix

- Compiler execution cannot bypass action validation, change-control admission, ticket worktree,
  repository identity, or run barriers.
- Worker and Reviewer grants remain process/attempt/input/schema bound and cannot invoke compiler
  orchestration operations.
- Boundary receipts hash exact action/reviewer results and reject omission, reordering, forgery,
  stale replay, and partial publication.
- Historical Lead slices and transcripts remain readable and visible after upgrade.
- Token accounting proves deterministic boundaries do not increment model-generation or token
  totals.

## Compatibility rollout

Do not reinterpret an in-flight Lead lease. Compatibility should proceed in three layers:

1. **Reader/reconciler first.** Keep `LeadSliceState`, broker-grant, transcript, and TUI readers.
   If a legacy slice is `spawning`, `active`, broker-in-flight, or committed-but-not-yielded, use
   the existing identity-bound reconciliation path and issue no compiler duplicate.
2. **New-run opt-in.** Add an explicit run-type orchestration driver such as
   `boundary_driver: compiler`; update bundled Software and Research run types to pin it. Missing
   fields in old snapshots retain `legacy_lead` semantics, so custom historical `lead_action`
   recipes are not silently skipped. Deprecate, but continue parsing, `lead_action` and
   `max_boundaries_per_lead` for that legacy mode.
3. **Optional quiescent migration.** A run-scoped migration may switch a canonical legacy run only
   when no Lead/worker/Reviewer is live, no broker operation is in flight, every prior committed
   Lead effect is reconciled, the configured Lead action matches the supported canonical broker
   contract, and a signed migration receipt pins the old/new policies. Otherwise finish the run in
   legacy mode.

Once legacy support is no longer needed, removing the Lead effect broker is a later cleanup. The
Lead/coordinator persona may remain available for explicit decision stages or operator chat, but it
must not be the default courier for deterministic effects.

## Disposition

The recommended implementation order is: (1) generic boundary state and executor extraction,
(2) compiler driver with dispatch/spawn/recover/finish, (3) singular restart-safe direct review,
(4) bundled-profile opt-in and compatibility tests, then (5) an end-to-end clean Medium smoke run.
No source edit was made during this audit.
