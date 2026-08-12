# Run lifecycle

Keep planning, approval, execution, and integration as distinct trust boundaries.

## Initialize the project

From an existing Git repository, choose one installed broad profile explicitly and validate the
result:

```sh
koni init coding --root .       # or: koni init research --root .
koni config validate --root . --json
```

Use `--profile-package /reviewed/package/directory` only for an explicit local package source. In an
ordinary interactive Pi session, `/koni init` may present the installed Coding and Research packages
for selection. Use `koni update --root .` or `/koni update` for a later verified baseline upgrade;
it preserves project-owned overlay changes and stages unresolved upstream changes for review.

Initialization validates package identity and the effective candidate before publication, preserves
unrelated `.codex`, Pi, and repository content, and creates no run. Treat an ownership conflict,
modified managed resource, escaping path, or symlink rejection as a condition to inspect rather than
bypass.

## Plan

Planning selects one run type, resolves one immutable base commit, hashes the resolved run type and
profile, snapshots the selected Koni agents plus Pi-resolved repository resources, records typed
intake, materializes the ordered pipeline, and creates a detached read-only planning checkout.

No permanent run ref exists during planning. Configured planning stages may ask structured
questions. `interactive` pauses every question, `high_impact_only` pauses high-impact questions, and
`autonomous` selects recommendations without a human pause. A pausing answer resumes the same bound
planning session; it does not start a replacement conversation.

## Approve

Approval must be explicit. Before approval, verify the pinned goal, plan, decisions, base, run type,
configuration hashes, and absence of open planning questions.

Approval re-verifies the snapshot, creates the run integration branch/worktree, retires the clean
planning checkout, initializes semantic graph state, compiles the first ticket board, and receipts
the current approval/checkpoint boundaries. Refuse approval when planning output is incomplete or
the snapshot drifted.

## Execute

Automatic supervision performs short restart-safe ticks. It compiles eligible graph gaps, dispatches
the configured Lead, reconciles ticket workers within the parallel limit, advances configured
review/checkpoint/report stages, and revisits interrupted transient work.

Questions, pauses, manual stages, external loops, and failed/blocked stages remain explicit operator
boundaries. Ticket execution follows:

```text
compiled gap -> ticket -> lease/worktree -> context -> step outputs
             -> scoped checks/compile -> integration -> review -> squash
```

Require output for dependency-ready workflow steps, product changes inside write scope, current
required receipts, passing review, and an integration-safe ticket state.

## Conclude

Treat a run as concluded only when its pipeline is terminal and its compiled board is terminal. A
generated report, passing command, or stopped agent is not sufficient by itself. Preserve reports,
receipts, reviews, and events as the audit trail.
