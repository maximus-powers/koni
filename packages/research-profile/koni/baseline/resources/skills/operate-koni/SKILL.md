---
name: operate-koni
description: Initialize, validate, run, inspect, pause, resume, recover, and safely remove Köni project workflows. Use when a Pi agent needs to use `/koni`, `koni tui`, or the bounded Köni CLI; plan and approve runs; answer structured questions; inspect receipts or pinned state; diagnose blocked or interrupted work; or recover without bypassing compiler and Git safety boundaries.
---

# Operate Köni

Operate the compiler-owned lifecycle through Köni commands and durable boundaries. Inspect before mutating and preserve audit evidence.

## Start safely

1. Run `koni status --root . --json` and `koni config validate --root . --json` before changing an existing project.
2. Treat current `.koni/project.yaml` as initialized. From an uninitialized Git project, use `koni init coding --root .` or `koni init research --root .`. If only legacy `.codex/koni` state exists, use the guarded migration surfaced by Core rather than copying or rewriting it manually.
3. Confirm `.koni/project.yaml`, every referenced profile/run type/agent resource, and repository skills exist. Initialization installs a verified profile baseline plus the project-owned overlay; it does not create or approve a run.
4. Open the control center with `/koni` inside ordinary Pi, or run `koni tui --root .` in the terminal where the standalone dashboard should appear. Koni never opens a pane itself.

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

- Use `/koni` or `koni tui --root .` to orient across runs, tickets, agents, questions, graph changes, reports, and Git readiness. Selecting a run is read-only.
- Use `koni status --root . --json` for a scriptable authority/profile projection and `koni config validate --root . --json` before and after recovery or configuration publication.
- Use the control center's guided Configure surface for future-run configuration. It publishes only after whole-candidate compilation and source-CAS validation; active runs continue using their pinned snapshots.
- Inspect the current pipeline stage, ticket status, blockers, questions, agent attempts, check receipts, review, events, and Git/worktree state before choosing a command.
- Prefer the configured action interface over manual edits to graph, tickets, receipts, run records, refs, or worktrees.
- Distinguish waiting from failure. Waiting for input, approval, a worker boundary, or an external provider is not corruption.

## Preserve pinned execution

- Operate an active run from its verified configuration snapshot. Never substitute later live `.koni` or legacy `.codex/koni` edits into it.
- Preserve run IDs, ticket IDs, branch ownership, context hashes, output hashes, check freshness, and receipt chains.
- Do not edit compiler-owned state or delete worktrees and refs manually.
- Do not force a ticket closed, forge a receipt, skip required review, or replay an irreversible effect outside its action journal.
- Pause when authority is ambiguous. Use preview and validation surfaces before destructive recovery.

## Hand off clearly

Report the selected run, current stage, ticket counts, active or waiting agents, open decisions, validation result, recovery action taken, and next explicit boundary. Avoid claiming success from process exit alone; cite terminal state and current receipts.
