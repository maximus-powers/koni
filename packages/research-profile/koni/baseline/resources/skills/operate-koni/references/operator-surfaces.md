# Operator surfaces

Choose the TUI for interactive understanding and the CLI for explicit, scriptable transitions.

## Control center

Run `koni` in an initialized project. Use the control center to:

- view every planning, active, paused, blocked, failed, or concluded run;
- inspect the selected run's tickets, graph, pipeline, questions, agents, health, and reports;
- create a run, review planning output, and approve it;
- answer pending structured decisions;
- invoke configured actions and drive the current explicit stage;
- pause, resume, preview deletion, or retry failed supervised work;
- edit future project configuration through the validated Configure surface.

Treat every panel as a projection of durable records. Select the intended run before acting; changing selection does not pause or mutate other runs. Use contextual help in the interface when a key or action is unclear.

## Automation orientation

```sh
koni runs --root .
koni --run <run-id> inspect --root .
koni --run <run-id> cockpit . --json
koni validate --root .
```

Use global `--run <run-id>` wherever a command can otherwise fall back to a compatibility-selected run.

## Planned-run commands

```sh
koni plan-run --root . --run-type medium --goal "Deliver the requested outcome"
koni resume-planning <run-id> --root .
koni approve-run <run-id> --root .
koni supervise-run <run-id> --root .
```

Read the JSON returned by `plan-run`; do not infer approval readiness from a process exit when a planning agent is incomplete or awaiting input.

## Questions and stages

```sh
koni answer-question <question-id> --option <option-id> --root .
koni answer-question <question-id> --custom "answer" --root .
koni resolve-questions --root .
koni --run <run-id> drive-stage <stage-id> --root .
```

Supply exactly one option or custom answer. Drive only the current matching stage. Do not use internal question-record ingress as a human-facing shortcut.

## External review loops

```sh
koni --run <run-id> start-external-loop <stage-id> --root .
koni --run <run-id> drive-external-loop <loop-id> --root .
```

Each drive performs at most one durable provider transition. Re-run after inspecting the persisted result; do not wrap it in an unbounded foreground polling loop.

## Configured actions

Prefer `koni action <action-id> ...` and the TUI action palette for profile-defined work. Actions validate typed parameters, legal ticket state, checkout requirements, effect order, journals, compensation, and recovery. Do not replace them with ad hoc edits or Git commands.
