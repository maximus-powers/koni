# Scope Rebind Independent Review

## Read-only review lease — 2026-07-15 (`scope-rebind-review/root`)

- Independent security/transaction review only for the structured `read-scope-repair` blocker and
  its proposed semantic graph/ticket rebind in `crates/koni-core/src/engine.rs`.
- No Rust, profile, TUI, live-run, binary, process, worktree, branch, or cmux mutation authority.
  This lane may append findings only to this mailbox and the central registry.
- The live-equivalent acceptance criterion is exact: append one already-declared production path
  from the scoped system's typed `owned_paths` to the target proof's `covered_paths`; re-evaluate
  the same pinned rule/profile into the same deterministic ticket ID; change only derived read
  paths, compiled-check bindings/hashes, and affected context hashes; preserve target/write scope,
  workflow topology, worktree/branch/HEAD, lease, status history, outputs/reviews/supersessions,
  and every unrelated graph/ticket byte.

## First review checkpoint — 2026-07-15

- The blocker half is directionally fail-closed: only a completed enclosing action journal becomes
  eligible; ticket publication precedes its compiler event; replay can append a missing event from
  the ticket's sealed binding; and neither the request nor blocker widens capability.
- Ordinary `compile_internal` cannot perform the semantic repair. Its full reconciliation
  deliberately skips an existing same-ID ticket whose status is neither initial nor terminal.
  Recovery therefore needs a dedicated candidate-evaluation/constrained-merge path and a durable
  graph+ticket publication journal; invoking ordinary compile after editing the graph is not an
  acceptable implementation.
- Before rebind, reconstruct the exact pre-blocker ticket from the blocked ticket (restore the
  recorded prior status, remove only the exact replan blocker and exact last binding) and require
  its hash to equal `base_ticket_hash`. Merely hashing the already-blocked ticket when recovery
  begins would bless unrelated intervening edits.
- The binding/rebind journal must include the clean ticket-worktree branch and HEAD, not only the
  lease object. Quiescent agents and a stable lease do not prove that the preserved product branch
  did not move.

## Open review work

- Audit the implementer's candidate equivalence, compiled-member receipt binding, context
  invalidation, lifecycle restoration, graph/ticket crash replay, and exact adversarial tests.
- Re-scan the dynamic diff and coordination mailboxes before final handoff.

## Dynamic implementation findings — 2026-07-15

### P0 — completion must precede stale repair validation

Recovery currently reconciles committed `read-scope-repair` events before committed semantic
rebinds. Once a rebind succeeds, the ticket is active again and the requested path is already
covered; replaying the original repair through the ordinary validator therefore reports it as
stale. Every future `recover` and every replay of the original steer action would fail. Replan
reconciliation must first recognize an exact completed/current rebind for that blocker request,
validate its transaction plus current graph/ticket/receipt, and no-op before any stale-path or
active-status rejection.

### P0 — prove the blocked ticket is exactly the compiler publication

The first dynamic preparation checked blocked status, lease hash, and review membership, but not
the recorded `base_ticket_hash`. That can bless unrelated edits made after blocker publication.
Derive the pre-blocker ticket from the current blocked ticket by restoring `prior_ticket_status`,
removing only the exact blocker created at `recorded_at` for `step_id`, and removing only the exact
last matching replan binding. The reconstructed hash must equal `base_ticket_hash`; every other
field, blocker, history row, output, review, lease field, and extension remains byte-for-byte.

### P0 — identical operator replay must converge

`steer` is not pipeline-bound, so retrying the same semantic-rebind JSON creates a second event
with the same request hash. A transaction keyed by request hash but bound to the first event will
fail forever if reconciliation later validates it against the second event. Deduplicate completed
events by exact request hash and payload/binding identity. The first committed event owns the
transaction; later exact duplicates return `already_rebound`; conflicting duplicates fail closed.

### P0 — unfinished publication cannot become dispatchable

The custom transaction must be reconciled before any generic `store.tickets()` enumeration,
because lifecycle-lane publication can crash with old/new ticket paths both present. More
generally, a prepared transaction that has published an active rebound ticket but not its complete
seal/event must block scheduler resume, context issuance, and broker grants until recovery proves
and completes it. Test old/old, new-graph/old-ticket, new-graph/new-ticket, duplicate-lane, and
complete-state/missing-event boundaries, plus every mismatched combination.

### P0 — prove the semantic receipt member, not only a read set

The replacement candidate must retain the exact compiled-set/member topology and show exactly one
allowed member delta for the amendment proof: `covered_paths = old + requested_path`. Its source
paths, child check, argv, working directory, selection identity, and every unrelated member remain
the same; derived semantic/member/set/anchor/contract hashes may change. The target step and ticket
gain no other read path, all writes remain identical, and the unrelated source-system owned path
stays absent. Merely finding the path in ticket/step read scope is insufficient.

### P1 — bind the preserved product checkout

Quiescent sessions and an unchanged lease object do not prove that retained product work stayed
fixed. Preparation/publication should require a clean compiler-owned ticket checkout on the lease
branch, bind its exact HEAD, and recheck branch/HEAD/cleanliness before and after publication. Rule
candidate evaluation should use the lease worktree as its filesystem root rather than the
integration checkout. Dirty work, branch mismatch, or head movement fails closed.

### P1 — keep the accepted contract internally consistent

The repair validator accepts an amendment field typed either `Path` or `list<Path>`, while the
semantic rebind can append only to a list. Reject a scalar amendment before publishing a blocker
or define a safe exact scalar transition. Prefer deriving proof eligibility from the pinned
operation/check-set configuration over hardcoded public operation/node-type names; the invariant
is the configured member's covered-path field and receipt binding.

## Required focused regressions

1. Live-equivalent happy path: exact requested system-owned path enters proof `covered_paths`, the
   same deterministic ticket and retained active lifecycle reopen, compiled member and receipt bind
   it, unrelated owned paths stay absent, and writes/workflow topology/targets/lease/history/HEAD
   remain unchanged.
2. Candidate drift matrix: reject removed old reads, any second added read, any write/read-node/
   write-node/target/operation/rule/workflow-topology change, missing compiled-member coverage, or
   unrelated compiled-member change.
3. History/context matrix: retain outputs, reviews, supersessions, change control, other blockers,
   and lease; retire every stale issued context whose step hash changed; prove an old receipt/grant
   cannot authorize the new scope.
4. Publication replay matrix: inject interruption after transaction prepare, graph node replace,
   receipt install, target-ticket install, old-lane retirement, transaction completion, and before
   compiler event append. Repeat recover and repeat both steer requests; expect one semantic delta,
   one receipt, one completion event, and no duplicate ticket authority.
5. Worktree/quiescence matrix: reject scheduler-running, live Lead/worker/reviewer, live or in-flight
   grant, dirty checkout, moved HEAD/branch, redirected path, absent/oversized/protected path, and
   any state mismatch while leaving the original blocked state and write authority untouched.

## Second review checkpoint — future replay and two-phase provenance

### P0 — completion is historical, not an immortal current-state assertion

The first completion fast path still required the current ticket to equal the immediate rebound
ticket, the current graph to equal the immediate amended graph, the run to remain paused, and the
ticket checkout to remain on its old HEAD. That makes every later recovery fail as soon as normal
work resumes and adds an output, heartbeat, commit, lifecycle transition, or graph result. A
completed rebind must instead validate immutable history (the sealed transaction, its owning
request, the exact completion event, and its durable receipt) and return `already_rebound` without
republishing or requiring quiescence. Exact pre/mid/post graph, ticket, lane, branch, and HEAD checks
belong only to a `prepared` transaction that recovery is still finishing.

The same rule applies after legitimate later supersession. Forward rollback can archive/remove a
ticket and later authorized graph evolution can replace the covered-path claim. Old action replay
must not resurrect that earlier authority or fail forever merely because current state moved
forward. Mutable current ticket extensions and graph membership therefore cannot be perpetual
proof of an already-completed historical action.

### P0 — the original blocker must bind the checkout and full graph prestate

Binding branch/HEAD only when the second rebind request is prepared leaves a gap between the two
committed phases. A paused operator can commit unrelated work after blocker publication; the
current implementation then accepts the new clean HEAD as its transaction base. Record and require
the clean retained worktree's exact branch and HEAD in the original `ReadScopeReplanBinding`, and
carry them unchanged through preparation and final publication. Likewise, the blocker's current
`base_graph_hash` is a semantic hash, so unrelated nonsemantic/compiler-owned/annotation changes
can be silently adopted. The promised one-field delta requires the full normalized graph hash at
the blocker boundary (a semantic hash may be retained separately).

### P1 — close comparator and publication asymmetries

- A step context hash must remain identical when neither its effective read scope nor its allowed
  compiled-check binding changed; the current comparator only enforces the forward implication
  that a gained path changes context.
- Compare the exact compiler-derived extension key set and values. Iterating only candidate keys
  lets a candidate omit derived workflow/operation/ranking/proof-authority metadata while the
  rebound ticket silently retains stale blocked metadata.
- Recheck the retained branch, HEAD, and cleanliness after graph/ticket/receipt readback and before
  sealing `complete`; the initial check alone has a commit race, especially for commits outside
  scoped filesystem manifests. Git discovery should also canonical-match the lease worktree.
- Enforce `prepared => completed_at absent` and `complete => completed_at present`. Validate the
  embedded durable receipt and exact in-memory post-graph before the first graph mutation so a
  corrupt prepared transaction fails before leaving a partial publication.
- Completion-event idempotence must compare the full compiler-owned payload. Finding a row with
  only the same ticket/request key is not enough to suppress a missing exact event.

## Final-pass authority gaps — 2026-07-15

### P0 — prepared publication needs a global authority quarantine

Early rebind reconciliation now precedes generic ticket enumeration inside explicit runtime
recovery, but no shared mutation/authority preflight checks for a `prepared` rebind transaction.
A crash after publishing the amended graph, receipt, and active rebound ticket but before sealing
the transaction can therefore leave ordinary context compilation, review, worker spawn, grant,
or resume paths able to consume state whose compiler transaction is unfinished. Every authority
issuance boundary must reject any prepared rebind until the dedicated recovery path proves and
seals it; recovery itself needs an explicit bypass or safe auto-reconcile route. A focused
regression must materialize the target-ticket midpoint, prove all dispatch boundaries fail closed,
then recover and prove normal dispatch becomes available.

### P0 — actual action replay still consults mutable current state first

The rebind/replan event validators correctly recognize immutable completion before their own
stale checks, but `execute_action` performs generic mutable checks before its completed-journal
lookup: run-terminal rejection, ticket lookup/change-control admission, and checkout constraints.
Because `steer` is normally not pipeline-bound, an exact retry after legitimate ticket removal,
hold, lifecycle progress, or run conclusion can fail before reaching historical reconciliation.
Exact completed read-scope action replay needs an early, narrowly bound historical path that does
not resurrect authority and does not depend on the immediate post-rebind ticket/graph/HEAD.

### P1 — completion-event suppression is still weaker than history validation

`append_read_scope_rebind_event_once` still treats any event with the same type, ticket, and
request hash as sufficient. A conflicting row with a different transaction or payload suppresses
the exact event; the transaction can then be sealed while historical validation fails forever.
Only the full expected compiler-owned payload is an idempotent no-op. Same-key disagreement must
fail before sealing or appending, with a focused collision regression.

### P1 — residual crash-recovery edges outside the exact live fixture

The initial blocker still uses generic lifecycle publication, whose write-before-retire crash
policy can leave duplicate ticket lanes that fail closed but require manual repair. Rebind graph
publication also writes the canonical title-derived node path rather than the exact loaded source
path, so a valid noncanonical historical node filename can become a duplicate-ID graph after the
amendment. The exact acceptance fixture uses a canonical node path, so this is not a live blocker,
but both cases should be explicit recovery/compatibility follow-ups.

## Final review disposition — 2026-07-15

All P0 findings above are closed in the current source checkpoint. Prepared transactions now
quarantine ordinary compile/context/review/worker/action/resume authority while the canonical
recovery path bypasses only that one prepared-rebind gate and retains every existing read-only
violation/quarantine check. Recovery reconciles the one-file lane midpoint before generic ticket
enumeration. Exact completed repair/rebind retries run as immutable historical reads under the run
authority barrier, accept both `ticket` and `ticket_id` parameter shapes, bind the same run/profile/
repository identity, reject deletion tombstones, and do not consult mutable current ticket, graph,
lease, HEAD, or lifecycle state. Completion/derived events require their exact compiler envelope
and payload, with conflicting event slots rejected before graph publication.

Independent latest-save verification passed the five focused rebind regressions (exact semantic
member/read-only delta and later replay; candidate extra read/write/member rejection; retained
HEAD drift rejection before mutation; prepared lane-midpoint quarantine plus canonical recovery;
completion-slot collision before publication) **5/5**, plus stale repair rejection without graph
or ticket mutation **1/1**. The happy fixture includes an unrelated system-owned path and proves it
never enters ticket, step, or compiled-member authority. No Rust/profile/live-state/binary/process/
worktree/cockpit change was made by this review lane.

### Residual P1-A — initial blocker lane midpoint

Exact call sites: `publish_read_scope_replan_blocker` calls `StateStore::write_ticket` at
`crates/koni-core/src/engine.rs:23326` (current save point); `write_ticket` publishes the new status
file before removing old lifecycle copies at `crates/koni-core/src/state.rs:1840-1863`. A hard crash
after the atomic `blocked/TK-*.yaml` write and before removing `in_progress/TK-*.yaml` leaves two
durable copies. Subsequent `StateStore::tickets()`/`ticket()` fails closed with duplicate lifecycle
authority, so no agent gains scope, but automatic read-scope reconciliation cannot reach the
blocker and manual duplicate-lane recovery is required. This does **not** block the canonical live
acceptance repair: its blocker is already durably published as exactly one `blocked` ticket, so
that pre-transaction crash window is historical rather than upcoming.

### Residual P1-B — noncanonical graph source filename

Exact call sites: prepared publication calls `graph.save_node` at
`crates/koni-core/src/engine.rs:24037`; `Graph::save_node` derives
`<node_type>/<slug(title)>--<id>.yaml` at `crates/koni-core/src/graph.rs:157-166` rather than
overwriting the exact file path from which `Graph::load` read that node. For a valid historical
graph whose node lives under a different YAML/JSON filename, publication writes a second file with
the same node ID while leaving the original. Readback then fails closed on duplicate node identity;
the transaction remains `prepared`, global authority stays quarantined, and recovery repeats until
an operator resolves the duplicate. This does **not** block canonical live acceptance: proof
`ND-12be7352e46a017421437ae7` is already stored at its exact canonical title-derived YAML path.

### Recommendation

Proceed with the canonical live semantic repair after the owner finishes combined tests and
warning-denied Clippy. Neither residual can widen authority and neither failure state is reachable
from the already-published canonical live prestate. Track both as generic recovery-compatibility
follow-ups before claiming arbitrary historical graph/layout crash completeness.

## Final released-checkpoint audit — 2026-07-15

The preceding P1-A finding is **superseded and closed**. Initial blocker publication now uses a
dedicated `publish_read_scope_replan_ticket` rename-then-atomic-replace transition: it accepts only
one exact pre-blocker ticket at either the source lane or the one-file rename midpoint, recognizes
the exact final blocked value idempotently, and never intentionally publishes two lifecycle
copies. `read_scope_repair_lane_midpoint_recovers_without_duplicate_ticket` exercises the crash
midpoint and proves one final blocked ticket with one blocker. The rebound direction retains the
same one-file midpoint discipline, and specialized rebind recovery still precedes generic ticket
enumeration where the blocked-content midpoint could otherwise be interpreted.

Independent verification against the current shared checkpoint, including the subsequent
root-aware filesystem-identity hardening, passed:

```text
CARGO_TARGET_DIR=/tmp/koni-scope-replan-target cargo test --locked -p koni-core read_scope_ -- --nocapture
9 passed; 0 failed; 0 ignored
```

The operator contract and documented CLI examples agree exactly with the strict schemas:
`read-scope-repair` carries the versioned ticket/step/path/source/amendment/review/correction/reason
object and exactly the source plus amendment target nodes; its printed binding supplies the
request and binding hashes consumed by the separately committed `read-scope-rebind`, whose target
set is exactly the amendment node. The generic `koni steer` CLI forwards repeated `--target-node`,
`--ticket`, and the JSON `--message`, then prints the structured action result containing those
hashes.

The live acceptance prestate remains exactly applicable and was inspected read-only. Run
`019f66a9-df5a-7302-a3e1-00482d37a7ab` has one ticket copy,
`tickets/in_progress/TK-63a91afabf98af03.yaml`; its retained worktree is clean, has no worker PID,
and remains on its pinned ticket branch. The run is durably paused. Requested path
`apps/books/src/components/ThreadQuestionInput.tsx` is an existing regular non-symlink file,
appears in system `ND-105e0d6ec813e1468da715e7.owned_paths`, is absent from proof
`ND-12be7352e46a017421437ae7.covered_paths`, and that proof has exactly one file at the canonical
`sales-notes-compatibility-boundary-proof--ND-12be7352e46a017421437ae7.yaml` path. Thus the sole
remaining compatibility residual is the already-documented fail-closed behavior for a different,
legacy graph whose amended node is stored under a noncanonical historical filename. It does not
apply to this live repair.

Final verdict: **clean for the released semantic-rebind contract and exact live acceptance
repair; no actionable blocker**. This lane changed only these append-only coordination notes and
did not mutate source, profiles, live state, binaries, processes, worktrees, branches, or TUI.
