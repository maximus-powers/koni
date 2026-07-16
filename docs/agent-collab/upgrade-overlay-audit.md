# Upgrade-safe baseline and project-overlay architecture audit

Owner: `upgrade-overlay-audit/root`

Status: `complete` — read-only source/design audit released to `primary-integrator/root`

Last checked: 2026-07-16 MST

## Mission and safety boundary

Design an upgrade contract in which bundled Koni defaults can evolve without overwriting a
project's configuration. The design must preserve active-run snapshots, keep the Codex-native
resource layout, distinguish generic Software defaults from Updog-specific decisions, provide
semantic conflict handling, and define migration, tests, and an incremental rollout.

This lane changed only this append-only mailbox. It did not edit Rust, tests, profiles, templates,
product documentation, live project state, installed binaries, processes, worktrees, branches,
refs, or cmux surfaces. The shared tree was already heavily dirty and was preserved without reset,
formatting, or broad mechanical changes. Coordination mailboxes and the relevant product/source
documents were reviewed; no active lane claimed the CLI/configuration publication seams described
below.

## Executive verdict

Koni already has the most important runtime invariant: a run captures and hashes a resolved
configuration snapshot before registration, and subsequent execution reopens that pinned snapshot.
Therefore a default-profile upgrade should change only future runs. Existing planned, approved,
paused, and active runs do not need to be stopped or rewritten.

The missing piece is project installation state. Schema-2 `--replace` currently stages a complete
new `.koni` directory and swaps it over the project's complete live `.koni` tree. Ownership hashes
protect separately published external resources, but there is no old-default / project / new-default
merge for editable profile configuration. A configured repository can therefore either stay on old
defaults or lose its local choices during replacement.

The lowest-risk correction is a **materialized working tree with immutable baseline provenance**:

1. keep the normal resolved configuration at `.koni/**` and Codex-native resources at their normal
   `.agents/**` paths;
2. persist the exact prior baseline bytes and identity in a hidden, Koni-owned store;
3. treat the difference between that baseline and the current live tree as the durable logical
   project overlay;
4. upgrade with a semantic three-way merge of old baseline, current project tree, and new baseline;
5. validate and publish the complete merged candidate with a shared crash-consistent transaction.

This provides a real project overlay without forcing the compiler, Pi/Codex agents, or operators to
read a virtual union filesystem. It also means the current live files remain the editable source of
truth: an edit made by hand or through Configure cannot silently fall outside the overlay merely
because an auxiliary patch document was stale.

Generic changes requested for every coding project belong in the versioned **Software baseline**.
Only repository-specific choices belong in the project overlay. Updog is an instance of Software,
not a separately mutated copy of the shipped default. The upgrade preview should consequently call
an incoming generic change a “new default” and an Updog-only decision a “project change.”

## Current source contract

### Installation and replacement

- `crates/koni-cli/src/main.rs:44` defines `init` / `install` and the current `--replace` authority.
- `initialize_project_with_profile_selector` at `main.rs:1245` verifies an existing install unless
  replacement is explicitly requested.
- `verify_existing_schema2_installation` at `main.rs:1437` checks the resource manifest, external
  ownership, the project catalog, and all run types.
- `install_schema2_profile` at `main.rs:1652` stages a complete profile, converts bundled schema-1
  material to schema 2 when necessary, stages shared skills, validates the complete candidate, and
  calls publication.
- `Schema2ResourceManifest` at `main.rs:1641` records only its schema/owner and hashes of externally
  published resources. It does not identify a bundled baseline or the project delta from it.
- `publish_staged_install` at `main.rs:2548` moves the complete existing `.koni` destination into a
  temporary backup and renames the complete staged profile into place. Successful cleanup removes
  the temporary backup. This is a replacement transaction, not an upgrade merge.
- `crates/koni-cli/src/templates.rs:6` represents embedded content as unversioned `EmbeddedFile`
  arrays (`SOFTWARE` begins at line 20). The profile YAML has a version, but there is no content
  identity for the final converted schema-2 bundle.

Current tests protect idempotent initialization, clean schema-2 installation, schema conversion,
and independently owned external files. They do not edit a project run type, agent, workflow,
graph rule, or prompt and prove that edit survives a newer bundled Software baseline.

### Runtime pinning is already correct

- `ConfigSnapshot` at `crates/koni-core/src/state.rs:140` is the immutable run-facing configuration
  projection.
- `ConfigSnapshot::capture_project_configuration` at `state.rs:227` copies the live `.koni` tree and
  repository skills into `run_root/config-snapshot`, hashes every captured file, and writes the
  snapshot manifest.
- Run registration pins the profile id/version/hash, run-type id/title/hash, base commit, snapshot
  path, and snapshot hash.
- `Engine::plan_run_with_binding` at `crates/koni-core/src/engine.rs:7790` compiles the live catalog,
  captures the configuration, finalizes one-run overrides inside that snapshot, and registers the
  pinned run.
- Opening, approving, and executing a run recompiles from the verified pinned snapshot and rejects
  changed, added, removed, or symlink-substituted snapshot files.

An upgrade must not rewrite a run snapshot or reinterpret a run against the new live baseline. The
only missing concurrency invariant is a project-configuration publication lock: planning must not
capture half of the old generation and half of the new generation while an upgrade is publishing.

### Configuration publication is duplicated

- `crates/koni-tui/src/model.rs:4203` stages a Configure candidate and validates it.
- `ConfigureModel::publish_config` at `model.rs:4251` publishes multiple live files with its own
  backup/rollback routine.
- CLI install/replacement uses the independent `publish_staged_install` implementation.
- `crates/koni-core/src/schema2_migration.rs` already contains a stronger transaction pattern:
  compiler-issued archival proof, no-follow path handling, a fsynced publication journal, and
  deterministic recovery.

Overlay correctness cannot be guaranteed if CLI upgrade and TUI Configure keep independent
publication and locking rules. The hardened migration primitives should be generalized instead of
adding a third publisher.

### Compiler layering is useful but is not a profile overlay

`RunTypeDocument` (`crates/koni-core/src/catalog.rs:52`) supports `extends` plus JSON-Pointer
overrides between run types. `ProjectCatalogCompiler` (`catalog.rs:625`) resolves that source-level
inheritance. Profile imports append typed arrays and then enforce unique identifiers. These are
authoring facilities inside one already selected profile; they do not provide an old-vs-new bundled
baseline or a durable repository overlay.

Phase one should not teach the runtime compiler a second virtual overlay model. Materialize and
validate the merged tree first, then let the existing compiler consume it normally.

## Proposed on-disk contract

Keep the user/agent-facing projection unchanged:

```text
.koni/
  project.yaml
  profile.yaml
  run-types/**
  agents/**
  graph/**
  operations/**
  workflows/**
  checks/**
  resources/**
  resource-manifest.json
  .managed/
    install.yaml
    overlay.yaml
    baselines/
      <baseline-digest>/
        manifest.yaml
        objects/<sha256>

.agents/
  skills/**
```

The exact set of ordinary profile directories remains profile-defined; the example is illustrative.
The key boundary is that `.koni/.managed/**` is Koni-owned provenance, while the rest of `.koni/**`
is the materialized, editable project configuration.

### `.koni/.managed/install.yaml`

This small, committed record should contain:

- management schema version;
- source kind (`bundled` or `custom`) and profile id;
- source profile version for display only;
- exact bundle/content digest;
- Koni build identity that produced the normalized schema-2 baseline;
- current baseline generation and baseline-manifest digest;
- last published composed-tree digest and overlay digest;
- publication/adoption timestamps and prior generation for recovery/audit.

Profile version alone is not an identity. Development builds can contain different bytes under the
same human version. The authoritative identity is a deterministic digest of the **final normalized
schema-2 baseline plus Koni-owned external resources**, not merely the schema-1 template arrays.

### Baseline manifest and objects

The manifest should namespace every Koni-owned path so `.koni` and native resources cannot collide:

```text
config/project.yaml
config/profile.yaml
config/run-types/small.yaml
resources/.agents/skills/configure-koni/SKILL.md
```

Each entry records path, object hash, file kind, and normalized mode. Content-addressed objects hold
the exact old bytes. Persisting the bytes is necessary: an upgrade must not depend on the old binary
still being installed, on network access, or on reconstructing comments from a newer serializer.
Because this state should survive clone/checkout, the management store belongs in the project and
should normally be version-controlled.

### Logical overlay

The authoritative project overlay is:

```text
diff(verified old baseline, current materialized project tree)
```

`overlay.yaml` may cache an audit-friendly index of added, changed, deleted, and explicitly retained
paths, with old/current hashes and semantic breadcrumbs. It is not the only authority. On every
Configure publication or upgrade, Koni recomputes the overlay from exact files before committing the
new generation. This makes manual YAML/Markdown edits first-class rather than invisible drift.

`.koni/.managed/**` must be excluded from:

- the materialized-tree digest;
- normal Configure/Advanced resource discovery;
- agent-visible profile imports;
- run `ConfigSnapshot` capture.

The run snapshot already contains the resolved config and skills it needs; copying historical
baseline blobs into every run would waste space and expose irrelevant manager internals.

`resource-manifest.json` should remain readable for compatibility. Its ownership model should evolve
to distinguish baseline bytes from composed project bytes. An intentionally edited Koni-owned skill
is a project overlay to merge, not merely a “modified external file” that makes all upgrades
impossible. Unrelated `.agents` files remain outside Koni ownership and must never be removed.

## Bundle abstraction

Replace call sites that reason directly over raw template arrays with an `EmbeddedProfileBundle`
abstraction containing at least:

- source/profile id;
- management and profile schema versions;
- human profile version;
- final schema-2 file inventory;
- Koni-owned native-resource inventory;
- deterministic content digest;
- optional predecessor lineage/migration notes.

The digest must be calculated after schema conversion and normalization so that installation and
upgrade compare the exact bytes they would publish. A small historical-baseline registry should be
shipped for supported earlier bundles; it is required for precise adoption of projects installed
before baseline provenance existed.

A custom profile source receives the same content-derived identity. It has no implicit “latest”:
future upgrade requires an explicit new `--from <path>` or equivalent source.

## Upgrade algorithm

Let:

- **B** = verified bytes of the project's recorded old baseline;
- **L** = current live materialized project tree;
- **N** = fully staged and normalized new baseline;
- **M** = candidate merge result;
- **O'** = `diff(N, M)`, the new logical project overlay.

Then:

1. acquire the stable project-configuration lock;
2. recover or reject any incomplete prior publication;
3. verify the baseline manifest and capture hashes/path identities for B and L;
4. stage N from the selected bundle/source;
5. compute a typed three-way merge `M = merge(B, L, N)`;
6. surface unresolved semantic conflicts without changing live files;
7. after resolution, compile the project catalog and every run type/profile against M;
8. validate agents, skills, imports, graph relationships, workflows, checks, and native resource
   ownership as one candidate;
9. recheck that B/L/source identities still match the draft inputs;
10. compute O', the new composed-tree digest, and the new baseline generation;
11. publish M, native resources, and management metadata with one durable journal;
12. verify the published generation, mark the journal committed, retain the previous baseline until
    commit verification, and garbage-collect old unreferenced generations later.

Fast-path rules for an individual value/path are conventional and deterministic:

- `L == B`: project did not customize it, so take N;
- `N == B`: upstream did not change it, so keep L;
- `L == N`: take the common value;
- otherwise use typed non-overlap merging or report a conflict.

Reapplying an already installed bundle must be an idempotent no-op.

## Semantic merge policy

### YAML / JSON / TOML

- mappings recurse by key;
- scalar values are atomic;
- add/add, modify/delete, and delete/modify at the same semantic location conflict unless the values
  are identical;
- sequences merge element-by-element only where the schema declares a stable identity, normally
  `id` for nodes, edge rules, run types, stages, personas, workflows, checks, and ticket types;
- fields whose order is semantically meaningful, including argument vectors, imports, and ordinary
  scalar sequences, remain atomic unless only one side changed;
- simultaneous incompatible reorder is a conflict;
- arbitrary objects must not be heuristic-matched by a convenient-looking field. The identity
  registry is explicit and covered by tests.

The implementation should preserve comments and formatting where practical. Prefer a lossless
concrete-syntax/text merge for untouched regions, using typed semantic identity to align conflicting
structures. A whole-document `serde_yaml` rewrite should not be the default because it can turn a
small default update into an unreadable project-wide diff.

### Markdown and prompt/skill text

Use line-based diff3 with non-overlapping hunk composition. Overlapping text changes conflict.
Prompts are executable policy, so “clean” concatenation must not be inferred from prose similarity.

### Generated documents

Resource manifests, composed-tree indexes, receipts, and management digests are regenerated from
the resolved candidate. They are never user-merged as ordinary content.

### Validation conflicts

A byte-level merge can be clean yet invalid. For example, the new Software baseline can retire a
node or persona that an Updog-local run type still references. Treat this as a first-class
`validation_conflict` tied to the affected semantic path. The operator may adapt the overlay or
explicitly retain the retired primitive as a project-owned definition. Koni must never silently drop
the reference or pretend a partially compiled profile is upgraded.

## Conflict and operator UX

### CLI

Introduce an explicit upgrade operation instead of redefining ordinary binary installation:

```text
koni upgrade [--profile software|research] [--from PATH] [--dry-run]
```

`--dry-run` should report:

- current and candidate baseline identities;
- untouched defaults that will advance;
- preserved local additions/changes/deletions;
- conflicts and retired/incompatible primitives;
- future run types affected;
- confirmation that existing runs remain pinned.

If conflicts exist, write a hash-bound draft under Git-common sidecar state such as
`.git/koni/config-upgrades/<upgrade-id>/`, leave live config untouched, and exit nonzero in
noninteractive mode. Conflict IDs must be stable and bound to B/L/N digests. Resolution choices are:

- **Keep project**;
- **Use new default**;
- **Edit merged value/document**.

No destructive resolution is preselected. Before final apply, reject the draft as stale if B, L, or
N changed and require a fresh merge.

Current `--replace` should be deprecated for same-lineage updates and routed to `upgrade` with an
explicit explanation. Switching Software to Research is not an upgrade and should require a
separate, unmistakably destructive `reset-profile` or `rebase-profile` workflow. It must export or
retain the prior overlay and require confirmation rather than silently applying Software-specific
choices to an unrelated ontology.

### TUI

Add a semantic **Configuration > Updates** surface; do not expose `.managed` blobs as ordinary
resources. It should show:

- `Software 0.x → Software 0.y` (plus exact digest in help/details);
- counts for new defaults, preserved project changes, conflicts, and retirements;
- a breadcrumb such as `Run Types > Medium > Planner > reasoning`;
- panes for Old default, Project, New default, and Result;
- the three explicit resolution actions above;
- complete candidate validation and a disabled Apply action until all conflicts are resolved.

Cancel discards only the sidecar draft. Apply publishes once. After success, state clearly that the
new baseline affects future runs; existing run rows retain their pinned profile/run-type identity.
This language lets an Updog operator understand that a generic Software improvement is arriving
without implying that an Updog-local workflow or prompt has become a new global default.

## Publication and concurrency contract

Extract a shared core transaction, for example `ConfigPublicationTransaction`, rather than growing
the CLI and TUI writers independently. It should be used by:

- fresh install and adoption;
- baseline upgrade and explicit profile reset/rebase;
- Configure publication;
- schema migration cutover.

The transaction should reuse/extract the hardened parts of `schema2_migration.rs`: descriptor-based
or no-follow path identity, an fsynced journal, staged validation, deterministic recovery, and
rollback that survives process death rather than only a returned Rust error.

Use one stable project-configuration lock outside the directory being swapped, preferably in the
Git common directory (`<git-common-dir>/koni/locks/configuration.lock`) with a stable project-root
fallback for non-Git installation. Acquire it in:

- `Engine::plan_run_with_binding`, from live catalog compilation through snapshot capture/hash and
  run registration;
- CLI install/adopt/upgrade/reset publication;
- TUI Configure publication;
- schema migration publication.

Approved/active execution does not require this lock because it reads its verified run snapshot.
Planning concurrent with an upgrade then sees either the complete old generation or the complete
new generation, never a hybrid.

`.koni` and `.agents/skills` are distinct filesystem roots, so publication cannot honestly claim one
kernel-atomic rename across both. Under the shared lock, stage the complete composed projection and
use a durable multi-root journal that is **crash-consistent all-or-recover**. Where safe, publish a
complete staged `.agents/skills` directory containing preserved unrelated entries instead of
renaming many individual skills. Preserve native paths; do not insert a Koni-only virtual path that
Codex cannot discover. Recovery must complete or roll back both roots before any Koni consumer is
allowed through the lock.

## Migration and adoption

### Fresh schema-2 installs

Normalize and validate the final bundle, record it as baseline B, calculate an empty overlay, then
publish. Fresh install should be the first rollout point because no ambiguity exists.

### Existing schema-2 projects

1. If the installed profile id/version/content can be matched to an embedded historical baseline,
   adopt those exact historical bytes as B and derive the precise overlay from L.
2. If no trustworthy historical baseline exists, use conservative adoption: compare L with the
   selected current baseline, classify every difference as project-owned, and require a preview.
   This preserves every live value but may retain stale old defaults as local decisions.
3. Never synthesize ownership by guessing which current values “look standard,” and never overwrite
   an unknown project during adoption.

An empty synthetic baseline would turn nearly the whole project into add/add ambiguity; treating all
uncertain differences as local is noisier than precise history but safer. The UI/CLI should label
this mode “conservative adoption” and explain that a one-time review can release stale values back
to the default.

### Schema-1 migration

Keep the existing archival/cutover semantics because schema migration changes the runtime format.
After conversion, establish provenance using the corresponding historical bundle conversion where
known, otherwise use conservative adoption. Do not conflate schema conversion with a silent defaults
upgrade.

### Custom profiles

The installed source digest becomes the baseline identity. A future change requires an explicit new
source. There is no assumption that Koni's embedded Software or Research bundle is its successor.

### Existing and active runs

Do nothing to their snapshots. Do not pause, refresh, recompile, or migrate them. The run remains
bound to the recorded profile/run-type/snapshot hashes; a future run captures the newly materialized
generation. A profile reset may leave historical runs inspectable/executable only insofar as their
normal pinned compatibility contract already permits.

## Exact implementation seams

### Core

- Add a focused module such as `crates/koni-core/src/config_publication.rs`, exported by `lib.rs`,
  owning the configuration lock, provenance manifests, staged candidate, journal, recovery, merge
  result/conflicts, validation handoff, and publication transaction.
- Extract generic transaction/no-follow/journal primitives from
  `crates/koni-core/src/schema2_migration.rs` rather than cloning them.
- Reuse `crates/koni-core/src/catalog.rs` compilation for whole-candidate validation. Add an explicit
  semantic sequence-identity registry close to the typed schema rather than scattering `id`
  heuristics through CLI code.
- In `crates/koni-core/src/state.rs`, exclude `.koni/.managed/**` from configuration snapshots while
  retaining the current resolved config and native skills.
- In `crates/koni-core/src/engine.rs:7790`, hold the shared configuration-generation lock across live
  compile, snapshot capture, snapshot finalization, and registration.

### CLI and bundled profiles

- In `crates/koni-cli/src/templates.rs`, replace direct array reasoning with bundle metadata,
  normalized inventories/digests, and a bounded historical-baseline registry.
- In `crates/koni-cli/src/main.rs`, add `upgrade` and adoption/status commands; evolve
  `Schema2ResourceManifest`; route `install_schema2_profile` through the shared transaction; retire
  direct whole-tree update behavior in `publish_staged_install`.
- Keep explicit fresh install separate from same-lineage upgrade and destructive profile rebase.

### TUI

- In `crates/koni-tui/src/model.rs:4203-4380`, replace Configure's independent writer with the shared
  candidate/publication transaction and expose update/conflict draft state.
- In `crates/koni-tui/src/configure.rs`, exclude `.koni/.managed/**` from semantic/Advanced resource
  discovery and add a first-class Updates domain.
- Use `app.rs` / `ui.rs` only for interaction and projection; merge authority remains compiler/core
  owned.

### Agent resources and documentation

- Update the configure-Koni skill and agent prompts to distinguish generic baseline edits from
  project overlay edits, and to state that approved changes affect future run snapshots only.
- Preserve dated documentation history as requested: append transition notes beside the current
  `--replace` and in-place model rather than rewriting older descriptions as if overlay support had
  always existed.

## Required regression matrix

### Merge units

- untouched local value advances to the new default;
- local-only scalar/map change survives;
- non-overlapping changes in one YAML document compose;
- same scalar changed differently conflicts;
- add/add, modify/delete, and delete/modify conflict correctly;
- stable-id list elements merge recursively;
- order-sensitive/scalar sequences conflict when both sides change;
- Markdown non-overlapping hunks merge and overlapping hunks conflict;
- generated documents are regenerated rather than merged;
- output ordering/digests are deterministic and reapplying is idempotent;
- comments and unrelated formatting survive a bounded update.

### Install and upgrade

- fresh Software/Research install records a verified baseline and empty overlay;
- a generic Software v1→v2 change flows into an untouched Updog-like project;
- locally modified run type, persona, node, edge rule, operation, workflow, check, prompt, and skill
  each survive;
- project-added/deleted primitives survive as explicit overlay decisions;
- an upstream removal referenced locally blocks before publication;
- ordinary upgrade rejects Software→Research lineage changes;
- custom-source lineage requires an explicit successor source;
- unrelated `.agents` resources remain byte-identical;
- a modified bundled skill is three-way merged rather than discarded;
- conflicts cause zero live writes;
- injected failure at every publication rename/fsync recovers one complete generation;
- symlink/hardlink/ancestor substitution, concurrent edit, and stale-draft attacks are rejected.

### Snapshot and concurrency

- planned, approved, paused, and active run snapshot bytes/hash remain unchanged through a live
  configuration upgrade;
- open/supervise/recovery continues to use the old pinned profile and run type;
- a newly planned run uses the new merged generation;
- plan-vs-upgrade locking yields a wholly old or wholly new snapshot, never a mixture;
- TUI Configure and CLI upgrade serialize on the same lock.

### Migration

- known historical baseline adoption derives a precise overlay;
- unknown-baseline conservative adoption overwrites nothing;
- schema-1 conversion followed by provenance adoption preserves its current compiler-issued archive
  proof;
- interrupted adoption is recoverable and idempotent.

### TUI

- management internals never appear as editable project resources;
- preview classifies new defaults and project changes accurately;
- all conflicts are reachable and all three resolution choices work;
- Apply is disabled until resolution and validation complete;
- cancel/stale draft changes no live files;
- existing runs retain their pinned identity while future-run messaging names the new baseline.

Run the focused core/CLI/TUI suites, full workspace tests, profile validation for Software and
Research, and the existing adversarial path/publication matrices before declaring the direct
replacement path retired.

## Incremental rollout

### Phase 0 — provenance and preview only

Land parsers/writers, deterministic bundle identities, shared validation, and an audit-only
`koni upgrade --dry-run`. Do not alter existing publication semantics automatically.

### Phase 1 — fresh-install provenance

Fresh installs write the immutable baseline and empty overlay. Configure continues editing the
materialized tree; overlay derivation is verified but not yet used to advance a baseline.

### Phase 2 — explicit adoption

Provide previewed adoption for existing schema-2 projects, using historical exact adoption where
possible and conservative adoption otherwise. Projects without management metadata retain their
current behavior until an operator adopts them.

### Phase 3 — CLI same-lineage upgrades

Enable conflict-aware baseline upgrades through the shared lock/transaction. Deprecate `--replace`
for updates, but retain an explicit compatibility error/instruction instead of silently changing its
meaning in scripts.

### Phase 4 — TUI Updates and unified Configure publication

Expose semantic preview/resolution in the control center and route all Configure writes through the
same core publisher. This is the point at which the TUI can honestly be the only routine interface
needed for project updates.

### Phase 5 — explicit rebase/reset and garbage collection

Add intentionally destructive cross-profile rebase/reset, retained-overlay export, historical
baseline garbage collection, and finally remove direct whole-tree replacement after a documented
compatibility window.

Every phase is gated by a management-manifest version and must remain forward-detectable by older
binaries. A Koni binary refresh must never automatically mutate project configuration.

## Decisions and trade-offs

1. **Materialized tree over runtime virtual overlay.** This keeps every existing compiler and
   Codex/Pi lookup honest. The cost is storing old baseline objects and performing overlay derivation
   at publication time.
2. **Exact old bytes over version-only reconstruction.** This enables deterministic three-way merge
   after clone or binary replacement. The storage cost is bounded profile content, not run data.
3. **Logical/derived overlay over a hand-maintained patch as sole authority.** Manual edits cannot be
   lost because an overlay index was not updated. Publication still persists a reviewable index.
4. **Crash-consistent multi-root transaction, not false atomicity.** Native `.agents` compatibility
   is preserved, while a shared lock and journal prevent Koni from consuming a partial generation.
5. **No active-run migration.** Existing snapshot machinery already provides the desired stability;
   touching it would add risk without user value.
6. **Software baseline versus Updog overlay is an ownership decision.** A change intended for every
   coding project must be authored and tested in the bundled Software profile. A repository-local
   exception remains local even if first discovered while using Updog as the live smoke project.

## Release recommendation

Do not describe current `--replace` as a safe project upgrade. It is safe only as an intentional
complete profile replacement under today's contract. The architecture above can be introduced
without destabilizing active work because runs are already pinned; the critical prerequisites are
exact baseline provenance, the shared configuration-generation lock, and one crash-consistent
publisher used by CLI and TUI.
