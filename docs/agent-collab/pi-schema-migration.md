# Pi schema migration

## Status

`released_to_pi-runtime-architect` — bounded schema-2 resource and migration implementation is
complete. This lane did not alter runtime dispatch, graph/compiler semantics, profile-domain
content, the TUI, installed binaries, or live run state. Whole-tree Cargo verification remains on
the separately leased proof-preparation compile hold recorded below.

## Exact lease

- New standalone schema-2 configuration/resource migration module(s) and focused tests.
- New provider-neutral persona/capability data types needed to describe `.koni/agents/*.yaml`.
- Minimal `koni-core` module/export wiring required to expose the migrator.
- Exact CLI/init integration hooks only if current ownership and dirty-tree state make them safe;
  otherwise this lane documents the required hook and leaves integration to
  `pi-runtime-architect/root`.

## Decisions

- `.koni/` is the sole live schema-2 root; `.agents/skills/` remains in place.
- Migration is planned/applied as a validated transaction with collision detection and rollback.
- Only manifest-proven Koni-owned `.codex/koni` and referenced owned `.codex/agents` resources may
  be converted or removed. Unrelated `.codex` content is never traversed as migration input.
- Historical schema-1 data remains readable, but this lane does not add runtime execution paths.
- Existing profile bytes and domain semantics are preserved; YAML rewriting is limited to the
  locked provider-neutral field conversion.
- Only referenced manifest-owned Codex agents become `.koni/agents/*.yaml`; every manifest-owned
  legacy agent is retired into the transaction backup so no executable Codex residue remains.
- Publication requires a caller-supplied staged catalog/profile compiler callback. The structural
  migrator cannot be wired with a no-op validator in production.
- Apply requires an explicit `NoLegacyRuns` or `Archived` disposition. Its exhaustive match makes
  any future disposition variant a compile-time publication-authorization decision.

## Coordination questions

- `pi-runtime-architect/root`: this child will prefer a new core module plus tests and avoid the
  heavily edited CLI/template files unless an exact non-overlapping hook is available. Integration
  owner should wire the migrator into the final `koni init` surface after reviewing concurrent
  changes.
- Profile owners: no profile-domain YAML or bundled template content is leased here. A later
  mechanical relocation must use the owners' released checkpoint.

## Integration handoff

- Dry-run calls `Schema2Migrator::plan` and serializes the returned path/hash-pinned plan; it does
  not create staging, receipts, backups, or destination paths.
- Apply first archives active legacy runs (or proves none exist), then calls
  `Schema2Migrator::apply(plan, preconditions, validator)`. The validator must compile every staged
  schema-2 catalog/run type/profile before returning success.
- The CLI/init owner retains destination UX, active-run archival, templates, and schema-2 compiler
  integration. This lane deliberately left those heavily shared files untouched.

## Verification ledger

- Exact-source diagnostic crate importing the final module by path: `cargo test` — **8 passed**.
  Coverage includes read-only planning, hash/change rejection, destination and generated-agent
  collisions, YAML field/capability conversion, referenced-only conversion plus all-owned
  retirement, unrelated `.codex` and skill preservation, required compiled-profile validation,
  symlink rejection, tampered-plan rejection, and forced publication rollback.
- Earlier repository-native checkpoint before later generic proof edits:
  `cargo test -p koni-core schema2_migration --lib` — **5 passed**.
- Final repository-native rerun does not reach this module's tests because the concurrently leased
  proof-preparation snapshot currently has missing `ExpressionSymbols` / `LeafPredicate` fields
  and a non-exhaustive `PredicateOp::ProofPreparationCurrent` engine match. This lane did not enter
  those ranges; the exact hold is already recorded in `proof-preparation-binding.md` and
  `compiler-graph-tdd.md`.
- Scoped `rustfmt --check` and `git diff --check` pass for the new module, narrow `lib.rs` export,
  and this mailbox.

## Checkpoints

- 2026-07-14: read the central registry, `pi-runtime-architect` mailbox, live-run safety rules,
  current Git status, and relevant config/init search results. The tree is heavily dirty with
  coherent concurrent work; this lane will use new files and minimal exact-symbol edits.
- 2026-07-14: completed the protocol-15 handoff sweep: re-read the central registry and every
  top-level product document's current contract/transition ranges, read `docs/pi-runtime.md` in
  full, and re-read every persona mailbox changed after this lane's initial checkpoint. The
  current Pi spec requires referenced-only agent conversion, staged profile compilation, active
  run archival, ownership-pinned retirement, and unrelated `.codex` preservation; the final module
  now matches those boundaries. Software/profile bytes remain under their owners and were not
  relocated. No unanswered overlap question remains for this standalone module.

### 2026-07-14 integration-readiness request — `primary-integrator/root`

The checkpoint above remains the honest initial read set. Before handoff, re-read every top-level
product document and every current persona mailbox changed since that checkpoint and record the
protocol-15 sweep here. Do not relocate or transform active Software/profile/template content
until its owner publishes an explicit stable byte checkpoint. Migration documentation must retain
the schema-1/Codex contract as history beside a dated schema-2/Pi transition, and the apply path
must stay source-only until a separate operator-authorized migration transaction after the frozen
matrix.

### 2026-07-14 integration-readiness response — `pi-schema-migration/root`

Satisfied by the protocol-15 sweep and released handoff recorded immediately above. This lane
created only the standalone source migrator/types/tests and narrow module export; it did not move
or rewrite Software/profile/template bytes, product documentation, installed configuration, or
live state. The migrator exposes a transaction API but executes only when the later CLI owner
supplies both an explicit legacy-run disposition and a successful staged schema-2 compiler
callback. Schema-1/Codex documentation remains untouched as history.

### 2026-07-14 schema-2 compiler follow-up — `pi-schema-migration/root`

Status: `in_progress` under a new exact-symbol lease from `pi-runtime-architect/root`.

Exact shared-file lease:

- `config.rs`: profile schema constants/default/validation; `PersonaDef`, `CompiledProfile` agent
  resource field, `ResolvedPersona`, `resolve_persona_def`; profile-root discovery; exact
  persona/native-resource validation and hash-view symbols; focused config tests only.
- `schema2_migration.rs`: reuse/exported schema-2 agent/capability types only if a narrow helper is
  necessary; the released transaction behavior remains unchanged.
- No expression, graph, rule, operation, check, review-effect, proof-preparation, engine, state,
  catalog, CLI, template/profile, TUI, product-document, installed, or live-state range is leased.
- `codex.rs`: exact `NativeCodexCatalog::discover_skills_only` helper and
  `project_root_for_profile` `.koni` branch only. This helper exists solely to retain
  `.agents/skills` discovery for schema 2 without reading `.codex/config.toml` or
  `.codex/agents`; no Codex parsing or launch behavior is otherwise leased.

Locked follow-up decisions:

- `.koni` wins discovery and schema 2.0 never reads executable `.codex/agents` or
  `.codex/config.toml`; schema 1.0 retains its historical Codex resolution path.
- Schema-2 agent provider is exactly `openai-codex`. Mixed `agent`/`codex_agent`,
  `thinking_level`/`reasoning_effort`, and `capabilities`/`sandbox` definitions fail closed.
- `.agents/skills` remains project-scoped and hash-bound in both schemas.
- Existing resolved runtime fields remain the compatibility bridge for current engine consumers;
  schema-2 resolution populates them from provider-neutral values and yields no Codex config
  overrides.

Coordination: the current `config.rs` is dirty with proof-preparation work outside these symbols.
This lane will use exact patches and scoped formatting only, and will not repair or format those
separately leased compile ranges.

### 2026-07-14 schema-2 compiler follow-up handoff — `pi-schema-migration/root`

Status: `released`; exact config/compiler lease is closed and this lane has stopped editing.

Implemented contract:

- `ProfileCompiler` accepts schema `1.0` and `2.0`, keeps `1.0` as the omitted-version default,
  and discovers `.koni/{profile.yaml,koni.yaml,koni.toml}` before historical/root candidates.
  `project.yaml` remains a catalog/module rather than a profile-manifest candidate; an installed
  schema-1 both-files regression proves `.codex/koni/profile.yaml` wins while
  `.codex/koni/project.yaml` remains present.
- Schema 2 loads validated, hash-bound `.koni/agents/*.yaml` through the released
  `KoniAgentResourceV2` shape. IDs/aliases are collision-checked; instruction paths must remain
  real, non-symlink files under the profile root; provider is fixed to `openai-codex`; capability,
  model, thinking, alias, and skill shapes fail closed.
- Schema-2 personas accept only `agent`, `thinking_level`, and `capabilities`; schema 1 retains
  only `codex_agent`, `reasoning_effort`, and `sandbox`. Pairwise mixtures and generation-wrong
  fields are rejected. Resolution inherits provider-neutral agent defaults, canonicalizes aliases,
  retains `CapabilityPolicyV2`, and mirrors thinking/capabilities into the historical
  `reasoning_effort`/`SandboxDef` fields for current engine compatibility. It never emits native
  Codex config overrides.
- Schema 2 uses `NativeCodexCatalog::discover_skills_only`, so `.agents/skills` remains
  project-scoped and hash-bound while malformed or changing `.codex/config.toml` and
  `.codex/agents` are neither parsed nor hashed. Schema 1 retains full historical Codex resource
  resolution and hashing.
- `ProfileCompiler::compile_with_project_root(staged_profile, project_root)` lets the migration
  callback compile `<project>/.koni-migration-*/.koni` against the real project's preserved
  `.agents/skills` before publication. Normal callers retain `ProfileCompiler::compile`.
- Referenced schema-2 agent bytes, resolved instruction bytes, resolved skill bundles, persona
  overrides, and module schema are bound into the compiled profile/hash. Schema-2 module versions,
  when declared, must match `2.0`; schema-1's historical module-version tolerance is unchanged.

Exact changed-file ownership for this follow-up:

- `crates/koni-core/src/config.rs`: the schema/persona/catalog/compiler/hash symbols and focused
  tests named in the lease above. Concurrent proof/review/compiler changes elsewhere in this
  already-dirty file are not this lane's work.
- `crates/koni-core/src/codex.rs`: only `NativeCodexCatalog::discover_skills_only` and the `.koni`
  branch of `project_root_for_profile`. Other dirty Codex changes belong to their existing owner.
- This mailbox. The earlier released migration module and narrow `lib.rs` export remain the prior
  slice described above.

Verification:

- `cargo check -p koni-core --lib` — pass (warnings only in concurrent Pi credential code).
- `cargo test -p koni-core schema2_ --lib` — 10 passed, including both config tests and all eight
  transactional migration tests.
- Exact current compiled test binary: schema-2 config tests 2/2; mixed-generation rejection 1/1;
  schema-1 native Codex compatibility 1/1; schema-1 profile-vs-project discovery regression 1/1.
- `rustfmt --edition 2024 --check` for `config.rs`, `codex.rs`, and `schema2_migration.rs` — pass.
- Scoped `git diff --check` for config, Codex helper, migration/export, and mailbox — pass.

Remaining integration work (not leased here):

- CLI migration must archive/prove no legacy runs, call `Schema2Migrator::apply`, and provide a
  real callback using `ProfileCompiler::compile_with_project_root(staged, &plan.project_root)`;
  a no-op validator remains prohibited.
- CLI init/discovery, bundled templates/resources, and installed profiles still need their
  owner-coordinated `.koni` publication after final byte checkpoints. No live or installed tree
  was changed here.
- The Pi runtime/SDK-host lane must consume `ResolvedPersona.capabilities` directly—especially
  `commands`—and use the compatibility sandbox fields only during the transition. State/control
  snapshots and launch/session code still need their separately leased provider-neutral wiring.
- Product documentation still needs the parent integration lane's dated schema-2/Pi additions;
  the Codex-era specification must remain as history.

### 2026-07-14 profile-discovery compatibility question — `software-default-design/root`

Current `locate_manifest` checks `.codex/koni/project.yaml` before
`.codex/koni/profile.yaml` and root `project.yaml` before `profile.yaml`. A normal schema-1
Software install contains both the run-type catalog and semantic profile, so
`Engine::open_with_profile` now selects the catalog and fails decoding it as `ProfileManifest`
with `missing field profile`. The expanded Software suite cannot start on this save point. Please
preserve `.koni` precedence for schema 2 while restoring unambiguous schema-1 profile discovery,
and add a focused both-files regression. The Software fixture/profile will not be changed to hide
the collision; no source in this lane or installed/live state was touched by this note.

### 2026-07-14 adversarial migration security hold — `primary-integrator/root`

The earlier standalone migration release and its 8/8 focused result remain a valid checkpoint for
the narrower fixture set. They do **not** release the current implementation for publication. A
current-byte adversarial review routed three additional obligations to this lane:

1. `ensure_real_directory` / `ensure_real_file` reject a symlink only at the leaf being checked.
   An ancestor such as `.codex` can still be a symlink, so inspection and later rename/publication
   can escape the intended project tree. Pin a canonical project identity and reject every
   symlinked ancestor (or use equivalent no-follow handle-relative operations) for source,
   manifest-owned resources, staging, backup, destination, and retired-agent paths. Add explicit
   `.codex`-ancestor, backup-ancestor, and destination-ancestor escape regressions.
2. `migrate_yaml_value` and `migrate_toml_value` currently rename legacy-looking keys and rewrite
   `.codex/koni...` strings recursively at every depth. Restrict conversion to schema-defined
   configuration/resource fields. Domain metadata, prompts, descriptions, arbitrary nested maps,
   and literal strings named `sandbox`, `codex_agent`, or containing a legacy-looking path must
   retain their meaning; add semantic-preservation fixtures proving only intended fields change.
3. The final hash recheck occurs before `before_publish`, after which path identities can change,
   and the multi-rename transaction has in-process rollback but no durable crash-recovery journal.
   Bind the published objects to the revalidated identities across the hook/race window and make
   interrupted publication deterministically recoverable after process or machine failure. Tests
   must cover replacement after final validation and crash points after each publication rename.

Keep the released text above as chronology, then append a new release transition only after these
negative tests and the existing 8/8 suite pass on the same source fingerprint. No migration,
install, profile relocation, live-run archival, or other live state is authorized meanwhile.

### 2026-07-14 explicit `migrate-pi` CLI transaction follow-up — `pi-schema-migration/root`

Status: `in_progress` under a fresh bounded lease from `pi-runtime-architect/root`. This is
source/test work only; no installed project, run registry, process, profile tree, or live state is
authorized for migration by this lease. The adversarial migration security hold immediately above
remains an independent overall-publication gate and is not weakened by wiring its future caller.

Exact shared-symbol lease:

- `crates/koni-cli/src/main.rs`: Koni imports for the released migration/run-archive APIs;
  `Command::MigratePi`; its one match arm; new private plan/apply output/helper symbols; focused
  parser/transaction tests only. Existing `Command::Migrate` remains the configured profile action.
- `crates/koni-core/src/engine.rs`: new `PiMigrationRun*` data types; exact
  `Engine::inspect_pi_migration_runs` / `Engine::archive_pi_migration_runs` methods; private
  schema-1 snapshot/process inspection and archive-receipt helpers; focused tests only. No existing
  graph, expression, rule, operation, proof, review, broker execution, deletion, or lifecycle
  semantics are leased.
- `crates/koni-core/src/state.rs`: exact read-only
  `ProjectRegistryStore::inspect_existing` method and one focused no-create test only.
- `crates/koni-core/src/lib.rs`: narrow exports of the new run-migration plan/result types.
- `schema2_migration.rs`, `config.rs`, CLI install/init/templates, product docs, profiles, runtime
  host/broker, TUI, installed configuration, and live state are not leased in this slice.

Locked transaction contract:

- `migrate-pi` requires exactly one explicit `--dry-run` or `--apply`. Dry-run performs no
  registry/config writes and prints both the hash-pinned config migration plan and run disposition.
- Apply revalidates the exact dry inspection under all affected run authority barriers, refuses
  every verified live owned process, identity conflict, or durable startup boundary, then archives
  every nonterminal schema-1/Codex-backed run. Each archive is a durable, idempotent receipt with
  the fixed migration reason and `resume_allowed: false`; the registry transitions to `stopped`,
  historical run bytes remain, and retry never resumes an archived Codex session.
- Only after the archive result proves zero remaining nonterminal Codex runs does CLI call
  `Schema2Migrator::apply`, passing `Archived` or `NoLegacyRuns` as proven and compiling staging via
  `ProfileCompiler::compile_with_project_root(staged, project_root)`. Unrelated `.codex` remains
  governed by the migrator's ownership plan.

#### Security-review expansion — parent-routed release blockers

`primary-integrator/root` has expanded this same owner lane before CLI release. The following exact
`schema2_migration.rs` ranges are now leased in addition to the CLI/run-archive symbols above:

- canonical project/source/destination/backup/staging ancestry validation and associated negative
  fixtures;
- schema-defined persona/manifest transformation functions only, replacing recursive arbitrary
  key/string rewriting, plus semantic-preservation fixtures;
- final source/path identity binding across the pre-publication hook;
- an fsynced migration publication phase journal, deterministic idempotent recovery, injected
  crash-boundary tests, and the narrow plan/result fields required to expose recovery state;
- replacement of caller-constructible legacy-run preconditions with an opaque core-issued proof
  bound to migration ID and exact registry revision/archive receipts.

These security repairs take priority over CLI breadth. Existing historical release text remains;
no new safe-publication claim will be made until the new adversarial tests and prior migration
suite pass on the same source fingerprint.

### 2026-07-14 compile checkpoint and lane release — `pi-schema-migration/root`

Status: implementation paused and the shared-symbol lease above is released at parent request.
No further source edits are authorized from this persona until explicitly reassigned.

Current checkpoint:

- `cargo check -p koni-core --lib` passes on the shared worktree (finished in 1m45s after waiting
  on the workspace Cargo lock). Warnings are unused/dead-code only.
- Run migration preflight/archive types and methods compile, including opaque registry/receipt-bound
  proof issuance and read-only `ProjectRegistryStore::inspect_existing`.
- Schema migration now compiles with path-scoped transforms, source-ancestor checks, post-hook
  source revalidation, and the initial fsynced forward-recovery journal implementation.
- This is only a compiling checkpoint, **not** a security or publication release. Journal crash
  injection/recovery tests, adversarial ancestry/semantic-preservation tests, focused run-archive
  tests, the `migrate-pi` CLI surface, docs, and cleanup remain incomplete. The security hold above
  remains in force.

### 2026-07-14 reassigned completion pass — `pi-schema-migration/root`

Status: `in_progress`, explicitly reassigned by `primary-integrator/root` after the release above.
The bounded lease is schema-2 migration internals/tests, the already-added exact Engine migration
APIs, CLI `migrate-pi`, and this mailbox only. Live projects, installed resources, and live run
state remain out of scope.

Schema-local source/tests staged while the shared Cargo/integration lane is held by the parent:

- every source/output ancestor is covered by adversarial symlink fixtures;
- YAML/TOML conversion touches only schema-defined persona, run-role, and profile-source fields;
  arbitrary metadata, prompt/path literals, and embedded schema keys are preserved;
- legacy `ultra` reasoning maps to Pi `max` only at those schema fields, with the Pi thinking-level
  allowlist enforced;
- publication inputs are inode-bound across the post-validation hook and journaled recovery;
- injected failures cover Prepared, SourceMoved, each AgentMoved boundary, AgentsMoved,
  DestinationPublished, and Complete, followed by recovery and a second idempotent retry.

`rustfmt --check` parsing succeeded before formatting. Cargo has intentionally not been invoked
since the parent reported unrelated concurrent initializer failures; engine/CLI work is waiting on
the parent's integration-zone clearance.

### 2026-07-14 18:51 MST current migration security disposition — `primary-integrator/root`

The ancestor checks, schema-scoped conversion, opaque run proof, and initial fsynced journal are
material source remediations; preserve their earlier absence as discovery history and do not ask
another lane to reimplement them. Two publication-authority P1s remain:

1. `publication-journal.json` is model-writable, protected only by a recomputable digest over public
   fields, and recovery accepts its embedded retirement plan without re-running resource-plan
   derivation or the compiler callback. Move authenticated recovery state under compiler-owned
   storage, rederive every destructive path, and prove a forged journal cannot retire source or
   `.git` sentinels.
2. Component inspection/hash and run-proof verification occur before later pathname renames and
   without a publication-spanning run barrier. Bind identity through no-follow directory handles
   and handle-relative rename (or an equivalent race-free primitive), and hold/revalidate run
   authority through commit. Add a synchronized post-check ancestor/leaf swap and a run appearing
   after the final discrete proof check.

The existing eight named tests do not evidence these new boundaries. Keep the lane unreleased
until forged-journal, race, crash-recovery, semantic-preservation, archival, and prior migration
tests pass on the same source fingerprint.

### 2026-07-14 publication-authority P1 remediation — `pi-schema-migration/root`

Status: `verification_in_progress`; the 18:51 security hold above remains visible as discovery
history and is not silently overwritten.

Current implementation response:

- The fixed recovery journal moved from model-writable `.koni-migrations/**` into
  `.git/koni/migrations/schema2-publication.json`. Its fsynced atomic generations remain
  corruption-detecting, but recovery no longer treats the embedded plan/digest as authority:
  config and ownership bytes are reread from the one live-or-backup location, every owned path is
  rederived from the schema-1 ownership manifest, agent resources are reparsed from their exact
  live-or-retired inode, and the complete path/hash/conversion plan must equal the journal before
  any recovery rename. Every recovery and completed retry also reruns the real staged/published
  profile compiler callback.
- Publication renames now use already-open no-follow source/destination parent descriptors and
  `renameat`. The exact source inode is opened before the concurrency hook, rechecked by name
  immediately before rename, and checked at the destination afterward; parent-path substitution
  cannot redirect the operation and same-byte leaf substitution fails closed.
- Engine archival transfers the migration lock, every affected Codex run-authority barrier, and
  the project-registry publication lock into the non-serializable opaque proof. The proof remains
  alive until `Schema2Migrator::apply` returns. A queued schema-1 registration waits at the same
  registry inode; once schema 2 commits, registration revalidates its immutable snapshot and
  rejects legacy `.codex/koni` bytes instead of appearing after the fence opens.

Current verification on this source:

- `cargo check -p koni-core --lib` — pass.
- `cargo test -p koni-core --lib schema2_migration::tests -- --nocapture` — **14 passed**.
  This includes the prior 12 tests plus an integrity-valid forged-journal `.git` sentinel attack
  and synchronized post-check leaf/ancestor swaps.
- The focused Engine archive target is temporarily compile-blocked by concurrent, non-migration
  test initializers missing newly added `AgentProcessRequest.direct_pi` and
  `AgentBrokerInFlight.write_intent` fields. The new queued-registration regression is present but
  this lane will not claim the P1 released until it executes after those owner ranges compile.
- `crates/koni-cli/src/main.rs` is released for non-overlapping auth/model additions. This lane's
  remaining owned CLI ranges are only `MigratePi`, its imports/match/helper/output, and the two
  `migrate_pi_*` tests.

### 2026-07-14 final security-save-point migration correction — `primary-integrator/root`

Current source now stores the journal under compiler-owned Git-common state, rederives the complete
legacy/resource plan and reruns profile compilation during recovery, and carries migration/
registry/per-run guards through `Schema2Migrator::apply`. Preserve the forged-journal and dropped-
barrier findings above as repair history; classify them source-addressed/test-pending and retain
their adversarial cases.

One definite publication defect remains: verified inode/hash identity is followed by pathname
`rename`, so a synchronized ancestor/leaf swap can move the wrong source before post-move
detection. Use no-follow descriptor-relative rename (or equivalent race-free publication), then
run the forged-plan, source/`.git` sentinel, late-run, crash, semantic-preservation, and synchronized
swap matrix on one fingerprint.

### 2026-07-14 19:40 MST moving-source compile red — `compiler-graph-tdd/root`

A focused Software preparation regression is currently blocked before test execution by six
schema-2 compile errors outside the compiler review lease: missing `PUBLICATION_JOURNAL`, missing
`validate_recovery_plan_derivation` and `recovery_compiled_root`, absent `Debug + Clone` on
`Schema2RunDispositionProof`, and an Engine call to `Schema2RunDispositionProof::issue` missing its
new fifth `Schema2PublicationAuthority` argument. The last call is near `engine.rs:3500`; the
schema-local errors are near `schema2_migration.rs:606-607, 141, 1552` on this moving snapshot.
Please restore one compiling checkpoint and append its fingerprint; no schema-2 bytes were changed
by the compiler lane.

### 2026-07-14 final publication-authority release — `pi-schema-migration/root`

Status: `released`. The two P1s recorded above are closed on the current shared source; the older
hold entries remain intentionally preserved as discovery and repair history.

- Recovery authority is compiler-owned and independently rederived. A journal with a recomputed
  public digest cannot add a retirement target: the forged-plan regression attempts to retire a
  `.git` sentinel and fails before mutating the source or sentinel.
- Publication is descriptor-relative on Unix. It opens the exact source object and no-follow
  source/destination parent descriptors before the concurrency boundary, rechecks the source
  inode, calls `renameat`, fsyncs the open parent descriptors, and verifies the destination inode.
  The synchronized same-byte leaf swap is rejected; the synchronized ancestor swap stays bound
  to the already-open parent instead of redirecting publication.
- The opaque proof owns the migration lock, all affected Codex run barriers, and the project
  registry barrier until `Schema2Migrator::apply` commits or returns. A registration queued after
  proof issuance waits on that barrier and, after schema-2 publication, rejects its immutable
  legacy snapshot instead of introducing a late Codex-backed run.

Final focused verification on the same working-tree checkpoint:

- `cargo test -p koni-core --lib schema2_migration::tests -- --nocapture` — **14 passed**.
- `cargo test -p koni-core --lib pi_migration_run_archive -- --nocapture` — **3 passed**.
- `cargo test -p koni-cli migrate_pi -- --nocapture` — **2 passed**.
- `cargo check -p koni-core --tests` — pass.
- `cargo check -p koni-cli --tests` — pass.
- `rustfmt --edition 2024 --check crates/koni-core/src/schema2_migration.rs` — pass.
- Scoped `git diff --check` for the schema migration and this ledger — pass.

Repository-wide `cargo fmt --all -- --check` is not claimed: it currently reports formatting
diffs in concurrently owned files including `agent.rs`, `engine.rs`, and
`runtime_containment.rs`. No bulk formatting was applied to those shared ranges.

Verification refresh after concurrent owners settled their broker/TUI compile edits:

- `cargo test -p koni-core --lib migration -- --nocapture` — **18 passed** (the 14 schema
  migration cases, 3 Engine archive/proof cases, and 1 legacy-catalog migration case).
- `cargo test -p koni-cli migrate_pi -- --nocapture` — **2 passed**.
- Relevant Git object fingerprints at handoff, in order `schema2_migration.rs`, `engine.rs`,
  `state.rs`, `lib.rs`, `main.rs`: `a230dc1a`, `95b1fe6e`, `9155ac88`, `ad543d89`,
  `d861c875`.

### 2026-07-14 20:57 MST — Software initializer consumer fixture (`software-default-design/root`)

The migration release above is accepted unchanged. A current initializer test still created its
“existing install” through the legacy schema-1 helper, so the product correctly refused a requested
profile replacement in favor of migration. The Software owner changed only that test fixture to
use the released schema-2 fresh-install helper. All six profile-selection/catalog/prompt exact cases
now pass with stable current `main.rs` and `templates.rs` hashes. No `MigratePi`, migration helper,
publication, or schema-conversion range was modified.

### 2026-07-14 21:00 MST — complete CLI consumer closure (`software-default-design/root`)

The first broad CLI follow-up reached 65/66 and exposed the same historical-fixture pattern in the
idempotent-init case. That fixture now also uses the released schema-2 fresh-install helper. Its
exact case passes, followed by the complete CLI binary **66/66** on unchanged current `main.rs` and
`templates.rs` hashes. This remains a test-fixture-only consumer correction; no migration-owned
source range or policy was changed.

### 2026-07-14 21:09 MST — shipped-skill schema-2 consumer alignment (`software-default-design/root`)

Final Software integration review found that the installed customization and operation skills still
treated `.codex/koni` as the sole live root after fresh init began publishing `.koni`. The Software
owner updated only shared skill guidance and its installed/template assertions: schema 2 now uses
`.koni`, provider-neutral YAML agents, and current persona fields; schema 1 remains an explicit
legacy-only branch. All skill validators and the complete CLI 66/66 pass. No migration publication,
recovery, archive, or authority implementation was changed.
