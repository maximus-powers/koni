# Getting started

This guide takes a repository from no Köni configuration to an approved,
inspectable run.

> **Current Pi-native guide — 2026-07-16 (`pi-native-port`):** Historical Cargo, bundled-host,
> Koni-owned-auth, `.codex/koni`, and Homebrew passages below are retained to explain earlier
> migrations. A new installation uses the three Pi/npm packages and ordinary Pi authentication.
> Koni never copies credentials or edits the user's Pi settings/resources. Projects use `.koni`,
> and `koni init coding|research` materializes a verified package baseline plus project overlay.

> **Pi-package registration correction — 2026-07-16:** “Never edits” above is too broad for an
> installation guide. Koni never reads or copies Pi credentials and never rewrites unrelated
> settings or resources. Installing through Pi necessarily adds Pi's own Koni package entries;
> the source installer transactionally replaces only Koni-owned package entries and rolls that
> change back together with its launcher if activation fails.

## Prerequisites

Current prerequisites are Node 22.19+, npm 11.13.0 for source/npm installs, Git 2.x, and an
ordinary working Pi 0.80.10 setup for agent-backed work. macOS Seatbelt or Linux bubblewrap is
required for contained command effects. Rust is needed only to recapture the frozen oracle, never
to install or run Koni.

- Git 2.x
- Codex installed and authenticated for agent-backed stages
- A terminal at least 82 columns wide for the interactive control center
- Rust 1.96 or newer only when building Köni from source. Development through
  rustup uses the newer toolchain pinned by this repository.

> **Current prerequisite correction — 2026-07-16:** The Codex and Rust bullets immediately above
> belong to the retained Rust-oracle workflow. Shipping Pi-native Koni needs neither Codex nor a
> Rust toolchain. Authenticate ordinary Pi only when a chosen provider-backed run requires it;
> Rust 1.96 is required solely for intentionally rebuilding or recapturing the frozen oracle.

> **Pi/schema 2 transition in progress — 2026-07-14 (`pi_product_docs_transition`):** Codex
> authentication remains the executable prerequisite for the schema-1 product described by this
> guide and for its pinned historical runs. The unreleased schema-2 target uses a Köni-owned host
> built directly on Pi and subscription OAuth, with no Codex or API-key fallback after migration.
> Do not treat that target as installed until the credential-TCB choice (Rust-owned allowlisted
> auth proxy versus signed/pinned host dependency closure), containment, artifact, protocol/token,
> migration, historical-reader, and frozen-matrix gates pass in
> [Direct Pi runtime](pi-runtime.md).

> **Release-candidate supersession — 2026-07-14 (`pi_product_docs_transition`):** The preceding
> unreleased/undecided status is historical. Current source is the schema-2/direct-Pi release
> candidate for macOS and uses ChatGPT subscription OAuth with no production Codex or API-key
> fallback. Its exact first-cut credential TCB is the Köni Rust binary, bundled Pi host, pinned Pi
> SDK 0.80.7 dependency closure, and official pinned Node 22.19.0 runtime; Node has no compiler-
> tool, graph, Git, receipt, or project-file authority. Linux login/inference fail closed pending a
> destination-allowlisted egress broker. Installation and migration remain separate guarded
> operator actions; protected forensic Updog state is not authorization for either.

Köni can configure a directory that is not yet a Git repository. It does not
initialize Git during `koni init`; Git initialization and the baseline commit
happen at the first run boundary that requires them.

> **Pi-native Git-root correction — 2026-07-16:** The paragraph above records the frozen Rust
> initializer. Current Core stores authority state in the Git common directory and therefore
> requires an existing Git worktree even for profile installation. In a brand-new directory, run
> `git init` before `koni init coding|research`; initialization still creates no run or commit.

## Install

Current package installation:

```sh
pi install npm:@koni/core
pi install npm:@koni/coding-profile
pi install npm:@koni/research-profile   # optional research domain

# Expose the standalone command from that same Pi-managed package closure:
export PATH="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules/.bin:$PATH"
```

From a source checkout, `./scripts/install-dev.sh` checks, packs, and installs these same three
payloads beneath `${KONI_INSTALL_PREFIX:-$HOME/.local}`. It registers only those three versioned
local package sources in one locked Pi-settings update, retains older bytes for running
authorities, and preserves authentication plus every unrelated package/resource setting.

> **Single-runtime packaging correction — 2026-07-16:** The former global command without
> `--legacy-peer-deps` is unsafe because ordinary npm may install its own Pi SDK and a TypeBox
> version different from the active Pi runtime. A second global Koni copy is no longer part of the
> install flow: Pi's managed `.bin/koni` and `/koni` load the same exact Core/profile bytes. Koni's
> launcher resolves and verifies the user's Pi 0.80.10 installation; no Koni closure may contain Pi
> or TypeBox below itself.

For upgrades, first run `koni stop --root /path/to/project`, then update only the installed Koni
sources: `pi update npm:@koni/coding-profile`, optional
`pi update npm:@koni/research-profile`, and finally `pi update npm:@koni/core`. Do not use the broad
`pi update --extensions`, which also replaces unrelated community packages. Close/reopen Pi or run
`/reload` in every already-open Pi session before `koni start --root /path/to/project`; a stopped
authority cannot unload old extension code already in Pi memory. Stop durably pauses runs and
aborts contained sessions before the bytes change; start uses the new Core and leaves those runs
paused for an explicit resume. If `pi list` reports a second Koni origin, remove the exact older
source with `pi remove <source>` (or `pi remove <source> --local` when it is project-local) before
opening Koni again.

> **Source-checkout upgrade path — 2026-07-16:** When Koni was installed with
> `./scripts/install-dev.sh`, keep the same stop → reload → start → explicit-resume sequence, but
> rerun `./scripts/install-dev.sh` instead of any `pi update npm:@koni/*` command. That installer
> atomically switches the three registered local sources to one new retained bundle. Do not mix
> local and npm update paths; duplicate Core origins fail closed.

Until the Homebrew formula is published, install from a source checkout:

```sh
git clone https://github.com/maximus-powers/koni.git
cd koni
cargo install --path crates/koni-cli
koni --version
```

> **Current source-install command — 2026-07-16:** The Cargo block immediately above is retained
> only as Rust-era history and is not a complete Pi-native installation. From the current source
> checkout run `./scripts/install-dev.sh`, prepend the printed
> `${KONI_INSTALL_PREFIX:-$HOME/.local}/bin` path when instructed, then verify `koni --version`.
> The installer registers the same three coarse packages without shipping the frozen Rust oracle.

The eventual Homebrew interface is `brew install koni`. No tap or core formula
is published yet.

> **Source-install cutover hold — 2026-07-14 (`pi_product_docs_transition`):** The commands above
> build the current shared checkout; they are not authorization to refresh an installed project
> onto the in-progress Pi/schema-2 cutover. Keep existing schema-1 projects and historical runs on
> their executable/readable contract until one immutable host/Rust/CLI/TUI/profile matrix is green
> and the security/migration review is signed. Schema-2 activation then occurs through its explicit
> migration transaction, not an ordinary guarded binary refresh.

> **Source-install supersession — 2026-07-14 (`pi_product_docs_transition`):** The immutable
> matrix and security/migration review named above are now green for current release-candidate
> source. The binary-only Cargo command remains historical because it omits the pinned runtime
> closure; use the verified installer contract below when an operator explicitly chooses to install
> the candidate. Installing it still does not migrate any existing project or authorize a live run.

> **Implemented Pi source-install contract — 2026-07-14:** For the schema-2 candidate, install the
> complete verified runtime instead of the binary-only historical command:
>
> ```sh
> git clone https://github.com/maximus-powers/koni.git
> cd koni
> ./scripts/install-dev.sh
> export PATH="${KONI_INSTALL_PREFIX:-$HOME/.local}/bin:$PATH"
> koni models --json
> koni auth status
> ```
>
> The installer requires Node 22.19 or newer and, on Linux, bubblewrap; it copies the exact bytes
> hashed into the Rust build beside `koni` and smoke-tests the contained Pi model registry. Use
> `koni auth login` for device-code ChatGPT-subscription sign-in. The current Linux containment
> deliberately refuses network-enabled Pi hosts until an outbound-only egress broker exists, so
> Linux packages support local metadata/model/status probes but not login or inference yet. macOS
> uses Seatbelt for the network-enabled subscription path.

> **Authentication UX transition — 2026-07-14:** Keep the device-code wording above as the earlier
> installer checkpoint. On macOS, `koni auth login` now uses Pi's standard browser login: Koni opens
> the OpenAI authorization page and the browser returns to Pi's scoped localhost callback. No
> ChatGPT Security setting or device-code enablement is required for the normal local flow. The
> Linux network limitation stated above is unchanged.

> **Authentication persistence transition — 2026-07-14:** The browser login is stored for future
> Koni upgrades in the operating-system account's `~/.koni/auth.json`, not in a project and not in
> Pi's or Codex's own auth file. Koni creates `~/.koni` as `0700` and the credential file as `0600`,
> validates ownership and file type without following symlinks, and updates it atomically. The
> credential is plaintext to the owning OS account, matching Pi's practical local-file model; other
> users receive no filesystem permission. `koni auth logout` removes only Koni's copy.

> **Authentication-path correction — 2026-07-14:** Preserve `~/.koni/auth.json` above as the
> initial file-backed checkpoint. Current source keeps account auth outside the project `.koni/`
> namespace: `~/Library/Application Support/Koni/auth.json` on macOS and
> `~/.local/state/koni/auth.json` on Linux. This means even a Koni project rooted at the user's home
> cannot collide with login state. Koni also removes only exact, owner-only stale temporary auth
> files left by an interrupted atomic write.

> **Pi-canonical authentication target — 2026-07-16:** The Koni-owned paths above remain accurate
> for the current raw-host compatibility runtime. The accepted next runtime uses Pi `AuthStorage`
> as the provider credential source wherever supported (normally Pi's configured agent directory,
> defaulting to `~/.pi/agent/auth.json`) and does not create a second Koni-owned credential copy.
> Rust retains only a nonsecret opaque provider/account/auth-generation binding and migration
> status. Koni will not mount the complete Pi agent directory into autonomous sandboxes; a
> supervised Pi-owned backend/service provides the exact launch-bound auth capability. Existing
> Koni credentials are kept until an explicit single-writer import, fresh-process verification,
> and deletion gate succeed. Do not manually move or delete either file. This is a target
> transition, not a claim that current `koni auth` commands have already changed. See
> [Pi-native session, resource, and authentication migration](pi-native-migration.md).

> **Pinned installer clarification — 2026-07-14:** The installer no longer copies an ambient Node
> executable. It requires `curl`, `tar`, and a SHA-256 utility, downloads the official standalone
> Node 22.19.0 and npm 11.13.0 archives for the current supported OS/architecture, verifies their
> pinned hashes, and builds and installs those exact runtime bytes. Linux additionally requires a
> build-pinned `bubblewrap`. Binary-only `cargo install` remains historical because it cannot
> install this verified runtime closure.

> **Pure Pi-package source install — 2026-07-16:** The bundled Node/host and Koni-owned auth/model
> commands above are now historical. Current source uses the ordinary Node/npm already required by
> Pi: run `./scripts/install-dev.sh`, then `koni --version`. Provider login and model discovery stay
> in Pi; current Core exposes `init`, `update`, `start`, `status`, `config validate`, `run`, and
> `tui`, and installs no second credential store or runtime host.

## Initialize a project

The current explicit commands are `koni init coding` and `koni init research`. Run one inside an
existing Git project, then invoke `/koni` from Pi or `koni tui` in the terminal you chose. Koni does
not open a terminal pane itself.

```sh
cd /path/to/project
git init                        # only for a brand-new directory
koni init coding --root .       # or: koni init research --root .
koni config validate --root .

# Then type /koni in an ordinary Pi session, or explicitly run:
koni tui --root .
```

> **Historical initializer interface:** The unannotated `koni init`, `--target`, `--profile`,
> `--from`, `--replace`, `--dry-run`, and `--open` examples retained below describe the frozen Rust
> initializer. They are preserved as migration history, not aliases in the Pi-native CLI. Current
> Core accepts the explicit package profile (`coding` or `research`), `--profile-package` for a
> reviewed package path, and `--root` for project discovery; guided configuration and run control
> live in the shared control center.

From the project or any directory beneath it:

```sh
koni init
```

Köni uses the enclosing Git worktree as the project root. Outside Git it uses
the current directory. Use `--target` when you want an exact destination:

```sh
koni init --target ~/src/my-project
```

On an interactive terminal, fresh initialization asks which bundled project
profile to install before it writes anything. Choose **Software** for
architecture-grounded code changes or **Research** for executable,
receipt-backed empirical work. Automation and other non-interactive callers
must make the source explicit:

> **Software-description evolution — 2026-07-14.** “Architecture-grounded code changes” above
> describes the original Software baseline. Software `0.4.0` changes that default to
> **Evidence-Guided Vertical Delivery**: one cohesive vertical claim, conditional architecture and
> contract work only when a material boundary requires it, adaptive proof, independent semantic
> review, and risk-proportional assurance. The historical phrase remains here so the initialization
> contract's evolution is visible; Research is unchanged.

```sh
koni init --profile software
koni init --profile research
koni init --from ~/profiles/my-team
```

There is no silent profile default. An unchanged existing installation and a
legacy migration retain their already-selected source without prompting;
`--replace` is a new source selection and therefore prompts unless its source
is explicit. `--dry-run` follows the same selection rule and reports the
selected source without writing. It is an orientation preview, not the full
staged source/profile validation; the real installation transaction performs
that complete validation before publishing files.

> **Profile-selection history — superseded 2026-07-14.** The original contract said, “The
> default bundled profile is `software`. Other sources are explicit.” Fresh initialization now
> makes the project domain an explicit operator choice, and non-interactive use must name its
> source. Existing installations retain their already-selected profile.

> **Profile-selection verification — 2026-07-14.** The current initializer has exact passing
> coverage for CLI controls, non-interactive refusal before any write, interactive reprompt plus
> name/number selection, fresh versus replacement selection, existing/legacy preservation, and
> packaging all five Software run types. These scoped tests held the initializer/template source
> fingerprint unchanged; they do not release the separately moving compiler/Pi integration.

Before publishing any files, initialization stages a complete installation,
validates all catalog and profile references, and checks its owned-file
manifest. Useful controls are:

| Option | Purpose |
| --- | --- |
| `--dry-run` | Show the resolved root, selected source, and installation/migration state without changing files |
| `--replace` | Replace only Köni-owned configuration after validation |
| `--open` | Open the control center after a successful initialization |
| `--target PATH` | Initialize an exact directory |

Repeated initialization is safe. Köni preserves unrelated `.codex` content
and refuses to overwrite an owned native resource that was changed after
installation. Restore or reconcile that resource first, moving durable local
customization into a project-owned resource where appropriate. `--replace`
replaces the profile intentionally, but it does not override this protection.

> **Initialization transition in progress — 2026-07-14 (`pi_product_docs_transition`):** The
> initialization behavior above remains schema 1. The schema-2 migrator stages one `.koni` tree,
> preserves unrelated `.codex` files and historical readers, archives active Codex-backed runs
> through compiler-issued evidence, and retires only manifest-proven owned resources. A migrated
> project then executes Pi only. Ancestor-symlink refusal, schema-field-only conversion,
> validation/publication race closure, durable crash recovery, and rollback fixtures remain
> required before that path is available; see [Direct Pi runtime](pi-runtime.md).

> **Initialization supersession — 2026-07-14 (`pi_product_docs_transition`):** Fresh current
> initialization now publishes schema 2 directly, and the explicit in-place migration path closes
> the conversion, no-follow publication, archival, recovery, and rollback requirements above.
> Neither path falls back to Codex. Applying migration to an existing project remains a distinct
> guarded operator action rather than an effect of source availability.

> **Replacement safety evolution — 2026-07-14.** Earlier guidance said to use `--replace` when
> replacement was intentional. The current rule keeps that intent but makes ownership protection
> explicit: replacement selects a profile baseline; it never silently destroys a locally modified
> owned Codex resource.

If the project has a legacy installation, read [Migration](migration.md) before
continuing.

The bundled profiles are foundations, not universal descriptions of every
project. After initialization, use the installed `configure-koni` skill when
the graph should encode repository-specific domains, interfaces, metrics,
ablations, gates, commands, or publication rules. It inspects the repository,
asks only for material missing decisions, and presents the proposed ontology,
compiler rules, ticket/proof model, and file plan for explicit approval before
editing the installed profile.

> **Installed-skill path transition — 2026-07-14:** Current schema-2 skills use
> `.koni/project.yaml`, resolved `.koni` profile sources, and provider-neutral `.koni/agents`.
> `.codex/koni` and Codex-native agent fields are recognized only for a detected schema-1 project;
> the skills do not create a dual runtime. The bundled operator skill uses the same detection rule.

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
2. Describe the Objective and choose a run type.
3. Review the effective stages, question behavior, parallel-agent limit, model,
   and reasoning settings.
4. Activate **Start Planning** (or **Start Work** for a no-planning run).
5. Answer any decision-bearing questions.
6. Review the durable planning output.
7. Focus **Approve run** and press Enter.

> **Terminology history — transitioned 2026-07-14.** The earlier instruction said “Describe the
> goal.” The operator-facing field is now consistently **Objective**; the underlying durable goal
> value remains a compatibility/storage detail rather than a second concept in the UI.

Planning resolves the selected target branch and its observed base commit, then
pins the complete effective configuration. Approval is the first point at which
Köni creates a permanent isolated run branch and worktree. Later edits in
Configure affect future runs only.

> **First-run runtime transition in progress — 2026-07-14 (`pi_product_docs_transition`):** This
> run lifecycle remains unchanged by the intended transport replacement. Before cutover, the
> pinned configuration includes schema-1 Codex resources; after a successful migration it includes
> schema-2 `.koni` resources and Pi events, with no Codex fallback. Existing Codex-backed runs are
> archived rather than resumed under Pi, and both snapshot families must remain inspectable.

> **First-run supersession — 2026-07-14 (`pi_product_docs_transition`):** That post-migration
> behavior is now the current schema-2 release-candidate path: planning, review, workers, and Lead
> use Pi only, while historical schema-1 runs remain inspectable and permanently non-resumable.
> Networked runs are supported on macOS; Linux model work fails closed pending allowlisted egress.

> **Git-intake history — superseded 2026-07-14.** The prior contract said only, “Planning
> resolves the base commit.” Runs now name the destination branch as well as its observed commit,
> because later target synchronization and explicit promotion must retain that operator intent.

The bundled run types are complete peers:

| Run type | Best for | Planning | Questions | Parallel agents |
| --- | --- | --- | --- | ---: |
| Small | Narrow, low-risk work | Software: one focused pass; Research: none | No questions | 1 |
| Medium | Normal feature or refactor work | One combined pass | High-impact only | 3 |
| Large | Cross-cutting or risky work | Architecture, risk, verification | Interactive | 5 |

> **Small-run evolution — 2026-07-14.** The original cross-profile table described Small as
> having no planning pass. Research retains that bounded option; the Software default now performs
> one focused pass so even narrow coding work receives a reviewed objective and proof boundary.

> **Software intent presets — 2026-07-14.** Software 0.4 retains the three complexity envelopes
> above and adds `new-feature` and `bug-fix`. Both resolve from Medium into complete selectable run
> types. New Feature emphasizes observable acceptance, the existing user journey, and the thinnest
> end-to-end slice. Bug Fix requires expected and observed behavior, accepts an optional
> reproduction signal, seeds a causal defect, and runs one implementation worker at a time.
> Software Small now uses `high_impact_only` and may ask at most one acceptance-blocking question;
> it no longer promises silence when a material ambiguity would make autonomous work unsafe.

> **Software 0.4 transition status — 2026-07-14.** The paragraph above documents the accepted
> selectable catalog and currently staged templates. It is not yet a release-completion claim:
> isolated catalog/profile compilation is green, while the final focused Software behavior and
> generic graph-set authority reviews remain active. Existing installed or pinned profiles keep
> their resolved three- or five-type snapshot until explicitly reconfigured.

> **Current integration-status transition — 2026-07-14.** The sentence above remains the staged
> pre-review checkpoint. Scoped graph-TDD is now independently released at generic 6/6; whole-
> project release still waits for the remaining review-effect, proof-preparation/path/selector/
> checkout authority gates, the expanded Software and Pi/schema-2 matrices, and one immutable
> fingerprint. Fresh or pinned projects must not infer that source completion authorizes an
> installed-profile replacement or migration.

> **Gate narrowing — 2026-07-14 (`pi_product_docs_transition`):** That broad list remains the
> integration snapshot that opened the work. Review-effect P1s, exact pinned-member selection,
> canonical ticket-worktree/root evaluation, and same-ticket proof-source/write separation are now
> closed in current source. Cross-ticket preparation provenance and emission/lease admission, the
> complete Software and Pi/schema-2 matrices, and one final immutable fingerprint remain active.
> The current source is therefore still not an installed-profile or guarded-refresh candidate.

> **Final-gate supersession — 2026-07-14 (`pi_product_docs_transition`):** The later compiler,
> Software, Pi/schema-2, and locked whole-workspace endpoint closes those remaining source gates;
> current source is now the release candidate. “Installed-profile” remains intentionally separate:
> no existing project changes until an operator performs the verified install and, where needed,
> the explicit guarded migration. The protected forensic Updog projects/runs grant no such action.

> **Compiler preparation-lineage source transition — 2026-07-14 (`compiler-graph-tdd`):** The
> cross-ticket item above is now wired in current source: graph-selected repository-relative proof
> paths establish a reviewed source-only preparation; one shared newest-attempt decision drives
> both rule truth and later write admission; and exact authenticated review effects may advance the
> prepared projection without authorizing manual drift or archived ticket cycles. The complete Bug
> Fix path reaches green promotion without reopening preparation and retains the source lock. This
> is not an installed-profile replacement or migration authorization; final publication still
> waits for the compile-epoch count regression, frozen compiler fingerprint, and the independent
> whole-project release gates recorded in the collaboration ledger.

> **Compiler preparation-cost transition — 2026-07-14 (`compiler-graph-tdd`):** The compile-epoch
> regression named above is now structural: a fresh Software compile performs three exact-graph
> binding scans over two ticket/receipt source indexes, and reviewed receipts are parsed once per
> source epoch rather than once per rule or successor. Exact graph identity—not semantic-exclusion
> metadata—controls result reuse. This closes the compiler-local repeated-I/O gate in source and
> focused tests; the unchanged whole-project, Pi, installation, and immutable-fingerprint gates
> still prevent treating the staged profile as a published upgrade.

> **Intent preset causal refinement — 2026-07-14:** Bug Fix no longer seeds an authored
> localization status or a guessed repair. An unresolved run begins with expected behavior,
> observed behavior, an exact reproduction/observation signal or honest unavailable explanation,
> and one focused defect-only diagnostic proof. Source-only preparation and reviewed diagnosis
> precede change planning. New Feature remains outcome/acceptance led. Both retain Medium's
> target-sync, composed-verification, reporting, and explicit-promotion boundaries; only Bug Fix
> intentionally serializes implementation work.

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
