# Getting started

This guide takes a repository from no Köni configuration to an approved,
inspectable run.

## Prerequisites

- Git 2.x
- Codex installed and authenticated for agent-backed stages
- A terminal at least 82 columns wide for the interactive control center
- Rust 1.96 or newer only when building Köni from source. Development through
  rustup uses the newer toolchain pinned by this repository.

Köni can configure a directory that is not yet a Git repository. It does not
initialize Git during `koni init`; Git initialization and the baseline commit
happen at the first run boundary that requires them.

## Install

Until the Homebrew formula is published, install from a source checkout:

```sh
git clone https://github.com/maximus-powers/koni.git
cd koni
cargo install --path crates/koni-cli
koni --version
```

The eventual Homebrew interface is `brew install koni`. No tap or core formula
is published yet.

## Initialize a project

From the project or any directory beneath it:

```sh
koni init
```

Köni uses the enclosing Git worktree as the project root. Outside Git it uses
the current directory. Use `--target` when you want an exact destination:

```sh
koni init --target ~/src/my-project
```

The default bundled profile is `software`. Other sources are explicit:

```sh
koni init --profile research
koni init --from ~/profiles/my-team
```

Before publishing any files, initialization stages a complete installation,
validates all catalog and profile references, and checks its owned-file
manifest. Useful controls are:

| Option | Purpose |
| --- | --- |
| `--dry-run` | Show the resolved root, profile, and installation/migration state without changing files |
| `--replace` | Replace only Köni-owned configuration after validation |
| `--open` | Open the control center after a successful initialization |
| `--target PATH` | Initialize an exact directory |

Repeated initialization is safe. Köni preserves unrelated `.codex` content
and refuses to overwrite an owned native resource that was changed after
installation. Review the conflict, move local customization into a project
resource, or use `--replace` only when replacement is intentional.

If the project has a legacy installation, read [Migration](migration.md) before
continuing.

## Open the control center

```sh
cd ~/src/my-project
koni
```

The default Operate view shows all runs, the selected ticket board, planning
and stage details, active agents, and the semantic graph. Press `c` for the
Configure view.

In a non-interactive terminal, Köni prints a plain snapshot instead of entering
the alternate screen. Automation can request JSON:

```sh
koni cockpit . --json
koni runs --root .
```

## Create the first run

1. Press `n`.
2. Describe the goal and choose a run type.
3. Review the effective stages, question behavior, parallel-agent limit, model,
   and reasoning settings.
4. Activate **Start Planning** (or **Start Work** for a no-planning run).
5. Answer any decision-bearing questions.
6. Review the durable planning output.
7. Focus **Approve run** and press Enter.

Planning resolves the base commit and pins the complete effective
configuration. Approval is the first point at which Köni creates a permanent
run branch and worktree. Later edits in Configure affect future runs only.

The bundled run types are complete peers:

| Run type | Best for | Planning | Questions | Parallel agents |
| --- | --- | --- | --- | ---: |
| Small | Narrow, low-risk work | None | No questions | 1 |
| Medium | Normal feature or refactor work | One combined pass | High-impact only | 3 |
| Large | Cross-cutting or risky work | Architecture, risk, verification | Interactive | 5 |

A project may define any additional peers, such as `UI Feature` or
`Infrastructure Change`. Run types are selected, not layered.

## Inspect and control a run

The TUI supervises automatic stages in short restart-safe ticks. Common CLI
equivalents are:

```sh
koni runs --root .
koni plan-run --root . --goal "Introduce a durable cache boundary"
koni approve-run <run-id> --root .
koni supervise-run <run-id> --root .
koni --run <run-id> inspect --root .
koni --run <run-id> cockpit . --json
```

Approval may trigger the first supervision tick automatically. A blocked or
failed stage remains visible and requires an explicit retry; Köni never hides
the failure by skipping the stage.

## Next steps

- Learn the [graph-first philosophy](philosophy.md).
- Understand the [configuration layers](configuration.md).
- Use the complete [TUI and CLI guide](control-center.md).
- Review the [Git and recovery model](runtime-and-git.md).
