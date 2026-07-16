# Planned proof-source relocation security review

- Owner: `relocation-security-review/root`
- Status: `in_progress` (read-only)
- Started: 2026-07-16 MST

## Exact lease

Read-only adversarial review of the `planned-proof-source-relocation` implementation in
`crates/koni-core/src/engine.rs`, including transaction preparation/publication, action-Journal
ownership, crash replay, quarantine, graph/ticket/Git/preparation CAS, path identity, and event
sealing. This lane may append evidence to this mailbox and the central collaboration registry.

It will not edit Rust, profiles, tests, installed or isolated binaries, live state, product
worktrees, Git refs, processes, or cockpit/cmux surfaces. Production implementation remains owned
by `primary-integrator/root`; the public lifecycle fixture remains owned by
`relocation-lifecycle-tests/root`.

## Coordination checkpoint

Read the central registry, the complete prior `relocation-test-audit` handoff, the lifecycle-test
mailbox, and the primary-integrator's current relocation contract. The review is following current
shared bytes because the implementation owner is actively hardening exact envelopes and the final
seal in parallel.

## Early findings routed to the implementation owner

1. **P0 — committed-request/no-transaction quarantine gap.** Normal global quarantine currently
   scans only persisted relocation transaction files. The steering action durably completes its
   action Journal, releases the action barrier/compiler lock, and only then reconciles and writes
   the transaction. A crash or second process in that interval sees no transaction and can obtain
   ordinary context, worker, review, resume, compile, or action authority even though
   `committed_planned_proof_source_relocation_pending` already recognizes the committed request as
   pending. This was sent to `primary-integrator/root` immediately.
2. **Concurrent regression — wrong owning actor.** A hardening edit briefly required the owning
   steering event actor to be `compiler`, while the configured Software `steer` action and exact
   completed-action replay both produce `lead`. That would reject every real transaction and
   replay. The exact mismatch was routed immediately; final findings will cite the stabilized
   source rather than an intermediate edit.

## Questions for other personas

<!-- Append signed questions or overlap warnings here. -->

## 2026-07-16 — adversarial checkpoint

The implementation owner has already incorporated the first quarantine finding into current
shared bytes: normal quarantine now consults the committed-request detector as well as persisted
transactions. A transient hardening regression requiring a `compiler` owner was also corrected to
the configured default `lead` steering actor. These are source checkpoints, not release claims;
the focused fixture and compiler matrix still own verification.

### Additional P0 findings routed

1. **Protected-path aliases are not protected.** New-path admission uses the case-sensitive lexical
   `worker_file_path_is_protected` predicate. On a case-insensitive or normalization-insensitive
   filesystem, a missing `.CODEX/new-proof` or `.GiT/new-proof` can resolve inside `.codex` or
   `.git`, pass the absence and no-symlink checks, and later receive worker write authority. The
   new path must be compared against every protected root with the filesystem-identity-aware
   comparator, including case/Unicode aliases.
2. **Transaction creation is not single-owner.** Post-action reconciliation runs after the outer
   barrier and compiler lock are released. Two reconcilers can both observe no canonical
   transaction, prepare different UUID-bearing values, and replace the same YAML path. That
   unlocked write can race a publisher which does hold the barrier, replacing a published phase
   with `prepared`. Creation needs a barrier/lock plus create-new or exact read/CAS semantics.
3. **The real full compiler validates its narrow delta after mutation.** The transaction stages
   candidate IDs and one expected ticket, but the real compile may first publish another ticket,
   retire/reopen a base ticket, or apply another change-control delta. Only afterward does the
   transaction require `tickets minus expected == base_tickets`. A failure therefore leaves
   durable unjournaled ticket mutations behind quarantine. The entire projected ticket board must
   be staged exactly, preferably through an isolated compiler store, before graph publication.
4. **New-path/worktree facts are not CAS-revalidated.** Absence, symlink-component rejection, and
   integration cleanliness are checked at preparation only. A crash permits an existing file,
   hardlink, symlink parent, ignored/untracked file, sparse tracked path, or other dirty product
   state to appear without changing the integration ref/HEAD or semantic state hashes. Both
   publication barriers must revalidate the filesystem/Git premise; Git HEAD/index should also
   prove the logical path is not an omitted tracked file.
5. **The declared `compiled` phase is not replayable.** Every non-complete replay first requires
   the current ticket vector to equal the pre-compile base and the failed compile Journal to remain
   exactly `Failed`. A successful real compile has already added the expected ticket, and normal
   finalization changes that Journal to `Recovered` before persisting `complete`. Therefore a crash
   (a) after compile ticket/event publication but before saving `compiled`, (b) after saving
   `compiled`, or (c) after recovering the Journal but before saving `complete` fails at the early
   pre-graph checks and can never reach the later idempotent finalization logic. CAS expectations
   must be phase-aware, with exact compiled poststate plus sealed compile event accepted only in the
   compiled lane; partial compiler mutation still requires isolated staging or explicit rollback.

### Additional P1 findings routed

1. A `complete` transaction with no event is healed by appending the completion event before the
   recovered failed Journal and sealed full-compile history are checked. This can publish a false
   success event before returning failure. The implementation owner has begun splitting immutable
   history validation and deepening the final seal; the pre-append ordering remains part of the
   required fix.
2. The complete-transaction healing branch acquires no fresh run barrier/compiler or event lock.
   Concurrent recoveries can both observe no event and append duplicates to the JSONL ledger.
3. Scheduler play writes `orchestration.running: true` without checking global quarantine.
   Supervision later blocks before launching work, but recovery now fails its durable-pause
   requirement until the operator pauses again. Play must fail while relocation is pending; pause
   must remain always available.
4. Transaction fixed identity omits the complete ticket write-path set and removes the
   proof-source authority extension. The remaining predicates prove old is absent/new is present,
   not that every other effective grant is unchanged. Compare an exact canonical old-to-new
   transformation of ticket scope, inherited step authority, and the compiler binding.
5. The owning steering event is hash-bound, but its complete action Journal is not embedded or
   revalidated after transaction creation. The Journal can disappear/change before publication or
   after completion without invalidating the repair's proof that operator authority committed.
6. Committed-request detection and reconciliation skip malformed/missing/mismatched action-Journal
   references rather than failing closed. A genuine event whose Journal is lost in the
   commit-to-transaction crash window can therefore become invisible to quarantine.
7. Durable transaction phase writes are ordered after ordinary rename-only graph/ticket/Journal
   writes. Power loss can retain `compiled`/`complete` while losing prerequisite ticket or
   recovered-Journal publication. Prerequisites need file and directory durability before the
   transaction phase advances, with exact safe replay for a failed-to-recovered Journal midpoint.

### Test coordination

`relocation-lifecycle-tests/root` now has a real configured legacy-profile collision and exact
steer lifecycle. Its public crash-envelope approximation removes the authentic completed
transaction and completion seal while retaining the owning steering event plus complete action
Journal, then proves ordinary configured compile sees
`committed-request-awaiting-transaction`. Exact prepublication, concurrent creator, duplicate-event,
path-race, and power-loss seams still require private failpoints or unit fixtures.

## 2026-07-16 02:56 MST — current-source P0/P1 disposition

This note supersedes the mailbox's earlier `in_progress` status without erasing the findings that
produced the current design. The read-only source review is complete for the save point whose
`crates/koni-core/src/engine.rs` modification time was 2026-07-16 02:55 MST. No definite P0 or P1
remains in the reviewed source. This is **not** a tracked-backend release claim: the public
lifecycle fixture is Software / `git_common_dir`, while Research uses `tracked` storage.

### Source-addressed findings

- A complete steering Journal with no transaction now quarantines ordinary authority, and
  transaction creation is serialized by the run barrier, compiler lock, and request-specific
  relocation lock. The configured `lead` steering actor, exact action input, embedded complete
  Journal, owning event, and failed compile Journal are hash-bound and revalidated.
- Preparation stages the complete deterministic compiler result before semantic publication. The
  relocation compile uses in-memory derivations, skips automatic gate/change-control publication,
  refuses unrelated ticket creation, refresh, reopen, or retirement, and validates an exact
  old-to-new transformation of ticket/step path authority, compiled members and sets, semantic
  hashes, selection/contract hashes, context hashes, and proof-source grants.
- Graph, ticket, Journal, transaction, and event ordering is phase-aware and durable. Prepared,
  graph-published, compiled, recovered-Journal, complete, and missing-event midpoints either replay
  exactly or stay quarantined. A missing completion seal is appended only under the run barrier and
  compiler lock after exact current amended-graph, preparation, ticket-board, Journal, and
  full-compile poststate validation. Fully sealed replay validates immutable history without
  requiring the current ticket or graph to remain frozen.
- The new path is normalized, protected-path/alias/symlink checked, proven absent on disk, and
  checked against active minted filesystem authority, graph declarations, current preparations,
  the Git index, and the pinned HEAD tree. Clean checkout, ref/HEAD, logical absence, and path
  identity are rechecked at both product publication boundaries.
- Tracked storage no longer lets the relocation compiler checkpoint invalidate its own pinned HEAD.
  The committed steering authority is checkpointed before a transaction is first prepared; an
  explicit `recover` reconciles an existing transaction before it writes a new recovery Journal or
  event; the relocation compiler suppresses its internal checkpoint; and final sealing writes a
  tracked checkpoint only after all old-HEAD CAS checks. Historical seal validation anchors to the
  recorded integration ref, proves its tip is a strict descendant with the pinned base on the
  first-parent chain, and finds an exact reachable commit containing the complete transaction,
  amended node, initial expected ticket, owning/recovered Journals, and exact owner/full-compile/
  completion events. Later legitimate ticket, graph, or event progress therefore does not reopen
  quarantine.

### Verification boundary retained

`relocation-lifecycle-tests/root` reports the public Software lifecycle green **2/2**, including a
resumed-running fully sealed replay and committed-request/no-transaction quarantine. That fixture
does not exercise the tracked-only checkpoint path. Before Research release, add a tracked fixture
covering committed-no-transaction, prepared, graph-published, compiled, recovered-Journal,
complete-without-event, final checkpoint, explicit recovery, and later ticket/event progress while
historical replay remains sealed. Concurrent creator/event and power-loss seams still merit private
failpoints. No Rust, profile, test, live state, binary, process, worktree, Git ref, or cockpit/cmux
surface was changed by this review.
