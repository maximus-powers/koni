# Operator surfaces

Choose the shared control center for interactive understanding and the bounded CLI for
initialization, validation, status, and non-interactive run creation.

## Control center

Run `/koni` inside ordinary Pi, or invoke `koni tui --root .` in the terminal where you want the
standalone dashboard. Both connect to the same per-project authority and durable state. Use the
control center to:

- view every planning, active, paused, blocked, failed, or concluded run;
- inspect the selected run's tickets, graph, pipeline, questions, agents, health, and reports;
- create a run, review planning output, and approve it;
- answer pending structured decisions;
- observe the current explicit stage and its compiler-owned next boundary;
- pause, resume, or request guarded deletion;
- edit future project configuration through the validated Configure surface.

Treat every panel as a projection of durable records. Select the intended run before acting;
changing selection does not pause or mutate other runs. Use contextual help in the interface when a
key or action is unclear.

## Bounded automation surface

```sh
koni status --root . --json
koni config validate --root . --json
koni run --root . --goal "Deliver the requested outcome" --type medium --target main
```

`koni run` creates a durable provisional/planning run, but it does not approve a plan or merge a
completed branch. Use the control center for questions, plan approval or revision, pause/resume,
deletion, ticket inspection, agent steering, and explicit target-branch merge. These actions are
revisioned authority operations rather than hidden CLI fallbacks.

## Configured actions

Profile-defined actions are compiler inputs for autonomous attempts and checks, not an ambient
operator shell. Inspect their receipts in the control center. Do not replace them with ad hoc graph,
receipt, run-record, ref, or worktree edits.
