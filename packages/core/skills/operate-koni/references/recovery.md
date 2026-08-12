# Recovery

Recover from the narrowest durable boundary. Inspect evidence first and never erase the record that
explains the failure.

## Decision table

| Condition                                           | Action                                                                                                                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planning pass interrupted, incomplete, or timed out | In `/koni` or `koni tui`, select the run, inspect its activity and agent transcript, then use Space to pause/resume through the durable recovery boundary                                                                    |
| Run waiting for a structured answer                 | Answer the open question, then allow the bound session/stage to resume                                                                                                                                                       |
| Operator needs to stop new dispatch                 | Select the run and press Space; wait until its row is durably paused                                                                                                                                                         |
| Paused run may continue                             | Validate its state, select it, and press Space to resume through a fresh authorized successor attempt                                                                                                                        |
| Automatic stage failed or blocked                   | Inspect the recorded cause and configured recovery evidence. Use only a specific action surfaced by the control center; if none is offered, keep the run paused and report the blocker rather than inventing a retry command |
| Ticket/action has a configured recovery path        | Allow Core to execute the compiler-owned recovery/forward-compensation boundary and retain its journal and receipts; never invoke profile action IDs as shell commands                                                       |
| External provider loop is waiting                   | Inspect its exact phase and published commit, then drive one transition                                                                                                                                                      |
| Run may be removed                                  | Select the run, press `d`, read the confirmation, and confirm only when its agents and work should be stopped and deleted                                                                                                    |
| Semantic change must be reversed                    | Pause and use only a compiler-surfaced forward-compensation action with exact evidence; current Core exposes no generic rollback CLI and never rewrites history                                                              |

> **Recovery/retry clarification — 2026-07-15.** Recovery repairs ticket, journal, and runtime
> state; it never silently retries a terminal supervised stage. When its JSON result reports
> `recovery_advisory.retry_required: true`, invoke the named `action` for the reported `stage_id`
> (or run the included command). This second explicit boundary revalidates recovery and the pinned
> stage input before dispatch resumes.

> **Pi-native command supersession — 2026-07-16:** Historical Rust releases exposed
> `resume-planning`, `pause-run`, `play-run`, `retry-supervised-stage`, and `delete-run` commands.
> Current Core intentionally does not expose those CLI names. The control center calls the versioned
> authority methods directly; do not reconstruct the removed commands from this history.

## Validate the diagnosis

Check:

1. the selected run and current checkout;
2. pipeline cursor, status, attempts, and blocker reason;
3. open or answer-pending questions;
4. agent startup, PID, exit, timeout, JSONL, and last-message evidence;
5. ticket lease, worktree, context, output, review, and integration state;
6. check receipt status and freshness inputs;
7. snapshot/profile hashes and repository/worktree cleanliness;
8. action journal and compensation/recovery status;
9. external-loop commit binding and provider evidence when applicable.

Run `koni config validate --root . --json` after corrective action. If validation fails, stop before
retrying an effect.

## Never repair by hand

Do not manually:

- mark a stage, ticket, check, review, or run successful;
- edit a pinned snapshot or hash-bound receipt;
- remove locks, run records, journals, or compiler-owned refs;
- reuse another ticket's worktree, receipt, or graph authority;
- force-push or reset a compiler-owned branch;
- copy live configuration over an active run snapshot;
- delete branches during ordinary cleanup.

Deletion defaults to compiler-owned runtime state and worktrees while retaining committed branches.
Request owned-branch deletion only when the preview proves ownership and the user explicitly wants
that destructive scope.

## Escalate with evidence

When recovery remains blocked, report the exact run and stage/ticket IDs, validation errors, latest
durable boundary, relevant receipt or journal status, worktree cleanliness, action attempted, and
why the configured recovery path cannot proceed. Omit secrets and avoid dumping unrelated agent
transcripts.
