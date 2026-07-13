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
- the resolved run type and semantic profile hashes;
- a file-by-file snapshot of Köni and referenced Codex resources;
- a detached, policy-read-only planning worktree.

Approval verifies the snapshot, removes the clean planning worktree, creates
the permanent run branch/worktree, seeds semantic state, and compiles the
initial board. A selected-run pointer exists for compatibility; selecting one
run does not mutate another.

Automatic supervision proceeds in short, restart-safe ticks. It reconciles
known interrupted work, respects pause and question state, schedules eligible
tickets within configured bounds, and advances automatic review, checkpoint,
and report stages. A terminal stage failure requires an explicit retry.

## Storage locations

Installed project configuration is reviewable in the product tree:

```text
<project>/.codex/koni/
<project>/.codex/agents/
<project>/.agents/skills/
```

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

Each workflow step records structured output, files read/written/deleted,
findings, risks, receipt references, and a recommended next step. Leases prevent
duplicate live workers. Agent history records starting, running, waiting,
completed, failed, and interrupted attempts.

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

## Commands and containment

Configured commands use argv arrays. Köni does not invoke a shell to interpret
profile strings. The runner applies:

- a contained project-relative working directory;
- explicit inherited and set environment variables;
- timeout and interruption handling;
- a declared effect such as `read_only` or `workspace_write`;
- structured result-protocol and JSON Schema validation;
- retry policy and durable attempt receipts.

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
