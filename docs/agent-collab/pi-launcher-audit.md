# Pi launcher / packaging audit

Owner: `pi_release_audit/pi_launcher_audit`

Status: `active — read-only except this mailbox`

## 2026-07-16 lease

This lane audits the launcher, source installer, package registrar, exact-archive smoke, and
release workflow. It does not edit product source, manifests, workflows, context construction,
credentials, Pi state, installed binaries, live projects, processes, or terminal panes. The
concurrent context-building experiment is explicitly outside this lease. Findings are routed to
`pi_release_audit/root`; coherent concurrent edits are preserved.

## 2026-07-16 22:11 MST — exact evidence checkpoint

### Open: duplicate Core is renamed, not failed closed

- Current Core only registers `koni` and a shutdown disposer
  (`packages/core/src/extension.ts:45-97`). It has no `session_start` duplicate-origin guard.
- Exact Pi 0.80.10 counts duplicate command names and deliberately exposes them as suffixed
  invocation names (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:371-411`).
  The public extension API can inspect the resolved command inventory with `pi.getCommands()`
  (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:839-923`), and an
  event context can request shutdown (`:1160-1170`).
- Disposable reproduction: load the built Core extension plus a second extension whose default
  export re-exports that same Core factory, start stock Pi 0.80.10 in RPC mode, and send
  `{"id":"commands","type":"get_commands"}`. The response command names are exactly
  `["koni:1","koni:2"]`; plain `koni` is absent and both suffixed handlers remain invokable. No
  remediation is emitted.
- This contradicts the user-facing claim at `README.md:101-104`. A current Core can detect any
  `koni:<positive integer>` entry during `session_start`, show exact `pi list` / `pi remove`
  guidance, then call `ctx.shutdown()`. Checking only an extension-local singleton cannot catch a
  legacy Core loaded beside the new one.

### Open: registrar activation is not one settings transaction

- `activate()` snapshots settings under one released lock (`scripts/register-dev-packages.mjs:62-65`),
  publishes a journal (`:67-77`), then loads and flushes a `SettingsManager` under later lock
  acquisitions (`:78-83`). `AtomicGlobalSettingsStorage.withLock()` releases after each callback
  (`:154-180`), and `snapshot()` is a distinct acquisition (`:183-191`).
- Pi's exact `SettingsManager` reloads the current file during its eventual persist, but treats the
  entire `packages` field as the modified value and replaces that field
  (`node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js:361-395`). Thus a
  concurrent `pi install/remove` package edit between registrar load and flush is lost.
- Deterministic interleaving: start with packages `[ambient, old-koni-A]`; Koni snapshots A and
  releases the lock; concurrent Pi changes the Koni source to B; activation publishes the new
  development roots; rollback sees a changed file and reconstructs packages with the journal's A
  (`scripts/register-dev-packages.mjs:86-110`). B is discarded and stale A is resurrected.
- Rollback also reconstructs JSON rather than restoring authenticated old bytes/absence when no
  concurrent edit occurred (`:102-110`), so an originally absent settings file becomes materialized
  and formatting/order can change. The transaction needs one lock across old snapshot, journal
  publication, and settings publication; the journal should bind the activated post-hash/Koni set.
  Rollback can restore exact old bytes when the post-hash still matches, merge only unrelated later
  edits, and fail closed on a changed Koni set.

### Open: activation journal copies the complete settings file, including legacy secrets

- The journal embeds `previousSettings` wholesale as `previous_settings`
  (`scripts/register-dev-packages.mjs:63-77`); `snapshotFileSync()` stores every settings byte in
  base64 (`:249-261`). This disagrees with the installer comment that the journal stores “only
  Koni-owned package entries” (`scripts/install-dev.sh:166-168`). Mode `0600` limits access but does
  not make this a credential-free copy.
- A never-migrated Pi settings file can contain legacy `apiKeys`; Pi 0.80.10 explicitly reads those
  values and moves them to `auth.json`
  (`node_modules/@earendil-works/pi-coding-agent/dist/migrations.js:12-64`). The installer first
  calls `pi --version` (`scripts/install-dev.sh:30-33`), but exact Pi returns for `--version` before
  `runMigrations()` (`node_modules/@earendil-works/pi-coding-agent/dist/main.js:403-405,432-435`).
  Therefore the registrar can copy real legacy keys into `$prefix/share/koni/activation-journal.json`.
- Prefer a journal containing only authenticated old/new Koni package entries plus settings hashes,
  or explicitly reject/redact legacy credential-bearing settings before publication. Do not claim
  Koni never copies credentials while the full-file snapshot remains.

### Open: exact-archive smoke does not traverse a Koni-owned attempt process

- The packed smoke starts a real authority (`scripts/pi-package-smoke.test.mjs:142-148`), but then
  constructs and aborts an independent stock-Pi session (`:150-158`). That helper uses an isolated
  auth path, an in-memory session manager, and `noTools: "all"` (`:521-561`); it is not admitted by
  Koni's run engine.
- The production path durably prepares a launch spec and attempt, then invokes the process
  supervisor (`packages/core/src/authority/run-engine.ts:2075-2184,2190-2210`). The process child
  constructs `ManagedPiSession` and reports ready/outcome
  (`packages/core/src/pi/attempt-process-child.ts:32-84`). None of these symbols or launch identities
  appears in `scripts/pi-package-smoke.test.mjs`.
- Existing process tests replace the production child with
  `test/fixtures/pi-attempt-process-fixture.mjs`
  (`packages/core/test/pi-attempt-process.test.ts:21,253-305`). They prove supervision mechanics,
  not that the packed closure can launch the real child with its Pi peer bridge/runtime pin.
- Release evidence still needs a provider-free packed admission that crosses the authority, durable
  launch spec, real `attempt-process-entry`, runtime pin, transcript creation, cancellation, and
  process-group shutdown. An initialization-and-immediate-abort probe is sufficient only if it uses
  that identical production path and cannot become a public authority bypass.

### Open: upgrade/PATH guidance can select or update the wrong installation

- Upgrade docs still use `pi update --extensions`, which updates unrelated community packages
  (`README.md:91-99`; `docs/getting-started.md:88-92`). They also omit closing/reloading already-open
  Pi sessions, whose loaded Core JavaScript remains old after package bytes change. Guidance should
  target the exact installed Koni sources and require `/reload` or a Pi restart before using Koni.
- The source installer only checks whether `$prefix/bin` occurs anywhere in `PATH`
  (`scripts/install-dev.sh:185-193`). If Pi's managed `.bin/koni` occurs earlier, installation
  succeeds but `koni` still invokes the older managed copy. Verify `command -v koni` resolves to
  `$prefix/bin/koni`, and report the shadowing path plus prepend instructions when it does not.
- The launcher treats the first existing `pi` path as active without checking regular-file and
  executable status (`packages/core/bin/koni.js:43-55`). On POSIX, a non-executable file/directory
  named `pi` is skipped by the shell but currently causes Koni's opaque-wrapper failure instead of
  selecting the same executable the shell selects. Use the platform-equivalent executable check
  before declaring the first PATH candidate active.

### Lower-priority release atomicity

- Publishing iterates a lexically sorted archive glob (`.github/workflows/release.yml:182-187`),
  which currently publishes Coding, then Core, then Research. If the final publish fails, public
  Core can reference a release set that is not fully present. Resolve archives by manifest identity,
  publish both profiles first, and publish Core last. Existing immutable-integrity retry handling is
  otherwise sound (`:163-180`).

### Confirmed closed in current tree

- The exact-archive smoke now seeds a mode-`0600` Pi `auth.json` sentinel before package installation
  (`scripts/pi-package-smoke.test.mjs:298-320`), snapshots its bytes/mode (`:609-617`), and asserts
  exact preservation after install and Koni operations (`:620-633`). The provider-free AgentSession
  deliberately uses a separate empty auth path (`:540-544`), so the sentinel is never interpreted,
  refreshed, or sent to a provider. This closes the prior credential-sentinel test gap, but not the
  full-settings journal copy above.

## 2026-07-16 22:14 MST — concurrent duplicate-guard transition

The first bullet in “duplicate Core” above was superseded while this audit was running. Current
`packages/core/src/extension.ts:41-173` now implements a `koni.core.discover.v1` /
`koni.core.available.v1` event-bus singleton protocol and checks it when a suffixed Koni command is
invoked (`:99-115`). That improves duplicate detection when **both** loaded Core copies implement
the new protocol, but it does not close the release blocker:

- A legacy Core neither subscribes to `koni.core.discover.v1` nor emits
  `koni.core.available.v1`. The new instance therefore records no conflict (`:132-150`).
- In the legacy-plus-new scenario Pi still resolves the commands as `koni:1` / `koni:2`; the old
  handler remains usable, and the new handler's `assertSingle()` also succeeds because the old Core
  is invisible to the custom bus.
- The exact Pi command inventory is the compatibility bridge across versions. The new Core should
  additionally inspect `pi.getCommands()` after command registration/session start for any
  `koni:<integer>` entry, report each command's `sourceInfo` origin, and shut the session down. Keep
  the event protocol as a useful same-generation diagnostic, not as the sole fail-closed boundary.

No product files were changed by this audit.

## 2026-07-16 22:16 MST — registrar evaluation-order blocker

- Module-level dispatch invokes `activate()` at `scripts/register-dev-packages.mjs:44-49` while the
  module is still evaluating.
- `activate()` calls `createAtomicSettingsStorage()` (`:62`), which constructs
  `AtomicGlobalSettingsStorage` (`:144-145`). The class declaration is later at `:148` and has not
  initialized yet.
- Exact archive smoke reached this path and failed with
  `ReferenceError: Cannot access 'AtomicGlobalSettingsStorage' before initialization`. This occurs
  before activation can work at all, regardless of lock/concurrency behavior. Defer command
  dispatch through a `main()` invoked after declarations (or move the class before dispatch), then
  rerun the exact registrar activation/rollback fixtures.

## 2026-07-16 22:24 MST — final launcher/packaging transition

This final read-only freshness sweep supersedes several open findings above without erasing their
history. No product source was changed by this audit.

### Closed in the current composed tree

- Duplicate Core detection is now fail-closed in source. At `session_start`, Core inspects Pi's
  complete command inventory, recognizes both `koni` and Pi-renamed `koni:<n>` commands (including
  guard-unaware legacy copies), reports exact scope-correct source removal, and shuts the Pi
  session down before Koni work can begin (`packages/core/src/extension.ts:116-124,185-213`). The
  focused legacy/current unit regression passes **11/11**, and Core strict typechecking passes.
- Registrar module dispatch now occurs after declarations (`scripts/register-dev-packages.mjs:545+`),
  eliminating the temporal-dead-zone failure. Activation snapshots, atomically journals, and
  publishes settings under one logical Pi settings lock; rollback and commit keep phase checks,
  launcher restoration/validation, and journal retirement under that transaction
  (`:44-149,157-245`). The journal stores only file identity and Koni-owned package entries, never
  full settings bytes or legacy keys. Disposable activation/rollback and a legacy-api-key sentinel
  probe both passed; rollback preserved the original settings semantics and mode.
- The transient `proper-lockfile.lockSync(..., { retries })` `ESYNC` failure is closed: async
  transactions use `lock()` retry options and synchronous callbacks perform bounded manual
  `ELOCKED` retry (`scripts/register-dev-packages.mjs:187-210`).
- PATH discovery now selects the first runnable regular Pi executable, skips a non-executable
  decoy, and still fails closed on the first executable opaque wrapper
  (`packages/core/bin/koni.js:43-79`). The exact package smoke contains both fixtures
  (`scripts/pi-package-smoke.test.mjs:168-229`). The source installer also verifies that
  `command -v koni` resolves to its installed launcher and reports shadowing with prepend guidance
  (`scripts/install-dev.sh:185-195`).
- Release publication resolves archives by manifest identity and publishes both profiles before
  Core; immutable retry integrity remains enforced (`.github/workflows/release.yml:182-215`).
- Upgrade guidance now targets only Koni-owned Pi sources, requires Pi reload/reopen, and leaves
  stopped runs paused for explicit resume (`README.md:91-109`; `docs/getting-started.md:88-97`).
- The packed smoke seeds a mode-`0600` Pi `auth.json` sentinel and asserts byte- and mode-exact
  preservation after installation and operator activity
  (`scripts/pi-package-smoke.test.mjs:616-633`).

### Remaining release blockers / evidence gaps

1. **The exact packed Koni attempt path is still unproven.** The smoke starts an authority, then
   constructs an independent stock-Pi in-memory `AgentSession` with `noTools: "all"`
   (`scripts/pi-package-smoke.test.mjs:142-158,528-568`). It never crosses Koni's durable launch
   spec, production attempt-process entry, runtime pin, transcript, cancellation, or process-group
   shutdown path. Release evidence needs one provider-free admission through that exact public
   authority/supervisor boundary.
2. **The packed legacy-plus-current duplicate-Core regression is still absent.** Source behavior
   and focused tests are correct, but the exact archive smoke does not load current packed Core
   alongside a no-event legacy Core fixture and prove notification, scope-correct remediation,
   shutdown, and zero handler/authority work. README correctly marks this packed guard pending
   (`README.md:111-114`).
3. **Registrar crash and concurrency seams lack release automation.** The implementation exposes
   `KONI_TEST_PAUSE_AFTER_JOURNAL_MS`, `KONI_TEST_CRASH_AFTER_FSYNC`, and rollback-phase crash seams
   (`scripts/register-dev-packages.mjs:410-449`), but the exact package smoke does not invoke them.
   Add deterministic fixtures for a concurrent Pi package writer, SIGKILL after journal/settings
   fsync and after settings rollback, restart recovery, and a legacy `settings.apiKeys` sentinel
   proving that neither raw nor encoded credentials enter the journal. Manual non-crash activation,
   rollback, and credential-sentinel probes passed; this is an automated release-evidence gap.
4. **Current source-install documentation still advertises the retired Rust path.**
   `docs/getting-started.md:99-106` tells users to run `cargo install --path crates/koni-cli`, while
   the current Pi-native source install is `./scripts/install-dev.sh`. Preserve the historical text
   and add an adjacent dated correction, per the documentation transition convention.

### Verification performed after the final file changes

- `node --check scripts/register-dev-packages.mjs`
- `node --check scripts/pi-package-smoke.test.mjs`
- `bash -n scripts/install-dev.sh`
- scoped `git diff --check` — clean
- `npm test --workspace @koni/core -- --run test/operator-surface.test.ts` — **11/11**
- `npm run typecheck --workspace @koni/core` — passed
- disposable registrar activation/rollback — passed
- legacy settings secret/no-journal-copy sentinel probe — passed

The full network/build-heavy exact-archive smoke was not rerun during this read-only handoff; CI
must still execute it after the remaining acceptance fixtures are added.

## 2026-07-16 22:36 MST — final release-boundary re-audit

This read-only pass intentionally excluded compiler context/prompt/resource/compaction work and
did not modify product source or live state. It re-read the current package manifests, launcher,
registrar, exact package smoke, installer, current-facing installation docs, CI, and tag-release
workflow after their latest concurrent changes.

### Prior packaging blockers now closed

- The exact archive smoke now admits a provider-free run through the packed production authority,
  durable launch spec, real attempt-process child, Pi session JSONL/mapping, transcript projection,
  pause/abort, delete, and zero-token boundary
  (`scripts/pi-package-smoke.test.mjs:192-198,756-907`). This supersedes remaining blocker 1 in the
  preceding transition.
- The same exact archive smoke loads packed current Core with a guard-unaware project-local legacy
  Core, asserts source/scope-correct remediation and session shutdown, proves the legacy handler did
  not run, and byte-preserves project/global Pi state (`:997-1044`). This supersedes blocker 2.
- Registrar release fixtures now cover killed journal and settings publication, killed rollback
  phase recovery, concurrent Pi settings locking, exact Koni-set CAS, malformed/unwritable state,
  prior launcher shapes, an absent prior settings file, legacy `settings.apiKeys` non-copy, and Pi
  auth byte/mode preservation (`:418-750`). This supersedes blocker 3.
- `docs/getting-started.md:108-112` now retains the Cargo text as history while explicitly directing
  current source installs to `./scripts/install-dev.sh`. This supersedes blocker 4.
- POSIX non-executable PATH selection, scope-correct duplicate detection, profile-first/Core-last
  publication, upgrade/reload guidance, and credential preservation remain present.

### Concrete tag-release blocker still open

- `.github/workflows/release.yml:51-54` validates each Pi component at
  `package-lock.packages["node_modules/<package>"]`. In the committed npm v3 lock layout, only
  `@earendil-works/pi-coding-agent` is at that root key. Its shrinkwrapped `pi-agent-core`, `pi-ai`,
  and `pi-tui` entries live below
  `node_modules/@earendil-works/pi-coding-agent/node_modules/<package>`
  (`package-lock.json:26-61,525-577`). Running the workflow's exact assertion fails with
  `@earendil-works/pi-agent-core: undefined` before packaging. Validate the actual installed/pinned
  Pi closure (or these exact nested lock entries) rather than assuming npm hoisting. This tag-only
  assertion is not exercised by root `npm run check`.

### Transient CI blocker found and already closed

- The brand gate initially failed on an intentionally historical old-repository path in
  `docs/agent-collab/cockpit-final-review.md:32`. Current `scripts/check-brand.sh:4-50` now narrowly
  excludes append-only collaboration history while continuing to scan every shipped/current-facing
  surface. `./scripts/check-brand.sh` passes, so this is no longer open.

### Verification

- Workflow files parse as YAML.
- Registrar/package-smoke JavaScript syntax, installer/report shell syntax, and scoped
  `git diff --check` pass.
- Lightweight shipping-manifest/PATH handoff test passes **1/1**.
- `./scripts/check-brand.sh` passes after the collaboration-history scope correction.
- Lock inspection confirms Pi coding agent `0.80.10`, its three nested Pi packages `0.80.10`, and
  both relevant TypeBox entries `1.1.38`; only the workflow lookup path is wrong.

No further concrete release/package/docs/CI blockers were found outside the externally owned
context coherence checkpoint, the tag-workflow lock assertion above, and the required final
immutable composed build/package-smoke/parity execution.
