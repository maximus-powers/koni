# Köni

**Graph-first planning and execution for coding agents.**

Köni turns a goal into an inspectable graph of work, compiles missing
relationships into tickets, and runs those tickets through explicit planning,
review, verification, and Git boundaries. The engine is deterministic; agents
provide judgment only where the project configuration asks for it.

> Köni is pre-1.0 software. It is ready for evaluation and development, but
> configuration compatibility is not yet guaranteed between minor releases.
> See [Maturity](docs/maturity.md) before using it on critical repositories.

## Why Köni?

Most agent harnesses begin with a prompt and hope the resulting sequence of
actions stays coherent. Köni begins with structure:

```text
goal → semantic graph → missing obligations → tickets → isolated work
                                                        ↓
                                      checks → review → squash integration
```

- **Graph-first planning** keeps dependencies, evidence, and ownership visible.
- **Project-owned behavior** lives beside the code in `.codex/koni/`.
- **Pinned runs** do not change when future configuration is edited.
- **Isolated workers** use run- and ticket-specific branches and worktrees.
- **Receipts and gates** make completion an auditable state transition.
- **One control center** covers planning, configuration, questions, agents, and
  recovery.

The name comes from the Königsberg bridge problem: the useful abstraction is
the topology—what connects to what—not a prematurely chosen route through it.
Read the [philosophy](docs/philosophy.md) for the full model.

## Quick start

Build and install the current development version:

```sh
git clone https://github.com/maximus-powers/koni.git
cd koni
cargo install --path crates/koni-cli
```

Homebrew packaging is being prepared, but no formula is published yet. Once it
is available, installation will be:

```sh
brew install koni
```

Initialize Köni from anywhere inside a project:

```sh
cd my-project
koni init
koni
```

`koni init` finds the enclosing project root, creates `.codex/` when
needed, and installs the bundled software profile, native Codex agents, and
repository skills. It preserves unrelated Codex resources and validates the
complete staged configuration before publishing it. Initialization configures
the project; it does not create a run.

In the control center, press `n` to describe a run, choose its run type, and
review its effective models, question policy, and parallelism. Planning pins
the base commit and configuration. Work begins only after explicit approval.

For other initialization modes:

```sh
koni init --profile research
koni init --from /path/to/profile
koni init --target /path/to/project
koni init --dry-run
```

See [Getting started](docs/getting-started.md) for prerequisites, migration,
and a first-run walkthrough.

## What gets installed

```text
my-project/
├── .codex/
│   ├── config.toml               # existing project settings are preserved
│   ├── agents/                   # native Codex agents used by Köni personas
│   └── koni/
│       ├── project.yaml          # run-type catalog
│       ├── run-types/            # complete, selectable run behaviors
│       ├── profile.yaml          # semantic model entry point
│       └── ...                   # graph, rules, workflows, actions, reports
└── .agents/
    └── skills/                   # Köni configuration and operation skills
```

The installed `.codex/koni/` tree is the project contract. The global
`koni` executable supplies the compiler, runtime, TUI, schemas, bundled
templates, migrations, and validation machinery. Initialized projects do not
depend on a Köni source checkout.

## Documentation

- [Getting started](docs/getting-started.md)
- [Philosophy](docs/philosophy.md)
- [Architecture](docs/architecture.md)
- [Configuration reference](docs/configuration.md)
- [Codex agents and skills](docs/codex-resources.md)
- [Control center and CLI](docs/control-center.md)
- [Runtime, state, and Git](docs/runtime-and-git.md)
- [Migration](docs/migration.md)
- [Maturity](docs/maturity.md)

The user-facing Next.js site lives in [`apps/docs`](apps/docs). Its local and
deployment workflow is documented in the [site README](apps/docs/README.md).

## Development

Köni is a Rust workspace pinned by `rust-toolchain.toml`.

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo run -p koni-cli -- --help
```

Validate a profile or exercise the local binary:

```sh
cargo run -p koni-cli -- validate-profile profiles/research
cargo run -p koni-cli -- init --target . --dry-run
```

Contributions are welcome. Start with [Contributing](CONTRIBUTING.md), and
please report security issues according to [Security](SECURITY.md).

## License

Köni is available under the [MIT License](LICENSE).
