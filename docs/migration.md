# Migration

> **Pi-native lifecycle evolution — 2026-07-16 (`profile_lifecycle_migration`):** The Rust-era
> migration transactions below remain implementation history. Current TypeScript Core adds a
> previewed, hash-bound `.codex/koni`/unmanaged-`.koni` adapter that preserves exact source bytes,
> requires the owning run authority to hold a pause/quiescence barrier when legacy run state
> exists, archives compatibility receipts atomically, and re-hashes a run before compatibility
> resume. It never treats legacy state as implicit execution permission. See
> [Pi-native profile lifecycle](profile-lifecycle.md).

> **Pure TypeScript/Pi runtime supersession — 2026-07-16 (`pi-native-port`):** New runs are executed
> only by `@koni/core` and Pi 0.80.10 sessions. Existing schema-2 project overlays are adopted
> without rewriting project configuration. Persisted Rust-era runs pass an exact discriminator,
> graph/config/Git proof, and compatibility adapter: terminal history is preserved; a clean active
> legacy worktree receives a journaled two-hop relocation before it can resume; dirty, moved, or
> ambiguous state remains blocked and untouched. There is no automatic credential migration—Pi's
> existing authentication stays canonical—and no fallback to the old runtime.

Köni includes a one-time migration for projects configured by its predecessor.
The old name appears in this document only where it identifies a literal path
or namespace that the migration must recognize.

> **Distinct Pi/schema 2 migration in progress — 2026-07-14 (`pi_product_docs_transition`):**
> This document's Pythagoras-to-Köni transaction remains the executable schema-1 migration and its
> history is not being replaced. A separate, unreleased transaction will migrate a current
> `.codex/koni` schema-1 project to `.koni` schema 2 and the direct Pi runtime described in
> [Direct Pi runtime](pi-runtime.md). Schema-1 snapshots remain readable, active Codex-backed runs
> are archived through compiler-issued evidence, and a migrated project has no Codex fallback.

> **Release-candidate supersession — 2026-07-14 (`pi_product_docs_transition`):** The separate
> “unreleased transaction” status is historical. Current source contains the schema-1-to-2/Pi
> release-candidate transaction, with `.koni` as the live post-migration root and no production
> Codex fallback. Its macOS runtime uses an exact first-cut credential TCB comprising the Köni Rust
> binary, bundled Pi host, pinned Pi SDK 0.80.7 dependency closure, and official pinned Node 22.19.0;
> Node retains no compiler-tool, graph, Git, receipt, or project-file authority. Linux login and
> inference fail closed pending allowlisted egress. Running this migration is a separate guarded
> operator action, and protected forensic Updog state is never authorization to apply it.

## What is detected

When `.codex/koni/` is absent, `koni init` checks for the legacy
`.codex/pythagoras/` directory. It also inventories native Codex resources
listed in that installation's ownership manifest.

Migration does not maintain two live layouts. A successful project uses only
the Köni configuration and namespace going forward.

> **Schema-2 no-dual-runtime boundary — 2026-07-14 (`pi_product_docs_transition`):** The same
> one-live-layout principle applies to the planned schema-1-to-2 cutover: `.koni` becomes the only
> execution source after publication, while old `.codex` snapshots and transcripts remain
> historical readers rather than executable fallback. The schema-2 transaction is not available
> until migration recovery/security and the frozen runtime matrix are green.

> **No-dual-runtime supersession — 2026-07-14 (`pi_product_docs_transition`):** Recovery,
> security, and frozen-matrix evidence now pass for the release candidate, so the explicit
> transaction is present in current source. The one-live-layout rule is unchanged: publication
> activates `.koni`, archives active Codex runs permanently, preserves historical readers, and
> provides no Codex execution fallback.

If both `.codex/koni/` and the legacy directory exist, initialization refuses
to guess which is authoritative. Reconcile or archive one layout explicitly,
then rerun the dry run.

## Preview first

From the project:

```sh
koni init --dry-run
```

The preview reports:

- the discovered project root;
- the selected profile;
- whether `.codex/` would be created;
- whether a current or legacy installation exists;
- whether replacement was requested.

Dry-run does not write a receipt, backup, configuration, branch, or Git ref.
It is an orientation step, not full validation; the real transaction performs
validation before publication.

## Migration transaction

Run the normal initializer when the preview is clean:

```sh
koni init
```

Köni then:

1. reads the legacy tree without modifying it;
2. converts known catalog, profile, resource locator, and branch-template
   identifiers in a staging directory;
3. preserves the original bytes beneath
   `.codex/.koni-migrations/<timestamp>/`;
4. compiles and validates the staged Köni project with its native agents and
   skills;
5. publishes `.codex/koni/` and owned native resources atomically;
6. writes a migration receipt identifying the migration and backup.

Validation or publication failure rolls the project back to its exact
pre-migration state. A failed staging directory is not treated as an installed
project.

> **Schema-2 migration security hold — 2026-07-14 (`pi_product_docs_transition`):** The six steps
> above apply to the predecessor-name migration. The new schema-2 transaction must additionally
> transform only known schema fields, reject symlinked source ancestors, revalidate source and
> authoritative run-registry state at publication, archive every active Codex run with opaque
> compiler-issued evidence, and journal/fsync each multi-rename phase for idempotent crash
> recovery. Prompt, metadata, and embedded schema strings that merely resemble legacy field names
> must remain byte-preserved. Those gates, plus historical-reader fixtures and the complete Pi
> security/frozen matrix, remain open in [Direct Pi runtime](pi-runtime.md).

> **Migration-security supersession — 2026-07-14 (`pi_product_docs_transition`):** The current
> release candidate closes those field-scoped conversion, no-follow ancestor/leaf publication,
> registry revalidation, compiler-issued archival, fsynced recovery, historical-reader, and frozen-
> matrix gates. They remain enforced transaction invariants, not checks an operator may waive.

## Conflicts

Migration stops when:

- old and new live configuration trees both exist;
- an installed native agent or skill collides with an unowned project resource;
- an owned resource changed since its recorded hash;
- a source path is a redirected symlink or escapes the project;
- configuration conversion leaves a dangling reference or invalid profile;
- a source filename collides after conversion.

Do not use `--replace` to silence an ownership problem you have not inspected.
Move intentional project customizations into a distinct resource or incorporate
them into the converted profile, validate, and retry.

> **Schema-2 ownership hold — 2026-07-14 (`pi_product_docs_transition`):** `--replace` likewise
> cannot authorize schema-2 conversion or retirement. Only manifest-proven owned resources may be
> converted/retired; unrelated `.codex` content, project customization, and historical readers are
> preserved. Ancestor redirects, stale ownership hashes, newly appeared legacy runs, partial
> archival, or an interrupted publication fail closed and require the migration recovery path.

> **Ownership-hold supersession — 2026-07-14 (`pi_product_docs_transition`):** Those fail-closed
> ownership and recovery rules are implemented in the release candidate. This supersedes their
> status as open implementation work, not their force: `--replace` still cannot bypass ownership,
> archival, pathname, or recovery evidence, and unrelated `.codex` resources remain untouched.

## Legacy profile format

Köni can present a legacy TOML profile through a synthesized `legacy` run type
long enough to stage an explicit conversion. That adapter is a compatibility
surface, not the recommended authoring format.

The control center's migration action creates a canonical YAML catalog, run
type, and profile draft. Review the draft and publish it through the same
complete validation transaction used by Configure. Existing pinned runs keep
their snapshots; future runs use the canonical catalog.

## After migration

Verify the project and inspect the resulting resources:

```sh
koni validate-profile .
koni
```

Then:

1. review `.codex/koni/project.yaml` and its default run type;
2. start a new Codex chat so project skills are rediscovered;
3. create a dry, narrow planning run and review its pinned snapshot;
4. keep the migration backup until the new configuration has been exercised;
5. commit project-owned configuration when it is intended to be shared.

The initializer migrates project configuration and its owned native resources;
it does not guess at active run directories, worktrees, or Git refs. Do not
rename those resources manually. Conclude or archive legacy active runs, then
create new work through Köni.

> **Post-cutover transition in progress — 2026-07-14 (`pi_product_docs_transition`):** The
> instruction to start a new Codex chat remains correct after the predecessor-name/schema-1
> migration above. It will not apply after schema 2: Köni will start its pinned Pi host directly,
> with no Codex fallback, and will retain old run/transcript resources only for inspection.
> Operator-directed archival is not sufficient evidence for the new transaction; production must
> bind compiler-issued no-active-runs/archive proof to the current registry revision and migration
> ID, then resolve the credential-TCB choice (Rust-owned allowlisted auth proxy versus signed/pinned
> host dependency closure) and pass artifact/containment/protocol/token and frozen-matrix review
> before publication.

> **Post-cutover supersession — 2026-07-14 (`pi_product_docs_transition`):** The credential-TCB
> choice is now decided and the named source matrix passes: the exact Köni Rust, bundled host/Pi SDK
> 0.80.7 closure, and pinned Node 22.19.0 runtime are trusted for provider credentials, while Rust
> alone owns compiler tools, graph, receipts, Git, and project files. Schema-2 publication still
> requires the exact compiler-owned migration proof; source readiness or operator intent cannot
> substitute for it.

## Schema 2 / Pi migration implementation checkpoint — 2026-07-14

The holds above remain the discovery history. The current source implements the explicit
transaction as:

```sh
koni migrate-pi --root . --dry-run
koni migrate-pi --root . --apply
```

Dry-run hashes every owned source and returns the configuration plus run-disposition plan without
writing. Apply requires that exact compiler proof, holds migration/registry/per-run authority,
stages and recompiles `.koni`, archives every eligible active Codex-backed run with the migration
reason, and publishes with an fsynced recovery journal under Git-common compiler state. Publication
uses no-follow parent/source descriptors, rechecks the bound inode, performs descriptor-relative
`renameat`, fsyncs both parents, and verifies the destination inode. Synchronized same-byte leaf
replacement and ancestor replacement regressions prove that a substituted pathname is rejected or
that only the already-bound original is moved.

The new live layout is `.koni/` with provider-neutral YAML agents under `.koni/agents/`; repository
skills remain in `.agents/skills/`. Unrelated `.codex` files and all historical transcript/read
surfaces remain. A migrated Codex run is forensic history only—Köni never resumes it under Pi.

Focused current-source evidence: schema migration 14/14, migration run-archive/proof 3/3, and CLI
dry-run/apply 2/2. These focused results establish the transaction boundary; release adoption still
requires the final whole-workspace and packaged-runtime matrix described in
[Direct Pi runtime](pi-runtime.md).

> **Migration-candidate endpoint — 2026-07-14 (`pi_product_docs_transition`):** The later final
> endpoint completes that whole-workspace and packaged-runtime matrix: locked workspace 1,041/0/3,
> locked clippy/formatting, Pi host 34/34, and a verified temporary-prefix package/model probe. No
> user installation or live migration occurred during that proof. Apply only as a separate guarded
> operator action in an authorized project; never reinterpret the protected forensic Updog runs as
> migration authority.

## Pi-native Rust-run successor adoption — 2026-07-16

> **Transition note (`legacy_run_adoption/root`):** This adds a guarded successor path beside the
> historical “forensic history only” rule above; it does not erase or weaken the original archive.
> A legacy run is never resumed in place and its Rust transport log is never passed off as a Pi
> session.

After a successful `planLegacyProjectMigration()` / `applyLegacyProjectMigration()` transaction,
operators can inspect the archived run catalog without writing:

```sh
koni adopt --migration <migration-id>
```

Only `planning`, `approved`, `active`, and `paused` entries with complete barrier, run-type, Git,
and immutable-source evidence can be adopted. Create one distinct paused successor explicitly,
then cross the separately verified resume boundary:

```sh
koni adopt --migration <migration-id> --run <legacy-run-id> --apply
koni resume --run <successor-run-id>
```

The adoption transaction writes current authority state only. It does not create a worktree,
launch Pi, mutate the legacy run tree, or move its branch. It binds the exact archived plan,
compatibility index, receipt bytes, registry, run tree, barrier, base/target commits, and source
checkout. First resume re-verifies those bindings before materializing a new detached planning
checkout. A clean committed legacy integration HEAD becomes the new planning base for
approved/active/paused work; a planning run uses its pinned base commit. The first model attempt
is a fresh authenticated Pi recovery root, not a fabricated branch of Rust transport events.

Unsupported terminal history and missing, dirty, redirected, ambiguous, changed, incompatible,
or history-rewritten sources remain untouched and return typed blockers. Repeating apply returns
the already registered successor, including after authority restart; it cannot create duplicate
current runs for one migration/source binding.
