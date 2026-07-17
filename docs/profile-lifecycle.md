# Pi-native profile lifecycle

Status: implemented in `@koni/core`; Coding 0.7.0 and Research 1.0.11 are the first evolved
immutable bundles using this lifecycle.

This is a transition note beside the earlier Rust-era initialization and migration documents. It
does not erase their historical explanations.

## Ownership boundary

An official profile package contains a passive Pi registrar, `koni/profile-manifest.json`, and a
complete immutable `koni/baseline/` tree. Pi-loaded registrars announce their manifest URL through
Koni discovery events; Core verifies every manifest path, byte count, file hash, bundle digest,
package identity, profile lineage, and compatibility range before use.

Installation owns only `<project>/.koni`. It never mutates `.pi`, `.agents`, credentials,
settings, community packages, prompts, themes, sessions, or unrelated `.codex` content.

## Baseline plus project overlay

Every install/upgrade stores two forms of provenance:

- `.koni/.managed/install.json` remains the strict compatibility record consumed by the project
  compiler; and
- `.koni/.managed/lifecycle.json` records generation, lineage, installed bundle, complete overlay,
  pending upstream changes, immutable baseline history, and guarded migrations.

Exact baseline bytes are retained at
`.koni/.managed/baselines/<bundle-sha256>/`. They are write-once: a changed archived byte fails the
next lifecycle operation instead of being silently repaired.

Upgrade is a three-way comparison among the exact prior baseline, current project bytes, and the
new verified package baseline:

- unchanged project files adopt changed upstream defaults;
- project edits, deletions, additions, and modified files removed upstream remain project-owned;
- a real edit/delete conflict stages incoming bytes beneath `.managed/upstream/` and records a
  pending change without overwriting the project file; and
- an ordinary local override is not mislabeled as a conflict when upstream did not change.

Publication uses a crash-forward file transaction with source-hash compare-and-swap. Normal
upgrades are semver-monotonic; downgrade requires an explicit guarded option. Preview performs the
same projection without creating `.koni`, a lock, or a transaction.

## Safe guided configuration edits

The control center does not write YAML or `.managed` files directly. Core exposes:

- `catalogProjectAuthoredConfig(projectRoot, profilePackageRoot)`;
- `readProjectAuthoredConfigDocument(projectRoot, profilePackageRoot, path)`; and
- `updateProjectAuthoredConfigDocument(request)`.

The catalog returns each authored YAML document's normalized path, source SHA, byte size, file
kind, semantic domain, guided-editability, label, and top-level keys, together with the compiled
configuration and effective-bundle revisions.

An update accepts one structured document and its exact expected source SHA. Core rejects
compiler-owned paths and unsafe values, serializes one strict YAML document, reconstructs the
complete candidate from the authenticated baseline plus current project overlay, compiles that
candidate, and atomically publishes the document, install bookkeeping, and lifecycle generation.
The result returns the new source, configuration, and effective-bundle hashes. Invalid candidates
and stale editors produce no authored or lifecycle change.

Real three-way conflicts are resolved through `resolveProfileUpstreamConflict(request)`. The
request binds lifecycle generation, path, and current project digest. `keep_project` preserves the
overlay while recording that decision; `accept_upstream` writes/recreates the verified package
byte or removes an upstream-orphaned file. Both choices compile the complete candidate and publish
the file effect, pending-conflict removal, resolution history, and lifecycle generation in one
transaction.

## Guarded legacy migration

`planLegacyProjectMigration()` is read-only. It inventories and hashes either legacy
`.codex/koni` schema 1 or an unmanaged `.koni`, refuses ambiguous dual roots and symlinks, merges
known schema-1 customizations onto the selected current baseline, converts provider-neutral agent
resources, and compiles the complete candidate. The plan binds source, package, transformed
inventory, Git-common legacy run registry, and every run tree.

`applyLegacyProjectMigration()` rechecks those identities before publication. Exact legacy config
and agent bytes, the plan, run compatibility index, barrier evidence, and receipt are archived
beneath `.koni/.managed/migrations/<migration-id>/` in the same transaction as the managed
profile. The source `.codex/koni` and legacy Git-common state remain byte-preserved; they are not a
second live configuration authority.

If a legacy registry or run state exists, apply requires a `LegacyRunMigrationAuthority` to keep
the owning runtime's pause/quiescence barrier held through publication. Planning runs map to
`planning_paused`; approved, active, and paused runs map to `execution_paused`; terminal states
retain their terminal disposition. `verifyLegacyRunCompatibility()` re-hashes the exact legacy
run tree immediately before any compatibility resume. A changed tree fails closed rather than
spending more tokens under stale state.

This adapter preserves run evidence and makes resumption an explicit authority decision. Merely
finding legacy files never authorizes migration, process control, or provider access.

> **Legacy-run execution transition — 2026-07-16 (`legacy_run_adoption/root`):** The archived
> compatibility evidence now has an explicit current-authority adoption path; this narrows the
> earlier statement that the adapter only preserved evidence without making discovery itself
> executable. `koni adopt --migration <id>` previews typed dispositions. The separate
> `--apply --run <legacy-id>` action creates one distinct paused current successor, never rewrites
> the Rust run, and does not start Pi. `koni resume --run <successor-id>` then re-hashes the source
> tree, registry, exact archived plan/index/receipt bytes, barrier, and Git pins before atomically
> authorizing a fresh epoch-zero Pi recovery lineage. Planning sources use their pinned base;
> approved/active/paused sources require one exact clean registered legacy integration checkout
> and use its committed HEAD. Terminal, dirty, ambiguous, changed, incompatible, or history-
> rewritten sources remain immutable with typed blockers.
