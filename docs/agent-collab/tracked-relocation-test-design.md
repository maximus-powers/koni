# Tracked planned-proof relocation test design

- Owner: `tracked-relocation-test-design/root`
- Status: `read_only_design_complete`
- Started: 2026-07-16 MST

## Exact lease

Read-only inspection and test design for the tracked-storage
`planned-proof-source-relocation` lifecycle. This lane may append coordination notes but does not
edit Rust, profile/template, existing tests, live state, installed or isolated binaries, product
worktrees, Git refs, processes, or cockpit/cmux state.

The implementation remains owned by `primary-integrator/root`; the public fixture remains owned by
`relocation-lifecycle-tests/root`.

## Real plan/approval topology

The tracked fixture must exercise the same topology as a real run:

1. `Engine::plan_run` creates a detached planning worktree at the immutable base under the
   repository common directory's Koni namespace.
2. `Engine::approve_run` removes that checkout and creates the permanent integration branch and
   integration worktree.
3. The opened run Engine is rooted at the approved integration worktree. For the test's adapted
   Software profile, semantic state is rooted at `<integration-worktree>/program`.
4. Registry, run barrier, orchestration, agent, and pipeline control remain in the shared Git
   common directory under `.git/koni/runs/<run-id>`. Copying or cloning only the integration
   directory loses this authority and is not a faithful fixture.
5. Ticket worktrees, including the reviewed preparation ticket, share that same common repository
   and merge their tracked state back into the integration branch.

The current fixture's plan/approve construction and its ticket-worktree finish adaptation are
therefore the right base. Phase reconstruction must operate on the approved integration checkout,
not the original user checkout and not the preparation ticket checkout.

## Critical checkpoint ordering

For tracked storage the relevant first-parent sequence is:

```text
H0  failed compile and all pre-steer state checkpointed
 |
H1  Complete steer action Journal + owning steering event checkpointed
 |   transaction.integration_head pins this commit
 |   transaction/graph/ticket/Journal/event publication remains dirty
H2  complete relocation checkpoint
 |
H3+ legitimate later ticket, graph, and event checkpoints
```

`execute_action("steer", ...)` calls `audit_state("commit action steer before planned proof-source
relocation")` before transaction preparation. Consequently, a head captured before calling steer is
H0 and **must not** equal `transaction.integration_head`. The final relocation commit H2 must have
exactly one parent and that parent must equal the transaction-pinned H1. The in-progress tracked
test's `integration_head_before_steer` equality and parent assertion should be changed accordingly.

This ordering also supplies an authentic public committed-request/no-transaction crash image: the
tree at H1 contains the exact owning event and Complete action Journal, the base graph/ticket board,
and the Failed compiler Journal, but no relocation transaction, amended node, expected ticket,
relocation compile event, or completion event.

## Smallest reliable reconstruction strategy

Use an independently created temporary tracked scenario for each reconstructed phase. Run one real
relocation to completion first, capture the complete transaction and exact production-written
artifacts, then restore that disposable integration checkout to H1. A fresh fixture per phase is
important because configured recovery can legitimately advance pipeline/control state in the
untracked common-directory sidecar; restoring only the tracked tree would not undo that control
progress.

The restore helper should use libgit2, never a shell `git reset`:

1. Verify the checkout is the transaction's `integration_ref` and current HEAD is H2.
2. Preserve H2 under a test-only backup ref so every captured commit remains explicitly reachable.
3. Parse H1 from `transaction.integration_head`.
4. CAS-move only the disposable fixture's integration ref from H2 to H1.
5. Read H1's tree into the index, write the index, then call `checkout_head` with
   `force`, `recreate_missing`, `remove_untracked`, and `update_index`.
6. Assert branch ref, HEAD, and integration ref all equal H1 and the checkout is clean.

This fixture-scoped CAS/tree restore preserves the real linked-worktree/common-dir topology and is
deterministic. Removing the transaction from H2 without restoring H1 is insufficient: it leaves the
amended graph and ticket authority in place, so it proves quarantine only and cannot prove exact
recovery from the committed-request midpoint.

Capture semantic artifacts before the restore:

- complete transaction YAML/value;
- amended proof-node file;
- exact initial expected-ticket file;
- recovered failed-compile Journal;
- the relocation full-compile event;
- the relocation completion event;
- H1, H2, the integration ref, and the complete changed-path set.

H1 supplies every base artifact. Overlay only the artifact set owned by the phase under test:

| Reconstructed phase | Exact state over H1 |
| --- | --- |
| committed request, no transaction | no overlay |
| `prepared` | prepared transaction only |
| `graph_published` | graph-published transaction + amended proof node |
| `compiled` / Failed midpoint | compiled transaction + amended node + exact expected ticket + exact relocation full-compile event; retain H1's Failed Journal |
| `compiled` / Recovered midpoint | preceding state + exact Recovered form of the failed Journal |
| `complete`, completion event absent | complete transaction + amended node + ticket + recovered Journal + full-compile event |
| complete, checkpoint absent | complete H2 graph/ticket/Journals/full-compile/completion-event/transaction state over H1 while ref/HEAD remain H1 |

For the smallest high-value matrix, choose the furthest valid write-before-phase-update seam for
each persisted status: `prepared` plus the already amended graph, `graph_published` plus the already
published expected ticket and full-compile event, and `compiled` plus the already Recovered failed
Journal. The publisher explicitly accepts both sides of those write/phase boundaries. The simpler
base forms in the table remain useful optional variants when fixture runtime permits them.

The complete transaction can derive the three incomplete transaction values without private Rust
access:

- `prepared`: set `status: prepared`, `completed_at: null`, remove
  `full_compile_event_id` and `full_compile_event_hash`;
- `graph_published`: same, with `status: graph_published`;
- `compiled`: retain the exact full-compile ID/hash, set `status: compiled` and
  `completed_at: null`;
- for each derived value, set `transaction_hash` to the empty string, compute
  `normalized_hash` over that value, and write the result back.

The two optional full-compile keys must be removed, not serialized as explicit nulls, because the
production struct skips `None` fields when calculating its self-hash. `completed_at` remains an
explicit null for non-complete phases because that Option is not skipped by serialization.

Prefer replaying captured production bytes or typed values rather than recreating event payloads by
hand. H1 already has the exact pre-transaction JSONL prefix. Append only the captured relocation
full-compile event and, when appropriate, captured completion event. Scan the graph directory for
the sole `--<proof-id>.yaml` file instead of duplicating the production title slug algorithm in the
test.

## Recovery assertions

For each phase call configured `recover`, not a private publisher. The preflight must reconcile the
pending relocation before the recovery action writes and checkpoints its own Journal/event. Assert:

- recovery succeeds and exposes one preflight relocation result;
- the transaction is `complete`, self-hashed, and has one completion event;
- the proof node, expected ticket, compiled checks, owning action Journal, and Recovered compiler
  Journal match the captured exact poststate;
- graph and prior-ticket invariants remain exact;
- current branch/ref/HEAD is a strict first-parent descendant of H1;
- one reachable first-parent checkpoint contains the exact complete transaction, amended node,
  initial expected ticket, owning and recovered Journals, and owner/full-compile/completion events;
- a second configured recovery or exact steer replay is byte-semantically idempotent and creates no
  second completion event or checkpoint.

For the committed-no-transaction row, first prove an ordinary configured compile is quarantined as
`committed-request-awaiting-transaction`, then recover. For the incomplete transaction rows, prove
ordinary compiler authority is quarantined before recovery as well.

Also assert the H1-to-H2 production tree delta before deriving any phases. It should be limited to
the transaction, events ledger, failed compiler Journal, amended proof-node file, and expected
ticket file. An unexpected changed path indicates the reconstruction allowlist or production
publication contract is incomplete and should fail the test rather than be silently copied.

## Historical seal after later progress

After one tracked happy path has H2:

1. Run an ordinary configured full compile so it adds legitimate event history and checkpoints H3.
2. If the profile permits it cheaply, start the expected ticket so its current ticket state and
   tracked checkpoint advance beyond the initial ticket sealed in H2. No worker process is needed.
3. Set orchestration to `running: true` through `RunControlStore`.
4. Capture current semantic-state hashes and current HEAD.
5. Replay the exact steer request.

The result must be `already_relocated`; HEAD, graph, current tickets, Journals, events, and
transaction must remain unchanged. This proves seal validation finds the exact historical H2 on the
first-parent chain and does not require the current board to remain frozen or the scheduler to be
paused. Event-only progress is the minimum; event plus ticket-state progress is the stronger and
still process-free proof.

## Coordination messages

The phase recipe and the H0/H1 assertion correction were sent to both
`relocation-lifecycle-tests/root` and `primary-integrator/root` before this note was finalized.
