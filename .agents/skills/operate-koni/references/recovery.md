# Recovery

Recover from the narrowest durable boundary. Inspect evidence first and never erase the record that explains the failure.

## Decision table

| Condition | Action |
| --- | --- |
| Planning pass interrupted, incomplete, or timed out | Run `koni resume-planning <run-id> --root .`; preserve the captured session when valid |
| Run waiting for a structured answer | Answer the open question, then allow the bound session/stage to resume |
| Operator needs to stop new dispatch | Run `koni pause-run <run-id> --root .`; allow active agents to reach a durable boundary |
| Paused run may continue | Run `koni play-run <run-id> --root .` after validating its state |
| Automatic stage failed or blocked | Address its recorded cause, then run `koni retry-supervised-stage <run-id> <stage-id> --root .` |
| Ticket/action has a configured recovery path | Invoke the configured `recover` or recovery action; retain its journal and compensation receipts |
| External provider loop is waiting | Inspect its exact phase and published commit, then drive one transition |
| Run may be removed | Preview first with `koni delete-run <run-id> --root . --preview` |
| Semantic change must be reversed | Use the configured forward-reversal action with an exact target and nonempty reason; do not rewrite history |

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

Run `koni validate --root .` after corrective action. If validation fails, stop before retrying an effect.

## Never repair by hand

Do not manually:

- mark a stage, ticket, check, review, or run successful;
- edit a pinned snapshot or hash-bound receipt;
- remove locks, run records, journals, or compiler-owned refs;
- reuse another ticket's worktree, receipt, or graph authority;
- force-push or reset a compiler-owned branch;
- copy live configuration over an active run snapshot;
- delete branches during ordinary cleanup.

Deletion defaults to compiler-owned runtime state and worktrees while retaining committed branches. Request owned-branch deletion only when the preview proves ownership and the user explicitly wants that destructive scope.

## Escalate with evidence

When recovery remains blocked, report the exact run and stage/ticket IDs, validation errors, latest durable boundary, relevant receipt or journal status, worktree cleanliness, action attempted, and why the configured recovery path cannot proceed. Omit secrets and avoid dumping unrelated agent transcripts.
