# Runtime, state, and Git

Köni treats runtime state and Git topology as one safety boundary. Runs are pinned, workers operate
in linked worktrees, and accepted ticket work is published only through an engine-owned squash
transaction.

## Project and run lifecycle

```text
configured
    │
    ▼
planning ── question ──► planning
    │
    ▼ explicit approval
approved ─► active ─► paused / blocked / failed
                         │
                         └──────────────► active
                                            │
                                            ▼
                                        concluded
```

`koni init` configures a project but creates no run. Planning captures:

- the goal and typed intake
- the immutable selected target branch and that branch's observed base commit
- the resolved run type and semantic profile hashes
- a file-by-file snapshot of the `.koni` catalog, profile, and provider-neutral agent resources
- a detached, policy-read-only planning worktree

Recording the target identity and the observed base separately lets approval and later promotion
distinguish branch identity from the pinned commit without weakening commit immutability.

Approval verifies the snapshot, removes the clean planning worktree, creates the permanent run
branch and worktree, seeds semantic state, and compiles the initial board. A selected-run pointer
exists for compatibility. Selecting one run does not mutate another.

Automatic supervision proceeds in short, restart-safe ticks. It reconciles known interrupted work,
respects pause and question state, schedules eligible tickets within configured bounds, and advances
automatic review, checkpoint, and report stages. A terminal stage failure requires an explicit
retry.

Two bounded circuits sit inside that rule. The runtime permits at most one compiler-directed
corrective pass after independent review rejects a candidate. A second failed review records a
blocker instead of spending unbounded rework turns. Separately, two consecutive identity-bound
terminal worker sessions with no durable output open a no-output blocker before a third dispatch.
Neither circuit invents completion or discards the failed evidence, and operator recovery stays
explicit.

### Continuous planning sessions

A newly admitted planner pins one attempt ID, one Pi session ID, and revision 0 before provider
work. The live provider process is a disposable host rather than the session identity. Köni releases
that host while waiting for plan review or an operator answer and restores it from the same
authenticated session JSONL when work continues.

Revision 0 publishes a complete planning artifact. Explicit steering appends an authority-bound
message and a contiguous revision record, captures cumulative provider totals as the revision's
budget baseline, and asks for a patch against the latest validated artifact. Compiler failures and
follow-up corrections remain in that revision. Repository discovery, question/evidence records,
duplicate-call detection, transcript history, provider usage, and cost ledgers remain cumulative.
Every validated revision is an immutable checkpoint whose artifact, graph, transcript, launch spec,
and grant hashes remain bound in the run record. Approval seals only the latest checkpoint.

The `planningSession` marker is the compatibility boundary. Historical runs without it keep their
existing multi-attempt launch specs, session files, conversation forks, terminal artifacts, revise
path, and approval rules byte-for-byte. Runtime code never infers continuity from attempt count.

The compiler carries each profile's `review_failure_reopen_from`, including the equivalent
structured reopen route, into the immutable derived ticket and durable run record. The authority
records the failed reviewer attempt ID and blocker. It reopens the configured owner plus its
subsequent workflow once. It issues fresh attempt and session identities for both correction and
review. Stale review output cannot satisfy the reset step. A second failure takes the original
explicit-blocker path. Legacy tickets without the projection remain readable and retain their prior
fail-closed behavior.

A configured check being present in an agent's grant does not imply it ran. Before a successful
terminal assignment may compile, every `validation_checks` member must have an authority-recorded
result for that exact attempt. That result needs both protocol acceptance and semantic pass. Older
check records without the pass bit remain valid history but cannot close current work. Failed
terminal submissions may still stop honestly without fabricating checks.

A process that was already compiler-owned may publish its exact diagnostic exit while a live run is
paused or awaiting a question. It may do so only after an action-length run-authority wait. An
under-lock recheck of the registry, control namespace, deletion state, and exact agent and process
binding must also pass. Deleted, unregistered, concluded, redirected, and missing state receives no
write and no cleanup. Explicit recovery may first record `exited_without_receipt` without inventing
success, and a later exact receipt replaces that status while preserving the recovery evidence.
Passive exact-live polling ignores proven terminal history. It falls back to full supervision for
every additional unfinished agent row, including stranded startup and committed-boundary state.

## Storage locations

Installed project configuration is reviewable in the product tree:

```text
<project>/.koni/
<project>/.agents/skills/
```

Project-wide runtime coordination lives under the repository's Git common directory, shared by the
main checkout and every linked worktree:

```text
<git-common-dir>/koni/
├── project.yaml                     # project ID, registry, selected run
├── locks/
├── command-authority/
├── transactions/
├── worktrees/
│   └── <run-id>/
│       ├── planning/
│       └── integration/
└── runs/
    └── <run-id>/
        ├── configuration/            # immutable file snapshot
        ├── pipeline.yaml
        ├── lifecycle.yaml
        ├── orchestration.yaml
        ├── planning/
        ├── questions/
        ├── agents/
        ├── external-loops/
        ├── reports/
        └── ...
```

For a normal repository, `<git-common-dir>` is `.git`. For a linked worktree it is the shared common
directory that Git reports. Do not hard-code `.git` in integrations.

The sidecar is compiler-owned. Inspect it through the control center, `koni status --json`, reports,
and explicit recovery rather than by editing records directly.

## Semantic storage backends

The profile chooses where graph, ticket, receipt, report, and program state live.

### `tracked`

`tracked` places semantic state at the configured paths in each run's integration and ticket
worktrees. Use it when the graph and reports are first-class project artifacts that belong in Git.

For example:

```yaml
storage:
  backend: tracked
  graph_dir: program/graph
  tickets_dir: program/tickets
  work_dir: program/work
  state_path: program/state.yaml
  reports_dir: program/reports
  receipts_dir: program/receipts
```

Ticket graph proposals stay isolated until review and integration. The integration transaction
commits the accepted semantic and product changes together.

### `git_common_dir`

`git_common_dir` keeps semantic state in the run sidecar, leaving the product tree clean. Use it
when the graph is orchestration metadata rather than a shipped artifact.

Ticket workers receive projected semantic state and submit structured deltas. The engine publishes
accepted sidecar state under the same run authority boundary as product integration. Some
cross-backend rollback operations are more conservative for this mode. See
[Recovery](#recovery-and-forward-reversal).

## Branch and worktree topology

Run types provide branch templates. The default shape is:

```text
refs/heads/main
refs/heads/koni/runs/<run-slug>-<short-id>
refs/heads/koni/runs/<run-id>/tickets/<ticket-id>
```

Each approved run receives:

- one integration branch pinned from the selected target branch's approved base
- one integration worktree
- zero or more ticket branches and ticket worktrees
- one temporary detached planning worktree before approval

The target identity and the observed base are recorded separately, and target synchronization and
promotion revalidate both.

Branch names, worktree names, base commits, and locations are recorded in the run registry. Every
ownership-sensitive operation compares those records to the live repository. A reused path, an
unexpected branch, a dirty worktree, or a mismatched HEAD fails closed.

Multiple approved runs may coexist because their namespaces are disjoint. A shared Git-common-dir
lock serializes project-wide topology mutations. Run authority locks serialize transitions for one
run.

A pre-isolation run may instead arrive with its registered integration checkout at the namespace
root itself. Startup does not reinterpret that old path as a valid new-layout checkout. It blocks
admission and preserves the canonical legacy object and hash. Only for one clean, exact reference,
HEAD, and repository proof does it journal a two-hop Git worktree move through a proof-owned staging
path into `integration`. Recovery identifies the authoritative hop from Git registration and
re-proves the immutable intent. It applies the compiler lock, clears obsolete ticket path
projections, and restores only the recorded prior lifecycle phase. Dirty, redirected, ambiguously
registered, moved-ref, occupied, and foreign-lock evidence stays preserved and token-idle.

The temporary detached planning checkout stays mandatory for every native run. The one compatibility
exception is a run whose hash-bound relocation intent has already settled with status `relocated`.
When its restored lifecycle schedules a replacement planning attempt, that attempt uses the proven,
compiler-locked canonical `integration` checkout. The old runtime had already planned in that
permanent checkout. This includes a paused run whose recorded resume phase is planning. A merely
retired or missing planning checkout does not activate the exception and still fails closed.

## Ticket lifecycle

A compiled ticket normally moves through:

```text
proposed → queued → in_progress → integrating → closed
             ▲          │             │
             └──────────┴── blocked ◄─┘
```

The exact state machine is profile-defined. The engine enforces its declared transitions and actors.

Starting a ticket:

1. Verify eligibility, dependencies, pause state, and concurrency scope.
2. Create or verify the owned ticket branch and worktree.
3. Issue a context pack bound to current semantic and repository inputs.
4. Grant the current workflow persona only the declared scope.

Eligibility includes a compiler-owned prepared-source check. Immediately before any new or existing
lease is returned, Köni revalidates a declared preparation ticket's exact selected-source
capability. It compares every persisted ticket write path with all current reviewed prepared-source
bindings. A ticket compiled before a later preparation cannot retain stale overlapping authority,
and retrying an existing lease does not bypass the check. Only an exact same operation, check,
source, and path re-preparation projection is admitted. Broad, literal, and production writes are
not.

Selecting current reviewed bindings uses one exact rule shared with predicate evaluation. For each
preparation operation registry ID and compiled source node, choose the newest reviewed attempt
before applying a target-universe filter. A newer failed, stale, or differently targeted attempt is
a tombstone and cannot reveal an older pass. During historical replay the compiler chooses each
ticket's latest review strictly before the replay cutoff for supersession ordering. It authenticates
only the live last review. A post-cutoff re-review therefore fails closed rather than retroactively
reviving an older preparation.

Step 3 compiles and validates the complete ticket authority before issuing anything. Eligible
graph-forbidden product execution uses the versioned schema `1.1` compact transport. Graph
authoring, graph and gate analysis, review, and unscoped reads retain the full schema `1.0`
document. The compact packet keeps exact selected steps and checks, file and graph scope, dependency
outputs, steering, current rework and acceptance, and source-provenance hashes. Required material is
never byte-truncated. Packets exceeding the broker preview ceiling continue through the existing
paged context path.

A current broker-backed worker receives its pinned, scope-bound runtime grant first. It must then
make `koni_runtime.context` its first successful model action. That call runs the configured context
action and returns the complete step document. The broker rejects every new graph query, graph note,
and output submission until the successful context receipt exists. An exact recorded request may
replay for crash recovery. A profile-specific start step may also precompile prompt-only context, as
Research does, but that does not replace the broker-issued, step-bound context document.

Core sends those exact grants through the Pi host. It retains all compiler, broker, graph, receipt,
Git, and project-filesystem authority itself.

Each workflow step records structured output, files read, written, and deleted, findings, risks,
receipt references, and a recommended next step. Leases prevent duplicate live workers. Agent
history records starting, running, waiting, completed, failed, and interrupted attempts. Pi-native
sessions are the only executable records. Attempts recorded by the pre-Pi-native Codex CLI runtime
stay readable archival history; today every provider executes through the same Pi-native path.

### Deterministic reopen

A successfully integrated terminal ticket historically left its lease, managed checkout, and ticket
branch available as retained audit state. A later graph change can legitimately re-emit that same
deterministic ticket ID. A fresh lease-less ticket must not be published over an occupied Git
namespace.

The generic contract first binds the exact terminal ticket and branch head to a completed
integration transaction. That transaction must match the same run, profile, ticket, and integration
ref. Tracked state must also match the ticket bytes accepted in that commit. Köni rejects live
worker authority, foreign or rebound namespaces, dirty work, missing integration provenance, and
ambiguous transactions.

It then durably prepares the reopen retirement and archives exact command-attempt authority. It
removes only the proven managed checkout and integrated ticket branch. It records retirement before
publishing the new cycle with `lease: null`. Prepared retirement is replayable if interruption
occurs after an artifact disappears. The prior terminal outputs, reviews, and blockers stay in
`prior_cycles`. Namespace reuse never authorizes silent deletion of unintegrated work.

## Journals and receipts

Actions write intent before performing effects. Journals distinguish prepared, running, succeeded,
compensated, and recovery-required states. This lets a restart reuse terminal results, reconcile a
known interrupted boundary, or stop without guessing.

Receipts bind evidence to current authority. Depending on the primitive, a receipt may include:

- run, profile, graph, ticket, target, context, and output hashes
- exact argv, working directory, environment policy, timeout, and exit status
- result-protocol fields and artifact hashes
- review verdict and findings
- source and destination Git object IDs
- checkpoint and integration identities

A receipt from stale inputs does not satisfy a current check merely because its human-readable
status says "passed."

An opt-in composite `graph_set` compiles a finite proof neighborhood independently from each ticket
target. It unions and sorts the exact members. It persists each registered child check with its
semantic source node, argv, working directory, `source_paths`, and `covered_paths`. Selection is
evaluated only over the effective step-readable graph, including traversal intermediates. Runtime
rejects topology, contract, and source-manifest drift before execution, and it binds every child
receipt to the exact parent, set, member, and step identity. A required composite receipt type is
satisfied only when every newest member is passing and admissible. One child cannot vacuously stand
in for the set.

A historical expected-red member may remain causal after intended product changes in two cases only.
The step output must explicitly name it, or the compiler must have executed it against that output's
exact ID and hash. A preserving green member must be current, must retain the historical member's
exact proof-source manifest, and rechecks that equality inside the command execution binding. After
target synchronization, composed verification resolves and replays the same required read-only
member identities rather than trusting a ticket-local aggregate assertion.

Interpreter commands are handled strictly. A directly named project-local script is causal
`source_paths` material even when it has no shebang and is not executable. Graph-set members reject
shell command strings and `env` wrappers, which would otherwise hide a second argv or repository
path from receipt identity. Non-shell inline interpreter programs stay exact argv material and do
not manufacture a filepath dependency.

Receipts also bind which checkout supplies the bytes. Before ticket integration, several checks
resolve repository files from that ticket's canonical leased worktree. They are graph-selected
source and covered-path currentness, filesystem predicates, review-effect coverage, and
candidate-graph validation. The semantic graph, tickets, and receipts stay in the shared common
store. Using the main or run-integration checkout for these concrete bytes would review a different
candidate. After target synchronization, composed verification deliberately resolves against the
canonical run integration checkout instead.

## Commands and containment

Configured commands use argv arrays. Köni does not invoke a shell to interpret profile strings. The
runner applies:

- a contained project-relative working directory
- explicit inherited and set environment variables
- timeout and interruption handling
- a declared effect such as `read_only` or `workspace_write`
- structured result-protocol and JSON Schema validation
- retry policy and durable attempt receipts

Timeout and interruption handling covers full attempt ownership, not only direct-child termination.
Every Unix check starts in a fresh Koni-owned process group. The runner drains stdout and stderr
through nonblocking, independently bounded captures. It retains at most 1 MiB per stream and 1.5 MiB
across an attempt. It hashes every observed byte even after the diagnostic prefix is full. Receipts
record observed bytes, retained bytes, and truncation separately for each stream.

Normal leader exit gets a short bounded descendant-drain window. Remaining same-group helpers are
then stopped with TERM followed by bounded KILL. Timeout, stop, setup, read, and wait failures use
the same group cleanup boundary. A configured result document is capped at 1 MiB, including
file-backed results. Oversize or truncated stdout results fail explicitly rather than being parsed
as partial evidence. An expected nonzero check with truncated diagnostics is likewise inadmissible,
because Koni cannot safely distinguish an intentional red from a hidden infrastructure failure.

On macOS, automatic read-only checks use a Seatbelt policy derived from declared read paths,
required system and toolchain reads, denied network, and private scratch. On platforms without
equivalent read containment, safety guarantees are more conservative. See [Maturity](maturity.md).

Read-only attempts are also audited for mutations. Unexpected changes are quarantined and require
exact operator restoration rather than an inferred reverse patch.

## Review and squash integration

Finishing a ticket does not merge its branch directly. Köni:

1. Verify current context and required receipts.
2. Validate product and semantic write scopes.
3. Execute configured checks.
4. Record the review verdict.
5. Compose the candidate Git tree against the run integration tip.
6. Report conflicts without mutating the integration checkout.
7. Create one single-parent squash commit with configured trailers.
8. Publish accepted semantic state and checkpoints.
9. Recompile the graph to discover newly eligible or retired work.

The ticket's internal commit history is not copied into the integration branch. The squash commit is
the reviewed transaction boundary.

Köni never resolves a conflict by choosing a side automatically. A resolver ticket or an explicit
operator action must produce a new reviewed candidate.

### Review effects

A configured passing review that changes semantic graph state records one exact pre-effect and
post-effect envelope. That envelope holds the canonical review input and configured actor, plus the
complete sorted candidate universe. It also holds exact pre-effect candidate snapshots and semantic
graph hash, declaration-ordered selectors and resolved assignments, and the exact post-effect graph
hash. Replay reconstructs and revalidates the configured transition on a clone. The exact pre-state
applies once, and the exact post-state is a true no-op. Every other state, actor, input, target or
scope or anchor drift, incomplete member set, and mapping mismatch fails without changing the caller
graph.

That guarantee is graph-projection and in-process failure atomicity. Atomic publication here means
rollback-on-return-error for the graph and ticket rename sequence, not power-loss atomicity. The
corrected active ticket status is included in that single in-process publication. Ordinary lane
writes publish the new value before removing the old, and duplicate lifecycle lanes fail closed. A
process or host crash between `.review-staging-*` and `.review-backup-*` renames still lacks a
durable publication journal. Do not claim full power-loss safety for review-effect publication until
fault-injected recovery converges every rename boundary to old and old, or new and new.

One narrowly typed pre-review consumer exists for a declared proof-source preparation. Because the
durable review is the fact being created, Köni may defer only that ticket's exact matching
preparation-current leaf. It still requires the compiler-pinned baseline set, current output and
historical receipts, and an unchanged command and source manifest. It also requires the independent
review dependency, complete targets, and the exact prospective effect. All of that precedes
launching or recording a passing review. This does not affect ordinary reviews. It does not let a
failed review establish currentness, and it does not relax the post-persistence or finish-time
target-state check.

A later configured review effect may advance a preparation-owned value only when everything it
depends on authenticates. That set is the exact predecessor projection, explicit dotted effect
paths, stable boundary, historical input and receipts, reviewer result, candidates, snapshots, and
replay. Links are strictly ordered and value-acyclic. Disjoint effects are ignored, while missing,
implicit, forged, cyclic, and future links revoke currentness.

In Git-common storage, an active base or successor is visible only in that exact ticket's projected
review and integration materialization. Global compilation requires terminal publication.
`integration.validate` carries that same-ticket materialization identity, and terminal publication
then makes the binding globally available. Tracked storage keeps its atomic graph and ticket
visibility. Full compilation shares one already-authenticated binding slice across rules and write
admission, while projected and prospective paths still evaluate fresh.

Evaluating fresh means fresh graph-dependent authentication, not repeated directory parsing inside
one boundary. A reentrant source-evidence guard snapshots the exact state-root, tickets-directory,
and receipts-directory tuple. It loads its tickets once and lazily parses and groups the complete
receipt authority once. Derivation resolvers may reuse a binding result only for the complete
normalized graph identity. Excluded annotations and compiler projections still invalidate that
result, because a generic selector may read them. Review, integration, and historical replay receive
local guards and retain materialization-ticket, prospective-effect, and ordered-cutoff semantics.
Change-control reconciliation deliberately separates derivation evidence from the final emission and
write-admission epoch.

## Target synchronization and promotion

The current target-bound contract pins the selected target ref plus its observed base, then creates
the integration branch from that approved target base. The selected target may legitimately advance
while the isolated run is active. Publication therefore requires an explicit synchronization and
verification boundary rather than treating the original base alone as sufficient authority.

Ticket integration finishes the isolated run. It does not publish the run to the branch selected at
intake. Near the end of a delivery pipeline, Köni:

1. Pin the current run and target heads, which Git rechecks under the repository topology lock.
2. Merge that target head into the run branch as a real two-parent commit, and record the exact
   resulting `run_head` and observed `target_head` in the successful target-sync output.
3. Create a configured integration-resolution ticket if the trees conflict, without writing
   `MERGE_HEAD` or mutating either checkout.
4. Begin composed verification only while both live refs still equal that successful sync boundary,
   then run the remaining review, verification, and report work against the composed product tree.
5. Leave the verified run unsealed while it waits for explicit operator authorization.
6. Preview target drift, checkout cleanliness, and every remaining blocker.
7. After authorization, recheck the synchronized refs, verification receipts, terminal board, and
   target checkout. Only then seal semantics, revalidate the possibly advanced final run head, and
   perform the repository-locked compare-and-swap over both expected heads.

Leaving the run unsealed until authorization keeps it available for legitimate resynchronization or
repair.

If either ref differs from the successful sync output before composed verification, Köni first
persists promotion state with authorization cleared and a synchronization blocker. Only after that
fail-closed write succeeds does it reopen target sync as `Pending`, without an input hash. A crash
or a failed pipeline write therefore cannot leave stale authorization attached to the changed head.
The next supervisor tick binds the then-live run and target heads as a new attempt. A second move
before that tick is naturally included. A move after the attempt becomes `Running`, but before Git's
compare-and-swap, abandons the stale attempt back to unbound `Pending` and retries on a later tick.

Press `m` on a ready run in the control center to review and authorize promotion. Promotion is a
compare-and-swap, not an automatic merge-on-completion. If the target moves after sync or
authorization, the transaction refuses the stale expectation and reopens target synchronization. If
the target branch is checked out with local changes, promotion leaves both the ref and the checkout
untouched. A clean checked-out target is updated together with its ref, so the working tree matches
the promoted commit.

Once promotion succeeds, the target ref and the run's sealed final head are identical. No later
semantic or report commit is appended behind the published head.

## Questions and pauses

Question records live in the selected run root. Ticket-scoped questions move that ticket to
`awaiting_input`. Run-scoped questions block compilation, actions, lease acquisition, and stage
dispatch for that run only.

Answers first enter an answered-pending-resume state. Köni then resumes the bound session and
completes the question transition. If the resume fails, the saved answer and pause stay durable.
Planning question batches wait for every member before resuming one shared session.

Automatic resolution is an explicit tick. It selects only the configured recommendation at or after
its deadline.

Manual pause is separate from question state. Pausing closes the scheduler gate and gracefully
drains owned agents at durable boundaries. Resuming continues the pinned run. It does not resolve
configuration again.

## External loops

An `external_loop` pipeline stage stores a provider-neutral phase record. Adapters may map phases to
pull-request publication, CI observation, review feedback, or repair dispatch. Each driver call
performs at most one durable transition and never sleeps in the engine.

Provider configuration, observed identity, evidence, and repair requests are bound to the owning run
and stage. External completion advances only that pipeline stage. Projects without a configured
external loop have no implicit GitHub or review-service behavior.

## Recovery and forward reversal

Explicit recovery inspects incomplete journals and known publication boundaries. Safe recovery is
idempotent. Rerunning it either completes the same proven transition or reports the same blocker.

Context compilation may observe preserved product edits under three conditions. State must live in
the Git common sidecar. The selected step must have no durable output. Every changed path must be
inside that step's write authority. It never commits or absorbs those edits. Two identity-bound
worker sessions without output open a durable circuit. Explicit recovery dispositions that exact
blocker, reactivates the existing lease, and starts a fresh post-recovery failure window.
Tracked-state, post-output, and out-of-scope changes retain the older fail-closed behavior.

A profile may also designate one typed terminal-resolver operation. A terminal source failure
deterministically creates or reuses one compiler-owned resolution ticket bound to that source and
its journal evidence. Resolver failure records a blocker and suppresses recursive resolver creation.
It never silently retries the failed product mutation and never replaces explicit recovery.

### Recovery checkpoints

A configured recovery that relocates one still-planned proof source uses two exact single-parent
checkpoints. H1 binds the canonical Complete steering journal, its action-completion event, and
exact superseded retry journals. H2 is the direct child that binds only the transaction, the amended
graph node, the deterministic ticket, the recovered compile journal, and the completion events.
Required-path checkpoints start from the parent tree and never broad-stage neighboring worktree
changes. Historical replay validates both actual deltas.

For tracked state, a separate Git-common marker is written only after eligible ticket checkouts and
retained transient trees are synchronized. An absent or interrupted marker keeps ordinary authority
quarantined, and recovery finishes that idempotent operational boundary without creating another
integration commit.

H1 recovery first tests whether current HEAD already byte-binds every required request-authority
file. When it does, that exact existing commit is validated before any tree-exclusion cleanup may
run. An H1 containing unrelated or transient-tree authority is rejected without advancing the
integration ref. The success event's retry list must equal all earlier exact-input `Recovered`
attempts, while an earlier independent `Complete` invocation is not misclassified as a failed retry.
Both live and historical H1 and H2 validation require configured transient tree roots to be absent
from the child tree.

Ticket-checkout synchronization advances each eligible branch with an expected-old-value ref
compare-and-swap. It pins the checkout baseline to the exact clean lease, H1, and H2 tree already
observed. It uses safe checkout rather than force overwrite and restores symbolic HEAD. It then
rechecks ref, index, and workdir before writing the operational marker. A relocation-handling
recovery invocation stops after this independently journaled unit. Unrelated generic recovery, if
any remains, is a later explicit invocation and cannot append an incidental checkpoint beyond H2.
Interruption inside a multi-file safe checkout stays fail-closed. No marker and no false seal is
published, but a mixed checkout can require manual restoration before recovery can continue.

### Forward reversal

Semantic forward reversal previews first, and it does not rewrite history. When supported, it:

- requires a paused run, a clean integration checkout, and no live agents
- identifies a first-parent ticket integration
- rejects later overlapping semantic changes
- archives causal graph, ticket, and worktree state
- publishes one new commit that reverses the accepted transition

Forward reversal currently requires tracked semantic state. Git-common-dir runs are refused until
product and sidecar reversal can share one proven atomic boundary.

Never repair Köni by deleting sidecar files or worktrees manually. Use the deletion preview,
explicit recovery, validation, and the explicit retry or reversal paths so ownership and audit
history stay intact.

### Review-rework disposition

The bounded two-failure review circuit stops automatic retries and preserves both rejected
candidates and verdicts. It is not a dead end. An operator may record nonempty, ticket-scoped
steering with kind `review-rework`, then run recovery. Recovery accepts only steering recorded after
that exact circuit opened. It cryptographically binds that event into the disposition. It supersedes
the rejected current output without deleting history, then reopens the configured correction step.
Ordinary recovery, stale steering, run-wide steering, and a differently named kind cannot bypass the
circuit. A later failed independent review opens a new circuit rather than permitting an unbounded
retry loop.

That disposition also applies before finish when the latest authoritative information disproves a
passed review. A nonempty, exact ticket-scoped `review-rework` event recorded after the reviewer
input session began makes that pass non-authoritative, even if the reviewer publishes later.
Recovery preserves the review as audit history and supersedes the configured owner and dependent
outputs. It records the event ID, hash, time, and correction message in the reopened ticket.

For Git-common state, removing the reviewed output prevents review-effect replay. For tracked state,
recovery first authenticates the exact recorded post-effect graph, reconstructs the bound
`pre_effect_nodes`, and atomically publishes that graph with the reopened ticket. Stale and tampered
effects fail closed without partial reopening. Finish and integration repeat the supersession check
even after compiler-owned projection refresh. The replacement reviewer sees and cryptographically
binds the correction, and only a review whose input session began after it can restore acceptance.
Older, empty, run-wide, conflicting-ticket, and non-`review-rework` steering do not revoke a valid
pass.

Reopening the configured correction step refers to the ticket workflow. If the orchestration
pipeline had already terminally blocked while waiting for that operator disposition, recovery
deliberately leaves the stage blocked. It does not also exercise retry authority. Once recovery's
own journal is complete, its result includes a `recovery_advisory`. That advisory carries
`retry_required`, `stage_id`, `action`, and the exact continuation whenever the post-recovery
compiler board has a safe one. The operator then invokes that separate retry boundary. It rechecks
recovery state, recomputes the pinned stage input, and preserves committed Lead-broker replay safety
before supervision continues.

### Integration transaction hardening

Review history, journal replay authority, and Git publication authority are distinct. Every
still-current passed review is checked for a newer exact ticket correction, so a later same-output
pass cannot hide an earlier revoked review. Finish preparation records the registered integration
ref and its exact pre-compare-and-swap head. Recovery may retire a `prepared` transaction only when
that ref still proves no product integration occurred. Rewrites, merges, this ticket's Koni
integration trailer, and any non-compiler path advance all fail closed. A terminal ticket with a
complete or absent transaction cannot be partially reopened and instead requires an explicit forward
correction.

Tracked finish journals become `Complete` before their deferred squash compare-and-swap. Both
completed-journal replay exits therefore require the correlated transaction boundary to be exactly
`complete`. Prepared, missing, duplicate, and differently bound boundaries cannot advance the
pipeline. When a profile names its integration recipe step, replay reconstructs that step's
authoritative result in memory from the completed boundary. The pipeline result therefore matches
the original execution without dirtying the already-integrated ticket checkout. A newer correction
first retires the correlated journal, then reopens outputs and effects, and finally marks the
transaction superseded. Retry is idempotent at each durable authority boundary.

## Direct Pi execution boundary

Production planning, review, ticket-worker, and Lead turns compose a verified Pi host directly. The
Node process receives no project mount and no ambient tool discovery. Core issues the exact model,
thinking level, prompt, output schema, timeout, token allowance, and broker catalog. It then
performs every graph, Git, file, receipt, and lifecycle effect itself.

Planning resumes are durable replays, not hidden provider-thread resumes. A fresh host receives
bounded prior successful outputs, with full-output hashes and explicit truncation, resolved question
decisions, and the current question checkpoint. Every question context must therefore contain the
facts and evidence needed to resume. Token ledgers charge terminal failures and pre-terminal usage
checkpoints as well as successful turns. They exclude cache reads only for `new_tokens`, and they
stop before a turn when fewer than 16 chargeable tokens remain.

Runtime logs are evidence projections rather than product-data mirrors. Hashes and byte counts
represent message and tool bodies. Worker logs stop at an 8 MiB bound, and durable broker receipts
stay the recovery authority. Compiler read, search, list, and context results have transport,
scan-byte, entry-count, and pagination bounds. A model therefore cannot turn a synchronous tool call
into an unbounded repository walk.

Each durable agent and attempt records its own same-directory `worker.<agent-id>.attempt-<n>.log`.
The shared directory keeps the existing `worker.pid` recovery boundary intact. The payload ceiling
reserves space for an explicit `log_truncated` record, and reopening an older near-cap file repairs
its reserved tail before writing that marker.

Automatic orchestration does not start or resume a Lead model turn solely to poll a live worker. The
supervisor records `waiting_workers` and observes compiler-owned process state without cognition. A
semantic Lead turn begins only when work is dispatchable, reviewable, recoverable, or finishable. An
explicit low-level wait may encounter the worker legitimately holding run authority while it
publishes a check or output. That observation is a nonterminal wait rather than a terminal Lead
failure.

Complete-output hashes stay compiler-owned integrity inputs, but they are not serialized into a
fresh model prompt. The model sees ordered semantic stage titles and content, byte counts, explicit
truncation, and resolved human decisions. It does not see compiler hashes, run, stage, session, or
batch IDs, or absolute paths.

Git-common projection roots are state-dependent. Before `start`, in `queued`, and after integration
in a terminal state, the integration checkout is authoritative because no private ticket checkout
exists. Once a ticket enters an active state, ticket-local projection, context, review, worker, and
acceptance paths require its exact canonical worktree lease. Missing, relative, redirected,
wrong-repository, and wrong-branch leases fail closed. No active agent or evaluation path falls back
to the integration checkout.

## Run deletion

Deletion is preflighted, journaled, idempotent, and resumable:

1. Prove every process, worktree, and branch belongs to the run.
2. Refuse live agents and dirty or redirected worktrees.
3. Remove owned temporary and runtime artifacts in deterministic order.
4. Optionally remove proven run and ticket branches.
5. Repair the selected-run pointer.
6. Remove the run root last.

The safe mode preserves committed branches. Köni never deletes an artifact it cannot prove it owns.

That rule also applies before legacy relocation. An unrelocated compatibility run is never passed to
ordinary new-layout cleanup. Explicit or already-durable deletion uses a separate source-hash-bound
Git intent. It proves exactly one clean checkout at an allowed legacy, staging, or destination path.
It removes that registered checkout, then deletes only the exact Koni run ref by compare-and-swap.
The user target ref is not a cleanup input. A crash after checkout retirement resumes at ref
retirement. Dirty and ambiguous data is left readable, and the run record is deleted only with an
explicit preservation audit.
