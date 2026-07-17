# Pi-native port coordination

Owner: `pi-native-port/root`

Status: active on branch `pi-native-port`.

## Locked decisions

- The shipped endpoint is pure TypeScript/Pi with no Rust binary or native Koni addon.
- Public packages are only `@koni/core`, `@koni/coding-profile`, and
  `@koni/research-profile`; compiler/runtime/state/Git/UI remain private Core modules.
- Pi owns credentials, provider execution, session JSONL, normal resources, and interactive chat.
- One TypeScript authority service per Git common directory owns compiler state, tickets,
  scheduling, grants, receipts, lifecycle, Git, and recovery.
- Autonomous work uses one fresh linear Pi session per immutable attempt. Pi branching remains
  available to ordinary user sessions but is not Koni ticket authority.
- Existing Pi settings/packages/resources are preserved. Community integrations are never
  silently installed and cannot issue Koni receipts.
- Both `/koni` and `koni tui` remain required and share one view model/component system.

> Transition note (2026-07-16): the operator host is being wired as a thin authority client in
> [`pi-operator-surface.md`](pi-operator-surface.md). Profile bytes are hash-cached beneath the Git
> authority root so daemon recovery never turns editable install metadata into trust. Pi startup,
> credentials, settings, and ambient resources remain owned by Pi and are not modified by Koni.

## Current gate

1. Preserve the exact shared worktree (`86c2ba5`, `pre-pi-native-wip-2026-07-16`).
2. Stabilize and tag a green Rust executable oracle before adding TypeScript port source.
3. Build the executable parity ledger before enabling TypeScript effects.

## Active delegated lanes

- `check_runner_containment_fix/root`: minimum Rust workspace stabilization only.
- `parity_contract_audit/root`: read-only parity-ledger and fixture inventory until oracle tag.
- `pi_extension_topology/root`: read-only profile/package scaffold inventory until oracle tag.

## Post-oracle implementation leases

- `pi_extension_topology/root`: root npm workspace, three public package manifests, profile
  registrar extensions, and deterministic Coding/Research baseline capture.
- `parity_contract_audit/root`: `reference/parity/**` executable ledger, schemas, cases, captures,
  and runner tests.
- `check_runner_containment_fix/root`: `packages/core/src/{contracts,shared,compiler}/**` and
  focused tests.
- `pi-native-port/root`: `packages/core/src/{authority,state}/**`, local protocol/journal/grant
  foundations, and integration of the three lanes.

### 2026-07-16 — contained Pi AgentSession lease

`pi_managed_sessions/root` owns the five new modules under `packages/core/src/pi/` for immutable
launch specifications, explicit zero-ambient resource loading, managed Pi sessions, supervision,
and Koni-aware compaction, plus focused offline tests. It will use the exact pinned Pi 0.80.10 SDK
surface, preserve Pi's normal credential/auth source, and make no provider calls in tests. It does
not own manifests, `extension.ts`, authority/state/compiler/Git modules, Rust, live runs, installed
binaries, or terminal surfaces. Mailbox:
[`pi-managed-sessions.md`](pi-managed-sessions.md).

### 2026-07-16 — shared control-center surfaces lease

`control-center-surfaces/root` owns only the new Pi-native presentation/controller modules under
`packages/core/src/control-center/{controller,component,standalone,markdown,input}.ts` and focused
tests. The lane consumes the canonical control-center view model and communicates through
`AuthorityClient` RPC only, so the installed Pi `/koni` surface and manually invoked `koni tui`
can share interaction and rendering semantics. It does not own authority/state/compiler/Git,
`extension.ts`, package manifests, live runs, installed binaries, or terminal-pane management.
Mailbox: [`control-center-surfaces.md`](control-center-surfaces.md).

### 2026-07-16 — shared Pi-native control-center surface ready for integration

`control-center-surfaces/root` implemented one authority-client controller and one Pi TUI component
tree for both `/koni` and manually invoked `koni tui`. The surface has exact peer-width wide
columns and a focused compact layout; Details with inline Overview/Plan/Stages tabs; vertically
stacked Objective/Goal/Run/Evidence; live-planning versus durable Markdown-plan presentation;
conditional option-and-notes Questions; all-attempt Agents; timestamped, active-duration Activity;
and a concise line-first graph whose marker/title overlays replace relationship cells. Pause,
resume, guarded deletion, manual merge, question answer, help, scrolling, and selection are shared
semantic actions. Every effect uses revisioned, idempotent authority RPC.

The explicit standalone constructor is inert until its caller invokes `start()` and never opens a
pane. Focused surface/view-model evidence is 10/10 green. Root integration must expose a read-only
`run.graph` projection, export/mount the modules, and feed complete native Pi transcripts into the
selected-agent Chat seam. Full implementation notes are in
[`control-center-surfaces.md`](control-center-surfaces.md).

## 2026-07-16 — coarse Pi package scaffold lease

`pi_extension_topology/root` now owns only the root npm workspace files and
`packages/{core,coding-profile,research-profile}` package manifests, profile registrar
extensions, oracle-derived normalized profile bundles, bundle-generation utilities, and focused
manifest/digest/materialization inventory tests. The frozen source is tag
`rust-oracle-baseline` (`fcc425e`). Core compiler/runtime/state/Git/control-center implementation,
all Cargo/Rust source, live projects, credentials, installed binaries, runs, and terminal surfaces
remain out of scope. Generated schema-2 baselines must come from fresh installs produced by the
tagged oracle; random migration receipts and legacy external-resource manifests are not authored
bundle inputs.

### 2026-07-16 — coarse package scaffold ready for integration

The `pi_extension_topology/root` lease is released. The root is now an npm workspace containing
only the three public packages. `@koni/core@1.0.0` is the single executable authority extension and
CLI package; its compiler/runtime internals remain other lanes' implementation. Coding `0.6.0` and
Research `1.0.10` are self-contained Pi profile packages whose tiny extensions only announce an
immutable manifest URL over the Pi event bus. They do not register tools, commands, or effects, and
they do not depend on or bundle a second Core module root.

Fresh installs from `rust-oracle-baseline`
`fcc425e51114bcedb9aeae44d6e8c8418a525e6b` were captured after the Rust schema-2 converter:

- Coding: 45 authored baseline files, bundle
  `sha256:850aedcdd53edeff41be7fcc8599b159b3516ac3772d5d8d3e22998d04ccade9`.
- Research: 48 authored baseline files, bundle
  `sha256:516ca34e79916431d44dd130201a4c84659df2bbf6f3dfd76b3d2c7d69f581f2`.

Each baseline includes the converted provider-neutral agent YAML and the exact 18 embedded shared
skill files. Random `migration-receipt.json` and the legacy external `resource-manifest.json` are
excluded. Their exclusion and the exact oracle commit remain recorded separately in
`koni/oracle-provenance.json`. Baseline file hashes and the NUL-delimited bundle digest use the
same `sha256:` contract as Core, and both official manifests pass Core's strict parser and
byte-verifier.

Reproducible capture and verification commands used:

```sh
CARGO_TARGET_DIR=/tmp/koni-rust-oracle-fcc425e \
  cargo build --locked --release -p koni-cli
capture_root="$(mktemp -d /tmp/koni-oracle-profile-capture.XXXXXX)"
mkdir "$capture_root/coding" "$capture_root/research"
git -C "$capture_root/coding" init -q
git -C "$capture_root/research" init -q
/tmp/koni-rust-oracle-fcc425e/release/koni init --profile software \
  --target "$capture_root/coding"
/tmp/koni-rust-oracle-fcc425e/release/koni init --profile research \
  --target "$capture_root/research"
node scripts/capture-profile-bundles.mjs --capture-root "$capture_root"
npm install --ignore-scripts
npm run check
npm pack --dry-run -w @koni/core
npm pack --dry-run -w @koni/coding-profile
npm pack --dry-run -w @koni/research-profile
```

The final check is green: the parity ledger validates; 5 independent baseline inventory and
materialization tests, 2 registrar tests, and all 65 current Core tests pass; all workspace
TypeScript compiles and Core builds. Dry-run package inventories contain the intended executable
or profile resources only. No live project, installed runtime, credential, run, process, or
terminal surface was changed.

## Coordination rule

Agents must preserve coherent changes they do not recognize, claim file scope before editing,
avoid live runs and installed binaries, and report decisions here. Existing architecture prose is
updated with dated supersession notes rather than silently rewritten.

### 2026-07-16 — native run compiler-program lease

`native-run-program/root` owns only the new concrete compiler bridge at
`packages/core/src/compiler/run-program.ts`, its focused provider-free test, and append-only
coordination notes. It authenticates the editable project through an installed Pi profile
package's verified baseline; validates planner-authored full and concise plan artifacts plus the
typed graph seed; derives tickets through the graph/rule compiler; resolves exact run types,
personas, models, thinking, resources, tools, and path grants; and emits immutable launch specs.
It never implements effects or recovery claims: those remain authority-owned. Mailbox:
[`native-run-program.md`](native-run-program.md).

## 2026-07-16 — native authority/state/Git foundation

`pi-native-port/root` added the first executable pure-TypeScript authority slice under
`packages/core/src/{authority,state,git,profile,pi}`. It now has canonical Git-common-dir
discovery, a single-owner local authority lease, bounded framed RPC, CAS/idempotent mutations,
crash-forward file journaling, immutable grant/replay checks, durable run records, a deterministic
dependency/max-parallel scheduler, Pi JSONL transcript projection, isolated run worktrees, and an
explicit two-phase target promotion (`prepare` then user-authorized publish). Git conflicts are
returned as compiler input rather than written into the target branch. Profile installation
verifies the package inventory and preserves edited/deleted project files, staging new upstream
bytes separately instead of overwriting them. Pi settings and credentials are never read or
modified by profile installation.

The authority service deliberately remains the only mutation serializer. Pi extension, CLI, and
TUI clients use the same protocol and never become authorization boundaries. No live Koni run,
installed binary, credential file, Pi setting, or terminal process was touched while establishing
this slice.

## 2026-07-16 — contained Pi session runtime ready for integration

`pi_managed_sessions/root` completed the high-level Pi 0.80.10 autonomous-session boundary. Core
now has immutable, hash-checked `AgentLaunchSpec`s; a sealed zero-ambient Pi resource loader; real
persisted linear `AgentSession`s; structured compaction with authoritative context reissue; and a
run supervisor with deterministic admission, steering/follow-up, pause, deletion, and disposal.
The runtime uses Pi's normal `ModelRuntime` credential path and never reads or modifies user Pi
configuration itself.

Crash recovery is explicitly distinct from fresh launch. It authenticates the exact JSONL header,
linear topology, single attempt mapping, launch/grant/state/resource/model identities, materialized
resource bytes, transcript terminal cardinality, usage totals, and a fresh durable authority
recovery projection before a provider-capable session is constructed. It then prompts once,
continues natively, projects an accepted terminal receipt without model work, or fails closed as
the durable state requires. Full details and the authority-provider integration contract are in
[`pi-managed-sessions.md`](pi-managed-sessions.md).

Handoff evidence is focused Pi **26/26**, complete Core **122/122**, strict Core TypeScript green,
Core build green, and whitespace green. Tests use real Pi persistence with network-disabled,
isolated model runtimes and no provider calls. No live run, credential, Pi setting, installed
binary, terminal, or product repository was changed.

### 2026-07-16 — contained-session handoff superseded after independent review

The 26/26 handoff above is retained as historical evidence but is superseded by the stronger
recovery/terminal boundary in [`pi-managed-sessions.md`](pi-managed-sessions.md). Focused evidence
is now **45/45**. Notable corrections are atomic header+mapping persistence, authority recovery
claims, high-level AgentSession continuation rather than low-level `agent.continue()`, strict
transcript/compaction authentication, torn-tail terminal projection, schema-validated terminal
arguments distinct from authority receipts, enforced single sequential terminating terminal
batches, proactive provider-output bounds, awaited abort, immediate runtime/claim release, observer
isolation, and symlink/inode hardening. Authority tool catalogs must throw on rejected terminal
submissions; every resolved terminal `AgentToolResult` denotes acceptance and is forced to
terminate the Pi batch.

The same boundary now hash-binds explicit attempt lineage. Initial attempts are epoch-zero roots;
retry/rework/review/recovery/integration attempts carry a positive epoch and paired parent
attempt/session identities, optionally pinned to one parent Pi entry. This metadata is preserved in
the atomic mapping and compaction context. Pi's `parentSession` session-header field remains unset
because it requires a source JSONL file path rather than Koni's logical parent session ID.

### 2026-07-16 — authority/session execution seam integrated

`pi-native-port/root` changed the production run engine to use
`PiAttemptProcessSupervisor` by default. Every autonomous attempt therefore runs in a killable
child process group; the older in-process `ManagedSessionSupervisor` is now an explicit test seam.
Full committed steering records, accepted/rejected tool receipts, per-tool transcript-result
budgets, context/compaction/recovery RPC, usage, terminal outcomes, pause, and deletion all cross
the same parent authority boundary.

Configured checks are no longer an ambient shell capability. `koni_run_check` resolves one exact
graph/command/composite plan through the compiler, persists an intent, snapshots declared paths,
executes exact argv in Seatbelt/bubblewrap with compiler-bound network/effect limits, captures
structured stdout/file results and produced-file hashes, and atomically commits compiler evidence,
audit artifacts, graph/ticket reconciliation, and the Pi receipt. Read-only mutation and dynamic
result/artifact contract violations fail closed. Interrupted external checks remain explicit
reconciliation blockers and are never blindly replayed.

Focused process/authority/compiler/managed evidence is green, and the combined Core suite reached
**214/214** before the concurrently edited profile lifecycle lane began regenerating its bundle.
No live project, credential, installed runtime, terminal pane, or existing run was changed.

The next Git parity gate is explicit: the initial TypeScript scaffold still materializes the
permanent run namespace during planning and shares the run checkout across ticket work. This is
not accepted as final behavior. The port must restore the documented detached planning checkout,
post-approval permanent run namespace, compiler-owned ticket branch/worktree per ticket cycle,
scope-checked squash integration, conflict tickets, and crash-safe retirement before parity can be
claimed.

### 2026-07-16 19:48 MST — Pi-native packaging boundary claimed

`pi-native-port/root` is replacing the historical Cargo/bundled-host developer install and release
pipeline with the same three coarse packages used by Pi: `@koni/core`,
`@koni/coding-profile`, and `@koni/research-profile`. The new source installer builds, checks,
packs, installs, and smoke-tests those npm payloads without reading or mutating the user's Pi
authentication, settings, extensions, skills, prompts, themes, or package registry. CI treats the
Rust tree only as a detached checked-in parity oracle; release jobs build and attest no Rust binary
or `runtime/pi-host` artifact. Profile Pi peer ranges are exact `0.80.10` rather than wildcards.

> **Pi package-convention correction — 2026-07-16:** The exact-peer sentence above is retained as
> the packaging checkpoint that was reviewed. Official Pi package loading supplies
> `pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui`, and `typebox` from the user's Pi runtime;
> shipping packages therefore declare those peers as `"*"` and never bundle a second copy. Koni's
> own development lock and executable compatibility suite remain pinned to Pi `0.80.10` (and that
> runtime's `typebox@1.1.38`) so widening the package peer does not weaken the tested runtime gate.

> **Installer-state correction — 2026-07-16:** The “without reading or mutating … settings or
> package registry” sentence above describes the earlier target, not the final registrar. The
> developer installer deliberately reads and atomically replaces only Koni-owned entries in Pi's
> global package settings so stock Pi discovers the three packages. It preserves credentials and
> every unrelated package, extension, skill, prompt, theme, project-local source, and setting. Its
> publication and rollback behavior remain subject to the crash/concurrency gates in
> [`pi-managed-packaging.md`](pi-managed-packaging.md) and
> [`pi-release-audit.md`](pi-release-audit.md).

This is an active packaging/docs lease over `scripts/install-dev.sh`, `.github/workflows/{ci,release}.yml`,
the three package manifests/lockfile, and adjacent dated transition notes. It does not install a
binary, publish a package, open a terminal, touch a live project, or alter credentials. The release
workflow publishes immutable package versions with npm provenance and attaches the exact three
archives/SBOM/checksums to the GitHub release. Frozen-oracle deletion remains gated on executable
parity; non-shipping historical files are not being removed prematurely.

### 2026-07-16 — direct-approval parity and control-center completion gate

`pi-native-port/root` added an explicit compiler-owned `agent | direct` planning mode. A run type
with no planning stage (currently Research Small) now creates a reviewable root-only graph and
approval artifact without constructing a synthetic planner or spending a provider turn. Approval
recompiles that exact root under the pinned schema and derives the normal ticket board. This
matches the Rust oracle's empty approved-planning-context behavior; an absent graph seed is accepted
only when the pinned run type genuinely has no planning stage.

The first shared control-center component is a useful dashboard foundation, not final parity. A
dedicated completion pass still owns: the complete New Run editor and provisional row; target-ref
selection; guided project configuration; structured plan review/revision; native transcript chat
and steering; direct-approval presentation; and every previously smoke-tested interaction recorded
in `docs/tui-cleanup-backlog.md` and `docs/control-center.md`. These are release gates, not deferred
ideas. They must remain one component/controller system shared by Pi `/koni` and manual `koni tui`.

#### 2026-07-16 20:28 MST — guided collection controls narrowed to semantic resources

The shared configuration catalog now exposes Add/Duplicate/Delete only for independently named
compiler resources: run-type and agent documents, `id`-bearing collection entries, and graph edge
types identified by `relation`. YAML-shaped implementation arrays such as expression clauses,
action recipe primitives, run-type patch operations, and the managed `project.yaml` run-type index
remain editable through their owning fields but no longer masquerade as creatable resources. The
run-type index continues to move atomically with its run-type document. This is a UI-semantic
boundary, not a schema change; every mutation still recompiles the complete candidate tree under
CAS before publication.

### 2026-07-16 20:31 MST — final TUI parity and packaged executable lease

This lane now owns `KPAR-TUI-0001/A03-work-titles` and
`KPAR-TUI-0003/A03-multiline-revision`. It will add exact provider-free interaction evidence and
then hand only the target-test mapping to the parity-runner owner. The npm-bin symlink behavior is
also an explicit packaging invariant: a fresh three-tarball install must print Core's exact version
and a real Usage page. This work remains isolated from user Pi state and live Koni projects.

#### 2026-07-16 20:25 MST — TUI proof handoff complete

The two owned control-center assertions now pass in the real shared controller/component suite:
all-attempt phase/ticket-aware titles (including the inactive Lead) and a multiline revision that
returns visibly to planning without approval. Focused surface evidence is **24/24** and strict Core
typechecking is green. The parity owner has the exact test identities; this lane made no competing
proof-manifest edit.

### 2026-07-16 21:12 MST — native Pi skill publication

`@koni/core` now publishes the three shared general-purpose Koni skills through its native Pi
package manifest: `configure-koni`, `model-koni-work`, and `operate-koni`. The build verifies that
the coding and research profile copies remain byte-identical before copying the exact 18-file tree
into the Core package. This intentionally does not expose either profile's complete resource bundle
to autonomous sessions: controlled attempts continue to receive only compiler-selected resources
bound by identity and content hash. Interactive Pi discovery therefore works normally without
turning ambient user or project resources into attempt authority.

### 2026-07-16 21:24 MST — final release-boundary lease; context lane excluded

The remaining implementation lease is deliberately narrow: authority/client protocol identity,
authority-daemon bootstrap compatibility, complete contained-child executable-closure pinning,
immutable cached profile publication, exact tarball-through-stock-Pi smoke coverage, release
workflow integration, and dated corrections to current-facing product docs. The concurrent
context-building experiment owns its own design surface; this lane will not edit compiler context
assembly, run-program prompt/context construction, resource binding, or compaction. Any overlap
question will be left in that lane's mailbox before source changes.

### 2026-07-16 21:38 MST — transaction-stable configuration snapshots

New-run compilation now authenticates the absence of an outside profile lifecycle owner and of
any unretired file transaction before, between, and after its double filesystem snapshot. The
guided editor remains valid because ownership is tracked by async context rather than the process
PID; a different request in the same daemon cannot borrow that authority. Crash recovery commits
and retires every journal before compilation resumes. The race and crash-pending regressions pass
alongside profile/config editing, authority identity, and contained-process tests (**45/45**).

This is deliberately a source-publication consistency fix, not a context-building change. The
concurrent context experiment retains ownership of prompt/context/resource/compaction semantics.

### 2026-07-16 — renewed context-lane exclusion

The user explicitly confirmed that a separate agent is trying context-building designs in this
same worktree. This lane therefore treats compiler/run-program context and prompt construction,
resource selection/binding, and Pi compaction as read-only integration inputs. I will check the
collaboration registry before any potentially overlapping edit and leave questions in the context
owner's mailbox rather than modifying that work. Current implementation remains confined to
executable identity/containment, authority lifecycle, packaging integration, and release gates.

### 2026-07-16 — embedded build identity and executable invocation authority

The previously recorded closure described authenticated executable bytes but did not yet force all
effects to invoke them. That gap is now closed. The compiled Core identity module carries a
deterministic post-build SHA in its loaded JavaScript; disk hashing normalizes only that marker and
acts as a freshness guard, so old in-memory code cannot adopt a newer on-disk identity. Shipped
placeholder builds refuse startup. Ordinary clients require loaded/disk agreement, while the
cross-build compatibility client can only quiesce and stop an authority before Pi is reloaded.

Authority startup captures the closure before Git discovery, pins the exact absolute Git identity,
passes the exact root-owned sandbox identity into configured effects, checks the full closure just
before each high-level effect, and rechecks Git/sandbox identity at spawn. New Git and check
receipts retain closure/executable hashes; older records remain readable. Pi's event bus makes two
current Core instances refuse `/koni`; the stronger `session_start` gate uses Pi 0.80.10's pinned
`getCommands()` and canonical `sourceInfo` to detect guard-unaware legacy copies as well. It prints
user/project/temporary-scope removal guidance and shuts Pi down before any renamed `koni:<n>`
command can start work. Focused provider-free evidence is **38/38**, the dedicated operator suite
is **11/11**, the Core build embeds and self-verifies its normalized SHA, and strict TypeScript is
green. Compiler context/prompt/resource/compaction files remained untouched.

### 2026-07-16 — durable two-phase Pi attempt admission

Production contained attempts no longer begin a provider turn merely because the child can create
a Pi session. The exact child first validates its immutable launch, constructs the real
`ManagedPiSession`, persists Pi's session header and Koni attempt mapping, and reports the exact
session file. The authority commits that path into the durable attempt record and attaches the
outcome observer before sending an ordered, attempt-bound `activate` control. Pause, deletion,
disconnect, or invalid framing releases the pre-activation wait only into abort/cleanup, so a
session that was never durably admitted cannot spend tokens.

The shipped authority always enables this boundary. A programmatic provider-free release probe may
withhold only the final activation after the production child is admitted; it grants no extra
authority and must pause/delete the disposable run. This lets the exact packed `run.create` →
compiler/scheduler → production child → Pi JSONL path be proven without a provider request.
Protocol/process/pool evidence is **16/16**. Compiler context, prompt construction, resource
selection, and compaction remain owned by the concurrent context lane and were not edited.

> **Admission guarantee clarification — 2026-07-16:** “pre-activation” means no provider turn and
> therefore no provider-token spend. Before reporting ready, Pi may perform its own local runtime
> initialization: reading ordinary credential/model configuration, checking local availability,
> loading cached model metadata, and refreshing a credential only where Pi's own offline/runtime
> rules permit it. The boundary does not claim zero credential activity; it claims that authority
> activation is mandatory before the model receives a prompt or starts a billed provider turn.

### 2026-07-16 — repository authority startup is one atomic transaction

Stale authority recovery is now serialized by a same-filesystem startup directory published only
after its complete owner record exists. A dead owner is atomically moved to a unique quarantine,
so only one contender can reclaim it. The winner retains this mutex while it authenticates and
removes a stale main lease, clears a stale socket, atomically publishes a complete lease record,
binds the listener, and applies socket permissions. Only then is endpoint admission reopened.
Consequently, a delayed second reclaimer can no longer delete a newly live lease or listener.

Startup-lock retirement is ownership-checked and retryable across partial cleanup; failed listener
startup destroys any early clients before releasing the lease. A focused stale-lock/stale-lease
concurrency regression proves one winner and one `authority_running` loser. Strict Core typecheck
and the composed authority/attempt-process set are green (**24/24**).

### 2026-07-16 23:18 MST — parity runner policy correction

The executable proof runner was starting Vitest at the repository root without naming Core's
checked-in config, so healthy Git/profile/process proofs inherited Vitest's five-second default and
were misreported as generic `STACK_TRACE_ERROR` plus teardown `ENOTEMPTY`/`EPERM` failures. The
runner now passes `--config=packages/core/vitest.config.ts`; a focused argument-construction test
prevents regression. The full mapped corpus passes **209/209** with normal file isolation and
parallelism under that policy. Reviewed captures and semantic contracts are unchanged. Later
`core_runtime_changed` results came only from concurrent `run-program.ts` writes and remain
discarded moving-source diagnostics pending the context owner's frozen handoff.
