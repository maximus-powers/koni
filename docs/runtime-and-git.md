# Runtime, state, and Git

Köni treats runtime state and Git topology as one safety boundary. Runs are
pinned, workers operate in linked worktrees, and accepted ticket work is
published only through an engine-owned squash transaction.

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

- the goal and typed intake;
- an immutable base commit;

> **Target-aware planning evolution — 2026-07-14:** The original bullet above is retained as the
> historical single-target contract. Planning now captures both the immutable selected target
> branch and that branch's observed base commit, so approval and later promotion can distinguish
> branch identity from the pinned commit without weakening commit immutability.
- the resolved run type and semantic profile hashes;
- a file-by-file snapshot of Köni and referenced Codex resources;
- a detached, policy-read-only planning worktree.

> **Pi/schema 2 snapshot transition in progress — 2026-07-14 (`pi_product_docs_transition`):**
> Referenced Codex resources remain the executable schema-1 snapshot and the reader contract for
> pinned historical runs. Schema-2 planning will pin `.koni` catalog/profile/provider-neutral agent
> resources and Pi-native events instead. Existing Codex-backed runs are archived rather than
> resumed across migration, historical snapshots remain inspectable, and a migrated project has no
> Codex fallback. Release still requires authoritative archival, migration recovery/security, and
> the frozen matrix in [Direct Pi runtime](pi-runtime.md).

> **Release-candidate supersession — 2026-07-14 (`pi_product_docs_transition`):** The archival,
> migration, security, and frozen-matrix holds above are now closed for current source. The
> schema-2/direct-Pi release candidate is supported for networked execution on macOS and has no
> production Codex fallback. Its exact first-cut credential TCB is the Köni Rust binary, bundled Pi
> host, pinned Pi SDK 0.80.7 dependency closure, and official pinned Node 22.19.0 runtime; Node has
> no compiler-tool, graph, Git, receipt, or project-file authority. Linux login/inference fail
> closed pending destination-allowlisted egress. Installation and migration are separate guarded
> operator actions; protected forensic Updog state authorizes neither.

Approval verifies the snapshot, removes the clean planning worktree, creates
the permanent run branch/worktree, seeds semantic state, and compiles the
initial board. A selected-run pointer exists for compatibility; selecting one
run does not mutate another.

Automatic supervision proceeds in short, restart-safe ticks. It reconciles
known interrupted work, respects pause and question state, schedules eligible
tickets within configured bounds, and advances automatic review, checkpoint,
and report stages. A terminal stage failure requires an explicit retry.

> **Supervision hardening — evolved 2026-07-14.** The original explicit-retry rule above remains
> the authority boundary. The current runtime additionally permits at most one compiler-directed
> corrective pass after independent review rejects a candidate; a second failed review records a
> blocker instead of spending unbounded rework turns. Separately, two consecutive identity-bound
> terminal worker sessions with no durable output open a no-output blocker before a third dispatch.
> Neither circuit invents completion or discards the failed evidence; operator recovery remains
> explicit.

> **Process-exit and passive-wait refinement — evolved 2026-07-16.** A process that was already
> compiler-owned may publish its exact diagnostic exit while a live run is paused or awaiting a
> question, but only after an action-length run-authority wait and an under-lock recheck of the
> registry, control namespace, deletion state, and exact agent/process binding. Deleted,
> unregistered, concluded, redirected, or missing state receives no write or cleanup. Explicit
> recovery may first record `exited_without_receipt` without inventing success; a later exact
> receipt replaces that status while preserving the recovery evidence. Separately, passive
> exact-live polling ignores proven terminal history but falls back to full supervision for every
> additional unfinished agent row, including stranded startup or committed-boundary state.

## Storage locations

Installed project configuration is reviewable in the product tree:

```text
<project>/.codex/koni/
<project>/.codex/agents/
<project>/.agents/skills/
```

> **Installed-layout transition in progress — 2026-07-14 (`pi_product_docs_transition`):** The
> three paths above remain the schema-1 product layout. Schema 2 publishes live semantic and
> provider-neutral agent resources beneath `.koni/` while retaining `.agents/skills/`; the
> Git-common run sidecar and its historical readers remain compiler-owned. Publication must reject
> symlinked ancestors, transform only schema-owned fields, bind current run-registry archival
> evidence, and recover every interrupted rename. Until those and the Pi security/frozen-matrix
> gates pass, source-in-progress `.koni` state is not an installed runtime contract.

> **Installed-layout supersession — 2026-07-14 (`pi_product_docs_transition`):** Those
> publication, archival, recovery, security, and matrix gates now pass for release-candidate
> source. `.koni` is the live layout after fresh schema-2 init or explicit guarded migration;
> schema-1 installations remain unchanged until that operator action, and migrated runs never fall
> back to Codex.

Project-wide runtime coordination lives under the repository's Git common
directory, shared by the main checkout and every linked worktree:

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

For a normal repository, `<git-common-dir>` is `.git`. For a linked
worktree it is the shared common directory reported by Git. Do not hard-code
`.git` in integrations.

The sidecar is compiler-owned. Operators should inspect it through `koni
inspect`, `koni cockpit --json`, reports, and recovery commands instead of
editing records directly.

## Semantic storage backends

The profile chooses where graph, ticket, receipt, report, and program state
live.

### `tracked`

`tracked` places semantic state at the configured paths in each run's
integration and ticket worktrees. Use it when the graph and reports are
first-class project artifacts that belong in Git.

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

Ticket graph proposals remain isolated until review and integration. The
integration transaction commits the accepted semantic and product changes
together.

### `git_common_dir`

`git_common_dir` keeps semantic state in the run sidecar, leaving the product
tree clean. Use it when the graph is orchestration metadata rather than a
shipped artifact.

Ticket workers receive projected semantic state and submit structured deltas.
The engine publishes accepted sidecar state under the same run authority
boundary as product integration. Some cross-backend rollback operations are
more conservative for this mode; see [Recovery](#recovery-and-forward-reversal).

## Branch and worktree topology

Run types provide branch templates. The default shape is:

```text
refs/heads/main
refs/heads/koni/runs/<run-slug>-<short-id>
refs/heads/koni/runs/<run-id>/tickets/<ticket-id>
```

Each approved run receives:

- one integration branch pinned from its approved base;

> **Target-aware branch evolution — 2026-07-14:** “Its approved base” above was the original
> single-target wording. The current branch is pinned from the selected target branch's approved
> base; the target identity and observed base are recorded separately and revalidated by target
> synchronization and promotion.
- one integration worktree;
- zero or more ticket branches and ticket worktrees;
- one temporary detached planning worktree before approval.

Branch names, worktree names, base commits, and locations are recorded in the
run registry. Every ownership-sensitive operation compares those records to
the live repository. A reused path, unexpected branch, dirty worktree, or
mismatched HEAD fails closed.

Multiple approved runs may coexist because their namespaces are disjoint. A
shared Git-common-dir lock serializes project-wide topology mutations; run
authority locks serialize transitions for one run.

## Ticket lifecycle

A compiled ticket normally moves through:

```text
proposed → todo → in_progress → integrating → closed
             ▲          │             │
             └──────────┴── blocked ◄─┘
```

The exact state machine is profile-defined. The engine enforces its declared
transitions and actors.

Starting a ticket:

1. verifies eligibility, dependencies, pause state, and concurrency scope;
2. creates or verifies the owned ticket branch/worktree;
3. issues a context pack bound to current semantic and repository inputs;
4. grants the current workflow persona only the declared scope.

> **Step-relevant context issuance — 2026-07-15:** Step 3 still compiles and
> validates the complete ticket authority before issuing anything. Eligible
> graph-forbidden product execution uses the versioned schema `1.1` compact
> transport; graph authoring, graph/gate analysis, review, and unscoped reads
> retain the full schema `1.0` document. The compact packet keeps exact selected
> steps/checks, file and graph scope, dependency outputs, steering, current
> rework/acceptance, and source-provenance hashes. Required material is never
> byte-truncated: packets exceeding the broker preview ceiling continue through
> the existing paged context path.

> **Prepared-source lease admission — 2026-07-14 (`proof-preparation-binding`):** The eligibility
> shorthand in step 1 now includes a compiler-owned prepared-source check. Immediately before any
> new or existing lease is returned, Köni revalidates a declared preparation ticket's exact
> selected-source capability and compares every persisted ticket write path with all current
> reviewed prepared-source bindings. A ticket compiled before a later preparation cannot retain
> stale overlapping authority, and retrying an existing lease does not bypass the check. Only an
> exact same operation/check/source/path re-preparation projection is admitted; broad, literal, or
> production writes are not.

> **Newest preparation authority transition — 2026-07-14 (`compiler-graph-tdd`):** “All current
> reviewed bindings” above now has one exact selection rule shared with predicate evaluation: for
> each preparation operation registry ID and compiled source node, choose the newest reviewed
> attempt before applying a target-universe filter. A newer failed, stale, or differently targeted
> attempt is a tombstone and cannot reveal an older pass. During historical replay the compiler
> chooses each ticket's latest review strictly before the replay cutoff for supersession ordering,
> but authenticates only the live last review; a post-cutoff re-review therefore fails closed rather
> than retroactively reviving an older preparation.

> **Context delivery transition — 2026-07-14:** The four-step list above preserves the earlier
> start-time shorthand. A current broker-backed worker receives its pinned, scope-bound runtime
> grant first, then must make `koni_runtime.context` its first successful model action. That call
> runs the configured context action and returns the complete step document; the broker rejects
> every new graph query, graph note, or output submission until the successful context receipt
> exists. An exact recorded request may replay for crash recovery. A profile-specific start step
> may also precompile prompt-only context, as Research does, but that does not replace the
> broker-issued, step-bound context document.

> **Model-transport transition in progress — 2026-07-14 (`pi_product_docs_transition`):** The
> compiler-issued context and `koni_runtime` broker authority above survive the transport change.
> Schema 2 sends those exact grants through a Köni-owned Pi host instead of Codex, and the Node
> peer never receives Git, receipt, or graph publication authority. That host is not released until
> the credential-TCB contradiction is resolved: either Rust owns an allowlisted TLS/auth proxy so
> Node never receives bearer tokens/general outbound authority, or the signed/pinned host and
> dependency closure become the credential TCB. Independently trusted/race-free artifacts,
> fail-closed teardown, request/turn/tool state, honest token enforcement, OAuth containment/
> secrecy, and real durable-broker integration must then pass together.

> **Model-transport supersession — 2026-07-14 (`pi_product_docs_transition`):** The choice is
> decided for this release candidate: exact Köni Rust, the bundled host and Pi SDK 0.80.7 closure,
> and pinned official Node 22.19.0 form the provider credential TCB. The packaged runtime is
> digest-pinned, descriptor-staged into private scratch, and rehashed; Rust retains all compiler,
> broker, graph, receipt, Git, and project-filesystem authority. The single production path has no
> Codex fallback. macOS Seatbelt is the networked target; Linux model work and login fail closed
> until an allowlisted outbound egress broker exists.

Each workflow step records structured output, files read/written/deleted,
findings, risks, receipt references, and a recommended next step. Leases prevent
duplicate live workers. Agent history records starting, running, waiting,
completed, failed, and interrupted attempts.

> **Historical-agent reader transition — 2026-07-14 (`pi_product_docs_transition`):** Schema-1
> Codex agent/session records retain these lifecycle projections. Schema 2 adds Pi-native events
> without rewriting old records or interpreting them as executable sessions. Migration archives
> active Codex attempts and refuses to resume them under Pi; exact terminal/event reconciliation
> and TUI compatibility remain frozen-matrix gates.

> **Historical-agent supersession — 2026-07-14 (`pi_product_docs_transition`):** Terminal/event
> reconciliation and TUI compatibility now pass for the release candidate. Pi-native sessions are
> the only executable schema-2 records; schema-1 Codex attempts remain readable archival history,
> and active attempts are permanently archived rather than resumed during guarded migration.

> **Deterministic reopen transition — 2026-07-14:** The lifecycle above historically left a
> successfully integrated terminal ticket's lease, managed checkout, and ticket branch available
> as retained audit state. A later graph change can legitimately re-emit that same deterministic
> ticket ID, but a fresh lease-less ticket must not be published over an occupied Git namespace.
> The current generic contract first binds the exact terminal ticket and branch head to a completed
> integration transaction for the same run, profile, ticket, and integration ref; tracked state
> additionally must match the ticket bytes accepted in that commit. Köni rejects live worker
> authority, foreign/rebound namespaces, dirty work, missing integration provenance, and ambiguous
> transactions. It then durably prepares the reopen retirement, archives exact command-attempt
> authority, removes only the proven managed checkout and integrated ticket branch, and records
> retirement before publishing the new cycle with `lease: null`. Prepared retirement is replayable
> if interruption occurs after an artifact disappears. The prior terminal outputs, reviews, and
> blockers remain in `prior_cycles`; namespace reuse never authorizes silent deletion of
> unintegrated work. Implementation is staged; focused generic and Software regression results are
> recorded in the collaboration registry before this becomes a release claim.

> **Scoped lifecycle release evidence — 2026-07-14:** The staging sentence above is retained as
> implementation history. The generic terminal-reopen cases now pass **2/2**, and the four
> lifecycle-relevant retirement/recovery cases pass **4/4**. The formerly failing exact Software
> stale-delivery consumer passes **1/1** through its second managed cycle. Because unrelated
> preparation/successor and Software bytes moved around that consumer run, one minimal exact
> post-successor rerun remains queued in the integration matrix. That evidence gate does not reopen
> the generic namespace-retirement implementation or weaken its fail-closed ownership proof.

## Journals and receipts

Actions write intent before performing effects. Journals distinguish prepared,
running, succeeded, compensated, and recovery-required states. This lets a
restart reuse terminal results, reconcile a known interrupted boundary, or
stop without guessing.

Receipts bind evidence to current authority. Depending on the primitive, a
receipt may include:

- run, profile, graph, ticket, target, context, and output hashes;
- exact argv, working directory, environment policy, timeout, and exit status;
- result-protocol fields and artifact hashes;
- review verdict and findings;
- source and destination Git object IDs;
- checkpoint and integration identities.

A receipt from stale inputs does not satisfy a current check merely because its
human-readable status says “passed.”

> **Graph-selected proof receipts — 2026-07-14:** The general stale-input rule
> above remains authoritative. An opt-in composite `graph_set` now compiles a
> finite proof neighborhood independently from each ticket target, unions and
> sorts the exact members, and persists each registered child check with its
> semantic source node, argv, working directory, `source_paths`, and
> `covered_paths`. Selection is evaluated only over the effective step-readable
> graph, including traversal intermediates. Runtime rejects topology, contract,
> or source-manifest drift before execution and binds every child receipt to the
> exact parent/set/member/step identity. A required composite receipt type is
> satisfied only when every newest member is passing and admissible; one child
> cannot vacuously stand in for the set.

> A historical expected-red member may remain causal after intended product
> changes only when it is either explicitly named by the step output or was
> compiler-executed against that output's exact ID and hash. A preserving green
> member must be current, must retain the historical member's exact proof-source
> manifest, and rechecks that equality inside the command execution binding.
> After target synchronization, composed verification resolves and replays the
> same required read-only member identities rather than trusting a ticket-local
> aggregate assertion.

> **Executable path closure — 2026-07-14:** The first graph-selected contract
> above is strengthened for interpreter commands. A directly named
> project-local script is causal `source_paths` material even when it has no
> shebang and is not executable. Graph-set members reject shell command strings
> and `env` wrappers, which would otherwise hide a second argv or repository
> path from receipt identity. Non-shell inline interpreter programs remain
> exact argv material and do not manufacture a filepath dependency.

> **Pre-merge checkout authority — 2026-07-14:** The receipt rules above also
> bind *which checkout supplies the bytes*. Before ticket integration, a
> Git-common ticket's graph-selected source/covered-path currentness,
> filesystem predicates, review-effect coverage, and candidate-graph
> validation resolve repository files from that ticket's canonical leased
> worktree. The semantic graph, tickets, and receipts remain in the shared
> common store; using the main or run-integration checkout for these concrete
> bytes would review a different candidate. After target synchronization,
> composed verification deliberately resolves against the canonical run
> integration checkout instead.

## Commands and containment

Configured commands use argv arrays. Köni does not invoke a shell to interpret
profile strings. The runner applies:

- a contained project-relative working directory;
- explicit inherited and set environment variables;
- timeout and interruption handling;
- a declared effect such as `read_only` or `workspace_write`;
- structured result-protocol and JSON Schema validation;
- retry policy and durable attempt receipts.

> **Configured-check containment transition — 2026-07-16:** The timeout and interruption bullet
> above is strengthened from direct-child termination to full attempt ownership. Every Unix check
> starts in a fresh Koni-owned process group. The runner drains stdout and stderr through
> nonblocking, independently bounded captures, retains at most 1 MiB per stream and 1.5 MiB across
> an attempt, and hashes every observed byte even after the diagnostic prefix is full. Receipts
> record observed bytes, retained bytes, and truncation separately for each stream. Normal leader
> exit gets a short bounded descendant-drain window; remaining same-group helpers are then stopped
> with TERM followed by bounded KILL, and timeout, stop, setup, read, and wait failures use the same
> group cleanup boundary. A configured result document is capped at 1 MiB, including file-backed
> results; oversize or truncated stdout results fail explicitly rather than being parsed as partial
> evidence. An expected nonzero check with truncated diagnostics is likewise inadmissible because
> Koni cannot safely distinguish an intentional red from hidden infrastructure failure.

On macOS, automatic read-only checks use a Seatbelt policy derived from
declared read paths, required system/toolchain reads, denied network, and
private scratch. On platforms without equivalent read containment, safety
guarantees are more conservative; see [Maturity](maturity.md).

Read-only attempts are also audited for mutations. Unexpected changes are
quarantined and require exact operator restoration rather than an inferred
reverse patch.

## Review and squash integration

Finishing a ticket does not merge its branch directly. Köni:

1. verifies current context and required receipts;
2. validates product and semantic write scopes;
3. executes configured checks;
4. records the review verdict;
5. composes the candidate Git tree against the run integration tip;
6. reports conflicts without mutating the integration checkout;
7. creates one single-parent squash commit with configured trailers;
8. publishes accepted semantic state and checkpoints;
9. recompiles the graph to discover newly eligible or retired work.

The ticket's internal commit history is not copied into the integration branch.
The squash commit is the reviewed transaction boundary.

Köni never resolves a conflict by choosing a side automatically. A resolver
ticket or explicit operator action must produce a new reviewed candidate.

> **Immutable review-effect transition — 2026-07-14:** A configured passing
> review that changes semantic graph state records one exact pre→post envelope:
> the canonical review input and configured actor, complete sorted candidate
> universe, exact pre-effect candidate snapshots and semantic graph hash,
> declaration-ordered selectors and resolved assignments, and the exact
> post-effect graph hash. Replay reconstructs and revalidates the configured
> transition on a clone. The exact pre-state applies once; the exact post-state
> is a true no-op; every other state, actor, input, target/scope/anchor drift,
> incomplete member set, or mapping mismatch fails without changing the caller
> graph. This is graph-projection and in-process failure atomicity. The current
> multi-file graph/ticket publisher uses staging plus best-effort rollback but
> has no crash journal or startup recovery protocol, so it must not be
> described as power-loss/crash-safe publication.

> **Preparation review candidate boundary — 2026-07-14
> (`proof-preparation-binding`):** The immutable-effect rule above now has one narrowly typed
> pre-review consumer for a declared proof-source preparation. Because the durable review is the
> fact being created, Köni may defer only that ticket's exact matching preparation-current leaf;
> it still requires the compiler-pinned baseline set, current output and historical receipts,
> unchanged command/source manifest, independent review dependency, complete targets, and the
> exact prospective effect before launching or recording a passing review. This does not affect
> ordinary reviews, does not let failed review establish currentness, and does not relax the
> post-persistence or finish-time target-state check.

> **Authenticated successor materialization transition — 2026-07-14
> (`compiler-graph-tdd`):** A later configured review effect may advance a preparation-owned value
> only when its exact predecessor projection, explicit dotted effect paths, stable boundary,
> historical input/receipts, reviewer result, candidates, snapshots, and replay all authenticate.
> Links are strictly ordered and value-acyclic; disjoint effects are ignored, while missing,
> implicit, forged, cyclic, or future links revoke currentness. In Git-common storage, an active
> base or successor is visible only in that exact ticket's projected review/integration
> materialization; global compilation requires terminal publication. `integration.validate`
> carries that same-ticket materialization identity, then terminal publication makes the binding
> globally available. Tracked storage keeps its atomic graph/ticket visibility. Full compilation
> shares one already-authenticated binding slice across rules and write admission; projected and
> prospective paths still evaluate fresh.

> **Preparation evidence I/O boundary refinement — 2026-07-14
> (`compiler-graph-tdd`):** “Evaluate fresh” above means fresh graph-dependent authentication, not
> repeated directory parsing inside one boundary. A reentrant source-evidence guard snapshots the
> exact state-root/tickets-directory/receipts-directory tuple, loads its tickets once, and lazily
> parses and groups the complete receipt authority once. Derivation resolvers may reuse a binding
> result only for the complete normalized graph identity; excluded annotations or compiler
> projections still invalidate that result because a generic selector may read them. Review,
> integration, and historical replay receive local guards and retain materialization-ticket,
> prospective-effect, and ordered-cutoff semantics. Change-control reconciliation deliberately
> separates derivation evidence from the final emission/write-admission epoch.

## Target synchronization and promotion

> **Contract transition — 2026-07-14.** The earlier lifecycle contract described planning as
> capturing “an immutable base commit” and each integration branch as “pinned from its approved
> base.” That remains the historical contract for runs created before target selection became a
> first-class input. The current target-bound contract pins the selected target ref plus its
> observed base, then creates the integration branch from that approved target base. Because the
> selected target may legitimately advance while the isolated run is active, publication now
> requires an explicit synchronization and verification boundary instead of treating the original
> base alone as sufficient authority.

Ticket integration finishes the isolated run; it does not publish the run to
the branch selected at intake. Near the end of a delivery pipeline, Köni:

1. pins the current run and target heads, which Git rechecks under the repository topology lock;
2. merges that target head into the run branch as a real two-parent commit and records the exact
   resulting `run_head` and observed `target_head` in the successful target-sync output;
3. creates a configured integration-resolution ticket if the trees conflict,
   without writing `MERGE_HEAD` or mutating either checkout;
4. begins composed verification only while both live refs still equal that successful sync
   boundary, then runs the remaining review, verification, and report work against the composed
   product tree;
5. seals the run and marks it ready for an explicit operator decision;
6. previews target drift, checkout cleanliness, and every remaining blocker;
7. advances the target ref only after authorization, with a final repository-locked
   compare-and-swap over both the expected target head and the expected final run head.

> **Ordering correction — 2026-07-14.** Steps 5–7 above preserve the earlier proposed ordering,
> in which semantic sealing preceded the operator-ready boundary. The released runtime instead
> leaves the verified run unsealed while it waits for explicit authorization. After authorization,
> it rechecks the synchronized refs, verification receipts, terminal board, and target checkout;
> only then does it seal semantics, revalidate the possibly advanced final run head, and perform
> the repository-locked two-ref compare-and-swap. This keeps the run available for legitimate
> resynchronization or repair until the operator has actually authorized publication.

If either ref differs from the successful sync output before composed verification, Köni first
persists promotion state with authorization cleared and a synchronization blocker. Only after that
fail-closed write succeeds does it reopen target sync as `Pending`, without an input hash. Thus a
crash or failed pipeline write cannot leave stale authorization attached to the changed head. The
next supervisor tick binds the then-live run and target heads as a new attempt. A second move before
that tick is naturally included; a move after the attempt becomes `Running` but before Git's
compare-and-swap abandons the stale attempt back to unbound `Pending` and retries on a later tick.

The TUI uses `m` on a ready run; the CLI uses `koni merge-run`. Promotion is a
compare-and-swap, not an automatic merge-on-completion. If the target moves
after sync or authorization, the transaction refuses the stale expectation and
reopens target synchronization. If the target branch is checked out with local
changes, promotion leaves both the ref and checkout untouched. A clean checked-
out target is updated together with its ref so the user's working tree matches
the promoted commit.

Once promotion succeeds, the target ref and the run's sealed final head are
identical. No later semantic or report commit is appended behind the published
head.

## Questions and pauses

Question records live in the selected run root. Ticket-scoped questions move
that ticket to `awaiting_input`; run-scoped questions block compilation,
actions, lease acquisition, and stage dispatch for that run only.

Answers first enter an answered-pending-resume state. Köni then resumes the
bound session and completes the question transition. If the resume fails, the
saved answer and pause remain durable. Planning question batches wait for every
member before resuming one shared session.

Automatic resolution is an explicit tick and selects only the configured
recommendation at or after its deadline.

Manual pause is separate from question state. Pausing closes the scheduler gate
and gracefully drains owned agents at durable boundaries. Resuming continues
the pinned run; it does not resolve configuration again.

## External loops

An `external_loop` pipeline stage stores a provider-neutral phase record.
Adapters may map phases to pull-request publication, CI observation, review
feedback, or repair dispatch. Each driver call performs at most one durable
transition and never sleeps in the engine.

Provider configuration, observed identity, evidence, and repair requests are
bound to the owning run and stage. External completion advances only that
pipeline stage. Projects without a configured external loop have no implicit
GitHub or review-service behavior.

## Recovery and forward reversal

`koni recover` inspects incomplete journals and known publication boundaries.
Safe recovery is idempotent: rerunning it either completes the same proven
transition or reports the same blocker.

> **Replacement-worker recovery evolution — 2026-07-15.** Context compilation may observe
> preserved product edits only when state lives in the Git common sidecar, the selected step has no
> durable output, and every changed path is inside that step's write authority. It never commits or
> absorbs those edits. Two identity-bound worker sessions without output open a durable circuit;
> explicit `recover` dispositions that exact blocker, reactivates the existing lease, and starts a
> fresh post-recovery failure window. Tracked-state, post-output, and out-of-scope changes retain the
> older fail-closed behavior.

> **Recovery evolution — 2026-07-14.** The prior contract made explicit `recover` the only stated
> resolution path, and it remains authoritative. A profile may now also designate one typed
> terminal-resolver operation: a terminal source failure deterministically creates or reuses one
> compiler-owned resolution ticket bound to that source and its journal evidence. Resolver failure
> records a blocker and suppresses recursive resolver creation; it never silently retries the
> failed product mutation or replaces explicit recovery.

> **Tracked compiler-transaction checkpoint evolution — 2026-07-16.** A configured recovery that
> relocates one still-planned proof source now uses two exact single-parent checkpoints. H1 binds
> the canonical Complete steering Journal, its action-completion event, and exact superseded retry
> Journals; H2 is the direct child that binds only the transaction, amended graph node,
> deterministic ticket, recovered compile Journal, and completion events. Required-path
> checkpoints start from the parent tree and never broad-stage neighboring worktree changes.
> Historical replay validates both actual deltas. For tracked state, a separate Git-common marker
> is written only after eligible ticket checkouts and retained transient trees are synchronized;
> an absent or interrupted marker keeps ordinary authority quarantined and makes `recover` finish
> that idempotent operational boundary without creating another integration commit.

> **Checkpoint ordering and synchronization clarification — 2026-07-16.** H1 recovery first
> tests whether current HEAD already byte-binds every required request-authority file. When it
> does, that exact existing commit is validated before any tree-exclusion cleanup may run; an H1
> containing unrelated or transient-tree authority is rejected without advancing the integration
> ref. The success event's retry list must equal all earlier exact-input `Recovered` attempts, while
> an earlier independent `Complete` invocation is not misclassified as a failed retry. Both live
> and historical H1/H2 validation require configured transient tree roots to be absent from the
> child tree.
>
> Ticket-checkout synchronization advances each eligible branch with an expected-old-value ref
> CAS, pins checkout's baseline to the exact clean lease/H1/H2 tree already observed, uses safe
> checkout rather than force overwrite, restores symbolic HEAD, and then rechecks ref, index, and
> workdir before writing the operational marker. A relocation-handling `recover` invocation stops
> after this independently journaled unit; unrelated generic recovery, if any remains, is a later
> explicit invocation and cannot append an incidental checkpoint beyond H2. Interruption inside
> libgit2's multi-file safe checkout remains fail-closed: no marker or false seal is published, but
> a mixed checkout can require manual restoration before recovery can continue.

`koni rollback <target> --reason "..." --dry-run` previews semantic forward
reversal. A forward reversal does not rewrite history. When supported, it:

- requires a paused run, clean integration checkout, and no live agents;
- identifies a first-parent ticket integration;
- rejects later overlapping semantic changes;
- archives causal graph, ticket, and worktree state;
- publishes one new commit that reverses the accepted transition.

Forward reversal currently requires tracked semantic state. Git-common-dir
runs are refused until product and sidecar reversal can share one proven atomic
boundary.

Never repair Köni by deleting sidecar files or worktrees manually. Use
`delete-run --preview`, `recover`, validation, and the explicit retry or
rollback commands so ownership and audit history remain intact.

## Direct Pi execution boundary — 2026-07-14

Production planning, review, ticket-worker, and Lead turns now compose a verified single-file Pi
host directly; the Codex CLI path is retained only inside historical/unit-test compatibility code.
The Node process receives no project mount or ambient tool discovery. Rust issues the exact model,
thinking level, prompt, output schema, timeout, token allowance, and broker catalog, then performs
every graph, Git, file, receipt, and lifecycle effect itself.

Planning resumes are durable replays, not hidden provider-thread resumes. A fresh host receives
bounded prior successful outputs (with full-output hashes and explicit truncation), resolved
question decisions, and the current question checkpoint. Every question context must therefore
contain the facts/evidence needed to resume. Token ledgers charge terminal failures and pre-terminal
usage checkpoints as well as successful turns, exclude cache reads only for `new_tokens`, and stop
before a turn when fewer than 16 chargeable tokens remain.

Runtime logs are evidence projections rather than product-data mirrors: message/tool bodies are
represented by hashes and byte counts, worker logs stop at an 8 MiB bound, and durable broker
receipts remain the recovery authority. Compiler read/search/list/context results have transport,
scan-byte, entry-count, and pagination bounds so a model cannot turn a synchronous tool call into
an unbounded repository walk.

**Direct-Pi worker-log transition — 2026-07-14:** The 8 MiB ceiling remains, but production Pi
workers no longer append every session to one ticket-level `worker.log`. Each durable agent/attempt
records its own same-directory `worker.<agent-id>.attempt-<n>.log`; the shared directory keeps the
existing `worker.pid` recovery boundary intact. The payload ceiling reserves space for an explicit
`log_truncated` record, and reopening an older near-cap file repairs its reserved tail before
writing that marker. The cumulative `worker.log` behavior remains only in the historical/test
Codex compatibility seam.

> **Passive worker-wait evolution — 2026-07-15.** The earlier bounded `wait-worker` protocol
> remains available as an explicit low-level compatibility operation, but automatic orchestration
> no longer starts or resumes a Lead model turn solely to poll a live worker. The supervisor records
> `waiting_workers` and observes compiler-owned process state without cognition. A semantic Lead
> turn begins only when work is dispatchable, reviewable, recoverable, or finishable. If an explicit
> legacy wait encounters the worker legitimately holding run authority while it publishes a check
> or output, that observation is a nonterminal wait rather than a terminal Lead failure.

## Run deletion

Deletion is preflighted, journaled, idempotent, and resumable:

1. prove every process, worktree, and branch belongs to the run;
2. refuse live agents and dirty or redirected worktrees;
3. remove owned temporary/runtime artifacts in deterministic order;
4. optionally remove proven run and ticket branches;
5. repair the selected-run pointer;
6. remove the run root last.

The safe mode preserves committed branches. Köni never deletes an artifact it
cannot prove it owns.

## Final Pi projection boundaries — 2026-07-14

The planning-resume paragraph above describes the durable replay envelope. Complete-output hashes
remain compiler-owned integrity inputs, but they are no longer serialized into a fresh model
prompt. The model sees ordered semantic stage titles/content, byte counts, explicit truncation, and
resolved human decisions; it does not see compiler hashes, run/stage/session/batch IDs, or absolute
paths.

Git-common projection roots are state-dependent. Before `start` (`todo`) and after integration
(terminal state), the integration checkout is authoritative because no private ticket checkout
exists. Once a ticket enters an active state, ticket-local projection, context, review, worker, and
acceptance paths require its exact canonical worktree lease. Missing, relative, redirected,
wrong-repository, or wrong-branch leases fail closed; no active agent or evaluation path falls back
to the integration checkout.

> **Explicit review-rework disposition — 2026-07-15.** The bounded two-failure review circuit
> above still stops automatic retries and preserves both rejected candidates and verdicts. It is
> no longer a dead end: an operator may record nonempty, ticket-scoped steering with kind
> `review-rework`, then run `recover`. Recovery accepts only steering recorded after that exact
> circuit opened, cryptographically binds its event into the disposition, supersedes the rejected
> current output without deleting history, and reopens the configured correction step. Ordinary
> `recover`, stale steering, run-wide steering, or a differently named kind cannot bypass the
> circuit. A later failed independent review opens a new circuit rather than permitting an
> unbounded retry loop.

> **Passed-review correction evolution — 2026-07-15 (`primary-integrator/root`).** The explicit
> disposition above now also applies before finish when the latest authoritative information
> disproves a passed review. A nonempty, exact ticket-scoped `review-rework` event recorded after
> the reviewer input session began makes that pass non-authoritative even if the reviewer publishes
> later. `recover` preserves the review as audit history, supersedes the configured owner/dependent
> outputs, and records the event ID, hash, time, and correction message in the reopened ticket. For
> Git-common state, removing the reviewed output prevents review-effect replay. For tracked state,
> recovery first authenticates the exact recorded post-effect graph, reconstructs the bound
> `pre_effect_nodes`, and atomically publishes that graph with the reopened ticket; stale or
> tampered effects fail closed without partial reopening. Finish and integration repeat the
> supersession check even after compiler-owned projection refresh. The replacement reviewer sees
> and cryptographically binds the correction, and only a review whose input session began after it
> can restore acceptance. Older, empty, run-wide, conflicting-ticket, and non-`review-rework`
> steering do not revoke a valid pass.

> **Recovery / supervised-retry clarification — 2026-07-15
> (`recovery-dispatch-audit/root`).** “Reopens the configured correction step” above refers to the
> ticket workflow. If the orchestration pipeline had already terminally blocked while waiting for
> that operator disposition, recovery deliberately leaves the stage blocked: it does not also
> exercise retry authority. Once recovery's own journal is complete, its result now includes a
> `recovery_advisory` with `retry_required`, `stage_id`, `action`, and the exact command whenever
> the post-recovery compiler board has a safe continuation. The operator then invokes
> `retry-supervised-stage`; that separate boundary rechecks recovery state, recomputes the pinned
> stage input, and preserves committed Lead-broker replay safety before supervision continues.

> **Passed-review integration transaction hardening — 2026-07-15
> (`primary-integrator/root`).** The correction evolution above now distinguishes review history,
> journal replay authority, and Git publication authority. Every still-current passed review is
> checked for a newer exact ticket correction, so a later same-output pass cannot hide an earlier
> revoked review. Finish preparation records the registered integration ref and its exact pre-CAS
> head. Recovery may retire a `prepared` transaction only when that ref still proves no product
> integration occurred; rewrites, merges, this ticket's Koni integration trailer, or any
> non-compiler path advance fail closed. A terminal ticket with a complete or absent transaction
> cannot be partially reopened and instead requires an explicit forward correction.
>
> Tracked finish journals become `Complete` before their deferred squash CAS. Both completed-
> journal replay exits therefore require the correlated transaction boundary to be exactly
> `complete`; `prepared`, missing, duplicate, or differently bound boundaries cannot advance the
> pipeline. When a profile names its integration recipe step, replay reconstructs that step's
> authoritative result in memory from the completed boundary so the pipeline result matches the
> original execution without dirtying the already-integrated ticket checkout. Newer correction
> first retires the correlated journal, then reopens outputs/effects, and finally marks the
> transaction superseded; retry is idempotent at each durable authority boundary.
>
> **Crash-atomicity clarification.** The older paragraph's phrase “atomically publishes” means
> rollback-on-return-error for the graph/ticket rename sequence, not power-loss atomicity. The
> corrected active ticket status is now included in that single in-process publication, ordinary
> lane writes publish the new value before removing the old, and duplicate lifecycle lanes fail
> closed. A process/host crash between `.review-staging-*` / `.review-backup-*` renames still lacks
> a durable publication journal and remains the previously documented P1 storage-hardening item.
> Do not claim full power-loss safety for review-effect publication until fault-injected recovery
> converges every rename boundary to old/old or new/new.
