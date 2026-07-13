---
name: operate-koni
description: Initialize, validate, run, inspect, pause, resume, recover, and safely remove Köni project workflows. Use when Codex needs to run `koni init`, use the Köni TUI or automation CLI, plan and approve runs, answer structured questions, supervise stages and tickets, inspect receipts or pinned state, diagnose blocked or interrupted work, drive an external review loop, or recover without bypassing compiler and Git safety boundaries.
---

# Operate Köni

Operate the compiler-owned lifecycle through Köni commands and durable boundaries. Inspect before mutating and preserve audit evidence.

## Start safely

1. Run `koni init --dry-run` when initialization, replacement, or legacy migration may be involved.
2. Run `koni init` from the project when `.codex/koni` is absent. Use `--target <path>` only to initialize an exact directory; use `--replace` only for resources Köni already owns.
3. Confirm `.codex/koni/project.yaml`, `.codex/koni/profile.yaml`, native agents, and repository skills exist. Initialization configures the project but does not create or approve a run.
4. Open the control center with `koni`, or use explicit CLI commands for automation.

Read [run-lifecycle.md](references/run-lifecycle.md) before crossing plan, approval, execution, or integration boundaries. Read [operator-surfaces.md](references/operator-surfaces.md) for TUI and CLI selection. Read [recovery.md](references/recovery.md) before retrying, deleting, or repairing durable work.

## Operate one run

1. Select a run type and record a clear goal plus typed intake.
2. Let the configured planning prefix complete. Answer only compiler-owned structured questions; resume the bound planning session after an answer.
3. Review the pinned plan, configuration identity, base commit, question decisions, and approval risks.
4. Approve explicitly. Treat approval as the first permanent run branch and semantic initialization boundary.
5. Let automatic supervision reconcile orchestration, workers, review, checks, reports, and interrupted transient work.
6. Stop at questions, pauses, manual/checkpoint stages, external loops, or failed/blocked stages. Drive only the current explicit boundary.
7. Require terminal tickets, current proof, accepted review, and a terminal pipeline before declaring the run concluded.

## Diagnose from durable evidence

- Use `koni runs --root .` to orient across runs, then pass global `--run <run-id>` to run-specific automation.
- Use `koni inspect --root .` and `koni cockpit . --json` for deterministic state projections.
- Use `koni validate --root .` before and after recovery. Use `koni validate-profile .codex/koni/profile.yaml` for live configuration changes intended for future runs.
- Inspect the current pipeline stage, ticket status, blockers, questions, agent attempts, check receipts, review, events, and Git/worktree state before choosing a command.
- Prefer the configured action interface over manual edits to graph, tickets, receipts, run records, refs, or worktrees.
- Distinguish waiting from failure. Waiting for input, approval, a worker boundary, or an external provider is not corruption.

## Preserve pinned execution

- Operate an active run from its verified configuration snapshot. Never substitute later live `.codex/koni` edits into it.
- Preserve run IDs, ticket IDs, branch ownership, context hashes, output hashes, check freshness, and receipt chains.
- Do not edit compiler-owned state or delete worktrees and refs manually.
- Do not force a ticket closed, forge a receipt, skip required review, or replay an irreversible effect outside its action journal.
- Pause when authority is ambiguous. Use preview and validation surfaces before destructive recovery.

## Hand off clearly

Report the selected run, current stage, ticket counts, active or waiting agents, open decisions, validation result, recovery action taken, and next explicit boundary. Avoid claiming success from process exit alone; cite terminal state and current receipts.
