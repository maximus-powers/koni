# Run lifecycle

Keep planning, approval, execution, and integration as distinct trust boundaries.

## Initialize the project

`koni init` discovers the project root, asks an interactive user to choose the bundled Software or Research profile before writing, and publishes current schema-2 `.koni` configuration plus repository skills. A detected schema-1 `.codex/koni` project follows the explicit migration path rather than becoming a second live layout. Non-interactive callers must pass `--profile` or `--from` for a fresh or replacement install. Use:

```sh
koni init --dry-run
koni init
koni init --profile software
koni init --profile research
koni init --from /path/to/profile
koni init --target /path/to/project
koni init --replace
koni init --open
```

Initialization validates staged resources before publication, preserves unrelated `.codex` and `.agents` content, and creates no run. A repeated compatible initialization should be idempotent. Treat an ownership conflict, mixed legacy/current layout, modified owned resource, escaping path, or symlink rejection as a condition to inspect rather than bypass.

## Plan

Planning selects one run type, resolves one immutable base commit, hashes the resolved run type and profile, snapshots Köni plus referenced provider-neutral agents and repository skills, records typed intake, materializes the ordered pipeline, and creates a detached read-only planning checkout. Historical schema-1 snapshots retain their exact Codex resources as audit inputs; they are not a schema-2 fallback.

No permanent run ref exists during planning. Configured planning stages may ask structured questions. `interactive` pauses every question, `high_impact_only` pauses high-impact questions, and `autonomous` selects recommendations without a human pause. A pausing answer resumes the same bound planning session; it does not start a replacement conversation.

## Approve

Approval must be explicit. Before approval, verify the pinned goal, plan, decisions, base, run type, configuration hashes, and absence of open planning questions.

Approval re-verifies the snapshot, creates the run integration branch/worktree, retires the clean planning checkout, initializes semantic graph state, compiles the first ticket board, and receipts the current approval/checkpoint boundaries. Refuse approval when planning output is incomplete or the snapshot drifted.

## Execute

Automatic supervision performs short restart-safe ticks. It compiles eligible graph gaps, dispatches the configured Lead, reconciles ticket workers within the parallel limit, advances configured review/checkpoint/report stages, and revisits interrupted transient work.

Questions, pauses, manual stages, external loops, and failed/blocked stages remain explicit operator boundaries. Ticket execution follows:

```text
compiled gap -> ticket -> lease/worktree -> context -> step outputs
             -> scoped checks/compile -> integration -> review -> squash
```

Require output for dependency-ready workflow steps, product changes inside write scope, current required receipts, passing review, and an integration-safe ticket state.

## Conclude

Treat a run as concluded only when its pipeline is terminal and its compiled board is terminal. A generated report, passing command, or stopped agent is not sufficient by itself. Preserve reports, receipts, reviews, and events as the audit trail.
