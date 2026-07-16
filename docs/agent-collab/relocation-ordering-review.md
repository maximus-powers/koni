# Planned proof-source relocation ordering review

## Lease

- Persona: `checkpoint-untracked-audit/root`
- Mode: read-only security/correctness review after the tracked H1 checkpoint change.
- Reviewed surfaces: the pre-append preview, Complete-action request checkpoint, committed
  reconciliation, phase recovery, tracked historical seal, and
  `GitBackend::checkpoint_with_required_paths`.
- No production or integration-test edits are authorized in this review lane.

## Current authority chain reviewed

1. Before appending the steering event, the compiler parses the
   `deny_unknown_fields` request and performs a full semantic preparation with
   `committed_authority=false`. That preview requires the exact Running steer-Journal prefix,
   excludes only that in-flight Journal from tracked cleanliness, and persists no transaction.
2. After all recipe steps succeed, `record_action_success` writes the Complete steer Journal and
   action/event history. The tracked path then explicitly checkpoints `events.jsonl`, the current
   Complete Journal, and exact same-input retry Journals changed to Recovered.
3. Reconciliation re-reads the committed request, reacquires run/compiler authority, performs the
   full preparation again with `committed_authority=true`, validates the complete transaction, and
   durably writes the prepared transaction before phased publication.
4. A complete transaction appends its completion event and searches first-parent history for an
   exact graph/ticket/Journals/events/transaction checkpoint descendant of the pinned integration
   head.

## Findings

### P1 — crash before H1 cannot be recovered

`record_action_success` durably writes the steering event and Complete Journal before
`checkpoint_planned_proof_source_relocation_request_authority` runs. A process interruption in
that interval leaves no transaction and leaves the request files dirty relative to H0.

On restart, configured recovery sees `committed_planned_proof_source_relocation_pending`, enters
`reconcile_committed_planned_proof_source_relocations`, and calls semantic preparation with
`committed_authority=true`. That preparation excludes none of the request-authority files and
therefore rejects the dirty event/Journal. Exact steer replay is also blocked by the global pending
relocation quarantine. No current path creates H1 from this valid Complete-action crash state, so
the run is stranded without manual Git mutation.

Required repair: in the tracked no-transaction recovery path, validate the exact Complete action
boundary and create or verify the required-path H1 checkpoint before committed semantic
preparation. Add a failpoint after `record_action_success` and before H1, then prove configured
recovery reaches one sealed transaction without manual staging.

### P1 — final H2 still relies on the racy broad scanner

The H1 request checkpoint explicitly stages required paths, but
`ensure_planned_proof_source_relocation_tracked_checkpoint` still calls generic `audit_state`.
The final seal follows rapid writes to the transaction, amended node, expected ticket, recovered
failed Journal, full-compile event, and completion event—the same stat/untracked discovery class
that caused H1 to become a no-op.

Historical seal validation fails closed rather than accepting a missing H2, but a valid completed
transaction can remain unrecoverably unsealed when the broad scanner misses one of those files.

Required repair: derive the six exact H2 authority paths (transaction, event ledger, owning and
recovered Journals, amended node, expected ticket), checkpoint them through the required-path API,
then perform historical seal validation. Add a racy-clean/explicit-path regression at the final
seal boundary and at complete-without-event recovery.

### P2 — “required paths” does not make the checkpoint tree exact

`checkpoint_with_required_paths` explicitly adds the named paths after the ordinary broad
`update_all`/`add_all`, but it still commits every other non-excluded change. The semantic preview
checks cleanliness before the request is appended and the helper checks cleanliness after the
commit, but an external filesystem write between those points can ride into H1. Koni's run barrier,
compiler lock, and quiescence checks exclude Koni-owned concurrent writers, but they do not lock a
human or unrelated process editing the hidden integration checkout.

Hardening recommendation: either build H1 from the parent tree plus only the exact authority paths,
or compare the actual parent-to-checkpoint tree delta against the allowed authority set and
compensate/refuse on any extra path. Also validate that `transaction.integration_head` itself
contains the exact owning event and Complete action Journal rather than proving them only in a
later descendant seal.

## Confirmed fail-closed properties

- Malformed, unknown-field, stale, wrong-ticket, wrong-node, noncanonical-path, wrong failed-
  Journal, or semantically nonreproducible requests are rejected during the non-persisting preview;
  they do not become committed steering authority.
- Post-H1 preparation independently repeats the semantic checks and binds the exact Complete
  action Journal, owner event, graph, preparation epoch, full ticket board, failed compile, profile,
  integration ref, and integration head.
- Ordinary actions are quarantined for an event/Complete-Journal request without a transaction and
  for every unsealed transaction phase.
- Exact replay of a fully sealed transaction is historical: it validates the immutable owner,
  Journals, compile event, completion event, and reachable exact checkpoint without requiring the
  current ticket board to remain frozen.
- Required checkpoint paths are nonempty repository-relative paths, cannot overlap either
  exclusion class, are included in LFS detection, and are explicitly staged after the broad scan.
  The focused Git tests and warning-denied core-library Clippy passed before this review.

## Release disposition

**Hold (P1).** The pre-append/committed semantic split is sound, and malformed/stale authority is
well constrained, but tracked crash recovery is incomplete before H1 and the final H2 seal still
uses the known-racy generic checkpoint path.

## Follow-up disposition — 2026-07-16 04:12 MST

This follow-up reviewed the shared source save point with `engine.rs` modified at 04:08 MST,
`git.rs` at 03:44 MST, and the tracked relocation integration target at 03:55 MST. It preserves the
original findings above as causal history. No production or test file was changed by this lane.

### Prior findings now addressed

- The valid crash after the action-completion event but before H1 no longer reaches committed
  semantic preparation with dirty request authority. The tracked no-transaction branch now calls
  `checkpoint_planned_proof_source_relocation_request_authority` before preparation and passes the
  exact owning request event (`engine.rs:26037-26063`).
- H2 no longer uses generic `audit_state`. It derives the transaction, event ledger, owning and
  failed/recovered Journals, expected ticket, and amended node paths; rejects visible unrelated
  status; and calls `checkpoint_from_with_required_paths` with the transaction-pinned H1 parent
  (`engine.rs:63143-63218`). This closes the earlier missing/racy authority-file failure mode.
- A newly created H1 or H2 is checked against the real Git commit, its single parent, its actual
  tree diff, its checkpoint record, and the current bytes of every required authority file
  (`engine.rs:62834-62936`). The public tracked tests assert exact H0-to-H1 and H1-to-H2 deltas and
  recover six durable phases beginning at H1
  (`planned_proof_source_relocation.rs:472-497, 544-666, 954-1024`).
- The narrower Complete-Journal-before-action-event crash no longer has the original hard dead
  end. When no matching action event exists, H1 recovery acknowledges remaining exact failures and
  appends a replacement completion event before checkpointing (`engine.rs:29081-29120`).

### P1 — a rejected broad checkpoint is accepted on retry

The checkpoint implementation still rebuilds the index with broad `update_all(["*"])` and
`add_all(["*"])`, then advances the branch ref before the relocation-specific tree validator runs
(`git.rs:1261-1296`). The new pre-check rejects unrelated changes already visible to status, and
the post-check correctly detects an unrelated path that races into the index after that status
read. But detection happens after the commit has become branch HEAD and neither H1 nor H2 rolls
that ref back.

That failure is not durably fail-closed:

- On H1 retry, the required files are already in HEAD, so the checkpoint may return `None`.
  `validate_planned_proof_source_relocation_checkpoint_tree` compares a parent-to-child delta only
  when a `CheckpointCommit` is supplied; the `None` path checks required blobs only
  (`engine.rs:62846-62935`). The previously rejected HEAD can therefore become the transaction's
  `integration_head`.
- On H2 retry, historical seal discovery walks every first-parent descendant and accepts any commit
  containing the expected transaction/Journals/ticket/node/events blobs. It never checks that the
  candidate is the direct, exact allowed-path child of H1 (`engine.rs:62989-63120`). A bad H2 which
  just failed the real-delta validator is consequently treated as fully sealed on the next
  invocation.

This also permits an external/manual descendant commit containing the complete authority files and
unrelated product changes to stand in for compiler-owned H2. Build the checkpoint tree from the
parent plus only the named authority paths (and exact transient removals) before moving the ref, or
compensate the ref/index/worktree on validation failure. Historical discovery must independently
prove the candidate's exact parent and tree delta. Until then, the earlier broad-change P2 is
escalated because retry promotes the checkpoint that runtime validation explicitly rejected.

### P2 — missing-event reconstruction is reachable but not the same canonical success record

Normal `record_action_success` records only Journals which were `Failed` and changed to
`Recovered` by that success call (`engine.rs:14245-14260, 51586-51607`). The new crash
reconstruction first recovers remaining failures, then includes **every** earlier same-input
`Recovered` Journal in its replacement event (`engine.rs:29087-29118`). An attempt already marked
Recovered by a prior configured recovery is omitted on an uninterrupted success but included when
the process dies after the new Journal becomes Complete. Thus crash timing changes the claimed
`superseded_failed_journals` authority even though the logical action history is the same.

Derive the reconstructed set from exact H0-Failed to worktree-Recovered transitions, or use one
canonical helper for both normal completion and reconstruction. The current event validation does
reject duplicate IDs, extra payload keys, wrong envelope/ticket, and invalid listed Journals
(`engine.rs:29121-29202`); the remaining issue is equality with the uninterrupted boundary.

### P2 — H2 publication completion is not crash-replayed after the Git commit

H2 moves the ref, validates the commit, and only then synchronizes empty ticket worktrees and
repairs terminal transient trees (`engine.rs:63211-63242`). A process death after the ref update but
before or during those operations leaves a blob-valid H2. On restart,
`planned_proof_source_relocation_is_fully_sealed` accepts that historical candidate and returns
without rerunning either idempotent synchronization (`engine.rs:25497-25520, 63256-63302`). Clean,
inactive leased ticket branches can therefore remain at H0/H1 while relocation quarantine clears.

The sealed-candidate path needs a durable publication-completion marker or a safe idempotent
synchronization replay when the candidate is still the current integration tip. The phase matrix
reconstructs `complete without checkpoint`, but not `H2 ref moved before worktree synchronization`.

### Follow-up release disposition

**Hold (P1).** Exact H1 creation after the committed action event and explicit required-path H2 are
material improvements, and the known racy omission failure is closed. Release remains blocked by
post-ref validation whose rejected broad commit is accepted on retry. The completion-event
reconstruction and post-H2 synchronization seams are bounded P2 follow-ups once that ref/tree
atomicity issue is repaired.

## Final disposition — 2026-07-16 04:53 MST

This pass reviewed the shared source with `engine.rs` modified at 04:50 MST, `git.rs` at 04:17
MST, and the relocation integration target at 04:48 MST. It preserves the earlier findings above
as causal history. This lane changed only this review record.

### P0 — none

No confidentiality, integrity, arbitrary-write, or unrecoverable semantic-authority defect remains
in the reviewed relocation boundary.

### P1 — none

All prior release-blocking findings are closed in the current source:

- Normal completion and the Complete-Journal/missing-event reconstruction both derive the exact
  ordered set of earlier same-input `Recovered` attempts through
  `canonical_superseded_failed_journals`; an existing event must equal that canonical set. Earlier
  successful repeatable actions remain valid but are not mislabeled as failed attempts
  (`engine.rs:14250-14273, 29217-29295, 51765-51810`).
- Required-path Git checkpoints reject an empty authority list, rebuild from the pinned parent,
  stage only the named files, remove transient tree entries, and move the ref with compare-and-swap.
  They never run the broad `*` staging path (`git.rs:1181-1197, 1210-1225, 1258-1327`).
- H1 validation always inspects the actual single-parent commit and actual parent-to-child delta,
  including when checkpoint creation returned `None`; it requires the event and Complete Journal
  to change and rejects unrelated paths. If current HEAD already byte-binds all required authority,
  it is validated before any exclusion cleanup can create a descendant. This closes the final
  malicious-preexisting-H1 mutation found by the adversarial regression
  (`engine.rs:29370-29435, 63109-63320`).
- Both live checkpoint validation and historical H2 discovery require configured tree exclusions
  to be absent from the child tree. Historical H2 must be the direct child of transaction-pinned H1
  and have exactly the five expected changing authority paths; the unchanged owning Journal is
  byte-bound but is not claimed as a delta (`engine.rs:63118-63266, 63322-63556`).
- Full sealing requires a Git-common marker bound to schema, run, transaction ID/hash, integration
  ref, and exact H2. Missing, truncated, malformed, or stale marker bytes leave the relocation
  quarantined. Recovery of an existing exact H2 reruns operational finalization and writes the
  marker without a new semantic commit (`engine.rs:62264-62355, 63572-63820`).
- Empty-ticket synchronization admits only the lease base, the exact target, or an explicitly
  proven target ancestor (H1 for relocation finalization). It compare-and-swaps the ticket ref,
  detaches at the verified index/workdir baseline, uses a safe index-updating checkout, restores
  symbolic HEAD, and verifies the ref, index, and workdir before marker publication. This covers
  normal H1-to-H2 progression and clean crash midpoints at ref=H1 or ref=H2 without accepting an
  arbitrary ticket commit (`engine.rs:19306-19467, 63572-63620`).

### P2 — abrupt interruption inside libgit2 checkout remains fail-closed, not self-healing

The code replays every durable clean midpoint around the ticket-ref update, detached baseline,
checkout, symbolic-HEAD restoration, and marker write. An operating-system kill *during* the
multi-file `checkout_tree` itself can still leave a mixed workdir/index. The next recovery rejects
that state as ambiguous and keeps the marker absent, so semantic authority is not falsely sealed
and user bytes are not force-overwritten; restoring the checkout to one trusted tree may require
manual intervention. A future durable per-ticket sync-intent record could authorize exact
base/H1/H2 blob-by-blob completion of that bounded availability seam.

### Verification evidence

- `cargo test --locked -p koni-core --test planned_proof_source_relocation -- --nocapture`:
  **9 passed, 0 failed** in 41.67 seconds on the final source.
- `cargo clippy --locked -p koni-core --test planned_proof_source_relocation -- -D warnings`:
  **passed**.
- The target now covers nine scenarios, including all six durable publication phases, partial
  action-success reconstruction, canonical-retry omission rejection, unrelated-product H1
  rejection without transaction publication, tree-excluded-blob H1 rejection without advancing
  HEAD, normal retained-ticket synchronization to H2, missing-marker replay from lease base, and
  the torn ref/HEAD=H2 with index+workdir=H1 midpoint.

### Final release disposition

**Scoped pass: no P0 or P1.** The relocation authority chain, exact-tree semantics, retry
acceptance, marker binding, and tested clean crash midpoints are release-ready for the documented
compiler-owned/quiescent-worktree boundary. Retain the P2 mid-checkout availability seam as an
explicit hardening item; it does not permit false sealing or silent overwrite in the reviewed
source.
