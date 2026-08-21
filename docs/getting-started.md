# Getting started

This guide takes a repository from no Köni configuration to an approved, inspectable run.

The path is: install Core plus one profile, initialize inside an existing Git worktree, then
explicitly open `/koni` or `koni tui`. Bare `koni` prints help. The extension is inert until a Koni
command, and it leaves ordinary Pi chat usable even when duplicate Core origins disable Koni.

After initialization, a trusted Pi TUI shows Koni's read-only compact companion without starting the
authority. Use `/koni-run` for the complete guided New Run modal. Use `/koni-runs` for background
status and pending questions or plans. Use `/koni` for the full control center, or `koni tui` for
that same full surface in an explicitly chosen terminal.

## Prerequisites

- Node 22.19 or newer
- npm 11.13.0 for source and npm installs
- Git 2.x
- An ordinary working Pi 0.80.10 setup, with TypeBox 1.1.38, for agent-backed work
- macOS Seatbelt or Linux bubblewrap for contained command effects
- A terminal at least 82 columns wide for the interactive control center

Koni needs no separate credential setup. Authenticate ordinary Pi only when a chosen provider-backed
run requires it.

The v1 release qualification is deliberately narrower than the configurable product surface. Use
Node 22.19 or 24 on a trusted macOS repository and assign `openai-codex/gpt-5.6-luna` with medium
thinking and no fallback to every persona when you need to stay inside the qualified autonomous
boundary. Other Pi models remain selectable, but they are not covered by that release evidence.
Ubuntu participates in repository and containment gates; it is not a supported networked inference
target.

Treat autonomy as supervised execution between explicit operator boundaries. Start the run yourself,
review and approve its compiled plan, keep `/koni`, `koni tui`, or an explicit supervision driver
active, answer material questions, and inspect receipts and diffs before separately authorizing
promotion. Pause, stop, restart, and explicit resume preserve known durable state. If Koni reports
an unknown recovery condition, stop and reconcile it instead of editing authority state by hand.

Core stores authority state in the Git common directory, so it requires an existing Git worktree
even for profile installation. In a brand-new directory, run `git init` before
`koni init coding|research`. Initialization still creates no run and no commit.

## Install

```sh
pi install npm:@koni/core
pi install npm:@koni/coding-profile
pi install npm:@koni/research-profile   # optional research domain

# Expose the standalone command from that same Pi-managed package closure:
export PATH="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules/.bin:$PATH"
```

Koni never reads or copies Pi credentials, and it never rewrites unrelated settings or resources.
Installing through Pi does add Pi's own Koni package entries. The source installer transactionally
replaces only Koni-owned package entries. If activation fails, it rolls that change back together
with its launcher.

There is no second global Koni copy in the install flow. Pi's managed `.bin/koni` and `/koni` load
the same exact Core and profile bytes. Koni's launcher resolves and verifies your Pi 0.80.10
installation. No Koni closure may contain Pi or TypeBox below itself.

### From a source checkout

```sh
git clone https://github.com/maximus-powers/koni.git
cd koni
./scripts/install-dev.sh
export PATH="${KONI_INSTALL_PREFIX:-$HOME/.local}/bin:$PATH"
koni --version
```

The installer uses the ordinary Node and npm that Pi already requires. It checks, packs, and
installs the same three payloads beneath `${KONI_INSTALL_PREFIX:-$HOME/.local}`. It registers only
those three versioned local package sources in one locked Pi-settings update. It retains older bytes
for running authorities and preserves authentication plus every unrelated package and resource
setting.

Provider login and model discovery stay in Pi. Core installs no second credential store and no
second runtime host. Whichever providers you authenticated in Pi — Anthropic Claude, OpenAI Codex,
or any other — are the providers Köni can run, and each role picks from that same catalog.

### Upgrades

First run `koni stop --root /path/to/project`. Then update only the installed Koni sources:

```sh
pi update npm:@koni/coding-profile
pi update npm:@koni/research-profile   # only when installed
pi update npm:@koni/core
```

Do not use the broad `pi update --extensions`, which also replaces unrelated community packages.
Close and reopen Pi, or run `/reload` in every already-open Pi session, before
`koni start --root /path/to/project`. A stopped authority cannot unload old extension code that Pi
already holds in memory. Stop durably pauses runs and aborts contained sessions before the bytes
change. Start uses the new Core and leaves those runs paused for an explicit resume.

When Koni was installed with `./scripts/install-dev.sh`, keep the same stop, reload, start, and
explicit-resume sequence. Rerun `./scripts/install-dev.sh` instead of any `pi update npm:@koni/*`
command. That installer atomically switches the three registered local sources to one new retained
bundle. Do not mix the local and npm update paths, because duplicate Core origins fail closed.

If `pi list` reports a second Koni origin, remove the exact older source with `pi remove <source>`.
Use `pi remove <source> --local` when it is project-local. Failing closed is scoped to Koni. Pi
shows a non-mutating warning and keeps ordinary chat and unrelated commands available. It refuses
Koni commands until one current Core source remains and the operator reloads Pi.

## Initialize a project

Run `koni init coding` or `koni init research` inside an existing Git project. Then invoke `/koni`
from Pi, or `koni tui` in the terminal you chose. Koni does not open a terminal pane itself.

```sh
cd /path/to/project
git init                        # only for a brand-new directory
koni init coding --root .       # or: koni init research --root .
koni config validate --root .

# Then type /koni in an ordinary Pi session, or explicitly run:
koni tui --root .
```

Core accepts the explicit package profile (`coding` or `research`), `--profile-package` for a
reviewed package path, and `--root` for project discovery. Guided configuration and run control live
in the shared control center.

Interactive initialization asks which bundled project profile to install before it writes anything.
Choose Coding for evidence-guided vertical delivery of code changes, or Research for executable,
receipt-backed empirical work. Non-interactive callers must name the source explicitly. There is no
silent profile default. An unchanged existing installation retains its already-selected source
without prompting.

Before publishing any files, initialization stages a complete installation, validates all catalog
and profile references, and checks its owned-file manifest.

Initialization also merges the official Superpowers Pi package into the repository's ordinary
`.pi/settings.json` package list. It does not copy those skills into `.koni`, and it preserves all
other Pi settings. Pi resolves the package exactly as it does in any other repository. Koni agents
inherit that resolved environment by default; use `.koni/agents/<id>.yaml` only to narrow a specific
agent.

When Pi first resolves that Git package, it creates `.pi/git/.gitignore` to keep managed checkout
bytes out of the repository. Commit that guard together with `.pi/settings.json` and the initialized
`.koni` configuration. The package checkout remains ignored, while the target checkout stays clean
for Koni's fail-closed final promotion.

Repeated initialization is safe. Köni preserves unrelated agent-tool content such as `.claude` and
`.codex`, and refuses to overwrite an owned resource that changed after installation. Restore or
reconcile that resource first. Move durable local customization into a project-owned resource where
appropriate.

If init reports an unmanaged `.koni` or ambiguous profile state, do not copy files manually. Resolve
the ambiguity by hand (move or remove the conflicting directory) before initializing.

After a later `koni update`, use `koni conflicts` to compare the project and upstream documents. The
Configure view offers the same comparison under **Upstream changes**. Then choose **Keep project**
or **Use update**.

The bundled profiles are foundations, not universal descriptions of every project. After
initialization, use the installed `configure-koni` skill when the graph should encode
repository-specific domains, interfaces, metrics, ablations, gates, commands, or publication rules.
It inspects the repository and asks only for material missing decisions. It then presents the
proposed ontology, compiler rules, ticket and proof model, and file plan for explicit approval. It
edits the installed profile only after that approval. The skill uses `.koni/project.yaml`, resolved
`.koni` profile sources, and provider-neutral `.koni/agents`.

Inspect the exact Pi-native environment for an agent with:

```sh
koni config resolve-agent run-planner --root .
koni config resolve-agent reviewer --run-type medium --root . --json
```

## Open the control center

```sh
cd ~/src/my-project
koni tui --root .
# Or type /koni in Pi.
```

The same controller, panels, questions, plan review, configuration editor, and authority state are
used in both places.

The default Operate view shows all runs, the selected ticket board, planning and stage details,
active agents, and the semantic graph. Press `c` for the Configure view.

In a non-interactive terminal, Köni prints a plain snapshot instead of entering the alternate
screen. Automation can request JSON:

```sh
koni status --root . --json
```

## Create the first run

1. Press `n`.
2. Describe the Objective and choose a run type.
3. Review the effective stages, question behavior, parallel-agent limit, model, and reasoning
   settings.
4. Activate **Start Planning**, or **Start Work** for a no-planning run.
5. Answer any decision-bearing questions.
6. Review the durable planning output.
7. Focus **Approve run** and press Enter.

If the plan needs a change, enter steering instead of approving. New runs continue the same planner
attempt and authenticated Pi session, create **Revision N**, and reset only that revision's token
allowance. The revised submission patches the latest validated plan; the prior checkpoint, session
history, provider usage, cost, repository discovery, questions, and evidence remain cumulative.
Compiler feedback is corrected within the same revision. Approval always binds the exact latest
validated checkpoint.

Runs created by an older Koni version may have no continuous-planning marker. They keep their
historical multi-attempt revise and approval behavior; Koni does not rewrite or merge those
sessions.

Planning resolves the selected target branch and its observed base commit, then pins the complete
effective configuration. Runs name the destination branch as well as its observed commit, because
later target synchronization and explicit promotion must retain that operator intent. Approval is
the first point at which Köni creates a permanent isolated run branch and worktree. Later edits in
Configure affect future runs only.

Run creation does not refuse a target branch whose checkout has uncommitted changes. The run always
starts from the branch's last commit, so in-progress local edits are excluded. They are never
captured and never touched. Koni says so up front: the start response carries a warning naming the
uncommitted paths, and the run's activity log records it. Final promotion still refuses to overwrite
a dirty target checkout, so nothing is deferred to a merge-time surprise and no local work is ever
discarded.

The bundled run types are complete peers:

| Run type | Best for                        | Planning                                 | Questions        | Parallel agents |
| -------- | ------------------------------- | ---------------------------------------- | ---------------- | --------------: |
| Small    | Narrow, low-risk work           | Coding: one focused pass. Research: none | High-impact only |               1 |
| Medium   | Normal feature or refactor work | One combined pass                        | High-impact only |               3 |
| Large    | Cross-cutting or risky work     | Architecture, risk, verification         | Interactive      |               5 |

Research keeps the bounded no-planning option for Small. The Coding default performs one focused
pass, so even narrow coding work receives a reviewed objective and proof boundary. Coding Small uses
`high_impact_only` and may ask at most one acceptance-blocking question. It does not promise silence
when a material ambiguity would make autonomous work unsafe.

Coding adds `new-feature` and `bug-fix` beside the three complexity envelopes. Both resolve from
Medium into complete selectable run types. New Feature emphasizes observable acceptance, the
existing user journey, and the thinnest end-to-end slice. Bug Fix requires expected and observed
behavior. It accepts an exact reproduction or observation signal, or an honest explanation that none
is available. It seeds one focused defect-only diagnostic proof, and source-only preparation and
reviewed diagnosis precede change planning. Bug Fix never seeds an authored localization status or a
guessed repair.

Both presets retain Medium's target-sync, composed-verification, reporting, and explicit-promotion
boundaries. Only Bug Fix intentionally serializes implementation work to one worker at a time.

A project may define any additional peers, such as `UI Feature` or `Infrastructure Change`. Run
types are selected, not layered.

## Inspect and control a run

The TUI supervises automatic stages in short restart-safe ticks. Common CLI equivalents are:

```sh
koni status --root . --json
koni run --goal "Introduce a durable cache boundary" --root .
koni resume --run <run-id> --root .
koni stop --root .
koni start --root .
```

Approval may trigger the first supervision tick automatically. A blocked or failed stage stays
visible and requires an explicit retry. Köni never hides the failure by skipping the stage.

## Next steps

- Learn the [graph-first philosophy](philosophy.md).
- Understand the [configuration layers](configuration.md).
- Use the complete [TUI and CLI guide](control-center.md).
- Review the [Git and recovery model](runtime-and-git.md).
