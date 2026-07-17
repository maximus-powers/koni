# Köni

**Graph-first planning and execution for coding agents.**

Köni turns a goal into an inspectable graph of work, compiles missing
relationships into tickets, and runs those tickets through explicit planning,
review, verification, and Git boundaries. The engine is deterministic; agents
provide judgment only where the project configuration asks for it.

> Köni is pre-1.0 software. It is ready for evaluation and development, but
> configuration compatibility is not yet guaranteed between minor releases.
> See [Maturity](docs/maturity.md) before using it on critical repositories.

> **Pi-native 1.0 supersession — 2026-07-16:** The pre-1.0 warning above describes the frozen Rust
> implementation retained as the parity oracle. The shipping package line begins at
> `@koni/core@1.0.0`; its public profile/package protocols are versioned, profile upgrades preserve
> project overlays, and active legacy state moves only through guarded migration. The release is
> still intentionally conservative for critical repositories until every executable parity proof
> in `reference/parity/` is green.

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

> **Current project boundary — 2026-07-16:** The `.codex/koni` phrase above is historical. The
> Pi-native packages keep canonical project configuration under `.koni/` and authority/run state
> under the repository Git common directory. They preserve the user’s existing Pi and `.codex`
> resources rather than making either a second Koni configuration authority.

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

> **Pi/schema-2 source-install update — 2026-07-14:** The historical `cargo install` command above
> installs only the Rust binary and is no longer a complete current-source installation. The
> direct Pi runtime also requires its exact bundled host and build-pinned Node image (plus
> bubblewrap on Linux). Use `./scripts/install-dev.sh`, which builds, packages, and smoke-tests that
> complete closure under `${KONI_INSTALL_PREFIX:-$HOME/.local}`. Tagged release archives carry the
> same `bin/` + `libexec/koni/` layout and signed build provenance.

> **Superseded by the Pi-native package port — 2026-07-16:** The Cargo binary and bundled second
> Pi host above are retained only as migration history. Koni now ships as three coarse Pi/npm
> packages: `@koni/core`, `@koni/coding-profile`, and `@koni/research-profile`. Install the Core
> packages through Pi for both `/koni` and the standalone `koni` command. A source checkout uses `./scripts/install-dev.sh`. That script builds and
> installs the same package payloads, registers only those three package sources, and preserves Pi
> authentication and every unrelated setting, package, extension, skill, prompt, and theme. The Rust tree is a frozen, non-shipping parity oracle
> until its executable deletion gate is complete.
>
> ```sh
> pi install npm:@koni/core
> pi install npm:@koni/coding-profile
> # optional second domain:
> pi install npm:@koni/research-profile
> # The same Pi-managed Core exposes the standalone command:
> export PATH="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules/.bin:$PATH"
> ```

> **Single-Pi-runtime correction — 2026-07-16:** The earlier global command without
> `--legacy-peer-deps` let npm solve Core's host-provided peers itself and could install a second Pi
> SDK plus an incompatible TypeBox. Global Koni installation is now superseded entirely: Pi's
> managed npm closure supplies both the extension and its `.bin/koni` link. The launcher locates the user's active Pi 0.80.10 package, verifies it, and
> propagates that exact peer bridge into authority and attempt children. The source installer uses
> versioned, retained package roots and one locked Pi-settings update so unrelated resources and
> already-running authority bytes are not overwritten.

To update the one managed closure without interrupting work, quiesce each active project before
the package update, then start it with the new Core. Quiescing durably pauses runs and aborts
contained sessions; it never discards run state.

```sh
koni stop --root /path/to/project
# Update only Koni-owned sources; profiles publish before Core activation.
pi update npm:@koni/coding-profile
pi update npm:@koni/research-profile   # only when installed
pi update npm:@koni/core
# Then close/reopen Pi, or run /reload in every already-open Pi session.
koni start --root /path/to/project
# Explicitly resume each run that should continue.
```

For a source-checkout installation, use the same stop → reload → start → explicit-resume sequence,
but rerun `./scripts/install-dev.sh` in place of all three `pi update` commands. The source installer
atomically activates a new retained local bundle; mixing the local-source and npm update paths would
create duplicate Koni origins and is rejected.

If `pi list` shows an older Koni source as well as the intended `npm:@koni/*` entries, remove the
exact older source before continuing: `pi remove <old-source>` for user scope or
`pi remove <old-source> --local` for project scope. Koni fails closed on duplicate Core origins;
it never chooses one by load order.

> **Duplicate-origin guard status — 2026-07-16:** The sentence immediately above states the
> release requirement. Until the packed legacy-plus-current guard is green, treat `pi list` as a
> required preflight and remove every older Koni source before loading the new Core. Pi 0.80.10
> otherwise renames duplicate commands to `koni:1`/`koni:2` and removes plain `/koni`.

Homebrew packaging is being prepared, but no formula is published yet. Once it
is available, installation will be:

```sh
brew install koni
```

Current source exposes `koni models`, `koni auth status|login|logout`, and the explicit
`koni migrate-pi --dry-run|--apply` transaction. OAuth login is device-code-only and uses the
ChatGPT subscription path; API keys are neither required nor accepted by this runtime.

> **Current authentication flow — 2026-07-16:** The device-code-only sentence above records an
> earlier checkpoint. Current macOS `koni auth login` requests Pi's standard browser-PKCE flow,
> opens the OpenAI authorization page, and receives the scoped localhost callback. Koni can still
> present a device-code interaction if the runtime/provider supplies one, but it is not the normal
> local flow. The ChatGPT-subscription and no-API-key boundaries remain unchanged; network-enabled
> login and inference are still fail-closed on Linux pending the documented egress broker.

> **Superseded by ordinary Pi authentication — 2026-07-16:** Koni no longer implements a second
> credential store or login command. Interactive and autonomous sessions use the credentials and
> provider setup that Pi already owns. Koni stores only non-secret model/provider selections in a
> compiled run and does not import, export, migrate, or rewrite the user's Pi authentication.

> **Current Core CLI correction — 2026-07-16:** The `models`, `auth`, and `migrate-pi` command
> sentence above describes the retired Rust host and is not a current interface. Pi owns models
> and authentication. The shipping `koni` command exposes `init`, `update`, `start`, `status`,
> `config validate`, `run`, and `tui`; incompatible legacy state is handled only through Core's
> guarded compatibility path, never by reconstructing those removed shell commands.

Initialize Köni from anywhere inside a project:

```sh
cd my-project
koni init
koni
```

`koni init` finds the enclosing project root, asks an interactive user to
choose the bundled Software or Research profile before writing, creates
`.codex/` when needed, and installs its native Codex agents and repository
skills. Non-interactive callers must pass `--profile` or `--from`. It preserves
unrelated Codex resources and validates the complete staged configuration
before publishing it. Initialization configures the project; it does not create
a run.

> **Schema-2 layout update — 2026-07-14:** The `.codex/koni` and native Codex-agent description
> above is retained as schema-1 history. Fresh Pi-era configuration is provider-neutral under
> `.koni/agents` and `.koni`; repository skills remain under `.agents/skills`. Existing projects
> move only through `koni migrate-pi`, which preserves unrelated `.codex` resources and archives
> active Codex-backed runs instead of resuming them under Pi.

In the control center, press `n` to describe a run, choose its run type, and
review its effective models, question policy, and parallelism. Planning pins
the base commit and configuration. Work begins only after explicit approval.

For other initialization modes:

```sh
koni init --profile software
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

> **Current schema-2 installation layout — 2026-07-14:** The tree above is retained as the
> schema-1 installation record. A fresh Pi-era initialization now publishes this provider-neutral
> layout; it does not create executable Codex agents or a live `.codex/koni` tree:
>
> ```text
> my-project/
> ├── .koni/
> │   ├── project.yaml            # schema-2 run-type catalog
> │   ├── run-types/              # complete selectable run behaviors
> │   ├── profile.yaml            # schema-2 semantic model entry point
> │   ├── agents/                 # provider-neutral Koni agent resources
> │   └── resource-manifest.json  # owned external-resource hashes
> └── .agents/
>     └── skills/                 # repository-local Koni skills
> ```
>
> Existing schema-1 projects reach this layout only through `koni migrate-pi --apply`; unrelated
> `.codex` files remain project-owned and untouched.

> **Current profile command — 2026-07-16:** Use `koni init coding` or `koni init research` from the
> Git project. The selected verified package is materialized under `.koni`; later `koni update`
> performs an explicit three-way baseline/overlay upgrade. Existing project configuration and all
> unrelated Pi/Codex resources remain project-owned. Type `/koni` in the user's ordinary Pi
> session, or run `koni tui --root .` explicitly in the terminal that should host the standalone
> dashboard; bare `koni` prints command help and never opens a pane.

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

> **Current Pi-native development commands — 2026-07-16:** The Cargo commands above exercise only
> the frozen historical oracle. Production development runs `npm ci`, `npm run check`, and
> `npm run build` at the repository root. `npm pack --workspace @koni/core` (and the two profile
> workspaces) produces the exact release artifacts; no Rust executable or legacy `runtime/pi-host`
> artifact is included.

## License

Köni is available under the [MIT License](LICENSE).
