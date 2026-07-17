# Pi/TypeScript release audit

Owner: `pi_release_audit/root`

Status: `active — read-only release audit`

## 2026-07-16 lease

This lane independently audits the pure Pi/TypeScript release boundary only:

- the three public package topology (`@koni/core`, `@koni/coding-profile`, and
  `@koni/research-profile`);
- stock-Pi package discovery and the shared `koni` CLI/TUI package payload;
- preservation of Pi credentials/settings and project-owned profile overlays;
- absence of shipped Rust binaries, native addons, and `runtime/pi-host` payloads or runtime
  dependencies;
- install/update safety and CI/release fail-closed gates.

This lane is read-only except for this mailbox. It will not edit product source, package
manifests, workflows, proofs/captures, context/resource assembly, live projects, Pi state,
credentials, installed binaries, processes, or terminal panes. The concurrent context-building
experiment is explicitly outside this lease. Existing coherent shared-tree changes are preserved.

## Coordination

The active Core/profile/operator/parity/resource leases were reviewed before the audit. Concrete
release blockers will be reported here with exact file/test evidence and routed to
`pi-native-port/root`; no speculative cleanup or preference-only finding will be raised.

## Findings

### Verified green boundaries

- The repository exposes exactly three public workspace packages: `@koni/core`,
  `@koni/coding-profile`, and `@koni/research-profile`. Current dry-run inventories ship the
  compiled Core/CLI/extension/three shared Pi skills or the corresponding profile bundle; no
  `crates/`, `runtime/pi-host`, native addon, or WebAssembly payload is present.
- Stock Pi 0.80.10 discovers `/koni`, `skill:configure-koni`, `skill:model-koni-work`, and
  `skill:operate-koni`. In an isolated Pi home it initialized and validated a Coding project
  without a provider call and without changing the post-install Pi settings/credential snapshot.
- An independent disposable managed-npm installation of the three packed archives was also
  discovered by stock Pi under Pi's real `--legacy-peer-deps` package-manager semantics.
- Profile install/update, conflict resolution, package authentication, and operator-source tests
  are **28/28**. Coding package tests are **2/2**, Research package tests are **4/4**, Core strict
  TypeScript is green, and whitespace verification is clean at this checkpoint.
- Profile materialization now publishes only from the immutable verified cache. Differing duplicate
  Pi profile announcements fail closed, while installed sibling packages are resolved and verified
  directly before ambient announcements are considered.
- Executable parity is frozen green by its owning lane: release ledger **24/24 cases**, **65/65
  assertions**, zero blockers; proof SHA
  `1781f13f0ff1c772fbfa4bb8eadd38b22fd9ac3b5f45c0ec8dd03941cbcf9359`; full-capture file SHA
  `a207fc6b99a23149f6dfda27a8e85d371c6d14e250fe6056486d894286caa8e7`; canonical capture SHA
  `fa8a2cf061e95c12bd161e8c415e5c7347b5a572e52b0959e4a439d79dfd458d`.
- The release workflow now publishes the exact attested tarballs and refuses an already-published
  immutable version unless the registry SRI exactly equals the local archive. The three intended
  public versions currently return npm `E404`, so there is no payload collision at audit time;
  scoped-package ownership and trusted-publisher configuration remain external release
  prerequisites.

### Open release blockers handed to `pi-native-port/root`

1. **Running-authority/runtime byte drift.** The current authority accepts but ignores
   `clientVersion`, the client does not authenticate the server's ready version, and an old daemon
   resolves a future attempt child from its mutable installed Core path. Updating an npm/Pi package
   can therefore make an old authority launch newly replaced Core/Pi bytes. A version-only check is
   insufficient for a same-version development refresh. The server/client handshake and every
   launched child must bind a compatible Core build identity and an immutable complete executable
   closure, not only the child entry file. Restart/recovery behavior must preserve existing runs.
2. **Standalone npm runtime resolution is nondeterministic and contradicts the documented
   single-runtime claim.** A disposable execution of the documented global install pulled a second
   Pi SDK closure and gave Core `typebox@1.3.6`, while Koni is tested against exact Pi `0.80.10` and
   `typebox@1.1.38`. Shipping `"*"` peers are correct for Pi-managed packages, but ordinary npm
   auto-resolves those peers independently. Once a newer Pi is latest, installation can appear
   successful and fail only at the exact-version check on the first autonomous attempt. The stable
   `koni tui` command needs a deliberate, tested standalone-runtime strategy and a packaged
   agent-session smoke, or it must route through the operator's actual Pi runtime.
3. **Profile publication versus new-run compilation.** Profile/config mutations serialize with
   `.koni/.managed/profile-lifecycle.lock`, but `compileProjectDirectory()` does not authenticate
   lock/transaction absence. `FileTransactionStore.commit()` publishes multiple files one by one
   and writes install provenance near the end. A concurrent `run.create` can take two stable
   snapshots inside that interval and compile the mixed old/new bytes as an allowed project
   overlay under unchanged old provenance. Existing pinned runs are unaffected. New-run/control
   catalog compilation must fail closed across an active or crash-pending lifecycle transaction,
   with a race regression. This audit does not edit that compiler/context area.
4. **Packed Pi discovery is not yet an automated gate.** The checked-in stock-Pi smoke loads
   workspace directories; the release smoke globally installs tarballs but does not ask stock Pi
   to discover and exercise those packed artifacts under Pi's real managed-npm peer behavior. The
   manually verified path should become a provider-free CI/release test over the exact tarballs.

Historical docs now carry adjacent dated corrections for removed Rust-era commands and Git-root
behavior, and shipped skills no longer instruct agents to invoke removed commands except in
explicitly labeled historical/no-such-command notes. Final packed-byte verification will be rerun
after the blockers above and concurrent context work have settled.

## 2026-07-16 late packaging/runtime audit

- The standalone peer-closure blocker is resolved in the current manifests: every Pi/TypeBox peer
  is an optional host peer. An isolated packed global install now contains zero nested Pi peers and
  is about 6.9 MB rather than the previous 669 MB/three duplicated SDK closures. The exact-archive
  release gate now goes through disposable stock Pi and asserts the absence of both top-level and
  nested Pi/TypeBox copies.
- The first development registrar revision incorrectly read merged project/global packages and
  wrote them globally, and Pi's `SettingsManager` silently queued malformed-settings errors. The
  current registrar is corrected and independently rechecked: it reads and atomically updates only
  global package settings from a guaranteed non-project directory, drains errors before and after
  the write, retains ambient global packages, does not leak project-local packages, and rejects
  malformed/unwritable settings without changing them.
- Exact Core build identity is now authenticated in the authority handshake. The authority captures
  a content identity for Core, its `bin` loader, the resolved Pi/TypeBox/dependency closure, Node,
  platform, and architecture; persists a content-authenticated pin; rechecks the closure before
  durable launch and immediately before spawn; and makes the child validate the pin before its
  dynamic Pi/session import. Final focused and packed-process evidence remains to be rerun after the
  in-flight integration settles.

### Current follow-up findings

1. `packages/core/bin/koni.js` still assumes a PATH Pi executable is a filesystem symlink or is
   owned by the current npm global root. A valid regular-file wrapper that executes Pi 0.80.10 is
   rejected, which also leaves Windows npm/pnpm `.cmd` shims, pnpm/bun wrappers, and custom prefixes
   unsupported. The explicit `KONI_PI_PACKAGE_ROOT` escape hatch also misclassifies a valid package
   directory whose name has an extension because it uses `path.extname` rather than filesystem
   metadata. Packaging owns the fix and cross-manager fixtures.
2. Profile publication/new-run compilation remains the one compiler-area blocker: the stable double
   snapshot still ignores an active lifecycle lock or crash-pending transaction. This lane will not
   edit it because context/compiler work is concurrently owned elsewhere.
3. Development version-root publication still needs confirmation that an interrupted or pre-existing
   bundle path cannot be accepted without re-authenticating its contents before Pi registration and
   launcher switching. The audit owner is testing that path now.

## 2026-07-16 final-integration checkpoint

### Resolved since the late audit

- The profile-publication/new-run race is closed in the current compiler: compilation authenticates
  lifecycle-lock and transaction absence around its stable snapshots, while the guided editor can
  compile only beneath its own authenticated lock context. The prior redundant journal cleanup was
  also removed/fixed. A combined authority, profile, operator, compiler, runtime-identity, and
  contained-attempt run is **59/59 green**.
- Cross-build authority refresh now has an intentionally tiny compatibility surface. A mismatched
  build may call only `authority.quiesce`; quiesce durably pauses pausable runs, aborts contained
  sessions, interrupts running attempts, flushes the successful response, and then requests process
  shutdown. Runs remain paused for explicit operator resume. A server-level quiescing gate rejects
  both RPC and internal mutations already queued behind that transition, with a focused regression.
- The runtime closure now hashes Node, Git, and the platform sandbox executable in addition to the
  Core/Pi package closure. The previous omission of `process.execPath` itself is resolved.
- The packaged release workflow now creates its CycloneDX SBOM from a disposable installation of
  the exact three archives. It asserts the exact five-component shipped closure (three Koni
  packages, `semver`, and `yaml`) and excludes Pi/TypeBox host peers.
- Launcher discovery now validates direct environment/PATH/shim candidates before bounded package-
  manager probes; the prior unconditional synchronous manager latency is resolved.

### Remaining release blockers / acceptance checks

1. **Pinned executable identity is not yet invocation authority.** `runtimeExecutable()` is exported
   but unused. `GitClient` still spawns bare `git` through ambient `PATH`, and Linux containment
   resolves `bwrap` from ambient `PATH` at each effect. Inserting a new earlier PATH executable after
   authority startup can therefore select bytes that were never pinned while all assertions over the
   originally captured executable still pass. The captured absolute paths must be injected into Git
   and sandbox execution, and the closure guard must run immediately before external effects, not
   only before a model attempt launch.
2. **Development installer crash recovery remains incomplete.** The install lock begins only after
   checkout-mutating build/pack work; a real crash leaves a lock that prevents journal recovery.
   Regular-file launcher backup cleanup is also ordered before journal cleanup/rollback, so a crash
   can leave settings reverted to the old source while the launcher still targets the new Core. A
   disposable reproduction confirms this mixed state. Snapshot-before-journal crashes can leave an
   orphan backup that blocks later installs. These crash windows need durable state-machine fixtures.
3. **Active Pi selection must not guess past the first executable.** If the first PATH `pi` is an
   opaque wrapper, the launcher currently scans later PATH entries/managers and can bind a different
   Pi installation. It must fail with explicit `KONI_PI_PACKAGE_ROOT` remediation. The advertised
   compatibility contract must also be made consistent: the launcher accepts `0.80.10-*`, package
   metadata advertises `>=0.80.10 <0.81.0`, and the authority runtime requires exact `0.80.10`.
4. **One installed Core closure must be enforced in practice.** The agreed release design is one
   Pi-managed npm closure, with Pi's managed `.bin/koni` added to PATH; source development analogously
   uses one sealed local closure. Pi 0.80.10 renames duplicate extension commands to `koni:1`,
   `koni:2`, so plain `/koni` disappears if an old global or project-local Core remains. Packed
   migration/smoke coverage must fail closed with exact removal guidance while preserving unrelated
   user/project Pi resources.
5. **The exact packed contained-attempt path still needs proof.** Existing package smoke proves stock
   Pi discovery, daemon start/stop, and a separate provider-free Pi `AgentSession`, but it has not yet
   admitted a real Koni attempt child through the packed authority/supervisor boundary. Release
   evidence must exercise that public path or expose a deliberately provider-free admission seam
   that traverses the same child, pin, transcript, cancellation, and shutdown machinery.
6. **Pi's settings writer is locked but not crash-atomic.** In pinned Pi 0.80.10,
   `FileSettingsStorage.withLock()` acquires `proper-lockfile` and then calls
   `writeFileSync(path, next)` on the live settings file. A kill can leave truncated user settings;
   the next registrar invocation then fails while loading them before it can interpret the Koni
   activation journal. Koni's activation journal is likewise written directly to its final path,
   so a kill can leave partial JSON. The source registrar needs an atomic custom
   `SettingsManager.fromStorage()` backend using Pi's same lock plus temp-file fsync/rename/directory
   fsync, and an atomically published journal. Kill/corruption fixtures must prove exact preservation
   and recovery of unrelated settings and credential bytes.
7. **An old in-memory Pi extension can impersonate newly replaced disk bytes.**
   `AuthorityClient.connect()` recomputes its advertised build by calling
   `captureCoreRuntimeIdentity()` on every connection
   (`packages/core/src/authority/client.ts:71-74`). If Pi loaded Core A, the managed npm closure is
   replaced with B, and that interactive session remains open, its old A JavaScript hashes B from
   disk and can pass the new B authority handshake. The same applies to a still-open standalone
   control-center process after reconnect. The executing identity must be latched from immutable
   generated build metadata/module-load state and coupled to a disk guard; it cannot be derived from
   mutable files at connection time. Add an old-session/in-place-update regression. Upgrade docs
   must quiesce authorities, close or reload interactive Pi sessions, update only the exact Koni
   sources (not `pi update --extensions`, which updates unrelated community packages), start the
   new authority, and leave runs paused for explicit resume.

### Corrections after concurrent fixes

- Remaining item 1 above (ambient Git/sandbox invocation) is resolved in the current authority.
  Core captures the executable closure before endpoint discovery, pins the exact absolute Git
  identity process-wide, passes the exact sandbox identity into the run engine, checks the full
  closure immediately before configured effects, rechecks executable bytes before every spawn,
  and records the sandbox executable digest in evidence. Strict Core TypeScript and the nine-file
  focused authority/runtime/Git/process/profile suite are green (**59/59**).
- The non-atomic version-root/launcher crash windows in remaining items 2 and 3 are resolved: the
  install lock now precedes checkout/build work and can reclaim a well-formed dead-PID owner; the
  launcher journal is deleted before its backup; rollback authenticates a regular-file backup
  before changing settings; pre-journal orphan backups are cleaned; sealed roots are reverified;
  the launcher binds only the first PATH Pi and fails opaque wrappers with explicit environment
  remediation; every compatibility surface now requires exact Pi `0.80.10`. The separate
  non-atomic **Pi settings write / Koni journal publication** finding in remaining item 6 is still
  open and is not superseded by these fixes.

## 2026-07-16 atomic-registrar follow-up

- The direct-write portion of remaining item 6 is resolved: the registrar now uses Pi's
  `proper-lockfile` implementation with a same-directory temporary file, file fsync, rename/link
  publication, and directory fsync for both settings and the activation journal.
- A narrower settings-transaction blocker remains. `activate()` snapshots the old settings beneath
  one Pi lock (`scripts/register-dev-packages.mjs:62-65`), publishes its journal (`:77`), then loads
  and flushes settings beneath later lock acquisitions (`:78-83`). A concurrent Pi install/remove
  of a Koni source in that gap can therefore be replaced while the journal records an older source;
  rollback (`:86-110`) can then resurrect the stale source. The same rollback reconstructs the
  packages list instead of restoring the authenticated old snapshot, so an originally absent file
  remains materialized and prior byte ordering/formatting can change even without concurrency.
  Activation needs one lock spanning snapshot, atomic journal publication, and atomic settings
  publication. The journal should bind the expected post-settings hash and activated Koni set.
  Rollback should restore the prior bytes/absence/mode exactly when the post hash still matches,
  preserve unrelated later edits when the Koni set still matches, and fail closed without deleting
  the journal or launcher when another actor changed Koni entries.
- The first exact package-smoke run against this revision also found an immediate evaluation-order
  failure: top-level dispatch invokes `activate()` at lines 44-53 before the
  `AtomicGlobalSettingsStorage` class at line 148 has initialized. The public registrar exits with
  `ReferenceError: Cannot access 'AtomicGlobalSettingsStorage' before initialization` from line
  145, so source activation is currently unusable until dispatch is deferred until after module
  declarations.
- The proposed exact-snapshot journal itself crosses a credential boundary. It serializes the
  entire prior Pi settings file as base64 at lines 63-77/249-261, although Pi 0.80.10 may still
  contain legacy `settings.apiKeys`: `pi --version` exits before Pi's migrations, and Pi skips the
  legacy-auth migration when `auth.json` already exists. Koni must not create a second credential
  copy beneath its install prefix. The journal should retain only the prior Koni package entries,
  prior file digest/mode/absence metadata, and expected activated Koni state; settings/auth bytes
  stay exclusively in Pi's files. A sentinel legacy-api-key fixture must prove the journal contains
  neither the key/provider nor its base64 while activation and rollback preserve live Pi state.

### One-lock registrar correction and remaining phase bugs

- The next registrar revision removes raw settings bytes from the journal and places snapshot,
  journal publication, and settings publication beneath one logical Pi lock. That closes the
  earlier credential-copy and pre-publication concurrency defects in design.
- It is not executable yet: `AtomicGlobalSettingsStorage.acquire()` passes `retries` to
  `proper-lockfile.lockSync()` (`scripts/register-dev-packages.mjs:187-194`), which pinned
  proper-lockfile rejects with `ESYNC`. A disposable activation exits before journal/settings
  publication.
- Commit and rollback still need phase-safe CAS. `commit()` reads beneath one lock, releases it,
  then checks the launcher and deletes the journal (`:130-143`); an external Koni-source change in
  that gap can be lost, and an added fourth Koni source passes the current contains-all-roots test.
  Commit must hold the lock through an exact activated-Koni-set check, launcher validation, and
  journal cleanup. `rollback()` restores settings, releases the lock, then restores the launcher
  (`:88-118`). A kill between those actions makes retry observe the prior Koni set and reject it as
  neither the old file digest nor activated set. Retry must recognize the prior Koni set as an
  already-completed settings phase, finish launcher restoration idempotently, and reserve failure
  for a third/conflicting Koni set.

## 2026-07-16 embedded-Core identity re-audit

- The shipped old-session identity boundary is now release-hard. Compilation replaces the one
  normalized marker in `dist/runtime/identity.js` with the pre-embed normalized Core digest and
  re-verifies that embedding did not change the normalized digest. Shipped `dist` fails closed if
  the placeholder remains; ordinary clients advertise the already-loaded embedded identity and
  separately compare all current disk bytes before connecting, while only the one-method quiesce
  compatibility client may operate after replacement. Independent inspection of the current built
  tree found embedded, normalized disk, and executing identities equal at
  `sha256:a1b8447520340187d59dc7bb66fab04a7478e0f9c9f3ff4de644b6ae2121967e`.
  This resolves the original mutable-disk impersonation finding; upgrade instructions must still
  close/reload interactive Pi sessions before using the new Core.

## 2026-07-16 duplicate-origin re-audit

- The first duplicate-Core guard revision is not sufficient for migration. Its private EventBus
  discovery protocol sees only current guard-aware Core builds, not the older Core origin that a
  user is specifically migrating away from. It checks only inside Koni's command handler, although
  Pi 0.80.10 renames duplicate commands to `koni:1`, `koni:2` and allows a legacy renamed handler to
  run. Its remediation also always says `--local`, even for a user-scope source. Pinned Pi exposes
  all renamed commands and their exact `sourceInfo { source, scope, path }` through
  `pi.getCommands()` during `session_start`. The current Core should inspect that inventory,
  notify exact scope-correct `pi remove` commands, and call `ctx.shutdown()` before either origin
  can operate. A packed provider-free regression must combine the new Core with a legacy/no-event
  Core fixture, not merely instantiate two copies of the new guard.

### Duplicate-origin source correction

- Core now performs the required pinned-Pi inventory check at `session_start`: it recognizes
  `koni` and Pi-renamed `koni:<n>` extension commands, includes guard-unaware legacy origins,
  deduplicates exact `sourceInfo` identities, emits user/project/temporary scope-specific
  remediation, and calls `context.shutdown()` before a renamed command can run. The EventBus guard
  remains defense in depth. Strict Core TypeScript plus operator/runtime/server tests are green
  (**23/23**). Only the exact packed new+legacy discovery regression remains a packaging acceptance
  check; the source defect itself is closed.

## 2026-07-16 smaller launcher follow-up

- PATH discovery currently treats the first *existing* `pi` filename as the shell's active Pi
  (`packages/core/bin/koni.js:43-53`). On POSIX a non-executable decoy earlier in PATH is not a shell
  command and should be skipped; the current code instead reports it as an opaque active wrapper.
  The first executable wrapper must remain authoritative and fail closed when opaque.

## 2026-07-16 final packed-boundary correction

- The apparent packed-Core identity mismatch was a stale-build artifact in the concurrently edited
  checkout, not an `npm pack` transformation. A byte inventory found source and extracted archive
  `package.json`, `dist/**`, and `bin/**` identical. Both trees normalize to
  `sha256:ce917497fb8790682a3523b439ed42590d3c89e5d5da1a52720d7b388009be50`; the
  existing compiled marker still records the earlier
  `sha256:a1b8447520340187d59dc7bb66fab04a7478e0f9c9f3ff4de644b6ae2121967e`
  because package/source edits landed after that build. The normal `test:pi-package`, root `check`,
  and release packaging jobs rebuild Core before packing. Do not weaken the runtime identity guard
  for this transient state; rerun exact smoke only after the coordinated final build.
- The latest package smoke now includes the registrar release fixtures previously requested: killed
  journal/settings/rollback publication, overlap with Pi's proper-lock writer, exact Koni-set CAS,
  legacy `settings.apiKeys` non-copy assertions, auth byte/mode preservation, malformed/unwritable
  settings, and launcher rollback shapes. Those registrar test gaps are closed.
- The POSIX non-executable PATH decoy is now skipped and covered by the exact fixture, while an opaque
  first executable remains fail-closed. That smaller launcher finding is closed.
- Remaining release-evidence gaps are (1) an exact packed, provider-free admission through Koni's
  real durable launch-spec -> attempt-process -> transcript/cancel/process-group path, and (2) an
  exact packed current-Core plus guard-unaware legacy-Core duplicate-origin regression. The current
  package smoke's separately constructed raw `AgentSession` and source-level duplicate tests do not
  prove those two production boundaries.
- Documentation follow-up: `docs/getting-started.md` still advertises the retired Cargo source
  installation command; source development should use `./scripts/install-dev.sh`.

### Production attempt admission defect

- Tracing the remaining packed-attempt seam exposed a source defect in the production bootstrap.
  `serveProjectAuthority()` explicitly constructs `PiAttemptProcessSupervisor` with the runtime
  guard and closure pin, but omits `deferActivationUntilAuthorityCommit: true`. That replaces the
  engine's safe default supervisor. The child therefore receives `deferActivation: false` and may
  enter `ManagedPiSession.start()` immediately after its ready frame, before `#markAttemptRunning()`
  has durably recorded the exact session file. The later engine `activate()` is then a no-op. The
  production bootstrap must enable deferred activation, and the exact packed provider-free fixture
  must prove the child remains admitted-but-unactivated until the durable attempt record exists,
  then exercise transcript creation plus abort/delete and process-group exit.

### Concurrent context-lane gate status

- A non-mutating Core typecheck at 22:29 MST is temporarily red while the separately owned context
  experiment is mid-edit. Diagnostics are concentrated in `compiler/run-program.ts`,
  `graph/context-selector.ts`, `state/run-record.ts`, context-aware tool handling in
  `authority/run-engine.ts`, and their tests. This audit will not patch or reinterpret those files;
  the final package build/smoke must wait for that owner to publish a coherent handoff. The focused
  attempt-process suite itself is green (**16/16**) and `git diff --check` is green.

### Final release-only sweep

- The context owner subsequently restored strict Core TypeScript coherence; the earlier red status
  was an in-flight checkpoint, not a retained source defect. Final immutable evidence is still
  required after all lanes stop editing.
- The brand gate briefly failed because it scanned an append-only collaboration note containing the
  historical repository name. Packaging now excludes only collaboration history while keeping
  current/shipping source and docs strict; `./scripts/check-brand.sh` passes. Historical evidence
  was not rewritten.
- A tag-only release assertion remains broken at this checkpoint. The `Build and audit the tested
  Pi host boundary` script reads every Pi package from
  `package-lock.packages["node_modules/<name>"]`, but npm places `pi-agent-core`, `pi-ai`, and
  `pi-tui` beneath `node_modules/@earendil-works/pi-coding-agent/node_modules/<name>` in the current
  exact lock. Only `pi-coding-agent` is root-level. The workflow therefore sees `undefined` for
  those three despite their correct nested `0.80.10` versions. Release validation must inspect the
  actual pinned coding-agent closure (or both exact lock locations) and needs a locally runnable
  regression because root `check` does not execute this inline tag-only script.
- A separate authority-singleton race remains in `authority/endpoint.ts` and `authority/server.ts`.
  Two starters may both read the same dead-PID lease; the first removes it and publishes a new
  lease, then the second contender's already-authorized `rm(force)` can delete that new lease and
  publish its own. Both successful lease holders subsequently unconditionally unlink the shared
  Unix socket before `listen()`, so the second can unlink the first live listener and bind a new
  pathname while the first engine remains alive. That yields two compiler/state authorities over
  one Git common directory. Stale reclaim needs an atomic/serialized lock primitive rather than a
  read-then-unlink sequence, plus a two-process stale-lease adversary proving exactly one authority
  and one reachable listener survive. The existing test covers only a normal already-live owner.
