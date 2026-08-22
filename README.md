# Köni

**Graph-first planning and execution for coding agents.**

Köni turns a goal into an inspectable graph of work. It compiles missing relationships into tickets.
It then runs each ticket through explicit planning, review, verification, and Git boundaries. The
engine is deterministic. Agents supply judgment only where the project configuration asks for it.

> The shipping package line begins at `@koni/core@1.0.0`. Its public profile and package protocols
> are versioned. Profile upgrades preserve project overlays. The release stays intentionally
> conservative for critical repositories. See [Maturity](docs/maturity.md) before using Köni on a
> critical repository.

## Why Köni?

Most agent harnesses begin with a prompt and hope the resulting sequence of actions stays coherent.
Köni begins with structure:

```text
goal → semantic graph → missing obligations → tickets → isolated work
                                                        ↓
                                      checks → review → squash integration
```

- **Graph-first planning** keeps dependencies, evidence, and ownership visible.
- **Project-owned behavior** lives beside the code in `.koni/`.
- **Pinned runs** do not change when future configuration is edited.
- **Isolated workers** use run- and ticket-specific branches and worktrees.
- **Receipts and gates** make completion an auditable state transition.
- **Provider-neutral execution** runs any Pi provider and model, per role.
- **One control center** covers planning, configuration, questions, agents, and recovery.

Köni keeps canonical project configuration under `.koni/`. It keeps authority and run state under
the repository Git common directory. It preserves the agent-tool resources already in your
repository, such as `.pi`, `.claude`, and `.codex`, rather than making any of them a second Koni
configuration authority.

The name comes from the Königsberg bridge problem. The useful abstraction is the topology (what
connects to what), not a prematurely chosen route through it. Read the
[philosophy](docs/philosophy.md) for the full model.

## Quick start

Install Core and the profile you want through the Pi package manager you already use:

```sh
pi install npm:@koni/core
pi install npm:@koni/coding-profile
cd /path/to/project
koni init
koni tui
# Or type /koni in an ordinary interactive Pi session.
```

The Coding profile is the default for bare `koni init`. To use the optional Research profile, also
install it with `pi install npm:@koni/research-profile` and explicitly run `koni init research`.
Global Koni packages are passive outside initialized repositories: they do not create a project,
run, authority, or provider request on install or load.

Koni uses that Pi installation's normal credentials, providers, models, settings, and interactive
resources. Loading the extension does not authenticate, start an authority, or change the Pi
session. Work starts only after an explicit Koni command.

Pi's managed npm closure supplies both the extension and its `.bin/koni` link. The launcher locates
your active Pi 0.80.10 package, verifies it, and propagates that exact peer bridge into authority
and attempt children.

Maintainers working from a source checkout use `./scripts/install-dev.sh`; end users should use the
Pi install commands above. The maintainer installer builds and registers the same three package
payloads with versioned, retained package roots and one locked Pi-settings update, so unrelated
resources and already-running authority bytes are never overwritten.

To update the one managed closure without interrupting work, quiesce each active project before the
package update, then start it with the new Core. Quiescing durably pauses runs and aborts contained
sessions. It never discards run state.

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

For a source-checkout installation, use the same stop, reload, start, and explicit-resume sequence.
Rerun `./scripts/install-dev.sh` in place of all three `pi update` commands. The source installer
atomically activates a new retained local bundle. Mixing the local-source and npm update paths would
create duplicate Koni origins, so Koni rejects it.

If `pi list` shows an older Koni source as well as the intended `npm:@koni/*` entries, remove the
exact older source before continuing. Use `pi remove <old-source>` for user scope, or
`pi remove <old-source> --local` for project scope. Koni fails closed on duplicate Core origins and
never chooses one by load order.

Core detects Pi's renamed command inventory without authenticating or starting Koni. It emits one
scope-correct removal warning and disables only Koni commands. It does not shut down Pi. Ordinary
chat and unrelated commands stay available until you remove one source and run `/reload`.

## Commands

Pi owns models and authentication. Koni does not implement a second credential store or login
command. Interactive and autonomous sessions use the credentials and provider setup that Pi already
owns. Koni stores only non-secret model and provider selections in a compiled run. It never imports,
exports, migrates, or rewrites your Pi authentication.

Because Pi owns the providers, Köni is provider-neutral by construction. Anthropic Claude, OpenAI
Codex, and every other provider Pi can reach are equally first-class, selectable per role, and
mixable inside one run. The run form and `koni run` offer exactly the models your Pi installation
can execute, and a profile default that your credentials cannot run is replaced by an authenticated
model with a visible notice instead of a hard failure. See
[Providers and models](docs/configuration.md#providers-and-models).

The shipping `koni` command exposes:

```sh
koni init [coding|research] [--profile-package PATH] [--root PATH]
koni update [--profile-package PATH] [--root PATH] [--preview SHA256 --apply]
koni conflicts [PATH] [--keep-project|--accept-upstream] [--root PATH]
koni start [--root PATH]
koni stop [--root PATH]
koni restart [--root PATH]
koni status [--root PATH] [--json]
koni config validate [--root PATH] [--json]
koni run --goal TEXT [--type <run-type>] [--target BRANCH] [--new-target [--from REF]]
koni resume --run RUN_ID [--root PATH]
koni tui [--root PATH]
```

`conflicts` shows the current and upstream documents before either version is selected.
`--new-target` branches a not-yet-existing `--target` from `--from`, which defaults to the current
branch.

## Initialize a project

Run bare `koni init` from anywhere inside an existing Git worktree:

```sh
cd my-project
koni init                    # Coding (default); or: koni init research
koni config validate
koni tui                     # opens only in this terminal
# Or type /koni inside Pi.
```

The selected verified package is materialized under `.koni`. A later `koni update` performs an
explicit three-way baseline and overlay upgrade. Existing project configuration and every unrelated
agent-tool resource — `.pi`, `.claude`, `.codex`, and anything else in the repository — stay
project-owned.

Inside Pi, `/koni init` opens guided Configure so you can choose and review initialization. It stays
at that approval boundary: it does not create a run, authority run state, or provider attempt.

Bare `koni` prints help. Koni never creates a terminal, tmux, or cmux pane on your behalf. The TUI
opens only in the terminal where you invoke `koni tui`.

In the control center, press `n` to describe a run, choose its run type, and review its effective
models, question policy, and parallelism. Planning pins the base commit and configuration. Work
begins only after explicit approval.

See [Getting started](docs/getting-started.md) for prerequisites and a first-run walkthrough.

## What gets installed

```text
my-project/
├── .koni/
│   ├── project.yaml            # run-type catalog
│   ├── run-types/              # complete selectable run behaviors
│   ├── profile.yaml            # semantic model entry point
│   ├── agents/                 # provider-neutral Koni agent resources
│   ├── resources/              # profile-selected skills and opt-in Pi bindings
│   └── .managed/               # baseline, overlay, migration, and upgrade provenance
└── .git/koni/                  # durable authority, run, ticket, receipt, and Git state
```

The installed `.koni/` tree is the project contract. The `koni` executable supplies the compiler,
runtime, TUI, schemas, bundled templates, migrations, and validation machinery. Initialized projects
do not depend on a Köni source checkout. Unrelated agent-tool and project resources — `.pi`,
`.claude`, `.codex`, and the rest of the repository — stay project-owned and untouched.

## Documentation

- [Getting started](docs/getting-started.md)
- [Philosophy](docs/philosophy.md)
- [Architecture](docs/architecture.md)
- [Configuration reference](docs/configuration.md)
- [Pi resources and community bindings](docs/pi-community-resource-bindings.md)
- [Control center and CLI](docs/control-center.md)
- [Runtime, state, and Git](docs/runtime-and-git.md)
- [Maturity](docs/maturity.md)

## Development

The shipping workspaces are TypeScript. They target Node `>=22.19`, Pi `0.80.10`, and the TypeBox
`1.1.38` that this Pi runtime supplies:

```sh
npm ci
npm run check
npm run build
```

`npm pack --workspace @koni/core`, plus the same command for the two profile workspaces, produces
the exact release artifacts.

## License

Köni is available under the [MIT License](LICENSE).
