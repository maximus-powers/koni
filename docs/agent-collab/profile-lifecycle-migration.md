# Profile lifecycle and migration

Owner: `profile_lifecycle_migration/root`

Status: complete; lease released after the final integration handoff below

Last checked: 2026-07-16 MST

## Claimed source scope

- `packages/core/src/profile/**` and profile-lifecycle migration modules
- profile-lifecycle focused tests under `packages/core/test/**`
- `packages/coding-profile/**` and `packages/research-profile/**` bundle manifests,
  baseline material, and their passive Pi registrars
- append-only collaboration and transition notes

Excluded: authority run engine, native run compiler, Pi session/process code, control
center, CLI/extension integration, live projects, Pi homes, credentials, installed
binaries, processes, refs, and terminal surfaces.

## Contract being implemented

Profiles are immutable, byte-verified npm package baselines. A project has one
materialized `.koni` overlay whose edits, deletions, and additions remain project-owned
across upgrades. Incoming defaults are three-way compared against the exact prior
baseline; conflicts are staged as inert proposals and never overwrite project bytes.
Pi's `.pi` tree, credentials, settings, packages, community extensions, and ambient
resources are outside this lifecycle and are never copied, edited, or installed.

Legacy Rust-era `.codex/koni` and pre-metadata `.koni` trees enter through an explicit,
versioned, previewable migration. The migration snapshots source identity, stages a
candidate, refuses ambiguous or unsafe state, and emits a durable receipt. Run state is
preserved byte-for-byte and is migrated only by a versioned compatibility adapter; it is
never inferred or silently discarded.

Third-party Pi packages are represented only as optional declarative resource bindings
inside the bundled profile. Koni never auto-installs them and contained attempts receive
only compiler-selected, hash-bound resources.

## Coordination

The CLI/operator lane should call this module's discovery, preview, install/upgrade, and
legacy-migration APIs. It must present pending upstream conflicts and require an explicit
resolution instead of treating a successful transaction as proof that every incoming
default was accepted.

## 2026-07-16 implementation handoff

The lifecycle implementation is complete within this lane:

- `install.ts` exposes verified package loading, read-only preview, crash-forward install/upgrade,
  immutable baseline retention, project overlays, real upstream-conflict staging, and lifecycle
  metadata.
- `migration.ts` exposes read-only schema-1/unmanaged planning, exact-source revalidation,
  provider-neutral agent conversion, current-baseline structural merge, held run-authority
  barriers, source-retaining archives/receipts, and pre-resume legacy run verification.
- `resource-bindings.ts` parses/resolves optional already-installed Pi packages without installing
  or enabling them.
- `config-edit.ts` exposes compiler-authenticated catalog/read/update APIs for one structured YAML
  document under source-SHA CAS. It returns semantic domains and fresh compiled revisions; the UI
  never writes `.managed`.

Exact config exports for the operator/control-center lane:

- `catalogProjectAuthoredConfig(projectRoot, profilePackageRoot)`;
- `readProjectAuthoredConfigDocument(projectRoot, profilePackageRoot, relativePath)`;
- `updateProjectAuthoredConfigDocument(request)`;
- `resolveProfileUpstreamConflict(request)`;
- `ProjectConfigCatalog`, `ProjectConfigCatalogEntry`, `ProjectConfigSemanticDomain`,
  `UpdateProjectAuthoredConfigRequest`, `UpdateProjectAuthoredConfigResult`, and
  `ProjectConfigMutationError`.

Exact migration exports:

- `planLegacyProjectMigration(options)`;
- `applyLegacyProjectMigration(plan, options)`;
- `verifyLegacyRunCompatibility(index, runId)`;
- `LegacyRunMigrationAuthority` and its hash-bound barrier request/evidence contracts.

Stable official bundle identities:

- Coding 0.7.0: 46 files,
  `sha256:4b34812a75bd020edd79d5f9b5c8efee9a326f8d47e552fc11f69f6cce96317a`;
- Research 1.0.11: 49 files,
  `sha256:66c11b019a5b81ad99d6c2d066adac464f212e472f6e8fb5395ab16da3632e2f`.

> **Resource-selector evolution — 2026-07-16 (`pi-native-port`):** The two hashes above remain the
> completed handoff identities before community-resource selection became executable. Adding the
> inert, disabled `select.skills`, `select.prompts`, and `select.tools` editor fields changes the
> authenticated Coding bundle to
> `sha256:7e3e03d9f306607c13c29a4f7f80f933302e87606c0d5dd6ee75135e3fdc2628` and Research to
> `sha256:0ffbe35feee0485e72e4c491590914b570d469d0c69c78ff5d3e37070c222aa6`.

> **Shared-skill supersession — 2026-07-16:** Those hashes remain the exact community-selector
> checkpoint. The final package pass removed obsolete Rust-era commands from the 18 shared skills
> and described the implemented verified-baseline/project-overlay upgrade. Coding is now
> `sha256:1ab5a2590299f34501027aeaeb7b4d24e467f88a2cc3b478dbae5de7ba6f3919`; Research is
> `sha256:521325d38da1465a747f2ad6d45e73484049de095196026a8d56f53093be130a`.

> **Native-command correction — 2026-07-16:** The two hashes above preserve the first operator-
> skill wording checkpoint. A release audit found additional manifest-bound lifecycle/recovery and
> Research README commands from the frozen Rust interface. After explicitly marking that history
> superseded and pointing agents only at shipping Pi/Core surfaces, Coding is now
> `sha256:2d686e082bbd72a7d866472e979578370dc2d9fe2e5bc1f7a711eeeeacb3a856`
> and Research is
> `sha256:596591fd6123dd773100297276deb6c1ea938bf9f9629ef432f4572c26a6fe95`.
> No ambient package is enabled or installed by this evolution.

The Research bundle retains nonempty node descriptions and one canonical bidirectional stored
fact for experiment/ablation `target_claims` (inverse `tested_by`) and `gate.applies_to` (inverse
`gates`). No reciprocal `tested_by`/`gates` edge declaration exists.

Evidence at this checkpoint: profile bundle/package/registrar tests **9/9** and focused Core
profile lifecycle/migration/config/resource tests **32/32**. Exact-optional/no-unchecked isolated
TypeScript is green. Broad Core validation is currently blocked only by concurrently edited Git,
run-engine, and control-center source outside this lease.

## 2026-07-16 final integration handoff

After the adjacent Git and operator lanes stabilized, the complete Core strict TypeScript check
also passed. The focused profile suite remains **32/32**, coding-profile check is **1/1**, and
research-profile check is **3/3**. Profile filesystem fixtures now use the same explicit 30-second
timeout as the migration/conflict fixtures so a composed parallel run cannot mistake ordinary
compiler/filesystem contention for a lifecycle failure; no production timeout or behavior changed.

The remaining integration obligation is deliberate and outside this released lease: the one
authority/run engine must implement `LegacyRunMigrationAuthority.withQuiescedRuns`, persist the
hash-bound barrier evidence, and call `verifyLegacyRunCompatibility` immediately before allowing a
migrated paused run to resume. The profile adapter does not gain independent run or process
authority.
