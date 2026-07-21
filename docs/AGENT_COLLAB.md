# Koni Agent Collaboration Registry

### 2026-07-19 — clean Medium Coding smoke running on bundle `e86b9609`

Primary integration has installed and project-upgraded the authenticated Coding bundle
`sha256:e86b9609cf72c88303821d33a952a5a2f61e2a34b981fe8601872a2649b5a5f0`, preserving Pi auth and
the old blocked canary as evidence. Clean run `run-5714e72a-ac93-4aeb-bf77-8094e7e4b3a3` is active
through Pi `/koni-run`; no Updog-specific profile edit is authorized. The full native run-program,
Core typecheck, Coding package, and profile-bundle gates pass. Current observations and the guarded
old-TUI authority-respawn race are recorded append-only in
[`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

### 2026-07-18 — live Medium planner compact-and-retry boundary claimed

Primary integration is correcting the fresh Updog Medium canary's pre-transport input-pressure
failure without weakening authority limits or editing Updog. Scope is the exact provider exposure
error classification in `packages/core/src/authority/run-engine.ts`, a real Pi AgentSession
compact-and-retry regression in `packages/core/test/pi-token-admission.test.ts`, and append-only
coordination notes. The failed canary remains blocked and idle as evidence; no provider, profile,
project state, credential, terminal layout, or unrelated compiler behavior is in scope.

### 2026-07-18 — bounded run pagination and quiesce closure claimed

`bounded_run_pagination/root` owns the pre-freeze migration from mandatory whole-project
`RunRecord[]` materialization to an anchored one-record-at-a-time scan, revision-bound compact run
pages, lazy revision-checked selected details, and restart-safe bounded quiesce batches. It will
migrate recovery, monitor, adoption, attempt lookup, interactive project status, and the full
control center without adding a run-count cap or weakening exact run/action authority. Legacy
`run.list` becomes an explicitly output-proportional compatibility surface; quiesce retains only a
bounded ID sample plus exact counts. The active storage owner still leases ProjectStore,
FileJournal, and their focused tests, so this lane begins with a disjoint pure page/cursor module
and will not touch those paths before an explicit handoff. No provider, network, credential, user
Pi state, terminal/pane, live project, or frozen Updog mutation is authorized. Exact scope and
transitions are append-only in
[`agent-collab/bounded-run-pagination.md`](agent-collab/bounded-run-pagination.md).

### 2026-07-18 — composed CC-6 liveness diagnosis corrected

The causal action/compiler/store trace supersedes the earlier lost-wake-up suspicion: the
change-control decision scenario's fixed 30-second observer expired during steady durable action
progress, amplified by authenticated ~35ms reads polled every 10ms. Consecutive commits completed
all checkpoints in roughly 96–110ms, compiler calls exited, nested store reads retained active
tokens, and no settlement promise was stranded. The composed waiter is being changed to 200ms
polling with a 30-second no-progress watchdog, a separate 90-second hard cap, and a 180-second test
ceiling. Temporary production trace seams are removed; production settlement/store semantics are
unchanged. The separate detached reentrant-child serializer defect is not causal here and remains
an independently owned store hardening contract.

### 2026-07-18 — authority publication-order audit claimed

Primary integration owns one narrow release-gate correction in
`packages/core/src/authority/project-store.ts` plus focused project-store tests. A provider-free
terminal rehearsal proved that one file-journal transaction can rename a completed run record
before a later hash-bound evidence artifact, allowing an unsynchronized reader to observe an
invalid published projection. The correction will preserve crash-forward recovery while ordering
unreferenced/new immutable artifacts before run records and publishing project authority state
last. Run/action validators, archive semantics, providers, credentials, installed Pi state, live
projects, terminals, and the frozen Updog canary are out of scope.

> **Publication-order correction complete — 2026-07-18:** ordinary reads now share a reentrant
> serialized lane with commits; project mutations install supplied evidence/artifact destinations
> first, referencing run records second, and publish the project authority revision/receipt last.
> Prepared-journal crash recovery remains forward-only. The focused project-store contract is
> **9/9**, adjacent authority-server/store coverage is **18/18**, and strict Core typecheck is
> green. The terminal receipt lane owns the final immediate-read end-to-end assertion before this
> release gate is retired.

### 2026-07-18 — review provenance semantic replay correction claimed

Primary integration owns one narrow compiler correction in
`NativeRunCompilerProgram.#reviewCandidateNodeIds`: historical terminal outputs must be reparsed
with the exact compiled operation/workflow/step change-control contract that originally authorized
them. The composed Research suite proved the artifact, attempt, assignment, and terminal hash were
all correct; only replay had dropped the semantic binding and misread a prior proposal selection as
ordinary output. The validator remains fail-closed when a historical step has no compiled binding.
No provider, credential, installed Pi state, live project, terminal, or frozen Updog state is in
scope.

### 2026-07-18 — canonical proposal UI fixture repair claimed

`lifecycle_settlement_races/root` owns only
`packages/core/test/fixtures/canonical-control-ticket.ts` and the two focused control-center
proposal-review cases. The production validator now correctly requires every terminal-accepted
configured-validation attempt to bind one exact `assignment_validation` action; the shared fixture
still fabricated its success proof without that action. This lane will migrate the fixture through
the production action plan/journal/proof constructors, keep production fail-closed, and record exact
provider-free evidence in
[`agent-collab/lifecycle-settlement-races.md`](agent-collab/lifecycle-settlement-races.md).

> **Read-only CC-1 through CC-6 audit extension — 2026-07-18:** root additionally assigned
> `lifecycle_settlement_races/root` an independent audit of the full frozen change-control
> authority surface and serial release gate. It owns no production source for this extension and
> will report exact P0/P1 adversaries without overlapping the active terminal/composed owners.

### 2026-07-18 — Pi-native operator discoverability closure

Primary integration aligned the user-facing entry points without changing their shared authority
model: `/koni-run` opens guided intake for an independent supervised background run,
`/koni-runs` opens the compact companion overlay, and `/koni` plus manually invoked `koni tui`
open the same full control center. `/koni help`, the Get Started guide, the CLI guide, and the
control-center key table now describe those surfaces consistently. Docs typecheck, lint, and
production build are green; the build emits only the pre-existing multiple-lockfile workspace-root
warning. This note supersedes older collaboration handoffs that described these entry points as
missing, while preserving their historical text.

### 2026-07-18 — terminal zero-check authority correction claimed

`terminal_zero_check/root` owns only the zero-configured-check terminal-policy guard in
`authority/run-engine.ts`, focused provider-free regressions in `terminal-policy-runtime.test.ts`,
and append-only notes. An absent immutable configured-check grant will be permitted only for an
exactly empty validation/replay projection; every non-empty projection remains rejected. Required
receipt and retained/source evidence semantics remain independent. Mailbox:
[`agent-collab/terminal-zero-check.md`](agent-collab/terminal-zero-check.md).

> **Terminal zero-check correction complete — 2026-07-18:** the guard now permits a missing
> `configuredChecks` grant only for an exactly empty validation/replay projection; all three
> independently non-empty projection surfaces still fail closed. Required receipt and retained/
> source evidence paths are unchanged. The focused regression moved to the released
> `execution-policy-authority.test.ts` because the originally named record suite has unrelated
> legacy proposal fixtures awaiting canonical control-ticket migration. Evidence is **10/10**,
> strict Core typecheck is green, and scoped diff checks pass. The lease is released; exact details
> are in [`agent-collab/terminal-zero-check.md`](agent-collab/terminal-zero-check.md).

> **Terminal receipt-ordering follow-up — 2026-07-18:** primary integration reopened the same
> narrow lane after shipped Research reached the next boundary. The correction will preserve the
> Rust order: compiler-issued context before the attempt, durable output/action admission, exact
> scoped compile or review action completion, then receipt evaluation plus terminal-policy/action
> settlement in one CAS. Model payloads receive no receipt authority; pause/delete and restart
> remain explicit between every durable boundary. Mailbox remains
> [`agent-collab/terminal-zero-check.md`](agent-collab/terminal-zero-check.md).

> **Research change-control parity declaration — 2026-07-18:** the earlier reserved/absent parity
> status is superseded without erasing its history. `KPAR-CHG-0001` is now one `specified` P0 case
> with exactly five public temporal assertions: atomic request/hold; reviewed rejection/no-op/
> application and delayed source release; exact crash-forward resolver retry without chaining;
> pause winning final settlement; and deletion winning the same boundary permanently. Each maps
> one composed Research test and one frozen Rust semantic identity, with canonical control-ticket,
> CC-5 raw/store publication, and archive/v1/retry tests as supplemental targets. The development
> corpus validates at **30 cases / 39 checkpoints / 85 assertions / 208 actions / 12 issues**, zero
> blockers. It has no CHG capture and was not published; the source-stable whole-corpus publisher
> remains the sole promotion boundary. Details are in
> [`agent-collab/parity-change-control.md`](agent-collab/parity-change-control.md).

> **Composed CC-6 aggregate liveness finding — 2026-07-18:** the first coherent aggregate is
> **4/5 in 123.33s**. The approved-application case stalls at its final configured review with a
> `terminal_accepted` attempt and a still-`running` assignment-validation journal; no semantic
> result or settlement exists, the source remains correctly held, and shutdown waits on the same
> task. This occurs before CC-5 release/Git publication. `change_control_composed_test/root` has a
> bounded `run-engine.ts` assignment-settlement liveness lease and failure-only composed
> instrumentation; all run-record/archive predicates remain frozen. Details are in
> [`agent-collab/change-control-authority-integration.md`](agent-collab/change-control-authority-integration.md).

> **Run-byte anchor and archive-order closure — 2026-07-18:** the earlier archive-inventory note
> caught descriptor-only deletion but still trusted a mutable run plus matching disk subset and
> incorrectly reconstructed global order from action `createdAt`. Project authority state now
> binds the exact raw bytes of the exact sorted run-id set; commits and genuine v1/flat-Git
> migrations update those digests state-last. Archive order remains the predecessor-authenticated
> append order, including an older action that settles after pressure compaction. Normalized,
> case-folded ProjectStore destination identity plus ASCII authority paths close APFS aliases for
> state, run, and archive effects. Final provider-free evidence is **321/321** across project store,
> change-control store, and legacy Git migration, with strict Core typecheck and scoped diff check
> green. The local trust-root boundary and separate combined-legacy/budget handoff are explicit in
> [`agent-collab/archive-anchor-order.md`](agent-collab/archive-anchor-order.md); source/test leases
> are released.

> **Archive inventory closure correction — 2026-07-18:** the earlier closure remains valid for
> exact index-to-directory correspondence, but its read-side created-at reconstruction is not a
> valid runtime ordering rule when an older unsettled action becomes removable only after newer
> settled rows were archived. Exact inventory also does not detect coordinated removal of both an
> unreferenced descriptor and its artifact. Source freeze is reopened for
> `archive_anchor_order/root` to add both red preimages, remove the false global-order predicate,
> and bind exact run bytes into the state-last project authority root. `store_patch_review/root`
> owns independent review. Arbitrary same-user rewriting of that authority root is explicitly
> outside this local trust-root boundary. A separate read-only audit is classifying combined
> legacy-shape, migration transaction-size, and bounded-read/load-amplification findings.

> **Aggregate Research liveness gate — 2026-07-18:** on the first coherent five-scenario run after
> archive and CC-5 closure, four cases completed and the reviewed application case timed out at its
> final configured `verify` action. The accepted attempt, active Git cycle, and held source were
> correct; the validation journal remained `running`, and shutdown awaited the same background
> promise. This is being treated as a production lost-wakeup, not masked with a timeout or blind
> rerun. The composed lane owns the bounded `run-engine.ts` diagnosis/regression, the lifecycle lane
> owns test-only terminal/archive integrity matrices, and the parity lane owns KPAR-CHG-0001 plus
> exact collected Vitest-title validation. Source freeze, packaging, credentials, and the guarded
> Updog canary remain held until the aggregate and broad provider-free gates are green.

> **Store-lane and freeze-seal update — 2026-07-18:** focused tracing reaches the final review
> primitive's AuthorityServer mutation callback and then blocks on its first store read, before any
> semantic compiler call. This proves an authority↔store lane inversion; the serializer repair is
> sequenced behind the distinct archive-inventory patch so two owners do not edit
> `project-store.ts` concurrently. The expanded store matrix is **281/283**: only raw row/segment
> index omission is accepted, while every same-CAS, terminal-success, ordering, boundary,
> duplicate-index, and pressure case rejects correctly. Exact directory inventory is the bounded
> repair. The publication seal was also expanded to all authored shipping/build/rehearsal inputs,
> with parity-runner units green **9/9**; its current moving-tree hash is not release evidence.

### 2026-07-18 — composed Research authority suite resumed; Git-first approval blocker proven

`change_control_composed_test/root` resumed its exclusive provider-free integration file. Five
shipped-Research-profile scenarios now type-check against canonical compiler control-ticket
authority, v2 decisions/materialization/recovery, archive-v2 proofs, and typed stopped-action
settlements; targeted self-hashed materialization and resolver-retry substitutions are also wired
to real composed states. The first execution exposed a pre-ticket parity defect: TypeScript runs
`approved_plan_compile` before materializing the permanent run checkout, so `rules.evaluate`
compensates on `ENOENT`. The frozen Rust oracle is Git-first. The test now observes that exact
journal boundary and will accept only `planning=retired`, `run=ready` before successful rule
evaluation. Full durable evidence and the additive design correction are in
[`agent-collab/change-control-authority-integration.md`](agent-collab/change-control-authority-integration.md).

### 2026-07-18 — per-case parity publication claimed

`parity_case_publication/root` owns only `scripts/parity-{runner,ledger}*.mjs`,
`reference/parity/**`, and append-only coordination notes. It is replacing the shared multi-case
target artifact with one canonical reviewed capture per case, adding an explicit one-pass
provider-free publication transaction, and adding stable-domain cases for configured actions and
lifecycle, operation/workflow/check semantics, semantic profile retirement, the shared full
control center, and passive Pi companion coexistence. `KPAR-CHG-0001` is reserved but will remain
absent until the Research change-control/recovery API freezes. It excludes all production source,
providers, credentials, packages, terminals, live projects, and the frozen Updog canary. Mailbox:
[`agent-collab/parity-case-publication.md`](agent-collab/parity-case-publication.md).

#### 2026-07-18 — per-case parity tooling frozen; release publication waits for source freeze

The validator, one-pass rollback-protected publisher, source-generation seal, five new stable-domain
contracts, exact proof identities, and collision-free disposable target reports are implemented.
The current valid development ledger has 24 mechanically split prior reviewed cases and five
honestly `specified` additions; tooling suites pass **17/17**, while the release gate correctly
refuses promotion. A complete publication attempt wrote nothing when concurrent production edits
changed Core identity underneath restart tests. `KPAR-CHG-0001` remains reserved and absent.
`pi-native-port/root` will resume this lane only after the Research composed API and literal source
tree freeze, then run the sole promoting publisher and complete release gate. Exact evidence:
[`agent-collab/parity-case-publication.md`](agent-collab/parity-case-publication.md).

### 2026-07-18 — graph/rules semantic closure claimed

`config_semantic_authority/root` now owns the bounded compiler/graph closure for parsed-only node
annotations/semantic fields/gate requirements, edge predicates, gate-policy context/obligation/
passing-receipt semantics, and lifecycle/rules state machines. Each field must change a real
provider-free outcome using the Rust oracle and shipped profiles; synthetic DTO consumption is not
accepted. It excludes run engine/records/scheduler/program, control center/monitor, release/profile
migrations/manifests, providers, packages, live projects, terminals, and the frozen Updog canary.
Coordination is append-only in
[`agent-collab/graph-rules-semantic-closure.md`](agent-collab/graph-rules-semantic-closure.md).

### 2026-07-18 — complete configuration consumer audit and action-host contract

`config_semantic_authority/root` published an accepted-field-to-native-consumer map for every
shipped profile domain and an exact list of fields that remain parsed, reference-checked, or merely
projected without their promised behavior. The generic action VM is explicitly **not** marked
consumed; its required authority host/effect-replay contract is now documented. See
[`configuration-consumer-inventory.md`](configuration-consumer-inventory.md),
[`action-authority-contract.md`](action-authority-contract.md), and the append-only mailbox in
[`agent-collab/config-semantic-authority.md`](agent-collab/config-semantic-authority.md).

### 2026-07-18 — pre-freeze Pi-native product parity claimed

`pre_freeze_product_parity/root` owns an independent provider-free audit and bounded repair of the
full Pi-native control center (`/koni` and `koni tui`) plus the minimal Pi-chat background-run
companion (`/koni-run`, `/koni-runs`, status and attention). The lease is limited to
`packages/core/src/control-center/**`, `packages/core/src/monitor/**`, narrow command wiring when
required, UI-focused tests, and append-only documentation. It excludes run authority/state,
compiler/config/profile/install/migrations/actions/providers/credentials/packages, live projects,
terminals, and the frozen Updog canary. Coordination and final parity evidence are recorded in
[`agent-collab/pre-freeze-product-parity.md`](agent-collab/pre-freeze-product-parity.md).

### 2026-07-18 — action/workflow authority parity claimed

`action_authority_parity/root` owns the release-blocking production consumption of pinned action
selectors, workflow `validation_action` boundaries, and configured nonautomatic action stages.
The lane will authenticate and persist plans, journals, and per-effect receipts before dispatch;
resume exact nonterminal journals after restart; revalidate lifecycle/config/state before each
primitive; and delegate only to existing typed authority/compiler/Git/session methods. Unsupported
reachable bindings fail at configuration compilation rather than producing no-op receipts. It
does not touch profile migrations/manifests, providers, credentials, installs, live projects,
terminals, or the frozen Updog canary. Coordination is append-only in
[`agent-collab/action-authority-parity.md`](agent-collab/action-authority-parity.md).

### 2026-07-18 — configuration semantic second-audit handoff

`config_semantic_authority/root` completed a read-only second consumer audit after freezing the
typed behavior IR. It found inert planning session/seed-stage knobs, duplicate raw planning-policy
interpretation, and an unconsumed compile-action/generic action-VM surface. No overlapping source
was edited; exact evidence and root/profile-owner handoffs are appended in
[`agent-collab/config-semantic-authority.md`](agent-collab/config-semantic-authority.md).

### 2026-07-17 — configuration-semantic authority claimed

`config_semantic_authority/root` owns exact compile-time profile/run-type behavior schemas,
hash-bound semantic projection, deterministic action-recipe planning/execution contracts, and
configured New Run intake/role projection. It does not own authority run execution, run records,
Git implementation, release/install artifacts, providers, terminals, live projects, or the
frozen Updog canary. Detailed coordination is append-only in
[`agent-collab/config-semantic-authority.md`](agent-collab/config-semantic-authority.md).

### 2026-07-17 — compiler-capability control-center closure claimed

`stage_capability_authority/root` has released its standalone DTO lane and now owns only
`packages/core/src/control-center/**`, focused control-center tests, and append-only documentation.
This bounded follow-up consumes the landed `run.controls`, `run.action.execute`, and `run.lineage`
authority APIs; implements Action Palette/Form with honest availability, reasons, confirmation,
and guarded delete/merge routing; renders authenticated human attempt lineage in Agents/Chat; and
finishes durable question-batch save/revise/next/final-resolve behavior with recommendations. It
does not edit `authority/run-engine.ts`, compiler/config/profile/extension/provider code, live
state, terminals, package exports, or the frozen Updog canary. Raw Configure document integration
remains held until the primary integrator explicitly releases that API. Coordination remains in
[`agent-collab/stage-capability-authority.md`](agent-collab/stage-capability-authority.md).

### 2026-07-17 — compiler-authored stage/action capability contract claimed

`stage_capability_authority/root` owns only a standalone, versioned stage/action capability DTO,
its fail-closed validators/derivation helpers, focused provider-free tests, and an append-only
handoff note. The module may describe honest availability, disabled reasons, confirmation, and
compiler-authored form schemas for plan approval/revision, question answer/resolution,
pause/resume, retry, merge authorization, deletion, configured actions, and automatic/no-action
stages. It does not execute effects, infer permission from display strings, or edit
`authority/run-engine.ts`, compiler implementations, `control-center/**`, package exports, live
projects, providers, credentials, processes, terminals, or the frozen Updog canary. Mailbox:
[`agent-collab/stage-capability-authority.md`](agent-collab/stage-capability-authority.md).

#### 2026-07-17 — stage/action capability contract frozen; lease released

The standalone v1 catalog/invocation contract now fail-closes on stale revision/generation,
disabled or unknown actions, missing destructive confirmation, editable compiler-bound context,
invalid forms, unsafe text, duplicate identities, and incoherent stage controls. It models every
native lifecycle/operator intent without executing an effect or deriving permission from display
copy. Focused evidence is **12/12**, isolated strict TypeScript is green, and scoped whitespace is
clean. Exact root integration steps are recorded in
[`agent-collab/stage-capability-authority.md`](agent-collab/stage-capability-authority.md); this
source/test lease is released.

### 2026-07-17 — Configure document authority claimed

`config_document_authority/root` owns a standalone provider-free service for semantic raw
configuration document list/read/create/rename/delete, optimistic concurrency, run-type
templates, and guarded legacy-migration preview/apply planning. It excludes the moving run engine,
control center, package exports, providers, live projects, and the frozen Updog canary. The API and
handoff remain append-only in
[`agent-collab/config-document-authority.md`](agent-collab/config-document-authority.md).

#### 2026-07-17 — Configure document authority frozen; lease released

The versioned standalone authority and its raw managed-profile publisher are complete. YAML,
TOML, and Markdown list/read/update/create/rename/delete use exact catalog/source CAS, full-candidate
compilation, and one lifecycle transaction; broken YAML remains reachable for repair. The service
also freezes nine-domain/29-kind semantic DTOs, compiler-resolved run-type templates, and
exact-preview legacy migration apply. New tests pass **8/8**, existing profile/config/migration
regressions pass **16/16**, strict Core TypeScript and scoped whitespace are green. Root owns only
RPC/export/control-center integration. Exact API, caveats, and fingerprints:
[`agent-collab/config-document-authority.md`](agent-collab/config-document-authority.md).

#### 2026-07-17 — Configure crash-gap seam narrowly reopened

`config_document_authority/root` owns only optional exact authority mutation markers and recovery
for raw update/create/rename/delete and run-type creation. The marker is committed with the profile
filesystem transaction so an RPC retry can reconstruct success before an authority-store receipt.
Legacy migration retains its canonical archived plan/receipt/lifecycle witness. No run-engine,
exports, control-center, live project, provider, or canary work is in scope. Mailbox remains
[`agent-collab/config-document-authority.md`](agent-collab/config-document-authority.md).

### 2026-07-17 — provider-free release lifecycle closure claimed

`release_lifecycle_closure/root` owns the final provider-free audit and narrowly scoped repair of
Git/worktree/manual-merge behavior, profile install/update/migration preservation, packaged CLI
entrypoints, and disposable package-install evidence. It excludes `authority/run-engine.ts`,
`state/run-record.ts`, `control-center/**`, `pi/**`, compiler and monitor source, all providers,
global installation, terminal-pane management, and the frozen Updog canary. Exact findings and
handoffs are append-only in
[`agent-collab/release-lifecycle-closure.md`](agent-collab/release-lifecycle-closure.md).

#### 2026-07-17 — semantic-retirement provenance seam frozen; lease released

`release_lifecycle_closure/root` completed the bounded manifest/resource/install provenance seam
for mandatory declarative YAML-field retirement and released its source lease. Strict Core
TypeScript, the **4/4** retirement suite, and scoped whitespace are green; the related manifest
semantic cases are green. Final official manifest regeneration, old-bundle end-to-end upgrade
evidence, aggregate matrices, and packed installation remain deliberately deferred until root's
literal source freeze. Exact behavior and deferred gates are recorded in
[`agent-collab/release-lifecycle-closure.md`](agent-collab/release-lifecycle-closure.md).

### 2026-07-17 18:15 MST — Gate E session/transcript/lineage release claimed

`session_lineage_release/root` owns the provider-free Gate E audit and closure inside
`packages/core/src/pi/**` plus focused tests and append-only transition notes. The contract is one
fresh, immutable, linear Pi session per autonomous attempt; retry, rework, review, recovery, and
integration form authenticated Koni attempt lineage rather than mutable in-session branches.
This lane will verify full Pi transcript fidelity, authoritative context reissue after compaction,
steering/follow-up, pause/delete cancellation, crash/restart recovery, and zero post-delete token
use against the exact pinned Pi runtime. It will not edit `extension.ts`, `run-engine.ts`,
`control-center/**`, `monitor/**`, compiler/scheduler files, credentials/settings, or the frozen
Updog canary. Authority/UI schema gaps will be handed to their current owners through the mailbox:
[`agent-collab/session-lineage-release.md`](agent-collab/session-lineage-release.md).

### 2026-07-18 — graph/rules semantic closure implemented; runtime handoffs explicit

`config_semantic_authority/root` has closed node annotations/semantic identity/gate-required
parity, finite edge predicates, gate templates/status/context facts, and a hash-verified lifecycle
catalog within its leased compiler/graph files. Current Coding and Research baselines pass the
in-memory current-manifest semantic gate; focused graph/rule/execution suites pass **24/24**.
Lifecycle remains Prepared only pending an explicit Rust-era-to-Pi ticket status mapping and calls
to the pure transition authorizer; gate filesystem context remains pending exact configured-check
grant widening. Evidence and exact handoffs are append-only in
[`agent-collab/graph-rules-semantic-closure.md`](agent-collab/graph-rules-semantic-closure.md).

### 2026-07-17 — cold authority startup false-negative correction

`pi-native-port/root` verified an isolated Coding Medium smoke project through the complete
configuration gate before any model/session launch. Its authority became healthy roughly 75 seconds
after cold packed-runtime materialization, but the bootstrap gave up at 60 seconds. The idle
authority was stopped and the bounded first-start window is now 120 seconds, retaining immediate
child-exit failure and all sealed admission checks. This scope touches only
`packages/core/src/operator/authority-bootstrap.ts` and append-only coordination notes; it excludes
the externally owned context-building experiment, live provider work, credentials, and project
state.

### 2026-07-17 — Core stateful-fixture release isolation

`pi-native-port/root` observed seven unrelated Core suites timing out only when their files ran
concurrently. An isolated representative run-engine lifecycle test passed in 3.7 seconds. Core
Vitest now serializes files because profile/Git/authority fixture resources are intentionally real
and share OS-level state; test-internal operation deadlines remain unchanged. This is a test-gate
reliability correction, not a runtime concurrency change.

### 2026-07-17 — real planner startup pre-provider timeout corrected

`pi-native-port/root`'s first real Medium planner on the isolated Updog smoke worktree was
blocked after the contained-session construction deadline of 30 seconds. Durable evidence proves
the timeout occurred before a Pi session header, provider request, reservation, token usage,
question, ticket, or target-branch change. Core now gives the sealed contained cold-start path the
same bounded 120-second readiness allowance already required by authority startup; activation and
provider authorization remain separate. The preserved run will be resumed only from a rebuilt
runtime after focused verification.

### 2026-07-17 — workspace package-gate coordination

`pi-native-port/root` stopped a second package installer before its test phase after detecting
unrelated Core/parity Vitest runs. Package activation requires a quiet shared `node_modules` and
stateful fixture workspace for interpretable results. The blocked live smoke run and its authority
are stopped while the lane waits; no provider work can occur during this coordination pause.

### 2026-07-17 — Pi read-only model tools and semantic rendering claimed

`pi-native-product-parity-final/root` owns only the installed Pi extension's inert, project-trust-
checked read-only status/graph/ticket tools, a pure semantic renderer shared with contained
authority-backed tools, focused provider-free tests, and append-only coordination notes. Every
interactive call must authenticate the current Core/Pi 0.80.10 runtime and connect only to an
already-running sealed authority; it must never start recovery, resume a run, create an authority,
or cause provider work. This lane claims `packages/core/src/pi/{interactive-tools,tool-renderer,
tool-catalog}.ts`, the minimum `src/extension.ts` registration seam, and focused tests. It excludes
all graph/context construction, compiler/run-program logic, provider/session/process/runtime code,
live state, credentials, and the moving `src/authority/run-engine.ts`. Mailbox:
[`agent-collab/product-lifecycle-operator.md`](agent-collab/product-lifecycle-operator.md).

### 2026-07-17 — compiler-issued sealed model binding claimed

`pi-native-port/root` owns only the shared secret-free Pi model descriptor seal, the required
`AgentLaunchSpec.model` API/catalog bindings, the distinct provider-output headroom token field,
and compiler population/focused tests. This lane does not edit graph/context selection,
`pi/managed-session.ts`, provider reservation/state/process code, Pi credentials/settings, live
projects, or terminals. The context experiment remains externally owned; runtime admission is
owned by `pi-native-acceptance-final/root`. Coordination details remain append-only in
[`agent-collab/native-run-program.md`](agent-collab/native-run-program.md) and
[`agent-collab/pi-runtime-release-hardening.md`](agent-collab/pi-runtime-release-hardening.md).

## 2026-07-17 08:36 MST — process fallback observer closes post-ESRCH crash window

Independent review invalidated only the 08:24 process supervisor/test hashes: an observation-only
coordinator could die after ESRCH but before ACK once the in-group sentinel was already gone. The
authority now supervises a minimal detached signal-0-only fallback with no credentials, runtime,
project resources, authority fd, or destructive capability. Outcome remains withheld until its
ESRCH proof; helper failure retains explicit retry authority. New exact crash tests and three full
focused passes are green at **40/40** each, with clean syntax/diff/leak gates. Replacement hashes and
the preserved failure history are appended to
[`agent-collab/pi-runtime-release-hardening.md`](agent-collab/pi-runtime-release-hardening.md).

### 2026-07-16 — legacy adoption P1 hardening claimed

`legacy_adoption_hardening/root` owns the bounded post-review corrections for live registry-byte
admission, exact Git-common-directory legacy path binding, directory-race-safe tree hashing, and
test-only operator runtime injection. Compiler context/run-program/resource/compaction code and all
live state remain excluded; production Pi peer resolution is unchanged. Mailbox:
[`agent-collab/legacy-adoption-hardening.md`](agent-collab/legacy-adoption-hardening.md).

#### 2026-07-17 00:11 MST — legacy adoption hardening complete; lease released

Live registry bytes are now re-hashed around every adoption/resume source-tree proof; exact
authenticated common-dir/state/registry/run-root bindings reject coherently re-hashed archive path
redirection before source-path access; and directory traversal no longer trusts `Dirent` types or
unstable descent identities. Operator tests use explicit authenticated Pi-runtime injection while
the production resolver remains unchanged. Strict Core TypeScript passes, the exact no-ambient-env
adoption suite is **4/4**, the composed adoption/migration suite is **9/9**, and scoped whitespace
checks are green. The source lease is released for independent review. Details:
[`agent-collab/legacy-adoption-hardening.md`](agent-collab/legacy-adoption-hardening.md).

#### 2026-07-17 00:18 MST — legacy adoption lease reopened after P1 review

The preceding release verdict is superseded. Path-based traversal can detect an ancestor swap too
late to prove external bytes were never observed, and the provider-free runtime injection escaped
through exported production API types. `legacy_adoption_hardening/root` is replacing traversal with
a genuinely pinned/contained bounded helper and removing every public authentication bypass seam.
External full gate PID 5081 began on the rejected tree and is diagnostic only. No profile/operator/
test source will move until it exits. Details:
[`agent-collab/legacy-adoption-hardening.md`](agent-collab/legacy-adoption-hardening.md).

### 2026-07-16 — profile compiler production-adapter gaps claimed

`profile_compiler_gap/root` owns only the shipped Coding query-binding repair, the Research
production `RuleDomainAdapter` seam for authenticated dynamic check truth, and provider-free
acceptance tests. Unknown bindings remain errors and missing/stale check evidence remains false;
the lane will not weaken rules or fabricate receipts. `compiler/run-program.ts`, context/prompt/
resource/compaction logic, providers, and live state are explicitly excluded; any required
run-program patch will be proposed in its owner mailbox before editing. Mailbox:
[`agent-collab/profile-compiler-gap.md`](agent-collab/profile-compiler-gap.md).

#### 2026-07-16 23:21 MST — gaps verified closed; regression lease released

The stabilized tree already contained both production fixes, so this lane changed no production
or profile source. Exact provider-free regressions now prove Bug Fix/no-defect query scoping and
Research production-adapter/fail-closed dynamic truth (**2/2**); the native Coding, Research
planned, and Research direct-approval entry points are also **3/3**. The only attempted full
typecheck blocker is an unrelated moving-source control-center diagnostic. No active context or
run-program source was touched, and this lease is released. Details:
[`agent-collab/profile-compiler-gap.md`](agent-collab/profile-compiler-gap.md).

### 2026-07-16 — sealed Pi-native model catalog claimed

`sealed_model_catalog/root` owns only the offline Pi `ModelRuntime` catalog projection shared by
the `/koni` host and standalone control center, unavailable-reason presentation, focused
adversarial provider-registration/catalog-parity tests, and append-only session/admission docs.
The catalog must preserve normal Pi credentials and `models.json` while refusing to advertise an
ambient extension-only provider as executable by a fresh contained attempt. This lane does not
touch compiler context assembly, run-program prompt/context construction, resource binding,
compaction, live Pi state, credentials, projects, installed binaries, or terminal processes.
Mailbox: [`agent-collab/sealed-model-catalog.md`](agent-collab/sealed-model-catalog.md).

#### 2026-07-16 — sealed catalog moving-tree dependency

The catalog lane's own earlier `component.ts:663` diagnostic is fixed and strict Core TypeScript
was green. A subsequent serialized rerun is blocked only by the concurrently moving legacy-run
adoption return at `src/profile/run-adoption.ts:192`, where required `barrier` is currently optional.
The catalog lane will not cross that lease; its focused tests remain independently runnable.

#### 2026-07-16 — sealed catalog complete; lease released

Both operator surfaces now select only models present and available in a fresh offline Pi
`ModelRuntime` built from Pi's normal credentials, `models.json`, and cache. `/koni` retains
ambient extension-only entries solely as disabled explanations; it never serializes or registers
their provider functions in the child. Unavailable configured defaults are explained and blocked
before run creation. Adversarial registration, surface parity, UI refusal, and offline no-network/
auth-model-file preservation evidence pass **39/39**. Session/admission docs now record fresh
linear attempts and the exact no-provider-turn/token-spend activation guarantee. The lease is
released; shared typecheck awaits only the unrelated moving legacy-adoption diagnostic above.

### 2026-07-16 — Pi-managed packaging boundary claimed

`community_resource_integration/root` owns the exact-tarball install/release boundary that uses the
operator's existing stock Pi 0.80.10 runtime and package manager as the sole Pi SDK/TypeBox source,
while retaining a manually invoked `koni tui` command. Scope is limited to the developer installer,
stock-Pi package smoke, package/release CI wiring, required package metadata, and append-only
packaging docs. It does not touch context assembly, authority/runtime source, parity files, live Pi
state/credentials/binaries/projects, providers, or terminals. Mailbox:
[`agent-collab/pi-managed-packaging.md`](agent-collab/pi-managed-packaging.md).

### 2026-07-16 — domain-flow executable parity claimed

`community_resource_integration/root` owns the provider-free executable parity work for the
assigned Research and Software-flow assertions: gate-first research, exact research runtime
inputs/results/promotion/conclusions, diagnosis-before-implementation, closure provenance, and
four-domain plan/closure currentness. Production fixes are limited to gaps exposed by public
compiler/run-program fixtures; no providers, fabricated command captures, live state, or profile
contract weakening is allowed. Proof-manifest edits are coordinated with the central parity
runner. Mailbox: [`agent-collab/domain-flow-parity.md`](agent-collab/domain-flow-parity.md).

#### 2026-07-16 21:02 MST — domain-flow parity complete; lease released

All eight Research/Software-flow blockers now have exact provider-free tests and frozen-Rust oracle
bindings; the proof registry parses with **0 blockers**. Exact file prerequisites/argv/typed results,
same-operation receipt ticket reconciliation, authenticated passing-review promotion, exact
conclusion coverage, diagnosis-first implementation, current closure proof/review coverage, and
four-domain plan completeness are executable. Mixed `relations:` traversals now follow the whole
configured relation set at every hop. Final composed evidence is Core **27/27**, Coding **2/2**,
Research **4/4**, and strict Core TypeScript green. Final proof SHA/capture publication remains with
`executable_parity_runner/root`; this source/proof lease is released. Details:
[`agent-collab/domain-flow-parity.md`](agent-collab/domain-flow-parity.md).

### 2026-07-16 — Pi community resource integration claimed

`community_resource_integration/root` owns the inert installed-package binding resolver, one safe
compiler projection module, the minimum native run-program pinning seam, focused provider-free
isolation tests, and append-only transition notes. The lane never installs or loads arbitrary Pi
package code: `interactive_only` stays ambient operator-only, `not_recommended` fails closed,
`skills_only` pins exact declared text resources, and `explicit_tools` requires an exact
authority-backed compatibility mapping plus network policy. It does not touch control/config,
authority run engine, Git, migration, reports, live projects, Pi settings/credentials/packages,
providers, processes, terminals, or installed binaries. Mailbox:
[`agent-collab/community-resource-integration.md`](agent-collab/community-resource-integration.md).

### 2026-07-16 20:31 MST — final control-center parity lease

`pi-native-port/root` owns the two unclaimed executable proof blockers
`KPAR-TUI-0001/A03-work-titles` and `KPAR-TUI-0003/A03-multiline-revision`, plus the packaged-CLI
symlink regression and release smoke. The surface must prove concise phase/ticket-aware titles for
active and historical agents, and a genuinely multiline steering submission that returns plan
review to visible planning without approving work. Proof-manifest edits will be coordinated with
`executable-parity-runner/root`; no live project, Pi home, installed binary, provider, process, or
terminal pane is in scope.

#### 2026-07-16 20:25 MST — TUI proof handoff complete

Both focused contracts are now executable in the shared control-center suite. Active ticket work
and the inactive planning Lead remain visible with concise semantic titles; the run-wide list uses
ticket prefixes and ticket selection filters without dropping history. Plan steering accepts a
real newline, renders the wrapped editor, submits the exact multiline value, closes review, does
not approve execution, and exposes planning activity. Focused evidence is **24/24** and Core strict
TypeScript is green. Exact proof titles were handed to `executable-parity-runner/root`.

### 2026-07-16 — full executable parity runner claimed

`executable_parity_runner/root` owns the checked-in TypeScript-vs-frozen-Rust
parity execution gate under `reference/parity/**` and `scripts/parity-*.mjs`.
The lane is replacing schema-only plans with isolated action dispatch,
checkpoint captures, deterministic entropy normalization, assertion-level
comparisons, and a release-mode gate that fails closed on every missing Core
surface. It does not edit product authority/Git/state/UI/profile code, Rust,
live projects, credentials, installed binaries, processes, terminals, or cmux.
Mailbox: [`agent-collab/executable-parity-runner.md`](agent-collab/executable-parity-runner.md).

### 2026-07-16 — Pi-native control-center full parity claimed

`pi_operator_surface/root` now owns only `packages/core/src/control-center/**`, focused offline
tests, and append-only coordination notes. The lane is completing the one shared `/koni` and
`koni tui` controller/component: guided New Run, project-overlay configuration, structured plan
review, Pi-native transcript/chat steering, and the complete dashboard/help/graph/question
interaction contract. Every durable read and effect remains an authority RPC; no provider,
credential, live project, run, process, terminal, or installed binary is in scope. Missing config
catalog/draft RPCs will be specified as a typed handoff rather than implemented inside the UI.
Mailbox: [`agent-collab/control-center-full-parity.md`](agent-collab/control-center-full-parity.md).

### 2026-07-16 — Pi-native direct approval implemented; UI parity lane queued

`pi-native-port/root` now owns the explicit no-provider direct-approval path for run types without
planning stages. Research Small validates and reviews a root-only graph, then compiles tickets only
after approval. The existing shared control center remains a foundation: New Run/configuration/
plan-review/native-chat parity is queued as one coherent follow-up lane as soon as a collaboration
slot is released. Git end-to-end tests are intentionally not being edited by root while
`isolated_git_lifecycle/root` rewrites their worktree contracts.

### 2026-07-16 — Pi-native operator surface claimed

`pi_operator_surface/root` owns Core's Pi `/koni` registration, manual `koni` CLI, authenticated
profile-source/cache bootstrap, authority daemon discovery/startup, and the thin adapter that mounts
the already-shared control center in Pi. The extension stays inert until invoked and neither surface
opens terminal panes. Pi credentials/settings/resources remain entirely ambient and untouched.
Mailbox: [`agent-collab/pi-operator-surface.md`](agent-collab/pi-operator-surface.md).

#### 2026-07-16 — Pi-native operator surface ready for integration

The source lease is released. `/koni` and manually invoked `koni tui [--root]` now mount the same
shared control-center controller/component; the extension is inert before invocation. CLI and Pi
commands cover profile init/update, authority start/status, effective-config validation, and run
creation. A verified bundle-hash cache beneath the Git authority root gives detached daemon
recovery immutable profile provenance without touching Pi auth/settings/resources. Focused tests
are **5/5**, Core typecheck/build and whitespace are green, package inventory is complete, and a
disposable detached-authority smoke ended with no residual process. Modal parity remains in the
separate control-center lane. Full handoff: [`agent-collab/pi-operator-surface.md`](agent-collab/pi-operator-surface.md).

### 2026-07-16 — Pi-native profile lifecycle and guarded migration claimed

`profile_lifecycle_migration/root` owns the profile package lifecycle: official installed-package
discovery, immutable bundled baselines, materialized `.koni` project overlays, three-way upgrades,
explicit conflicts, complete Coding/Research bundles, and guarded Rust-era project/run migration.
The lane never edits `.pi`, credentials, settings, community resources, live projects, active
processes, CLI/extension/session/runtime files, or terminal surfaces. Mailbox:
[`agent-collab/profile-lifecycle-migration.md`](agent-collab/profile-lifecycle-migration.md).

### 2026-07-16 — executable Rust/TypeScript parity contract active

`parity-contract-audit/root` owns `reference/parity/**`, the narrowly named
dependency-free parity ledger runner/tests under `scripts/`, and append-only
coordination notes. The frozen oracle is annotated tag `rust-oracle-baseline`
at commit `fcc425e`. The initial ledger is green with 24 cases, 29 checkpoints,
65 assertions, 126 typed actions, and 8 exact issue records. No Rust behavior,
`packages/**`, live project, credential, provider, installed binary, run,
terminal, or cmux surface is in scope. Mailbox:
[`agent-collab/parity-contract-audit.md`](agent-collab/parity-contract-audit.md).

#### 2026-07-16 — first detached-oracle command capture reproduced

The deterministic install/profile-compile/validate/fail-closed-control capture
was generated twice from the detached oracle with disposable project and Pi
homes and zero provider/agent command. The capture also executes exact
provider-free compiler and positive pause/play Core contracts. Both complete
files have SHA-256
`04c01423ebf329331f5d7f3a663d411df841c9bc9d6693fb91904fa85eb716c8`.
The ledger now hash-pins and validates its provenance, isolation contract, and
secret scan. Positive lifecycle capture will require a no-provider fixture
seam; `plan-run` is explicitly excluded because it crosses into Pi planning.

### 2026-07-16 — full Pi-native TypeScript port claimed

`pi-native-port/root` owns the coordinated end-to-end migration on branch `pi-native-port`:
the executable Rust parity oracle, the coarse `@koni/core`, `@koni/coding-profile`, and
`@koni/research-profile` package system, deterministic TypeScript authority/compiler/runtime,
native Pi sessions and credentials, shared Pi/standalone control center, compatibility migration,
and final Rust deletion gates. The exact pre-port shared tree is preserved by commit `86c2ba5` and
tag `pre-pi-native-wip-2026-07-16`. No live project run, product checkout, or terminal surface is
authorized as a test target. Mailbox: [`agent-collab/pi-native-port.md`](agent-collab/pi-native-port.md).

#### 2026-07-16 — contained Pi-session lane hardened after review

`pi_managed_sessions/root` retains the contained autonomous-session files listed in
[`agent-collab/pi-managed-sessions.md`](agent-collab/pi-managed-sessions.md). Its current boundary
uses atomic attempt mapping, authority-owned recovery claims, exact transcript/compaction
authentication, schema-validated terminal arguments distinct from authority receipts, awaited
abort, immediate provider/runtime release, and zero-ambient resources. Focused evidence is
**45/45** with real network-disabled Pi persistence; the authority integrator owns catalog and run
engine wiring. No live provider, credential, run, project, process, terminal, or installed binary
is in scope.

The launch boundary also hash-binds explicit attempt lineage: epoch-zero initial roots and
parent-bound positive-epoch retry/rework/review/recovery/integration branches. Logical parent session
IDs remain in Koni authority/mapping state; they are not written into Pi's path-valued
`parentSession` header field.

### 2026-07-16 — Pi-native session/resource/auth migration audit claimed

`pi-native-migration-audit/root` owns documentation only: an exact pinned
`@earendil-works/pi-coding-agent@0.80.7` API/source audit, Koni subsystem migration matrix,
boundary ADR, staged vertical slice, compatibility/security consequences, and deletion gates.
The corrected target makes Pi canonical for provider credentials/auth wherever supported; Rust
retains no provider secrets and stores only opaque nonsecret capability/fingerprint/migration
bindings. No runtime/source code, live state, binary, credentials, provider calls, project refs,
terminal, or cmux surface is in scope. Mailbox:
[`agent-collab/pi-native-migration.md`](agent-collab/pi-native-migration.md).

#### 2026-07-16 — Pi-native migration audit released

The docs-only lease is released to `root`. The target ADR now makes Pi the session, resource,
extension, native-chat, model-execution, and canonical provider-auth substrate while Rust retains
all workflow/effect authority. Exact pinned 0.80.7 APIs, stock auth locking versus non-atomic
persistence, zero-ambient AgentSession construction, the full subsystem migration matrix, guarded
credential import, run/session compatibility, smallest read-only extension slice, P0/P1 risks,
tests, source scopes, and legacy deletion gates are recorded. Session branching is attempt-scoped:
one Pi tree per immutable assignment, one Rust-authorized branch epoch, and every post-terminal
revision/rework/review receives a new launch/session/grant. Adjacent historical credential-path
notes were preserved and superseded, not replaced. Scoped diff checks are clean; no source, runtime,
binary, credential, provider, project, run, process, TUI, or cmux state changed. Decision and
evidence: [`pi-native-migration.md`](pi-native-migration.md) and
[`agent-collab/pi-native-migration.md`](agent-collab/pi-native-migration.md).

### 2026-07-16 12:49 MST — durable process identity hardening released

`release_review_runtime/root` has frozen and released the process-identity lane. New process
records use versioned kernel-native identities: Linux boot UUID plus `/proc` start ticks, or macOS
`proc_pidinfo` start seconds plus microseconds. Exact PID, process-group leadership, zombie state,
and the existing executable binding remain fail-closed. Legacy `ps lstart` records deserialize for
history but never authorize TERM or KILL. The destructive helper revalidates the same identity
immediately before both TERM and SIGKILL, so a leader that exits during the grace window revokes
escalation authority over its former PGID. Core production check, nine focused regressions,
warning-denied clippy, workspace rustfmt, and scoped diff check are green. No live/runtime/binary/
cmux/profile/acceptance state changed. Evidence:
[`agent-collab/process-identity-fix.md`](agent-collab/process-identity-fix.md).

### 2026-07-16 12:29 MST — durable process identity hardening claimed

`release_review_runtime/root` owns only the versioned kernel-native process birth marker in
`crates/koni-core/src/agent.rs`, the minimum destructive-signal admission gate in
`crates/koni-core/src/engine.rs`, focused regressions, and append-only coordination notes. New
records will use Linux `/proc` start ticks or macOS `proc_pidinfo` start time; second-resolution
legacy markers remain historical/read-only and cannot authorize signal or kill. Process-group and
executable binding remain mandatory. No configured-check runner, live state, binary, cmux,
TUI/CLI, profile, acceptance repository, or installed runtime is in scope. Mailbox:
[`agent-collab/process-identity-fix.md`](agent-collab/process-identity-fix.md).

### 2026-07-16 — configured-check runner containment repairs claimed

`check_runner_containment_fix/root` owns only `crates/koni-core/src/process.rs` check-attempt
process-group/session containment, bounded TERM/KILL/reap/drain helpers, independent and cumulative
stdout/stderr capture limits, bounded result-file reads/classification, explicit receipt truncation
metadata, and focused deterministic Core regressions. No live runs, cmux, binaries, profiles,
TUI/CLI, acceptance repositories, or installed runtime are in scope. Mailbox:
[`agent-collab/check-runner-containment-fix.md`](agent-collab/check-runner-containment-fix.md).

#### 2026-07-16 — configured-check containment ready for integration

The lease is released. Every configured check now owns a fresh Unix process group, drains stdout
and stderr without joinable reader threads, and converges normal descendant cleanup plus
timeout/stop/setup/read/wait failures on bounded TERM/KILL/group-exit/leader-reap/pipe-drain
handling. Each stream retains at most 1 MiB, the attempt retains at most 1.5 MiB, complete observed
streams are hashed, receipts expose retained/observed/truncated metadata, and typed stdout/result
files fail above the 1 MiB result boundary. Truncated expected-nonzero output cannot become false
historical evidence. Focused process tests are **24/24**, warning-denied Core Clippy is green, and
the full Core library is **692 passed / 0 failed / 3 ignored**. Scoped formatting/diff checks are
clean. No live/runtime/binary/cmux/profile/product/ref state changed. Exact contract and evidence:
[`agent-collab/check-runner-containment-fix.md`](agent-collab/check-runner-containment-fix.md).

### 2026-07-16 11:16 MST — final context production-call-site evidence claimed

`context_spawn_preflight_fix/root` owns only the shared wrapper pregrant validation call, the
existing direct-Pi PID/`active_worker` ticket-publication helper, and focused tests that route the
bound pack through the claimed Software broker's real `context`/`read_file` paths. The final P1
bar is same-length SHA drift plus path/delete/ticket drift with no new receipt/effect, and proof
that PID publication preserves the refreshed issued context. No real Pi/provider, live state,
binary/bundle, cmux, product checkout, ref, profile, or unrelated runtime surface is in scope.
Mailbox: [`agent-collab/context-spawn-preflight-fix.md`](agent-collab/context-spawn-preflight-fix.md).

### 2026-07-16 11:08 MST — production Worker-spawn seam evidence released

`context_spawn_preflight_fix/root` has frozen and released the follow-up P1 lease for independent
re-review. One real Software wrapper regression now proves exact MAX reaches the injected
pregrant continuation once, exact MAX+1 reaches it zero times and leaves ticket/pack/receipt/
grant/response/agent/log namespaces unchanged, dirty replacement recovery refreshes a stale
selected-step binding with one publication, and path/body/ticket-hash adversaries fail both
pregrant and bound delivery before a receipt. The discovered same-bytes path-substitution gap is
closed by requiring the compiler-derived canonical ticket/context-digest document path.

Focused evidence: production wrapper **1/1**, Core library check clean, Rustfmt check clean, and
scoped diff check clean. No live/runtime/binary/bundle/cmux/product-worktree/process/ref/profile
state changed. Exact fixture design, assertions, command, and retained P2s:
[`agent-collab/context-spawn-preflight-fix.md`](agent-collab/context-spawn-preflight-fix.md).

### 2026-07-16 10:46 MST — production Worker-spawn seam evidence claimed

`context_spawn_preflight_fix/root` has reacquired only the direct
`spawn_direct_pi_agent_with` test seam and focused regressions in `crates/koni-core/src/engine.rs`.
The independent post-fix review accepts current production semantics but blocks release until a
non-launching injected continuation proves MAX crosses once, MAX+1 has zero prelaunch/durable
effects, dirty replacement context is rebound exactly once, and bound path/body/current-ticket
mutation fails before a receipt. No production redesign, live/runtime launch, binary/bundle,
cmux, process, ref, profile, product checkout, or broad formatter is in scope. Mailbox:
[`agent-collab/context-spawn-preflight-fix.md`](agent-collab/context-spawn-preflight-fix.md).

**Lease expansion — 2026-07-16 10:52 MST:** the mandatory alternate-path adversary found that a
rehashed binding could point to a same-bytes file elsewhere under run work storage. The primary
integrator authorized one shared canonical `ticket/context-hash/context.md` path check in the two
existing prelaunch/delivery validators. Existing containment, no-symlink, body identity, and
current-ticket checks remain and the adversary stays fail-closed.

### 2026-07-16 10:37 MST — Worker context spawn boundary released

`context_spawn_preflight_fix/root` has released its exact context-specific source lease to
`primary-integrator/root`. New policy-enabled Workers now compile, size, and cryptographically
bind the selected-step context before any launcher/grant/agent/Pi/provider side effect; the held
run-agent barrier and launcher-entry revalidation prevent a stale boundary. Broker and Pi context
delivery are one-shot and monotonic. Pre-EOF supplements are closed, so the persisted 128-context
cap preserves 128 of 256 receipts for informed work. The Pi observation latch is driven only by
the compiler-bound `context_completion_required` bit, and absent-policy Worker/Lead/observer
sessions retain the historical 64 MiB bounded compatibility path.

Focused evidence is Rust broker **10/10**, Core library check clean, Pi runtime **60/60**, and
TypeScript typecheck clean. No live/binary/runtime-bundle/cmux/project/process/ref/profile state
changed. The primary integrator retains composed MAX/MAX+1 launcher-counter coverage, separate
large Lead/observer fixtures, physically populated crash/reopen receipt-ledger coverage, broad
matrices, independent re-review, and any guarded refresh. Exact design, commands, and caveats:
[`agent-collab/context-spawn-preflight-fix.md`](agent-collab/context-spawn-preflight-fix.md).

### 2026-07-16 10:10 MST — context observation/budget post-fix review requests changes

`context-fix-reviewer/root` independently reviewed the successful-context observation latch,
context cursor, 4,000,000-byte/256-receipt arithmetic, dispatch ordering, direct-Pi wire, and
historical/Lead compatibility. The new-policy happy path is accepted: initial full context and
every exact continuation including EOF quarantine later same-message siblings without broker
dispatch, and the next provider request can continue after observing the result. Straight-line
UTF-8 paging needs at most 123 deliveries, or 124 with path-only recovery.

Three P1 domains still block guarded release. Bundled Software does not build the exact context
until an already-running Worker calls `koni_runtime.context`, so over-bound rejection is not
pre-dispatch and the current test proves only a helper error. Repeated successful `context` calls
can regress `Paging`/`Complete` to the initial offset; varying `max_bytes` then creates distinct
durable page receipts and can consume all 256, invalidating the claimed 128 product reserve. And
Pi receives no policy bit, so its latch changes policy-absent historical direct-Pi Workers; the new
global 4 MB validator likewise changes historical 4 MB..64 MiB and unscoped observer/Lead packs.
No P0 was found. P2 gaps remain around malformed EOF-shaped trusted responses, initial-paged and
`already_issued` sibling tests, and a real maximum-context durable-ledger/dispatch regression.
Exact evidence and minimum corrections:
[`agent-collab/context-fix-review.md`](agent-collab/context-fix-review.md).

### 2026-07-16 09:36 MST — context observation/budget release blockers claimed

`context-observation-budget-fix/root` owns the two P1 release corrections and closely related
fail-closed P2 hardening from
[`agent-collab/context-read-discipline-review.md`](agent-collab/context-read-discipline-review.md):
Pi same-assistant-message quarantine after every successful compiler-context delivery; one
compiler-validated arithmetic invariant joining context size, preview/page progress, receipt
capacity, and a product-work reserve; UTF-8 continuation progress; a default-closed Worker-tool
partition; and focused malformed-cursor/boundary tests. Expected source ranges are context-only
symbols/tests in `crates/koni-core/src/{agent_tool_broker,engine}.rs` and
`runtime/pi-host/src/runtime.ts` plus its focused tests and append-only documentation. No live
state, binary/runtime installation, process, cmux surface, fixture, Git ref, or product worktree
is in scope. Mailbox:
[`agent-collab/context-observation-budget-fix.md`](agent-collab/context-observation-budget-fix.md).

#### 2026-07-16 09:57 MST — source lease released for integration

The two P1s are closed in source and the cheap adjacent P2s are hardened. Pi keeps sequential
execution but treats every successful full/paged context result and exact continuation, including
EOF, as a model-observation boundary; later siblings are rejected locally and never dispatched to
the broker. Rust now fails future Worker tools closed before context completion, requires exact
context continuations to request at least 32 KiB, rejects malformed request/response path, offset,
SHA, and nonadvance cases, and guarantees scalar progress for a one-byte UTF-8 request. The single
budget contract is 4,000,000 accepted context bytes, 32,765 worst-case page progress, at most 123
page-bearing receipts or 124 with path-only recovery, a 128-receipt context allowance, and an
unconditional 128/256 product/check/submission reserve. The first byte above the cap fails before
context-pack publication/Worker eligibility.

Focused evidence on private Cargo targets: provider-neutral broker **21/21**; multibyte maximum,
one-byte progress, Worker prompt, already-issued recovery, and existing real direct-Pi paging each
**1/1**; embedded Implementer **1/1**; Pi runtime **57/57**; TypeScript typecheck, exact-file
Rustfmt checks, and `git diff --check` are green. No bundle/dist, binary, live state, process, cmux,
fixture, ref, or product worktree changed. Remaining nonblocking P2s are search-result byte-offset/
hash ergonomics and parity in the explicitly test-only historical Codex/MCP seam. Exact handoff:
[`agent-collab/context-observation-budget-fix.md`](agent-collab/context-observation-budget-fix.md).

### 2026-07-16 — supervision exit-publication P1 repairs claimed

`supervision_exit_guard_fix/root` owns only the action-length, fail-closed exit-publication guard
shared by direct-Pi/generic terminal waiters; exact direct-Pi record/result correction; exact-live
transitional-agent rejection; and focused Core/lifecycle regressions. Diagnostic receipts remain
allowed for live registered paused/questioned runs, but deletion, missing control/registry,
unregistered/concluded state, or mismatched agent identity/status refuse every write and ticket
cleanup. Historical terminal agent rows remain compatible with the read-only exact-live fast path.
No live state, binary/runtime bundle, cmux, fixture, profile, Git ref, or product worktree is in
scope. Mailbox: [`agent-collab/supervision-exit-guard-fix.md`](agent-collab/supervision-exit-guard-fix.md).

#### 2026-07-16 — correction ready for integration

The claimed slice is released in source. Both terminal waiters now share a mandatory action-length,
live-registry/control/deletion guard; direct Pi additionally revalidates its complete exact agent
binding and preserves provisional recovery evidence during exact success/failure correction.
Pause/question draining remains permitted, while deletion, unregistration, conclusion, missing or
redirected control, and authority exhaustion perform no record/PID/ticket cleanup. Exact-live
polling rejects every extra unfinished row but ignores internally complete terminal history.
Private-target focused gates pass as recorded in the mailbox; broad composed gates, independent
re-review, and guarded refresh remain owned by `primary-integrator/root`.

This file is the shared coordination surface for every agent working in this repository.
Update it before starting a task, whenever ownership or status changes, and when handing work
off. The detailed product backlog remains in [`tui-cleanup-backlog.md`](tui-cleanup-backlog.md);
this registry records ownership, integration state, and cross-agent hazards.

### 2026-07-16 08:54 MST — conservative exact-live supervisor fast path active

`live-supervision-fastpath-impl/root` owns only `Engine::supervise_run_once_with`'s
pre-authority decision, new narrowly named exact-live-worker validation helpers/test counters in
`crates/koni-core/src/engine.rs`, and focused lifecycle regressions. Under the existing supervisor
lease, an unchanged active registration/running orchestration/waiting stage/no-question snapshot
plus an exact compiler-owned Worker grant, agent record, ticket lease, and owned live process may
return the existing passive `Waiting` result without global run authority or quarantine/board
projection. Every missing, changed, stale, dead, mismatched, paused, deleted, questioned, blocked,
terminal, or ambiguous case falls through to the current full fail-closed tick. Pi sequential tool
execution, broker currentness, grant serialization, and durable one-in-flight CAS remain unchanged.
No live state, binary/runtime asset, process, cmux, Git ref, installed profile, or product worktree
is in scope. Mailbox: [`agent-collab/live-supervision-fastpath.md`](agent-collab/live-supervision-fastpath.md).

## Coordination protocol

1. Read this registry and `git status --short` before editing.
2. Claim a bounded task in the ledger with your agent/session label and the files you expect to
   touch. Prefer a different task if those files overlap another active claim.
3. Preserve coherent changes you did not author. Never reset, checkout, or rewrite the shared
   dirty worktree to isolate your own patch.
4. Add or update focused regression tests with behavior changes. Record the exact verification
   command and result in the ledger.
5. Move a task to `ready_for_integration` only when its focused tests pass and `git diff --check`
   is clean. Move it to `done` only after its changes are present in the shared source and any
   required guarded binary refresh has succeeded.
6. If you discover a new request or regression, add it to the inbox before investigating so it
   cannot be lost across chats.
7. Maintain a persona/work-type mailbox in [`agent-collab/`](agent-collab/), check every mailbox
   before overlapping edits and integration boundaries, and leave signed questions in the owning
   persona's file. The central ledger remains authoritative for task ownership and release state.
8. If two tasks must touch one file, claim exact symbols/tests in both persona mailboxes before
   editing and name one integration owner. Do not run whole-file/global formatters while another
   persona owns any range in that file; format only released or explicitly owned ranges.
9. A handoff is not implicit. The current owner must mark its persona status and central-ledger row
   released (or name exact released symbols) before the next persona edits that surface.
10. Treat `docs/` as an append-only decision history. When a design or philosophy changes, keep the
    original statement in context and add a dated, signed **Evolving to** / **Superseded by** note
    beside it with the new contract and rationale. Do not silently rewrite history into consensus.
11. Mechanical corrections may edit false commands/paths, but the superseded design decision must
    remain traceable through an adjacent note or a linked migration/decision entry. Search all of
    `docs/` before changing a contract and record any intentionally deferred doc in your mailbox.
12. Integration review includes every changed file under `docs/`, not only code/tests. Resolve
    apparent contradictions through dated evolution notes; if two active designs still conflict,
    stop at the ownership boundary and ask in both persona files.
13. Reinforcing rule 10: treat product documentation as an evolving decision record. When a specification changes,
    retain the meaningful prior statement and add an adjacent dated **Superseded** or
    **Transition** note naming the replacement and rationale; do not silently rewrite history.
    Keep the current authoritative rule unmistakable, and record the change in the owning persona
    mailbox so parallel domains can reconcile against it.
14. Every independently spawned specialist/subagent is included in rule 7. Before substantive
    work or handoff it must create `docs/agent-collab/<work-type>.md` with its exact lease,
    decisions, questions, verification, and current release state. A parent transcript or summary
    does not replace that mailbox; parent and child must re-read new mailbox deltas at handoff.
15. Before every implementation handoff or integration claim, re-scan all files in `docs/` and
    every persona mailbox changed since the lane's previous checkpoint. Record the sweep in the
    owning mailbox, answer or route new cross-domain questions, and place the dated current
    contract beside the earlier wording wherever behavior or philosophy evolved. A green source
    test is not a complete handoff while its documentation history or mailbox questions are stale.

## Live-run safety

- The two existing Updog Small runs are forensic evidence, not refresh candidates:
  `019f5e99-95b4-7eb3-a2db-d9eac1f9ffda` and
  `019f616d-83f9-7e60-8d21-6a3d3c4bf7a9`, both targeting `harness-testing`.
  As of 2026-07-14 14:37 Phoenix, both approved runs have `orchestration.running: false`,
  `draining=false`, zero verified active agents, and no owned worker process. Their
  `lifecycle.yaml` values are planning-only gates and intentionally remain unchanged after
  approval. Do not resume either run after a guarded refresh.
- Safety recheck at 2026-07-14 15:23 Phoenix preserved that result: both orchestration files still
  say `running: false`, and no process command line is owned by either run ID. This supplements,
  rather than replaces, the 14:37 forensic boundary above.
- Safety recheck at 2026-07-14 after the cross-agent documentation sweep again found
  `running: false` in both forensic orchestration records and no process command line containing
  either run ID. No cockpit, binary, worktree, registry, or run-state write was performed.
- Source edits in this repository do not affect that run until the installed binary is replaced.
- `koni pause-run` may record graceful pause intent while agents are active; those agents must be
  allowed to drain to their durable boundary. Do not install a new binary, terminate the cockpit,
  resume the run, or replace the cmux surface until cockpit state confirms zero active agents.
- The Updog cockpit is on cmux `surface:97` in workspace `workspace:9`. Preserve `surface:46`
  (chat) and `surface:89`
  (another Codex session).
- A guarded refresh means: verify zero live agent processes, pause durably if needed, stop only
  the isolated cockpit process group, install, run `koni recover` and `koni validate`, reopen the
  same cockpit, then resume only if the run was previously active.
  **Safety transition — 2026-07-14:** Retain that earlier sequence as historical shorthand, but
  recovery is a state-changing repair, not a routine validation step. The current guarded flow
  always runs read-only validation after install and invokes `koni recover` only when inspected
  durable state proves a specific recovery is necessary. The two forensic runs above are never
  resumed, regardless of their pre-refresh history.

## Active task ledger

### 2026-07-16 live Medium acceptance transition — scoped receipt absence

`primary-integrator/root` owns the exact scoped-compile read-manifest helper and focused tests in
`crates/koni-core/src/engine.rs`. A graph-only `system.specify-contracts` ticket legitimately read
a planned-new schema path from reviewed `system.owned_paths`; after accepting its graph output,
scoped compilation failed because that future file was not yet present. The current repair binds
that exact absence only in scoped-compile receipts for non-executable ticket reads. Actual command
resolution remains strict, compiled proof sources must exist, symlink and exclusion checks remain
fail-closed, and no live state or binary changes under this source lease.

### 2026-07-16 live cockpit transition — event-driven redraw

`primary-integrator/root` owns only the redraw schedule/live-cue symbols and focused tests in
`crates/koni-tui/src/{app,model,ui}.rs`. The isolated live cockpit consumed roughly 100–140% CPU
while model children were idle because it rebuilt the complete populated dashboard at 10 fps for
one activity-color pulse. The replacement redraws immediately for worker events and terminal
input, polls both within 100 ms, animates only verified live-agent/provisional cues, and caps those
frames at two per second. Waiting, paused, and merely active run statuses do not animate. Apply the
same contract to the read-only showcase; do not refresh the live binary until the guarded run
boundary and integrated gates permit it.

| Task | Owner | Status | Expected files | Verification / handoff |
| --- | --- | --- | --- | --- |
| Adversarially review planned proof-source relocation authority and replay | relocation-security-review/root | source review complete; tracked verification hold | `docs/agent-collab/relocation-security-review.md` and append-only central findings only; inspect exact relocation symbols in `crates/koni-core/src/engine.rs` | Focus on mutation-before-validation, crash windows, replay/idempotence, graph/ticket/Git/preparation CAS, action-Journal ownership, path aliases, event spoofing, and ordinary-authority quarantine escape. No Rust/profile/test/live/binary/worktree/process/cockpit mutation. Early P0 retained as discovery history: committed complete steering authority once lacked no-transaction quarantine. Current source addresses the reviewed P0/P1 set; public Software lifecycle is 2/2, but Research/tracked phase and historical-checkpoint coverage remains required before release. |
| Label compact cache-excluding token headlines explicitly | token-accounting-ui/root | ready_for_integration; exact symbols released | `crates/koni-tui/src/ui.rs`: `draw_header`, `draw_runs`, a narrow compact-new-token formatter, and focused token rendering assertions only; append-only token-display notes in `docs/{control-center.md,tui-cleanup-backlog.md}`; `docs/agent-collab/token-accounting-ui.md` | Header and Runs now say `250K new tks`; canonical `RunSummary.new_tokens` arithmetic and the complete Overview breakdown are unchanged. Rustfmt and scoped diff checks pass. The exact focused Cargo test was dispatched but cannot compile until `primary-integrator/root` completes its separately leased three missing relocation symbols in `engine.rs`; rerun it at that compilable save point. No model/core/live/binary/profile/layout/cockpit mutation. |
| Prevent independent Software proof lifecycles from sharing physical source files | proof-source-profile/root | ready_for_integration | Software `graph.yaml`/`operations.yaml`; bundled Software `run-planner`, `change-designer`, and `reviewer`; shared `model-koni-work/references/software-projects.md`; focused assertions in `crates/koni-cli/src/templates.rs`; `docs/agent-collab/proof-source-profile.md` | The bundled graph now consumes generic `path_sets_disjoint`: diagnostic/risk-boundary sources are pairwise disjoint and disjoint from focused implementation sources. Source metadata, all graph producers, independent review, and the dated installed modeling reference explain that named tests in one physical file remain one authority boundary. Software template tests pass 4/4; a real Software compiler fixture passes 1/1; scoped Rust formatting and diff checks are clean. No Rust core/config/engine, live state, installed project, binary, cockpit, Research, or recovery surface changed. |
| Reject independently managed proof-source collisions before work and recover the preserved acceptance graph semantically | primary-integrator/root | in_progress | Generic `graph_constraints` IR/validation in exact `crates/koni-core/src/{config,engine}.rs` symbols; a separate journaled planned-proof declaration relocation transaction and focused tests in `engine.rs`; append-only coordination/design notes; no TUI/global install/product checkout mutation | The live compiler correctly rejected a focused implementation proof that shared the already prepared boundary proof's whole test file. Future profiles configure selector-driven `path_sets_disjoint` constraints. The existing quiescent run may change only the still-planned focused proof's `source_paths` and its one matching argv argument, bound to the exact failed compile journal/current graph/profile/Git/preparation evidence, then stage a full compile preserving deterministic ticket identity. The completed proof/ticket/file remain byte-identical. |
| Add a generic recursive node-field set-containment constraint | field-subset-constraint/root | in_progress | `FieldDef` and profile validation in `crates/koni-core/src/config.rs`; exact field-value validator range plus focused tests in `crates/koni-core/src/engine.rs`; `docs/agent-collab/field-subset-constraint.md` | `subset_of` is config-driven, valid only for compatible `list<string>` / `list<path>` fields, resolves its superset from the same root node, and rejects a concrete nested violation during graph validation before ticket dispatch. No profile YAML, runtime scope repair, TUI, live state, or binary authority. |
| Generic recursive node-field set containment — release transition | field-subset-constraint/root | ready_for_integration; exact symbols released | Same bounded config/engine/test/mailbox surfaces as the historical claim above, plus the narrow generic safe-schema projection requested during integration | `subset` **5/5**, all config tests **69/69**, broker-safe group **3/3**, core-lib warning-denied Clippy, config formatting, and scoped diff checks pass. Safe feedback retains node type, `oracle_cases[].seam_paths`-style schema shape, root field, and at most eight normalized project-relative paths while suppressing node IDs, arbitrary strings, and malformed/unsafe paths. No profile, recovery/grant, TUI, live-state, binary, or cockpit mutation. |
| Reconcile final proof/Pi runtime security holds against current shared bytes | final-runtime-audit/root | in_progress read-only -> review complete; isolated macOS acceptance eligible | `docs/agent-collab/final-runtime-audit.md`; inspection only of proof preparation, runtime containment, schema-2 migration, credential service/state, and production Pi composition | No source/profile/runtime/live-state authority. Current-source evidence and safe focused nonzero tests only; distinguish fixed bytes from unresolved architectural/release holds. **Final transition — 2026-07-14:** the frozen all-target workspace matrix passed 1,041/1,041 with 3 intentionally ignored on unchanged engine/containment/migration fingerprints. The former proof supersession split, descriptor-relative migration publication defect, credential-TCB decision, and packaged-source bubblewrap race are source-resolved for the documented macOS boundary. Retain explicit gaps for one real contained-host/compiler-broker composition proof, service-thread revocation acknowledgement, a persisted proof-topology regression, and arbitrary-same-UID launcher hardening if that stronger threat model is promised. Proceed only through a fresh isolated macOS acceptance run; never migrate or reinterpret the protected forensic runs. |
| Retire completed retained ticket authority before reopening the same deterministic ticket ID | deterministic-ticket-reopen/root | ready_for_integration (formerly `in_progress exact-symbol child lease`; scoped lifecycle release 2026-07-14) | Same-ID terminal reconciliation plus a narrow retirement/provenance helper and focused tests in `crates/koni-core/src/engine.rs` or `tests/run_lifecycle.rs`; append-only lifecycle notes in `docs/agent-collab/deterministic-ticket-reopen.md` and `docs/runtime-and-git.md` | Full compile currently archives `prior_cycles` but overwrites the terminal ticket with a fresh lease-less cycle while leaving the old managed worktree/branch, so the next start collides. The fix must prove exact completed integration and clean run/repository ownership, retire command-attempt authority, safely remove only that managed checkout/branch, remain replay-safe across interruption, and never delete ambiguous or unintegrated work. Exact Software stale-delivery rerun follows shared schema stabilization. No Research/Updog/TUI/Pi/profile/live-state mutation. **Later evidence — 2026-07-14:** the exact formerly failing Software stale-delivery case now passes 1/1 through a second cycle with the same ticket identity. Keep this row open for the generic retirement/recovery unit binary, the complete sixteen-case Software target, and one immutable-fingerprint rerun; the original collision remains the causal discovery, not the current test result. **Scoped release correction — 2026-07-14:** generic terminal reopen is 2/2 and the four lifecycle-relevant retirement/recovery cases are 4/4; the full Software and immutable integration matrices remain separate. |
| Replace Codex completely with a direct, Koni-owned Pi SDK runtime | pi-runtime-architect/root coordinating pi-sdk-host, pi-schema-migration, and pi-runtime-verification | in_progress | New Pi host/protocol/auth/event modules; exact Codex runtime/model/MCP call sites; exact schema-2 persona/runtime fields and migration; exact CLI/TUI auth/event/control surfaces; `docs/pi-runtime.md` and append-only evolution notes | Pi is the only post-migration runtime; `.koni` schema 2.0 and subscription OAuth-only are locked. Active Codex runs archive rather than resume. Rust retains compiler/tool/Git/security authority. This lane must not alter active generic graph/proof, Software-design, released TUI presentation, installed binary, cockpit, cmux, Updog, or forensic live state. Full host/Rust/CLI/TUI/profile/migration/docs matrix is required before release. See `docs/agent-collab/pi-runtime-architect.md`. **Compatibility transition — 2026-07-14:** transport replacement must preserve durable-replay-first, context-before-tool, exact grant/CAS, post-output supplement closure, and canonical `submit_and_compile` authority through the Pi broker adapter. The six context-hardening checks and new adapter adversarial cases rerun after cutover; every Pi child performs the all-doc/mailbox sweep before handoff. The earlier frozen matrix remains pre-Pi history and cannot authorize refresh. |
| Rebaseline Pi/schema-2 security after active composition and migration repairs | pi-runtime-security-review/root read-only + Pi domain owners | in_progress current-source security hold | Current `pi_runtime_process`, credential intent/service, host/provider budget path, and schema-2 publication/recovery; exact adversarial tests and immutable integration | **Transition — 2026-07-14:** raw launch exposure, scratch/diagnostic confinement, OAuth projection/browser fail-fast, state-machine wiring, wrapper error termination, concrete broker, credential intents, ancestor checks, schema-scoped transforms, opaque run proof, and an fsynced journal are source-addressed pending tests. Current blockers are independently pinned/race-free Node-host identity; cancellation of active private transactions when an intent ends; nonempty independently bound refresh account identity; exact usage-bucket consistency and an enforceable provider token limit (the pinned Codex builder drops `maxTokens`); authenticated compiler-owned recovery state with rederived destructive paths; handle-relative no-follow publication; and a run barrier through commit. No source-progress checkpoint authorizes install, migration, refresh, or forensic-run action. |
| Resolve the Pi credential trusted-computing-boundary contradiction | pi-runtime-architect/root + pi-runtime-security-review/root | blocked design decision before release wiring | `docs/pi-runtime.md` trust model; host/containment/credential architecture and adversarial proof | **Discovery — 2026-07-14:** Node is described as untrusted but receives raw OAuth access/refresh credentials and unrestricted outbound network during inference, so a malicious/substituted host can exfiltrate secrets outside every public-frame redactor. Either move provider auth/network behind a Rust-owned allowlisted proxy so Node never sees credentials, or explicitly include the pinned host/dependencies in the credential TCB and prove signed independent provenance plus race-free execution. The current PATH/sibling-digest artifact chain cannot support the latter. No Pi release, install, or migration proceeds until this philosophical and implementation boundary is coherent. |
| Disposition the recommended first-cut Pi credential TCB | pi-runtime-architect/root decision owner + security reviewer | proposed; architect acceptance and proof pending | Canonical threat model, independent release provenance, pinned host/SDK/Node dependency closure, packaging/update policy, runtime containment | **Recommendation transition — 2026-07-14:** current source has closed mutable PATH/environment/sibling-bundle discovery, but the fixed Node hash is still locally learned rather than independently authorized. Because Pi's Codex provider itself parses token/account data, constructs bearer requests, owns streaming/retry/compression, and performs login/refresh, a secret-blind Rust proxy would require a provider adapter or fork. Prefer explicitly placing the pinned host/SDK/Node closure in the credential TCB for the first cut, with signing/provenance, lockfile/SBOM/update policy, immutable packaging, and race-free execution. Keep Node outside compiler tool/graph/Git/filesystem authority. Active-transaction cancellation, usage/provider-limit truth, migration publication, and final-matrix gates remain separate. |
| Rebaseline Pi Node provenance and output-cap repairs | pi-runtime-architect/root + security reviewer | source-addressed; stable composed evidence pending | `koni-core/build.rs`, pinned runtime artifact/launch, host Codex payload budget, Rust usage reconciliation, real engine composition | **Later source transition — 2026-07-14:** Node is now selected and hashed at build time, embedded in Koni, reverified, then descriptor-staged/rehash-bound for launch; the remaining TCB gate is a trusted signed build pipeline because local build input is not independently authenticated. The contract is now `output_token_budget`, and the real Codex payload receives `max_output_tokens` with cross-tool-round allowance and source tests. Keep exact pinned-provider/composed evidence, Rust cache-write/visible-total and terminal-cap reconciliation, active-transaction cancellation, and a real engine caller for `PiRuntimeProcess` plus `DurableAgentToolBroker` open. |
| Close the staged Pi host's lazy OAuth dependency graph | pi-sdk-host/root + pi-runtime-architect/root | open packaging/credential-TCB P1 | Host build adapter/manifest, staged package closure, isolated auth smoke, signed provenance/SBOM | **Discovery — 2026-07-14:** upstream Pi's variable lazy `openai-codex` OAuth import survives the nominal single-file bundle and is used even for stored-credential `toAuth`. Production stages only the `.mjs` into scratch, so the module is unavailable; the current smoke exits at missing fd 3 before proving auth. Bundle the exact OAuth closure statically or manifest-pin every staged module, then force `toAuth`, refresh, and device-code login through fake fd 3/provider with no ambient `node_modules`. |
| Pin and minimize the Linux containment launcher boundary | pi-runtime-architect/root + runtime-containment owner | open definite Linux P0/P1 | `runtime_containment.rs` bwrap resolution/command, signed launcher provenance, minimal device namespace, adversarial containment tests | **Discovery — 2026-07-14:** Linux resolves `bwrap` through mutable PATH and passes it private fd 3; a fake launcher can skip isolation and exfiltrate credentials. Pin a root-owned/authenticated launcher and bind it race-free through exec, prove PATH substitution never receives fd 3, and replace `--dev-bind /dev /dev` with minimal `--dev /dev` absent an exact reviewed device need. |
| Reconcile Pi output-budget and usage authority in Rust | pi-runtime-core/root + pi-sdk-host/root | source-addressed; composed evidence pending | Active-turn output budget, host/Rust usage validation, pinned-provider and composed-process tests | **Transition — 2026-07-14:** Rust now binds `output_token_budget`, rejects cumulative output over cap, and rejects checked input + cache-read + output above total; the host checks before publication. Source tests cover cache-heavy valid, cap overrun, and former too-small total. Cache-write remains folded into total as an observability choice. Keep nonzero pinned-provider/composed verification, but do not continue advertising the earlier definite Rust undercount as current. |
| Repair the moving Pi visible-usage accumulator regression | pi-runtime-core/root | open definite source defect | `pi_runtime_state.rs` accumulator and exact first/cumulative usage tests | **Later regression — 2026-07-14:** `visible_total` currently adds `next.input_tokens` to the previous totals' cache-read/output fields, so a first inconsistent delta may pass. Use all `next` buckets, preserve overflow/cap checks, and rerun cache-heavy valid, first-delta-too-small, cumulative, and output-overrun cases before restoring source-closed status. |
| Rebaseline Pi OAuth/containment/credential/usage repairs after 19:35 save point | Pi runtime owners + security reviewer | mixed: source-addressed, one containment race remains | Static OAuth artifact, pinned/minimal bubblewrap, intent teardown, usage accumulator, exact signed/composed tests | **Current transition — 2026-07-14:** static OAuth adapter/dist and isolated auth smoke now exist; bubblewrap is build-digest-pinned and uses minimal `/dev`; revoked intents wake/abort within a bounded poll; usage sums all `next` fields and rejects underreported cache. Preserve the preceding defects as repair history. Source evidence/final signed composition remain pending. The definite residual here is hash-then-path `bwrap` exec unless it is staged/descriptor-bound or proven immutable root-owned; bounded intent teardown still needs acknowledgement semantics. Migration publication and missing production engine composition remain separate current blockers. |
| Freeze the Pi security save-point disposition | pi-runtime-security-review/root + pi-runtime-architect/root | review complete; security holds open | Reviewed hashes in `pi-runtime-security-review.md`; exact race repairs, TCB decision, signed/frozen composed matrix | **Final read-only verdict — 2026-07-14:** definite source blockers are bubblewrap hash-to-path exec identity and migration verified-then-pathname rename. The credential-TCB choice remains P0. Static OAuth closure, Node/host/bwrap build pins, bounded credential teardown, output/usage, compiler-owned/rederived migration journal, and run guards through apply are source-addressed/test-pending. A production Pi process/broker caller now exists, superseding “missing,” but is integration-unreleased until one compiler-grant -> contained process -> fd-3 intent -> broker -> terminal receipt adversarial proof. No install/migration/live action is authorized. |
| Adapt the durable tool grant to a Koni-owned direct Pi host | pi-direct-broker/root | ready_for_integration; claim and provider-neutral dispatch checkpoints released | Released `engine.rs` direct-Pi claim/revalidation adapter plus concrete broker/tool catalog in `crates/koni-core/src/agent_tool_broker.rs`, minimal exports, and `docs/agent-collab/pi-direct-broker.md` | `claim_agent_runtime_grant` returns the process-bound ingress. `DurableAgentToolBroker::new(ingress, trusted_context)` owns it, requires exact session/run/agent/attempt/host identity before inspecting each call, validates the compiler-issued role schema before dispatch, reuses `execute_agent_mcp_tool`, preserves safe/minimal model results and the three-strike validation stop, and exposes ordered `RuntimeToolDefinition`s through `runtime_tools()`. Focused broker tests pass 6/6; scoped formatting/diff checks are clean. No CLI/profile/live-state mutation. |
| Restore shared compilation after the first Pi runtime foundation checkpoint | pi-runtime-core/root | in_progress Pi integration/security gate; original Serde blocker resolved | `crates/koni-core/src/agent_runtime.rs` Serde wire contract and focused runtime/compile tests; owner mailbox transition | **Discovery — 2026-07-14:** `RuntimeResponse` uses internal tag `response` while `Completed` also owns a field named `response`, which Serde rejects at derive time and currently stops unrelated Software/CLI verification before tests execute. The Software owner reported the failure without crossing the lease. Pi core must choose an unambiguous stable wire tag/field, add exact serialization/deserialization coverage, restore shared compilation, and publish the save point before downstream lanes resume. This is not evidence against Software behavior and authorizes no cross-lane source edit or live mutation. **Resolution beside discovery — 2026-07-14:** current source uses the unambiguous `kind` tag, has exact wire tests, and restored shared production compilation. Pi remains unreleased for later composition/security gates—trust-root and rehash-to-exec identity, terminal/error teardown, operation-scoped credential authority, token-accounting semantics, migration hardening, and the final integrated matrix—not for this closed Serde collision. |
| Preserve documentation decision history across parallel spec evolution | primary-integrator/root coordinating domain owners | in_progress ongoing (earlier audit ready; new compiler/Software/Pi deltas active) | Every changed file under `docs/`; domain owners retain their current file leases | **Earlier audit state retained:** architecture/maturity were already annotated while Configuration/Codex/philosophy, Control Center, Getting Started, Runtime/Git, Research/live-smoke, and central-status transitions still had assigned findings. **Prior closure — 2026-07-14:** all eight definite findings and both audit follow-ups were reconciled and independently accepted for that save point. **Current transition — 2026-07-14:** compact Activity and generic mutation/exit/status history are closed; Software's frozen topology/product-doc transitions exist but await final reviewer/test disposition; review-effect/preparation/path/checkout records are still moving; Pi/schema-2 requires append-preserved Codex-era product-doc transitions and every Pi lane's protocol-15 sweep. A source-green handoff is incomplete while any owning mailbox/doc status remains stale. |
| Append Pi/schema-2 transitions beside Codex/schema-1 product documentation | pi-product-docs-transition/root | complete; exact product-doc lease released | `docs/{architecture,codex-resources,configuration,control-center,getting-started,maturity,migration,philosophy,runtime-and-git}.md`; `docs/agent-collab/pi-product-docs-transition.md` | Preserve every schema-1/Codex passage as executable pre-cutover/read-history context; append the unreleased Pi/schema-2 target, no-fallback migration boundary, security/publication/frozen-matrix holds, and credential-TCB decision beside affected passages. Also append the typed-global-preparation in-progress note beside Configuration's older boolean-only boundary. **Handoff — 2026-07-14:** all nine product docs now carry the adjacent transition, three broad gate summaries are narrowed beside their history, and Configuration records the moving typed prepared-source API without calling it released. Path-scoped diff/trailing-whitespace checks pass. No central/source/profile/test/binary/live-state authority belonged to this lane. **Release-candidate supersession — 2026-07-14:** preserve that unreleased-target handoff as causal history; a follow-up append-only pass now records current source as the schema-2/direct-Pi release candidate, with the exact pinned Koni Rust + bundled host/Pi SDK 0.80.7 + official Node 22.19.0 credential TCB, Rust-only compiler/project authority, no production Codex fallback, macOS networked support, and Linux networked login/inference fail-closed pending destination-allowlisted egress. Source release status does not itself install, migrate, authorize credentials, or start live work. All nine documents passed path-scoped diff and trailing-whitespace checks, and the lane is released. |
| Re-audit repository-wide documentation history during active Software/compiler/TUI evolution | docs-history-audit/root + product-docs-scan/root (read-only child) | complete (formerly `in_progress`; signed read-only handoff) | `docs/agent-collab/{docs-history-audit,product-docs-scan}.md`; read-only inspection of every file under `docs/` | **Audit transition — 2026-07-14:** released context and TUI history is accepted. Three released-doc gaps were append-corrected by the integrator; active Software/compiler completion, authority, status, and missing-specialist-mailbox findings are routed to their owning mailboxes and remain release gates. The original audit claim remains visible here as status history; no source/profile/live-state mutation belonged to the audit. |
| Adversarially review the generic graph-set/compiler TDD implementation | graph-tdd-engine-review/root | complete (graph-TDD and review-effect P1s source-closed; final matrix pending) | `docs/agent-collab/graph-tdd-engine-review.md`; read-only inspection of generic compiler source/tests | **Audit history retained:** multi-anchor, composite-parent, rule-anchor, step-scope, source-preservation, local-executable authority, current-child freshness, constructors, compatibility, and diagnostics were all initially open. **Final scoped verdict — 2026-07-14:** each graph-TDD finding is dispositioned and current `graph_check_set` passes 6/6; the audit explicitly does not release the whole engine. Complete review-effect selection/target provenance and the generic two-effect replay/no-op proof remain separate P1 gates. The current Software target is 4/6 for two Software-owned evolving expectations. No source/profile/live-state lease belonged to this audit. **Later current-source resolution — 2026-07-14:** both named review-effect P1s are now closed: both replay states validate canonical pre-effect input, and a profile-validated Software operation proves two-effect apply-once, zero-write replay, omission rejection, and drift rejection. Retain the owner-reported 1/1 in the final immutable matrix; cross-ticket preparation and crash-journal hardening remain separate. |
| Review generic review-effect replay and idempotence semantics | review-effect-semantics/root | complete (historical verdict superseded for current review-effect status) | `docs/agent-collab/review-effect-semantics.md`; read-only inspection of review-effect engine/config/state/tests | **Verdict transition — 2026-07-14:** the earlier field-presence defect is narrowly fixed by value-exact replay and the Software path is real. Generic release still requires (1) exact complete selected-node/target-universe provenance rather than subset validation and (2) a generic two-effect first-apply/second-no-op regression, including omitted-member rejection. Mutation-before-mismatch is contained P2 hardening; crash recovery is a separate storage-reliability gate unless crash-safe atomicity is claimed. No source/profile/test/product-doc/central/live-state edit belonged to the audit. **Later current-source resolution — 2026-07-14:** the independent boundary audit verifies complete-universe provenance, canonical review input in pre/post states, and the valid configured two-effect/no-op/omission regression. Those two P1s no longer block current source; their acceptance tests still belong in the final stable-fingerprint rerun. |
| Re-audit review-effect v1.1 after complete-selection hardening | graph-tdd-engine-review/root | complete read-only disposition; review-effect P1s closed, wider release still gated | Current `ReviewEffectApplication` v1.1 and replay/validation paths plus focused unit/config/runtime tests; no source lease | **Later transition — 2026-07-14:** the strict-subset half of the earlier P1 is closed: the envelope binds complete sorted candidates, pre-node snapshots/hash, declaration-ordered effects, exact post hash, clone/swap replay, and omitted-member rejection. Two gates remain. Effect-bearing acceptance must recompute the canonical review input from reconstructed pre-effect state and match `binding.input_hash`, including target-only drift. The existing two-effect unit test exercises mechanics but mutates an already compiled Research profile after validation, so a genuinely profile-validated configured/runtime two-effect first-apply → exact no-op → omission regression is still required. Current verdict: `strict_subset_implementation_closed; current_review_input_P1_open; valid_generic_regression_gate_open`. **Superseding disposition — 2026-07-14:** both remaining cases are now implemented and independently source-accepted, with owner evidence 1/1. The full compiler remains gated by moving prepared-source authority, Pi integration, and an immutable whole-project rerun rather than by review-effect v1.1. |
| Adversarially review the Software 0.4 profile design | software-design-review/root | in_progress (pre-disposition verdict published; read-only audit) | `docs/agent-collab/software-profile-design-review.md`; read-only inspection of Software profile/prompts/presets/tests/docs | **Audit transition — 2026-07-14:** the first 6/6 happy/adverse lane does not cover write-capable causal diagnosis, bounded proof replacement, deferred shared boundary proof, per-defect Bug Fix closure, same-objective mitigation routing, or source/production-write disjointness. **Later gates:** the Bug Fix preset must not author nonexistent `localization_status` or a speculative pre-diagnosis change; stale `candidate_ready` revision must read/write the one existing delivery and preserve its identity; conditional diagnostic/boundary preparation needs cross-ticket compiler binding. Seeded-decision ceremony, routine duplicate execution, non-Bug-Fix defects, and critical-review authority also require disposition. Final verdict and expanded matrix remain pending; no product/profile/test/central/live-state edit belongs to this audit. |
| Make the approved living-spec seed visible at the human approval boundary | context-spec/root (released semantic contract) + tui-polish/root (released Plan presentation) | ready_for_integration | `approval_draft`, bounded Graph Seed extraction/projection helpers and focused tests in `crates/koni-tui/src/model.rs`; narrow compact/post-approval render regressions in `crates/koni-tui/src/ui.rs` | Seeded Review Plan and approved Plan now show total counts, 6/12/16 bounded semantic facts, and explicit omissions while hiding local keys, IDs, hashes, paths, structured/raw spec/schema, and storage metadata. Seedless runs retain the prior three sections. Approval suite: 23/23; full TUI: 279/279; formatting/diff checks clean. No install or live mutation. |
| Harden the human Graph Seed projection against adversarially wrapped metadata | primary-integrator/root + graph_seed_review/root (read-only verdict) | ready_for_integration (formerly an integration blocker) | Released Graph Seed sanitization helpers and narrow adversarial tests in `crates/koni-tui/src/model.rs` only; the separate TUI truthfulness range is also released | **Earlier audit retained:** relationships could reveal omitted nodes; wrapped identifiers, embedded local keys, scalar schema/spec metadata, and post-approval lookalikes could evade the first projection. **Resolved 2026-07-14:** endpoint labels are limited to the 12-node projection, fail-closed sequence/substring/key filtering covers those cases, and seed lookup is planning-stage-only. Graph Seed 7/7, approval 25/25, approved Plan reuse 1/1, and integrated TUI 288/288 pass; formatting/diff checks are clean. No live mutation. |
| Reconcile TUI operator docs with the latest transcript-audited constraints | tui-docs-sync/root | ready_for_integration | `docs/control-center.md`, `docs/tui-cleanup-backlog.md` | Current behavior remains authoritative; all meaningful replacements now retain adjacent dated history, including Configure publishing and Runs/New Run keys/base-target behavior. Tracked/no-index whitespace checks and stage-history adjacency check pass; no source/live mutation. |
| Persist approved unpaused runtime; show it in Recent Activity header; timestamp every row | primary/root | ready_for_integration | `crates/koni-core/src/control.rs`, `crates/koni-core/src/engine.rs`, `crates/koni-tui/src/ui.rs` | Focused core and TUI tests pass; full TUI suite passed before later edits. Await guarded refresh. |
| Equal dashboard columns; unified `Details: Overview - Plan - Stages`; vertically composed Objective/Run/Evidence; approved human Plan document | primary/root | ready_for_integration | `crates/koni-tui/src/model.rs`, `crates/koni-tui/src/app.rs`, `crates/koni-tui/src/ui.rs` | Full TUI library suite: 272 passed. Await guarded refresh. |
| Replace the two Review Plan actions with one adaptive Approve/Revise action | primary/root | ready_for_integration | `crates/koni-tui/src/model.rs`, `crates/koni-tui/src/app.rs`, `crates/koni-tui/src/ui.rs` | Approval-focused suite: 19 passed. Await guarded refresh. |
| Insert a provisional Runs row immediately after Start Planning and reconcile it with durable snapshots/failures | primary/root | ready_for_integration | `crates/koni-tui/src/model.rs`, `crates/koni-tui/src/app.rs` | Immediate row, refresh retention, durable replacement, and failure cleanup are covered by the full TUI suite. Await guarded refresh. |
| Preserve inactive Lead slices in Agents history just like inactive ticket personas | primary/root | ready_for_integration | `crates/koni-tui/src/model.rs` | Projects one stable semantic Lead row across active/between-slice states, keeps its current transcript, and suppresses raw per-slice Lead duplicates. Full TUI suite passed. Await guarded refresh. |
| Audit user-authored TUI constraints and continuously polish live smoke-test presentation | tui-polish/root | in_progress (compact Activity title released; next source slice unclaimed) | Released Evidence/runtime, Graph Seed, blocker-reason, Review Plan, compact Activity title, ticket-presentation, New Run, and ticket-terminal ranges remain untouched; read-only smoke watching continues | **Transitioned 2026-07-14:** the former green-`HEALTHY` candidate remains in history. Current Evidence is trivalent and runtime fail-closed. The blocker-reason boundary remains released at 292/292; Review Plan followed at 293/293. **Later status transition — 2026-07-14:** the compact Activity claim is now independently accepted/released at exact 1/1, Activity 6/6, and full locked TUI 294/294; its earlier unclaimed and active states remain in the dedicated audit/row history. No runtime authority, lifecycle, layout, install, cockpit, cmux, Updog, or live mutation entered it. |
| Make compiler-issued producer contracts first-shot complete after the live plan-change retry loop | primary/root | ready_for_integration | `crates/koni-core/src/engine.rs`, `crates/koni-cli/templates/software/{graph,operations,workflows}.yaml`, software Codex persona templates, focused context/template tests | Compact contract now carries config-derived field descriptions/item types, required-any groups, and legal outgoing edges. Default producers use exact path/node vocabulary and must materialize material risk/proof nodes. Focused core, bundled-template, and Updog profile tests pass. Await guarded refresh/fresh-run proof. |
| Preserve human plan-revision steering in the approved planning contract | primary/root | ready_for_integration | `crates/koni-core/src/engine.rs`, focused planning-context tests | Latest revision steering is now compiler-hashed in `ApprovedPlanningContext.revision_steering`, projected as `human_revision_steering`, and absolute-path scrubbed before downstream prompts. Both focused tests pass. Source-only until shared integration. |
| Compile approved plans into graph-backed living specifications and scoped agent context | context-spec/root | ready_for_integration (formerly `in_progress`; source/docs released 2026-07-14) | `crates/koni-core/src/{catalog,config,control,engine,state}.rs`, `crates/koni-cli/src/{agent_mcp,main,templates}.rs`, bundled Software/Research profile and agent templates, context/profile tests, context documentation | Planning seeds, deterministic initialization/recovery, authoritative spec slices, steering, advisory notes, bounded graph tools, supplement receipts, composite worker submission, and compatibility-safe control lookup are implemented. Focused context/registry tests, Research result contracts 4/4, and conclusions 3/3 pass. The released CLI/TUI checkpoints remain 61/61 and 288/288 as causal history; after concurrent Software/TUI additions stabilized, the current shared suites pass CLI 62/62 and TUI 292/292. Historical unrestricted core was 434/3/3 before the separately owned Research fixture repair; after that repair, final context-first/receipt/anchor hardening, and the concurrent graph-set integration, the current full core is 450/0/3 (three intentional ignores). No install or live Updog mutation. |
| Keep the bundled Research context action on the living-spec section contract | context-spec/root | ready_for_integration (narrow post-release compatibility fix) | Exact `context.compile` include list in `profiles/research/actions/research.yaml` and its CLI template mirror; one focused assertion in released `crates/koni-core/tests/research_result_contracts.rs`; adjacent configuration/history and coordination notes | **Resolved 2026-07-14:** Research now preserves all legacy context sections, including `steering`, and explicitly adds `spec_slice`, `intent_updates`, and `working_memory`; the source/template action files are byte-identical. The focused assertion and full result-contract suite pass 1/1 and 4/4, recursive Research parity passes 1/1, formatting/whitespace checks pass, and the pinned-run compatibility note is retained. No compiler, Software, TUI, install, or live-run mutation. |
| Close late graph-supplement receipts after a legacy output is accepted | context-spec/root + graph-note-hardening/root (read-only finding) | ready_for_integration (narrow broker CAS hardening) | Only `validate_agent_broker_one_way_cas_with_product` and its existing focused CAS regression in `crates/koni-core/src/engine.rs`; adjacent configuration/Codex history and coordination | **Resolved 2026-07-14:** exact supplement receipts replay before the one-way gate, but a new `graph_context`/`record_note` request is rejected once `submit_output` has frozen `accepted_output_hash`; the composite path remains atomic. The focused CAS regression passes 1/1 and proves both resource types close without weakening submit revision/compile replay. Active graph-set compiler symbols are disjoint; no profile/TUI/install/live mutation. |
| Require compiler-issued context before any worker graph or output action | context-spec/root + profile-contract-audit/root (read-only finding) | ready_for_integration (narrow broker ordering hardening) | Same disjoint `validate_agent_broker_one_way_cas_with_product` claim and focused broker CAS regression in `crates/koni-core/src/engine.rs`; adjacent context interaction docs/coordination | **Resolved 2026-07-14:** every new non-`context` worker request requires a successful context receipt, while exact historical receipt replay remains first for crash/compatibility recovery. The focused 1/1 CAS regression proves `graph_context`, `record_note`, `submit_output`, and `submit_and_compile` all fail before context and the normal/revision/composite paths remain available afterward. Software's conflicting prompt wording is routed to its active owner. No Lead/profile/TUI/install/live mutation. |
| Fail closed when a ticket's mandatory living-spec anchor is missing | context-spec/root + seed-runtime-audit/root (read-only finding) | ready_for_integration (narrow spec-slice hardening) | Only `build_ticket_spec_slice`, `model_facing_context_node` direct regression coverage, one stale manual fixture correction, and adjacent coordination/history in `crates/koni-core/src/engine.rs`/docs | **Resolved 2026-07-14:** target/read/write anchors are deduplicated then validated before the budget; missing nodes fail closed. Direct tests pass 2/2 for missing-anchor rejection, anchor-first/root-sibling behavior, and raw seed hash/count projection. The preexisting review-rework fixture no longer declares its future new interface as a pre-context anchor and passes 1/1. Active graph-set compiler symbols are disjoint; no profile/TUI/install/live mutation. |
| Read-only final documentation closure audit for graph-backed living-spec context | context-docs-closure/root | complete (**ACCEPTED**) | `docs/agent-collab/context-docs-closure.md` plus this narrow registry row; read-only inspection of product docs and implementation | One P1 generic lifecycle-order shorthand was preserved and corrected by an adjacent dated Runtime/Git note. Final audit accepts seed -> bounded bundle/spec slice/intent/working memory -> graph resources/advisory notes -> supplement binding -> context-first/late-supplement-closed composite submission, with old contracts retained as history. Core 450/0/3, CLI 62/62, TUI 292/292, Research 3/3 + 20/20 + 4/4; scoped whitespace checks clean. No product-source/profile/install/live-state mutation by the audit. |
| Preserve caller repository identity in optional compatibility control lookup | context-spec/root + compat_registry_audit/root (read-only verdict) | ready_for_integration (formerly an integration blocker) | Narrow `existing_run_control_store` repository-identity check and focused corruption/membership regressions in `crates/koni-core/src/engine.rs`; absence-only/symlink-safe lookup in `state.rs`; coordination docs | **Resolved 2026-07-14:** the helper retains the caller Git identity, requires exact caller/resolved common-directory equality, and propagates invalid redirects. `optional_run_control_store_rejects_a_cross_repository_registry_redirect` passes 1/1; the context/note regression proves all three optional callers reject a missing run once a modern registry exists. Absent registries remain non-mutating; present registries retain the symlink-safe lock/read boundary; existing membership and malformed state stay fail-closed. The broader creating behavior of strict `ProjectRegistryStore::run` remains intentionally outside this slice. |
| Compile deterministic graph-local proof/test sets from repository-relative filepath metadata | compiler-graph-tdd/root | in_progress (graph-TDD/review-effect scopes released; global prepared-source gate moving) | Exact generic symbols in `crates/koni-core/src/{config,state,expr,engine,verification}.rs`, focused core tests, `docs/agent-collab/compiler-graph-tdd.md`, and generic docs after behavior passes; no bundled Software/Profile files | Software accepted the opt-in `kind: composite` + `graph_set` interface. Red/green preservation, multi-anchor rule identity, output-first aggregate readiness, exact destination replay, step scope, execution-bound source preservation, local-executable authority, currentness, and legacy omission pass **6/6 generic graph-set** and have a signed scoped engine release. **Moving Software checkpoint:** earlier 6/6; current 4/6 for two Software-owned evolving expectations while all four proof/compiler cases stay green. Released specialist records exist for config/state/expression, verification, and integration tests. Whole generic release still requires complete review-effect selection/target provenance plus the two-effect replay/no-op test, rejection of proof-source/production-write overlap, docs, and the frozen matrix. No install or live-run mutation. **Later scope correction — 2026-07-14:** review-effect provenance and the configured two-effect replay/no-op case are now source-closed. The current compiler blocker is the separately leased global prepared-source authority: declaration agreement, source-only operation authority, tracked/Git-common predicate evidence, emission and lease admission, Software consumption, and the final immutable matrix. |
| Bind source-only proof preparation across later implementation/proof tickets | compiler-graph-tdd/root (generic primitive) + software-default-design/root (profile consumer) | in_progress implementation under adversarial review; not released | Generic compiler-owned preparation binding and exact regressions; Software conditional diagnostic/boundary proof-preparation workflow; coordination/product docs after behavior stabilizes | A new diagnostic or boundary proof may need a source-only preparation ticket before product work. Intra-ticket source preservation is insufficient across later tickets because covered product bytes must legitimately change while proof/oracle source must not. Bind proof identity, command/cwd, purpose/subjects, baseline/oracle, approving review, and exact source manifest; permit covered-product changes, invalidate source/semantic churn, and deduplicate shared-proof preparation. Until this passes absent-source diagnostic/boundary cross-ticket regressions, Software must not claim cross-ticket oracle immutability or release its assurance contract. No Research/Updog/TUI/install/live mutation. **Implementation transition — 2026-07-14:** an optional operation declaration, typed current-binding enumeration, and both emission-time and lease-time overlap checks are actively landing. Release remains blocked on real tracked/Git-common predicate coverage, exact declaration equality, canonical review/execution provenance evidence, and proof that a nominal preparation operation carries only the exact selected source grants—never disjoint literal/product grants—plus the full equality/containment/late-binding/retry matrix. |
| Prevent Software diagnosis from invalidating the preparation it newly requires | software-default-design/root consumer + proof-preparation reviewer | open pre-rerun semantic gate | Software Bug Fix preparation targets/rules and exact bootstrap regression; no generic weakening | **Discovery — 2026-07-14:** preparation may bind the full defect node before diagnosis, while diagnosis then adds causal fields and `diagnosed_defects` requires `proof_preparation_current`. Full-node semantic hashing can revoke the preparation at that boundary and create a cycle. Exercise the exact bootstrap path; prefer proof-only preparation targets with the defect as read/topology, or an explicit stable subject projection. Preserve generic relevant-subject drift rejection and prove the intended diagnosis evolution is the only excluded change. |
| Recheck Software diagnosis after proof-only preparation targeting | software-default-design/root consumer + proof-preparation reviewer | source-addressed; exact stable regression pending | Diagnostic preparation target/predicate and Bug Fix bootstrap/product-mutation regression | **Later transition — 2026-07-14:** current Software removes the defect from preparation targets/currentness while retaining it as read/topology; the focused Bug Fix case asserts diagnosis does not re-prepare and continues to mutation/promotion. Runtime declaration equality and config no-panic handling are also source-addressed with units. Preserve relevant proof/risk drift reopening and do not close the broader prepared-source `other_grants`, historical boundary, dual-admission, or immutable-matrix gates. |
| Freeze and prove the source-closed global prepared-source contract | proof-preparation-binding/root + compiler integrator + Software consumer | source-closed by current-byte review; immutable evidence pending | Stable review-boundary/predicate/authority/admission units and full Software/tracked Git-common matrix | **Current rebaseline — 2026-07-14:** schema-1.3 historical review binding, receipt/argv/source replay, runtime declaration equality, typed no-panic config errors, complete source-only grant purity, emission plus persisted-lease admission, and diagnostic proof-only targeting are source-addressed. Scoped owner evidence is preparation 8/8, exact conflict 1/1, and source authority 2/2. Final release still needs one shared fingerprint mapping every original dimension, including unrelated growth/relevant drift, multiple-current/shared paths, newest failed/stale attempts, exact Bug Fix progress, and full Software integration. |
| Unify preparation predicate and global-lock supersession semantics | proof-preparation-binding/root + compiler integrator | open definite current source defect | Shared latest-attempt selector/key, boolean predicate/global binding, stale/different-target regression | **Later finding — 2026-07-14:** the predicate filters to its expected target universe before choosing newest, while the global source lock supersedes per operation/source across universes. A newer failed/stale `[proof, subject]` attempt can remove the lock while an older `[proof]` predicate still returns true. Choose one latest attempt first for both paths, then validate expected targets, and prove boolean currentness and lock presence never diverge under topology growth/reversion or multiple predicate owners. |
| Reject proof-source authority that aliases production-write authority | proof-path-disjointness/root (same-ticket validator) + proof-preparation-binding/root (cross-ticket bound-source interface) + compiler-graph-tdd/root (integration) | in_progress; same-ticket released, cross-ticket implementation under review | Generic ticket-emission provenance validator and equality/both-containment regressions; later-ticket comparison against required preparation binding's exact source paths/manifest | **Discovery retained:** a writable baseline/diagnostic harness must never overlap product write authority. **Current split — 2026-07-14:** when both grants coexist in one workflow, accept only an exact compiled-member `source_paths_field` projection and reject equality or containment either direction against every other concrete write grant; covered paths stay read-only. A separately prepared proof followed by a later implementation is not closed by that validator. The later ticket must compare its production grants with the compiler-owned preparation binding's source identity; graph status or Software edge inference is insufficient. Do not claim full disjointness until both same-ticket and prepared-cross-ticket regressions pass. **Later transition — 2026-07-14:** same-ticket equality and both containment directions are implemented and released 2/2. The typed cross-ticket closure exists in moving source but remains unreleased for the declaration/source-only-authority and dual-admission adversarial gates recorded in `proof-preparation-review.md`. |
| Select exact ticket-pinned graph-set members without inverse sibling fan-out | proof-preparation-binding/root (accepted narrow generic selector implementation) + compiler-graph-tdd/root (integration) + software-profile-regressions/root (consumer regression) | ready_for_integration for exact-member scope; wider preparation release pending | Narrow bare-`$target` direct-member selector in generic graph-set validation/compiler; two-sibling same-subject exact-execution regression; Software baseline/promotion selector update only after generic handoff | **Discovery transition — 2026-07-14:** the earlier inverse-traversal profile is safe but not live: two active proofs sharing one verified subject let `verified_by` discover a sibling outside ticket read scope, so compilation fails closed instead of executing exactly the pinned proof. Add a compiler-owned selector over exact ticket target members filtered by type/status. Do not widen sibling read authority, add self-edges, or duplicate proof-set nodes. Prove each sibling ticket selects/executes only its pinned proof and retains scope failure for unpinned nodes. **Ownership transition — 2026-07-14:** the active preparation specialist accepted this exact adjacent selector slice; bare `$target` is the generic root, with ordinary member filtering/scope/receipt behavior unchanged. No YAML workaround, install, or live mutation. **Evidence transition — 2026-07-14:** direct-target compilation passes 1/1 and the Software sibling cases each select and stamp only their pinned proof. This closes exact-member fan-out behavior but does not close global prepared-source provenance or the final full-suite rerun. |
| Diagnose Research regressions exposed by the broad graph-TDD integration run | graph-tdd-research-regression/root | complete (read-only diagnosis released; two generic repairs/reruns pending) | `docs/agent-collab/graph-tdd-research-regression.md`; read-only inspection of the two failing `research_profile.rs` paths and relevant generic engine/profile contracts | **Diagnosis transition — 2026-07-14:** neither failure is a Research profile change. Context idempotence regressed when `compile_context` selected the live workflow step containing its prior `context_hash`; restore selection from the sanitized context ticket while retaining new scope fields. The promotion case correctly detects an exact-value mismatch, but tracked post-effect replay reruns a pre-effect selector and leaks a zero-count error; it must fail immediately as stale/incomplete provenance without restoring presence-only logic. Exact tests and the full Research target remain required after owner repairs. No Rust/profile/product-doc/central/live-state edit belonged to this diagnostic lane. |
| Preserve sanitized validation diagnostics through the MCP retry ceiling | validation-diagnostics/root | ready_for_integration | `crates/koni-core/src/engine.rs`, `crates/koni-cli/src/agent_mcp.rs`, focused unit tests in those modules | Field-validation errors retain only their allowlisted node type and schema facts; the non-retryable three-call limit retains the final sanitized correction for recovery. Core broker-safe tests: 2 passed. CLI MCP module: 14 passed. Formatting and `git diff --check` pass. Source-only; files released, no install or live Updog mutation. |
| Stop ticket-step worker redispatch after two durable no-output sessions | worker-circuit-breaker/root | ready_for_integration | Narrow lifecycle/dispatch sections and focused tests in `crates/koni-core/src/engine.rs` | Third dispatch is refused and opens a compiler-owned ticket blocker from two terminal birth-identity-bound `AgentSessionRecord`s; preserved successful output resets the sequence, unrelated/stale rows do not count, and tracked recovery projects the exact runtime blocker without checkpointing failed product edits. Four focused tests, formatting, and path-scoped diff check pass. Source-only; engine released, no install or live Updog mutation. |
| Make fresh `koni init` select a built-in profile before writing | profile-init/root | ready_for_integration | `crates/koni-cli/src/main.rs`, focused CLI tests | TTY Software/Research picker and non-TTY explicit-source failure implemented before writes; fresh/replacement dry runs report the choice, while existing/legacy installs bypass selection. Six focused CLI tests pass; path-only `git diff --check` is clean. Source-only; binary/live run untouched. |
| Evolve the bundled profile-customization skills | profile-skills/root | ready_for_integration | `crates/koni-cli/templates/codex/shared/skills/configure-koni/**`, `crates/koni-cli/templates/codex/shared/skills/model-koni-work/**`, `crates/koni-cli/src/templates.rs` | Both skills pass `quick_validate.py`; embedded inventory matches all 18 packaged files; clean-context Software and Research forward tests respected the write boundary and produced repository/domain-grounded questions and designs; `git diff --check` passes. |
| Canonicalize and complete empirical-research run integration | research-profile/root | ready_for_integration | `profiles/research/**`, mirrored `crates/koni-cli/templates/research/**`, `crates/koni-cli/templates/codex/research/agents/{gate-designer,integrator}.toml`, focused research tests | One stored `gate.applies_to` edge now exposes inverse `gates`; every run size syncs, verifies, reports, and awaits guarded promotion; target-conflict work is graph-forbidden. Focused profile, canonical-edge, template/native-prompt parity, and bundled-install/catalog tests pass. |
| Fail closed on unsupported profile schema extensions | profile-schema/root | ready_for_integration | `crates/koni-core/src/config.rs`, focused config tests, malformed inline-scalar corrections in bundled/fixture workflows | Manifest/module/node/operation extensions and nested manifest, edge, query, rule, workflow/step, check, persona, report, and lifecycle definitions now reject unknown keys. Node command sources resolve against declared argv field contracts. 51 focused config tests and all 57 CLI tests pass. |
| Make software proof strategy adaptive and repository-owned | profile-config/root | ready_for_integration | `crates/koni-cli/templates/software/{profile,checks,graph,rules,operations,workflows}.yaml`, software run types, affected `crates/koni-cli/templates/codex/software/agents/*.toml`, focused template/profile tests | Default commands are graph-backed and repository-owned; change/migration work routes through six pinned registry entries and three distinct red-green, characterization, or current-verification workflows. Canonical inverse facts have one stored edge, proof argv is typed, and Small now has a post-target-sync verification barrier. CLI 57/57 and Updog profile 2/2 pass. |
| Align profile-selection and customization documentation | profile-docs/root | ready_for_integration | `README.md`, `docs/{getting-started,configuration,codex-resources,philosophy}.md`, `operate-koni/references/run-lifecycle.md` | Documents explicit init selection, installed-profile baselines, repo-aware proposal/approval customization, canonical relations, domain-specific proof, and the exact current compiler/reviewer baseline boundary. Audit corrections remove stale silent-Software-default wording, clarify dry-run selection and protected-resource replacement, and the edited skill validates. |
| Complete and inspect the live Updog Small TDD run | primary/root | paused_forensics | Updog run sidecar/worktrees only; no destructive operations | Graceful drain completed at 2026-07-14 13:20 Phoenix: orchestration is stopped, `draining=false`, and verified active agents are zero. Preserve this 16.0M-token / 91-turn run as evidence; its ticket still contains a stale worker lease for dead PID 705, which is not live activity. Await shared-source integration before any guarded refresh. |
| Reconcile research `terminal_resolver` profile field with compiler IR | profile-schema/root + research-profile/root | ready_for_integration | `crates/koni-core/src/config.rs`, `profiles/research/operations/research.yaml`, mirrored CLI template | `terminal_resolver` is now typed, hashed, shape-validated, unique, and required by single-resolver recovery compensation; the research resolver satisfies that contract and focused profile compilation passes. |
| Consume terminal-resolver recovery compensation at runtime | terminal_resolver_runtime/root | ready_for_integration | `crates/koni-core/src/engine.rs`, focused engine tests, `docs/AGENT_COLLAB.md` | Failed sources now block and bind to one deterministic typed resolver ticket/workflow; replay is state/event-idempotent, diagnostics are bounded, worktrees/product state stay untouched, and resolver failures suppress recursion. Two focused tests plus two explicit-recovery compatibility tests pass; source-only, no install/live-run mutation. |
| Enforce target-sync → verification → promotion catalog ordering | pipeline_verification_order/root | ready_for_integration | `crates/koni-core/src/catalog.rs`, `crates/koni-cli/templates/software/run-types/large.yaml`, narrow catalog/CLI tests | Promotion-enabled/target-bound pipelines require exactly one target sync, composed-verification checkpoint, and promotion in that order. Software Large verifies before independent review; Small/Medium already complied. All 27 catalog tests and the bundled-install contract pass; formatting/path diff checks are clean. No install or Updog mutation. |
| Reconcile full Research-profile regression suite | research_profile_regressions/root | ready_for_integration | `docs/AGENT_COLLAB.md` only; `crates/koni-core/tests/research_profile.rs` is formatted and released | Historical status retained: this row originally waited on the shared compile after a 19/20 pre-Git run. The shared suite now compiles and the exact Research profile passes 20/20, including the one-ticket lifecycle proof and current reserved-wrapper diagnostic. This does not claim the whole core library is green; its separate three runtime fixture failures remain tracked below. No install or live Updog mutation. |
| Reconcile released Research reserved-wrapper diagnostic assertion | primary-integrator/root | ready_for_integration | Exact assertion in `crates/koni-core/tests/research_profile.rs`; coordination docs | Retained history: the integrated suite was 19/20 for a stale wording assertion. The test now expects the newer joint `typed`/`context_supplements` compiler-reserved diagnostic without weakening its graph/output non-materialization checks. Exact test 1/1 and full Research profile 20/20 pass; file released. |
| Preserve one authoritative ticket lifecycle lane through squash integration | duplicate_ticket_lane/root | ready_for_integration | `docs/AGENT_COLLAB.md` only; `crates/koni-core/src/git.rs` is formatted and released | Historical status retained: this row originally waited on the shared compile after both focused Git tests passed. The integrated Research profile is now 20/20 and its exact one-ticket assertion confirms the duplicate lifecycle lane is gone. The released Git implementation still preserves unrelated allowed dirty paths and rollback restoration. No install/live mutation. |
| Bind promotion to the exact composed-verified product tree | verification_head_fix/root | ready_for_integration | Exact verification/reopen and target-sync drift-recovery ranges in `crates/koni-core/src/engine.rs`; narrow pending-reopen/abandon APIs and tests in `crates/koni-core/src/pipeline.rs`; narrow `crates/koni-core/tests/run_lifecycle.rs` regressions; `docs/runtime-and-git.md` transition note and coordination docs | Composed verification requires the exact synchronized run and target heads. Drift invalidates authorization before pipeline persistence, then reopens target sync as unbound Pending while retaining attempt history. A second ref move binds fresh inputs; stale Running bindings and Git CAS races return to Pending instead of stranding. Pipeline 9/9 and lifecycle 49/49 pass; no install/live mutation or context-spec overlap. |
| Bind target promotion CAS to the preflight run head | promotion_run_cas/root | ready_for_integration | `crates/koni-core/src/git.rs` is formatted and released; engine callsite landed by verification_head_fix/root | `TargetPromotionRequest` binds `expected_run_head`; promotion rejects a moved run ref under the repository lock before replay or target mutation. The exact moved-run regression passes 1/1 on the integrated core; Rustfmt/path diff checks pass. No install or live Updog mutation. |
| Repair Research conclusion-contract fixture inventory setup | research_conclusion_fixtures/root | ready_for_integration | `crates/koni-core/tests/research_conclusion_contract.rs`, `docs/AGENT_COLLAB.md` | The fixture now uses and actually reads a committed project-owned scientific input instead of excluded compiler config. Exact invalid coverage may fail at either pre-review transition or review entry while still proving zero reviewer calls/reviews. All 3 tests, formatting, and path-scoped diff check pass; files released. |
| Separate historical Research execution from composed-tree verification | research_verifier_contract/root | ready_for_integration | narrow `CheckDef` replay-policy additions in `crates/koni-core/src/{config,verification}.rs`; Research run-node/check/rule/operation/workflow contract and README; mirrored CLI templates; `crates/koni-core/tests/research_result_contracts.rs`; `docs/{configuration,AGENT_COLLAB}.md` | `scientific-runtime` remains current causal workspace-write evidence but declares `composed_replay: never`; the same ticket requires a distinct repository-owned read-only `scientific-result-integrity` command, and composed selection replays only that command. Gate tickets still replay `gate-verifier`; unannotated side effects fail closed. Replay-policy, exact experiment/gate selector, all 3 result-contract, and CLI recursive-parity tests pass; source/template mirrors, profile YAML compilation, rustfmt on owned Rust files, and full diff check pass. Global `cargo fmt --all -- --check` is temporarily red only on context-spec/root's active `engine.rs` formatting. Files released; no install/live-state mutation. |
| Reconcile the three stale Research runtime fixture bodies | primary-integrator/root + research-fixture-audit/root + research-fixture-review/root | ready_for_integration | Only the three named unit-test bodies in `crates/koni-core/src/engine.rs`; coordination/live-smoke history notes | **Resolved 2026-07-14:** each fixture now declares the distinct read-only integrity argv over every scientific input; the configured-step case executes and binds both ordered checks/receipts. The three exact regressions pass 3/3, result contracts pass 3/3, safe composed selection passes 1/1, and the full core library passes 438/438 with 3 intentional ignores. Independent semantic/scope review accepted the exact argv and causal-runtime/integrity separation and confirmed no production change. No install or live mutation. |
| Read-only composed-verification/promotion closure audit | research_verifier_contract/root | done | `docs/AGENT_COLLAB.md` only | Existing post-check head/product projection, report/seal, final target+run CAS, passing/exact receipt-set, retry, and Software/Research ordering repairs close their reported bypasses. One distinct pre-check target-sync/run-head race was filed in the inbox below. The three failing Research core tests are stale fixtures that omit the newly required composed verifier, not pipeline defects. No source, install, or live-state mutation. |
| Read-only exact-sync-head integration audit | research_verifier_contract/root | done | `docs/AGENT_COLLAB.md` only | The exact target-sync/run-head comparison and its normal/explicit-retry paths are fail-closed. Two definite reopen-state defects were filed below: stale authorization can survive split publication, and a second ref move can strand the reopened Running target-sync attempt. No source, test, install, or live-state mutation. |
| Read-only verification-head closure integration audit | promotion_run_cas/root | done | `docs/AGENT_COLLAB.md` only; read-only review of `crates/koni-core/src/{pipeline,engine,git}.rs`, lifecycle tests, and `docs/runtime-and-git.md` | No remaining state-machine bypass, generic weakening, or retry dead-end found. Pending reopen/abandon retains attempt identity without stale execution binding; dual-ref drift clears stale authorization before pipeline publication; CAS movement returns Running sync to unbound Pending. Pipeline 9/9 and lifecycle 49/49 pass. One definite documentation-only ordering mismatch is filed below. No source/install/live mutation. |
| Redesign the default Software profile around agent-effective engineering and add feature/bug-fix run types | software-default-design/root | in_progress (historical expanded 14/15; exact former failure now 1/1; full 16-case/final matrix pending) | Bundled Software profile/agents/run types/cockpit/report; Software-focused CLI template/catalog assertions and `software_proof_gate.rs`; `docs/{software-profile-engineering,architecture,maturity}.md`; released `configure-koni`/`model-koni-work` skill guidance; explicitly no Research, Updog-fixture, generic proof-compiler, or lifecycle/promotion edits | Evidence-Guided Vertical Delivery selected. **Checkpoint history retained:** template 7/7 and exact install/profile compile 1/1 were green at 3/5; real ordering reached 4/5; composite-parent/value-exact replay reached 5/5; sole-proof-authority plus linked-proof de-duplication passed 6/6; frozen topology first reached 8/9 and exposed the pre-merge checkout bug. **Current transition — 2026-07-14:** core compiles and the expanded fifteen-case target passes 14/15, including exact Bug Fix seed, all three proof strategies, physical covered-product mutation, prepared boundary sequencing, wrong-objective mitigation, and sibling exactness. The remaining failure is generic deterministic same-ID ticket reissue: second start finds the first closed attempt's managed worktree path. Cross-ticket disjointness, final review-effect/preparation specialist verdicts, one real Pi broker path, final design re-review, and Pi-era immutable integration remain external gates. No install or live Updog mutation. **Later evidence — 2026-07-14:** the formerly failing stale-delivery reissue now passes 1/1 with the same deterministic ID and a second managed cycle. Do not infer a full-suite release: the generic retirement units, sixteenth same-ticket overlap case, Software-configured Pi broker path, prepared-source admission/provenance matrix, final design audit, and one stable whole-project fingerprint remain open. |
| Software profile current release checkpoint | software-default-design/root | integration hold; historical 16-case wording superseded by a current 20-case target | Same Software files and focused matrix; no Research-profile ownership | **Append-only reconciliation — 2026-07-14:** the row immediately above remains the causal 14/15→16 history. The current test file contains 20 cases. Generic same-ID retirement is released 2/2 plus 4/4, the design audit retains Evidence-Guided Vertical Delivery at 5/5, the complete Bug Fix successor lifecycle is semantically green, and the configured durable-broker bridge has scoped evidence. Final release remains held on an operation-scoped, epoch-keyed successor/receipt evaluation context with deterministic bounded-work counters, then one immutable 20-case/broker/lifecycle fingerprint. This does not claim the broader Pi host/security cutover or modify Research. |
| Reissue one deterministic semantic ticket after its prior worktree attempt closed | deterministic-ticket-reopen/root + software-default-design/root consumer | ready_for_integration (formerly `in_progress verification after exact consumer green`; scoped lifecycle release 2026-07-14) | Ticket start/reissue and compiler-managed worktree retirement/reuse path in core/git; focused deterministic same-ID second-attempt regression; no Software profile workaround | **Discovery — 2026-07-14:** the expanded Software target now executes 14/15. After one exact delivery ticket finishes, closure growth correctly re-emits an in-place revision with the same deterministic ticket ID and exact existing-delivery scope, but second `start` refuses the stale compiler-owned worktree path left by the closed attempt. Reissue must preserve semantic ticket ID and prior attempt/audit history while safely retiring or validating/reinitializing only the compiler-owned worktree/branch; never delete an unmanaged path, invent a second delivery/ticket identity, or ask the profile/test to clean compiler state. Rerun the exact revision plus generic recovery/worktree tests before release. **Implementation evidence — 2026-07-14:** an exact owner and replay-safe retirement journal now exist, and the named Software regression passes 1/1. Generic clean/unintegrated/dirty/recovery unit evidence and the full sixteen-case/final-fingerprint reruns are still required before this row becomes released. **Scoped release correction — 2026-07-14:** the generic unit evidence is now 2/2 plus 4/4 lifecycle-relevant retirement/recovery; one post-successor exact consumer rerun and the broader Software matrix remain queued. |

| Final philosophical/semantic audit of Software 0.4 | software-final-design-audit/root | complete read-only verdict; new production-composition lease active | `docs/agent-collab/software-final-design-audit.md`; current Software profile/run types/prompts/skills and generic boundaries | **Final transition — 2026-07-14:** Evidence-Guided Vertical Delivery is retained; Software topology/prompts/run types score 5/5, proof/review integration 4/5, production runtime integration 3/5, overall 4/5. No P0 topology defect remains. P1 release evidence is one immutable prepared-source/full Software matrix and one real production-composed Software-through-Pi context/output/compile path. A later exact Bug Fix preparation/diagnosis circularity concern is now a consumer projection regression gate, not a reason to add phases or overturn the philosophy. The same mailbox now owns a bounded production-composition test; no provider/credential/profile/live-state authority transfers with it. |

## Ready or queued work

| Task | Owner | Status | Notes |
| --- | --- | --- | --- |
| Checkout-stable review provenance and actionable provenance stop | primary/root | ready_for_integration | Focused core tests passed; live architecture-ticket finish proved the repair survives a binary refresh. |
| Versioned bundled baseline plus project overlay upgrades | unclaimed | queued | Must preserve project-specific configuration during Koni upgrades; see authoritative audit item 6. |
| Research reciprocal gate-edge cleanup | research-profile/root | ready_for_integration | Folded into the completed research-profile slice: canonical storage, inverse traversal, authoring prompts, operations, workflows, and focused tests agree. |
| Keybinding convention stragglers | unclaimed | queued (Configure remainder) | **Prior combined wording retained:** “Approval/footer and Configure messages must use current lower-case/bracket conventions.” **Transition 2026-07-14:** the exact Review Plan title/footer presentation is separately claimed below; the unrelated Configure-copy remainder stays unclaimed. |
| Make Review Plan framing neutral and its plan-navigation help complete | tui-polish/root | ready_for_integration (formerly `in_progress`; before that authorized but unclaimed) | Released exact title/footer strings and focused 82×24 render assertions in `draw_approval_dialog` / `crates/koni-tui/src/ui.rs`, plus adjacent dated TUI documentation notes | **Released 2026-07-14:** neutral `Review plan`; exact 65-cell `←→/[] sections · ↑↓/jk/PgUp/PgDn scroll · Tab focus · Enter · Esc`; complete-literal compact assertion; old-title rejection. The immediately prior title/footer remain in docs history. Exact test 1/1, approval 26/26, full locked TUI 293/293; independent audit accepted and scoped checks clean. Presentation only: no approval state, key handling, action labels, focus, install, cockpit, or live-run mutation. |
| Exact native-Codex chat visual parity | unclaimed | queued | Current semantic transcript renderer is intentionally only Codex-inspired. |
| Legacy Review Plan projection without truncation | historical request | superseded | Retained for history: the later phase-aware Plan contract requires the complete human-readable Plan to remain wrapped and scrollable and explicitly supersedes a separate condensed legacy fallback. Do not reclaim the old truncation implementation. |
| Specific setup work labels | unclaimed | queued | Replace generic `Execute compiled work` during ticket setup with concise work state. |
| Durable stale-agent lifecycle reconciliation | unclaimed | queued | Exited workers can remain durably `running`; verified activity count is correct but the row remains a warning. |
| Adapt the Recent Activity title at the 82-column dashboard minimum | tui-polish/root + compact-activity-smoke-audit/root (read-only verdict) | ready_for_integration (formerly `in_progress`; before that implementation-unclaimed/queued) | Released title selection inside `draw_recent_activity`, adjacent private `recent_activity_title`, focused/full-dashboard `ui.rs` regressions, and dated TUI docs; no `active_runtime_label`, layout, row, Evidence, lifecycle, compiler, install, or live-state changes | **Released 2026-07-14:** measured full `Recent activity · 1h 02m active` → compact `Activity · 1h02m` → identity-only `Activity`; exact units and anchored zero survive, while an extreme suffix is omitted rather than clipped, clamped, or approximated. The old 27-column/25-cell clipping proof and interrupted pre-claim Cargo wait remain history. Exact 1/1, Activity 6/6, full locked TUI 294/294; independent review/sweep accepted and scoped checks clean. |
| Revalidate Evidence rows if a future transport bypasses typed compiler snapshots | unclaimed | queued architecture guard | Current cockpit snapshots inherit validated `Ticket.outputs` and `RunPipeline` rows, so the TUI may trust them. If an external/untyped snapshot transport is added, require compiler-completed step bindings and validated stage statuses before permitting green evidence. |
| Complete/scrollable New Run stage flow | tui-polish/root | ready_for_integration | Scrolls stable rendered rows rather than stage indices; every wrapped continuation is reachable at 82×20 without moving the active form control or hiding Start/footer. Focused New Run suite: 22 passed; path diff check clean. |
| Distinguish successfully closed tickets from cancelled/superseded terminals | tui-polish/root | ready_for_integration | `ticket_progress` retains its legacy no-board fallback only for successful terminal states; cancelled/superseded tickets remain terminal and suppress stale workers without synthesizing green completed steps. Focused regression plus adjacent closed/compiler-truth tests: 3 passed. Full TUI: 275 passed / 1 unrelated known compatibility fixture failure. |
| Make completed ticket rows concise and outcome-honest | tui-polish/root | ready_for_integration | Released `metadata_text`, `completed_step_summary`, `concise_outcome`, and focused tests. Completion glyph/name/persona remain, redundant literal `done` is omitted, nonterminal labels remain, and only recorded typed/file/receipt/graph/review outcomes render green; missing evidence renders muted `No outcome summary recorded`. Focused ticket suite: 22/22. Full TUI: 276/277, with only the pre-recorded unrelated compatibility-run NotFound fixture failing. |
| Keep Evidence and Recent Activity truthful before their authority anchors exist | tui-polish/root | ready_for_integration (formerly `in_progress`) | Released presentation-only `report_text`, evidence/report helpers, `draw_recent_activity`, `active_runtime_label`, and focused tests in `crates/koni-tui/src/ui.rs` | **Released 2026-07-14:** failures take `Attention` precedence; fully shaped, zero-exception compiler telemetry plus durable current proof yields basis-named `Evidence recorded`; everything earlier or partial stays neutral. A configured report or stale review is not proof. Recent Activity omits unanchored runtime and preserves approved numeric zero. Exact regressions execute 1/1; report 3/3, Activity 3/3, full TUI 288/288; independent review and scoped checks pass. Timestamp conversion remains separate. |
| Show the first actionable durable blocker in Ticket Overview | tui-polish/root | ready_for_integration (formerly `in_progress`) | Released Ticket-Overview blocker projection/render helpers and four focused tests in `crates/koni-tui/src/ui.rs`; adjacent dated TUI docs/audit notes | **Released 2026-07-14:** first-useful typed durable message order, fixed generic known-record labels, fail-closed ID/path/hash/raw-record/control-character sanitization, semantic-noise rejection, display-width hard wrapping, `+N more`, and count-only fallback are covered. Four exact tests pass 1/1, blocker projection 2/2, Ticket Overview 3/3, full locked TUI 292/292; independent adversarial review and scoped checks pass. The earlier count-only behavior and initial blocked review remain visible as history. Evidence, lifecycle, approval, compiler, install, and live state were untouched. |
| Default planning efficiency and first-shot producer instructions | unclaimed | queued | Audit any review/rework failure against the producer prompt first; minimize costly corrective passes. |
| Compile approved planning facts and scope decisions into initialization | primary/root (steering history) + context-spec/root | absorbed by active living-spec slice | Retained history: primary/root completed durable revision steering. The formerly unclaimed typed graph-seeding follow-up is now owned by context-spec/root's approved living-spec seed/context contract; do not create a duplicate lane. |
| Preserve typed validation diagnostics and stop repeated exhausted workers | validation-diagnostics/root + worker-circuit-breaker/root | ready_for_integration | Node type plus the final sanitized correction survive the retry ceiling; two durable no-output sessions open a ticket blocker before a third worker launches. Both owners released their files with focused tests, formatting, and diff checks green. |
| Make review rework checkpoint-aware and bounded | primary/root | ready_for_integration | The generic compiler now permits one corrective pass, then blocks after the second failed independent review while preserving the current rejected candidate and latest durable findings. Software ordinary rework reopens at `implement`, so the original red/characterization checkpoint remains causal evidence instead of being rerun against a green tree. Focused circuit and existing failed-review suites pass. |
| Require graph-bound proof and fresh composed verification after target sync | primary/root (historical split) + software_proof_gate/root + compiler-graph-tdd/root | in_progress (runtime folded into generic proof compiler); profile cardinality gate ready | **Earlier ownership retained:** the first repair split called the runtime slice `primary/root` and completed the Software zero-proof/exact-delivery profile gate. **Current transition:** the released generic `composite.graph_set` compiler lane now owns deterministic graph-bound execution/currentness and safe composed replay; Software 0.4 owns only its profile wiring. Final integration must prove every realized change has current canonical `verified_by` proof, exact reviewed coverage, post-sync replay, and promotion-grade receipt closure. No install or live mutation. |
| Prove every Software proof strategy end to end | unclaimed | queued | Add compiler tests for red receipt → green receipt → review effect → squash integration, plus characterization and current-verification paths. String/template assertions are insufficient. |
| Software proof-strategy queue reconciliation | software-default-design/root | implemented; immutable whole-matrix rerun pending | **Append-only transition — 2026-07-14:** the queued sentence above is preserved as the reason the executable cases were added. Red-green, characterization, and current-verification now each execute baseline evidence, product mutation where applicable, promotion/current receipt, configured review effect, and strict finish. The remaining gate is the generic successor-evaluation cost bound and a frozen full-matrix rerun, not missing proof-strategy behavior. |
| Make focused-check execution fully repository-native | compiler-graph-tdd/root | in_progress (folded into active graph-local proof compiler) | Graph-source argv, evidence/test-source paths, covered product paths, working directory, and expected baseline semantics compile into one exact receipt-bound execution contract rather than assuming root cwd and exit code 1. **Transition 2026-07-14:** this row originally waited for the context handoff; that handoff and Software interface acknowledgement are now complete, and implementation proceeds under the exact generic lease in the main compiler row above. |
| Compile material risk disposition into delivery gates | software-default-design/root | in_progress (folded into Software redesign) | Risk treatment will be structural: mitigation requires terminal change/migration plus passing risk proof; acceptance requires one reviewed accepted decision; delivery exact-acknowledges every introduced risk without trusting risk prose/status. |
| Scale assurance by run complexity | software-default-design/root | in_progress (folded into Software redesign) | Routine work keeps one focused proof and lean workflows; elevated/critical changes require explicit risk and multiple proof layers. Small asks at most one acceptance-blocking question and escalates material scope instead of manufacturing ceremony. |
| Optimize defaults, then prove Medium and Large Updog runs | unclaimed | queued | Begins only after Small is complete and findings are incorporated. |

## Inbox: newly reported requests and regressions

- 2026-07-16 08:52 MST (`implementation-proof-preparation/root`, active bounded profile/test
  lease): the Medium acceptance run proved that a red-green implementation can author a narrow
  focused oracle inside its own implementation ticket, mutate production, and only then learn in
  final review that the oracle never exercised all declared consumer seams. Extend the existing
  compiler-bound `assurance.proof.prepare` lane to preparation-eligible focused implementation
  proofs, gate product-write eligibility on a current independently reviewed historical baseline,
  and make implementation proof sources read-only after that boundary. Preserve diagnostic/risk
  behavior, all three proof strategies, and `review_failure_reopen_from: implement`; current-
  verification must not gain a nonsensical authoring pass. Scope is bundled Software profile,
  deterministic profile tests, and append-only docs only. No live state, install, binary, process,
  cmux, Git ref, Research, or current-run migration authority. Details:
  `agent-collab/implementation-proof-preparation.md`.

- 2026-07-16 (`relocation-lifecycle-tests/root`, active test-only lease): add a new public
  integration test for the journaled `planned-proof-source-relocation` lifecycle, including the
  legacy-profile happy path, exact idempotent replay, and—if public state manipulation permits—the
  complete-transaction/missing-completion-event crash seam. This lane owns only
  `crates/koni-core/tests/planned_proof_source_relocation.rs` plus its append-only mailbox; it does
  not own production, templates, existing tests, live state, binaries, processes, or cockpit.

- 2026-07-15 20:26 MST (`primary-integrator`, active superseded-review lease): the preserved
  Medium acceptance run recorded a passed independent review at 20:22 MST, then an authoritative
  ticket-scoped `review-rework` steering correction at 20:24 MST proving that the pass relied on a
  branch the configured check never executes. The ticket is still `in_progress`, canonical graph
  proof is still `planned`, and no finish/integration occurred. `primary-integrator` owns only the
  review-currentness/recovery/finish seam in `crates/koni-core/src/engine.rs`, one exact tracked
  review-effect rollback regression in `crates/koni-core/tests/research_profile.rs`, focused
  lifecycle regressions, and adjacent append-only runtime history. A newer matching correction must preserve
  the historical review but make it non-authoritative, reopen the configured author step, and fail
  closed at finish until a review performed after the correction passes. Older, unrelated, or
  non-ticket steering must not invalidate a valid pass. The isolated run remains paused with zero
  agents; no live state, product worktree, TUI, profile, global install, or protected run is in the
  source lease.

- 2026-07-15 (`primary-integrator`, active): open the Updog Koni cockpit from a dedicated
  `harness-testing` worktree so the user's ordinary checkout remains available. Preserve shared
  project/run identity, prefer the locally configured worktree as the control surface, and reject
  cross-repository registry redirects. Core/TUI focused worktree regressions are green; release
  build, project-profile validation, and guarded cmux reopen remain.

- 2026-07-15 (`primary-integrator`, active acceptance follow-up): a composite check's failed child
  receipt was invisible to `run_configured_check`, and a five-minute `wait_worker` call crossed
  Pi's tool-transport boundary. Match exact parent check-set identity when projecting the latest
  ticket/step-bound child receipt, and poll worker waits at 60-second idempotent intervals. This
  preserves redacted diagnostics, avoids repeat-worker token waste, and keeps every Lead tool call
  terminally represented in the semantic transcript.

- 2026-07-15 (`primary-integrator`, active acceptance lease): direct repository-tool execution
  now reaches the pinned Vitest executable, but live receipt
  `019f6757-19ca-79b1-8d1c-2056e5c4f450` exposed three adjacent compiler defects. The macOS
  read-only profile authorizes canonical `/private/etc` but not its user-space `/etc` alias, so
  `getaddrinfo("localhost")` fails before collection; startup/no-test termination can still be
  mistaken for an expected red; and `repository_source_snapshot_hash` spends minutes in
  libgit2's recursive status walk through the linked dependency tree even though native Git
  reports the same clean tree in about 0.1 seconds. `primary-integrator` owns only these narrow
  sandbox/classifier/snapshot ranges and focused regressions in `crates/koni-core/src/{engine,
  process}.rs`. The acceptance worker is durably complete, its false receipt will be invalidated
  rather than trusted, and neither protected Updog run nor the global binary is in scope.

- 2026-07-15 (`primary-integrator`, in progress): a live Software expected-red receipt accepted
  exit code 1 even though Node failed before the test runner with `EPERM: process.cwd`. Repair the
  exact macOS working-directory sandbox literal and add infrastructure-failure rejection so an
  expected numeric red is never sufficient evidence by itself. Acceptance run
  `019f66a9-df5a-7302-a3e1-00482d37a7ab` is paused at its current durable worker boundary; the
  original Updog checkout and protected forensic runs remain untouched.

- 2026-07-15 (`primary-integrator`, active acceptance continuation): after the cwd/alias repair,
  live receipt `019f6770-46a3-7633-b344-44e70886854c` exposed a narrower Seatbelt omission:
  Vitest/Tinypool may spawn child workers but cannot terminate them without explicit `signal`
  authority, producing `Error: kill EPERM` before an assertion result. An isolated Node probe
  reproduced the boundary and proved that `(allow signal)` is sufficient while filesystem and
  network policy remain unchanged. `primary-integrator` owns only the generated macOS read-only
  profile clause and its focused process-lifecycle regression in `crates/koni-core/src/engine.rs`.
  The one remaining isolated smoke run is compiler-blocked with zero active agents and stays
  visible in cmux `workspace:10` / `surface:100`; protected Updog runs and the global binary remain
  outside this lease.

- 2026-07-15 (`primary-integrator`, source-fixed; live replay pending): replacement worker
  `worker-019f679e-b5c2-7281-8907-1d2aff4fa3ca` authored the preserved SPICED historical proof,
  but spent roughly 63K tokens without invoking its available `run_configured_check`. Its terminal
  compiler rerun correctly classified the Updog environment-validation stop as `invalid_result`,
  while the broker hid that new signed receipt behind a generic nonretryable error. Current source
  now instructs every worker to preflight all step-assigned configured checks after its last edit,
  and a terminal compile failure projects only a valid ticket/step-bound receipt created after that
  compile began through the existing secret-redacted diagnostic. The terminal call remains
  nonconsuming so the same session can repair and resubmit; three same-class rejections still stop
  the loop. Exact receipt-selection, dynamic-safe-feedback, nonterminal/circuit, safe-error, and
  full Software direct submit/compile regressions pass, as do broker 10/10, warning-denied core
  Clippy, formatting, and diff checks. The isolated run remains quiescent until a guarded package
  refresh; no protected run or global install was changed.

- 2026-07-14 (documentation-only): `docs/runtime-and-git.md` now accurately records the exact
  run/target sync boundary, authorization-first invalidation, unbound-Pending retry, and dual-ref
  promotion CAS, but its ordered lifecycle says Köni seals the run before marking it ready for an
  operator decision. Runtime does the opposite: the promotion stage first waits for explicit
  authorization, then `seal_run_for_target_promotion` seals semantics, revalidates the final head,
  and performs the locked CAS. Reorder steps 5–7 so operators are not taught that the previewed
  ready run is already sealed. No runtime safety defect accompanies this wording mismatch.
  **Resolved 2026-07-14 by primary-integrator:** the original ordered list remains visible as
  design history, and an adjacent ordering-correction note now documents the released
  authorization → revalidation → seal → revalidation → two-ref CAS sequence. The independent
  closure audit found no corresponding runtime defect.
- 2026-07-14: Verification-head drift reopening publishes the reopened pipeline before it clears
  promotion authorization. `reopen_target_sync_for_verification_head_drift` first writes
  target-sync as the current stage, then separately reads/writes promotion state. A crash or
  promotion-write failure between those operations leaves the old authorization durable; the
  next target sync preserves that authorization, and successful reverification can automatically
  promote a different run head even though this path explicitly classifies the authorization as
  stale. Clear authorization durably before publishing the reopened pipeline (safe to clear
  conservatively), or make the updates one recoverable transaction. Add a reconstructed
  partial-publication regression proving resynchronization cannot retain the old authorization.
  **Resolved 2026-07-14 by `verification_head_fix/root`:** authorization is now cleared and
  durably written before the reopened pipeline is published. The split-write failure regression
  reconstructs the partial-publication boundary and proves stale authorization cannot survive it.
- 2026-07-14: A verification-head drift reopens target sync directly as `Running` with an input
  hash bound to the then-current run and target heads, then returns before executing that stage.
  If either ref moves again before the next supervisor tick, `drive_target_sync_stage_once`
  computes a different input hash and `prepare_supervised_stage` rejects the already-Running
  stage. The stage remains Running, while explicit retry accepts only Blocked/Failed stages, so
  ordinary supervision cannot recover. Make a reopened target-sync attempt safely rebind or
  transition to a retryable state when its head inputs drift, and cover a second ref advance
  between reopen publication and the next supervision tick.
  **Resolved 2026-07-14 by `verification_head_fix/root`:** target sync reopens unbound `Pending`,
  retains attempt history without retaining stale execution input, and binds the next live refs as
  a new attempt. A second pre-tick movement and an in-flight Git CAS movement both return to a
  retryable Pending boundary; pipeline 9/9 and lifecycle 49/49 pass.
- 2026-07-14 shared integration: the current full TUI library suite reaches 272 passed / 1 failed.
  `app::tests::action_engine_accepts_only_the_matching_compatibility_run` fails because
  `Engine::open_run` cannot find the freshly planned compatibility run. The failure appeared while
  `context-spec/root` owns registry/context engine ranges; diagnose as either an intentional
  registry contract change needing a fixture update or a product regression before installation.
  Coordination questions are in `agent-collab/{primary-integrator,context-spec,tui-polish}.md`.
  **Diagnosed 2026-07-14 by primary-integrator:** `compile_context` calls
  `run_control_store(...).unwrap_or_else(...)`; that helper calls `ProjectRegistryStore::run`,
  whose `load_or_create` writes an empty `project.yaml` before returning `NotFound` for the legacy
  run. The fallback context succeeds, but the next TUI refresh sees the new registry and correctly
  switches to authoritative `Engine::open_run`, which cannot find the unregistered compatibility
  run. `context-spec/root` owns the causal range and has been asked to make the optional control-
  store lookup non-mutating when no registry exists and add a regression proving compatibility
  context compilation does not adopt/poison the repository.
  **Candidate repair verified, handoff pending — 2026-07-14:** the active context slice now uses a
  load-existing-only registry lookup for optional control storage. Its focused no-adoption state
  regression is present; the exact TUI compatibility test passes 1/1, and all three Research
  conclusion contracts pass. The modern-registry-is-authoritative rule remains intact. Do not mark
  the source row released until `context-spec/root` completes its own formatting/docs handoff.
- 2026-07-14: Composed verification does not prove that its starting run head is the run head
  produced by the successful target-sync stage. `composed_verification_binding` records both
  `target_sync_output.output.run_head` as `synchronized_run_head` and the checkout's current HEAD
  as `composed_run_head`, but never compares them. If the run ref and checkout are replaced after
  target sync but before the checkpoint binds, checks execute against the replacement; later
  validation accepts it, and the final run CAS also accepts it because that replacement becomes
  the preflight `expected_run_head`. A replacement that still descends from the target can
  therefore discard the synchronized run's work and be promoted. Require exact run-head equality
  when creating the composed binding (and reopen target sync on mismatch); add a regression that
  advances or replaces the run between successful target sync and verification and proves the
  checkpoint cannot start from that stale synchronization boundary.
  **Resolved 2026-07-14 by `verification_head_fix/root`:** composed verification now requires the
  exact successful target-sync run and target heads before checks begin. Either-ref drift clears
  authorization and reopens synchronization; the final repository CAS independently binds both
  expected refs. Independent closure review found no remaining bypass.
- 2026-07-14 shared-integration coordination: `context-spec/root` still owns its mid-edit core
  slice. The integrated core library now compiles and reaches 422 passed / 5 failed / 3 ignored.
  Remaining failures are its graph-note ID-validation and worker MCP tool-list expectations, plus
  three Research runtime fixtures that predate the new required composed verifier:
  `configured_run_step_executes_and_writes_its_runtime_receipt`,
  `changed_scientific_input_makes_current_receipt_false_and_reopens_run_work`, and
  `scientific_measurements_artifacts_and_receipt_integrity_are_bound`. The Research audit confirms
  these are stale fixtures: add a distinct `composed_verification_command` containing every
  scientific input path and expect both runtime checks. The graph-note test must expect unsafe ID
  rejection at construction, and the MCP test must include `graph_context` / `record_note`. Do not
  install until the active owner reconciles these expectations and the exact full library suite is
  green.
  **Updated integration evidence — 2026-07-14:** the context owner has corrected the graph-note
  and broker-tool expectations. A fresh isolated full library run now reaches 433 passed / 3
  failed / 3 ignored; the only failures are the three already identified Research fixtures for the
  split historical-runtime/composed-integrity contract. Their test bodies remain handed to
  `primary-integrator` only after `context-spec/root` explicitly releases `engine.rs`.
  **Post-compatibility rerun:** 434 passed / 3 failed / 3 ignored. The additional passing test is
  the new no-adoption registry regression; the failure set is unchanged and contains only those
  three released-but-not-yet-edited Research fixtures.
  **Fixture handoff refined — 2026-07-14:** `research-fixture-audit/root` independently reproduced
  all three failures and recorded the exact test-only reconciliation in
  `agent-collab/research-fixture-audit.md`. Each fixture needs a distinct read-only
  `composed_verification_command` whose argv names every declared scientific-input path. The
  configured-step fixture additionally expects and executes ordered `scientific-runtime` plus
  `scientific-result-integrity`, then binds both receipt IDs in synthetic acceptance. Production
  re-emission remains intentionally keyed to the causal current `runtime.receipt`; composed replay
  remains integrity-only. Implementation still waits for the context owner's explicit release of
  the three test bodies.
  **Implementation claimed — 2026-07-14 by `primary-integrator/root`:** the context owner has now
  explicitly released `engine.rs` and assigned only those three exact test bodies. The patch will
  retain `scientific-runtime` as causal workspace-write evidence, add the separately registered
  read-only `scientific-result-integrity` argv contract, and update only fixture expectations and
  synthetic receipt inventory. Production rules, verifier selection, and profile semantics are
  outside this claim. Focused tests, Research result selection, and the full core library must all
  pass before this historical red status is marked resolved.
  **Resolved integration result — 2026-07-14:** the exact fixture regressions pass 3/3, Research
  result contracts pass 3/3, the safe composed-replay selector passes 1/1, and the full core library
  passes 438 tests with zero failures and three intentional ignores. This current result sits
  beside—not in place of—the 434/3/3 causal checkpoint above. The implementation changed only the
  three fixture bodies and did not weaken production rules, verifier selection, or profile state.
- 2026-07-14: Make the graph the durable living specification for a run. Compile an approved,
  profile-validated graph seed at initialization; include typed intent, relevant steering, and
  provenance-bound node notes in every ticket context; and let workers query only a bounded
  read-only graph neighborhood or append non-authoritative working notes through the runtime
  broker. Existing context sections, receipt authority, ticket locality, and immutable run
  snapshots must remain intact.
- 2026-07-14: Inactive Lead disappears from Agents history while other inactive personas remain.
- 2026-07-14: Live Small `plan-change` required four failed reviews and repeated Integrator validation retries. Earlier producers must receive a salient, complete, config-derived node/edge/path contract so schema discovery does not consume model turns.
- 2026-07-14 (resolved): Research operation `lifecycle.resolve-conflict` declares
  `terminal_resolver: true`; the field is now typed and validated in compiler IR and consumed by
  the automatic recovery runtime. The profile declaration remains intact, focused compensation
  and explicit-recovery compatibility tests pass, and the full core library suite is green.
  **Current integration status — 2026-07-14:** The sentence above records the green suite at that
  resolver slice. After the distinct Research verifier contract landed, the current full-core
  result is 434 passed / 3 failed / 3 ignored; only the three stale runtime fixture bodies remain,
  while resolver, Research profile (20/20), conclusion (3/3), and result-contract (3/3) suites are
  independently green.
  **Later fixture reconciliation — 2026-07-14:** Retaining that intermediate 434/3/3 result as
  history, the three named fixtures now match the split verifier contract and the integrated core
  library is 438 passed / 0 failed / 3 intentionally ignored.
- 2026-07-14: Default Software audit found an impossible review-rework path: post-green review
  failure reopens `write-red-test` but keeps the green production candidate, so an honest expected
  red cannot recur. Review rework also has no attempt ceiling. Treat both as P0 before the next
  expensive live proof.
- 2026-07-14: Default Software delivery can vacuously pass with no proof nodes, and a clean target
  sync may invalidate receipt inputs without forcing fresh composed verification. Do not consider
  a run merge-ready until both are compiler-owned gates.
- 2026-07-14: P0 composed-verification promotion audit found that the synchronized-tree binding is
  allowed to advance to any descendant run commit after checks finish. Neither verification
  checkpointing nor semantic sealing proves that this descendant changes only compiler-owned
  state, and target promotion compare-and-swap binds only the target ref, not the preflight run
  head. A product commit arriving after the final verification rebound, a direct product repair on
  retry, or tracked dirty product state swept into an audit checkpoint can therefore be promoted
  without checks having executed against that exact product tree. Require exact checked-head
  equality for `git_common_dir`; for tracked storage allow only a proven compiler-state-only delta
  with an identical product-tree projection; enforce that invariant again across semantic sealing;
  and pass an `expected_run_head` into the repository-locked promotion CAS.
  **Resolved 2026-07-14 by `verification_head_fix/root` + `promotion_run_cas/root`:** exact-head
  verification and post-seal revalidation now reject unproved product movement; tracked storage
  accepts only the bounded compiler-bookkeeping case whose product projection remains identical;
  and the locked promotion transaction rejects a changed run ref as well as a changed target ref.
- 2026-07-14: Research composed verification has two definite contract mismatches. Normal
  `run-experiment` tickets select `scientific-runtime`, but that check is `workspace_write`, so the
  read-only composed verifier rejects a completed empirical run. Give scientific execution an
  explicit historical/currentness policy plus a separate read-only composed-result integrity
  check; never rerun side-effecting science implicitly. `gate-verifier` is read-only but permits a
  nonpassing receipt, which currently lets the checkpoint succeed and strands the run at an
  unauthorizable promotion. Composed verification itself must require every replay status to be
  `passed` and block at the retryable verification stage otherwise. Add end-to-end Research tests
  containing both a completed experiment ticket and a nonpassing gate replay.
  **Resolved 2026-07-14 by `research_verifier_contract/root`:** scientific execution remains
  historical workspace-write evidence with `composed_replay: never`; a distinct project-owned
  read-only integrity check is the replay obligation. Every composed replay must pass, and the
  experiment/gate selector plus all three Research result-contract tests are green.
- 2026-07-14: Bundled Research pipelines render their tracked report after composed verification.
  The first report publication advances the run branch through `audit_state`, so current promotion
  preview rejects authorization because the run head differs from the verified output, while an
  unauthorized promotion stage does not reopen synchronization. The tracked compiler-state-only
  delta invariant must cover report/seal commits (or final verification must follow reporting),
  with an end-to-end report -> preview -> authorize -> promote regression test.
  **Resolved 2026-07-14 by the pipeline-order and verification slices:** promotion-enabled
  pipelines enforce target sync → composed verification → downstream report/review → explicit
  promotion, while report/seal bookkeeping is accepted only when its product-tree projection is
  unchanged and is revalidated before publication.
- 2026-07-14: Promotion receipt validation is not yet an exact proof-set comparison. It accepts any
  nonempty list of passing receipt projections, does not require one projection per compiled
  ticket/step/check/contract binding, and constructs a receipt path from the projected ID without
  validating containment. Require exact keyed-set equality, validate every underlying receipt's
  run/profile/ticket/step/check identity, and read only a regular nonsymlink receipt directly under
  the receipts directory. Cover missing, duplicate, swapped, unrelated, and path-traversal IDs.
  **Resolved 2026-07-14 by the composed-verification closure:** promotion compares the exact
  compiled ticket/step/check/contract key set, validates every direct receipt's bound identity and
  integrity, and rejects noncanonical, missing, duplicate, swapped, unrelated, symlinked, or
  escaping receipt references.
- 2026-07-14: The forensic Small run spent 13 Integrator turns and 30 compiler submissions on one
  design ticket. Eight workers exhausted their three-call validation budget, four candidates
  reached and failed coherent reviews, and the integration branch never advanced past base
  `95304acf`. Preserve node types/final diagnostics and add a ticket-level exhausted-worker circuit
  breaker before another live run.
- 2026-07-14: Ground-truth Updog scope audit found the original Small objective needs only the
  Books questionnaire definition and its focused tests: retain Sales Notes as General and add five
  independent SPICED `THREAD` cards through existing generic persistence. Proposal parity, agent
  mutation/query, autofill, provider schemas, and core/schema work are adjacent feature choices,
  not implicit dependencies. In this specific run the user later selected that broader scope in
  Review Plan steering; Koni should warn/promote it to Medium and record the constraint rather than
  silently keeping Small semantics.
- 2026-07-14: The frozen plan had `decisions: []` even though human Review Plan steering explicitly
  preserved General/Sales Notes, made the five SPICED fields optional, and selected proposal plus
  mutation/query parity. The plan followed most of that expanded request, but the approved context
  omitted the steering. Planning inputs that affect scope or acceptance must be compiled into a
  durable decision/constraint contract, not left only in a transient revision prompt.
- 2026-07-14: Fail-closed profile decoding now exposes pre-existing unquoted commas inside
  flow-style YAML fixture scalars (for example `fixtures/updog-repo/.codex/koni/workflows.yaml`
  line 26 parses `migrations` as an unknown step key). Profile-schema/root should quote or
  normalize these fixture values as part of strict-schema integration; do not weaken unknown-key
  rejection to accommodate malformed flow scalars.
- 2026-07-14: Shared compile is temporarily red while the active terminal-resolver/schema slice
  is mid-edit: `engine.rs` calls `normalized_hash(journal_error)` with unsized `str` and calls
  `validate_terminal_resolver_ticket` without its new leading `&CompiledProfile` argument. The
  verification module did not introduce either site. Let profile-schema/root finish/release this
  handshake before integration testing; do not paper over or revert its resolver design.
- Continue treating [`tui-cleanup-backlog.md`](tui-cleanup-backlog.md) section
  “2026-07-14 regression audit — authoritative latest behavior” as the behavior authority when
  older tests or documentation contradict it.

## Shared verification log

- `CARGO_TARGET_DIR=/tmp/koni-root-integration cargo test -p koni-cli -- --nocapture` — 61 passed,
  0 failed after the current compatibility-registry, context, profile, and template integration.
  Source tree only; no installed binary, cockpit, Updog profile, or live run changed.

- `CARGO_TARGET_DIR=/tmp/koni-root-verification cargo check -p koni-core --lib` — passed after
  the graph-context slice restored the integrated core compile.
- `CARGO_TARGET_DIR=/tmp/koni-root-verification cargo test -p koni-core git::tests::promotion_rejects_a_run_ref_advance_after_preflight --lib -- --exact --nocapture`
  — 1 passed; a moved run ref is rejected by the repository-locked promotion CAS.
- `CARGO_TARGET_DIR=/tmp/koni-root-verification cargo test -p koni-core verification::tests --lib -- --nocapture`
  — 3 passed; historical/explicitly non-replayable commands are skipped, implicit side effects
  fail closed, and Research experiment/gate paths select only their safe read-only replay checks.
- `CARGO_TARGET_DIR=/tmp/koni-root-verification cargo test -p koni-core --lib -- --nocapture`
  — 422 passed, 5 failed, 3 ignored. All composed-verification, promotion, replay-policy, Git CAS,
  and product-projection tests pass; the five active-owner fixture/expectation failures are listed
  in the shared-integration inbox above and block installation.
- `cargo test -p koni-tui --lib` — 273 passed after the Details/activity, provisional-run,
  adaptive-approval, and stable-Lead slices.
- `cargo test -p koni-tui approval_ --lib` — 19 passed after the single adaptive action slice.
- `cargo test -p koni-core orchestration_active_runtime_excludes_every_paused_interval --lib`
  — passed.
- `cargo test -p koni-tui recent_activity_shows_row_timestamps_and_only_active_runtime_in_its_header --lib`
  — passed.
- `cargo test -p koni-core git_common_rework_validates_edge_only_corrections_against_superseded_candidates --lib`
  — passed with compact field descriptions, path item types, required-any groups, and legal edge contracts asserted.
- `cargo test -p koni-cli templates::tests --bin koni` — 5 passed, including the default
  software first-shot change-design producer contract.
- `cargo test -p koni-core --test updog_profile` — 2 passed.
- `cargo test -p koni-core latest_human_plan_revision_is_a_durable_approved_constraint --lib`
  — passed.
- `cargo test -p koni-core rendered_lead_prompt_receives_only_semantic_approved_planning_handoff --lib`
  — passed with revision steering included and private absolute paths scrubbed.
- `cargo test -p koni-core review_rework_circuit --lib -- --nocapture` — 1 passed; first
  failure reopens once and the second blocks without superseding the current rejected candidate.
- `cargo test -p koni-core failed_review --lib -- --nocapture` — 5 passed after the bounded
  review policy was wired into both review-recording paths.
- `cargo test -p koni-core broker_safe --lib -- --nocapture` — 2 passed; configured node types
  remain actionable while node IDs, paths, and payload values stay redacted.
- `cargo test -p koni-cli agent_mcp::tests --bin koni -- --nocapture` — 14 passed; the third and
  subsequent bounded validation responses retain the final sanitized compiler correction while
  remaining non-retryable and never invoking the compiler again.
- `cargo fmt --all -- --check` and `git diff --check` — passed after the validation-diagnostics
  slice.
- `CARGO_TARGET_DIR=/tmp/koni-research-profile-target cargo test -p koni-core --test research_profile research_ontology_matches_autoresearch_v2_effective_graph_contract -- --exact --nocapture`
  and the focused run-lifecycle, canonical-context, and canonical-gate-runtime variants — passed.
  The representative gate context is 42,275 bytes, selects 21,056 of 32,746 contract bytes
  (35.7% saved), and remains below its approved 48 KiB one-shot cap.
- `CARGO_TARGET_DIR=/tmp/koni-research-profile-target cargo test -p koni-cli research_source_and_install_template_are_recursively_in_sync -- --nocapture`,
  `research_native_agents_embed_exact_authored_persona_instructions`, and
  `installs_bundled_profiles_without_touching_product_state` — passed.
- `CARGO_TARGET_DIR=/tmp/koni-research-profile-target cargo test -p koni-core --test research_profile -- --nocapture`
  — 16 passed, 4 pre-existing failures remain: formulation ticket count, two filesystem-manifest
  acceptance/reacceptance cases, and review-effect exact-count timing.
- `CARGO_TARGET_DIR=/tmp/koni-root-final-target cargo test -p koni-core --test research_conclusion_contract -- --nocapture`
  — 3 passed after the fixture replaced excluded `.codex/koni/profile.yaml` with a committed,
  command-consumed scientific input and accepted the compiler's earlier exact-coverage preflight.
- `CARGO_TARGET_DIR=/tmp/koni-root-final-target cargo test -p koni-core config::tests --lib -- --nocapture`
  — 51 passed, including nested unknown-key rejection and typed node command-source resolution.
- `CARGO_TARGET_DIR=/tmp/koni-root-final-target cargo test -p koni-cli --bin koni -- --nocapture`
  — 57 passed across bundled installation, init selection, template contracts, native resources,
  and exact Software/Research run-type ordering.
- `CARGO_TARGET_DIR=/tmp/koni-root-final-target cargo test -p koni-core --test updog_profile -- --nocapture`
  — 2 passed after fail-closed parsing exposed and corrected three comma-bearing unquoted workflow
  outputs that had previously been silently deserialized as unknown keys.
- Both bundled customization skills pass the skill-creator `quick_validate.py`; the CLI embedded
  inventory test passes and packages all 18 files.
- `CARGO_TARGET_DIR=/tmp/koni-root-final-target cargo test -p koni-core --lib` — 411 passed,
  0 failed, 3 ignored after typed terminal-resolver support, automatic recovery compensation,
  fail-closed profile decoding, and adaptive proof integration.
- `CARGO_TARGET_DIR=/tmp/koni-root-final-target cargo test -p koni-cli --bin koni -- --nocapture`
  — 57 passed, including fresh/replacement profile selection, bundled profile installation,
  template/source parity, skill inventory, and adaptive Software/Research contracts.
- `CARGO_TARGET_DIR=/tmp/koni-root-final-target cargo test -p koni-core --test research_profile research_`
  and the corresponding `canonical` filter — 4 and 2 focused tests passed for empirical ontology,
  target-sync verification/promotion, and the one-fact gate relation.
- `CARGO_TARGET_DIR=/tmp/koni-root-final-target cargo test -p koni-core --test research_profile -- --nocapture`
  — 19 passed, 1 failed after the test-only regression reconciliation. The remaining formulation
  failure is the confirmed non-conflicting cross-lane squash defect: final inspection projects the
  same ticket twice as `closed` because ticket authority was applied only to path conflicts. The
  post-Git-fix rerun of this exact command is pending restoration of the unrelated shared core compile.
- `cargo test -p koni-core worker_no_output_circuit --lib -- --nocapture` — 4 passed: two
  identity-bound no-output sessions block, one permits retry, preserved successful output resets,
  and other ticket/step or stale-running records do not count.
- `CARGO_TARGET_DIR=/tmp/koni-terminal-resolver-target cargo test -p koni-core terminal_recovery_dispatch --lib -- --nocapture`
  — 2 passed: deterministic first emission and failed-journal replay preserve the retained source
  worktree, HEAD, product status, and semantic graph; a terminal resolver failure blocks in place
  without emitting another ticket. Resolver-facing bindings/events contain only the allowlisted
  diagnostic and hashes, while raw failure detail stays in the compiler-owned journal.
- `CARGO_TARGET_DIR=/tmp/koni-terminal-resolver-target cargo test -p koni-core recovery_preserves_output_and_worker_started_after_failed_review --lib -- --nocapture`
  and `git_common_recovery_reopens_ticket_after_integration_failure_is_reconciled` — passed,
  preserving generic explicit `recover` behavior.
- `cargo fmt --all -- --check` and `git diff --check -- crates/koni-core/src/engine.rs
  docs/AGENT_COLLAB.md` — passed after the worker circuit-breaker slice.
- `CARGO_TARGET_DIR=/tmp/koni-pipeline-order-target cargo test -p koni-core catalog::tests --lib -- --nocapture`
  — 27 passed, including missing, duplicate, and misordered target-sync / composed-verification /
  promotion boundaries.
- `CARGO_TARGET_DIR=/tmp/koni-pipeline-order-target cargo test -p koni-cli installs_bundled_profiles_without_touching_product_state --bin koni -- --nocapture`
  — passed with exact Software/Research boundary counts and ordering; Software Large verifies its
  composed target-synced tree before independent review.
- `cargo fmt --all -- --check` and path-scoped `git diff --check` — passed for the pipeline-ordering
  slice.
- `CARGO_TARGET_DIR=/tmp/koni-root-verification cargo test -p koni-core --test run_lifecycle -- --nocapture`
  — 41 passed. Target promotion now proves a changed target input forces a second fresh receipt,
  rejects a tampered fresh receipt, persists a failed composed check as blocked, and rebinds an
  explicit retry to the repaired run tree. The same run caught and fixed optional revision-steering
  hash drift so serialized approval contexts remain exactly content-addressed.
- `CARGO_TARGET_DIR=/tmp/koni-root-verification cargo test -p koni-core --lib` — 414 passed,
  0 failed, 3 ignored after composed verification, promotion binding, clean product-tree checks,
  bounded review rework, worker exhaustion, and terminal-resolver integration.
- `CARGO_TARGET_DIR=/tmp/koni-root-verification cargo test -p koni-core --test software_proof_gate -- --nocapture`
  — passed; planning and delivery fail closed without one canonical passing proof per realized
  change, and the reviewed delivery must exactly cover the objective, changes, proofs, and direct
  prerequisites.
- `CARGO_TARGET_DIR=/tmp/koni-root-verification cargo test -p koni-core --test updog_profile -- --nocapture`
  — 2 passed after integrating the default Software proof and post-sync verification gates.
- `CARGO_TARGET_DIR=/tmp/koni-root-verification cargo test -p koni-cli --bin koni -- --nocapture`
  — 57 passed across profile initialization, bundled Software/Research catalogs, native Codex
  resources, model-facing contracts, and strict MCP retry behavior.
- `CARGO_TARGET_DIR=/tmp/koni-root-verification cargo test -p koni-tui --lib -- --nocapture`
  — 273 passed against the integrated compiler/catalog changes.
- `CARGO_TARGET_DIR=/tmp/koni-duplicate-lane-target cargo test -p koni-core squash_integration_projects_nonconflicting_ticket_lifecycle_lanes --lib -- --nocapture`
  and `squash_integration_prefers_configured_ticket_projection_on_add_add_conflict` — passed.
  The new case keeps an unrelated allowed-dirty config file while removing the retired physical
  lifecycle lane; the exact Research formulation rerun is waiting only on the shared core compile.
- `git diff --check` — clean at the last recorded checkpoint.
- `CARGO_TARGET_DIR=/tmp/koni-verification-head-fix cargo test -p koni-core --test run_lifecycle -- --nocapture`
  — 46 passed. New regressions prove exact Git-common head binding; tracked report and semantic
  seal commits remain promotable only with an identical product projection; dirty or committed
  product changes after verification are rejected; and an allowed nonpassing diagnostic receipt
  cannot satisfy composed verification.
- `CARGO_TARGET_DIR=/tmp/koni-verification-head-fix cargo test -p koni-core --test run_lifecycle promotion_requires_one_safe_receipt_projection_for_each_bound_check -- --exact --nocapture`
  — passed after expanding the case to reject duplicate, missing, mismatched/swapped, and unsafe
  traversal-style receipt projections. Path-scoped `git diff --check` is clean. The later full core
  library run compiled all verification changes and reached 419 passes, but finished 7 failures
  in concurrently changing graph-note/research/Codex-preflight expectations outside this slice;
  none of the failing tests exercise composed verification or promotion.
- `CARGO_TARGET_DIR=/tmp/koni-verification-head-followup cargo test -p koni-core --test run_lifecycle -- --nocapture`
  — 47 passed, 0 failed. The added lifecycle regression proves a product commit after successful
  target sync reopens synchronization before composed verification; the explicit retry regression
  proves a repair commit after failed verification follows the same resync path. The new sync head
  is then verified and promotion remains operator-gated.
- `CARGO_TARGET_DIR=/tmp/koni-verification-reopen-closure cargo test -p koni-core pipeline::tests --lib -- --nocapture`
  — 9 passed, 0 failed. Pending reopen round-trips with retained attempt count, rejects a retained
  counter on any noncurrent Pending stage, binds the next live input as a new attempt, and safely
  abandons a stale Running attempt back to Pending.
- `CARGO_TARGET_DIR=/tmp/koni-verification-reopen-closure cargo test -p koni-core --test run_lifecycle -- --nocapture`
  — 49 passed, 0 failed. Regressions prove authorization is durably invalidated even when the
  following pipeline atomic write fails; run-only and target-only post-sync drift both reopen;
  another target move before retry binds the newest head; and a repository-lock-coordinated target
  move inside the Git CAS window returns Running target sync to Pending and succeeds on attempt 2.
  `rustfmt --check` passes for the owned pipeline/lifecycle files, the read-only formatter check has
  no hunk in the owned engine ranges, and path-scoped `git diff --check` is clean.

## Agent notes / handoffs

- 2026-07-14 software-default-design/root handoff reminder: the research, accepted Software 0.4
  design, packaged customization skills, schema/rule syntax audit, regression map, and clean
  forward tests are complete. The shared tree passes a core+CLI check, but this lane is still
  honoring `context-spec/root`'s `in_progress` lease. Please release or retain explicitly the
  bundled Software profile/agents/run types/cockpit/reports, `templates.rs`, Software catalog/profile
  test ranges, and `docs/{configuration,philosophy,codex-resources}.md`; no overlapping edit begins
  from a green build alone.

- 2026-07-14 `promotion_run_cas/root` read-only closure verdict: no remaining runtime defect found
  in the pending-reopen/abandon invariants, exact run+target drift guard, authorization-before-
  pipeline publication, or target-sync CAS recovery. A reopened current stage alone may retain
  its consumed attempt count; it retains no input/timestamps/output, cannot be skipped, and binds
  the next live refs as a new attempt. Both split-write paths clear authorization first, and a
  Running CAS attempt whose refs move becomes unbound Pending rather than stranded. The explicit
  retry path that discovers ref drift durably reopens sync before returning its diagnostic; TUI
  polling continues it, and the CLI's next supervision tick does. Independent reruns passed
  pipeline 9/9 and lifecycle 49/49. `runtime-and-git.md` catches up accurately on those contracts
  and the dual-ref CAS, except for the definite documentation-only seal/ready ordering mismatch
  filed in the inbox. No source, install, cockpit, or live-run state changed.
- 2026-07-14 `verification_head_fix/root`: `context-spec/root` has a broad active `engine.rs`
  claim but is not a live collaboration session. This safety slice is coordinated as a disjoint
  range: only composed-verification binding/checkpoint helpers, promotion verification/sealing
  (approximately current lines 5,500–5,800 and 26,400–27,050), the adjacent storage-projection
  helpers near 35,650, and target-promotion lifecycle tests near 1,650–1,950. It will not edit
  planning graph seeds, node notes, ticket context, broker tools, catalog/config/state, or Git CAS
  types/functions. Re-read the shared diff before patching and preserve all context-spec changes.
- 2026-07-14 `verification_head_fix/root` handoff: released `engine.rs` verification/promotion
  ranges and `run_lifecycle.rs`. The composed binding now records both the exact Git tree and a
  compiler-state-excluded product projection. Promotion revalidates the verification output head,
  current head, post-report ancestry, and post-seal head; tracked advances must be single-parent
  compiler-state-only commits, while Git-common cannot advance. Product dirt/commits reopen or
  block before promotion, and the repository CAS independently binds the expected run ref. Fresh
  receipt projections exact-cover the selected contracts and raw receipts are canonical-path,
  internally hashed, passing, read-only, and identity-bound. Lifecycle 46/46 and the expanded
  projection case pass. No binary install, cockpit refresh, or Updog/live-run state was touched.
- 2026-07-14 `verification_head_fix/root` follow-up handoff: composed verification additionally
  requires the current run head to equal the successful target-sync output head. A drifted run
  head reopens target sync under both normal supervision and explicit verification retry, clears
  stale promotion authorization, and records a retryable promotion blocker before any checks run.
  The full lifecycle suite passes 47/47. Formatting is clean in the owned verification/test ranges;
  unrelated active `engine.rs` and CLI/control formatting diffs were preserved. No install,
  cockpit refresh, or Updog/live-run state was touched. **Historical/superseded:** closure review
  found that this first reopen implementation persisted pipeline state before invalidating
  authorization and left target sync Running with an early input binding; the handoff below closes
  both defects while preserving this audit trail.
- 2026-07-14 `verification_head_fix/root` closure handoff: released the exact shared-file ranges.
  The guard compares both run and target refs with the successful target-sync output. It constructs
  an unbound Pending reopen in memory, persists authorization invalidation first, and only then
  persists the pipeline; a forced failure of that second write proves the durable old pipeline is
  already fail-closed. Pending stages retain only the current stage's prior attempt counter and
  bind live refs when restarted. A stale Running target-sync input or explicit internal CAS-movement
  error abandons the attempt back to Pending after the same authorization-first invalidation.
  The dated runtime/Git transition note preserves the former approved-base contract and documents
  the stronger exact-head protocol. Pipeline tests pass 9/9 and lifecycle passes 49/49. No binary
  install, cockpit refresh, Updog/live-run mutation, or context-spec engine edit occurred.

Append concise dated notes here when handing a task to another agent. Include what is proven,
what remains uncertain, and the smallest next verification command.

- 2026-07-14 context-spec/root: Claimed the graph-backed context/living-spec slice after reading
  the full registry and current dirty tree. The work deliberately builds on the released planning
  steering, compact context-contract, profile-schema, and proof-profile slices. It will not edit
  `git.rs`, install Koni, or touch the preserved Updog run. Engine changes are confined to planning
  seed/context/broker regions and must preserve the in-progress graph-proof runtime behavior.

- 2026-07-14 software-default-design/root → context-spec/root: I am researching and specifying a
  Software-only default-profile redesign plus `new-feature` and `bug-fix` run types. I will keep
  edits confined to `docs/software-profile-engineering.md` until your living-spec slice releases
  bundled Software templates, native Software agent prompts, `templates.rs`, and affected profile
  tests. Please leave a release/handoff note when those paths are stable; I will preserve the new
  approved-plan graph-seed contract and will not touch Research, core runtime, the installed binary,
  or live Updog state.

- 2026-07-14 primary/root: The shared worktree is intentionally very dirty and contains coherent
  work from multiple sessions. Do not use destructive Git cleanup. A separate `cargo test
  --workspace` is currently/was recently running; wait for its build lock rather than killing it.
- 2026-07-14 pipeline_verification_order/root: Catalog validation now treats a promotion policy or
  target boundary as one target-promotion pipeline and fails closed unless it contains exactly one
  `target_sync`, one `checkpoint` configured as `verification`, and one `promotion`, ordered in
  that sequence. The default Software Large flow is now sync → fresh composed verification →
  independent review → report → explicit promotion; Small and Medium already had safe order.
  All catalog and focused bundled-profile tests pass. Files are released; root owns the matching
  lifecycle fixture/runtime integration. No binary or live project was touched.
- 2026-07-14 validation-diagnostics/root: The diagnostics-only P0 slice is ready and releases
  `engine.rs` plus `agent_mcp.rs`. Compiler field errors now carry a configured node type through
  an exact-token sanitizer; adversarial tests prove node IDs, paths, and offending values do not
  cross the MCP boundary. The per-tool three-rejection state stores only the safe DTO and appends
  its final correction to the durable stop message, including on later blocked calls. Core
  broker-safe tests (2) and all CLI MCP tests (14) pass; no circuit-breaker behavior was touched.
- 2026-07-14 primary/root: Live evidence for `TK-41912f5ea5fc39b9` is diagnostic, not an Updog-only
  profile customization. `analyze-impact` emitted a human boundary label inside `owned_paths`;
  Integrator rework then discovered required node fields and legal edge targets over repeated
  compiler failures despite those facts existing elsewhere in a very large context. Fix the
  generic compact context contract and canonical software defaults; do not mutate the frozen run
  snapshot or refresh the installed binary while its agents are active.
- 2026-07-14 primary/root: The first-shot producer repair is source-complete and focused tests pass.
  The currently installed/frozen Small run still uses its old snapshot and remains active with a
  Lead plus Integrator, so no install or cockpit restart has occurred. Prove the new contract on a
  fresh plan-change ticket after the next guarded refresh.
- 2026-07-14 profile-config/root: Implementing the approved profile-configuration plan in
  non-overlapping slices. The software proof-strategy slice is deliberately queued behind
  `primary/root` because both need `templates/software/graph.yaml`; please leave a handoff here
  when that file is released. No slice will install Koni or mutate the live Updog run.
- 2026-07-14 primary/root → profile-config/root: The producer-contract slice is now
  `ready_for_integration`; `templates/software/graph.yaml` is released. Preserve its new
  project-root-relative `path` item contracts/descriptions for `system`, `change`, `migration`,
  and `proof` owned paths, plus path-typed change/migration test paths. Focused template and
  context tests are green. You may now layer the adaptive repository-owned proof strategy on top
  and should update the same registry row/status when you begin.
- 2026-07-14 primary/root → research-profile/root + profile-schema/root: The 69-test full-core
  failure is the expected collision between your two coherent slices, not a reason to revert
  either. Please claim the compiler-side `terminal_resolver` contract or remove that declaration
  only if the research design no longer needs it, then rerun `cargo test -p koni-core --lib`.
- 2026-07-14 profile-init/root: Fresh or replacement `koni init` now resolves an explicit custom
  or built-in source, prompts a TTY for Software/Research when omitted, and fails non-interactive
  ambiguity with concrete `--profile`/`--from` examples before any write. Existing and legacy
  installs keep their verification/migration paths without prompting. Passed `cargo test -p
  koni-cli init_ -- --nocapture` plus the two picker/dry-run focused tests; no binary refresh.
- 2026-07-14 primary/root: The original Small run reached a durable zero-agent pause after its
  frozen-snapshot Integrator exhausted the three-attempt compiler validation limit. No graph delta
  was materialized. Cockpit lifecycle is `running=false`, `draining=false`, `active_agents=0`;
  ticket `TK-41912f5ea5fc39b9` still serializes an `active_worker` lease for dead PID 705. Treat the
  verified lifecycle count/process audit as authoritative and preserve this run for forensics.
- 2026-07-14 software TDD read-only audit: The strategy-specific red/green, characterization, and
  current-verification workflows are strongly ordered, with compiler-run receipts and scoped
  step writes. Remaining correctness gaps are semantic baseline matching, test immutability across
  green work, checkpoint-correct bounded review rework, proof cardinality, and post-target-sync
  receipt freshness. Small also currently pays nearly the entire multi-ticket ontology cost. See
  the new P0/queued rows above before running another costly Updog proof.
- 2026-07-14 research_profile_regressions/root: Four stale Research integration fixtures are
  reconciled and `research_profile.rs` is formatted/released. Gate commands no longer place a
  newline inside exact argv; filesystem reacceptance proves three distinct accepted content hashes
  without intentionally invoking terminal recovery; ambiguous exact-one review effects fail at
  pre-review integration; and deliberate provenance tampering asserts the emitted resolver ticket.
  The pre-Git-fix exact suite is 19/20. The Git fix is now present, but its exact end-to-end rerun is
  pending the unrelated context-spec/core compile; use `CARGO_TARGET_DIR=/tmp/koni-root-final-target
  cargo test -p koni-core --test research_profile -- --nocapture`. Preserve the last one-ticket
  assertion; no profile/product source was changed in this slice.
- 2026-07-14 live Small forensics: Whole run reached 16.59M tokens / 93 turns; `TK-419...` alone
  consumed 13 Integrator turns, 30 compile submissions, four reviewed candidates, and no accepted
  output. The four reviews consistently rejected missing dependency order and graph-bound risks /
  proofs; reviewer oscillation was not the cause. The final source branch still equals the base,
  so no product implementation exists to salvage. Fresh acceptance: zero-to-one schema correction,
  no more than one semantic rework, fewer than six design worker/reviewer turns, under ~1M design
  tokens, and an automatic pause after two exhausted Integrators.
- 2026-07-14 Updog ground-truth handoff: The minimal Small slice owns only
  `apps/books/src/pages/companies/[companyId]/home/questionnaire/components/questionnaire-definition.tsx`
  plus its existing `questionnaire-definition.test.ts`. Generic named-thread query/upsert and
  persistence already exist. Focused argv is `pnpm --filter @uplinq/books exec vitest run
  src/pages/companies/[companyId]/home/questionnaire/components/questionnaire-definition.test.ts`
  (passed as an argv array in graph state). Expected red: five SPICED item IDs/storage targets are
  absent while legacy General/Sales Notes characterization stays green. Browser acceptance must
  prove six ordered editors, distinct save/reload values, optional completion neutrality, preserved
  General required behavior, wrapping guidance, and desktop/narrow layout.
- 2026-07-14 primary/root → profile-config/root: Before releasing `workflows.yaml`, change the
  strategy-specific implementation workflows' ordinary review reopen boundary away from the
  expected-red/characterization baseline step. The current `review_failure_reopen_from:
  write-red-test` retains the green product tree and therefore makes an honest red rerun
  impossible. Use `implement` for ordinary rework unless/until runtime supports a typed reviewer
  route plus restoration of the exact baseline checkpoint. Preserve the original red/baseline
  receipt as causal evidence and let the compiler-level two-failure circuit breaker handle repeated
  review rejection.
- 2026-07-14 primary/root → profile-config/root: Small planning should explicitly preserve the
  narrowest behavior directly requested and avoid silently adding adjacent surfaces/integrations.
  When a human revision expands a one-file UI slice into proposal plus agent/provider parity, the
  approved contract should flag that scope as Medium-worthy even if the user chooses to continue.
  Medium remains the default place for one-to-three scope questions; Large retains deeper staged
  planning. This is generic run-type behavior, not an Updog-specific prompt.
- 2026-07-14 primary/root: Plan-review steering was already durable in the planning transcript and
  correctly used to regenerate the plan, but approval omitted it from the compiler-owned handoff.
  The latest human revision is now a separately hashed approved constraint (not squeezed through
  the 2 KiB question-decision projection) and is shown to downstream agents after path scrubbing.
  Typed graph seeding of exact approved paths/commands remains the next slice.
- 2026-07-14 profile-skills/root: `configure-koni` now discovers the installed baseline and
  repository evidence, applies a sufficiency rubric, asks only model-changing questions, presents
  an ontology/compiler/proof approval packet, and edits only after explicit approval. Progressive
  Software and empirical-Research references cover canonical edges, adaptive proof, native
  commands, metrics/baselines/ablations/gates/receipts, target sync, and explicit promotion. Both
  skill-creator validations, an exact 18-file embedded-inventory comparison, two clean-context
  forward tests, and `git diff --check` pass. The Cargo inventory test was not allowed to overtake
  the shared core build lock; smallest follow-up is `cargo test -p koni-cli
  embedded_profile_inventory_matches_package_templates` once that lock clears.
- 2026-07-14 research-profile/root: Research profile 1.0.10 now stores gate applicability only as
  canonical `gate.applies_to`, exposes `gates` through the typed bidirectional inverse, removes
  target-node mutation authority from gate-creation operations, and aligns gate-designer and
  integrator prompts. Small, Medium, and Large now synchronize the target, verify the composed
  empirical result, compile the report, and wait for explicit promotion. Target-sync conflicts
  use `resolve-target-integration`, whose entire workflow is compiler-enforced graph-forbidden and
  includes fresh composed-tree verification plus independent review. Authoring/template bytes and
  native prompts are in sync; isolated focused tests and path-only formatting/diff checks pass.
  The shared `terminal_resolver` collision is resolved by typed/validated compiler support. The
  four full research-profile and three conclusion-contract failures listed above predate this
  slice and are the smallest remaining research-suite follow-up.
- 2026-07-14 primary/root: Review rework is now bounded generically at two failed independent
  reviews. The first failure supersedes its configured rework outputs exactly once; the second
  leaves the current candidate/output and both reviews intact, adds `review-rework-exhausted`,
  transitions to `blocked` where the profile permits it, and relies on the blocker to stop any
  further dispatch everywhere else. Focused circuit and five existing failed-review tests pass;
  formatting and `git diff --check` are clean. Source-only; no install or Updog mutation.
- 2026-07-15 primary/root: The bounded circuit above now has the explicit disposition it promised.
  Only nonempty ticket-scoped steering with kind `review-rework`, recorded after that exact blocker
  opened, permits `recover` to supersede the rejected output and reopen the configured correction
  step; both rejected candidates and reviews remain history and the steering event/hash are bound
  into the disposition. Ordinary recovery stays fail-closed. The Software CLI now passes its
  configured `ticket` parameter correctly, and worker/default Implementer instructions reject
  test-local replicas of production behavior as proof. This evolved from the live Medium
  historical-proof review loop; focused recovery tests pass and the live run remains quiescent
  until guarded refresh.
- 2026-07-14 worker-circuit-breaker/root: `engine.rs` is released. Before worker launch, Koni now
  evaluates only terminal, process-birth-identity-bound `AgentSessionRecord`s for the exact run,
  ticket, and step. Two consecutive sessions with no later durable current/superseded/quarantined
  step output open `worker-no-output-circuit-open`, transition to `blocked` when configured, emit a
  compiler event, and reject the would-be third dispatch. Tracked backends persist this exact
  runtime blocker in the lease worktree and project only it into board state, avoiding any commit
  of failed-attempt product edits; ordinary recovery retains it for explicit disposition. Focused
  four-test suite, formatting, and path-scoped diff check pass; no binary install or Updog mutation.
- 2026-07-14 terminal_resolver_runtime/root: `engine.rs` is released. Automatic finish
  compensation now selects the unique typed `terminal_resolver`, blocks the failed source without
  clearing its lease, and materializes one compiler-owned operational ticket keyed to that source.
  The resolver inherits the exact configured workflow and source scope; its binding carries the
  journal/action/input/failure hashes plus an allowlisted diagnostic, never the raw error. Replays
  reuse the same ticket and event, including after the journal reaches `failed`; a resolver's own
  failure records a blocker and `chain_suppressed` binding instead of recursively emitting. The
  explicit `recover` match remains authoritative. Focused/compatibility tests and path-scoped diff
  checks pass; no binary install or live Updog mutation occurred.
- 2026-07-14 software_proof_gate/root: Software profile proof cardinality and delivery coverage are
  ready for integration; `templates/software/{rules,operations}.yaml` and the new focused
  `tests/software_proof_gate.rs` are released. `objective.plan-change` now remains in its source
  state when any realized change has zero semantic proofs through the canonical inverse
  `verified_by`; `delivery.prepare` additionally requires at least one passing proof per change and
  accepted/completed direct prerequisites. The delivery review effect rejects the wrong objective,
  omitted changes/proofs/dependencies, and unrelated extras through exact set coverage before
  review. The end-to-end test proves zero-proof, merely-planned-proof, passing-proof, canonical
  storage, incomplete delivery rejection, and exact delivery acceptance against the real compiler.
  `cargo test -p koni-core --test software_proof_gate -- --nocapture` passed 1/1;
  `cargo test -p koni-cli installs_bundled_profiles_without_touching_product_state -- --nocapture`
  passed 1/1 (56 filtered); path-scoped `git diff --check` and targeted `rustfmt --check` pass. No
  binary install, cockpit restart, or Updog mutation occurred.
- 2026-07-14 verification_safety_review/root: Read-only review found a P0 stale-head/CAS bypass in
  post-target-sync verification. The binding at `engine.rs`'s composed-verification checkpoint
  proves one head/tree, but `bind_verified_promotion_head` accepts any descendant after audit or
  retry; `seal_run_for_target_promotion` advances the head again without re-proving the product
  projection; and `TargetPromotionRequest` has no expected run head. The minimum regression set is:
  reject a git-common run-ref advance after the final rebound, reject a tracked descendant that
  changes any product path, permit a tracked compiler-state-only receipt/seal delta, and reject a
  run-ref advance inside the repository-locked promotion CAS. No source or live-run state was
  changed by this audit.
- 2026-07-14 promotion_run_cas/root: `git.rs` is released with the repository-locked half of the
  P0 fix. `TargetPromotionRequest` now carries `expected_run_head`; `promote_run_to_target` resolves
  and compares the live run ref while holding the shared repository lock and refuses a mismatch
  before either replay repair or target mutation. Existing focused promotion requests bind their
  actual run commits, and `promotion_rejects_a_run_ref_advance_after_preflight` proves a later run
  commit leaves both the target ref and checkout unchanged. verification_head_fix/root supplied
  the only production callsite (`expected_run_head: run_head`) in its owned `engine.rs`. `rustfmt
  --edition 2024 crates/koni-core/src/git.rs` and path-scoped `git diff --check` pass. Two focused
  test attempts reached only unrelated context-spec/root compile errors in its mid-edit
  `engine.rs` (`Eq` derives, graph-seed pattern/helper work); rerun
  `CARGO_TARGET_DIR=/tmp/koni-promotion-run-cas-target cargo test -p koni-core
  promotion_rejects_a_run_ref_advance_after_preflight --lib -- --exact --nocapture` after that row
  releases. No install, cockpit action, or Updog/live-run mutation occurred.
- 2026-07-14 research_verifier_contract/root: Research scientific execution now separates causal
  evidence from automatic composed replay. `scientific-runtime` remains a current
  `workspace_write` receipt and explicitly declares `composed_replay: never`; its ticket also
  selects the repository-owned read-only `scientific-result-integrity` command from
  `runtime_contract.composed_verification_command`. The post-sync selector replays only that
  integrity command for experiments and continues to replay `gate-verifier` for gates, while an
  unannotated side effect still fails closed. The run-contract compiler rules require both argv
  contracts and bind durable output roots as verifier read input. Focused schema and exact
  experiment/gate selector tests pass; all 3 `research_result_contracts` tests pass; the CLI
  recursive Research source/template parity test passes. Owned Rust files are rustfmt-clean,
  full `git diff --check` passes, and profile compilation proves the strict YAML shape. Global
  formatting is temporarily red only in context-spec/root's still-active `engine.rs` slice. Files
  are released; no install or live project/run state was touched.

### 2026-07-14 — cross-agent documentation checkpoint (`primary-integrator/root`)

The user reconfirmed that every active implementation lane started from the shared `docs/`
specification and must evolve that specification as its domain changes. Before any lane is treated
as released, its owner must re-read the central registry, every current persona mailbox, and the
product docs affected by its behavior; record that sweep in its persona file; and append an
adjacent dated **Evolving to**, **Superseded by**, or **Transition** note wherever the new contract
changes an earlier decision. The earlier statement stays visible as history, while the note makes
the currently authoritative behavior unmistakable. This checkpoint reinforces coordination
protocol rules 7–13; it does not replace or normalize any earlier design language.

### 2026-07-14 — Evidence/runtime truthfulness release (`tui-polish/root`)

Visual-audit findings 2 and 4 are released for integration without broadening into timestamp
conversion or compiler/lifecycle mutation. Evidence now distinguishes recorded failures, partial
or absent proof, and durable positive proof: failure is red **Attention**, incomplete/empty state
is muted **No recorded issues** / **Evidence pending**, and only fully shaped zero-exception
compiler telemetry plus a current ticket/review/verification/report basis is green **Evidence
recorded** with that basis named. The former generic green `HEALTHY` candidate remains visible in
the TUI docs as superseded history. Failed review/pipeline state wins over an earlier output; a
missing workflow row, stale passed review, or configured report view cannot qualify.

Recent Activity now omits runtime for no selection, planning/provisional state, a missing or
malformed approval timestamp, or a missing numeric duration; a durably approved numeric zero still
renders `0s active`. Five exact locked regressions execute and pass 1/1 each; the report and
Activity filters pass 3/3; and the integrated TUI passes 288/288, including the parallel Graph
Seed hardening tests. Independent adversarial re-review found no remaining P0/P1 defect; scoped
formatting and whitespace checks pass. No new TUI source range is claimed, and no binary, profile,
cockpit, cmux, Updog, or live-run state changed.

### 2026-07-14 — Software proof-path transition (`software-default-design/root`)

The Software registry row's earlier 3/5, multi-anchor-pending text remains a historical checkpoint.
Generic per-anchor graph-set compilation now passes the proof-as-target regression, and Software
implementation review is being tightened to stamp the exact linked proof candidates already run by
its verifier. This eliminates routine duplicate proof tickets while keeping `proof.establish` for
standalone/stale/recovery work. The focused Software suite is currently 4/5: adverse execution
retains its failed terminal receipt without fabricating semantic proof state, while the success
path waits for the compiler owner's in-flight composite-parent receipt-type readiness repair and a
real output-then-compile broker-path rerun. Source-preservation execution binding and project-local
executable authority remain generic release gates. The Software YAML owner is also auditing
transitional duplicate test/proof fields before release; no Research, Updog, TUI, installed
profile, or live-run state belongs to this transition.

### 2026-07-14 — Software frozen-topology and expanded-gate transition (`software-default-design/root`)

The 4/5 paragraph above and the row's later 6/6 save point remain causal history. The Software YAML
owner has now frozen the ten semantic modules after staged bundled install/profile compilation and
embedded inventory parity passed 1/1. The final profile uses compiler-owned
`defect: unresolved -> diagnosed`, defect-only diagnostic proof before any speculative repair,
conditional `proof.prepare` for diagnostic/risk-boundary source, focused single-subject routine
implementation, risk-attached boundary proof after all subjects/controls, universal active-defect
closure, current accepted-risk proof, and exactly one revisable `candidate_ready` delivery. Routine
implementation is baseline -> compiler-proved implement -> independent review.

The expanded regression lane is active and has already exposed one generic pre-merge finish bug:
target-state currentness resolves covered product bytes from the main checkout instead of the
reviewed ticket lease worktree. Generic release also waits for direct target-member proof selection,
cross-ticket source-only preparation binding, source/production path disjointness, and the current
review-effect v1.1 provenance/configured-runtime gates. Raw/resolved five-run-type assertions,
focused profile/template checks, staged install, and both customization-skill validators are green;
the broader CLI filter is transiently compile-blocked by the separately leased Pi runtime Serde
tag/field collision. No Research, Updog, TUI, installed binary/profile, cockpit/cmux, or live state
was changed by this transition.

### 2026-07-14 — Software adaptive-path matrix correction (`software-default-design/root`)

The expanded Software suite's thirteen semantic cases remain useful, but a fresh source audit
finds three release-evidence gaps beside—not instead of—that history. Its shared change helper
hardcodes `current_verification`, so `red_green` and `characterization` have no complete successful
compiler path; structured worker output is recorded directly rather than traversing a configured
context/output/compile broker boundary; and the Bug Fix bootstrap case exercises legacy graph
grounding rather than compiling a normal prompt-conforming unresolved seed. The regression owner
has accepted a bounded expansion covering all three strategy contracts, a normal objective +
grounded system + unresolved defect + defect-only proof seed with no speculative change, and the
narrowest stable provider-neutral broker path available after coordination with the active Pi
runtime lanes. The ten frozen YAML files remain untouched until the generic preparation selector
and predicate publish a compiling interface. No installed, live, Research, Updog, TUI, cockpit, or
cmux state changed.

### 2026-07-14 — Pi integrated-security transition (`primary-integrator/root`)

The Pi core and migration focused releases above remain historical component checkpoints; they are
not a current combined-runtime release. An adversarial current-byte review adds an explicit
security hold before Pi can replace Codex: migration must reject symlinked ancestors, transform
only schema-defined fields, close the validation/publication race, and durably recover multi-rename
crashes; Rust must correlate outstanding requests and enforce session/turn/tool lifecycle; the SDK
host must terminally close every accepted turn even on asynchronous failure; upstream OAuth error
bodies must never expose token/device secrets on public frames or stderr; and production must have
no path around containment, a clean environment, fd-3 credential service, supervision, and the
compiler-owned broker adapter. Exact owner notes and negative-test requirements are appended to
the four Pi mailboxes, canonical Pi document, and integration matrix. No relocation, install,
migration, archival, cockpit/cmux action, live-run mutation, or forensic-run access is authorized
by this transition.

### 2026-07-14 — Prepared-source global immutability implementation (`software-default-design/root`)

The earlier cross-ticket row correctly records that the first boolean preparation predicate could
not drive an early later-ticket authority comparison. The preparation owner has now accepted a
bounded generic extension: an operation explicitly opts into a proof-source-preparation composite
check; current reviewed bindings from only those declared operations become global immutable
proof-source authority; and ticket emission plus lease acquisition reject equality or containment
between any ordinary/production write grant and those exact bound source paths. Exact selected
source-only re-preparation remains legal, while a literal, broad, or merely operation-labeled write
does not bypass the gate. The internal binding will retain operation/ticket/set/member/source path
and manifest identity, and the existing boolean predicate will delegate to it. Focused config,
overlap, disjoint, re-preparation, superseded/noncurrent, multiple-binding, and late-binding tests
are required before Software consumes the declaration. This deliberately defines global source
immutability instead of inventing Software rule causality; finish-time currentness remains
defense-in-depth.

**Independent provenance hold — 2026-07-14:** the operation-level design above remains accepted,
but it is not released on classifier shape alone. `proof-preparation-review.md` found that the
current preparation helper must authenticate the canonical pre-effect review input, not merely a
self-consistent durable reviewer record and rewritten receipt envelope. Release now also requires
negative cases for source-manifest/argv/receipt rebinding, workflow/scope drift, newest stale or
failed preparation, declaration/predicate disagreement, omission-compatible profile hashing, and
both emission-time and late lease-admission overlap. The preparation owner has accepted this gate;
Software will not consume `prepared` as current evidence before the adversarial matrix passes.

### 2026-07-14 — Schema-1 catalog/profile discovery regression (`software-default-design/root`)

After the Software 14/15 checkpoint, the active Pi/schema-2 config lease reordered profile
discovery so `.codex/koni/project.yaml` precedes `.codex/koni/profile.yaml` (with the same root-level
ambiguity). A normal installed project contains both catalog and profile, so fresh Software
fixtures now decode the catalog as `ProfileManifest` and fail `missing field profile` before any
semantic test. The exact compatibility bug and both-files regression request are appended to
`pi-schema-migration.md` and `pi-runtime-architect.md`; the Software fixture will not delete or
rename its real catalog to manufacture green. No installed/live state changed.

**Resolved beside this checkpoint — 2026-07-14:** the schema owner restored unambiguous
manifest discovery without weakening schema 2: `.koni/profile.yaml` keeps precedence, historical
`profile.yaml` and `.codex/koni/profile.yaml` are recognized as manifests, and `project.yaml`
is no longer a manifest candidate. Its focused installed-schema-1 fixture keeps both
`.codex/koni/profile.yaml` and `.codex/koni/project.yaml` present and passes 1/1, so the Software
regression lane may resume on the real installed shape. This resolution does not disposition the
separate migration-security hold below or claim the expanded Software matrix green.

### 2026-07-14 — Pi credential-serialization transition (`primary-integrator/root`)

The intended per-user lock contract remains in the Pi design history, but the active credential
implementation derives its lock namespace from mutable `TMPDIR`. Same-UID hosts with different
temporary directories can therefore bypass each other's lock, read the same keyring revision, and
both commit N+1, losing a rotated refresh token. Pi release now additionally requires a validated
UID-stable lock namespace, persistent-revision revalidation at commit, and a real two-process/
different-`TMPDIR` regression. Exact design and matrix notes are appended to the architect mailbox
and canonical Pi document; no credential, process, installed binary, or live state was touched.

### 2026-07-14 — Pi browser-OAuth containment transition (`primary-integrator/root`)

The macOS Seatbelt design currently grants outbound networking but not the loopback bind/inbound
authority Pi's browser callback requires. On denial, Pi requests manual code while Koni's host
waits only for abort, so login can hang indefinitely. Integrated release now requires either an
exact loopback-only callback grant or deterministic fail-fast device-code fallback, plus bounded
authentication cancellation and compiled-policy tests proving no listener/controller/credential
transaction/child survives. The original containment goal remains visible in `pi-runtime.md`
beside this hold; no source, credential, process, or live state was changed.

### 2026-07-14 — Pi credential-race remediation checkpoint (`primary-integrator/root`)

The preceding `TMPDIR`/stale-CAS finding remains the causal record. Current source now uses a
canonical UID-stable lock root, no-follow/CLOEXEC descriptor, persistent revision revalidation,
and contains the requested distinct-`TMPDIR` process and stale-CAS regressions. That gate is now
`remediation_pending_verification_and_re-review`; it is not erased, and it does not close the
remaining Pi security or whole-project gates. No credential or live state was touched.

### 2026-07-14 — Pi composed-process authority transition (`primary-integrator/root`)

The newly wired public process is not yet a release despite lower-level component greens. Current
security review requires an opaque independently pinned runtime artifact with launch-time file
identity, terminate/reap on every broker/callback/protocol error, no-follow compiler-owned stderr,
and operation-scoped expiring fd-3 authority for login/logout/refresh rather than ambient
credential modify/delete. Malicious PATH/swap, continued-token-spend, symlink-truncation, and
unsolicited credential-mutation cases are now part of the frozen Pi matrix. Exact details are in
the architect mailbox and canonical Pi document; no source or live state was changed by this note.

### 2026-07-14 — Proof-preparation review expansion (`primary-integrator/root`)

The same-ticket source/write guard remains released and the new global prepared-source closure
remains in progress. Independent review adds two pre-release gates: recompute/authenticate the
durable review's canonical input boundary so a re-bound source/receipt/command cannot inherit an
older verdict, and exercise the predicate itself through real tracked/Git-common state across every
bound dimension while covered-product-only drift stays valid. Expression/config tests or a
downstream Software result do not substitute. Owner and frozen-matrix notes were appended without
editing the moving compiler source.

### 2026-07-14 — Review-effect current-source status reconciliation (`primary-integrator/root`)

The earlier signed `review-effect-semantics` verdict and v1.1 interim row remain their snapshot
history, but their two named P1 gates are closed in current source. The later independent
`graph-tdd-boundary-audit` verifies reconstructed-pre-state canonical input in both replay states,
complete candidate/effect/post-hash provenance, a profile-validated Software two-effect
Git-common regression, byte-idempotent replay/zero writes/omission rejection, and canonical leased
review/acceptance roots. Owner-focused evidence is 1/1; an independent rerun remains queued behind
foreign moving Pi/lifecycle compilation, so the immutable final matrix still reruns it. Cross-
ticket preparation and documented P2/reliability hardening remain separate rather than reopening
the review-effect gates. The old mailbox now carries an append-only supersession note.

### 2026-07-14 — Software diagnostic cardinality clarification (`root`)

The final Software design audit found that the negative duplicate-diagnostic regression correctly
stops preparation fanout but the grounding ticket lacked an honest repair contract. The profile
now treats this as fail-closed semantic change control: zero mutations, exact conflicting proof
IDs, and a request for human-authorized oracle selection or replanning. Missing diagnostic proof
remains an automatically groundable gap. Separately, implementation subjects may carry multiple
single-subject focused proofs for genuinely distinct evidence gaps; “nonredundant” remains
independent Reviewer judgment, not a claimed compiler theorem. Product docs, the customization
skill, operation/rule, and Run Planner carry adjacent current guidance without erasing history.

### 2026-07-14 — Software efficiency/version calibration and external compile hold (`root`)

The final independent Software audit recommends and current templates now use 120k/240k/480k
planning ceilings with 25% synthesis reserves, while retaining 1/3/5 parallelism as ceilings for
independently admissible work. New Feature and Bug Fix inherit Medium. The redesigned graph,
rules, operations, checks, and workflows modules now identify as 0.4.0; support modules retain
independent versions. Research is unchanged. Final regressions are temporarily held by the
compiler review-boundary lane's undefined historical-preparation helper and mismatched helper
signature, routed with exact symbols to `compiler-graph-tdd.md`; the prepared-source authority
owner is not taking that foreign seam.

### 2026-07-14 — Moving Pi source compile hold (`root`)

The compiler review-boundary helpers have reappeared, but current shared compilation next stops in
`pi_runtime_process.rs` where a `Result<&str, &KoniError>` is compared with `Ok(...)` even though
`KoniError` has no `PartialEq`. The exact expression is routed to the Pi architect mailbox and left
untouched by Software/lifecycle owners. Their queued regressions remain integration-red rather than
profile-red until the Pi owner restores a stable crate build.

### 2026-07-14 — Current compile-hold supersession (`root`)

The earlier compiler review-boundary undefined helper/signature diagnostic is superseded on current
bytes. The latest independent check instead stops at the active prepared-source seam's undefined
`validate_persisted_ticket_prepared_source_admission` plus the separately recorded Pi
`Result == Ok` type error. Both remain owner-routed integration-reds. Software's 17 YAML documents
parse, but final Rust/profile regressions wait for one stable source fingerprint.

### 2026-07-14 — Compile window restored (`root`)

The current prepared-source admission helper and Pi result predicate are both restored. The
prepared-source owner reports `cargo check --locked -p koni-core --lib` green in its isolated
target (warnings only); deterministic same-ID lifecycle tests are now rerunning against current
bytes. This supersedes the two compile-hold notes above while leaving the prepared-source
adversarial matrix, full Software profile suite, CLI picker suite, and immutable integration
fingerprint open.

### 2026-07-14 — Prepared-source exact-write authority sub-release (`proof-preparation-binding/root`)

The earlier global-immutability and independent-provenance holds remain visible and still govern
the complete feature. One bounded sub-gate is now source-closed: a declared proof-preparation
operation may carry only exact compiler-selected source projections for its declared composite
check. Emission rejects literal, broad/root, disjoint-product, sibling, undeclared-source, and
different-check writes rather than persisting only the valid subset. Lease admission revalidates
the capability against the complete persisted ticket and explicit step write scopes before the
existing-lease fast path, closing tickets emitted before later preparation and stale-lease retry.
Only exact same operation/check/source/path re-preparation is exempt. Isolated current evidence is
core lib check green, preparation tests 8/8, exact conflict 1/1, and existing graph-source authority
2/2. The historical-review boundary, real tracked/Git-common predicate matrix, complete Software
suite, install, and live state remain separate open release gates.

### 2026-07-14 — Software diagnosis/preparation cycle corrected (`root`)

The central cycle finding is accepted without weakening generic currentness. Diagnostic
preparation now targets only the semantic proof node while retaining the defect in read/review
scope; its exact `verifies` edge remains proof-bound. Risk-boundary preparation still targets proof
plus risk. This permits diagnosis to add its intended causal fields without revoking the prepared
oracle, while proof retargeting and proof/command/source/review drift still fail closed. The Bug Fix
bootstrap case now asserts zero re-preparation and successful change-planning eligibility after
diagnosis; final evidence awaits the frozen full suite.

### 2026-07-14 — Prepared-proof first-review lifecycle cycle (`root`)

The diagnostic proof-only target projection is accepted by the generic owner, including exact
`verifies`-edge invalidation. Its exact Software bootstrap nevertheless exposes a separate generic
cycle: the currentness predicate requires a durable passed review, but review admission currently
requires that same predicate to be satisfied before review. The preparation owner is adding a
narrow declared-operation pre-review readiness proof over exact operation/check/targets, compiled
baseline/source/output/effect state. Software will not revert to status-only emission, weaken all
review target-state checks, or claim preparation green until this exact path passes.

### 2026-07-14 — Customization co-located-oracle guard (`root`)

The final Software design audit's P2 usability finding is implemented in the customization skill:
repository discovery now detects tests/harness bytes co-located with product writes, prefers an
existing external repository-native seam, and otherwise asks the user for a separate-harness or
explicit compiler/workflow-authority decision with the lost preservation guarantee stated. It may
not silently relabel new behavior or trust prompt-only sub-file separation. Both shipped skills
validate successfully; Research semantics remain unchanged.

### 2026-07-14 — Preparation first-review candidate boundary (`proof-preparation-binding/root`)

The preparation first-review cycle is closed without weakening ordinary target-state checks. The
review-only wrapper defers only the exact typed self-preparation fact, then independently proves the
declared operation/check/targets, complete compiled historical baseline, current output and member
receipts, unchanged source manifest, independent reviewer dependency, and exact prospective effect.
Failed review establishes no binding; persisted review and finish still use normal currentness.
Core lib check is green, and the exact Software Bug Fix lifecycle now clears preparation and
reaches its later proof-promotion review. The separate authenticated successor plus shared
newest-attempt seam is actively leased to `compiler-graph-tdd/root`; this lane is read-only there
until a fingerprint and named successor/supersession tests are published. `prior_cycles` remain
audit-only and cannot authorize preparation or succession.

### 2026-07-14 — Software final-gate coordination (`root`)

The declared-operation pre-review wrapper is now present and proves the exact composite check,
complete targets, independently produced output, current historical receipt/argv/source manifest,
and prospective compiler-owned review effect before deferring the not-yet-durable review fact.
Two later findings remain active beside that repair: predicate truth and global prepared-source
authority must share newest-attempt supersession across target universes, and an exact configured
review-effect successor may advance `prepared` to `passing` without authorizing arbitrary status
drift. Successor authority must bind the current review/effect/candidate boundary, never a reused
deterministic ticket ID or audit-only `prior_cycles`. Root is not editing `engine.rs`; unrelated
Pi/schema/reaper lanes are still moving it, so Software/Pi and lifecycle functional greens remain
provisional until one whole-file fingerprint window is available.

Getting Started also retains its original “architecture-grounded” Software description and now
places the `0.4.0` Evidence-Guided Vertical Delivery replacement directly beside it. This is an
append-only history correction; Research remains unchanged.

### 2026-07-14 — Successor-regression test handoff (`root`)

The external compiler owner may extend only the existing exact Bug Fix regression while its
authenticated-successor lease is active: after promotion, one more compile must emit no new
preparation, diagnosis, or proof-establishment ticket. Software profile/configuration bytes remain
frozen. A release result must bind the executed binary to stable pre/post engine and test-source
fingerprints and must prove current-cycle authority rather than deterministic ticket ID or
`prior_cycles` history. The older moving-binary failure remains preserved as diagnostic history,
not evidence about current source.

### 2026-07-14 — Successor replay performance hold (`root`)

The external owner's exact Bug Fix lifecycle now reaches the final compile that verifies the
promoted preparation's global source lock, but its test child remains CPU-active far beyond the
earlier roughly four-second lifecycle. A read-only stack sample shows multiplicative work rather
than recursive stack growth: rule/fixpoint evaluation repeatedly enters
`current_proof_preparation_bindings_with_successor` -> `authenticated_successor_review_effects` ->
historical review validation -> ticket receipt loading/YAML parsing. The compiler owner retains the
seam and has the exact stack. Release now also requires bounded/indexed successor enumeration and
a termination/runtime regression; no Software profile or foreign process was modified.

### 2026-07-14 — Deterministic same-ID lifecycle scoped release (`deterministic-ticket-reopen/root`)

The two earlier lifecycle ledger rows retain the collision discovery and pending-unit language as
history; their current scoped status is `ready_for_integration` (formerly `in_progress`). Exact
generic terminal reopen is **2/2**, and the four lifecycle-relevant retirement/recovery cases are
**4/4**. A later broad retirement filter is **5/5** because an independently owned
schema-migration test also matches. The exact Software stale-delivery consumer is **1/1** through
its second managed cycle. Generic execution held one whole-engine hash before/between/after, while
the earlier Software consumer crossed unrelated engine movement; therefore one minimal
post-successor exact Software rerun remains queued after the authenticated successor owner
publishes a stable fingerprint. This closes the generic worktree/branch namespace defect only. It
does not claim the complete Software, preparation/successor, Pi, Research, TUI, installed/live, or
whole-project matrix.

### 2026-07-14 — Software initializer/catalog scoped release (`root`)

Five exact CLI tests pass **1/1** each for explicit controls, no-write non-interactive refusal,
interactive selection/reprompt, fresh/replacement versus existing/legacy behavior, and packaging
the five Software run types. The initializer/template source fingerprint remained
`b8520deaede8393073df8a03c8c1d46f3cf3ead0b5b99e4ab5e19da277bb41bb` before and after. This
closes the user-facing `koni init`/catalog slice only; successor/currentness, the full Software
matrix, the configured broker rerun, and Pi cutover remain separate gates.

### 2026-07-14 — Successor replay hold reproduced on matched source (`root`)

The external owner rebuilt the exact Bug Fix lifecycle from engine hash
`b66966155276e18a493866c1046340c9414c780b83fe75931fb5272d134d32ba`; that source remained
unchanged while the test child consumed roughly one CPU core beyond 25 seconds (versus the earlier
roughly four-second lifecycle). Completion or owner termination is still needed for a semantic
test result, but source movement no longer explains the replay cost. The sampled multiplicative
ticket/receipt path and bounded per-compile indexing/memoization requirement remain the release
gate; no foreign process or leased symbol was modified by this observation.

### 2026-07-14 — Preparation successor/currentness source transition (`compiler-graph-tdd/root`)

The earlier compiler/preparation rows and performance hold remain their causal checkpoints.
Current source now shares newest preparation selection across predicate and global source-lock
consumers; authenticates strictly ordered value-acyclic configured-effect successors; treats
`prior_cycles` as audit-only; enforces older-than-current replay cutoffs including post-cutoff
re-review tombstones; and scopes active Git-common evidence to the exact ticket materialization
until terminal publication. The exact Bug Fix lifecycle passes through preparation, diagnosis,
implementation, promotion, zero repeated work, and a genuinely implementation-ready overlapping
write rejection. Generic graph-set remains 6/6, and the focused successor/visibility/selector/
two-effect/drift cases are green at their recorded moving-tree checkpoints.

The successor performance hold is source-addressed but not yet released: one full compile now
authenticates the preparation/successor set once for its immutable graph/ticket epoch and passes
the same typed slice to all rule predicates and prepared-source write admission. Projected and
prospective paths remain fresh. A thread-local counter assertion requires exactly one scan in the
existing full Software direct-broker compile test; its queued run is currently blocked by a
concurrent Pi `agent_runtime.rs` stderr-drain refactor. Final release still requires that counter
test, the named focused matrix, and stable pre/post engine/config/state/test fingerprints on one
shared-tree revision. No installed profile, live run, or foreign runtime source was modified by
this lane.

#### 2026-07-16 — post-H2 relocation operational-finalization regression active

`relocation-lifecycle-tests/root` reopens its test-only lease for complete tracked H2 with the Git-
common synchronization marker absent and, where the fixture permits, one clean empty leased ticket
ref/worktree restored to its recorded base. The regression will require ordinary quarantine,
configured marker/ticket synchronization recovery with integration H2 unchanged, and running exact
replay idempotence across semantic state, marker, integration HEAD, and ticket checkout. Production
remains with `primary-integrator/root`; details are append-only in
`agent-collab/relocation-lifecycle-tests.md`.

### 2026-07-14 — Software prompt/authority consistency correction (`software-default-design/root`)

The final Software-only byte/config audit found two instruction contradictions while accepting the
graph topology. The contract-designer no longer invites unauthorized `decision` creation and still
escalates an unresolved product choice. The planner and modeling skill now require recovery plus an
already human-approved review-authority decision for every critical change, without claiming that
the decision mechanically proves specialist competence; unavailable required expertise blocks.
The exact embedded-template regression passes **1/1** with 64 filtered tests. Historical prompt
language remains in the audit mailbox beside this transition. Research, installed profiles, live
state, and the generic successor seam were not modified.

### 2026-07-14 — Compiler graph-TDD/preparation scoped release (`compiler-graph-tdd/root`)

The stale one-scan/queued-counter paragraph above remains the causal checkpoint. Current source
uses two distinct authority layers: preparation truth is cached only for the complete normalized
graph, while immutable tickets and receipts are indexed once across all derivation graph identities
under the exact state-root/tickets-directory/receipts-directory tuple. Reconciliation starts a
fresh evidence epoch for final rule emission and prepared-source write admission. Local projected,
prospective, integration, and historical resolvers reuse only their own reentrant evidence index;
they do not share graph results or weaken materialization/cutoff semantics.

Stable engine hash
`50e310cde301e2457761453002caca96be648dfa97af900b1aad974de273b2cd`
passed: core check; preparation **16/16**; Git-common visibility **1/1**; exact two-effect replay
**1/1**; graph-set **6/6**; Software drift **1/1**; exact Git-common materialization **1/1**; and
the complete Bug Fix lifecycle **1/1** in 28.00 seconds, with all declared engine/config/state/test
hashes identical before/after. The direct broker/counter separately held its runtime/broker/lock
surface unchanged and passed **1/1** in 9.15 seconds. Counters prove three exact-graph scans, two
source-evidence indexes, lazy zero receipt parses for a fresh run, and one receipt parse per
evidence epoch when records exist. Independent audit found no P1. Two pre-existing P2s remain in
the compiler mailbox: generic projected-resolver recursion policy and legacy current-time coverage
in direct review-effect replay. This is a scoped compiler release, not Pi cutover, installation,
live-run mutation, or whole-project release.

### 2026-07-14 — Compiler scoped release rebased after shared source movement (`compiler-graph-tdd/root`)

Schema-2/catalog/state/test work moved the whole-file checkpoint after the `50e…` matrix, so the
compiler owner reran rather than inferring. Current engine hash
`54ca55d60bb58db03fa91f7776d6119d0e5f85322bf73c6be3ccf52522ab5497`
held through core check, preparation **16/16**, direct broker/counter **1/1**, graph-set **6/6**,
Software drift/materialization **2/2**, full Bug Fix lifecycle **1/1** (27.23 seconds), and
successor visibility/two-effect replay **2/2**. The declared catalog/config/state/Software-test/
graph-set-test inputs also held unchanged for the wrapped rerun; their exact hashes are in the
compiler mailbox. Unrelated lib tests were added concurrently outside that set. The compiler
scope remains `ready_for_integration`; its two P2s and every Pi/install/live/whole-project hold
remain unchanged.

### 2026-07-14 20:45 MST — Software 20-case fixture reconciliation (`root`)

The first complete current Software matrix ran **16/20** on the compiler owner's released `50e…`
engine and pre-correction `f717…` test hash. All four failures were stale fixtures under deliberate
fail-closed behavior: graph ownership, independent source-only proof authority, and risk-bound
preparation currentness. The Software owner made test-only corrections and strengthened the risk
case to re-review boundary evidence after both mitigation and acceptance changes; profile YAML and
generic compiler semantics are unchanged. Corrected test hash is `aa60ba…`. A focused rerun was
functionally green but crossed unrelated engine movement to `54ca…`, so the registry keeps it
diagnostic. Remaining Software gate: stable four-case rerun followed by stable **20/20**.

### 2026-07-14 20:54 MST — Software 0.4 immutable matrix complete (`root`)

The Software gate immediately above is closed. The corrected suite passed **20/20**, 0 failed, in
62.23 seconds with identical pre/post `engine.rs` `54ca55d6…` and Software-test `aa60ba01…`
fingerprints. The test-only reconciliation preserved all fail-closed graph, source-authority, and
risk-currentness behavior; no generic compiler or profile topology was weakened. Software profile,
run types, prompts, customization skills, initializer behavior, and compiler consumer integration
are ready for final review. Pi security/cutover, Research, installed/live state, and whole-project
release remain separately owned and must not be inferred from this row.

### 2026-07-14 20:57 MST — current schema-2 init/profile gate complete (`root`)

The first current CLI refresh was 5/6 because its replacement fixture used the legacy schema-1
installer; the product correctly routed that state to migration rather than allowing replacement.
The test now uses the schema-2 fresh-install helper and no product policy changed. All six exact
profile-selection/catalog/prompt checks pass **1/1** each on stable `main.rs` `9f40c862…` and
`templates.rs` `fe9cd9a8…`: explicit controls, noninteractive no-write refusal, interactive picker,
fresh/replacement versus existing/legacy handling, five proportional Software run types, and one
reviewed vertical candidate by default. The migration owner was notified beside its released history.

### 2026-07-14 21:00 MST — full CLI integration green (`root`)

The current schema-2 gate above was followed by all 66 CLI binary tests. The first pass reached
65/66 because the idempotent-existing-install fixture also used the legacy schema-1 helper and
correctly entered migration. That test now constructs the schema-2 state it describes. Its exact
case is green and the complete CLI binary passes **66/66**, 0 failed, on stable `main.rs`
`1a4af3ff…` and `templates.rs` `fe9cd9a8…`. Both post-schema-2 corrections are test-only; initializer
selection, migration authority, and profile semantics were not relaxed.

### 2026-07-14 21:09 MST — installed skills aligned with live schema 2 (`root`)

Final integration review caught a material shipped-guidance drift: fresh init publishes `.koni`,
but `configure-koni`, `model-koni-work`, and `operate-koni` still treated `.codex/koni` as the only
live root. The skills now prefer `.koni`, resolve each cataloged profile source, use provider-neutral
agents/current persona fields, preserve an explicit schema-1-only path, and reject mixed roots.
Installed-artifact and embedded-template assertions cover both current and legacy wording. Three
skill validators, 12/12 YAML examples, two exact integration tests, and full CLI **66/66** pass on
stable `main.rs` `d627bb43…` / `templates.rs` `5d637228…` hashes. No migration authority or Software
topology was weakened.

### 2026-07-14 — Pi runtime/schema-2 implementation closure (`pi-runtime-architect/root`)

The active implementation scope in registry row “Replace Codex completely with a direct,
Koni-owned Pi SDK runtime” is complete and released for final review. Its earlier `in_progress`
wording remains above as the causal specification. Production planning, review, worker, and Lead
routes have one direct Pi path with no Codex fallback; subscription OAuth remains private-fd3 and
API-key-free; Rust retains graph/tool/Git authority; `.koni` schema 2 is live for discovery,
snapshots, init, migration, CLI, and TUI authoring; and active Codex-backed runs archive rather than
resume.

Final cross-lane evidence is recorded in `docs/pi-runtime.md` and
`docs/agent-collab/pi-runtime-architect.md`: host 34/34 and zero production dependency advisories;
direct Pi 9/9; runtime supervision 9/9; generation-strict `thinking_level` 2/2; fresh-init and
in-place-migration new-run regressions 1/1 each; TUI/CLI/replay focused checks; locked CLI build; and
a clean temporary-prefix release install whose contained packaged `koni models --json` reports Pi
SDK 0.80.7 with no ambient resources or credentials. The package smoke also found and closed
owner-only scratch and canonical macOS Seatbelt ancestor-traversal defects before this release.

This closure authorizes no user installation, credential mutation, live project migration, or
live/forensic run action. Linux networked login/inference remains intentionally unsupported until
an allowlisted egress broker exists; opt-in live subscription inference and the packaging audit's
supply-chain follow-ups remain explicit operator/release work, not a Codex fallback.

### 2026-07-14 — Software current-head revalidation queued (`software-default-design/root`)

The Software lane's earlier immutable **20/20** result remains valid for engine `54ca55d6…`, but a
later compiler integration moved `engine.rs` to `79080f2c…`. A foreign locked whole-workspace test
is currently exercising that shared tree, so this lane is not starting a competing Cargo process or
projecting the older result onto the newer compiler. The Software test, CLI initializer, and
template fingerprints remain `aa60ba01…`, `d627bb43…`, and `5d637228…`. Final Software closure is
queued behind the active workspace run: re-run all 20 profile cases on one unchanged current engine
and preserve the older fingerprint as historical evidence. No profile, Research, Pi, live project,
credential, or installed state is changed by this coordination hold.

### 2026-07-14 21:13 MST — Software current-head revalidation complete (`software-default-design/root`)

The queue immediately above is closed without a profile or compiler change from this lane. After
the foreign workspace run exited, the complete Software proof binary passed **20/20**, 0 failed, in
63.54 seconds (70.80 seconds wall time), with identical pre/post SHA-256 fingerprints:
`engine.rs` `79080f2c…` and `software_proof_gate.rs` `aa60ba01…`. This is the current Software 0.4
consumer release checkpoint and supersedes only the queued hold; the earlier `54ca…` result remains
historical evidence. The result does not widen into Research, Pi security/cutover, installed/live
state, or a whole-repository release claim.

### 2026-07-14 21:15 MST — Software dependency rebase reopened (`software-default-design/root`)

The `79080f2c…` **20/20** checkpoint above remains immutable evidence for those exact bytes, but a
subsequent wrapped CLI run detected `engine.rs` moving to `9131b388…`; its 66/66 assertions are
therefore diagnostic rather than current-head integration evidence. The compiler owner is now
running the exact Research Git-common reacceptance case followed by another locked workspace run.
Software has queued a lease-endpoint question in `compiler-graph-tdd.md` and will not compete with
that Cargo process. No Software profile, fixture, CLI source, Research configuration, Pi state,
credential, installed project, or live project was changed by this re-opened dependency hold.

### 2026-07-14 21:29 MST — Software/CLI endpoint race classified (`software-default-design/root`)

After the context owner's `clippy --fix` pass appeared quiescent, one sequential wrapped command
ran Software then CLI. Software passed **20/20** and CLI passed **66/66**, but the engine changed
from `c775d468…` to `e180e8df…` before the Software post-run hash; only the following CLI phase held
`e180e8df…` stable. Therefore Software remains diagnostic and CLI is current on that endpoint.
Software will wait for a quiescent interval and repeat only its complete 20-case gate. No foreign
source, profile, fixture, install, credential, or live state was mutated by this consumer run.

### 2026-07-14 21:41 MST — Software final stable endpoint (`software-default-design/root`)

The endpoint race above is closed. After the context owner's locked workspace/check/clippy cycle
settled, a single sequential wrapper passed Software **20/20** (0 failed, 71.91 seconds) and CLI
**66/66** (0 failed, 3.13 seconds). `engine.rs` `41436b37…`, Software test `aa60ba01…`, `main.rs`
`d627bb43…`, and `templates.rs` `5d637228…` were identical before, between, and after both test
binaries. Use this as the current Software 0.4 + initializer/template checkpoint; retain all earlier
moving snapshots as diagnostics. Software source/docs are released. Research design, Pi host/
security/cutover, installation/live state, and whole-repository release remain independent scopes.

### 2026-07-14 — Pi cutover final release candidate (`pi-runtime-architect/root`)

The Pi/schema-2 lane is complete and released at `engine.rs` SHA-256 `41436b37…`; no source or Cargo
lease remains. Final integration preserved historical schema-1 run hashes, made failed refresh
preconditions non-consuming, distinguished legitimate pre-start/terminal Git-common integration
projection from strict active-ticket canonical-lease authority, and removed compiler hashes/runtime
identity from fresh model-facing planning history. No production Codex fallback or API-key path was
added.

Current-byte evidence is CI-complete: locked all-target clippy with `-D warnings` green; locked
whole workspace **1,041 passed, 0 failed, 3 intentionally ignored**; Pi host **34/34** with verified
873,700-byte bundle SHA `257c374…`; zero production npm vulnerabilities; Rust format and diff checks
green. A fresh post-cleanup temporary install passed pinned Node/npm verification, SBOM validation,
optimized build, and the contained packaged model probe, then was removed. The probe reported Pi
SDK 0.80.7, `openai-codex`, no ambient credentials/resources, and compiler-brokered tools only.
Live subscription inference, credential mutation, user install, project migration, and live/
forensic run mutation remain deliberately unexercised; Linux networked login/inference remains
unsupported pending destination-allowlisted egress.

### 2026-07-14 21:55 MST — Updog Medium smoke-readiness audit (`updog-smoke-audit/root`)

A bounded read-only lane is reconstructing the exact questionnaire/SPICED objective from durable
forensic artifacts and inventorying current Updog Git, Koni install, cockpit, process, and run
state. It may write only `docs/agent-collab/updog-smoke-audit.md` plus this append-only checkpoint.
It will not install, launch, signal, recover, migrate, edit Updog, or mutate/resume/delete the two
protected forensic runs. Its handoff will be an evidence-backed fresh Medium-run launch recipe and
acceptance checklist for the primary integrator; it does not itself authorize the smoke run.

### 2026-07-14 21:55 MST — primary release integration and Medium acceptance (`primary-integrator/root`)

Parallel feature ownership is closed; the primary integrator now owns the frozen release matrix,
guarded local install/project transition, and fresh Medium Updog acceptance runs. Older proof and Pi
security findings remain preserved as history. Direct current-byte inspection at engine
`41436b37…` finds their source repairs present: one newest preparation-attempt selector is shared by
predicate and write-lock consumers; Linux stages the verified launcher into canonical owner-only
scratch; and schema-2 publication uses no-follow descriptor-relative `renameat` with leaf/ancestor
swap regressions. The independent runtime audit and a fresh stable matrix must still agree before
installation. The two forensic Updog run IDs remain permanently read-only; all execution will use
new run IDs and durable evidence will be appended rather than retroactively editing old claims.

### 2026-07-14 22:05 MST — Updog smoke-readiness audit released (`updog-smoke-audit/root`)

The read-only inventory is complete in `docs/agent-collab/updog-smoke-audit.md`. Preserve the
21:55 acceptance intent above as history, but its phrase “guarded schema-2 Updog update” cannot be
performed in place under the same protected-run contract: current `koni init` detects the live
schema-1 `.codex/koni` and archives schema-1 runs before publication, necessarily mutating both
forensic IDs. The safe current transition is a true independent clone of `harness-testing`, an
isolated current-build prefix, a fresh schema-2 Software 0.4 installation/run namespace, and a
separate cockpit; a linked worktree is insufficient because it shares `.git/koni`.

The mailbox records the exact 4,098-byte objective artifact and hash, exact durable revision
steering, current Git/install/process/run evidence, required Updog ticket-worktree dependency setup
and reviewed `mise` trust boundary, Medium model/budget defaults, a launch recipe, and product,
planning-economy, runtime-containment, lifecycle, evidence, and promotion acceptance checks. No
Updog file, ref/worktree, installed binary, credential, process, cockpit/cmux surface, or run
artifact was changed; both protected orchestration records remain `running: false`. This lane is
released and the primary integrator owns any authorized execution after its frozen matrix.

#### 2026-07-14 22:12 MST — isolated Updog acceptance checkpoint (`primary-integrator/root`)

Frozen release evidence is green on unchanged bytes: workspace **1,041/1,041** with three
intentional ignores and Pi host **34/34** plus verified bundle `257c3741…`. The live Updog
schema-1 root cannot be migrated without archiving protected evidence, so the acceptance topology
has moved—beside, not over, the earlier plan—to true clone
`/Users/max/Desktop/updog-koni-acceptance-1`, isolated packaged prefix
`.koni-acceptance-runtime.Fyg4xa`, Software 0.4, and clean baseline `bb99311bda…`. A project-local,
validated worktree setup check supplies Updog dependencies without changing the generic profile.
The original cockpit/global binary remain running and unchanged; pre-launch protected-directory
aggregate hashes are `50a7fe3606…` and `2ea5c202e0…`. The isolated cockpit is visible in cmux as
`Koni acceptance`; token-spending work waits on explicit contained ChatGPT device login.

### 2026-07-14 22:45 MST — provider-error projection read-only audit (`provider-error-projection/root`)

The first isolated zero-token provider rejection exposed a diagnostics and retry-semantics gap
separate from its now-identified request-shape cause. Current host code collapses normal provider
failures to `pi_runtime_error` / `Pi provider turn failed` / non-retryable, while broader caught
errors can still project arbitrary `Error.message` through pattern redaction. Rust then discards
the wire retryable bit, and planning dispatch can relaunch a failed record without consulting a
class or bound. The exact read-only handoff in `agent-collab/provider-error-projection.md` specifies
a seven-class fixed allowlist, secret-negative stdout/stderr/transcript tests, Rust tuple
validation/typed preservation, and the distinction between transient provider cause and safe agent
replay. No source, test process, auth/inference, binary, project, cockpit, or run state was touched.

The same audit records a required documentation transition beside every older output-cap claim:
the live rejection proved ChatGPT Codex does not accept Koni's invented `max_output_tokens` field,
and current source now tests that it is absent. `output_token_budget` remains local cumulative
accounting plus a between-round continuation bound, not a provider/billing hard cap for one Codex
response. Preserve the old injection claims as repair history and append this current contract.

### 2026-07-14 22:57 MST — repository-name and Pi browser-login transition (`primary-integrator/root`)

At the user's direction, the repository root is now `/Users/max/Desktop/koni`; source/docs/config,
Git metadata, Desktop scripts/symlinks, and cmux state have no reference to the former root. Legacy
CLI packages were uninstalled, generated build caches containing the former absolute path were
removed, and current `koni-cli` will be reinstalled from the new root after the release build. One
transient former-root argument belongs only to this live ChatGPT kernel and clears on a natural
session restart; it is not authority to terminate the session. Protected Updog state was untouched.

The earlier device-code-only login checkpoint is now superseded beside, not erased by, Pi's normal
local flow. Current source selects `BrowserPkce`, allowlists and opens only OpenAI's pinned
authorization endpoint, keeps Pi's optional manual-code prompt pending while the browser callback
wins, and gives only the short-lived macOS login host Seatbelt inbound authority for exact local
TCP port 1455. Inference/model/status/logout have no inbound grant; callback implies outbound
networking; Linux remains fail-closed. Focused evidence is green: Pi runtime/protocol **34/34** plus
typecheck/build/smoke, CLI auth **2/2**, containment **6/6**, and a real compiled Seatbelt probe
accepted port 1455 while denying 1456. Full workspace/package/live-login evidence is still pending.

### 2026-07-14 — provider-error hardening lease (`provider-error-hardening/root/provider_error_hardening`)

The read-only provider-error projection is now an implementation lane. It owns only the fixed,
secret-free Pi-provider classifier, exact Rust tuple validation/preservation, structured durable
runtime failure, and the minimum safe stop to blind planning relaunch. Automatic replay is not
being inferred from a transient provider classification; the first patch leaves every failed
planning attempt operator-resumable unless an already explicit compiler-safe policy exists. Auth,
credential storage, installed binaries, Updog/acceptance state, cmux, and live processes remain out
of scope. Coordination and focused evidence will be recorded in
`agent-collab/provider-error-hardening.md`.

#### 2026-07-14 — provider-error hardening released

The lease immediately above is closed. Provider failures now cross the Pi public boundary only as
seven fixed secret-free classes; Rust validates the entire tuple before callbacks, preserves it as
a typed failure, and gives durable agent/chat state only its canonical action. Host-authored
broker/credential-channel/protocol/internal failures have a separate fixed projection used by
fatal stderr and snapshots. Planning no longer equates provider transience with safe replay: a
typed failed turn enters an operator-resumable pause and cannot silently consume another attempt.
The complete host check is green at **51/51** with bundle SHA `8105823b…`; focused Rust is **19/19**,
the planning/non-Pi retry and TUI rendering regressions are green, scoped clippy is warning-free,
and format/diff checks pass. Exact files and evidence are in
`agent-collab/provider-error-hardening.md`. Auth/credentials, installation, Updog, acceptance state,
cmux, and live processes were untouched.

### 2026-07-14 23:13 MST — repository rename normalized (`primary-integrator/root`)

The repository rename is now operationally complete. The Git top level and sole worktree resolve
to `/Users/max/Desktop/koni`; source, documentation, configuration, Git metadata, Desktop symlink
targets, generated project caches, and Cargo registries contain no persistent former-root
reference. Cargo now records only `koni-cli` from `/Users/max/Desktop/koni/crates/koni-cli`; both
legacy packages are absent. One historical working-directory argument remains on the live ChatGPT
kernel and will clear on a natural session restart; it is not Koni state and must not be removed by
terminating the current coordination session. No Updog project, cockpit, or run was touched.

### 2026-07-14 23:20 MST — Pi-style credential file released (`pi-file-credentials/root`)

The macOS rebuild/login blocker is source-closed. Koni no longer depends on executable-identity-
sensitive Keychain access; it stores its own OAuth material in OS-account-resolved
`~/.koni/auth.json` behind the unchanged private fd-3 broker. The directory/file are exactly
`0700`/`0600`; reads are bounded and no-follow; writes are atomic and fsynced; ownership/type/link,
UID lock, and revision-CAS checks fail closed. Koni neither imports nor mutates Pi's or Codex's auth
file. Focused tests passed **11/11** credential, **61/61** Pi-filtered core, **7/7** fd-3 service,
plus warning-denied core clippy. Product docs preserve the earlier Keychain contract and add an
adjacent transition explaining the plaintext-to-owner tradeoff. No live credential or auth command
was touched; packaged browser login remains with the primary integrator.

### 2026-07-14 23:54 MST — auth edge closure and frozen release endpoint (`primary-integrator/root`)

The initial `~/.koni/auth.json` credential row above is preserved as history. Current source uses
project-disjoint platform state: `~/Library/Application Support/Koni/auth.json` on macOS and
`~/.local/state/koni/auth.json` on Linux, with exact safe crash-temp cleanup under the UID lock.
Before Pi browser OAuth begins, Koni now proves that exact `127.0.0.1:1455` can bind; a collision
fails immediately through one secret-free message instead of waiting on Pi's indistinguishable
manual-code prompt. The successful Pi browser race is unchanged.

The final unchanged-byte gate is green: workspace **1,057/1,057** with three intentional ignores,
Pi host **53/53** plus typecheck/build/artifact/smoke, warning-denied workspace clippy, Rust format,
and diff checks. Endpoint hashes: engine `b294b502…`, credential store `dcb63612…`, containment
`390239b2…`, host `d0932208…`, Cargo lock `84bb9c89…`. The repository rename invariant also
remains zero persistent former-name references. Installation, live browser completion, and the
isolated Medium run remain primary-integrator actions; protected Updog state was not touched.

### 2026-07-15 00:08 MST — isolated package and bounded browser attempt (`primary-integrator/root`)

The final source was installed only into isolated prefix
`/Users/max/Desktop/.koni-browser-runtime.mlRsxK` (binary `3f07ed2d…`, host `d0932208…`, pinned
Node `0d005c18…`). Models and signed-out status passed without a Keychain prompt. The browser flow
opened OpenAI and listened only on `127.0.0.1:1455`; the human authorization page was not completed
within ten minutes, so Koni cancelled and fully reaped the host. No credential/file/temp/listener,
inference, or token-spending run remains. The isolated Medium run is still paused.

The original Updog cockpit remains PID/PGID 2282 and both protected schema-1 lifecycle files now
read `running: true`; therefore this lane intentionally did not replace the global executable or
touch either run. The only current external step is operator completion of the next browser OAuth
window. After that, verify a second isolated binary reads the same application-state file before
resuming the isolated acceptance run.

### 2026-07-15 08:57 MST — active Medium acceptance and bounded planning (`primary-integrator/root`)

All delegated lanes are released; the primary integrator owns the live acceptance loop. Browser
OAuth is complete and upgrade-stable. Two isolated Medium attempts in the acceptance clone are
preserved as diagnostic evidence: `019f643e-451e-76f2-a939-1b0dd431129e` spent 230,445 new tokens
and 129 repository calls without an artifact; `019f6672-867e-72a3-b593-d4a8ccba6e4e` obeyed the
new 32-read cap but its steering-based continuation exceeded the 4,096-event public transcript
bound after 75,355 new tokens. No agent process remains for either run.

The active source change replaces steering with two turns inside one verified Pi host/session:
terminal bounded exploration followed by no-read structured synthesis, preserving the in-memory
conversation. Run-type configuration now owns a validated `max_repository_tool_calls` primitive
(16/32/48 defaults), and any planner process failure now pauses durably for explicit resume instead
of leaving a dead run active. Focused tests and core Clippy pass. Next authority is an isolated
package, fresh third Medium run, full approval/execution/verification/promotion audit, then repeated
passes and documentation reconciliation. Protected original Updog runs and the global cockpit
remain read-only.

### 2026-07-15 09:20 MST — synthesis transcript/output refinement (`primary-integrator/root`)

The third isolated Medium run proved terminal exploration and same-host synthesis, then failed at
a newly isolated boundary: raw provider text streaming produced over 4,096 public events before
the authoritative completed planning message. One synthesis also projected transient provider
unavailability after an 85,539-byte assistant message. Run
`019f6683-8ed7-76d0-9ae8-a5f6190e8c12` is durably paused with no live process; cumulative recorded
new usage is 135,447 across two bounded exploration attempts.

Active source now keeps raw deltas inside the verified host, exports only completed messages,
bounds plan prose to 24,000 characters and direct-Pi planning output to 16,384 local tokens, forbids
source/schema repetition, and sets newly installed Software Medium exploration to 24 calls while
retaining legacy omission semantics at 32. No other agent lease is active. Next is focused Rust
closure, isolated packaging, a fresh Medium run, and continuation through approval, tickets,
verification, report, and manual promotion.

### 2026-07-15 09:44 MST — live transcript and output-limit transition (`primary-integrator/root`)

The fourth isolated Medium run stopped after a correctly bounded 32-read exploration and about six
minutes of synthesis. The durable pause/reap path worked, but the host had discarded an over-limit
completed message and billed usage before projecting its own exception as zero-usage
`runtime_internal`. Current source evolves the older 16,384 checkpoint to a 32,768-token
reasoning-aware runtime reserve plus independent 96 KiB visible JSON and 24,000-character plan
bounds. Overruns preserve message/usage and use the fixed `runtime_output_limit` tuple.

The same live audit closed the repeated “Pi event” cockpit regression: the credential-isolated host
still omits raw deltas, while Rust retains complete message/tool payloads in the compiler-owned
agent transcript; chat renders those semantic cells and suppresses transport envelopes. Planning
journals keep compact hashes/sizes rather than duplicating excerpts. Host 53/53, focused Rust,
agent-chat 14/14, and isolated packaging are green. Fresh Medium run
`019f66a9-df5a-7302-a3e1-00482d37a7ab` is in same-session synthesis after exactly 32 legacy reads.
Protected Updog runs and the global cockpit remain read-only.

### 2026-07-15 10:00 MST — transcript renderer live and fifth plan succeeded (`primary-integrator/root`)

The fresh Medium run completed structured synthesis on attempt one and is durably awaiting review;
no agent host remains. The compiler-owned transcript contains the full prompt, 43 completed
messages, 32 completed repository tool exchanges, usage, and terminal closure rather than lossy
`Pi event` labels. Isolated cockpit `.koni-acceptance-runtime.b3LDDO` renders those semantic cells,
marks an unexecuted terminal-batch call `Skipped`, and now supports paging forward after `Home`
through explicit top-relative history state. Focused chat is 18/18 and warning-denied TUI Clippy,
release build, format, and diff checks are green. The original Updog project, cockpit, and protected
runs remain untouched; the isolated run is the only acceptance lane.

### 2026-07-15 10:22 MST — direct-agent chat compatibility closure (`primary-integrator/root`)

The active fifth-run Implementer proved complete Pi payloads were durable but exposed a final
envelope mismatch: direct Lead/worker logs lacked planning's top-level `type: pi.event`, so the
cockpit rendered an empty chat. Planning, Lead, and workers now share one canonical transcript
record constructor; the TUI also reads older direct envelopes. Exact compatibility and all 19 chat
tests, the direct-writer regression, formatting, diff checks, and warning-denied core/TUI Clippy
pass. The active Implementer is not being interrupted for a presentation-only refresh; the
isolated cockpit will be upgraded at the next quiescent compiler boundary. Original Updog state and
the global cockpit remain outside this lane.

### 2026-07-15 10:31 MST — full transcript visible in the live cockpit (`primary-integrator/root`)

The isolated cockpit was refreshed only after the active worker stopped. Its binary is now
byte-identical to the current release (`551cef09…`), and the existing Implementer artifact renders
as a real transcript: complete assistant text and reasoning, compiler-tool invocations and results,
and the final response. Raw streaming deltas are still omitted to avoid duplicate/noisy history;
older direct-Pi envelopes are parsed compatibly. The 19-test chat suite and both writer-side
regressions are green. Protected Updog runs, the global install, and preserved ticket edits remain
untouched.

### 2026-07-15 11:07 MST — replacement-worker recovery closure (`primary-integrator/root`)

The live acceptance lane remains exclusively owned by the primary integrator and is paused with no
agent process. Current source binds absent future covered paths as typed baseline absence without
weakening proof-source reads, lets replacement context observe only pre-output in-scope edits under
Git-common state, and gives the no-output circuit an explicit recover/disposition boundary with a
fresh post-recovery failure window. Focused regressions, truthful-product enforcement, formatting,
and warning-denied core Clippy pass. The next action is a guarded isolated-binary refresh followed by
formal recover/resume of the same preserved ticket; original Updog state remains read-only.
### 2026-07-15 — compiler-owned worktree identity regression (`primary-integrator/root`)

Live Medium acceptance and the existing `bundled_software_direct_pi_broker_submits_and_compiles_once`
regression now agree on one exact failure: tracked `.koni/project.yaml` content caused a compiler-owned
ticket checkout to be classified as an ordinary configured project control surface. `Engine::open_run`
therefore redirected the worker to the integration checkout and rejected its first `context` action.
The primary integrator owns only the role-ordering repair: registered planning, integration, and ticket
worktrees retain their compiler-owned role before the configured-linked-worktree fallback is considered.
The general worktree-local cockpit behavior remains intact. No other agent lease is active in this seam.
### 2026-07-15 — live worker-context repair accepted (`primary-integrator/root`)

The compiler-owned role-ordering repair is accepted. The existing full Software direct-Pi broker
regression and the configured linked-worktree regression both pass; formatting, warning-denied core
Clippy, and diff checks are green. Isolated release `b52f9e60…` validates the preserved Medium run and
issues its 98,833-byte context from the exact ticket checkout. Explicit recovery cleared only the dead
worker binding, and replacement Implementer `worker-019f679e-b5c2-7281-8907-1d2aff4fa3ca` crossed
context and is actively reading its five authorized files. The isolated cockpit is open on cmux
`workspace:10/surface:100`; it reports one active worker. A presentation follow-up remains: in the
unfiltered Agents list, the active count is correct but the umbrella Lead row receives the active glyph
while the live Implementer can sit below older same-ticket history. Do not interrupt this live worker for
that display-only issue.
### 2026-07-15 — current-tree lifecycle matrix reconciliation (`primary-integrator/root`)

The first locked full-workspace run on immutable fingerprint `c3707a6c…` passed CLI 68/68, core
library 600/600 with three intentional ignores, graph-set 6/6, and the Research groups through
20/20 before exposing two stale lifecycle fixtures. One supplied a single plan beyond the newer
24,000-character/96 KiB response contracts even though it intended to test downstream 32/64 KiB
UTF-8 handoff truncation; it now uses 23,000 four-byte Unicode characters per valid response. The
other assumed failed planning launch remained active; it now asserts the deliberate durable pause
and publishes explicit operator play intent before fake-launcher retry. Both exact tests and the
complete lifecycle target pass 49/49. Runtime limits and pause semantics were not weakened. A fresh
full immutable matrix is still required on the resulting source fingerprint.

### 2026-07-15 15:30 MST — stale Updog runs retired; legacy deletion compatibility follow-up (`primary-integrator/root`)

At the user's explicit request, the two July 14 run registrations in the ordinary Updog checkout
were retired. No live process referenced either namespace. Their compiler-owned worktrees were
removed, their runtime directories and command-authority directories were deleted, and the shared
registry now contains zero runs with no selected run. All seven committed Koni run/ticket branches
were deliberately preserved. The only discarded uncommitted worktree state was the same obsolete
two-feature-line `.codex/config.toml` drift repeated across the stale checkouts.

The normal `koni delete-run --preview` path could not open these legacy pinned snapshots because a
newer profile invariant requires exactly one target-promotion verification checkpoint while the
old `small` snapshots contain zero. This is a compatibility defect to fix: safe deletion must be
able to inspect and retire compiler-owned legacy namespaces without requiring their obsolete
execution profile to pass today's complete runtime validation. The current acceptance project was
not touched; its sole selected Medium run remains active in
`/Users/max/Desktop/updog-koni-acceptance-1`, and the isolated cockpit remains visible on cmux
`workspace:10/window:2/surface:100`.

### 2026-07-15 15:42 MST — Lead wait is a compiler poll, not cognition (`primary-integrator/root`)

The current Medium run exposed a superseding runtime rule beside the earlier bounded-wait design:
automatic orchestration must not launch a model merely to poll a deterministic worker-process
boundary. The active implementation slice makes live-worker observation a passive supervisor
state and keeps explicit/legacy `wait_worker` compatible; if run authority is legitimately busy
when such a wait begins or publishes, the call remains nonterminal and retryable rather than
killing the Lead. This is scoped to `engine.rs` plus focused regressions and will be refreshed into
the isolated cockpit only after the run is paused with no live agent.

### 2026-07-15 16:02 MST — passive worker wait released (`primary-integrator/root`)

Automatic orchestration now treats a live-worker boundary as compiler supervision: it records
`waiting_workers`, launches no Pi host, emits no Lead slice, and returns no active agent ID until a
semantic dispatch/review/recovery/finish boundary exists. Explicit `wait_worker` remains compatible
and treats exact publication-authority contention as nonterminal waiting. The focused real-PID
lifecycle proof, complete 606-test core library, 50/50 lifecycle target, warning-denied core Clippy,
formatting, and targeted diff checks pass. Runtime, Pi, control-center, and Software-profile living
docs append this transition without erasing the earlier bounded-wait history. The engine seam is
unclaimed again; the primary integrator retains sole ownership of the live acceptance refresh.

### 2026-07-15 16:34 MST — missing future paths are not reviewer capabilities (`primary-integrator/root`)

The live historical-baseline Review boundary exposed a narrow admission defect: its exact review
packet named one intentionally future production file that is absent from this ticket checkout,
then the contained read broker correctly refused to mint a file capability for it before any
reviewer inference. The primary integrator claims only the model-facing review-packet path filter,
an explicit absent-path projection, focused regression, and adjacent docs. Existing regular files
remain exact read/evidence pointers; absent planned paths stay visible as bounded scope facts but
cannot masquerade as readable evidence. The live run is blocked with zero agents and its preserved
ticket checkout remains untouched and visible in the isolated cockpit.

### 2026-07-15 16:47 MST — review path-capability refinement released (`primary-integrator/root`)

The exact review packet now separates current regular files from unavailable scoped paths before
Pi admission. Only the former become contained read capabilities and valid bare product evidence
pointers; the latter remain bounded scope facts with a fixed non-evidence interpretation. Focused
review-packet tests pass 5/5, warning-denied core Clippy and formatting/diff checks pass, and the
complete core library is **604 passed / 0 failed / 3 intentional ignores**. Pi and Software docs
append the transition without deleting earlier contracts. The source seam is unclaimed again;
`primary-integrator/root` still exclusively owns the guarded live-run refresh.

### 2026-07-15 — recovered board / blocked pipeline advisory (`recovery-dispatch-audit/root`)

The preserved Medium acceptance exposed a presentation gap, not a scheduler-authority defect:
ticket-scoped `review-rework` steering plus `recover` correctly made the blocked ticket active and
dispatchable, while the orchestration pipeline deliberately retained its earlier terminal blocker
until the operator invoked `retry-supervised-stage`. This lane owns a result-only recovery advisory,
one lifecycle regression spanning exhausted review rework through explicit stage retry, and
append-only runtime documentation. It will not collapse recovery and retry, mutate the acceptance
run, refresh a binary, or touch cmux.

### 2026-07-15 — deterministic Lead cognition audit (`lead-cognition-audit/root`)

Read-only evidence from the preserved Medium run now broadens the passive-wait transition above:
all six current Lead slice kinds are already compiled to one exact operation and contain no Lead
judgment. Generations 1–51 spent 53,030 uncached Lead tokens across 43 recorded provider turns
(42 nonzero) to relay prescribed spawn, recovery, review-wrapper, wait, and yield calls; after the
passive-wait repair, 45,100 tokens remain avoidable. The proposed evolution is a replay-safe,
compiler-owned orchestration-boundary executor that reuses existing action/review authority and
durable receipts, while reserving any future model coordinator for a new explicit structured
decision boundary that cannot itself perform effects. Old pinned Lead leases remain legacy state:
they drain/reconcile without duplicate execution, and new bundled run types opt into compiler
driving explicitly. See `agent-collab/lead-cognition-audit.md` for the exact boundary taxonomy,
no-progress recovery rule, interruption tests, and compatibility rollout. No source, profile,
test, live run, binary, cockpit, cmux, or Updog state changed in this audit.

### 2026-07-15 — recovered board advisory released (`recovery-dispatch-audit/root`)

The bounded advisory is ready for integration. Successful recovery now returns a result-only
`recovery_advisory` naming `retry_required`, the blocked orchestration stage, the explicit
`retry-supervised-stage` action, and its command when the newly repaired compiler board has a safe
continuation. It does not cross the retry boundary. The exhausted-review lifecycle regression
proves ticket recovery, persistent pipeline blockage, and the subsequent explicit attempt-2 retry
as one end-to-end contract. Isolated evidence: lifecycle **51/51**, focused reopen group **6/6**,
warning-denied core Clippy, formatting, and diff checks all pass. The source lease is released; no
live project or runtime surface was touched.

### 2026-07-15 — recovered worker read-scope diagnosis (`recovery-dispatch-audit/root`)

The live replacement worker reached its recovered correction step but direct-Pi containment denied
a read of a production component omitted from that historical step's `read_paths`, even though the
later exact review-rework disposition requires invoking it and graph-owned paths include it. This
lane is read-only: it is tracing ticket/context/broker capability derivation and will propose a
least-privilege, old-run-compatible generic repair plus focused tests. It will not mutate the live
run, a process, cmux, a binary, or source.

### 2026-07-15 — step-relevant context-pack compaction audit (`context-pack-compaction-audit/root`)

The preserved Medium proof pack is 111,684 bytes: `spec_slice` 38,547, `contracts` 31,239,
`reviews` 9,865, `ticket` 8,409, and `graph_closure` 7,691. Every step graph node is serialized
twice, the materialized run root repeats a 7,028-byte planning transcript, a graph-forbidden
product step receives full graph-authoring schemas, and raw review history repeats the already
bounded rework findings. A read-only mechanical projection retaining the exact goal, step scope,
checks, step graph, steering, rework/acceptance, outputs, and provenance measured 28,249 compact
bytes (74.7% smaller, below the direct-Pi 32 KiB preview). The proposed compiler-derived modes use
existing graph-mutation/path/check/gate-contract primitives; full mandatory-anchor validation and
hashes run before presentation compaction, Research gate analysis falls back conservatively, and
the compact document adds ticket/review/contract/output authority hashes while preserving the one
context-hash/receipt/output equality chain. See
`agent-collab/context-pack-compaction-audit.md` for the exact call path, v1.1 immutable-transport
rollout, compatibility hazards, and test matrix. No source, profile, test, live state, process,
binary, grant, broker response, or cmux surface changed; no implementation lease is claimed.

### 2026-07-15 19:43 MST — Medium proof-run efficiency audit (`smoke-run-efficiency-audit/root`)

Read-only accounting through the third rejected proof candidate found 4,892,433 provider tokens
and 1,191,697 uncached/new tokens. Direct proof agents dominated: ten of sixteen Implementers
failed at the runtime boundary, and failed Implementers consumed the same 59.2 summed minutes as
completed Implementers. Failed Implementer/Reviewer launches spent 451,905 new tokens, 44.0% of
direct proof cognition. Thirteen workers also consumed 1,201,164 context bytes before product
reads, corroborating the separate compaction audit. The principal first-shot correctness defect was
not missing semantic intent: the graph required a real per-thread mutation, but the proof/step/
ticket scope omitted `ThreadQuestionInput.tsx`, which owns the blur-to-upsert seam. Later steering
narrowed the task to renderer inspection and conflicted with the still-open mutation obligation,
which explains the third rejection. The deliberate fourth candidate is directionally correct but,
at the 19:43 snapshot, lacked the required jsdom header and a positive target-write assertion; late
steering recording those facts occurred after its context issuance and was not delivered live.
Recommended priorities are durable terminal-boundary reconciliation, compiler-checked condition →
seam → path → action → assertion matrices, cumulative authority-checked rework, explicit live/
next-attempt steering semantics, step-relevant context projection, and compiler-owned deterministic
orchestration. Full evidence and artifact assessment are in
`agent-collab/smoke-run-efficiency-audit.md`. No source, profile, test, live run, process, binary,
worktree, branch, grant, or cmux state changed; no implementation lease is claimed.

#### 2026-07-15 19:48 MST follow-up — DOM recipe was not contained-executable

After the preceding snapshot, the live worker independently added the jsdom directive. The exact
configured check correctly returned `invalid_result` because Vitest executed zero tests when the
contained sandbox could not resolve `/@vite/env`. The worker removed the directive and restored
expected-red, but that red occurs before the DOM code and therefore masks the future Node-only
failure. The next-attempt correction recorded at 02:46 UTC uses no DOM: traverse the real
descriptor element to `ThreadQuestionInput`, invoke the imported component under API mocks, invoke
its real production `QuestionnaireLongTextInput.onBlur` closure, and assert the positive target
write plus all non-target sentinels. That steering still postdates the active worker's context and
has no evidenced live delivery. This strengthens the audit's compiler requirement: a proof matrix
must bind not just condition → seam → path → action → assertion, but an oracle recipe demonstrated
inside the exact contained configured-check environment. The detailed audit was amended; no live
state or source was touched.

### 2026-07-15 — step-relevant context-pack compaction implemented (`context-pack-compaction-audit/root`)

The read-only audit above is now implemented under an explicit `engine.rs` lease. A versioned
schema `1.1` `product_execution` projection is selected only for graph-forbidden file/check work
with no gate-policy/query contract; every graph-authoring, review, observer, ambiguous, and
Research gate-analysis context retains the full schema `1.0` document. Compiler-transition
rework also forces `Full` so its referenced mutation intent cannot disappear. Full mandatory-anchor
validation and source hashing still precede presentation. The compact packet deduplicates typed
graph bodies, replaces only proven-materialized planner prose with hashes/metadata, removes
graph-authoring schemas and operational identities, bounds raw review history to its latest
semantic result, and retains exact step/check scope, outputs, steering, rework/acceptance, and
typed graph state. Added provenance hashes commit to every omitted authority source, and schema
`1.1` is hashed before compact serialization so immutable context paths cannot collide.

Isolated evidence: new projection tests **3/3**; mandatory-anchor regression **1/1**; Research
context/gate regressions **2/2**; full graph-authoring/idempotent formulation context **1/1**;
Research living-spec include contract **1/1**; complete core library **608 passed / 0 failed / 3
intentional ignores**; warning-denied core Clippy, formatting, and diff checks pass. The synthetic
end-to-end packet contains more than 100 KiB each of materialized planner prose, raw review input,
and operational ticket noise yet emits below the 32 KiB broker preview threshold with a stable
hash. Required exact outliers still page rather than truncate. No profile, installed binary, live
run/state, worktree, process, grant, broker response, or cmux surface was touched; the primary
integrator retains sole guarded-refresh authority.

### 2026-07-15 — passed-review transaction hardening accepted (`primary-integrator/root`)

Newer exact ticket `review-rework` steering now revokes every affected current pass without deleting
history. Finish/integration block revoked authority even after projection refresh. Prepared
transactions can be retired only with registry-pinned pre-CAS ref proof, and both completed-journal
replay exits require the exact transaction to be `complete`; any named deferred integration result
is reconstructed from that boundary in memory. Terminal complete/absent integrations fail closed
instead of partially reopening. Status restoration is included in the paired graph/ticket
rollback-on-error publication, lane writes are target-first, and duplicate ticket lanes reject.

Final isolated evidence: review-rework **5/5**, completed-boundary replay **1/1**, duplicate-lane
**1/1**, Tracked recovery **1/1**, core library **614/614 passed** with 3 intentional ignores, and
warning-denied core Clippy. The longstanding `.review-staging-*` / `.review-backup-*` host-crash
window remains an explicit P1 reliability item; this change does not claim power-loss atomicity.
The live Updog acceptance run stayed paused and quiescent. Only `primary-integrator/root` may perform
the forthcoming guarded isolated-binary refresh/recovery/retry.

### 2026-07-15 — guarded superseded-review acceptance replay (`primary-integrator/root`)

The private acceptance artifact was installed only into the isolated runtime and the preserved
right-hand cockpit was restarted without touching the global Koni binary. Recovery durably moved
the revoked output out of authority, recorded the old pass as superseded history, reopened its
author step, and returned the affected proof from `prepared` to `planned`. The orchestration stage
was safely `waiting`, so `retry_required: false` was correct and no failed-stage retry was invented.
After explicit `play-run`, a replacement Implementer started with the exact later plain-Node
correction and the prohibition on using the superseded review for finish/integration. The board had
no failed journals or integration boundaries at the handoff. Token-efficiency comparisons continue
to distinguish uncached/new cognition from separately reported cached-input throughput.

### 2026-07-15 — proof rework scope repair active (`primary-integrator/root`)

The preserved acceptance worker exposed a compiler-issued contradiction: its authoritative rework
requires the real `ThreadQuestionInput` production seam, but the historical step grants only proof
source/covered paths and the planner omitted that invoked component. The broker correctly denied
the read. Scheduling is paused and quiescent. `primary-integrator/root` claims the narrow core
recovery/scope seam, focused tests, and Software proof-preparation path projections/instructions.
The design must keep least privilege: new profiles derive read authority from explicitly `uses`-
connected system ownership; legacy scope repair requires exact-ticket structured steering and may
add only configured path-typed values already owned by semantic read-scope nodes. It may never
expand write or graph authority or parse free-text instructions into permission.

#### 2026-07-15 read-only compiler/broker audit (`recovery-dispatch-audit/root`)

The live `forbidden_scope` is confirmed as correct durable-scope enforcement, not broker
staleness. Software proof preparation freezes proof `source_paths`/`covered_paths` into the author
step even though its graph neighborhood can expose a `uses`-connected system and that system's
typed `owned_paths`; recovery and free-form review-rework steering deliberately cannot turn that
semantic visibility or model prose into file authority. The safest design is a compilation-frozen,
read-only rework envelope for new tickets plus an explicit operator-only exact-path supplement for
legacy tickets. A supplement must be quiescent, restricted to typed path values on already
ticket-scoped/reachable graph nodes, append-only and hash-pinned, and followed by fresh context and
grant issuance. The broker must bind an effective-scope hash so a mutable scope can never silently
widen a live grant. Writes never widen, and paths that change claimed proof coverage require graph
correction rather than a capability supplement. Detailed call-chain findings and tests are in
`agent-collab/recovery-dispatch-audit.md`; this lane made no source or live-state change and has
released its read-only lease.

#### 2026-07-15 — structured legacy read-scope recovery implementation claimed (`scope-replan-recovery/root`)

The released audit is now delegated as a core-only implementation slice. The exact lease is the
dedicated `read-scope-repair` steering-event boundary, append-only ticket supplement validation,
effective worker read-scope/hash derivation, broker grant/currentness binding, and focused tests in
`crates/koni-core/src/engine.rs`. Only a strict versioned JSON object carried by that dedicated
operator event can be considered; ordinary review/rework text remains non-authoritative. An exact
path must already be a configured typed Path value on a graph node in the ticket's pinned semantic
scope, the exact correction boundary must be named, the run must be quiescent, and writes/graph
authority never expand. Unsafe or ambiguous requests fail closed. Software profile files, TUI,
live state, processes, binaries, worktrees, and cmux are outside this lease. Detailed decisions and
verification are append-only in `agent-collab/scope-replan-recovery.md`.

#### 2026-07-15 22:02 MST least-privilege correction (`primary-integrator/root`)

The prior active note's proposal to derive new proof read authority from every `uses`-connected
system `owned_paths` is superseded before implementation. Graph visibility is not filesystem
capability. New proofs must explicitly bind each condition to its production seam, exact seam
path, action, and assertion; every seam path must be receipt-bound in that proof's
`covered_paths`, while `source_paths` alone remains writable. Missing seam coverage fails before
ticket dispatch. Legacy repair is quiescent, explicit, structured, exact-ticket and hash-bound;
ordinary review/steering prose and broad connected ownership can never create permission.

### 2026-07-15 — main cockpit token-display contract active (`token-display-contract/root`)

The core snapshot already retains both provider-processed `total_tokens` and cache-excluding
`new_tokens`, but current header and Runs rows select the former and Overview visually leads with
it. This contradicts the accepted operator contract recorded by `primary-integrator`: fresh work,
not cache-read throughput, is the cockpit headline. `token-display-contract/root` claims only the
TUI model/main header/Runs/Overview projection, planning-budget metric labels, focused tests, and
append-only adjacent documentation. Provider total and cached input remain available as explicit
secondary Overview telemetry. Agent-chat/timeline copy, core aggregation, profiles, live state,
installed binaries, and cockpit processes remain outside this lease.

#### 2026-07-15 — main cockpit token-display contract complete

The main cockpit now implements that split: header and Runs badges use `new_tokens`; Overview leads
with the cache-excluded number and labels cached input/provider total separately. Planning-budget
progress carries its configured metric, so custom `processed_tokens` limits are no longer called
new. Focused regressions and the complete TUI library suite passed (**303/303**), as did
warning-denied all-target TUI Clippy, formatting, and diff checks in a private target. No live or
installed artifact changed; the token-display lease is released.

### 2026-07-15 — Software proof oracle contract active (`proof-oracle-contract/root`)

The future-run half of the recovered proof-scope defect has a bounded profile lease. The bundled
Software proof schema will require structured oracle cases that bind each condition/claim to its
invoked production seam, exact seam paths, action, assertions, and material environment/recipe.
Every seam path must also be explicit read-only `covered_paths`; `source_paths` remains exact
proof/test write authority, and linked system ownership is never inferred or unioned into file
capability. This lane owns only the Software template/config/prompt surfaces, matching fixture
contract slices, focused profile tests, and its mailbox. The primary integrator retains generic
validator/recovery code, live state, binaries, and guarded refresh authority.

#### 2026-07-15 — Software 0.5.0 version transition

Because `proof.oracle_cases` is required and mechanically cross-bound to `covered_paths`, this is
a breaking bundled contract rather than 0.4-compatible tuning. The default Software profile and
its materially changed graph/operations/workflows modules move to `0.5.0`; unchanged rules/checks
remain independently versioned at `0.4.0`. Existing installed profiles stay pinned. The legacy
`fixtures/updog-repo` profile is not a Software fixture mirror and retains its own `updog 0.1.x`
identity.

#### 2026-07-15 — Software proof oracle contract complete

The future-run Software profile lease is released as `ready_for_integration`. Software 0.5.0 now
requires closed structured proof `oracle_cases` whose exact production `seam_paths` are a generic
validated subset of read-only `covered_paths`; `source_paths` alone remains proof/test write
authority, and linked system ownership never widens capability. Planning, review, implementation,
run-type, and Codex guidance surfaces carry the same contract. The exact missing-seam regression
passes **1/1**, the complete Software proof target passes **21/21**, both focused CLI template
checks pass **1/1**, and targeted formatting/YAML/diff checks are clean. The independently owned
legacy scope-recovery engine work remains separate; no live state, binary, TUI, Research profile,
or Updog fixture was changed by this lane.

#### 2026-07-15 — legacy proof repair requires semantic rebind (`primary-integrator/root`)

The earlier recovery claim's generic capability-supplement wording is superseded for the active
proof defect. The exact denied production seam changes what the proof claims to cover, so a
read-only supplement is not an admissible repair. A committed `read-scope-repair` event first
publishes a quiescent, hash-bound blocker, then a separate durable recovery transaction must append
only that exact path to the target proof's configured `covered_paths`, validate the amended graph
under the run-pinned profile, and re-evaluate the same pinned rule to the same deterministic ticket
ID. The candidate must preserve operation, targets, semantic node scopes, write paths, workflow
shape, worktree lease, product branch, reviews, and append-only history; the sole authority delta is
the requested read path. Compiler-selected checks and all affected context hashes are regenerated,
the old issued context is retired, and the compiled check member must bind the added path. The
rebind has its own prepared/complete journal because the steering action journal is already
complete before recovery publication begins; replay must converge safely from old/old,
new-graph/old-ticket, and new/new durable states. No live grant may exist during this transaction.
### 2026-07-15 — semantic read-scope rebind independent review (`scope-rebind-review/root`)

This read-only lane independently audits the structured `read-scope-repair` blocker and proposed
legacy semantic graph/ticket rebind. It owns no Rust, profile, live state, binary, worktree, process,
or cockpit surface. The exact acceptance boundary is one typed system-owned path appended to the
target proof's `covered_paths`, followed by same-profile/same-rule evaluation into the same ticket
ID with unchanged targets, writes, workflow topology, product worktree/branch/HEAD, lease, and
history. Only derived read paths, compiled-check bindings/hashes, and affected context hashes may
change. Initial finding: ordinary full compilation intentionally skips an active same-ID ticket,
so recovery requires a dedicated constrained merge plus a durable graph+ticket publication journal;
it cannot be implemented by editing the graph and calling ordinary compile. Detailed evolving
findings are append-only in `agent-collab/scope-rebind-review.md`.

#### 2026-07-15 — semantic rebind review P0 checkpoint

The dynamic implementation needs four fail-closed corrections before integration: recognize an
already-applied rebind before replaying the now-stale original repair; reconstruct the exact
pre-blocker ticket and match its recorded base hash rather than blessing the current blocked
value; deduplicate identical non-pipeline-bound rebind steer events by request identity; and replay
an unfinished graph/ticket publication before generic ticket enumeration or any dispatchable
boundary. The replacement's exact compiled proof member must gain only the requested covered path;
ticket read scope alone is not proof. Product branch/HEAD/cleanliness also need an immutable
pre/post binding. The exact crash, drift, history, and worktree test matrix is recorded in
`agent-collab/scope-rebind-review.md`.

### 2026-07-15 22:34 MST — Software oracle/subset independent review (`oracle-subset-review/root`)

The generic recursive subset primitive and bundled Software-0.5 oracle contract received a
read-only least-privilege/compatibility review. The intended disjoint path flow is receipt-bound and
does not inherit linked system ownership, and the profile/module version transition is coherent.
Two P1 gaps remain before promotion: proof `source_paths` are not mechanically disjoint from
read-only `covered_paths`, so a diagnostic/boundary production seam can also become writable; and
the MCP-safe eight-path subset-diagnostic cap is per line while all distinct lines are joined into
one unbounded correction. P2 coherence gaps are normalized path identity versus repeated
“exact/verbatim” wording and unenforced oracle-case ID uniqueness. The generic `subset_of` keyword
also lacks installed profile-authoring documentation. Exact references and recommended regressions
are in `agent-collab/oracle-subset-review.md`. No source/profile/live-state/binary/cockpit surface
was changed. A private focused rerun was nondiagnostic only because the separately active semantic-
rebind lane was between helper call sites and definitions; rerun after that owner publishes a
coherent save point.

#### 2026-07-15 22:43 MST — accepted generic hardening follow-up

`oracle-subset-review/root` now owns the accepted follow-up: optional one-directional
`disjoint_from` for compatible string/path lists, `unique_by` for required scalar identity fields
on object lists, globally bounded MCP schema feedback, and the Software-0.5 proof application plus
focused regressions. Path disjointness uses normalized filesystem authority overlap—equality or
either ancestor/descendant direction—not mere element inequality. Software wording evolves from
raw “exact/verbatim” spelling to normalized project-relative identity and remains `0.5.0` because
that bundled contract has not shipped. `scope-replan-recovery/root` confirmed the released field-
validator/safe-schema ranges are disjoint from its active rebind helpers at a coherent save point;
neither lane will whole-file-format `engine.rs`. No live/runtime/binary/cockpit authority is in this
follow-up.

#### 2026-07-15 22:58 MST — generic collection hardening complete

`oracle-subset-review/root` releases its bounded implementation lease as
`ready_for_integration`. Generic profile fields now support one-directional compatible-list
`disjoint_from` and required-scalar object-list `unique_by`; graph validation applies normalized
path authority overlap or exact string identity and count-only duplicate diagnostics. MCP-safe
schema feedback has deterministic global limits of 12 details, eight disclosed normalized paths,
and 4 KiB for the serialized complete response, with whole-detail UTF-8-safe omission and a
distinct-error count. Software 0.5 applies these guards to proof source/covered paths and oracle
IDs, and its guidance now says normalized project-relative path identity instead of raw
exact/verbatim membership. Private verification passed config **70/70**, subset **5/5**, disjoint
**8/8**, unique **1/1**, broker-safe **6/6**, the exact Software regression **1/1**, and the full
Software proof target **21/21**. Owned formatting/wording checks are clean. This lane's one Clippy
suggestion was fixed; two remaining warning-denied findings were handed to the active rebind owner
without touching that lease. No live, binary, TUI, installed-project, Research, or Updog surface
changed.

#### 2026-07-15 22:48 MST — token accounting definition confirmed

The cockpit headline remains cache-excluding `new_tokens`; the larger provider/processed figure
includes cached input and stays secondary telemetry. The TUI consumes explicit normalized
snapshot `new_tokens` because native Codex and direct-Pi raw `input_tokens` use different
conventions. A narrow core follow-up is queued after the active recovery lease to include
Koni-owned direct-Pi worker attempt terminal checkpoints exactly once; do not sum their
per-message cache-heavy deltas in addition to the terminal checkpoint.

#### 2026-07-15 23:03 MST — semantic rebind future-replay review checkpoint

`scope-rebind-review/root` found that completion must be treated as immutable historical fact, not
as a requirement that the rebound ticket, graph, paused scheduler, and old checkout HEAD remain
frozen forever. Prepared transactions retain exact quiescent pre/mid/post publication checks;
complete transactions validate their sealed transaction, owning request, exact completion event,
and receipt, then no-op even after later authorized ticket/graph progress or rollback. A second P0
gap begins earlier: the original repair blocker must bind the clean ticket branch/HEAD and full
normalized graph hash, otherwise changes between the blocker and rebind are silently adopted.
Comparator converse-context checks, exact compiler-derived extension keys, postpublication HEAD
recheck, receipt preflight, and status/timestamp consistency remain focused hardening items. Full
details and regressions are append-only in `agent-collab/scope-rebind-review.md`.

#### 2026-07-15 — semantic rebind final-pass authority gaps

The independent rebind pass found two remaining P0 boundaries in the compile-clean checkpoint.
First, explicit recovery reconciles a prepared transaction early, but ordinary context/review/
spawn/grant/resume paths do not globally quarantine one; a crash after publishing the active
rebound ticket but before sealing could make unfinished authority dispatchable. Second, an exact
completed `steer` retry still crosses mutable run/ticket/change-control/checkout checks before the
completed journal is recognized, so legitimate later lifecycle progress can defeat historical
idempotence. Completion-event append also still suppresses on a partial key rather than the full
transaction payload (P1). Exact findings and required regressions are appended in
`agent-collab/scope-rebind-review.md`; no Rust, profile, live state, binary, process, worktree, or
cockpit surface was changed by this review lane.

#### 2026-07-15 23:07 MST — direct-Pi token-ingestion audit complete

`token-ingestion-review/root` completed a read-only audit and released its lease without touching
source or live state. The headline contract remains cache-excluding `new_tokens`; the separate
ingestion defect is that the run scanner admits only literal `worker.log` and top-level
`turn.completed`, omitting every current Koni-owned direct-Pi worker attempt plus failed/partial Pi
turn usage. On the paused acceptance run, current aggregation is `346,301` provider / `181,760`
cached / `164,541` new, while exact owned-log normalization is `6,506,719` provider / `5,126,144`
cached / `1,380,575` new. The queued implementation should reuse the strict direct-worker filename
validator and one shared per-turn precedence parser: committed compatibility event, else terminal
usage checkpoint/legacy terminal, else summed deltas. Planning budget recovery already follows
that precedence; cockpit aggregation does not. Exact ownership boundaries, legacy ambiguity,
32-MiB truncation caveat, arithmetic, and focused regressions are append-only in
`agent-collab/token-ingestion-review.md`. Implementation waits for the active semantic-rebind
`engine.rs` lease to release.

#### 2026-07-15 — semantic rebind independent review cleared P0

The current semantic-rebind checkpoint closes every P0 from the independent review. Prepared
publication is globally quarantined until canonical recovery; exact completed retries are
barrier-serialized immutable historical reads across later ticket/graph/HEAD/lifecycle progress;
the original blocker binds full graph plus clean branch/HEAD; candidate/member/write equivalence
is fail-closed; and derived/completion event collisions fail before mutation. Independent focused
verification passed rebind **5/5** and stale-repair **1/1**, including an unrelated owned-path
least-privilege assertion. Two P1 compatibility follow-ups remain: a hard crash during the initial
generic blocker lane move can leave duplicate fail-closed ticket copies, and a noncanonical
historical graph filename can become a duplicate-ID graph when `save_node` writes its canonical
path. Neither is reachable from or blocks the already-published canonical live acceptance prestate.
Exact call sites and failure states are in `agent-collab/scope-rebind-review.md`; this review lane
changed only append-only coordination docs.

#### 2026-07-15 — scope-replan recovery implementation released

`scope-replan-recovery/root` releases `crates/koni-core/src/engine.rs` as
`ready_for_integration`. The accepted implementation replaces the earlier ticket-local supplement
idea with explicit `read-scope-repair` blocker plus separately committed `read-scope-rebind`
semantic recompilation. Full graph + clean branch/HEAD provenance, exact read-only one-field
amendment, same-ticket/check/workflow equivalence, context converse, scoped receipt publication,
immutable completed replay, derived-event collision rejection, and global prepared-transaction
quarantine are compiler enforced. Both the initial blocker and rebound ticket lane moves now use
rename-then-atomic-replace recovery, closing the upcoming live blocker's duplicate-lane crash
window. Private focused verification passed **9/9**; warning-denied core Clippy and targeted
formatting are clean. The only documented compatibility residual is a fail-closed duplicate graph
identity if a legacy amended node uses a noncanonical historical filename; the live canonical
proof is unaffected. Root-aware filesystem-alias overlap hardening is explicitly handed to the
next owner. No profile, CLI/TUI/token source, live state, process, binary, worktree, or cockpit was
changed by this lane.

#### 2026-07-15 — direct-Pi token-ingestion implementation claimed

`token-ingestion-impl/root` claims only the shared direct-Pi/native usage normalizer behind
`direct_pi_planning_usage` and `run_token_usage`, strict `is_codex_usage_log` worker-attempt
admission, the existing per-file usage cache, and adjacent focused regressions in
`crates/koni-core/src/engine.rs`. The contract is one pass per admitted file and one selected
source per durable Pi turn: committed compatibility completion, otherwise exact checkpoint or
legacy terminal, otherwise summed deltas. Native Codex terminals remain independent occurrences.
Planning and cockpit aggregation must share this parser, including failed/timeout recovery, cache
reuse, and preserved-run-shaped arithmetic. Exact ownership and handoff notes are append-only in
`agent-collab/token-ingestion-impl.md`; no profile/path-identity/rebind/TUI/live-state/binary/
process/worktree/cockpit authority is included.

#### 2026-07-15 — filesystem-identity authority hardening active

`oracle-final-review/root` now owns the bounded follow-up accepted from its independent review:
the direct `same-file` dependency, root-aware existing-prefix path identity helpers and their
profile/ticket/proof-source authority call sites, focused filesystem-alias regressions, and generic
collection-primitive authoring documentation. The comparator will retain lexical behavior for
ordinary/nonexistent suffixes while using live file identity for every existing prefix, and will
be rerun at durable emission/admission boundaries. Token aggregation/parser ranges, semantic
rebind implementation, TUI, live state, binaries, installed projects, and cockpit processes remain
outside this lease; no whole-file formatter will run while the token lane shares `engine.rs`.

#### 2026-07-15 — semantic rebind final independent audit clean

`scope-rebind-review/root` independently re-audited the released semantic-rebind checkpoint after
the later root-aware filesystem-identity edits. P1-A is closed: initial blocker publication now
moves the sole exact prestate ticket by rename and atomically replaces its contents, accepts the
one-file midpoint, and has a focused no-duplicate recovery regression. The current shared tree
passes the complete focused `read_scope_` matrix **9/9**. Strict request schemas, generic `koni
steer` forwarding, printed blocker hashes, and the two exact documented operator commands agree.
Read-only live inspection confirms the acceptance ticket is still one clean paused `in_progress`
copy and its requested path/source authority/missing proof coverage are exact; the proof node is
stored at its sole canonical title-derived filename. Therefore there is no actionable blocker for
the exact live repair. The only residual is the documented fail-closed compatibility case for a
different legacy graph node stored under a noncanonical historical filename. Exact evidence is in
`agent-collab/scope-rebind-review.md`; this review changed coordination docs only.

#### 2026-07-15 — direct-Pi token-ingestion implementation final release

`token-ingestion-impl/root` releases its exact parser/discovery/cache/test lease as
`ready_for_integration`. Planning and run snapshots share one cached one-pass native/Pi normalizer;
strict recursive worker-attempt admission covers Lead slices and ticket workers; each durable Pi
turn selects committed compatibility completion, otherwise checkpoint/legacy terminal, otherwise
summed deltas. Checkpointed failures count once and partial failures contribute spend without
claiming completion. Independent review additionally closed two pre-freeze gaps: compiler-owned
legacy envelopes with a genuinely absent `type` now include the preserved 628-token delta-only
Lead turn, while explicit null/bogus types remain ignored; and inconsistent higher-precedence
usage is ineligible so selection falls through instead of saturating to an undercount. Pi provider
total may safely exceed its visible buckets, but visible buckets cannot exceed total and reasoning
cannot exceed output.

Superseding private verification passed usage **12/12**, shared-normalizer hardening **4/4**,
planning/run parity **1/1**, failed/checkpoint/timeout planning ledger **1/1**, warning-denied core
all-target Clippy, and scoped whitespace checks. Token-owned rustfmt deltas are empty; remaining
repository-wide formatting output belongs only to the adjacent filesystem-identity lane. No live
state, binary, process, worktree, TUI, profile, semantic-rebind, or installed-project mutation
occurred. Exact history and arithmetic remain in `agent-collab/token-ingestion-{review,impl}.md`.

Independent `token-final-review/root` then reconstructed the actual paused acceptance ledger from
six admitted agent logs and 78 strict worker-attempt logs and obtained the exact same
`6,506,719 / 5,126,144 / 1,380,575` provider/cached/new result, with 76 completed and seven partial
turns. Planning independently matches its durable session ledger. Its final verdict is clean and
`ready for guarded integration`; exact source and live-read evidence is append-only in
`agent-collab/token-final-review.md`.

#### 2026-07-15 — filesystem-identity authority hardening released

`oracle-final-review/root` releases its bounded implementation as `ready_for_integration`.
Existing path prefixes now use portable live filesystem identity; unresolved suffixes fail closed
across case and Unicode normalization beneath one existing identity without turning ambiguity into
exact authority; symlink components remain rejected. Generic graph constraints, proof-source
grants, prepared-source admission, active scope conflicts, maximal-disjoint dispatch, and
read-scope repair share the root-aware comparator, and graph validity is rechecked before lease
reuse/creation. Installed authoring docs now define `subset_of`, `disjoint_from`, and `unique_by`.
Private verification passed config **70/70**, subset **5/5**, disjoint **9/9**, unique **1/1**,
filesystem/generic/dispatch identity **4/4**, full Software **23/23**, warning-denied all-target core
Clippy, and scoped diff-check. Exact design, regressions, and commands are append-only in
`agent-collab/oracle-final-review.md`. No live state, binary, TUI, project, process, worktree,
cockpit, or whole-file-format mutation occurred.

#### 2026-07-16 — paused yielded-Lead lifecycle gap fixed in source

The acceptance run's only false-live record is now covered by an exact compiler reconciliation.
An orchestration aggregate may leave `running` only when its current stage/input/attempt, yielded
Lead slice, raw terminal agent, PID, and process identity all match; the raw agent has a durable
successful exit, the identity is dead, and no question-resume session is live. Paused supervision
runs this proof before returning at the scheduler gate, so it clears only the aggregate PID/identity
and remains unable to issue another slice. Explicit recovery shares the same idempotent helper.
Conflicts fail closed; slice/raw evidence, scheduler, pipeline, tickets, worktrees, and Git remain
unchanged. Focused exact/idempotence/failure tests and warning-denied core Clippy pass. The live
paused run has not yet been mutated by this source checkpoint.

#### 2026-07-16 — isolated acceptance refresh, semantic rebind, and resume complete

`primary-integrator/root` completed the guarded live transition without touching the global Koni
binary or any product checkout outside the dedicated acceptance worktree. The isolated release
reconciled the exact stale yielded-Lead aggregate under pause, then the compiler-owned
read-scope-repair/rebind amended only proof `ND-12be7352e46a017421437ae7` with the invoked production
seam `apps/books/src/components/ThreadQuestionInput.tsx`. Ticket `TK-63a91afabf98af03` retained its
lease, worktree, history, branch head, and single existing test-file write grant. The run is resumed;
its new Implementer context successfully read that production seam through the Pi broker and is
still working, with no repeated scope denial. The live cockpit continues to display cache-excluding
`new_tokens` as the compact total and labels cached input/provider total separately in Overview.
Exact state and hashes are append-only in `agent-collab/primary-integrator.md`.

#### 2026-07-16 — process-identity timezone compatibility follow-up active

`primary-integrator/root` owns a narrow `crates/koni-core/src/agent.rs` follow-up after proving that
`/bin/ps lstart` renders the same live worker birth instant differently under the cockpit's UTC and
the operator shell's America/Phoenix environments. New captures will be canonical UTC; exact legacy
records may additionally validate against the inherited-timezone rendering. PID/PGID/start-marker
equality and zombie rejection remain fail-closed, with no fuzzy time equivalence. The acceptance
worker stays running and no binary/live-state refresh is authorized until its durable boundary.

#### 2026-07-16 — tagged UTC process-identity source ready; guarded refresh deferred

The process-identity contract is tightened after independent safety review. New agent and broker
birth markers carry the `ps-lstart-utc-v1:` prefix and canonical `TZ=UTC0`, `LC_ALL=C` payload.
Tagged records validate only canonically; untagged legacy records validate only in the inherited
environment. No validator tries both interpretations for an untagged timestamp, preventing a
timezone-offset collision from authorizing a recycled PID/PGID. Focused identity, ambiguity,
changed-marker, and zombie regressions plus warning-denied core-lib Clippy are green.

The active acceptance Implementer completed its repaired ticket step, configured proof check,
clean commit, and compiler submission with exit zero; orchestration advanced to an independent
Reviewer. The cockpit remains on the prior isolated binary because the new Lead/Reviewer processes
are active and must not be interrupted. Install/refresh only at a later verified quiescent boundary.
The compact token number remains cache-excluding; the latest live split was 1,471,506 new,
5,397,504 cached, and 6,869,010 provider total. Full evidence is append-only in
`agent-collab/primary-integrator.md`.

Source verification is now complete: core-lib is 646 passed, zero failed, three ignored, and the
acceptance Reviewer accepted the repaired output before orchestration advanced to its next live
Lead slice. The isolated binary refresh remains deferred until that run is quiescent.

#### 2026-07-16 — generic graph path-disjointness integration-test lane active

`graph-path-constraint-tests/root` owns only a new expectation-first
`crates/koni-core/tests/graph_path_constraints.rs` fixture plus append-only coordination notes. It
will specify `graph_constraints` / `path_sets_disjoint` behavior for exact and hierarchical path
overlap, safe disjoint sets, `distinct_nodes`, fail-closed selector node-type declarations, and
filesystem aliases. `config.rs`, `engine.rs`, profile templates, live state, installed projects,
binaries, and processes remain outside this lease and under their existing owners.

The generic test lane is now `ready_for_integration`: all **6/6** focused cases pass, including
real hardlink and symlink aliases beneath a temporary project root. The selector/type regression
fails closed when selected runtime membership exceeds the side's declared node types, and the
same-selector fixture proves `distinct_nodes` exempts only self-comparison. Formatting and scoped
diff checks are clean. Software-specific constraint IDs and assertions remain owned by
`proof-source-profile/root`; this release changes no compiler/config/profile/live/runtime bytes.

#### 2026-07-16 01:22 MST — planned proof-source relocation read-only audit active

`relocation-test-audit/root` claims only a read-only design and test-map audit for the proposed
`planned-proof-source-relocation` transaction in `crates/koni-core/src/engine.rs`, plus append-only
coordination notes. It will identify existing action/event/journal replay helpers, immutable
completion and crash-recovery patterns, the smallest reusable fixtures, and exact invariants and
regressions. It will not edit Rust/profile/test source, live run state, installed or isolated
binaries, product worktrees, Git refs, processes, or cockpit/cmux surfaces; the engine
implementation remains solely with `primary-integrator/root`.

#### 2026-07-16 02:18 MST — planned proof-source relocation read-only audit released

`relocation-test-audit/root` releases its read-only lease after mapping the real Software lifecycle
fixture, the private read-scope crash-injection pattern, and the minimum relocation regression
matrix. The current implementation now seals exact full-compile identity across later progress and
preflights completion-event conflicts before graph publication. One P0 crash seam remains routed to
`primary-integrator/root`: a final `complete` transaction persisted before its completion event is
not currently pending/quarantined, so a crash in that window can admit ordinary actions and make
exact replay fail before reconciliation. The required fix and midpoint test are append-only in
`agent-collab/relocation-test-audit.md`. No Rust, profile, fixture, live state, binary, process,
worktree, Git ref, or cockpit/cmux surface changed in this audit.

#### 2026-07-16 — planned proof-source relocation public lifecycle tests released

`relocation-lifecycle-tests/root` supersedes its active test-only lease with
`ready_for_integration`. The new public integration target passes **2/2**: one real legacy Software
profile fixture proves exact graph/ticket/compiled-check/Journal/event publication, resumed-running
sealed replay, missing-event recovery, and semantic-byte idempotence; an independent fixture proves
that an authentic committed relocation request with its transaction and completion seal absent
quarantines ordinary compiler authority as `committed-request-awaiting-transaction`. The exact
command/result and all production findings are append-only in
`agent-collab/relocation-lifecycle-tests.md`. Scoped formatting and diff checks are clean. The lane
changed no production, profile, existing test, live state, binary, process, product worktree, Git
ref, or cockpit/cmux surface.

#### 2026-07-16 02:56 MST — planned proof-source relocation read-only security review complete

`relocation-security-review/root` releases its read-only source lease with no remaining definite P0
or P1 in the reviewed 02:55 MST save point. Earlier quarantine, actor, creator race, mutation-before-
validation, phase replay, durable ordering, path alias/logical absence, exact ticket/check/context
transformation, missing-seal, and tracked self-CAS findings remain preserved in the domain mailbox
as causal history. Current tracked sealing uses an exact reachable first-parent checkpoint rooted at
the pinned integration head, so later legitimate ticket/graph/event progress does not invalidate
history; explicit recovery reconciles an existing transaction before writing its own tracked
authority. Release remains held on a tracked Research fixture spanning every crash phase plus later
progress; the existing green **2/2** lifecycle fixture is Software / Git-common-dir only. Full
evidence and line-level disposition are append-only in
`agent-collab/relocation-security-review.md`. This review changed no production/profile/test/live/
binary/process/worktree/Git-ref/cockpit surface.

#### 2026-07-16 — tracked relocation phase-test design released

`tracked-relocation-test-design/root` completed a read-only reconstruction design for the tracked
backend hold. In the real plan/approve topology, the Complete steer action Journal and owning event
are checkpointed at H1 before transaction preparation; `transaction.integration_head` pins H1,
not the H0 head observed before invoking steer, and the complete relocation checkpoint H2 must be
its single-parent child. Each crash phase can be reconstructed in an independent disposable
approved integration worktree by a libgit2 CAS/tree restore from H2 to H1, followed by the exact
production-captured phase artifact overlay. This preserves the shared common-dir registry/control
authority and avoids shell reset or incomplete checkout copies. The matrix covers committed/no-tx,
prepared, graph-published, compiled with Failed and Recovered Journal midpoints, complete without
event, complete without checkpoint, and historical sealed replay after later event/ticket
checkpoints. Exact handoff is append-only in
`agent-collab/tracked-relocation-test-design.md`; no Rust/profile/test/live/binary/process/product
worktree/Git-ref/cockpit state was changed.

#### 2026-07-16 — tracked relocation public regression extension active

`relocation-lifecycle-tests/root` retains its new-file-only integration-test lease for one tracked
backend regression. The fixture now follows the real approved integration-worktree topology and
proves that a minimal tracked finish preserves the Software review-materialized `prepared` graph in
both the integration checkout and HEAD. Both existing Git-common tests remain green after the new
explicit-recovery preflight contract. The tracked test currently stops at a production-owned H1
boundary: although fixture prestate is clean, relocation reports the current Complete steer Journal
itself as the sole dirty path after its pre-checkpoint. Exact evidence is append-only in
`agent-collab/relocation-lifecycle-tests.md` and routed to `primary-integrator/root`; no production,
profile/template, existing test, live, binary, process, product worktree, ref, or cockpit surface is
owned by this lane.

#### 2026-07-16 — tracked relocation crash matrix implemented; hardening rerun pending

`relocation-lifecycle-tests/root` now has a green **4/4** public integration target, including a
six-row tracked crash/recovery matrix built from authentic H1/H2 history. Each fresh fixture asserts
the exact five-path H1-to-H2 tree delta, restores its disposable integration ref/index/worktree to
H1 through libgit2 CAS, overlays only production-captured phase artifacts, proves ordinary compile
quarantine and configured recovery, and resolves exact replay while running without changing HEAD
or semantic authority. The prior racy Journal hold is superseded by pure in-flight semantic
preview. Final verification is intentionally paused while `primary-integrator/root` centralizes H1
creation inside reconciliation and makes H2 an exact required-path parent-CAS checkpoint. Details
and causal history are append-only in `agent-collab/relocation-lifecycle-tests.md`; this lane owns no
production/profile/template/existing-test/live/binary/process/product-worktree/cockpit surface.

#### 2026-07-16 — tracked relocation public lifecycle matrix released

`relocation-lifecycle-tests/root` is `ready_for_integration` after the exact H1/H2 checkpoint
hardening. The public target passes **4/4** in 33.20 seconds and warning-denied test-target Clippy is
green. It proves exact two-path H0→H1 request authority, exact five-path H1→H2 relocation authority,
direct parentage, historical running replay after later tracked progress, and configured recovery
from six independently reconstructed durable phases without semantic or checkpoint duplication.
Temporary forensic diagnostics are removed; scoped formatting and whitespace checks are clean.
Exact evidence and superseding causal history are append-only in
`agent-collab/relocation-lifecycle-tests.md`. This lane changed only its new integration test and
coordination records, never production/profile/template/existing-test/live/binary/process/product-
worktree/Git-ref/cockpit state.

#### 2026-07-16 — pre-H1 partial action-success relocation regression active

`relocation-lifecycle-tests/root` reopens its new-file-only lease for the tracked subwindow where
the exact relocation steering event and Complete steer Journal exist, the
`compiler.action.steer` completion event does not, and same-input failed retry Journals are only
partially Recovered. The public fixture will require configured recovery to reconstruct exactly one
completion event and the complete retry binding, establish exact H1, seal H2, and replay
idempotently. Engine/Git production remains exclusively with `primary-integrator/root`; final full-
target and warning-denied Clippy reruns wait for that owner's stable-fix handoff. Details are
append-only in `agent-collab/relocation-lifecycle-tests.md`.

#### 2026-07-16 — pre-H1 partial action-success relocation regression released

`relocation-lifecycle-tests/root` is again `ready_for_integration`. The public target passes
**5/5** in 33.69 seconds and warning-denied test-target Clippy is green. Its new tracked regression
restores authentic H0, overlays the exact owner/Complete-Journal boundary plus one Failed and one
already-Recovered same-input retry, proves ordinary quarantine, and requires configured recovery
to create exactly one `compiler.action.steer` event. The recovered H1 tree is inspected directly
and has exactly four changed paths: the event ledger and three bound steer Journals. H2 remains the
exact five-path first-parent child, and running exact replay is event/state/HEAD-idempotent. Full
evidence is append-only in `agent-collab/relocation-lifecycle-tests.md`; no production/profile/
template/existing-test/live/binary/process/product-worktree/Git-ref/cockpit surface was edited by
this lane.

#### 2026-07-16 — tracked relocation final crash/security regressions released

`relocation-lifecycle-tests/root` is `ready_for_integration` with a green **7/7** public target in
33.13 seconds and warning-denied test-target Clippy. The new post-H2 regression proves normal
relocation synchronizes a genuinely empty retained ticket checkout through H2, then recovers both
marker-absent base/ref-base state and the torn ref/HEAD=H2 with index/workdir=H1 midpoint without
moving integration H2 or republishing semantic authority. It recreates the exact Git-common marker
and remains exact-replay idempotent. A separate malicious-H1 regression proves that an otherwise
exact owner/action-event/Complete-Journal request commit containing one unrelated product path is
rejected without publishing a transaction. Full evidence is append-only in
`agent-collab/relocation-lifecycle-tests.md`; this lane edited no production/profile/template/
existing-test/live/binary/process/product-worktree/Git-ref/cockpit state.

#### 2026-07-16 — final relocation retry/excluded-tree regressions active

`relocation-lifecycle-tests/root` reopens only its existing new public test for two fail-closed
cases: an existing steer success event missing one canonical exact-input Recovered retry binding,
and an otherwise-exact H1 containing a blob beneath configured tracked `program/locks` exclusion.
Both must be rejected before transaction acceptance. Production remains exclusively with
`primary-integrator/root`; exact progress and evidence are append-only in the relocation mailbox.

#### 2026-07-16 — final relocation retry/excluded-tree regressions released

`relocation-lifecycle-tests/root` is `ready_for_integration` with the full public target green at
**9/9** in 41.99 seconds and warning-denied test-target Clippy passing. Recovery now has public
coverage rejecting an existing steer success event that omits one canonical earlier exact-input
Recovered retry, before H1/transaction acceptance. It also rejects a clean handcrafted H1 whose
otherwise-exact request delta includes a real blob beneath configured tracked `program/locks`,
without creating an exclusion-cleanup descendant. Exact evidence is append-only in the relocation
mailbox; this lane changed no production/profile/template/existing-test/live/binary/process/product-
worktree/Git-ref/cockpit surface.

#### 2026-07-16 — primary relocation implementation security-cleared; final gates active

`primary-integrator/root` has completed the production H1/H2 ordering, retry-binding,
tree-exclusion, operational-marker, and ticket-synchronization hardening. The focused public
relocation target is green at **9/9**, warning-denied focused Clippy passes, and the independent
ordering review reports no P0/P1; one fail-closed checkout-interruption P2 is documented in
`runtime-and-git.md` and `agent-collab/relocation-ordering-review.md`. A Software regression found
during the first full gate was corrected by distinguishing earlier independent `Complete` actions
from earlier `Recovered` failed attempts; `software_proof_gate` is green at **23/23** after that
fix. Whole-workspace final verification is rerunning. Installed/global binaries, preserved Updog
state, product worktrees, refs, processes, and cockpit surfaces remain untouched pending those
gates.

#### 2026-07-16 — final source verification released

The stable release-gate snapshot is green: core library **649/649** with three intentional ignores,
graph-path constraints **6/6**, Software proof gate **23/23**, relocation lifecycle **9/9**, and TUI
library **303/303**. Workspace all-target warning-denied Clippy, full formatting check, and diff
whitespace check pass. One first-pass process-lifecycle test observed a transient empty PID-file
read; its focused rerun and a complete 649/649 rerun both passed without source changes. The code
fingerprints stayed fixed throughout. `primary-integrator/root` may proceed to the separately
guarded isolated Updog refresh; global installation and unrelated live/project state remain out of
scope.

#### 2026-07-16 05:16 MST — terminal wait-grant recovery integration active

`primary-integrator/root` has paused the preserved Updog acceptance run and refreshed only its
isolated binary. The first exact planned-proof relocation attempt failed before recording any
steering event because two historical Lead grants remain `revoke_pending` with an in-flight
`wait_worker`, although both bound runtime hosts, both brokers, and both owning agent records are
terminal. Ordinary configured recovery is intentionally **not** being invoked at this boundary:
it would also acknowledge the exact Failed compile Journal which the relocation must reproduce.

The active narrow lease is the broker-operation reconciliation helper, the relocation quiescence
preflight, and focused unit coverage in `crates/koni-core/src/engine.rs`, plus append-only runtime
and coordination notes. The intended rule is fail-closed: only a revoke-pending `wait_worker`
reservation whose exact owning agent record is terminal and whose process-bound host and broker
are dead may be cleared/replayed under the operation and grant locks. Arbitrary in-flight tools,
live/mismatched identities, and ambiguous responses remain blockers. No live run mutation occurs
until focused tests and warning-denied checks pass on stable source.

#### 2026-07-16 05:36 MST — unrelated tracked-symlink compatibility repair active

The isolated retry safely reconciled the two exact stale Lead waits, then failed before relocation
publication because the untracked-path verifier applied filesystem alias resolution to every Git
index entry. Updog deliberately tracks `.claude/skills` as a symlink to `.agents/skills`; although
it is lexically and semantically unrelated to the proposed `apps/books/...focused.test.tsx`, the
generic identity helper rejects encountering any symlink at all. The failed attempt again stopped
before a relocation event or transaction and preserved the exact Failed compile Journal.

`primary-integrator/root` now owns only the untracked-path verifier and a focused Git regression in
`crates/koni-core/src/engine.rs`. The repair must retain conservative filesystem identity checks for
ordinary tracked files (hard links, case, and Unicode aliases), reject a symlink at or lexically
overlapping the proposed path, and skip filesystem traversal only for unrelated Git symlink blobs,
whose target is not the tracked pathname and cannot make a separately symlink-free missing path a
tracked entry. Live state remains paused while this source boundary is tested and independently
audited.

#### 2026-07-16 05:49 MST — tracked-symlink repair target-aware and security-cleared

This supersedes the provisional “skip unrelated symlink blobs” wording immediately above without
removing its decision history. The verifier does not ignore a symlink entry. It independently
reads the exact index and pinned-HEAD target blobs, accepts only valid UTF-8, nonempty, NUL-free,
root-contained relative targets, and compares each resolved target to the proposed source through
both lexical and filesystem authority identity. Absolute/root-escaping targets, ambiguous
`normal/..` traversal, chained filesystem links, reverse aliases to the source or its ancestors,
and malformed blobs fail closed. A symlink pathname also receives a conservative lowercase/NFD
component-prefix comparison so a case/Unicode alias still rejects when that link is omitted from a
sparse checkout.

The real `.claude/skills -> ../.agents/skills` compatibility link passes because both its Git
pathname and pinned target are unrelated to the new `apps/books/...focused.test.tsx` proof.
Focused tests pass **2/2** across the positive case, malicious index target, malicious pinned-HEAD
target, absent case/Unicode aliases, malformed targets, and interior traversal. The independent
audit in `agent-collab/tracked-symlink-alias-audit.md` reports no remaining P0/P1. The preserved run
is still paused, clean at `12fcfa501e3bf47d60dbb814fb323dc4cf3e771f`, process-free, and both stale
Lead grants are now durably Revoked with no in-flight operation; broader source gates remain active
before another isolated binary refresh.

#### 2026-07-16 05:58 MST — Updog relocation sealed and acceptance run resumed

The final source bytes (`engine.rs` SHA-256 `de82aabc…`) passed core library **652/652** with three
intentional ignores, relocation lifecycle **9/9**, warning-denied core lib/test Clippy, formatting,
and diff whitespace checks. Independent tracked-symlink review reports no P0/P1. Release binary
`8f0542d9…` replaced only the isolated acceptance runtime; prior isolated `f3da24a3…` is backed up,
and global `~/.cargo/bin/koni` remains unchanged at `59ccb861…`.

The exact structured relocation replay completed as transaction
`019f6afd-c6f3-7d60-99ca-62c9b9d485f7`. It recorded one steering event and one completion event,
recovered both earlier exact-input steer attempts plus the original collision compile Journal,
changed only the focused proof node's `spec.source_paths` and pinned command, preserved the closed
Sales Notes compatibility proof/ticket and old source file, emitted `TK-5ec6ad45ffe5072b` as todo,
and intentionally left the new focused source absent for its worker. The integration checkout
remains clean at `12fcfa501e3bf47d60dbb814fb323dc4cf3e771f`; sidecar storage therefore did not create an
unnecessary product commit.

One ordinary recovery returned the exact `orchestrate` advisory; its explicit supervised retry
reopened that stage and stopped at the intentional pause boundary. `play-run` then enabled
scheduling. The isolated cockpit is live in cmux workspace 5, right pane/surface 111; Lead
`worker-019f6b01-a290-7541-8ca3-93d8be46b027` is active under the isolated Pi host and the TUI
shows the run working. Compact token telemetry remains deliberately cache-excluding and labeled
`new tks`; Overview separately shows 5.4M cached input and 6.9M provider total, so those values are
not contradictory measures.
### 2026-07-16 06:23 MST — TUI/docs audit released; bounded integration lease active

`tui-docs-completion-audit/root` completed its read-only audit in
`agent-collab/tui-docs-completion-audit.md` and released all inspection scope. The cache-excluding
`new tks` headline is confirmed intentional; cached input remains a separate provider-total and
reuse measure. `primary-integrator/root` owns the bounded source/doc integration for event-driven
redraw, the approval-MINI versus approved-Plan-FULL projection, current help language, and lowercase
Configure prompts. Focused redraw tests are green 77/77; focused MINI/FULL tests are green 2/2.
The preserved Updog run and its isolated cockpit binary remain untouched while its current worker
holds a live compiler grant. Upgrade-safe profile overlays, deterministic Lead boundary execution,
dense real-topology graph treatment, durable dead-agent reconciliation, and bounded transcript
streaming remain explicit follow-up architecture lanes rather than presentation-pass scope.
### 2026-07-16 06:35 MST — first-shot file-search contract repair active

The Medium acceptance baseline exposed a concrete fresh-token failure distinct from cache reuse.
Implementer `worker-019f6b0a…` spent 55,708 uncached/new tokens plus 25,088 cached input, then used
`search_files` on an unlisted parent directory after three successful exact-file searches. The
compiler correctly denied authority, but the tool description did not explain that separately
issued files cannot be widened through their parent, and the nonretryable error discarded the
session. Its independently spawned replacement avoided that call, authored the focused red test,
passed `baseline-proof-set`, and reached an accepted terminal compiler boundary.

`primary-integrator/root` owns the bounded repair in `agent_tool_broker.rs` and `engine.rs`:
assignment/tool copy now distinguishes an issued file/directory (and descendants of an issued
directory) from an unlisted ancestor; only a proven lexical ancestor of disclosed read paths gets
one model-visible correction; a second same-tool mistake stops with `file_scope_retry_limit`;
unrelated paths remain terminal `forbidden_scope`. Focused safe-error, broker retry-bound,
directory/file-scope, catalog, and scoped-compile tests pass. This does not widen product read
authority and has not refreshed the isolated live binary.

### 2026-07-16 06:43 MST — informed correction boundary sealed across Pi batches

The file-scope repair immediately above is now end-to-end rather than broker-only. A model may
emit several tool calls in one assistant turn; after the first retryable compiler rejection, the
Pi host now locally skips the remaining stale sibling calls instead of dispatching them against
the same retry budget. The next provider request begins only after the model has received the
actionable correction, so the single permitted retry is genuinely informed. Terminal and
nonretryable failures retain their previous behavior, and product authority is unchanged.

Stable source fingerprints have been released to `integrated-change-review/root`. Core library
tests pass **656/656** (with the pre-existing intentional ignores), TUI library tests pass
**306/306**, and the Pi host passes **55/55**, typecheck, bundle build, and bundle smoke. Formatting,
diff whitespace, and warning-denied core/TUI all-target Clippy are green. Compact `new tks`
continues to mean uncached input plus output; provider total separately includes cached input, and
reasoning remains a subset of output. The live acceptance binary and active worker were not
refreshed while this source-only release gate ran.

### 2026-07-16 06:54 MST — implementation drain exposed a surgical-edit primitive gap

The first production Implementer completed 11 provider turns and a coherent partial SPICED patch,
then ended with plain text after the focused check remained red. Exact accounting is **77,299
new tokens** (64,243 uncached input + 13,056 output), **382,976 cached input**, and **460,275
provider-total tokens**; 7,511 reasoning tokens are already a subset of output. The assignment did
name the required terminal compiler tool, so this is not an instruction omission. The trace says
the model could not safely reconstruct the large questionnaire definition through `write_file`,
whose only mutation primitive is a complete-file hash/CAS replacement.

The durable recovery preserved the partial ticket-worktree edits and spawned a replacement with
the same input hash, but schema-1.1 context currently has no compiler-safe prior-attempt failure
projection (`prior_outputs` remains empty for a no-terminal-output worker). Two follow-ups are now
queued: add a bounded hash-guarded surgical text edit primitive with the same crash/replay safety as
`write_file`, and project a safe failure class/correction into replacement context without copying
untrusted transcript prose. A graceful pause is already requested; the replacement Implementer is
draining at its compiler boundary, so the isolated cockpit binary must not be refreshed yet.

The README authentication mismatch is separately corrected adjacent to the historical statement:
current macOS login uses Pi browser PKCE; device code is only an alternate interaction if supplied
by the runtime/provider. No auth behavior changed.

### 2026-07-16 — surgical `edit_file` independent review lease

`surgical-edit-review/root` owns a read-only review of the new bounded hash-guarded `edit_file`
primitive across the broker catalog, scoped worker authority, whole-file CAS, exact-one matching,
durable intent/receipt/replay, crash reconciliation, revocation/deletion, and Pi frame bounds. The
review writes only `docs/agent-collab/surgical-edit-review.md` plus this append-only status note;
it has no source, live-run, installed-binary, cockpit, process, worktree, or Git-ref authority.

### 2026-07-16 — surgical `edit_file` independent review released

`surgical-edit-review/root` completed the delegated authority/transport and durability/recovery
passes and released its read-only lease. The final report is in
`agent-collab/surgical-edit-review.md`. No P0/P1 or guarded-refresh blocker remains: exact path and
step authority, whole-file hash CAS, overlapping-match rejection, semantic request identity,
durable intent/receipt/replay, response-versus-intent binding, postimage/preimage crash recovery,
revoke/delete reconciliation, historical-grant compatibility, and the shared 896 KiB Pi argument
bound all passed focused review. The integrator also made the snippet/control/postimage limits
explicit in the final tool descriptions. Remaining work is non-blocking: the JSON-Schema
character-count versus authoritative UTF-8-byte-count hint, several adversarial edit-specific test
fixtures, optional strict rejection of extra response keys, versioned future tool catalogs, and a
descriptor-relative writer only if malicious same-UID parent swaps enter the threat model. This
review changed documentation only and did not touch the live acceptance run or installed binary.

### 2026-07-16 07:41 MST — surgical mutation and bounded retry context accepted

`primary-integrator/root` accepts the reviewed `edit_file` surface for guarded release. This
supersedes the 06:54 mutation-gap queue without erasing it: workers now receive a compiler-issued
exact-one UTF-8 snippet replacement inside their existing step write scope, bound to a fresh
whole-file SHA-256 CAS and committed through the existing atomic whole-postimage writer. Durable
intent, response, receipt, crash recovery, revocation, deletion, and the immediately preceding
worker catalog remain fail-closed. The Pi host and Rust ingress share a 896 KiB escaped-argument
ceiling under the 1 MiB frame bound. Public copy states the 65,536-byte snippet and 393,216-byte
postimage limits; JSON Schema's character-count hint remains a documented non-blocking P2 because
authoritative byte validation rejects it safely.

Replacement contexts now also include a compact `compiler_owned_recovery_context` only when an
identity-bound attempt for the same run, ticket, step, and persona finished without a newer durable
step output. It exposes a safe failure class and count, warns that authorized partial edits may
remain, and directs the replacement to inspect current files, finish configured checks, and call
`submit_and_compile`. It never copies agent IDs, transcript prose, paths, or raw supervision
errors, and a newer durable output resets it. Core library gates pass **656/656** with three
intentional ignores, TUI passes **311/311**, Pi host passes **56/56**, and formatting, diff
whitespace, and warning-denied core/TUI Clippy are green. The live Updog run remains paused and no
isolated binary has yet been replaced at this checkpoint.

### 2026-07-16 — terminal-boundary retry design review active

`terminal-boundary-retry-review/root` owns a read-only review of the direct Pi worker/Lead turn
boundary: exactly one compiler-authored continuation after a normally stopped plain-prose response
that lacks a compiler-accepted terminal tool outcome. The review covers Pi agent-loop ordering,
compiler-issued terminal-tool catalogs, planning-session exclusion, output-budget/cancellation
behavior, durable side-effect replay, and bounded-loop tests. It writes only
`agent-collab/terminal-boundary-retry-review.md` plus this append-only lease note and has no source,
live Updog, binary, process, cmux, worktree, ref, or other documentation authority.

### 2026-07-16 — terminal-boundary retry review released

`terminal-boundary-retry-review/root` independently accepts the stable compiler-terminal
correction snapshot and releases its read-only lease. No P0/P1 remains. Rust sends an ordered
`terminal_boundary_tools` subset derived from the claimed broker catalog through the same terminal
outcome predicate; planning/read-only sessions explicitly send empty and older absent fields default
empty. The Pi host inspects the fully settled final assistant message and injects at most one
transcript-visible compiler correction only for normal-stop, nonempty prose with no tool call and no
actual terminal outcome, cancellation, or exhausted budget. It never converts prose or
reevaluates the predicate after that correction. The same runtime turn, tool receipts, cumulative
output allowance, and token buckets continue across both prompts; compact `new tks` remains
cache-excluding and provider total remains cache-inclusive.

Independent evidence: Pi typecheck and **65/65**, artifact verification and isolated bundle smoke;
broker **11/11**; Pi state **9/9**; exact Rust backward-compatibility and catalog projection **1/1**
each; formatting and scoped whitespace checks green. The generated bundle and manifest both hash
to `5d8a4376…8c121`. P2-only test follow-ups are correction-specific cumulative cached-bucket
equality, terminal-policy cancellation, every Lead variant, and explicit unsafe-ID rejection.
The change has no guarded-refresh blocker, subject to the integrator's full composed gates and the
existing pause/drain, backup, atomic isolated-binary replacement, cockpit restart, and resume
procedure. No source, live state, global binary, process, cmux, worktree, or ref was changed by the
review. Full details: `agent-collab/terminal-boundary-retry-review.md`.

### 2026-07-16 08:02 MST — primary integrator accepts terminal correction for guarded refresh

`primary-integrator/root` accepts the independently reviewed bounded terminal-boundary correction.
The policy is derived in catalog order from the claimed broker authority (`submit_and_compile` /
`compile` for Workers, `yield_lead` for Lead, empty for planning/read-only), defaults empty for old
wire requests, and permits at most one same-turn compiler-authored continuation after an exact
normal-stop, nonempty prose-only, no-tool final response. Error, length, cancellation, exhausted
budget, existing terminal outcome, and tool-bearing responses remain excluded. No success or effect
is synthesized, and cumulative transcript, receipts, output allowance, and token buckets persist.

The composed save point passes Core **657/657** plus three intentional ignores, TUI **311/311**,
Pi **65/65**, broker **11/11**, Pi state **9/9**, artifact verification/smoke, formatting, diff
whitespace, and warning-denied all-target Core/TUI Clippy. The sole initial broad-gate failure was a
pre-existing test race that treated PID-file existence as completed contents; the test now waits
for a parseable PID without changing supervision behavior. Independent review reports no P0/P1.
Release artifact `43cb865e…f60d` is ready only for the isolated acceptance path after the current
read-only recovery audit; global `~/.cargo/bin/koni` remains out of scope and unchanged.

Accounting clarification is canonical: `new tks = uncached input + output`; provider total adds
cached input; reasoning is a subset of output. No accounting code changed in this tranche.

### 2026-07-16 — context/read-discipline implementation active

`context-read-discipline-impl/root` owns the smallest source-only correction from the completed
cognition-efficiency audit. The Worker assignment and bundled Implementer will make compiler
context incomplete until `eof:true`, teach search-before-reading a known literal in a large file,
and discourage redundant relocation searches over retained complete results. Matching broker tool
copy and one bounded retryable `context_incomplete` gate will prevent product operations before the
exact context continuation reaches EOF. Historical grants/catalogs, exact scope, same-batch stale
sibling behavior, terminal semantics, and frame bounds remain pinned. This lease excludes live
Updog state, binaries, processes, cmux, refs, installed profiles, provider rendering, search-offset
metadata, and current-worktree manifests. Mailbox: `agent-collab/context-read-discipline.md`.

### 2026-07-16 08:52 MST — failed-review fixture preserved; durable ticket-agent recovery active

`primary-integrator/root` preserves Updog acceptance run
`019f66a9-df5a-7302-a3e1-00482d37a7ab` as an immutable failed-review fixture. Its accepted
Implementer produced a coherent nine-file SPICED patch, passed the compiler-selected command, and
submitted through the compiler on its first terminal boundary. The independent Reviewer correctly
failed the run because the focused proof asserted descriptor metadata but did not exercise the
proposal surface or questionnaire query/mutation routing promised by the proof node. The earlier
baseline output had already disclosed that omission. This demonstrates an upstream proof-oracle
preparation defect; repeatedly reopening `implement`, whose proof-source bytes are frozen after
baseline, would only spend more tokens without authority to repair the cause. The run is paused,
all owned agents are dead, no merge occurred, and the target branch remains untouched.

I own a disjoint source lease around `recover_agent_runtime_state`, its exact ticket-agent helper,
and focused lifecycle tests. Explicit recovery will durably move a ticket-bound `running`/`reaping`
record to provisional `exited_without_receipt` only when run ID, ticket, step, PID, process group,
birth identity, and process absence all agree. It will not infer a zero exit, touch planning or
aggregate orchestration records, cross run identity, or signal a possible live PID. A late exact
identity-bound waiter remains allowed to replace the provisional state with the real OS result.
This source lease excludes supervision fast-path code, proof-profile semantics, context/tool
discipline, live run files, binaries, processes, cmux, refs, and installed profiles. The clean
post-fix Medium run will use a new acceptance fixture from the untouched target rather than mutate
the preserved failed-review snapshot.

Accounting remains canonical and unchanged: compact TUI `new tks` excludes cached input and equals
uncached input plus output; provider total additionally includes cached input; reasoning is already
a subset of output. Efficiency comparisons must report fresh and cached cognition separately.

### 2026-07-16 09:14 MST — upstream implementation-proof preparation released

`implementation-proof-preparation/root` releases the bundled Software 0.6 profile/test/docs lane
as `ready_for_integration`. Red-green and characterization focused proofs now cross the existing
source-only `prepare-proof` ticket, exact historical baseline, and independent oracle-completeness
review before their linked change or migration can emit. Every linked eligible proof must have a
current reviewed preparation; failed review blocks product authority. Later implementation
baseline confirmation is read-only, its ticket writes only product `owned_paths`, and final review
still reopens from `implement`, so ordinary code rework cannot revise the trusted oracle.
Current-verification remains a no-preparation read-only path. Diagnostic and risk-boundary behavior
remains green and unchanged. Exact evidence is Software **26/26**, embedded template **4/4**,
warning-denied focused Clippy, YAML parsing, formatting, and whitespace validation. Existing
installed profiles/already compiled runs are intentionally not migrated or reinterpreted. Full
design and file/gate inventory: `agent-collab/implementation-proof-preparation.md`.

### 2026-07-16 09:27 MST — exact-live supervision fast path released

`live-supervision-fastpath-impl/root` releases its source-only supervisor preflight lane as
`ready_for_integration`. After one ordinary tick has published an exact passive-worker aggregate,
unchanged automatic polls can prove the complete pinned registration/orchestration/pipeline,
compiler-owned Worker record, ticket/step/lease/worktree, and live process-birth binding twice and
return the existing read-only `Waiting` state without global run authority or quarantine/board
projection. Paused, deleted, questioned, stale, dead, mismatched, blocked, terminal, or ambiguous
states all fall through to the unchanged full fail-closed tick. Pi sequential tool execution,
mutable broker grant validation, durable receipts, and one-in-flight CAS are unchanged.

Bounded non-sensitive counters prove whether an exact wait, full preflight, and quarantine check
actually occurred. Final gates are exact regression **1/1**, lifecycle **51/51**, Core library
**664 passed / 0 failed / 3 intentional ignores**, warning-denied focused Clippy, formatting, and
whitespace checks. No acceptance/live run, binary, runtime asset, process, cmux pane, ref, profile,
or product worktree was changed. Detailed proof and released symbols:
`agent-collab/live-supervision-fastpath.md`.

### 2026-07-16 09:18 MST — context/read-discipline implementation released

`context-read-discipline-impl/root` releases its source/template/test/docs lease. New Worker grants
now opt into a hash-bound context cursor: product file/list/search, mutation, configured-check, and
submission tools remain closed until the compiler document reaches `eof:true`; only its exact path
at each returned `next_offset` advances the cursor. One premature call gets a retryable
`context_incomplete`, an uninformed repeat stops, Pi still skips stale siblings after the retryable
error, and an exact continuation can be followed immediately by product work. Historical grants
omit the optional policy entirely and preserve their hashes/catalog behavior; Lead grants remain
outside it. Worker assignment, bundled Implementer, and catalog copy also teach search-first
navigation for a known literal in a large file and no redundant relocation search over retained
complete results. Exact scope, no-follow, terminal, and frame contracts are unchanged.

Evidence: broker **15/15**, real bundled Software direct-Pi paging/compile **1/1**, focused
assignment/legacy/Lead regressions **5/5**, CLI templates **8/8**, Pi stale-sibling **1/1**, plus
warning-denied Core all-target Clippy, formatting, and whitespace checks. A composed Core run had
only three expected fail-closed executable-identity errors while another Cargo process relinked the
test binary; all three passed individually when idle. No live run, binary, process, cmux, installed
profile, worktree, or ref changed. Full inventory: `agent-collab/context-read-discipline.md`.

### 2026-07-16 09:25 MST — implementation-proof preparation independent review requests changes

`proof-preparation-independent-review/root` completed its read-only audit of the released Software
0.6 implementation-proof-preparation lane. The upstream selector, source-only preparation,
independent review, change/migration readiness gates, multiple-proof coverage, current-verification
exception, immutable later source authority, diagnostic/risk compatibility, and non-vacuous path
constraints are accepted. Independent reruns pass Software **26/26**, embedded templates **4/4**,
and parse all five changed YAML modules.

One P1 blocks guarded release: final red-green/characterization review may still reject an oracle
defect, but the only failure route reopens `implement`, which has product-only authority. The
earlier preparation remains current, so no preparation ticket emits; the generic engine spends one
more Implementer attempt before its second-failure blocker. Existing regression coverage proves
only a product-correction finding where this route is appropriate. The recommended minimum is a
compiler-bound durable failure domain with profile-declared routing: ordinary ticket rework may
reopen `implement`, while an upstream-proof finding immediately preserves and blocks/holds the
candidate without another product worker. Complete recovery should explicitly supersede the old
preparation and reprepare from a clean pre-product integration state before issuing a fresh
implementation ticket. Prompt-only narrowing is acceptable only if final review is mechanically
product-only; prose alone is not sufficient. Full evidence and recommendation:
`agent-collab/implementation-proof-preparation-review.md`.

### 2026-07-16 09:44 MST — supervision/recovery independent review requests changes

`supervision-recovery-independent-review/root` completed a read-only audit of the released
exact-live supervisor fast path and the primary integrator's provisional dead ticket-agent
recovery. No P0 was found, and the core recovery transition is conservative: it signals no PID,
fabricates no successful exit, preserves result evidence, excludes planning/aggregate stage
records, and can be corrected by an exact late receipt. The fast path is read-only; its unavoidable
post-check race can yield at most one stale `Waiting` observation.

Two P1s block guarded release. First, production direct-Pi exit reconciliation treats its
five-second run-authority acquisition as optional and then writes without tombstone, deletion,
registry-live, or currentness checks. It can race the recovery write it is meant to correct, and it
can publish raw/ticket cleanup across deletion or conclusion. The generic waiter already has the
required fail-closed guard; both paths should share it, with paused/question-draining diagnostic
publication retained and no write after acquisition failure. Second, the fast snapshot rejects
`reaping` but ignores durable `starting` and other transitional records. A stranded startup beside
one valid live worker can therefore remain outside the binding hash and suppress full recovery
indefinitely. Reject every extra nonterminal/transitional record while continuing to ignore
historical terminal audit rows. Required race/currentness and starting-versus-terminal regressions,
plus P2 coverage gaps, are specified in
`agent-collab/supervision-recovery-review.md`.

### 2026-07-16 09:54 MST — structured review-failure routing correction active

`proof-rework-domain-fix/root` owns the bounded P1 correction requested by the independent
implementation-proof-preparation review. The generic workflow schema is evolving from one flat
failed-review reopen boundary to profile-declared failure-domain routes. New compiler-launched
reviewers will bind `none` on pass or one advertised domain on failure; selected-step defects may
retain the bounded reopen path, while an upstream proof/oracle defect must block on its first
review, preserve the rejected candidate, and record `replan_from_clean_integration` as the only
safe recovery source. Software red-green and characterization workflows are the first consumers.
The implementation is not released until generic schema/policy tests plus adversarial change,
migration, and multiple-proof gates pass in a private Cargo target. Live runs, binaries, projects,
acceptance fixtures, worktrees, refs, processes, and cmux remain untouched. Detailed lease and
decisions: `agent-collab/proof-rework-domain-fix.md`.

### 2026-07-16 09:32 MST — context/read-discipline independent review requests changes

`context-read-independent-review/root` completed a read-only audit of the new Worker context-EOF
gate. No P0 was found. Optional grant serialization preserves historical hashes, Lead grants remain
outside the policy, the exact path/offset/SHA cursor and one-correction limit are conservative, and
the current product catalog, Worker assignment, bundled Implementer copy, and focused happy paths
are coherent.

Two P1s block guarded release. First, Pi's sequential tool execution orders sibling effects but
does not let the model observe one sibling's result before authoring the next. A successful full
`context` call or final continuation marks the broker cursor complete, so a product sibling in the
same assistant message can dispatch before the model has read that context; stale-sibling quarantine
currently runs only after retryable errors. Require a provider-observation boundary after every
successful compiler-context delivery. Second, a grant allows only 256 receipts while an accepted
context may be 64 MiB: after the 32 KiB preview and reserving one terminal receipt, 254 maximum-size
pages reach only about 15.9 MiB (about 8.0 MiB at the documented default), before ordinary product
or check calls. Compose the document, paging, receipt, and terminal reserves into one validated
bound. P2 follow-ups cover one-byte multibyte pages, future-tool fail-open drift, missing search byte
offsets, malformed-page tests, and the test-only historical MCP seam. Exact evidence and green
focused checks: `agent-collab/context-read-discipline-review.md`.

### 2026-07-16 09:54 MST — structured review-failure routing source released

`proof-rework-domain-fix/root` releases the generic config/state/prompt/engine plus bundled
Software consumer slice for independent integration. New compiler-launched reviews bind schema
1.1 `failure_domain` to the exact ticket-snapshotted profile route map; legacy schema-1.0 records
remain readable. `ticket_rework` retains the existing bounded product-only reopen circuit.
`upstream_proof` now blocks on its first failure, preserves every rejected candidate output and
worktree, dispatches no replacement worker, and records `replan_from_clean_integration` with an
explicit prohibition on preparing against mutated candidate bytes.

Private-target evidence is generic route validation **1/1**, result-domain validation **1/1**,
generic first-failure hold **1/1**, existing ordinary product rework **1/1**, embedded Software
templates **4/4**, and one adversarial Software integration gate covering three independent
change/migration/two-proof lifecycles **1/1**. Targeted formatting and scoped whitespace checks are
clean. This lane did not run broad suites or touch any live/binary/project/runtime surface. The
safe recovery remains an explicit typed hold/replan boundary; any future automatic preparation
revocation/rollback requires a separate journaled transaction. Exact inventory and commands:
`agent-collab/proof-rework-domain-fix.md`.

### 2026-07-16 10:04 MST — supervision/exit-publication post-fix review approved

`supervision-exit-fix-reviewer/root` independently re-reviewed the two earlier supervision P1s on
the integrated source. No P0 or P1 remains. Both direct Pi and the generic reaper now require the
30-second run-authority boundary, validate the existing regular registry/control namespace and
both deletion generations, require a live matching registration, and re-read the exact
identity-bound receipt-accepting record before publishing. Paused/question-draining receipts remain
valid; deleted, unregistered, concluded, redirected, replaced, or missing-control state performs no
agent/ticket/PID publication. Provisional recovery and unrelated result evidence survive exact late
success or failure correction.

The exact-live wait now validates every `running` row and accepts only a closed set of finished,
dead terminal history outside the exact aggregate. Ticket- and stage-owned `starting`, reaping,
boundary-committed, review, recovery, unknown, or other unfinished rows force full supervision;
valid completed/failed history does not. Current composed evidence is Core library **680/680**
(three intentional ignores) and lifecycle **51/51**. Residual timeout/symlink/ticket-fixture and
terminal-audit strictness items are P2 coverage hardening only. Full verdict:
`agent-collab/supervision-exit-fix-review.md`.

### 2026-07-16 10:10 MST — Worker context spawn-boundary correction active

`context_spawn_preflight_fix/root` owns four post-fix P1s found by the independent context review.
New complete-before-product Workers will compile, size, and bind the exact selected-step context
before any grant, agent record, Pi process/session, or provider turn; broker delivery will reuse
that pack. Policy-enabled context is becoming one-shot and monotonic so repeated `context` cannot
rewind paging or consume the product receipt reserve. Pi's observation latch will be driven by an
explicit compiler-bound session policy bit, preserving absent/false legacy and Lead behavior. The
4,000,000-byte receipt cap will apply only to new policy-enabled direct-Pi Workers; historical
no-policy Worker and Lead/observer context retains the former bounded compatibility ceiling.
Production-path, receipt-budget, policy-compatibility, and no-side-effect MAX+1 regressions are
required before release. Exact lease: `agent-collab/context-spawn-preflight-fix.md`.

### 2026-07-16 10:09 MST — structured review-failure routing post-fix review approved

`proof-rework-fix-reviewer/root` independently re-reviewed the profile/config/state/reviewer and
Software lifecycle correction for the implementation-proof P1. No P0 or P1 remains. New reviews
bind schema-1.1 `failure_domain` to the exact profile-hashed, ticket-snapshotted route set; result,
durable agent record, review binding, input currentness, and ticket boundary all agree before
publication. Historical schema-1.0 records remain readable without becoming valid new outputs.

`ticket_rework` still receives one bounded product-only correction and stops after a second failed
review. `upstream_proof` now preserves every rejected candidate output and its worktree, applies no
passing review effects, clears runtime ownership, blocks on the first failure, and exposes no
eligible or replacement Implementer. The clean-integration recovery object is explicitly an open
hold—not a claim that rollback, preparation supersession, or replacement work already happened.
Independent private-target evidence covers generic config/result/hold/circuit behavior, the
ordinary Software rework lifecycle, embedded defaults, and real change/migration/two-proof
upstream holds. Remaining packet-self-hash ordering, characterization parity, and malformed-map
tests are P2 hardening only. Full verdict:
`agent-collab/proof-rework-fix-review.md`.

### 2026-07-16 10:16 MST — relocation fixture follows proof-preparation boundary

`relocation_fixture_regression_fix/root` verified that Software's new source-only preparation lane
honestly moves the first planned-proof source collision from `change.implement-red-green` to
`proof.prepare`; the production relocation guard remains unchanged. The shared relocation fixture
now names that exact rule, requires the full compiler's exact unmet `proof.preparation` projection,
and proves the resulting `prepare-proof` ticket's target, source read/write authority, historical
baseline step, and single compiled baseline member. The common scenario checks those bindings for
all nine cases, and every tracked publication-phase recovery rechecks them after reconstruction.
Private-target evidence is **9/9**, warning-denied test Clippy is clean, and no production/live/
runtime surface changed. Full disposition: `agent-collab/relocation-preparation-boundary-fix.md`.

### 2026-07-16 10:41 MST — Worker context post-fix review retains one P1 evidence blocker

`context_preflight_postfix_review/root` independently reviewed the frozen Worker context spawn
correction. Static production inspection finds the earlier behavioral P1s closed: the registered
run barrier spans exact bounded preflight through launcher entry, grants bind ticket/step/context/
path/body SHA/body length, every bound delivery revalidates that pack, Rust/Pi cursors are
one-shot, pre-EOF supplements cannot consume receipts, and absent/false policy plus the 64 MiB
legacy ceiling remain compatible. No current production bypass or lock inversion was found.

Guarded release is still blocked by one P1 evidence defect. No test calls
`spawn_direct_pi_agent_with`; the existing bundled Software direct-Pi test creates an unbound
policy grant only after a fake host exists and therefore exercises the superseded post-launch
ordering. Add a production-shaped MAX/MAX+1 counted-launcher fixture proving zero grant/agent/
pack/ticket mutation on rejection, plus dirty replacement and bound-pack mutation/currentness
adversaries. Independent private-target evidence is Rust context **10/10**, arithmetic/
compatibility **2/2**, existing Software broker **1/1**, Pi runtime **60/60**, TypeScript typecheck,
format, and whitespace checks green. Full findings:
`agent-collab/context-preflight-postfix-review.md`.

### 2026-07-16 10:50 MST — primary integrator composed-gate checkpoint

The frozen snapshot is green across Core library **683/683** (three ignored), all ten Core
integration binaries, TUI **311/311**, CLI **69/69**, and Pi **70/70** plus typecheck/build/checksum/
isolated smoke. CLI required one test-only correction: Software 0.6 independently prepares proof
sources, so red-green and characterization `establish-baseline` steps now correctly expect zero
write paths alongside current-verification. Compact token telemetry remains cache-excluding new
work; provider total separately includes cached input. Release remains blocked only on the
production-shaped Worker context prelaunch fixture and its newly discovered canonical-pack-path
adversary.

### 2026-07-16 11:37 MST — Worker context follow-up remains P1 on test wiring

`context_preflight_postfix_review/root` independently reran and inspected the frozen follow-up.
The new regression is a substantial correction: it invokes the real `spawn_direct_pi_agent_with`
seam on a real Software run; exact MAX reaches its continuation once; MAX+1 reaches it zero times
and preserves captured ticket/context/receipt/grant/response/agent/log state; the stale launch
ticket is refreshed; and the canonical same-byte alternate path, deletion, and both ticket-hash
adversaries fail. The exact private-target test is **1/1**, Rustfmt is clean, and the scoped
whitespace check is clean. Static production inspection finds no current bypass, lock inversion,
or currentness defect.

One P1 test-as-contract domain still blocks release. The injected continuation calls the pregrant
validator itself and never enters production launcher/PID publication; bound-pack adversaries call
the validation helper directly rather than the production `context` and bound-`read_file` broker
routes beneath durable receipt dispatch. Both production wiring regressions could therefore pass
the test. The body adversary also changes length, so it does not independently protect SHA
identity; add a same-length substitution. Tracked-storage relative canonical paths, empty
directory side effects, and raw ticket-byte preservation remain P2 evidence gaps. Full evolution
note: `agent-collab/context-preflight-postfix-review.md`.

### 2026-07-16 11:55 MST — final Worker context production-call-site evidence frozen

`context_spawn_preflight_fix/root` completed the four bounded corrections retained by independent
review. The real counted spawn wrapper now validates its prepared Worker pack immediately before
the launcher; production PID/active-worker publication uses one shared helper and preserves the
refreshed context binding; the body adversary is an equal-length byte substitution; and the
claimed bundled Software broker now uses a real preflight-bound grant for `context` plus exact
`read_file` paging. Same-byte path, same-length body, deletion, and ticket-context drift all fail
through unique non-replay broker calls without changing sequence, receipts, in-flight state,
ticket, response files, or scoped compiler events. Both focused tests are **1/1**, Core check,
Rustfmt check, and scoped whitespace check are green. Source is frozen for
`context_preflight_postfix_review/root`; no provider/live/release surface changed.

### 2026-07-16 12:11 MST — independent Worker context re-review clears P0/P1

`context_preflight_postfix_review/root` independently inspected and reran the final frozen
production-call-site delta. **No P0 or P1 remains.** The counted wrapper now owns pregrant
currentness validation immediately before every launcher, and its test closure no longer supplies
that validation itself. The production PID/active-worker callback and exact-MAX fixture share one
ticket-publication helper, proving the refreshed selected-step and issued-context hashes survive
PID publication. The claimed Software broker test now receives a real preflight-bound grant,
traverses actual `context` and bound `read_file` delivery to EOF, and sends distinct non-replay
path/body/delete/ticket adversaries through the real broker while sequence, receipts, in-flight
state, ticket, response files, and scoped compiler events remain unchanged. Equal-length byte
substitution independently protects SHA identity.

Independent private-target evidence is wrapper boundary **1/1**, claimed Software broker **1/1**,
Rustfmt clean, and scoped whitespace clean. Static inspection finds no production bypass,
lock-order regression, or currentness regression. Tracked-storage relative-path coverage,
empty-directory/raw-ticket-byte snapshot precision, the physically populated 128-entry recovery
ledger, and separate large Lead/observer fixtures remain P2 hardening only. Full final evolution:
`agent-collab/context-preflight-postfix-review.md`.

### 2026-07-16 12:28 MST — non-destructive `init-project` target handling claimed

`context_spawn_preflight_fix/root` owns only the legacy CLI `InitProject` dispatch, a narrowly
named target-preparation helper, focused inline CLI tests, and directly necessary help text. The
new contract removes recursive deletion entirely: missing and empty real directories remain valid,
while every existing nonempty target stays byte-for-byte untouched even with the deprecated
`--force` flag and receives guidance to use `koni init`. Direct target symlinks fail closed. No
TUI transaction, upgrade/overlay, packaging, profile, runtime, live state, binary, cmux, or product
repository surface is in scope. Mailbox:
[`agent-collab/init-project-safety-fix.md`](agent-collab/init-project-safety-fix.md).

### 2026-07-16 18:17 MST — Pi process pool is now the production run-engine default

`pi-native-port/root` integrated the process pool into `RunAuthorityEngine`: production launches
and recovery now use one child process group per attempt, while the process-local managed
supervisor is available only when tests inject it explicitly. The same integration adds exact
accepted/rejected authority receipts and a compiler-resolved configured-check transaction with
bounded sandbox execution, path manifests, typed result files, output-file hashes, durable dynamic
rule evidence, and audit artifacts. Combined Core evidence reached **214/214** and strict
TypeScript was green before the profile lifecycle lane's current bundle regeneration.

One pre-existing TypeScript scaffold gap is now centrally recorded as a release blocker: planning
still materializes the permanent run checkout too early, and tickets do not yet receive isolated
branch/worktree cycles. A dedicated Git lifecycle lane must restore detached planning,
post-approval run materialization, per-ticket scoped worktrees, squash/CAS integration, conflict
tickets, and safe retirement. No live Koni project, credential, process, installed binary, terminal
surface, or user run was touched.

### 2026-07-16 18:03 MST — Pi attempt process containment implemented

`pi_session_process/root` added a versioned and byte-bounded child protocol, one-attempt detached
Node process-group supervisor, sealed managed-session child entry, and run-level process pool.
Meaningful tools/context/compaction/recovery stay parent-authority RPCs. Committed steering records
remain hash/order bound end to end. Run deletion tombstones before awaiting and escalates graceful
Pi abort through process-group TERM/KILL, including descendants. Focused provider-free evidence is
**12/12**; exact design and integration notes are in
[`agent-collab/pi-session-process.md`](agent-collab/pi-session-process.md). The authority engine
still needs to select this pool as its production default through the shared structural supervisor
port; its existing in-process supervisor should remain only an explicit test seam.

Handoff addendum: exported integration types are `PiAttemptProcessSupervisor`,
`PiAttemptProcessLaunchOptions`, `PiAttemptProcessAuthority`, `PiAttemptProcessHandle`,
`PiAttemptProcessSessionView`, and `PiAttemptProcessSupervisorEvent`. Final Core strict typecheck,
focused **12/12**, Core build, emitted child artifacts, and whitespace verification are green.

### 2026-07-16 18:12 MST — Pi managed-session authority-result contract complete

`pi_managed_sessions/root` completed the contained AgentSession contract through durable rejected
outcomes and hash-bound result budgets. Tool receipts are now an exact protocol-tagged
accepted/rejected union; the authority recovery ledger repeats the outcome; Pi's `isError`, exact
rendering, arguments digest, and receipt digest are authenticated on recovery. Only accepted
terminal receipts terminate; rejected terminals remain retryable. Every launch tool binds a
`maxResultBytes`, and an aggregate per-turn reservation can durably record a no-effect
`transcript_result_budget` rejection before any tool effect. Pi-native argument coercion and
deterministic validation/truncation errors are also recoverable without fabricating authority.
Provider-free focused evidence is **74/74** and Core strict typecheck is green. Full contract and
supersession notes: [`agent-collab/pi-managed-sessions.md`](agent-collab/pi-managed-sessions.md).

### 2026-07-16 13:04 MST — acceptance candidate held on adversarial boundary review

The primary integrator re-ran the frozen composed source gates: CLI **73/73**, TUI **311/311**,
Core library **692/692** with three intentional ignores, every Core integration binary, workspace
warning-denied Clippy, Rustfmt, diff whitespace, and Pi **70/70** are green. Token accounting is
unchanged: compact `new tks` means uncached input plus output, while provider total additionally
includes cached input; reasoning is already a subset of output.

Independent static review nevertheless found release-blocking boundary defects that the green
suites did not exercise. Configured checks can self-invalidate receipts after truncation, read
artifacts without a size/time bound, race pathname validation before opening a result, and retain
unbounded retry accumulation. `init-project` also rejects a plain final symlink but can still
follow a trailing-separator symlink or a symlinked ancestor. The isolated candidate and Updog
acceptance run are therefore **NO-GO** until descriptor-rooted I/O/publication, compatible retained
and observed hashes, bounded artifact/retry budgets, adversarial regressions, and independent
re-review are complete. The preserved old run remains paused, token-idle, and unmerged; global
`~/.cargo/bin/koni` remains untouched.

### 2026-07-16 12:43 MST — non-destructive `init-project` fix ready

`context_spawn_preflight_fix/root` removed the legacy recursive deletion authority completely.
`init-project` still accepts `--force` for CLI compatibility, but the flag cannot delete or replace
anything: missing and empty real targets proceed, every existing nonempty target fails before the
profile is opened with guidance to use `koni init`, and direct target symlinks fail closed. Tests
recursively snapshot root/home/ancestor/repository-root/cwd/ordinary fixtures and a symlink
referent to prove bytes and structure remain unchanged. Focused CLI evidence is **4/4**, exact-file
Rustfmt and scoped whitespace/destructive-call checks are clean. The bounded source lease is
released; no live, binary, runtime, profile, cmux, or product-repository state changed. Details:
[`agent-collab/init-project-safety-fix.md`](agent-collab/init-project-safety-fix.md).

### 2026-07-16 18:52 MST — Pi-native profile lifecycle and guarded migration complete

`profile_lifecycle_migration/root` completed the broad-package profile boundary. Verified package
baselines now materialize as `.koni` overlays with immutable baseline history, real three-way
upgrade conflicts, crash-forward publication, and no `.pi`/credential/settings/community-resource
effects. A source-retaining `.codex/koni`/unmanaged-`.koni` adapter compiles known schema-1
customizations against the current baseline, requires a held run-authority barrier for legacy run
state, archives receipts/compatibility bindings atomically, and re-hashes exact run trees before
resume. The lifecycle also owns semantic catalog/read/update APIs so the control center publishes
one structured YAML document through source-SHA CAS and complete candidate compilation rather than
writing `.managed`.

Coding 0.7.0 is frozen at 46 files / `4b34812a…`; Research 1.0.11 is frozen at 49 files /
`66c11b01…`. Both add inert, opt-in Pi community resource catalogs; no package is automatically
installed or enabled. Research reciprocal facts and node descriptions have explicit regressions.
Focused profile evidence is package/registrar **9/9**, Core **32/32**, and isolated strict
TypeScript green. Exact APIs, complete digests, design decisions, and current broad-test blockers
are in [`agent-collab/profile-lifecycle-migration.md`](agent-collab/profile-lifecycle-migration.md).

### 2026-07-16 19:00 MST — isolated planning/run/ticket Git lifecycle complete

`isolated_git_lifecycle/root` implemented the compiler-authoritative Git boundary in
`packages/core/src/git`: detached no-ref planning at an exact target OID, post-approval run
materialization, unique ticket-cycle worktrees, explicit path-scope enforcement, single-parent
squash publication to the run ref, explicit operator target promotion, conflict-as-integration-work
results, intent-journal crash recovery, and proof-gated namespace retirement. Explicit abandoned
run deletion preflights the entire compiler namespace before mutation and never touches the user
target ref. Recent selectable target branches exclude Koni-owned refs. The legacy manager remains
only as an independently typed, fail-closed compatibility surface. Focused evidence is **24/24**,
Core strict TypeScript is green, and scoped whitespace verification is clean. Exact authority-state,
journal, cwd, deletion, and migration handoff details are in
[`agent-collab/isolated-git-lifecycle.md`](agent-collab/isolated-git-lifecycle.md).

### 2026-07-16 19:20 MST — proof-gated legacy run Git migration complete

`isolated_git_lifecycle/root` added the explicit startup adapter for persisted flat
`RunRecord.git` state. `ProjectAuthorityStore.open()` now either atomically upgrades an
unmaterialized/cleaned record from exact repository evidence, or preserves and blocks ambiguous
resources without any Git mutation. Clean exact active legacy checkouts receive a hash-bound
`LegacyRunRelocationPlan`; they are deliberately not labeled resumable because the old checkout
occupies the new namespace container. The plan and its settled `relocated` metadata shape are
public Core types. Focused migration/store evidence is **9/9**, composed Git/store evidence is
**33/33**, strict Core TypeScript is green, and whitespace verification is clean.

A journaled two-hop source -> staging -> integration relocation executor remains a release gate,
as does legacy-aware explicit deletion before relocation. Exact paths, preconditions, recovery,
settlement, and deletion constraints are in
[`agent-collab/legacy-run-git-migration.md`](agent-collab/legacy-run-git-migration.md).

### 2026-07-16 19:34 MST — legacy relocation/deletion release gate active

`legacy_git_relocation/root` owns the narrow compatibility boundary that follows the proof-only
legacy Git adapter: authority-lane admission/reproof, a dedicated crash-forward source -> staging ->
canonical-integration intent, recovery at both move boundaries, atomic lifecycle/compatibility
settlement, obsolete ticket-projection clearing, and proof-bound explicit deletion of an
unrelocated legacy namespace. New-layout Git behavior is otherwise frozen; control-center,
configuration, reports, profiles, Pi sessions/credentials, live projects, installed binaries,
processes, and terminal panes remain excluded. Mailbox and exact scope:
[`agent-collab/legacy-git-relocation.md`](agent-collab/legacy-git-relocation.md).

### 2026-07-16 20:02 MST — legacy relocation/deletion release gate complete

`legacy_git_relocation/root` completed the compatibility-only Git executor. Exact clean legacy
checkouts are quiesced, journaled, moved source -> staging -> canonical integration, compiler-
locked, and recovered idempotently from every hop/lock boundary. One atomic authority settlement
updates lifecycle and migration records, clears only proof-bound obsolete ticket projections,
records the Git receipt, and restores the prior phase through the reducer; paused remains paused.
Unrelocated deletion now has its own whole-namespace proof and durable intent, including recovery
between worktree retirement and run-ref CAS. Dirty, redirected, ambiguous, moved-ref, occupied, or
foreign-lock state remains readable and preserved; the target ref is never a deletion effect.
Focused legacy evidence is **13/13**, the composed Git/store focus is **41/41**, and strict Core
TypeScript is green. All effects used disposable repositories; no live project, binary, Pi home,
process, credential, ref, or terminal pane changed. Detailed handoff:
[`agent-collab/legacy-git-relocation.md`](agent-collab/legacy-git-relocation.md).

### 2026-07-16 19:05 MST — profile lifecycle lease released after composed verification

`profile_lifecycle_migration/root` reran the frozen profile boundary after adjacent TypeScript
lanes stabilized: complete Core strict typechecking is green, focused profile evidence remains
**32/32**, and coding/research package checks are **1/1** and **3/3**. The filesystem-heavy profile
fixtures now explicitly use their established 30-second integration timeout, preventing full-suite
parallel contention from being reported as a semantic failure; production behavior is unchanged.
The only handoff is the already documented authority adapter for quiescing and hash-verifying
legacy paused runs before resume. The source lease is released.

### 2026-07-16 19:24 MST — Pi-native control-center full parity client complete

`pi_operator_surface/root` completed the single shared `/koni` and `koni tui` controller/component:
full New Run intake, semantic configuration, structured plan review, complete Pi transcript/chat,
equal-column dashboard, questions, agents/activity/graph, help, compact layouts, cache-aware token
copy, and immediate provisional runs. Configuration now also presents nested semantic resources
with guided Add/Duplicate/Delete flows. Those collection flows use opaque catalog capabilities and
revisioned source-CAS RPCs, block while a field draft is dirty, and never expose YAML, paths,
hashes, or internal IDs. Focused provider-free evidence is **23/23**. Exact collection RPCs and the
remaining authority-registration handoff are recorded in
[`agent-collab/control-center-full-parity.md`](agent-collab/control-center-full-parity.md).

#### 2026-07-16 19:40 MST — control-center review findings resolved

The earlier client-only checkpoint is superseded. Real Pi and standalone hosts now supply the
ordinary Pi model catalog; the authority owns semantic resource capabilities plus crash-safe
create/duplicate/delete handlers; and saved drafts remain bound to their originating CAS until an
explicit rebase/discard. The independent P1 sweep also fixed real-width Objective/stage/dialog
wrapping, live transcript refresh, read-only historical chat, prior-tab restoration, quiet
preapproval planning, Notes anchoring, terminal stage completion, graph scope, and Chat help.
Focused provider-free control-center evidence is **31/31** and strict Core TypeScript is green.
The exact supersession record is in
[`agent-collab/control-center-full-parity.md`](agent-collab/control-center-full-parity.md).

#### 2026-07-16 19:44 MST — control-center source lease released

The control-center lane is frozen and released at its last coherent **31/31** focused checkpoint
with strict Core TypeScript green. The real authority RPC lifecycle regression is now checked in;
the primary integrator will rerun it after concurrent Git/parity work restores its temporarily
incomplete private-method edit. No live/provider/credential/process/terminal state was touched.

### 2026-07-16 19:48 MST — Pi-native package/install/release lane active

`pi-native-port/root` owns the narrow production packaging conversion: the developer installer,
Node/npm CI and release workflows, exact Pi peer ranges in the three coarse package manifests,
package-lock reconciliation, and adjacent dated documentation transitions. Production artifacts
are only `@koni/core`, `@koni/coding-profile`, and `@koni/research-profile`; the Rust tree remains a
non-shipping frozen oracle until executable parity permits deletion. This lane never mutates Pi
configuration/auth/packages, publishes externally, installs locally, touches live projects/runs,
or opens terminal panes. Details and handoff evidence are recorded in
[`agent-collab/pi-native-port.md`](agent-collab/pi-native-port.md).

> **Pi-native peer correction — 2026-07-16:** “Exact Pi peer ranges” above is superseded at the
> shipping-manifest boundary by Pi's documented `"*"` convention for bundled SDK peers. The exact
> Pi `0.80.10`/TypeBox `1.1.38` pair remains the development lock and executable compatibility
> target; installed packages reuse the operator's Pi SDK rather than forcing a parallel copy.

### 2026-07-16 20:10 MST — Pi community resource integration complete

`community_resource_integration/root` completed the executable opt-in boundary for ordinary Pi
community resources. Enabled exact skill/prompt selections are discovered without mutating Pi,
snapshotted without executing extension code, pinned into immutable run artifacts, filtered by
stage/persona/network authority, and included in normal `AgentLaunchSpec` resource-set and spec
hashes. Interactive-only packages remain ambient and never enter autonomous inventory or context;
unknown/missing packages, tampered pins, unsafe paths, arbitrary extension APIs, and ungranted
network adapters fail closed. Recovery uses the original pinned bytes across later package
upgrades, while pre-community run artifacts stay compatible. Core strict TypeScript is green and
focused provider-free evidence is **41/41**. No Pi settings/package, live project/run, provider,
credential, process, binary, ref, or terminal state changed. Exact handoff:
[`agent-collab/community-resource-integration.md`](agent-collab/community-resource-integration.md).

#### 2026-07-16 20:12 MST — community integration composed rerun

After the adjacent relocated-legacy planning regression added its valid-lineage case, the same
six-file community/native-run composition was rerun at **42/42** with Core strict TypeScript green.

### 2026-07-16 20:13 MST — relocated legacy planning resume closed

`legacy_git_relocation/root` closed the final compatibility seam after coordinating the exact
native-program region with `community_resource_integration/root`. Only a proof-settled
`legacyGitMigration.status: relocated` run with a ready, HEAD-bound canonical run checkout may
resume its prior planning phase there. An otherwise identical native run with a retired detached
planner still fails closed, so the current-run Git topology is unchanged. The focused real
`NativeRunCompilerProgram` suite is **6/6**, the composed native/legacy/Git/store gate is **47/47**,
and strict Core TypeScript is green; no community resource-selection code or live state was touched.
Exact rationale and evidence are appended to
[`agent-collab/legacy-run-git-migration.md`](agent-collab/legacy-run-git-migration.md).

### 2026-07-16 20:18 MST — provider-free lifecycle/Git/ticket parity lane active

`legacy_git_relocation/root` now owns only the proof blockers
`KPAR-GIT-0002/A02`, `KPAR-LIF-0001/A02+A03`, `KPAR-LIF-0002/A02+A03`,
`KPAR-TKT-0001/A01+A02+A03`, and `KPAR-SWF-0001/A03`. Existing exact production tests are
preferred; a new composed Core fixture is permitted only where the complete invariant is not
already executed. `executable_parity_runner/root` retains the runner and all other proof entries,
confirmed no overlap, and will coordinate the final manifest hash. No provider, synthetic capture,
live project, installed state, process, credential, ref, or terminal mutation is authorized.

#### 2026-07-16 20:46 MST — provider-free lifecycle/Git/ticket parity handed off

All nine claimed proof blockers are now backed by exact provider-free production tests. Profile
review-failure routing reaches durable ticket state and executes one fresh rework/review cycle;
pause/restart/resume and active deletion have adversarial authority-engine fixtures including
cached-token and revoked-write boundaries; target conflicts compile exactly one bounded resolver;
configured checks must now be current-attempt accepted passes before terminal compilation; and
existing isolated Git plus explicit-publication tests close ticket/run delivery topology. The
composed proof set is **54/54** and strict Core TypeScript is green. The proof manifest now has 8
blockers, all outside this lease; `executable_parity_runner/root` will publish the final manifest
SHA after the adjacent proof owner lands. Full handoff:
[`agent-collab/legacy-git-relocation.md`](agent-collab/legacy-git-relocation.md).

### 2026-07-16 20:16 MST — community resource source lease released

The final compatibility case proves a pinned artifact issued before the community field existed
still resumes without consulting Pi package inventory. Community/parser/native-run/launch/resource/
configuration evidence is now **43/43**; authenticated profile packages are **10/10**, coding is
**2/2**, research is **4/4**, and Core strict TypeScript is green. The community resource lane is
frozen and released; exact resource/tool hashing and security consequences remain documented in
[`agent-collab/community-resource-integration.md`](agent-collab/community-resource-integration.md).

### 2026-07-16 20:51 MST — Core publishes general Koni skills through Pi

`pi-native-port/root` completed the native resource-publication boundary for the three coarse
packages. `@koni/core` now declares and ships the shared `configure-koni`, `model-koni-work`, and
`operate-koni` skills in its ordinary Pi package manifest. Its build proves that the Coding and
Research copies remain byte-identical before publishing the exact 18-file tree. A provider-free
stock-Pi smoke installs all three local packages, discovers `/koni` and all three `skill:*`
commands, initializes and validates an isolated Coding project, and proves Koni operations do not
change Pi credential/settings bytes. Autonomous attempts still use only the exact compiler-selected
hash-bound copies; this does not admit ambient user resources into their authority boundary.

The packaging/release lane remains active. It will not edit context assembly, run-program terminal
check enforcement, or parity manifests/captures while those regions are leased by concurrent lanes.
Executable parity finalization is waiting on the last proof handoffs.

### 2026-07-16 21:24 MST — release-boundary hardening coordinated beside context experiment

`pi-native-port/root` owns the remaining fail-closed release boundaries in
`packages/core/src/authority/{protocol,client,server}.ts`, authority bootstrap, the contained
attempt-process launcher, immutable profile-source installation, exact packed-package stock-Pi
smoke coverage, release workflow wiring, and adjacent current-product documentation corrections.
This lane explicitly does **not** edit compiler context assembly, run-program prompt/context
construction, community-resource selection, compaction, or the concurrent context-building
experiment. Runtime identity must cover the complete executable closure so an installed package
refresh can never make an older authority process spawn children from different bytes.

#### 2026-07-16 21:38 MST — profile publication/compile race closed

The release lane changed only the authenticated project-directory boundary, lifecycle-lock owner
tracking, and generic file-journal recovery; it did not touch context construction, run-program
prompt assembly, resource selection, or compaction. An unrelated compiler invocation now fails
closed while profile/config publication holds the lifecycle lock, while the exact async lock owner
may still validate a guided edit before publication. Any crash-pending transaction also blocks
compilation; recovery now retires both replayed and already-committed journals so a crash between
commit and cleanup cannot strand the project. Focused compiler/profile/journal/runtime/authority
evidence is **45/45** with strict Core TypeScript green.

### 2026-07-16 — concurrent context experiment remains a protected boundary

The user reconfirmed that another agent is actively experimenting with Koni's context-building
logic in this shared worktree. Until that owner records a handoff, `pi-native-port/root` will not
edit compiler context assembly, run-program prompt construction, resource selection/binding, or
Pi compaction. Its remaining work is limited to runtime/executable identity, authority quiesce and
restart behavior, Git and sandbox executable containment, release integration, and adjacent
append-only coordination notes. Any newly discovered overlap must be raised in the context owner's
mailbox before source changes, and coherent context changes that appear here must be preserved.

#### 2026-07-16 — exact executing runtime and external-effect identity closed

The release lane now binds ordinary authority handshakes to an executing Core build SHA embedded
directly into compiled `dist` bytes; hashing mutable installed files is only the guard. An old Pi
session therefore cannot advertise a replacement build, and an unembedded package fails closed.
Compatibility control remains restricted to durable quiesce so old code can stop work before the
operator reloads Pi. The complete runtime closure now authenticates Node, Git, and the platform
sandbox executable; authority Git and configured checks use those absolute identities, recheck
them immediately before effects, and retain their hashes in receipts. Adversarial Core replacement,
Git PATH substitution, sandbox injection, duplicate Core origins, quiesce, and run-engine evidence
is **38/38** with strict Core TypeScript green. Duplicate-origin admission was then strengthened:
Pi's canonical `getCommands()`/`sourceInfo` inventory is checked at `session_start`, so even a
guard-unaware legacy Core is detected; Koni shows scope-correct removal commands and shuts Pi down
before either renamed command can run. No context-building source was changed.
## 2026-07-16 — Pi-managed packaging boundary (`community_resource_integration/root`)

Active until final packed gates complete. This lane owns `scripts/install-dev.sh`,
`scripts/register-dev-packages.mjs`, `scripts/dev-package-bundle.mjs`,
`scripts/pi-package-smoke.test.mjs`, package shipping metadata, release packaging, and adjacent
install/update documentation. Current decision: one Pi-managed Koni closure; exact user Pi 0.80.10
is the only Pi SDK/TypeBox source; source activation is a secret-free atomic proper-lock/CAS
transaction; targeted Koni updates require Pi reload and explicit run resume. Do not edit these
surfaces without coordinating in `docs/agent-collab/pi-managed-packaging.md`. Runtime duplicate-
origin and production-attempt seams remain owned by `pi-native-port/root` and will be consumed by
the packed smoke without moving authority into packaging.

## 2026-07-16 — two-phase contained-session activation (`pi-native-port/root`)

Production children now persist and authenticate the exact Pi session mapping, report readiness,
and wait. The authority durably records `attempt.sessionFile` and attaches its outcome observer
before issuing an attempt-bound activation control; pause/delete/disconnect before activation exits
without a provider turn. The exact packed smoke consumes a programmatic provider-free probe that
withholds activation only after the real production child has been admitted, then verifies the Pi
JSONL mapping, zero usage, durable interruption, and shutdown. Focused process evidence is
**16/16**. No compiler context, prompt, resource-binding, or compaction source was changed.

> **2026-07-16 admission clarification:** the ready barrier permits Pi-owned local
> credential/model initialization before readiness. It guarantees no provider turn and no token
> spend until the authority sends the attempt-bound activation; it does not guarantee zero
> credential reads, local availability checks, cached-model loading, or Pi-owned credential
> refresh activity during session construction.

### Coordination request to active TypeScript context experiment — 2026-07-16 22:32 MST

The serialized Core build is currently blocked by the context lane's in-progress shared-source
checkpoint. The release lane will not edit these owned semantics. Please finish or explicitly hand
off the following exact compiler errors, record the resulting design/checkpoint in your persona
mailbox, and notify `pi-native-port/root` before another immutable build:

- `authority/run-engine.ts:3426`: dynamic context return spreads a value TypeScript does not know
  is an object;
- `compiler/run-program.ts:950`: exact-optional `nodeId` construction includes `undefined`;
- `compiler/run-program.ts:3602`: missing `canonicalEncode` binding;
- `compiler/run-program.ts:5025`: missing `AttemptStatus` binding;
- `graph/context-selector.ts:323`: legacy contextual records do not carry `recordType`;
- `state/run-record.ts:421`: nullable/unvalidated `executionConfig.agents` access.

Packaging stopped before packing, so no stale tarball was accepted. Runtime/packaging sources are
otherwise frozen for the next gate; the exact packed production-attempt and duplicate-origin tests
are already wired.

**Context-lane follow-up — 22:44 MST:** the earlier seven errors were resolved, but the next
serialized typecheck now reports `test/native-run-program.test.ts:1016` assigning
`string | undefined` to an exact-optional `string` fixture field. The release lane is again leaving
that context-owned test untouched; please close it before the next immutable build and record the
context checkpoint.

## 2026-07-16 — atomic authority startup/reclaim (`pi-native-port/root`)

Authority singleton ownership now uses a complete-directory startup mutex with dead-owner atomic
quarantine. That mutex spans stale lease/socket cleanup, no-replace publication of a complete main
lease, listener bind, and socket permissions. A delayed reclaimer therefore cannot unlink a newer
lease or live listener. Ownership-checked retirement is retryable across partial cleanup, and a
failed startup destroys early clients before relinquishing authority. Strict Core typecheck and the
focused authority plus attempt-process suites pass **24/24**. This changed endpoint/server lifecycle
only; the concurrent context experiment remains untouched.

## 2026-07-16 23:12 MST — composed gate waiting on context freeze (`pi-native-port/root`)

The final parity gate currently has no accepted red semantic result. Root-level Vitest had bypassed
Core's 20-second policy, producing false timeout/cleanup failures; the runner now loads the
checked-in Core config and the exact 209-test target corpus passes **209/209** under that policy.
Subsequent parity attempts overlapped active `run-program.ts` writes and failed closed as
`core_runtime_changed`, so they are moving-source non-results. The release lane has asked
`native-run-program/root` for an explicit frozen fingerprint/handoff and will not alter context,
prompt, resource-binding, or compaction semantics in the meantime. Reviewed parity captures remain
unchanged.

## 2026-07-16 23:12 MST — production legacy-run adoption lane active

`legacy_run_adoption/root` owns the explicit compatibility transaction that turns a supported,
hash-verified Rust-era run archive into current authority-owned `RunRecord` state and safely
resumes it only after quiescence and durable admission. Scope is limited to the adoption
coordinator, minimum CLI/operator/authority protocol wiring, focused provider-free tests, and
append-only migration notes. Unsupported or changed state must retain immutable evidence and
return typed blockers. Compiler context/prompt construction, resource selection/binding,
compaction, live projects, Pi settings/credentials, installed binaries, and running processes are
excluded. Detailed lease: [`agent-collab/legacy-run-adoption.md`](agent-collab/legacy-run-adoption.md).

## 2026-07-16 23:43 MST — production legacy-run adoption complete

`legacy_run_adoption/root` completed the explicit Rust-era run successor path. Read-only preview,
explicit paused admission, and explicit reverified resume are reachable through CLI/operator and
authority RPC. Admission is side-effect-free in Git/provider space and atomically registers a
distinct current `RunRecord`; first resume re-binds the exact source tree/registry, plan bytes,
compatibility bytes, receipt bytes, barrier, and Git pins before launching a fresh epoch-zero Pi
recovery lineage. Supported states are planning/approved/active/paused; terminal, dirty,
ambiguous, changed, incompatible, or rewritten sources return typed blockers and retain evidence.
Strict Core typecheck passes; focused adoption 2/2 and composed operator/launch/adoption 23/23 at
the frozen checkpoint. No context, prompt, resource-binding, compaction, live project, settings,
credentials, installed binary, or running process changed. Full handoff:
[`agent-collab/legacy-run-adoption.md`](agent-collab/legacy-run-adoption.md).

## 2026-07-16 — sealed model-admission P1 follow-up active

`sealed_catalog_p1_fixes/root` owns the three bounded corrections from independent catalog review:
shared pre-`run.create` availability admission for `/koni`, `koni run`, and the dashboard;
per-model reasoning choices derived from Pi 0.80.10's `thinkingLevelMap`; and exact Pi/TypeBox host
authentication before interactive commands or reuse of an existing authority. The lane is
coordinating its temporary `cli.ts`, authority-bootstrap, and operator-test overlap with
`legacy_run_adoption/root` and will not edit those files until that owner freezes them. It excludes
all context-building, run-program, resource-binding, compaction, legacy-adoption semantics, and
live-state mutation. Detailed lease:
[`agent-collab/sealed-model-catalog.md`](agent-collab/sealed-model-catalog.md).

## 2026-07-17 00:06 MST — legacy adoption hardening lane active; defer composed gates

`legacy_adoption_hardening/root` is closing the independent review findings for exact live-registry
reverification, authenticated Git-common run-root containment, inode-stable directory traversal,
and the provider-free operator test seam. It owns only migration/adoption source and focused tests;
compiler context, run-program prompt/context construction, resource binding, and compaction remain
excluded. A separate full gate begun at 00:05 includes the first production verifier edit but
predates its acceptance tests. Treat that run as broad diagnostic evidence only. Other lanes should
not start another composed parity/workspace/package gate until this note is superseded by the
hardening handoff and the context lane has published its own frozen fingerprint.

## 2026-07-16 — sealed model-admission P1s closed

`sealed_catalog_p1_fixes/root` has released its bounded follow-up. Every run-start UI now consumes
one sealed Pi catalog and one pre-`run.create` admission rule; model options carry Pi 0.80.10's
per-model reasoning levels, invalid configured defaults remain visible blockers, and selectors
cannot create a value Pi would clamp. Interactive `/koni` authenticates Pi 0.80.10 + TypeBox
1.1.38 at session start and before work, while authority startup authenticates the same peer before
both launch and existing-authority reuse. Provider-free CLI, interactive, dashboard, and reuse
regressions pass with the focused catalog/control/operator suite **45/45**; strict Core TypeScript
and scoped whitespace checks are green. The lane did not touch the protected context experiment or
legacy-adoption semantics. Full evidence:
[`agent-collab/sealed-model-catalog.md`](agent-collab/sealed-model-catalog.md).

## 2026-07-17 00:12 MST — context and legacy-hardening leases frozen; composed gate unblocked

The graph-native context lane is committed at `c0d3226d0022079e4689330ab5d9d389fbd3e9b8`,
including the final persisted-touched-path selector wiring and regression, and has released
`run-program.ts`, the selector, and focused context tests. The independent legacy-adoption
hardening lane has also published its frozen implementation handoff and released its disjoint
migration/adoption files. The 00:05 composed run crossed active source writes and remains invalid
moving-source evidence; a new serialized composed gate may now use the frozen fingerprints in
[`agent-collab/native-run-program.md`](agent-collab/native-run-program.md) and
[`agent-collab/legacy-adoption-hardening.md`](agent-collab/legacy-adoption-hardening.md).

## 2026-07-17 01:24 MST — context experiment active again; composed gate held

`pi-native-port/root` observed new concurrent writes in `graph/context-selector.ts`, its focused
test, `pi/managed-session.ts`, and the production-session test after the prior context freeze.
Those files are treated as owned and read-only by the release/legacy-adoption lane. The legacy
filesystem containment tests may continue because their source set is disjoint, but no workspace,
parity, build, pack, or release result will be accepted until the context owner records the new
design, evidence, and frozen fingerprints in its mailbox. The release lane is editing only legacy
migration/adoption containment and authentication files and will not reset or normalize coherent
context work it does not recognize.

## 2026-07-17 02:24 MST — current context checkpoint independently verified, still read-only

The four context-owned files have remained unchanged since 01:22 MST. Their current behavior and
fingerprints are recorded append-only in
[`agent-collab/native-run-program.md`](agent-collab/native-run-program.md); the exact focused suites
pass **26/26** without source movement. This does not transfer ownership. The release integrator
will include those exact hashes in the next composed gate and abort that gate on any concurrent
context write.

## 2026-07-17 02:42 MST — Pi runtime release-hardening lane active

The composed gate is held after independent review found three P1s in attempt-process lifecycle,
immutable bootstrap, and two-phase effect admission. `pi-native-port/root` now owns only the
bounded runtime files and focused tests listed in
[`agent-collab/pi-runtime-release-hardening.md`](agent-collab/pi-runtime-release-hardening.md).
The context experiment remains a separate read-only lane; legacy migration/adoption is frozen and
will not be reopened. Other agents should avoid runtime process/bootstrap edits until this lane
publishes fingerprints and an explicit handoff.

## 2026-07-17 03:10 MST — runtime blocker set closed; bounded context overlap declared

The independent acceptance and session-security audits converge on exactly four P1 domains and no
P0s: process-group capability/lifecycle, immutable bootstrap execution, preactivation authority
effects, and prospective Codex token admission. The active runtime lane now owns that closed set.
Its only overlap with the context experiment is the provider-payload budget hook in
`pi/managed-session.ts`, recorded in both collaboration mailboxes before editing; the existing
context-failure propagation and graph ranking behavior are protected. Disjoint process/bootstrap
work may proceed in parallel, but no composed gate or release handoff is valid until all four
contracts and their adversarial tests are green together.

## 2026-07-17 — product lifecycle/operator lane active

`pi_native_product_parity_final/root` owns the missing reachable legacy-project migration,
pending-upstream conflict list/inspect/resolve workflow, and Pi-community inertness correction.
It is limited to a new operator lifecycle module, CLI/extension, shared control-center files,
focused tests, exports, and append-only docs. The moving authority engine remains read-only until
its owner grants a narrow RPC handoff. Context construction, provider/session/runtime machinery,
legacy migration/adoption internals, live projects, installed binaries, and processes are excluded.
Detailed lease and the proposed authority contract:
[`agent-collab/product-lifecycle-operator.md`](agent-collab/product-lifecycle-operator.md).

## 2026-07-17 05:16 MST — product lifecycle/operator source frozen

`pi_native_product_parity_final/root` released its product-source/test lease after strict Core
typecheck, scoped whitespace validation, and focused **56/56** evidence. Exact fingerprints,
inert-Pi warning semantics, explicit migration behavior, legacy `flock(2)` bridge boundary, and
pending-upstream comparison/CAS behavior are recorded in
[`agent-collab/product-lifecycle-operator.md`](agent-collab/product-lifecycle-operator.md). The lane
will not reopen those bytes. It is waiting only for an explicit provider-accounting handoff before
adding the three disjoint `profile.conflicts.*` registrations to `run-engine.ts` plus a focused
authority integration proof.

## 2026-07-17 — Pi-native current-facing documentation released

`pi_native_docs_final/root` completed the documentation-only reconciliation across the root and
package READMEs, current maintainer guides, and public Next.js source. Current sections now present
the three coarse TypeScript/Pi packages, sole Core workflow/effect authority, ordinary Pi
credentials/settings/sessions, explicit `/koni` and `koni tui` surfaces, guarded migration and
upstream comparison, immutable attempt-session lineage, and zero automatic provider retries before
the retained Rust/Codex history. No Core source/test, context/compiler/runtime/provider code,
manifest, credential, live state, process, terminal, or generated `.next` source was edited. Site
lint, typecheck, and production build plus scoped whitespace validation pass. Exact scope,
aggregate documentation hash, and evidence are in
[`agent-collab/pi-native-docs-final.md`](agent-collab/pi-native-docs-final.md).

## 2026-07-17 05:49 MST — process-retirement proof remediation reopened

`pi_runtime_frozen_audit/root` found that a reaper failure or unexpected sentinel exit can resolve a
terminal failed outcome before process-group absence is proven, after which the live pool discards
the only process-bearing handle. The lane is reopened with a bounded lease over only
`pi/attempt-process-supervisor.ts`, `pi/attempt-process-pool.ts`, the minimum process protocol/types
if unavoidable, focused process fixtures/tests, and append-only release-hardening notes. It will
make proven group absence a prerequisite for terminal publication and pool retirement, retain a
retryable cleanup handle after retirement failure, and add stuck-descendant/retry/reuse-safety
coverage. Run-engine, provider accounting, context/compiler files, credentials/settings, live state,
and all product/operator files remain excluded and must retain their frozen fingerprints.

## 2026-07-17 06:19 MST — product authority and lifecycle-race checkpoint accepted

`pi_native_product_parity_final/root` completed the inert installed Pi read tools, sealed
profile-conflict authority/recovery, and the root-assigned pause/delete/quiesce Git-race remediation.
Exact advancement tokens gate scheduler launches, semantic publication, and Git intent prepare;
pre-stop publication intents are exact-CAS compensated or explicitly preserved; final pause/delete
waits for outside-mutation drain/recovery; and cross-build quiesce admits only one async-scoped
internal settlement while rejecting all external/ordinary internal mutations. Focused evidence is
Core typecheck, product/operator **63/63**, authority server **9/9**, and exact quiesce/races **5/5**.
Independent P0/P1 review accepted checkpoint hashes `run-engine.ts` `fa9e4163…` and `server.ts`
`c24663b2…`. A broad authority run crossed coherent process-owner writes and is invalid diagnostic
evidence; the final composed rerun/fingerprint release waits for that owner's stable hash. Context
selection/construction and run-program prompt/resource logic remain protected and untouched. Full
checkpoint: [`agent-collab/product-lifecycle-operator.md`](agent-collab/product-lifecycle-operator.md).

## 2026-07-17 06:44 MST — shared Medium authoring example corrected and frozen

`pi-native-port/root` closed the release audit's disjoint profile-documentation drift without
touching the externally owned context-construction lane or the active process-retirement lane. The
shared `configure-koni` run-type reference in both official profile bundles now models Coding
Medium's shipped Planner/Reviewer `gpt-5.6-sol` + `max`, Lead `gpt-5.6-sol` + `xhigh`, and Worker
`gpt-5.6-terra` + `high` policy. A Coding profile regression parses both the real run type and the
Markdown YAML example and requires exact equality. Independent bundle inventory/materialization is
**5/5** and Coding profile evidence is **4/4**; the frozen shared skill hash is `1c150fab…`, Coding
bundle hash `c83eb529…`, and Research bundle hash `b40f0475…`.

The protected external context checkpoint remains byte-identical (`run-program.ts` `f337ac16…`,
`context-selector.ts` `99494628…`, and focused tests `41f73582…`/`7bd648eb…`). Final composed gates
remain held until `pi_runtime_frozen_audit/root` publishes stable process-retirement hashes and the
read-only release lane accepts them.

## 2026-07-17 07:10 MST — disjoint release surfaces corrected; process proof still active

The root removed the brand gate's obsolete requirement that one public docs page retain the legacy
product name. All current/shipping paths are now covered by the general scan; `check-brand.sh` and
its shell syntax check pass independently. The shipped Core README now accurately describes inert
Koni command/tool/profile registration and names the four read tools without weakening its no-read,
no-auth, no-autostart guarantee. The product lane also hash-bound conflict crash recovery to the
transaction-time full configuration and effective bundle; an unrelated valid config edit can no
longer be mistaken for the crashed transaction's result.

The process lane is not frozen yet. Its admitted and pre-admission cleanup-retention regressions are
green, but the newly assigned pre-owner guardian replacement test is still being debugged and has
timed out in independent reproduction. No composed release result should be accepted until that
exact test and the repeated focused process suite pass without leaked descendants.

## Context-owner coordination request — compiled default run type

The static Pi-native release audit found that the compiled project's `default_run_type` is dropped
from `NativeRunCompilerProgram.controlCatalog()`. Consequently the CLI hard-codes `small` and the
control center selects the first sorted run type, even though both shipped profiles declare Medium
and arbitrary valid profiles need not define Small. The product owner is repairing only the
protocol/controller/CLI consumers. The context/run-program owner is asked to coordinate before its
next save point and add the exact compiled default identifier to the read-only control catalog
projection, with a focused producer assertion. No prompt, resource-selection, dynamic-context, or
compaction semantics should change. Until that handoff is recorded, the protected `run-program.ts`
hash remains `f337ac16…` and the composed release gate stays held.

## 2026-07-17 06:39 MST — generic compiled run-type CLI help refrozen

`pi_native_product_parity_final/root` closed a disjoint release-audit P2 in shell help: `koni run`
now advertises `--type <run-type>` and explains that available choices come from the compiled
project profile/configuration instead of implying only `small|medium|large` are accepted. The full
operator suite is **18/18** and exact fingerprints are recorded in
[`agent-collab/product-lifecycle-operator.md`](agent-collab/product-lifecycle-operator.md). Process,
profile, context, authority, credentials, live state, and terminal surfaces were untouched; the
composed authority gate still waits for the process-retirement freeze.

## 2026-07-17 07:12 MST — profile recovery whole-tree witness independently accepted

A replacement read-only product audit found and then accepted the bounded remediation for one P1:
profile-conflict crash recovery now persists and rechecks both the transaction-time compiled
configuration hash and exact effective authored-bundle hash. Historical records with neither field
remain readable but cannot reconstruct an authority receipt; partial/malformed pairs fail closed.
Tests cover exact recovery, unrelated valid resource drift, historical absence, and partial-pair
rejection. Strict typecheck and the direct conflict suite are green; the authority-backed suite is
held only for the separate process-runtime hash freeze. Context/compiler selection, process runtime,
profile bundles, authority engine, credentials, live state, and terminal surfaces were untouched.
Exact current hashes and evidence are in
[`agent-collab/product-lifecycle-operator.md`](agent-collab/product-lifecycle-operator.md).

## 2026-07-17 07:49 MST — compiled project default reaches New Run and CLI

`pi_native_product_parity_final/root` closed the static-audit P1 where operator surfaces discarded
the compiler-validated `default_run_type`. The shared catalog now carries and validates the exact
default; New Run selects it regardless of display order; and an omitted CLI `--type` resolves from
the same sealed catalog instead of inventing `small`. The one protected native producer field was
explicitly coordinated and both adjacent context suites remained green with unchanged context
fingerprints. Typecheck, control center **30/30**, operator **19/19**, native run program **9/9**,
and context/production **27/27** pass. Exact replacement hashes and the no-overlap statement are in
[`agent-collab/product-lifecycle-operator.md`](agent-collab/product-lifecycle-operator.md). The
separate process-retirement freeze still gates the one final composed authority run.

## 2026-07-17 08:24 MST — process topology candidate freeze ready for composition

`pi_runtime_frozen_audit/root` completed the bounded process-retirement remediation without touching
provider/session/context/product authority. The accepted topology is pre-admission detached
observation-only coordinator → in-group sentinel relay → in-group self-killing guardian. Worker
launch is withheld until coordinator and guardian readiness; ESRCH is the only absence proof;
EPERM never ACKs; failed proof retains a process-bearing pool handle; and exactly one coordinator
replacement plus guardian replacement crash windows are covered. Core typecheck and three
consecutive focused runs are green at **38/38** each, embedded scripts parse, owned diffs are clean,
and no fixture processes remain. Exact hashes and evidence are appended to
[`agent-collab/pi-runtime-release-hardening.md`](agent-collab/pi-runtime-release-hardening.md).

## 2026-07-17 — package-start deadline repair claimed; context experiment remains protected

`pi-native-port/root` is repairing only the crossed default start/stop deadline selection exposed
by the exact-tarball stock-Pi smoke, then rerunning the disposable package and composed release
gates. Direct packaged status proves the preserved daemon, sealed stage, lease, state, and socket
are healthy. The concurrent context-building agent retains exclusive ownership of context
selection, run-program prompt/resource construction, managed-session context, compaction, and
their focused tests; this release lane will preserve and re-verify those coherent bytes without
editing them. Detailed evidence is appended to
[`agent-collab/pi-native-port.md`](agent-collab/pi-native-port.md).

## 2026-07-17 — Pi-native composed gate accepted; isolated real smoke next

The shared tree passed full executable parity, profile, host-boundary, ledger/capture, Core,
package, documentation, audit, static, and leak gates. The stock-Pi tarball proof constructed and
deleted a real provider-free contained Pi session without user credential writes or provider token
usage. `pi-native-port/root` will now install only the verified package and run the established
Medium objective in `/Users/max/Desktop/updog-worktrees/harness-testing`. Main Updog, user
processes, and the externally owned context-building files remain excluded. Exact evidence and
current protected-context hashes are in [`agent-collab/pi-native-port.md`](agent-collab/pi-native-port.md).

## 2026-07-17 — dormant run-type reasoning now fails closed (`pi-native-port/root`)

The first isolated Medium launch stopped before run creation because the legacy-derived Large
preset still carried `ultra`. Koni now normalizes legacy migration values to Pi `max` for both
personas and run-type roles, and configuration compilation rejects `ultra` or any unsupported
reasoning level even when that preset is not selected. The focused migration/configuration suites
and typecheck passed. Only the migrated smoke overlay’s three invalid Large values were normalized;
its legacy `.codex/koni` source and all prior evidence remain retained. Rebuild/reinstall is next
before retrying the Medium launch.

## 2026-07-17 — configuration admission now includes graph runtime semantics (`pi-native-port/root`)

The second preflight caught a retained schema-1 risk status list that omitted its inherited
schema-2 initial `active` state. The migration transformer now restores inherited initial statuses
after a legacy merge, and `config validate` invokes the graph runtime’s semantic validator so this
class of error cannot first surface at run creation. Focused migration/configuration tests and
typecheck pass; no run, session, worktree, or provider request occurred. The smoke overlay received
only the matching `risk.statuses += active` repair; legacy source and evidence remain untouched.

## 2026-07-17 14:27 MST — blocked-run retry boundary closed (`pi-native-port/root`)

The live Medium smoke proved the contained planner cold-start timeout left a valid blocked run but
no operator path could invoke the lifecycle's existing retry transition. `run.resume` and the
control-center play action now retry blocked records from their durable prior phase while retaining
ordinary pause/resume behavior. A planner failure/retry regression proves zero pre-activation token
usage, fresh immutable attempt/session identity, and explicit retry lineage; focused authority and
lifecycle tests pass **18/18**, with Core typecheck green. This lane continues to preserve the exact
run ID and will install only after the shared Vitest workspace is quiet.

## 2026-07-17 14:50 MST — Pi/OpenAI opaque call-id compatibility (`pi-native-port/root`)

The real planner exposed an ordinary OpenAI Responses tool-call id containing `|`; Koni's process
protocol had applied its internal identifier grammar and blocked before tool authority. The call id
now crosses the bridge byte-for-byte under a 1,024-byte printable-ASCII bound, while internal ids
retain their narrower grammar and all artifact paths continue to use hashes. Exact captured-shape,
control-character, and oversize regressions pass in the full process suite (**41/41**); Core
typecheck is green. The failed live attempt settled 3,134 input + 241 output tokens, no tools or Git
effects occurred, and the same run remains recoverable from planning.

## 2026-07-17 15:12 MST — canonical receipt overlap routed to context owner (`pi-native-port/root`)

The live planner crossed Pi tool transport and committed a read-only list receipt, then dynamic
context failed because `run-program.ts` compared the newline-terminated JSON artifact bytes against
the documented canonical parsed-receipt hash/size. Recovery already uses the correct
parse-and-canonicalize contract. Exact evidence and a narrow overlap request are appended to
`agent-collab/native-run-program.md`; that source remains untouched until the active shared verifier
releases the workspace. The request settled 3,127 input + 369 output tokens, no writes or Git effects
occurred, and the original run/target remain preserved.

## 2026-07-17 15:15 MST — canonical receipt overlap refrozen (`pi-native-port/root`)

The context-owner overlap is complete and released: dynamic context now validates the canonical
parsed receipt ledger rather than newline-terminated presentation bytes, matching recovery and the
public authorized-result contract. Native run-program tests pass **9/9**, strict Core typecheck is
green, exact replacement hashes are in `agent-collab/native-run-program.md`, and no selection,
prompt, resource, graph, or compaction-content behavior changed. A composed package gate precedes
retrying the same live Medium run.

## 2026-07-17 15:50 MST — live graph-seed root contract repair (`pi-native-port/root`)

The preserved Medium planner submitted its complete plan but modeled the existing run objective as
an undeclared local edge key. Koni's compiler correctly requires the literal `$root`, yet that
cross-field rule was absent from both the terminal schema descriptions and planner instructions.
The release lane has claimed a narrow prompt/schema/diagnostic repair plus an exact regression in
`run-program.ts`, its focused test, and both shipped planner persona documents. Context selection,
receipt projection, compaction, and graph compilation semantics remain protected; detailed live
evidence and the overlap boundary are in
[`agent-collab/native-run-program.md`](agent-collab/native-run-program.md).

## 2026-07-17 15:54 MST — graph-seed root contract refrozen (`pi-native-port/root`)

The compiler-issued schema, context, and prompt now explicitly bind the existing objective to the
literal `$root`; both profile personas carry the same rule, and bounded diagnostics name invented
endpoints. The live `books-spiced-plan` regression is covered. Native compiler **9/9**, profile
inventory **5/5**, Coding **4/4**, Research **4/4**, strict typecheck, and diff checks pass. Exact
fingerprints and the released overlap are recorded in
[`agent-collab/native-run-program.md`](agent-collab/native-run-program.md).

## 2026-07-17 16:40 MST — terminal graph schema now needs full compiled typing (`pi-native-port/root`)

The same preserved run proved `$root` guidance is necessary but insufficient: Pi's terminal schema
still allowed arbitrary node types/specs/relations, so the planner emitted `implementation_slice`
and was rejected after an expensive synthesis. The native-run-program seam is narrowly reopened to
project the pinned compiler-owned planning operation, graph field definitions, compiler-owned
exclusions, and edge vocabulary into Pi's structured terminal schema and context. No graph/runtime
acceptance rule is changing; this prevents invalid shapes before submission. Exact evidence and
scope are in [`agent-collab/native-run-program.md`](agent-collab/native-run-program.md).

## 2026-07-17 16:45 MST — compiled typed terminal graph contract refrozen (`pi-native-port/root`)

Planning output now uses a configuration-derived Pi schema: only planning-operation node types,
closed agent-authored spec fields, canonical relation names, and the configured node limit can be
generated. The same field and edge triples are present in bounded planner context, while runtime
graph validation remains authoritative. Native **9/9**, tool/provider **17/17**, strict typecheck,
and diff checks pass; exact hashes and the released seam are in
[`agent-collab/native-run-program.md`](agent-collab/native-run-program.md).

## 2026-07-17 — release-plan reset: two UI surfaces and provider-free gates before smoke

Direct operator inspection disproved the earlier “full Pi-native control-center parity” claim.
The current TypeScript surface preserves selected semantics but is not an identical behavioral and
visual port of the mature Rust control center: the frozen Rust TUI has 311 tests, the TypeScript
control-center coverage is much smaller, and the four current TUI parity captures record passing
test names rather than rendered terminal frames or complete interaction traces. That history stays
above, but it no longer authorizes release or a live provider-backed smoke.

The current product contract has two distinct Pi-native surfaces over one authority:

1. `/koni` and explicit `koni tui` open the same full Rust-oracle-equivalent control center.
2. `/koni-run` starts a background run and retains normal Pi chat while a minimal native Pi
   widget/status companion shows progress and surfaces only actionable questions, plan review,
   failures, and merge readiness. It is not an autonomous-agent steering chat.

The provider-free release plan, Gates A–H, parallel ownership waves, guarded Updog preservation,
and final single-smoke procedure are recorded in
[`agent-collab/release-completion-plan.md`](agent-collab/release-completion-plan.md). In addition to
the two UI gaps, release is blocked on compiler enforcement of configured collection/path
constraints and compiler-derived safe scheduling; neither may be deferred to smoke testing. The
preserved Updog run remains blocked with no active attempt and must not be resumed, approved,
deleted, merged, or rewritten until one frozen release candidate passes the provider-free
rehearsal and guarded refresh.

## 2026-07-17 — full completion implementation begins (`primary-integrator/root`)

The user has authorized implementation of the replacement release-completion plan. The existing
dirty `pi-native-port` tree is the shared authoritative baseline and contains coherent work from
earlier lanes; no reset, blanket replacement, or stale-HEAD worktree will be used. Source ownership
is split into three disjoint first-wave leases: compiler/scheduler semantics, full control-center
parity, and the Pi-native companion. `primary-integrator/root` owns cross-lane protocol wiring,
release composition, lifecycle/Git/package closure, and the frozen Updog canary.

The canary remains `/Users/max/Desktop/updog-worktrees/harness-testing`, run
`run-924d787b-6aa6-4738-a8d1-66ad783f8b19`. It is blocked, token-idle, and must not be resumed,
approved, deleted, merged, migrated, or rewritten until all provider-free gates pass against one
packed release candidate. Agents must append their decisions and exact test evidence to their own
mailbox files and ask overlap questions there before editing another lane's owned files.

## 2026-07-17 — Configure crash-gap witness frozen (`config_document_authority/root`)

The standalone configuration authority lease is released again. All five ordinary mutators now
accept the frozen `{ id, requestSha256 }` marker and can recover an exact committed semantic result
after a crash before the outer authority receipt. Recovery settles prepared and
committed-before-cleanup journals under the lifecycle lock, rejects cross-request replay, and
fails closed if configuration advanced. Focused authority/raw tests pass **9/9**, existing
Configure/profile/migration regressions pass **16/16**, and strict Core typecheck is green. Legacy
migration remains governed by its separately archived plan/receipt/lifecycle triple. Exact API,
failure codes, fingerprints, and integration boundary are in
[`agent-collab/config-document-authority.md`](agent-collab/config-document-authority.md). No
run-engine, RPC/server, exports, control-center, live project, provider, process, installed binary,
terminal, or frozen canary was touched.

## 2026-07-17 — full control-center authority consumers complete (`stage_capability_authority/root`)

The full Pi-native control center now consumes the compiler-authored stage catalog and typed action
forms, authenticated attempt lineage, and durable authored-order question batches. Its Configure
surface also consumes the released semantic Config Document RPC: Guided Configure opens an expert
Project Resources tree and source editor plus reviewed New/Rename/Delete, Run Type, and retained-
source Legacy Migration dialogs. The UI never turns copy into authority or receives a configuration
filesystem path; mutations round-trip exact semantic tokens through the revisioned RPC client.
Focused control-center evidence is **69/69** green; the combined stage-contract/control-center
matrix is **81/81**. Final Core typecheck and hashes are recorded in
[`agent-collab/stage-capability-authority.md`](agent-collab/stage-capability-authority.md); the
frozen Updog canary, providers, credentials, processes, installed packages, and terminals were not
touched.

## 2026-07-17 — release-candidate semantic closure (`primary-integrator/root`)

The compiler/runtime boundary now distinguishes ticket-local reviewer attempts from the
assignment-free final independent reviewer even though both use read-only verification
containment. Ticket reviews retain their ticket descriptor, ticket-cycle worktree, persona, and
same-ticket lineage; the run-wide reviewer alone receives the permanent run workspace. A
semantically rejected independent review also carries an explicit durable non-acceptance marker,
so restart/resume cannot skip it merely because the Pi session terminated normally. Its fresh
retry is parented to the exact rejected review and merge readiness still requires the exact
compiler-accepted OID/graph pair.

Crash-safe legacy migration now recovers the exact prior semantic result from its archived
authority witness, bound to the outer request marker and effective configuration identity. The
released full control center consumes all landed stage, question, lineage, and semantic Configure
authority instead of reconstructing permission from display copy. Current provider-free evidence:
native run program **10/10**, run authority **20/20**, config/migration **16/16**, stage/control
center **81/81**, control center **69/69**, and the composed root matrix **112/112**. The tree is
awaiting one independent P0/P1 audit and then a literal source freeze before exact package/install
closure. No provider, credential, global Pi configuration, installed package, live project,
terminal, process, or frozen Updog canary changed during this checkpoint.

## 2026-07-17 — `/koni-run` compact-intake P1 closed (`primary-integrator/root`)

The independent audit's compact-intake blocker is repaired. The Pi-chat New Run surface now has
the same Unicode caret operations and safe paste semantics as the full control center, and its
viewport follows each semantic focus without overwriting that control with an overflow marker.
An exact 42-row trace uses the coding profile's 12-stage/4-role shape, renders every Tab transition,
and proves the explicit Start button is visible before activation. Focused evidence is **7/7**;
strict Core typecheck and scoped diff checks are green. The independent auditor is rechecking this
replacement before source freeze; package/install gates remain held.

## 2026-07-17 — compiler-pinned semantic pipeline (`primary-integrator/root`)

Lifecycle stage selection no longer infers behavior from configured ID spelling. The compiler's
ordered semantic stage projection is now persisted with each new/adopted run, validated before
Git planning, and used for every lifecycle transition. Legacy records without the projection must
rehydrate it from their exact pinned compiler artifact or fail closed. An adversarial
`discover/signoff/build/quality/ship` lifecycle crosses an authority restart and reaches the right
planning, approval, orchestration, checkpoint, and promotion stages; focused lifecycle evidence is
**3/3** and strict Core typecheck passes. The larger config-semantic inventory remains actively
claimed and blocks source freeze.

## 2026-07-17 — semantic profile-overlay upgrade (`release_lifecycle_closure/root`)

The immutable profile baseline archive now serves as the base of a conflict-aware YAML merge for
package upgrades. This evolves the earlier safe-but-file-level overlay behavior: upstream-only map
fields apply, project-only edits/comments/order remain where the YAML AST can preserve them, and
same-field divergence is persisted as exact paths for explicit review. “Use upstream” patches only
those divergent fields into the merged project file; it no longer discards unrelated local values.
Non-YAML or unmergeable documents retain the historical whole-file conflict path. The pure merge
suite is **5/5**, including fail-closed conflict-path budgets/canonicalization, and the synthetic
installer proof passes. Existing run state and compiler-pinned behavior/Git bytes remain outside
the profile transaction. Full pack/install/live gates are still held for literal source freeze.

## 2026-07-17 — schema-1 semantic adapter closure (`release_lifecycle_closure/root`)

Legacy schema-1 profiles now cross the semantic, not merely structural, configuration boundary.
Known old Git and Lead pull-loop defaults map to current compiler authority; compile/Lead/report
selectors and required verification topology come from the authenticated baseline. Project-owned
intake, questions, models, parallelism, prompts, noncolliding reserved Git templates, and arbitrary
planning stages remain intact. A dedicated custom-run-type proof shows only the required checkpoint
is introduced, with no Medium workflow replacement. The final authenticated sibling-ref migration
suite, including prefix-collision and noncolliding custom controls, is **10/10**. Final
identity/package/install/live evidence still waits for literal source freeze.

## 2026-07-17 — configuration behavior + bounded Lead seam (`config_semantic_authority/root`)

Configuration now compiles to hash-bound behavior/action/Git IR and new runs pin the exact selected
slice. The Lead is one read-only qualitative judgment, never a deterministic ticket pull loop.
Provider-free E2E exposed and closed Git's leaf/prefix ref collision: run refs now end in literal
`integration`, with ticket refs under literal sibling `tickets`, and custom collisions fail during
compilation. Focused evidence is **49/49** across config/Git/behavior/manifests plus the native Lead
slice; Core typecheck is green. Current bundles are Coding `sha256:1fe752…afeeb` and Research
`sha256:1bc8bd…26c60`. The lane has explicitly flagged storage layout/exclusions, change-control
state names, and orchestration running/lease/fixpoint fields as accepted-but-unconsumed blockers;
root must wire or reject them before semantic source freeze.

## 2026-07-18 — remaining semantic consumers claimed

`remaining_semantic_consumers/root` owns the bounded audit and closure of profile fields that the
new behavior IR still accepted without an effect boundary: storage backend/layout/exclusions,
Research change-control state aliases, and orchestration running/lease-stale/fixpoint settings.
The lane will wire an exact existing native consumer where one exists; otherwise compilation and
bundled defaults will stop advertising unsupported variation. It owns only the relevant
configuration contract/compiler/default/documentation surfaces and focused provider-free tests.
It does not edit `authority/run-engine.ts`, `state/run-record.ts`, `git/**`, release/package
scripts, providers, installed packages, terminals, live projects, or the frozen Updog canary.
Coordination is append-only in
[`agent-collab/remaining-semantic-consumers.md`](agent-collab/remaining-semantic-consumers.md).

## 2026-07-18 — bounded Lead judgments are authority-owned (`primary-integrator/root`)

The compiled Lead seam is now a real run-authority boundary. New behavior-backed runs create one
read-only, hash-bound orchestration-entry judgment before deterministic ticket admission; an empty
ready projection may create one separately bound compiler-deadlock judgment. `proceed` releases
the scheduler, `blocked` durably blocks, and a still-unchanged projection after deadlock review is
blocked without another model call. Lead never selects tickets, manages parallelism, spawns
workers, mutates graph state, or polls. Its attempt and result are bound to behavior, stage, graph,
run OID, persona, launch/session lineage, and the normal question/terminal authority. Pre-Lead
admitted snapshots retain their historical no-Lead semantics across upgrade. Focused entry,
deadlock, end-to-end, provider-terminal pause/delete, typecheck, and whitespace evidence is
recorded in
[`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md). Aggregate identity
gates remain deferred until the active semantic/profile lanes freeze.

## 2026-07-18 — operation/workflow/check consumer lane audited (`primary-integrator/root`)

The complete configuration inventory exposed a second semantic closure beyond generic actions:
operation contracts and admission flags, optional/source-preserving workflow steps, required
receipts/escalation/stop behavior, and check replay/freshness/retry policy are compiled but not yet
enforced by the Pi-native authority. Their Rust-oracle meanings and adversarial acceptance gates
are recorded in
[`agent-collab/operation-workflow-check-closure.md`](agent-collab/operation-workflow-check-closure.md).
Implementation waits only for the action lane to release the overlapping run-program/authority
ranges; these fields remain release blockers rather than silently advertised configuration.

## 2026-07-18 — hash-bound cockpit consumer + UI parity (`pre_freeze_product_parity/root`)

The Pi-native full control center now has a strict, canonical-hashed cockpit view projector bound
to each run's exact `compiledConfigHash`. Profile-authored source/actions/columns/options materially
control panel titles, ticket projections/tabs, activity limits, and graph presentation. YAML action
names are presentation slots only and are intersected with fresh authority capabilities; missing
legacy names stay visibly disabled. Both Pi and standalone hosts accept the same exact-artifact
resolver interface. Primary integration must now wire that resolver from the immutable compiled
artifact—never current YAML—before release parity can be claimed. Detailed contract and focused
evidence are in
[`agent-collab/pre-freeze-product-parity.md`](agent-collab/pre-freeze-product-parity.md).

The UI lane is now frozen and its source lease is released to primary integration. Focused
provider-free evidence is **109/109**; exact file identities and the remaining authority resolver
handoff are recorded in the lane document. Shared TypeScript/package gates remain root-owned after
the concurrent authority/state edits settle.

## 2026-07-18 — graph/rules semantic lane frozen (`config_semantic_authority/root`)

Node ontology/semantic identity, finite edge predicates, gate templates/status/context facts, and
finite lifecycle catalogs now have executable consumers and provider-free adversarial coverage.
Lifecycle admission rejects unreachable states; both bundled runtime profiles now provide reachable
`ticket` and `run` machines, including an explicit compiler failure transition. The pure catalog and
transition authorizer are frozen for the separately owned durable runtime adapter, which must map
existing statuses/phases rather than add a second state field. Evidence and exact handoffs live in
[`agent-collab/graph-rules-semantic-closure.md`](agent-collab/graph-rules-semantic-closure.md).

## 2026-07-18 — deterministic scheduler/change-control lane (`scheduler_change_control/root`)

The scheduler now accepts an exact pinned execution-semantic authority projection and separates
unresolved proposal/application barriers from leases that actually own execution. `proposed` and
disposition work are never agent-runnable; approval/application/recovery authority fails closed;
single-flight reservations apply both across restart and within one selected batch. Pure,
replay-safe reconcilers derive canonical proposal, approved application/no-op, source release, and
terminal-resolver outcomes without touching providers or durable state. Root retains the explicit
same-CAS run-engine/persistence integration handoff. Scope, transition design, focused evidence,
and API details are append-only in
[`agent-collab/scheduler-change-control.md`](agent-collab/scheduler-change-control.md).

## 2026-07-18 — compiler execution semantics bound end to end (`run_program_semantic_binding/root`)

`NativeRunCompilerProgram` now consumes operation/workflow/check, finite lifecycle, cockpit, and
gate-policy semantics only from each run's exact pinned configuration. Tickets and steps carry
immutable execution-policy bindings; prompts/grants bind the same policy and scoped gate context;
graph deltas enforce typed operation mutation rules; every configured check and command leaf
carries exact effect, receipt, replay, retry, and gate-context policy. Causal ticket checks remain
execute-all. Composed terminal verification has a distinct replay-only compiler projection and
compiler acceptance path that rejects missing, extra, stale, or reused retained receipts. Exact
source-preservation member pairs are projected for runtime manifest enforcement. Focused compiler
and execution-policy evidence is **20/20** and Core typecheck passes. The compiler source lease is
released; runtime integration owns consumption of these APIs. Exact contracts and hashes are in
[`agent-collab/run-program-semantic-binding.md`](agent-collab/run-program-semantic-binding.md).

## 2026-07-18 — same-CAS configured lifecycle + explicit inert-machine retirement (`primary-integrator/root`)

Every semantic run and ticket transition is now re-authorized by the exact lifecycle catalog
pinned into that run inside `ProjectAuthorityStore.commit`, not merely at an upstream callsite.
New tickets enter from configured `todo`, durable ticket deletion fails closed, compiler
transitions use the canonical compiler actor, and non-compiler transitions carry an explicit
per-ticket actor in the one-CAS write envelope. This preserves Coding's Lead-only proposal
approval and Research's compiler-owned approval without inferring authority from UI text.
Focused lifecycle/store evidence is **10/10**.

The audit also found two Research state machines with no declared owner. Rather than hard-code
meaning from the IDs `gate` and `research`, the current profile retires those entries through an
authenticated migration. The retirement DSL now supports exact selector-addressed array-item
removal while preserving neighboring project YAML/comments/order; ticket/run machines remain
fully consumed, gate policies remain check/compiler policy, and `research_status` remains a
derived program-state projection. Focused retirement/lifecycle/graph evidence is **18/18**.
Profile manifests/provenance and the frozen Updog canary remain held until change-control and
terminal-policy source freeze.

## 2026-07-18 — execution-policy runtime + terminal closure (`execution_policy_runtime/root`)

Behavior-backed configured checks now carry and persist exact top/leaf execution policy, prepare
each process attempt durably, apply only the pinned retry/backoff decision, and bind the complete
retry audit into final compiler input. Semantic composite checks capture compiler-identical member
source manifests. Terminal acceptance has a distinct replay-only path: only current/read-only/
opted-in leaves run, excluded causal leaves require exact retained receipts, current/historical
receipt requirements are evaluated from the pinned catalog, and `preserve_source_paths_from` bytes
are compared inside the acceptance CAS. New assignments commit a self-hashed semantic terminal
record; pre-policy assignments commit an explicit legacy record. Change-control provenance fields
shared with the central CAS lane are stable. Detailed invariants and evidence live in
[`agent-collab/terminal-policy-runtime.md`](agent-collab/terminal-policy-runtime.md).
> 2026-07-17 primary-integrator: durable change-control Git supersession is implemented and tested
> in `packages/core/src/git/lifecycle.ts`. The active runtime agent should call
> `supersedeTicketCycle(...)` before clearing/restarting a held source ticket. Archive refs persist
> as audit evidence; no metadata-only worktree reset is permitted. Focused evidence: 37/37
> `isolated-git-lifecycle` tests, including every supersession effect boundary and dirty recovery.

## 2026-07-18 — change-control operator surfaces frozen (`change_control_operator_surface/root`)

Full control center, compact Pi companion, and native Pi proposal tools now share one bounded
authority projection and one exact decision contract. Enter alone never decides; Pi confirmation
is mandatory; cancellation and revision conflicts do not replay mutations; clients never author
the actor. Final focused evidence is **84/84**, Core typecheck/build pass, and the source lease is
released. Exact contracts, files, and the two unrelated aggregate blockers found during a broader
test run are recorded in
[`agent-collab/change-control-operator-surface.md`](agent-collab/change-control-operator-surface.md).

## 2026-07-18 — typed Research change-control compiler handoff (`run_program_semantic_binding/root`)

The compiler lane now emits two disjoint, canonical assignment transaction variants:
`upstream_request` (source ticket/step/policy/output plus deterministic publication) and
`proposal_application` (exact configured application/disposition and scope). It purely projects
complete pinned-workflow proposal/application/resolver tickets; proposal work is read-only over its
control nodes with no graph/file mutation, no-op creates no ticket, and resolver recursion is
suppressed. Runtime owns same-CAS publication/source hold, durable proposal selection/review, source
release, and Git supersession. Exact contract and **23/23** focused evidence are appended in
[`agent-collab/run-program-semantic-binding.md`](agent-collab/run-program-semantic-binding.md).

## 2026-07-18 — primary integration holds source freeze for runtime + legacy compatibility

The typed compiler (**23/23**) and proposal operator surfaces (**84/84**) are frozen and released.
`execution_policy_runtime/root` is completing the same-CAS change-control transaction in
`run-engine.ts`; `change_control_redteam/root` is independently checking all terminal paths,
review/application publication, source supersession, resolver recovery, replay, and deletion.

The shared fixture sweep also found nine failures in `legacy-run-git-migration.test.ts`: migrated
live/preserved records currently carry a checkout projection rejected by the canonical Git
namespace validator. `legacy_git_namespace_fix/root` owns only that compatibility repair and may
not weaken the validator. Profile manifests/provenance, packed installation, providers, credentials,
terminals, live projects, and the frozen Updog canary remain held until both lanes are green.

> Transition note: the legacy namespace lane is now fixed and released. Canonical lifecycle state
> always names the managed `integration` worktree, flat source paths remain only in authenticated
> migration evidence, terminal-live checkouts are relocated or explicitly preserved, and the
> focused suite passes **17/17**. Runtime change control and profile publication remain the active
> freeze gates.
# 2026-07-18 — Official profile release publication claimed

`pi-native-port/profile_release_publication` owns only the Coding/Research profile packages,
their authenticated in-place publication script and independent bundle test, package-lock
profile versions, focused profile install/migration/semantic-retirement tests, and append-only
coordination notes. It is publishing Coding `0.8.0` and Research `1.1.0` from the reviewed
working-tree baselines, with exact prior-bundle retirement authorization. It will not edit
runtime/compiler/authority/control surfaces, providers, credentials, installed Pi state,
terminals, live projects, or the frozen Updog canary. Mailbox:
[`agent-collab/profile-release-publication.md`](agent-collab/profile-release-publication.md).

> **Publication closure — 2026-07-18:** Coding `0.8.0` and Research `1.1.0` are
> published with exact-prior-bundle `retire-inert-semantics-v1` authorization.
> In-place capture is byte-deterministic; exact upgrades, overlays/conflicts,
> target-only additions, wrong-source/tamper/replay rejection, and the two
> canonical-hash-only schema-1 stock adapters are green. Final evidence is
> bundle/oracle **5/5**, aggregate profile **85/85**, schema-1 migration **13/13**,
> both profile typechecks, and Core typecheck/build. The lane is released; exact
> identities and compatibility boundaries remain recorded in
> [`agent-collab/profile-release-publication.md`](agent-collab/profile-release-publication.md).

## 2026-07-18 — composed change-control authority rehearsal claimed (`primary-integrator/root`)

The primary integrator owns one new, disjoint provider-free composed test file for the complete
change-control transaction after `execution_policy_runtime/root` stabilizes its APIs. The test
must drive the real authority/store/compiler/Git boundary through request publication and source
hold, authenticated approval or rejection, approval-bound proposal context, reviewed no-op or
application materialization, ticket publication, Git supersession, source reissue, terminal
resolver creation/release/repeat failure, explicit failed-resolver retry, restart/replay, pause,
and deletion with zero post-delete sessions. Existing runtime-focused test files remain owned by
the runtime lane. This claim changes no provider, credential, installed Pi state, terminal, live
project, or frozen Updog canary.

## 2026-07-18 — resolver-retry operator handoff consumed (`primary-integrator/root`)

The full control center now routes blocked-run pause/resume activation to the exact compiler-owned
`retry_terminal_resolver` form and refuses generic resume when a fresh capability catalog exposes
no legal retry. The compact Pi companion keeps its deliberately closed decision client: Enter on
a blocked/failed/merge-ready row with no inline question, plan, or proposal opens the full shared
control center instead of duplicating recovery policy. Focused provider-free traces are **51/51**
and **7/7**. Runtime still owns retry settlement, durable binding, pause/delete ordering, and the
focused fault matrix; root owns the disjoint composed authority rehearsal after that API freezes.

## 2026-07-18 — composed authority integration file lease (`change-control-composed-test/root`)

Transition note to the earlier generic rehearsal claim: the exact provider-free file is
`packages/core/test/change-control-authority-integration.test.ts`, owned exclusively by
`change-control-composed-test/root`; its mailbox is
[`agent-collab/change-control-authority-integration.md`](agent-collab/change-control-authority-integration.md).
This lane may append coordination notes, but will not edit production source or any of the runtime
owner's five focused test files. It is waiting for coherent runtime APIs while assembling the real
Research profile + authority/store/compiler/Git + scripted-Pi rehearsal and its negative durable
record matrix. It will not touch providers, credentials, installed Pi state, terminals, live
projects, or the frozen Updog canary.

## 2026-07-18 — primary integration release-evidence boundary

`primary-integrator/root` owns the post-freeze parity/package composition. It will publish a
distinct canonical target capture for every ledger case, add explicit cases for the newly shipped
semantic authority and both Pi UI surfaces, and run the exact packed three-package closure in a
disposable Pi home. This work starts only after runtime, composed-change-control, and red-team
lanes declare one coherent schema checkpoint; it will not edit their owned production/test files
or touch providers, credentials, installed Pi state, terminals, live projects, or the frozen
Updog canary.

## 2026-07-18 — durable change-control store adversaries claimed (`change-control-store-negatives/root`)

This lane owns only the new
`packages/core/test/change-control-store-authority.test.ts`, its mailbox, and append-only
coordination notes. It will exercise raw-load and `ProjectAuthorityStore.commit` attacks against
the frozen CC-1 through CC-3 authority contracts, using canonical helpers and recomputed attacker
self-hashes. It will not edit production source or existing tests, and will report exposed gaps to
the runtime owner and primary integrator. Providers, credentials, installed Pi state, terminals,
live projects, and the frozen Updog canary remain untouched. Mailbox:
[`agent-collab/change-control-store-authority.md`](agent-collab/change-control-store-authority.md).

> **Adversarial checkpoint — 2026-07-18:** v2 proposal decisions are green **7/7**. The exact
> live-to-archive+artifact positive CAS is green, while eleven CC-3 substitutions/insertion/segment
> attacks remain strict failing tests. CC-2 rejects all live identity/plan/settlement/policy/output
> and semantic substitutions except a detached action ID; raw load also accepts index/archive
> disagreement and archived-success-as-failure. Aggregate evidence is **17 pass / 14 intentional
> fail**, Core typecheck green. Exact predicates are in the lane mailbox and have been handed to
> the primary integrator/control-ticket owner; production source was not edited here.

> **Store-adversary slot released — 2026-07-18:** the disjoint suite is checkpointed at **17 pass /
> 14 strict fail** against the last coherent source snapshot. Eleven exact CC-3 archive/segment
> predicates and three CC-2 non-evictable-proof predicates remain production blockers. CC-1 will
> be appended only after the canonical projector owner publishes the real same-CAS causal recipe;
> no synthetic interim authority was frozen into tests. See the mailbox for the enumerated list.

## 2026-07-18 — canonical control-ticket authority claimed (`control-ticket-authority/root`)

This lane owns the shared compiler-authored immutable ticket-authority mechanism for proposal,
approved application, and terminal resolver tickets, closing frozen CC-1 and the control-ticket
portions of CC-2/CC-5. Its production lease is limited to `state/change-control.ts`, the
control-ticket projection/validation regions of `state/run-record.ts`, and matching projection
helpers in `compiler/run-program.ts` and `authority/run-engine.ts`; it may repair only the released
focused compiler/scheduler fixtures. The disjoint store/composed test files remain exclusively
owned by their existing lanes. Mailbox:
[`agent-collab/control-ticket-authority.md`](agent-collab/control-ticket-authority.md).

> Transition note (primary integrator, 2026-07-18): corrected configured-validation pause/delete
> fixtures now reach their claimed final-assignment boundary and expose a real CC-4 deadlock:
> terminal stop settlement waits on the same in-flight action promise it must abandon. The
> proposal fixture is green after explicit source publication and mutation-lane synchronization.
> Do not weaken the two stop-race assertions or release the action before the lifecycle label; a
> dedicated lifecycle/settlement lane must close this gap.

## 2026-07-18 — lifecycle settlement races claimed (`primary-integrator/root`)

Primary integration owns only pause/delete ordering and stopped-action settlement helpers in
`authority/run-engine.ts`, with the corresponding focused cases in
`run-authority-engine.test.ts`. It will not edit archive/compaction or canonical control-ticket
regions. Closure requires the stop tombstone to win independently of blocked in-process action
promises, one typed terminal disposition for every admitted boundary, exact attempt/ticket
rollback, and no restart/provider resurrection.

## 2026-07-18 — archive transaction authority lane

`archive-transaction-authority/root` owns the narrow CC-3 implementation: exact live-action to
archive-row+artifact CAS validation, exact prefix-to-segment compaction, immutable archive history,
raw artifact validation, and terminal-proof retention through compaction/restart. Control-ticket
projection and lifecycle-stop logic remain owned by their existing lanes. See
`docs/agent-collab/archive-transaction-authority.md` for the frozen predicates and evidence.

Transition note: that lane is now complete. All original CC-3 and durable-proof strict failures are
green, with a 1,025-action restart/unrelated-mutation rehearsal. New rows/segments use deterministic
v2 projection; v1 is an explicit artifact-bound read-only compatibility path and cannot be newly
emitted. The exact commands, counts, compatibility consequences, and snapshot fingerprints are in
the lane document. Broad moving-source gates remain with the primary integrator.

> Transition note (2026-07-18): the lifecycle settlement race lease moved from
> `primary-integrator/root` to `lifecycle_settlement_races/root` so source stabilization and the
> provider-free CC-4 matrix can proceed in parallel. Scope and frozen predicates are recorded in
> [`agent-collab/lifecycle-settlement-races.md`](agent-collab/lifecycle-settlement-races.md).

> **Lifecycle/Git settlement closure — 2026-07-18:** the dedicated lane closed all six configured
> action stop races with exact typed abandonment, boundary-specific rollback, recovery parent/child
> settlement, restart-safe fresh approval compilation, and no late blocker/provider/effect
> resurrection. Approval now follows the Rust oracle: journaled permanent run materialization
> settles before configured plan compilation, with crash-forward restart and pause-during-Git
> coverage. The obsolete proposal RPC fixture now uses the full canonical compiler-control
> authority chain rather than a compatibility bypass. Evidence is **11/11** focused, **35/35** for
> the complete engine file, and a green strict Core typecheck. Exact predicates and compatibility
> notes are in [`agent-collab/lifecycle-settlement-races.md`](agent-collab/lifecycle-settlement-races.md).

> **Canonical control-ticket authority complete — 2026-07-18:** the proposal, approved-
> application, and terminal-resolver roles now use one compiler-authored immutable envelope with
> complete operation/workflow/definition/ticket projections and role-specific causal preimages.
> Raw load and the CAS mutation boundary both reject all 24 frozen substitution families for all
> three roles; exact same-CAS creation and JSON-restart/lifecycle positives are also covered.
> Evidence is **150/150** in the dedicated matrix and **174/174** with native compiler and
> scheduler suites; Core typecheck and owned-file diff checks are green. No weak legacy promotion
> exists. One old synthetic engine-test proposal must be rebuilt with the published canonical
> recipe, and the composed shipped-profile rehearsal remains independently blocked before the
> projector by worktree materialization. Exact regions and handoff details are in
> [`agent-collab/control-ticket-authority.md`](agent-collab/control-ticket-authority.md).

## 2026-07-18 — primary provider-free product checkpoint

Primary integration reran the Pi session/attempt/lineage/transcript/compaction boundary against the
moving-but-coherent source tree: **172/172** tests passed across ten focused files. A separate full
control-center/compact-monitor/operator sweep passed **129/134**. Three failures were stale operator
fixtures that omitted newly required compiled launch defaults; those fixtures are now current and
`operator-surface.test.ts` is **20/20**. The remaining two failures are deliberately held strong:
their UI proposal fixture is rejected by the production run-record reader because it predates the
canonical compiler control-ticket envelope. Primary integration will replace it with an exact
proposal fixture rather than bypassing record validation. No provider, credential, installed Pi
state, terminal, live project, or frozen Updog state was touched.

> **Composed Research transition note — 2026-07-18:** the Git-first approval correction now passes
> the strict shipped-profile boundary, including `planning=retired` and permanent `run=ready` at
> successful rule evaluation. The provider-free adapter now invokes the real Rust-backed terminal
> tool rather than simulating its receipt. Its next exact failure is a zero-check terminal-policy
> predicate: the launch correctly has no `configuredChecks`, the compiler correctly projects empty
> validation/replay arrays, but runtime safety rejects `undefined` grant plus empty projection as
> out of scope. Strong request/hold assertions remain unchanged; details are in
> [`agent-collab/change-control-authority-integration.md`](agent-collab/change-control-authority-integration.md).

> **Canonical control-ticket fixture closure — 2026-07-18:** all three positive compiler-control
> roles now derive terminal proof authority from real pinned action plans, journals, semantic
> results, and typed settlements. The complete authority matrix is **150/150**, strict Core
> typecheck is green, and no negative predicate changed. The remaining six durable-store reds are
> an independently owned production archive-awareness issue: terminal acceptance validation scans
> only live action records after the exact action moves to an authenticated row/segment. Full
> evidence and ownership are in
> [`agent-collab/lifecycle-settlement-races.md`](agent-collab/lifecycle-settlement-races.md).

> **Composed Research receipt-ordering note — 2026-07-18:** after the zero-check correction, the
> real terminal path advances to intrinsic receipt closure and fails before action admission:
> structured output is recognized, but `context-pack` and `scoped-compile` are required before the
> current code has admitted the configured `compile-ticket` action (or run direct assignment
> compilation). No assignment-validation journal exists at failure. The terminal-policy owner is
> comparing producer/settlement order against the Rust oracle; the composed suite remains strong
> and provider-free.

> **Primary provider-free closure update — 2026-07-18:** the earlier **129/134** product checkpoint
> is historical. The UI proposal fixtures now use the exact compiler-authored control-ticket
> recipe and the complete full-control-center/compact-monitor/operator matrix is **134/134**. The
> two stale terminal-policy proposal fixtures were migrated to that same recipe and are **4/4**.
> Archive retry authority is now **184/184**: authenticated v2 rows and v2 segments may authorize
> an exact resolver retry after restart, while artifact-bound v1 rows and v1 segments remain
> strictly read-only. The canonical control-ticket matrix is **150/150**, the complete authority
> engine is **35/35**, and strict Core typecheck is green. These were provider-free checks only;
> installed Pi, credentials, terminals, live projects, and the frozen Updog canary were untouched.
## 2026-07-18 — composed Research configured-state handoff

`change_control_composed_test/root` proved that shipped Research selects `compile-ticket` for
`drill-hypothesis/drill-claims`, with allowed semantic states `[in_progress, integrating]`. The
TypeScript scheduler's raw `running` state is canonically `in_progress` through the pinned ticket
lifecycle, matching the Rust oracle. Both action admission and execution-time currentness must use
that same projection: raw admission rejects the catalog, while semantic admission followed by raw
revalidation blocks with `action ticket state changed after admission`. Do not widen the profile or
pre-transition the ticket. The terminal/action lane owns the coherent correction; the five-scenario
composed suite remains strict and is held at the first durable failure until its rerun handoff.

> **Composed Research configured-review ordering note — 2026-07-18:** the real rejection/reissue
> scenario now completes and records the configured proposal risk review, but the configured
> validation settlement integrates/ticks while the exact review attempt is still
> `terminal_accepted`; only its caller subsequently finalizes that attempt. Proposal
> materialization sees the incoherent intermediate state, hard-blocks with `no exact accepted
> configured review`, and prevents the later finalizer from advancing. Downstream advancement must
> not observe a settled-success action before coherent attempt/proof completion. Exact evidence is
> in [`agent-collab/change-control-authority-integration.md`](agent-collab/change-control-authority-integration.md).

> **Terminal/action ordering correction — 2026-07-18:** terminal admission, compiler action
> execution, semantic receipt closure, provider-attempt closure, and downstream advancement are now
> distinct ordered boundaries. Direct and configured receipts are compiler-authenticated and bound
> to exact launch/output/result bytes; settlement and terminal-tool callbacks cannot schedule or
> publish before the exact Pi attempt finalizes. Pause/delete abandon the exact action with no proof,
> and resume preserves that pair as non-current audit history. Focused evidence is **1/1** direct
> receipt, **3/3** pause/delete/restart, **18/18** action/policy/runtime, strict typecheck, and scoped
> diff check. The composed pause/resume case is **1/1**. One release gate remains: raw file-journal
> readers can transiently see run state before a later hash-bound artifact destination; primary owns
> the authoritative read-isolation/state-publication-last audit. Full predicates and commands are in
> [`agent-collab/terminal-zero-check.md`](agent-collab/terminal-zero-check.md).

> **Composed Research proposal-binding note — 2026-07-18:** finalization-only advancement closes
> the prior configured-review visibility race. The next strict boundary is one selection-preimage
> mismatch: proposal terminal proof and review authority hashes are exact, but the selection
> compiler hashes the proposal step binding while materialization and the durable invariant use the
> immutable proposal ticket binding. The invariant remains strong; the compiler must use one
> unambiguous schema meaning (or explicitly bind both). Exact three-hash evidence is in
> [`agent-collab/change-control-authority-integration.md`](agent-collab/change-control-authority-integration.md).

> **Composed Research resolver-proof ordering note — 2026-07-18:** the provider-free resolver
> scenario proves exact failure settlement, operator retry, immutable Git supersession archive,
> crash/restart reissue, chain suppression, and completion of the fresh resolver's full workflow.
> Publication then rejects the resolver because its terminal success proof was not attached: final
> assignment settlement projects the ticket from `completed` to `review` before a later proof
> branch checks for `status === completed`. Proof attachment must use the pre-publication terminal
> disposition in the same CAS; the completed-resolver invariant remains strict. Details are in
> [`agent-collab/change-control-authority-integration.md`](agent-collab/change-control-authority-integration.md).

> **Composed resolver archive oracle correction — 2026-07-18:** immediate action-row archival on
> retry is not a product contract. The failed resolver Git cycle must be archived under the exact
> retry hash; its semantic failure authority may remain in the live settled action map until normal
> retention moves it to an authenticated v2 row/segment. The composed test now requires exactly
> one live-or-v2 authority home plus the indexed failure proof and exact Git supersession. The
> separate 184-test archive matrix remains responsible for v2 compaction parity. Historical
> over-specific wording remains above with this append-only correction.

> **Composed assignment-settlement single-flight note — 2026-07-18:** after the proposal-binding
> fix, rejection/no-op/application materialization proceeds through the application's final review.
> That review stalls with a terminal-accepted attempt and completed semantic journal but no action
> settlement/terminal policy. Terminal-tool background settlement and provider-outcome finalization
> call the same settlement concurrently; only action-plan execution is currently single-flight.
> Full terminal-policy preparation through final CAS needs one promise per invocation, while
> provider finalization remains the sole downstream advancement owner. Exact state is documented in
> [`agent-collab/change-control-authority-integration.md`](agent-collab/change-control-authority-integration.md).

> **Composed Research focused closure — 2026-07-18:** full-settlement single-flight and the narrow
> compiler/proof corrections close both long paths. Rejection/no-op/application is **1/1 in
> 47.46s** through application-cycle integration/retirement, source reissue, forgery negatives, and
> clean pause. Resolver failure/retry/Git-archive/fault/restart is **1/1 in 18.02s** through exact
> live-or-v2 failure authority, terminal success proof, source release, chain suppression, forgery
> rejection, and clean pause. All five cases have focused green evidence; aggregate 5/5 is held for
> the archive-aware validator's coherent source handoff.

> **Legacy archive evidence correction — 2026-07-18:** the earlier **184/184** archive statement
> remains a valid checkpoint for current v2 rows/segments and v1-labelled projections that already
> carried the newer terminal-authority field. It did not yet prove a genuinely historical v1
> run-record projection in which that field is absent. Source freeze and the aggregate five-case
> rehearsal therefore remain held while the terminal/archive lane adds an authenticated open-time
> journal migration, genuine field-absent row and segment fixtures, and a bounded-history timing
> check. Historical v1 artifacts stay immutable/read-only; only the authenticated run projection
> may be upgraded before ordinary reads or mutations become available.

> **CC-5 application publication authority finding — 2026-07-18:** a provider-free store adversary
> now proves that raw authority accepts a completed canonical approved-application and released
> source while the application's owned Git cycle is still active/unpublished. The test is isolated
> at `change-control-store-authority.test.ts:222-258` and intentionally red pending the narrow
> ticket↔Git invariant. Normal runtime ordering is already publish → retire → complete/release; the
> raw/store boundary must independently require exact integrated publication plus retirement and
> reject supersession as completion evidence. The terminal/archive owner still leases the shared
> validator/test region; no production fix starts before explicit release.

> **CC-5 application publication closure — 2026-07-18:** after the archive lease released, the
> source-release predicate was bound to the application's exact current Git cycle. That cycle must
> be integrated and retired with no supersession identity; prior cycles for the same application
> are permitted only as canonical superseded/unintegrated audit history, preserving resolver-driven
> reissue. Exact/no-change/prior-superseded positives and six raw/store attack families are green
> **18/18**; the complete shared store suite is **206/206**, and Core typecheck is green. This
> supersedes the immediately preceding open-finding status without deleting its historical reason.

> **Terminal/action/archive final handoff — 2026-07-18:** the archive lease is released. New v2
> rows and segments carry exact self-hashed terminal-authority projections; terminal attempts and
> indexed proofs resolve to one live or authenticated archived action. Genuine field-absent v1
> rows/segments are authenticated and projected once at open time, advancing project authority but
> preserving semantic run revision and immutable artifact bytes; the second reopen is idempotent,
> and v1 remains read-only for new retries. Full assignment settlement is invocation-single-flight,
> downstream advancement remains provider-finalizer-only, and reviewed terminal resolvers publish
> their exact success proof in their completion CAS. Evidence: Core typecheck green; focused receipt/
> single-flight **2/2**; genuine-v1 row/segment **2/2**; 1,025-action performance **1/1 in 17.96s**;
> full shared store matrix **188/189 in 46.47s**, with only the intentionally red CC-5 adversary.
> `lifecycle_settlement_races/root` now owns that independent ticket↔Git-cycle invariant without an
> archive-file coordination hold. Full predicates and commands are in
> [`agent-collab/terminal-zero-check.md`](agent-collab/terminal-zero-check.md).

> **Archive inventory closure — 2026-07-18:** guarded store reads now require exact canonical disk
> inventories for archive rows and segments and reconstruct canonical retention order from the
> authenticated actions, closing predecessor-free row/segment deletion and reordering. Genuine-v1
> migration remains one-time, idempotent, and read-only. Evidence is **4/4** focused structural,
> **1/1** heavy v1/retry, **283/283** full store, **9/9** project store, with Core typecheck and diff
> checks green. Both source/test leases are released; details are in
> [`agent-collab/lifecycle-settlement-races.md`](agent-collab/lifecycle-settlement-races.md).

> **Composed Research coherent aggregate closure — 2026-07-18:** after the independent
> project-store serializer lease fix landed, the corrected rejection/no-op/application target is
> **1/1 in 59.16s** and the complete change-control authority integration matrix is **5/5 in
> 102.71s**. Core typecheck and scoped diff check are green. The composed fix remains test-only:
> 200ms observation, a 30-second idle watchdog reset solely by durable run-revision progress, a
> 90-second hard cap, and a 180-second test ceiling. No production settlement or authority
> predicate changed; the detached-child serializer defect and repair remain an independent store
> contract. Full evidence is in
> [`agent-collab/change-control-authority-integration.md`](agent-collab/change-control-authority-integration.md).

## 2026-07-18 — Pi-native acceptance audit holds release smoke (`pi_native_acceptance_audit/root`)

The requested product shape is materially implemented: shared full `/koni`/standalone control
center, passive `/koni-run`/`/koni-runs` companion, ordinary Pi credentials/setup preservation,
three-package/profile flow, and explicit-only `koni tui`. Provider-free Gate 3 is **285/285** with
Core typecheck/diff green, and profile bundles are **5/5**. Source freeze is nevertheless held on
two active bounded-history defects: pre-anchor/v1 full authentication still retains unbounded
global identity/action state, and selected retry authority rereads a shared segment per invocation
without a request-wide unique-byte preflight. The package README also mislabels the registered
proposal inspect/confirmed-decision tools as an all-read-only five-tool surface. After those close,
parity remains development **24 passing/6 specified**, followed by one frozen aggregate,
publication, exact-tarball stock-Pi/PTY/removal rehearsal, and independent effect/visual reviews.
Exact evidence and sequencing are in
[`agent-collab/pi-native-acceptance-audit.md`](agent-collab/pi-native-acceptance-audit.md).

## 2026-07-18 — provider-free package/UI smoke closure active (`/root/package_ui_smoke_closure`)

The primary integration package lane delegated a bounded evidence-only closure over
`scripts/pi-package-smoke.test.mjs`, the inaccurate tool paragraph in `packages/core/README.md`,
[`agent-collab/package-ui-smoke-closure.md`](agent-collab/package-ui-smoke-closure.md), and this
append-only registry transition. The rehearsal will use only an owned temporary HOME and Pi agent
directory, exact local archives, Pi's supported programmatic extension runner, and an in-memory
terminal. Authority/storage source, profile source, parity publication, providers, user Pi state,
credentials, terminals/panes, live projects, and Updog remain excluded.

> **Package/UI smoke lease released — 2026-07-18:** the smoke now requires three distinct archive
> digests, resolves all three installed commands through Pi's supported extension runner with the
> exact authenticated stock-Pi root, exercises the packed standalone CLI branch through an
> in-memory 82-by-20 terminal, and removes the three exact sources while restoring unrelated Pi
> settings, credentials, prompts, package/extension/skill bytes, and permissions exactly. Focused
> UI evidence is **91/91** and a fresh exact-three-archive install/remove probe is green. The README
> now correctly separates five read-only status/context/transcript tools, proposal inspection, and
> the one confirmed proposal-decision mutator. Two moving-tree aggregate runs found and fixed a
> stale transcript assertion and a missing explicit Pi-root handoff; neither failed aggregate is
> claimed as release evidence, and primary integration requested no third repeat before freeze.
> `/koni-run` still cancels before **Start** in this harness, and standalone uses an in-memory
> terminal, so the final frozen-tree populated-handler and real-PTY exact-tarball rehearsal remains.
> No provider, real terminal/pane, user Pi state, credential, live project, or Updog state was
> touched. Exact evidence is in
> [`agent-collab/package-ui-smoke-closure.md`](agent-collab/package-ui-smoke-closure.md); all leases
> are released.

## 2026-07-18 — provider-free populated UI parity audit claimed (`populated_ui_parity/root`)

This bounded pre-freeze lane owns only `packages/core/src/control-center/**`,
`packages/core/src/monitor/**`, tightly related operator display adapters, focused UI
tests/fixtures, and append-only coordination notes. It will render the exact shared
`ControlCenterComponent` used by `/koni` and `koni tui` from one deterministic fully populated
authority fixture at 82x20, ordinary, and roomy dimensions; exercise the compact Pi companion;
compare semantic glyph/style/region and interaction traces against the accumulated Rust-TUI
requirements; and fix definite UI-source gaps without redesigning authority. It excludes
authority/storage, compiler/profile/parity publication, package smoke, credentials/user Pi,
providers/network, terminals/panes, live projects, and the frozen Updog canary. Mailbox:
[`agent-collab/populated-ui-parity.md`](agent-collab/populated-ui-parity.md).

> **Populated UI parity lease released — 2026-07-18:** the exact shared
> `ControlCenterComponent` now has one deterministic fully populated glyph/style/region oracle at
> **82x20**, **122x40**, and **180x52**. It caught and repaired complete narrow-footer selection,
> compact Activity duration naming, inaccurate Questions help, and an ANSI reset that made the
> inactive Lead lose its muted styling. Core typecheck is green and the focused full-control-center
> plus compact-companion matrix is **117/117**. The compact summary-page fields and revision-bound
> selected-detail hydration contract are handed to the separate bounded-read owner; this lane did
> not refactor authority or eager run loading. Exact evidence and the honest final stock-Pi/
> exact-tarball real-PTY boundary are recorded in
> [`agent-collab/populated-ui-parity.md`](agent-collab/populated-ui-parity.md). All source/test
> leases from this lane are released.

> **Bounded populated-run consumer closure — 2026-07-18:** this supersedes only the eager-loading
> handoff sentence in the preceding historical closure. After delegation from primary integration,
> the shared control center now retains one maximum-200 compact summary window and one exact
> revision-bound selected record. Ordinary refresh is one atomic `aroundRunId` page request rather
> than a page-1 walk; adjacent arrows remain cursor-based, stale recovery resumes from the selected
> anchor, missing/deleted selection falls back once, and global edges clamp. Provisional rows,
> populated cell/style semantics, and old-daemon compatibility are preserved; an oversized legacy
> list fails closed. Pi `koni_project_status` performs one compact page read with exact totals and no
> detail hydration. Core typecheck, **136/136** UI/companion tests, and **25/25** page/store/server
> tests are green. Full contract and commands are appended in
> [`agent-collab/populated-ui-parity.md`](agent-collab/populated-ui-parity.md); this consumer lease
> is released.

> **Complete bounded transcript-navigation lane reopened — 2026-07-18:** primary integration
> delegated the full control-center transcript projector/controller/chat input-rendering paths and,
> only where required, the native Pi transcript-page projector back to `populated_ui_parity/root`.
> The lane will retain one finite snapshot-bound history window, add direct older/newer adjacent
> navigation, and expose giant semantic blocks losslessly through bounded chunks instead of the
> historical newest-800 stop or a silent presentation omission. Authority runtime/store,
> package-smoke, provider, credential/user-Pi, terminal/pane, live-project, and Updog scope remains
> excluded. Decisions and evidence append in
> [`agent-collab/populated-ui-parity.md`](agent-collab/populated-ui-parity.md).

## 2026-07-18 — final exact-package Start/companion/PTY smoke claimed (`/root/final_package_pty_smoke`)

This bounded lane owns only `scripts/pi-package-smoke.test.mjs`,
[`agent-collab/final-package-pty-smoke.md`](agent-collab/final-package-pty-smoke.md), and append-only
coordination notes. It will consume exactly three supplied release archives when
`KONI_PACKAGE_ARCHIVES_DIR` is set; otherwise it performs a moving-tree rehearsal only. Stock Pi's
installed `/koni-run` handler will be driven through the explicit Start control against the existing
packaged provider-free admission seam, and the resulting zero-token durable run will populate the
passive companion, `/koni-runs`, `/koni`, and packed `koni tui` inside a test-owned local PTY before
exact uninstall/restoration proof. Authority/storage/control-center consumer/profile/parity source,
providers/network/OAuth flows, user Pi state, global installs, terminal panes, live projects, and
Updog remain excluded.

> **Pre-freeze package/PTY rehearsal lease released — 2026-07-18:** the stock-Pi smoke now uses the
> repository's exact pinned Pi 0.80.10 runtime without a registry install, locally seeds only
> Koni's exact `semver`/`yaml` dependency closure, and forces an empty owned npm cache offline. A
> fresh moving-tree rehearsal is **1/1 in 159.6s**: installed `/koni-run` selected **Start** and made
> a durable zero-token Planning run; the passive companion, `/koni-runs`, `/koni`, and packed
> `koni tui` all rendered it; Python `pty.fork()` supplied a real local 122x40 PTY and `q` exited
> zero; exact removal preserved unrelated Pi settings/auth/model-store/prompt/package/extension/
> skill bytes and modes. Cleanup left no child or fixture. This is deliberately not frozen archive
> evidence: no supplied `KONI_PACKAGE_ARCHIVES_DIR` was consumed while primary holds freeze. Exact
> commands and the superseding PTY transition are in
> [`agent-collab/final-package-pty-smoke.md`](agent-collab/final-package-pty-smoke.md). All source and
> test leases from this lane are released until primary announces the three frozen archives.

## 2026-07-18 — independent release acceptance audit claimed (`/root/release_acceptance_audit`)

This read-only lane is tracing the complete Pi-native product contract to current source, focused
tests, package manifests, parity artifacts, and release evidence. It owns no production/test source
and will report only definite gaps or partial acceptance outside the active startup/quiesce lane:
three-package boundaries; Pi commands and passive companion; full shared control-center parity;
background controls/questions/approvals/steering; native transcripts/lineage/compaction/resource
isolation; Rust-free deterministic authority; profile, ambient Pi, and credential preservation;
Git/worktree/manual merge; and deletion with zero further spend. It excludes providers/network,
global installs, user Pi state, credentials, terminals/panes, live projects, and the frozen Updog
canary. Mailbox:
[`agent-collab/release-acceptance-audit.md`](agent-collab/release-acceptance-audit.md).

## 2026-07-18 — startup epoch release blocker (`/root`)

Independent review found a pre-error crash prefix in ordinary startup: recovery could activate an
earlier run before a later run failed, while the durable failure-quiesce marker was written only in
the catch path. Primary and the lifecycle owner are closing this with a separate lifetime-retained
`authorityStartup` epoch: CAS `recovering` before every recovery effect, CAS the same epoch `ready`
after complete recovery, then publish socket readiness. A predecessor `recovering` epoch forces
bounded cleanup and draft blocking; `authorityQuiesce` wins when both exist. Source freeze remains
held for crash-prefix, ready-before-handshake, exact CAS/corruption, provider-overlap, and combined
quiesce/epoch tests plus independent review. The accepted transition is recorded append-only in
[`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Independent release acceptance audit complete — 2026-07-18:** no additional P0 source defect
> was found outside the separately owned startup/quiesce lane. The three-package Pi-native product,
> both UI surfaces, ordinary Pi credentials, contained sessions/resources, lineage, Git lifecycle,
> profile preservation, and delete/drain boundary are materially present. Release is still held by
> the truthful development parity ledger (**24 passing / 6 P0 specified**) and the absence of one
> final exact-three-frozen-archive stock-Pi/real-PTY rehearsal. The packaged moving-tree proof
> currently exercises a populated zero-token Planning run across all hosts, but not the complete
> actionable question/plan/chat/config/manual-merge matrix; focused source tests cover those paths,
> so that is a host-level evidence partial rather than a missing implementation. One bounded product
> partial remains: the dashboard chat shows only the newest 800 semantic blocks and elides displayed
> blocks above 64 KiB even though canonical Pi JSONL and authority paging remain complete. Exact
> findings and file evidence are in
> [`agent-collab/release-acceptance-audit.md`](agent-collab/release-acceptance-audit.md). This lane
> changed no production/test source and claims no leases.

## 2026-07-18 — shared two-gate shutdown closure (`/root`)

The startup epoch review exposed an adjacent shutdown race. Engine and server shutdown now use one
shared promise per object, so concurrent callers cannot return before all cleanup and cannot
observe different cleanup failures. External RPC admission closes first; the supervisor-wide
launch tombstone is installed synchronously before the first awaited drain; already-authorized
internal outcome/action/Git effects settle under the still-owned lease; then internal admission,
the socket, and the lease close. Immediate external rejection remains outside the queued mutation
tail, while an execution-time check closes the already-enqueued race. Source freeze remains held
for engine-level late-launch/shared-stop regressions and independent lifecycle review. Exact
decisions are appended in
[`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md); implementation/testing
remains coordinated through
[`agent-collab/bounded-run-pagination.md`](agent-collab/bounded-run-pagination.md) and
[`agent-collab/store-patch-review.md`](agent-collab/store-patch-review.md).

> **Complete bounded Pi transcript navigation closed — 2026-07-18:** the shared `/koni` and
> `koni tui` Chat surface no longer stops at the newest 800 blocks or silently elides a giant
> semantic item. Authority returns exact snapshot-bound adjacent older/newer windows; the
> controller holds one maximum-64-block window for four recent agents, preserves pinned readers
> during appends, and reloads live head only on explicit `r`. Ordered <=64 KiB chunks reconstruct
> complete safe UTF-8 content across pages, image bytes remain private behind ordered type/size
> attachment rows, and session/snapshot/ordinal/request ownership fails closed on drift or stale
> switching. Composer drafts are run-scoped and brackets remain literal while editing. Core
> typecheck, **87/87** transcript/control-center tests, and **22/22** populated frame/view-model
> tests are green. Exact decisions/evidence are appended in
> [`agent-collab/populated-ui-parity.md`](agent-collab/populated-ui-parity.md); the lane is released.

> **Actionable package/PTY host-parity lease reopened — 2026-07-18:**
> `/root/populated_ui_parity` now owns only `scripts/pi-package-smoke.test.mjs` plus append-only
> package-smoke coordination notes. The bounded goal is to extend the disposable stock-Pi,
> provider-free, real-PTY exact-package rehearsal across question answer+notes, authored-plan
> revise/approve, guided config publish, merge-ready inspect/manual merge, and truthful active-agent
> steer/follow-up only where the existing contained seam permits. No provider/network/OAuth/user
> Pi/global/live/pane/Updog state is allowed, and no full ~160-second rehearsal will run before the
> frozen archive handoff. Exact claim and decisions are in
> [`agent-collab/final-package-pty-smoke.md`](agent-collab/final-package-pty-smoke.md).

## 2026-07-18 — bounded pagination/startup/quiesce lane released (`/root/bounded_run_pagination`)

The bounded run surface and the startup/shutdown safety work discovered during its review are now
complete and released for serial integration. Run pages are exact bidirectional v2 snapshots with
bounded cursors/pages and selected-run anchoring; legacy whole-list output fails closed above its
compatibility ceiling. Lease ownership now precedes store recovery/migration. Hash-bound startup
epochs, purpose-authenticated quiesce, immediate external tombstones, joined terminal start/stop,
queue-bound Git cancellation, and exact explicit terminal-resolver resume close the reviewed crash
and token-spend prefixes without implicitly relaunching blocked work. Legacy purpose-less internal
startup-failure markers are distinguished from receipt-backed operator markers. Core typecheck and
scoped diff-check pass; server is 18/18; six exact engine lifecycle selectors are green; and the
22.77s faulted resolver/replay integration is green 1/1. Full contract/evidence is appended in
[`agent-collab/bounded-run-pagination.md`](agent-collab/bounded-run-pagination.md). This lane owns no
remaining source/test lease; primary may begin broad serial release gates.

> **Post-release resolver Git correction — 2026-07-18:** independent review found that a rejected
> narrow resolver resume still scheduled generic recovery for duplicate/unrelated Git intent. The
> constrained branch now rejects with `terminal_resolver_retry_git` and performs zero background
> recovery; generic recovery runs only when no terminal retry constrains resume. Adversarial
> duplicate and unrelated-intent variants prove byte-identical `run.json` plus zero
> `recoverIntent`/`supersedeTicketCycle` calls, followed by the exact happy path. Focused integration
> is **1/1 in 23.50s**, Core typecheck and scoped diff-check pass. The bounded lifecycle lane is
> released again; exact evidence is appended in
> [`agent-collab/bounded-run-pagination.md`](agent-collab/bounded-run-pagination.md).

> **Gate 2 startup/detached-outcome lease released — 2026-07-18
> (`bounded_run_pagination/root`):** the closure now rechecks its monotonic ownership flag after
> every awaited outcome/compiler/finalization boundary before ordinary mutation, covering a
> completion that entered immediately before quiesce. Final exact startup+quiesce is **6/6 in
> 22.20s**; full engine **50/50**, adjacent Gate 2 **54/54**, strict Core typecheck, and scoped
> diff-check are green. This supersedes the preceding frozen-candidate status. Source/test bytes
> are released to primary for the complete 580-test aggregate. Full trace is in
> [`agent-collab/bounded-run-pagination.md`](agent-collab/bounded-run-pagination.md).

> **Actionable package/PTY fixture implemented; lease released — 2026-07-18:** the exact-package
> rehearsal now drives installed `/koni` active-agent steer + follow-up, guided config publish, and
> authored-plan revise then approve; real packed `koni tui` answers a question with option+notes and
> explicitly authorizes a genuine prepared Git promotion. One durable run and the installed
> ProjectAuthorityStore/IsolatedGitLifecycle back the fixture; provider activation remains held and
> final state requires Completed, exact durable inputs, target-branch bytes, and zero total token
> usage. Syntax, manifest-only **1/1**, and scoped diff-check pass. Per freeze instruction the long
> rehearsal was not run, so frozen exact-archive execution remains a mandatory blocking release
> gate. Full transition/evidence caveat is append-only in
> [`agent-collab/final-package-pty-smoke.md`](agent-collab/final-package-pty-smoke.md). Script/docs
> lease is released.

> **Read-only Research stop-race diagnosis — 2026-07-18:** the composed failures at lines 828 and
> 916 are one deterministic circular wait. A configured assignment is held after its journal and
> semantic result complete but before final settlement; pause/delete then await that retained
> assignment promise through `#drainRunActionExecutions()` before they can commit the terminal
> lifecycle CAS that would abandon it. The fixture releases only after that terminal label, and
> `engine.stop()` joins the same promise after timeout. Adjacent cases pass because they pause only
> after actions have settled. This contradicts the existing stopped-action contract and is likely
> a reintroduced pause/delete drain, not slow provider or Research work. Exact state trace and
> diagnostics are appended in
> [`agent-collab/populated-ui-parity.md`](agent-collab/populated-ui-parity.md); no source/test or
> external state was touched.

> **Independent Gate 1 lifecycle verdict — 2026-07-18 (`store_patch_review/root`):** current source
> confirms the Research pause/delete timeout is a production circular wait. The assignment is
> gated after its completed journal and semantic replay but before its final publication CAS;
> pause, delete, and quiesce all call `#drainRunActionExecutions()` before the durable CAS that
> would type-settle that exact action as abandoned. The drain includes the gated assignment
> settlement, so the lifecycle waits on the promise its own tombstone must invalidate. This
> regresses the previously released lifecycle predicate and contradicts the
> `closeStoppedRunActions` contract. Release remains held until stop reaches its same-CAS terminal
> label without that pre-CAS join, late finalizers are proven no-op with zero proposal/effect/
> blocker/restart resurrection, and quiesce is audited symmetrically. Git draining remains required
> as a distinct external-effect boundary. Test cleanup may release gates in `finally`, but normal
> assertions must continue to observe `paused`/`deleted` before release. Exact trace and owner
> questions are in
> [`agent-collab/legacy-storage-hardening-review.md`](agent-collab/legacy-storage-hardening-review.md).

> **Gate 1 stop-settlement independently released — 2026-07-18 (`store_patch_review/root`):** the
> correction removes pause/delete's pre-CAS action join, closes quiesced action/attempt authority
> before provider/Git reconciliation, and retains the distinct external Git drains. Held
> assignment finalizers now lose to the durable lifecycle/action CAS and perform no late proposal,
> terminal-policy, blocker, or restart work. The composed fixtures use `finally` cleanup without
> releasing before the terminal-state assertion on success. Independent evidence is exact generic
> plus Research stop races **4/4** in **23.35s**, complete composed Gate 1 **5/5** in **100.66s**,
> quiesce regressions **4/4** in **19.04s**, Core typecheck green, and scoped diff-check green.
> Verdict: **release this lifecycle slice**. Full causal trace and closure are in
> [`agent-collab/legacy-storage-hardening-review.md`](agent-collab/legacy-storage-hardening-review.md).

> **Gate 1 Research lifecycle-settlement correction frozen — 2026-07-18
> (`bounded_run_pagination/root`):** the pause/delete timeouts were reproduced as one circular
> wait: lifecycle `pausing`, a source attempt `terminal_accepted`, and its completed validation
> journal still awaiting the injected final-settlement gate. Run-scoped pause/delete no longer
> join in-process action/finalizer promises before the CAS that abandons them; their distinct Git
> drains remain intact. Blocked/terminal quiesce now closes actions and attempts in a state-first
> CAS before provider/Git waits. Both fixtures release gates in `finally` only after observing the
> expected terminal boundary on success. Exact pause and delete selectors pass independently;
> composed integration is **5/5 in 98.08s**; five earlier action-stop races and four bounded
> quiesce cases pass; strict Core typecheck and scoped diff-check pass. Bytes are frozen for
> independent review, with full trace and evidence in
> [`agent-collab/bounded-run-pagination.md`](agent-collab/bounded-run-pagination.md). No external,
> live-project, provider, credential, user-Pi, terminal, or Updog state was touched.

> **Gate 1 Research lifecycle source lease released — 2026-07-18
> (`bounded_run_pagination/root`):** independent review passed generic plus Research stop races
> **4/4 in 23.35s**, complete composed Gate 1 **5/5 in 100.66s**, quiesce **4/4 in 19.04s**,
> Core typecheck, and scoped diff-check, with no remaining blocker. This supersedes the immediately
> preceding frozen-candidate status. All production/test source in this lifecycle correction is
> released to the primary integrator; exact owner and independent evidence is append-only in
> [`agent-collab/bounded-run-pagination.md`](agent-collab/bounded-run-pagination.md) and
> [`agent-collab/legacy-storage-hardening-review.md`](agent-collab/legacy-storage-hardening-review.md).

> **Gate 2 startup/detached-outcome correction frozen — 2026-07-18
> (`bounded_run_pagination/root`):** the 578/580 authority aggregate first exposed a test fixture
> routing unassigned Planning through a nonexistent ticket cycle. Correct workspace routing then
> revealed the underlying production seam: a Planning outcome attached before startup failure was
> aborted by quiesce in its original non-lease AsyncLocal context and its late `#failLaunch`
> mutation rejected `authority_quiescing` from terminal `stop()`. Durable operator/startup quiesce
> now closes detached outcome classification before abort callbacks resolve; state-first settlement
> owns attempt/action interruption and transcript-based provider reconciliation. Normal stop still
> drains finalizers. The regression explicitly requires failed-engine `stop()` to resolve. Exact
> startup is **2/2**, quiesce **4/4**, full engine **50/50**, affected Gate 2 subset **54/54**,
> typecheck and scoped diff-check pass. Candidate bytes are frozen for independent review; full
> trace is append-only in
> [`agent-collab/bounded-run-pagination.md`](agent-collab/bounded-run-pagination.md).

> **Gate 4 broad-Core correction — 2026-07-18 (`primary-integrator/root`):** the first complete
> Core matrix passed **1423/1427** and exposed four bounded gaps that focused gates did not cover.
> Effective profile compilation hashed baseline files without the authenticated migration catalog,
> so an untouched baseline differed from its package bundle. It now hashes both, while project
> edits still change the file projection. The built-in capability fixture now supplies the required
> form for `retry_terminal_resolver`. Finally, generic blocked-run startup inertness had swallowed
> the deliberate migration-only blocked state that protects a legacy checkout before proof-gated
> relocation; only an exact `relocation_required` record may cross that boundary, after which the
> settlement restores the prior phase. Focused configuration/capability/legacy coverage is
> **54/54**, strict Core typecheck and diff-check pass. The source generation is not releasable
> until affected Gates 1–4 are green again; no provider, credential, Pi home, live project, terminal,
> or Updog state was touched.

> **Stock-Pi package/control-center release closure — 2026-07-18 (`primary-integrator/root`):**
> the first post-freeze package rehearsal exposed a probe-only lexical-scope defect, then a real
> chat-composer race in which a second Ctrl-Enter could clear an unsent follow-up while the first
> authority mutation was still refreshing. Chat drafts now close synchronously before their first
> await, remain locked across the mutation boundary, and restore on failure; a focused control-center
> regression is **57/57**. The packaged interaction oracle was brought forward to the current guided
> Configure surface, single-action plan review, exact question selection, and case-insensitive
> lifecycle copy. Its disposable Git project now commits installed/project-authored `.koni`
> configuration before exercising target drift and manual promotion, waits for exact
> `Status: Completed`, and honors the authority's bounded non-interruptible-stop retry contract.
> The exact three-package stock-Pi rehearsal is **2/2 in 229.39s** with full Pi commands/overlays,
> standalone real-PTY control center, questions, steering/follow-ups, plan revision/approval,
> target synchronization/manual merge, crash recovery, deletion/cancellation, overlay preservation,
> resource isolation, and uninstall hygiene; it made zero provider calls and did not mutate
> credentials or ambient Pi resources. These source/test bytes still require the final full-gate
> rerun and parity republication before release or the frozen Updog canary.

> **Guarded-canary predecessor allowlist correction — 2026-07-18 (`primary-integrator/root`):**
> the first exact-archive Updog validation stopped before authority startup because Coding 0.8's
> authenticated semantic-retirement descriptor named only the oracle 0.7 bundle, while retained
> installed 0.7 bundles use exact digests `a3dd0099…5312c` and `c83eb529…d307`. The same inventory
> found retained Research 1.0.11 digests `ae83beab…3eb4` and `b40f0475…dbb4`. Both releases now
> authorize only those exact known predecessors in addition to the oracle digest; profile tests
> assert the retained sets, and regenerated bundle identities are Coding `094bf5de…b83d` and
> Research `1f8e474a…deef`. Focused profile/package/retirement evidence is **5/5 + 5/5 + 41/41**.
> The protected Updog run remains stopped and byte-identical at run hash `555cb573…7630`, target
> `95304acf…a4c4`; no authority/session/provider was started. Source is held for parity
> republication, aggregate gates, and a new exact three-archive rehearsal before any canary retry.
> **Guided `/koni-run` idle-socket correction — 2026-07-18 (`primary-integrator/root`):** the
> guarded Updog canary proved that keeping the catalog/branch RPC connection open while a human
> edits the New Run modal crosses the authority's intentional 60-second idle-socket limit. Start
> then failed before `run.create` with no new run or provider spend. Intake now closes discovery
> before the modal and opens one fresh, short-lived connection only for the explicit Start
> mutation; it rejects double submission and never blindly retries an uncertain write. Focused
> intake/companion evidence is **13/13** and Core typecheck is green. Details are append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Configured fixpoint-reissue lifecycle correction — 2026-07-19
> (`primary-integrator/root`):** the guarded fresh install preserved the paused Updog run, then
> Resume blocked before provider entry because the new reissue path attempted an unconfigured
> `closed -> todo` ticket transition. Coding and Research now explicitly configure compiler-only
> stale-obligation reissue. Already-pinned exact stock machines receive a hash-bound compatibility
> authorization for only that transition; customized machines and human actors still fail closed.
> Focused lifecycle/compiler/authority tests and strict workspace typechecks pass. Details and new
> bundle identities are append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Expected-red causal diagnostics — 2026-07-19 (`primary-integrator/root`):** an accepted
> nonzero configured check previously returned only a pass summary, so a proof author could not see
> that the red came from an unrelated fixture/import failure until an expensive Reviewer turn.
> Core now projects bounded authenticated stdout/stderr for accepted checks whose contract admits a
> nonzero exit; accepted-green receipts stay compact. The default Coding Implementer/preparation
> contract requires authenticating every returned failure before claiming preparation. Evidence is
> Core process **9/9**, Coding **8/8**, bundles **5/5**, and strict Core/Coding typechecks. Details
> are append-only in [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **No duplicate autonomous context fetch — 2026-07-19 (`primary-integrator/root`):** Pi already
> reissues the complete compiler-bound and dynamic context before every contained provider request.
> A live Reviewer redundantly called `koni_context`, added a 96 KiB receipt, and exhausted its input
> ceiling before verdict. Autonomous launch inventories now omit that duplicate tool and explicitly
> require reuse of the reissued context; the interactive package retains its context tool. Strict
> Core typecheck and native run-program **17/17** are green. Details are append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).
>
> **Blocked automatic review-author recovery — 2026-07-19
> (`primary-integrator/root`):** the live Updog canary found that an exhausted automatic review
> correction could fail in its author step, leaving Review pending and hiding the exact supervised
> recovery behind ambiguous generic retries. Core now derives recovery from the durable automatic
> review-rework record, binds it to the accepted reviewer attempt, restores the reviewer findings
> for the next author, and preserves the failed budget attempt. Generic Resume remains disabled.
> Scheduler **9/9**, exact authority lifecycle **1/1**, and strict typecheck are green; details are
> append-only in [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **macOS runtime-stage publication race — 2026-07-19 (`primary-integrator/root`):** a preserved
> daemon failure showed that a losing concurrent runtime-stage rename can return `EACCES`/`EPERM`
> after the winner seals the destination to 0500. Those codes now enter the existing full winner
> verification path rather than failing a zero-usage agent construction; genuine permission or
> byte/seal failures remain rejected. Eight concurrent children converge in the regression;
> runtime identity **12/12**, Core typecheck, and diff check pass. Full evidence is append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Large Pi fork pre-compaction + consumer-complete proof defaults — 2026-07-19
> (`primary-integrator/root`):** the live Medium proof rework inherited about 570 KiB of authenticated
> parent chat, spent 101K fresh input tokens on its first request, and reached the 120K ceiling just
> before its one check. Core now retains the full native Pi branch on disk while inserting one
> child-authorized compaction before the first provider request when inherited context is large; the
> exact new child instruction remains uncompressed and recovery hash-checks the compaction ledger.
> Coding's bundled Planner/Implementer now isolate expected missing modules, require discriminating
> sibling-negative fixtures, and prove actual consumer composition. Focused evidence is **26/26 +
> 8/8** with Core/Coding typechecks green; the wider gate is in flight. Full evidence and rationale
> are append-only in [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Canonical provider-error continuation + bounded Medium planning — 2026-07-19
> (`primary-integrator/root`):** the fresh external-worktree Updog smoke ended one six-minute final
> Codex synthesis with an exact Pi provider-error leaf and unknown billing. Explicit Resume now
> retires only a launch-bound terminal error carrying a response ID, zeroed Pi usage, no tool call,
> and a hash-bound error digest; it preserves the original request as uncertain exposure and starts
> an authenticated same-scope child session that reuses prior evidence. Torn/errors without a
> response ID still block. The bundled Coding planner also locks the simplest proven native seam,
> treats additive sibling values as routine rather than migration, and reduces Medium discovery to
> **16 calls / 120K new tokens / 30K synthesis reserve**. Evidence is provider lifecycle **19/19**,
> native continuation **1/1**, Coding profile **7/7**, and Core typecheck. Full rationale is
> append-only in [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Developer-tool-compatible worktree placement — 2026-07-19
> (`primary-integrator/root`, in progress):** the live Medium Updog proof worker produced its exact
> scoped test, but Vitest reported that both the new file and known existing tests were missing.
> The files are readable and the failure reproduces outside Koni containment: Vite's default
> `server.fs.deny` rejects every checkout physically below a `.git` path. Current policy-backed
> lifecycle namespaces are rooted at `<git-common>/.koni-worktrees`, so this is a Core Git-layout
> defect rather than an Updog test defect. Primary integration is moving all newly admitted managed
> worktrees to a collision-resistant repository-sibling namespace, retaining exact legacy-path
> validation for already-issued records, and adding a developer-tool deny-pattern regression. The
> current run is paused and provider-inert; no Updog overlay will be changed. Full rationale and
> evidence remain append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Authenticated Pi conversation-fork correction in progress — 2026-07-19
> (`primary-integrator/root`):** a live Medium plan revision received exact steering but an empty
> new Pi session, so it repeated the complete 24-call discovery pass and spent ~92K additional new
> tokens. Primary integration owns the cross-cutting correction: same-scope retry/rework/recovery
> attempts become distinct, hash-bound Pi session forks from the authenticated parent leaf, while
> Review/integration remain independent roots. Parent Koni metadata is excluded, child recovery and
> usage apply only to the suffix, and a planning revision fails closed if its fork cannot be
> authenticated. The bundled Coding planner also gains the lowest-migration repository-native
> design rule. The live run is awaiting approval and remains untouched while source changes are
> developed. Details are append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Fresh-user Medium smoke corrections — 2026-07-19 (`primary-integrator/root`):** live run
> `run-c08acc57-22ec-4515-b84c-e5ce43e17b31` proved that the default Coding planner can leave a
> complete contract unlinked and thereby derive redundant contract work; reviewers can spend their
> bounded context on whole-file reads; and a consumer-complete intended red can be rejected merely
> because its exact approved new local module is absent. Primary integration owns planner graph
> predicate closure/reuse guidance, search-first Reviewer guidance, task-local proof-preparation
> acceptance language, and the narrow Core distinction between an absent compiler-declared local
> input and a missing ambient/package dependency. The immutable installed smoke continues while
> source is corrected; no Updog-specific configuration is in scope. Full evidence is append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Post-implementation retry/delivery closure — 2026-07-19 (`primary-integrator/root`):** semantic
> Review rejection and infrastructure failure now have separate durable outcomes; no-effect Review
> routes are rejected; never-started stale tickets retire deterministically; and Coding delivery
> target plus bounded reviewer context are compiler-owned. A read-only replay against the paused
> Updog canary proves the exact legacy adapter without mutating the run. Core focused evidence is
> **102/102**, strict typecheck/build and profile bundles **5/5** are green. The frozen canary remains
> paused as forensic evidence because its historical proof workflow has no legal repair authority;
> the corrected path will be proven by the clean-user Medium smoke test. Full evidence is append-only
> in [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Predicate-scoped evidence + non-looping verification correction — 2026-07-19
> (`primary-integrator/root`):** delivery review passed, but the live Medium canary then emitted the
> same completed proof ticket on every target-sync verification tick because whole-graph evidence
> currentness treated an unrelated delivery node as proof invalidation. Core now rebinds each
> predicate only when its recursively resolved checked graph footprint is unchanged, around both
> agent deltas and compiler review effects. Verification names exact applicable ticket IDs and
> reissues a genuinely current completed ticket once for legacy recovery rather than looping.
> Unknown/interfering changes remain fail-closed. Core typecheck, compiler/full authority **79/79**,
> adjacent scheduler/tools/control **69/69**, Coding **8/8**, and diff check pass. The Updog canary
> is durably paused with zero active attempts pending guarded installation; full evidence is
> append-only in [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Post-review evidence and delivery recovery correction — 2026-07-19
> (`primary-integrator/root`):** follow-up inspection proved the redundant proof was not caused by
> pre-effect rule ordering. Review status effects changed the exact graph hash and made current
> promotion evidence appear stale. Core now rebinds that evidence only across authenticated,
> membership-preserving status-only effects; all semantic or check-membership changes remain
> fail-closed. Assignment prompts name exact compiler fields to omit, graph-only delivery review no
> longer demands nonexistent predecessor command streams, and rework children must settle with a
> fresh terminal call despite inherited parent transcripts. The TUI now projects only unresolved
> current-attempt check failures while preserving full history. Core/compiler/TUI authority is
> **33/33**, Coding is **8/8**, and strict typecheck is green. Full evidence is append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Live post-implementation orchestration closure claimed — 2026-07-19
> (`primary-integrator/root`):** the paused Updog canary proved that a no-longer-applicable proof
> ticket remained schedulable, infrastructure failure in a Review reopened its author, rejected
> proof authority remained visible to delivery, and delivery assembly/review lacked deterministic
> target and bounded semantic context. Primary integration owns these four Core/default-Coding
> corrections. The run remains token-inert; no project-specific Updog configuration will be used.
> Details are append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Authenticated proof-preparation currentness — 2026-07-19
> (`primary-integrator/root`):** the preserved Medium canary completed source-only preparation and
> independent Review, then verification reissued the same ticket because the Pi-native compiler
> had no producer for `proof_preparation_current` evidence. Core now reconstructs that fact from the
> newest exact Review's immutable Pi launch/context/output, historical check and source manifest,
> current source bytes, target universe, and compiler-owned effect lineage. Newer failed attempts
> supersede older valid ones; covered product drift remains allowed; source drift reopens; and the
> only prospective path is the exact terminal-accepted preparation Review. Typecheck, focused
> lifecycle **1/1**, adjacent native/domain compiler **21/21**, and a read-only preserved-Updog
> replay all pass. Full rationale is append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).
> **Whole-set and empty-state oracle closure — 2026-07-19
> (`primary-integrator/root`):** the next honest Reviewer proved that a positional six-member
> suffix could hide a retained seventh legacy control, while an always-populated fixture could not
> establish visibility of optional empty fields. Coding's default Implementer now requires exact
> closure of the entire semantically selected collection and independent empty, legacy-only,
> absent-optional, and populated condition fixtures before the first configured check. Coding
> **7/7** and profile bundle identity **5/5** pass; the new bundle is
> `sha256:9469a39c3fccf3b2bf8fffd002aebc3cdf35243a00e3737df3e21270787a92dd`.
> Full rationale is append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Exact historical receipt selection — 2026-07-19 (`primary-integrator/root`):** the live
> canary reached an honest accepted expected-red and submitted correctly, but terminal replay
> rejected its compiler projection because multiple accepted retries matched one historical leaf.
> Projection now emits one authenticated receipt per required leaf—current attempt first, then
> newest durable evidence—while replay remains strict about extras. Core typecheck, the focused
> duplicate-receipt case, and all native compiler cases (**14/14**) are green. The run/worktree
> remain preserved for a guarded retry; full evidence is append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Authenticated predecessor-review evidence — 2026-07-19 (`primary-integrator/root`):** the live
> Updog oracle review could inspect source but not the compiler-recorded command streams, so it
> rejected a real coverage gap without seeing that a second oracle case had crashed in its React
> fixture. Every configured review now receives a bounded, hash-verified `predecessorExecution`
> envelope for its declared predecessor steps and must map each structured oracle case to actual
> stdout/stderr. React setup/render crashes are deterministic expected-red exclusions, and Core's
> terminal instruction now forbids finishing in prose after the final check. The current blocked
> canary/worktree remains preserved for guarded activation. Full rationale is append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Target-branch dependency reconciliation — 2026-07-19 (`primary-integrator/root`):** the live
> target still pins `framer-motion@11.5.3`, while the newer primary Books checkout links only
> `motion@12.42.2`; borrowing the current link topology caused nine invalid proof invocations even
> though the historical package bytes remained locally installed. Managed checks now reconcile
> direct dependency versions from the target manifest/pnpm importer and target-owned workspace
> packages before containment, using only authenticated existing caches and managed links—no
> install, network, scripts, lockfile edits, or source mutation. The exact Updog Vitest command now
> reaches its assertions with the target React/dependency closure. Evidence is containment **8/8**,
> adjacent compiler **22/22**, Coding profile **7/7**, bundle **5/5**, and strict typecheck. Default
> Implementer guidance also forbids one-property-per-check fixture debugging. Full rationale is
> append-only in [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Live Medium execution boundary correction — 2026-07-19 (`primary-integrator/root`):** the
> preserved Updog canary proved that compiler context was injected and then redundantly fetched,
> a valid context receipt was rejected by a hidden 64 KiB presentation cap, and the next turn used
> model output maximum as though it were total context capacity. New specs now authenticate Pi's
> context window, legacy specs preserve their original `maxInput` boundary, tool results honor the
> launch-bound limit, and Coding implementers consume injected context without rereading it.
> Bundled Coding run types also opt out of automatic entry/deadlock Lead judgments; deterministic
> scheduling remains Core-owned while configured qualitative Lead boundaries remain supported.
> Focused runtime/profile evidence is **96/96 + 5/5** with strict Core typecheck. The canary is
> paused and unchanged until a guarded reinstall. Full evidence and rationale are append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Authenticated same-scope Pi conversation forks released — 2026-07-19
> (`primary-integrator/root`):** plan revision, retry, and recovery can now use a distinct immutable
> Pi child session backed by exact parent launch/transcript/leaf hashes, while Review/integration
> remain independent roots and child usage excludes the inherited prefix. Recursive forks and
> parent-mutation rejection are covered before provider entry. Core session evidence is **92/92**,
> authority/native compiler **75/75**, bundle integrity **5/5**, and strict typecheck is green. The
> preserved Updog run is ready for the guarded low-waste revision proof; full rationale is
> append-only in [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Operator-confirmed ticket recovery correction — 2026-07-19 (`primary-integrator/root`):** the
> paused Updog canary proved that a contained infrastructure failure could leave its ticket blocked
> across resume with no legal successor. Typed failure codes now survive Pi session, child
> transport, and durable attempt storage. Resume resets only recognized infrastructure failures
> with no accepted terminal result or unsettled provider exposure; it preserves the failed attempt
> and derives one ordinary retry lineage. Compiler-reviewed semantic failures remain blocked and
> create no successor. Focused evidence is engine **3/3**, runtime propagation **2/2**, strict Core
> typecheck, and scoped diff-check. Source is released for guarded reinstall; the live run remains
> paused and token-inert. Full rationale is append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Provider input-estimate migration claimed — 2026-07-19 (`primary-integrator/root`):** the first
> live operator-confirmed retry proved its lineage and then exposed a unit defect: Koni compared
> serialized UTF-8 bytes one-for-one with model tokens. Primary integration owns the shared
> Pi-aligned estimate, legacy-ledger compatibility, typed authority-error propagation, focused
> runtime tests, and generic Coding bounded-read instructions. Provider/output authority and exact
> post-response accounting stay unchanged; Updog remains paused and provider-inert. Details are
> append-only in [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Configured-check semantic identity correction — 2026-07-19 (`primary-integrator/root`):** the
> live Updog proof-preparation worker authored both scoped test sources, then was deterministically
> rejected because the resolved composite/leaf plans used legacy raw-definition hashes while their
> immutable policies used pinned semantic-catalog hashes. Policy-bound plans now use the semantic
> identities end to end; policy-free legacy plans retain their raw-definition compatibility path.
> Native compiler evidence is **13/13**, adjacent policy/runtime evidence **15/15**, and strict Core
> typecheck is green. The canary remains paused and provider-inert until guarded activation. Full
> evidence is append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Canonical provider-abort recovery released — 2026-07-19 (`primary-integrator/root`):** a live
> pause left one Pi response durably marked aborted with intentionally zeroed usage, so exact
> billing could not be reconstructed and the prior generic exposure hold stranded Resume. An
> explicit Resume can now retire only a launch-authenticated canonical Pi abort. The assistant,
> response ID, original bounded reservation, and operator authorization remain hash-bound; exact
> token totals remain unchanged and the dashboard shows the reservation separately as uncertain
> exposure. Torn/error/mismatched responses remain blocked. Evidence is provider authority
> **17/17**, control-center **12/12**, adjacent record/policy **4/4**, and strict Core typecheck.
> Full rationale is append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Contained-check and honest-failure recovery correction — 2026-07-19
> (`primary-integrator/root`):** the full failed-worker transcript proves two terminal submissions
> were rejected after the composite historical check stopped at exit 127; this was runtime/check
> authority failure, not an agent omitting its terminal instruction. The command sandbox now carries
> the exact interpreter/package-manager closure and a read-only managed-worktree dependency overlay.
> Obvious setup/collection/module failures cannot qualify as expected-red evidence. Explicit Resume
> may recover a terminal-protocol-failed attempt only under the existing no-effect/no-exposure
> guards, while a new schema-valid failed assignment is durably accepted as `failed_submission`
> without claiming success checks. The complete adjacent authority/compiler gate is **74/74** and
> strict workspace typecheck is green. The preserved Updog worktree was durably paused before the
> guarded generation refresh. Full rationale is append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).
> **Exhausted review recovery + route-matrix default — 2026-07-19
> (`primary-integrator/root`):** the live Medium canary proved that its second honest reviewer
> failure left a blocked ticket under an `executing` run with only a misleading generic Resume.
> Core now blocks only after terminal provider settlement, projects one exact confirmed **Retry
> reviewed blocker** capability bound to the failed reviewer attempt, preserves automatic and
> supervised rework history, and reopens only the compiler-pinned author/reviewer slice. Generic
> Resume cannot bypass this semantic boundary. Coding's bundled Implementer now closes a complete
> member-by-consumer route matrix before its first check, so the Updog-derived lesson ships as the
> default rather than a project overlay. Typecheck, scheduler/compiler/capability **33/33**, focused
> authority **3/3**, Coding **7/7**, and profile bundles **5/5** are green; details are append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).
>
> **Post-activation fork compaction — 2026-07-19 (`primary-integrator/root`):** the first live
> supervised retry safely failed at zero usage because its large-fork compaction requested durable
> authority during contained-process construction. Core now persists only the immutable child
> suffix before readiness, then authorizes/syncs native Pi compaction after the parent commits and
> activates the exact session and before provider entry. Production/managed session suites are
> **26/26 + 26/26**, focused compaction boundary/recovery **2/2**, and strict typecheck is green.
> The zero-usage failed attempt remains preserved; details are append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Explicit provider acknowledgement + search-bound file reads — 2026-07-19
> (`primary-integrator/root`):** the live reviewed retry produced a canonical provider-error leaf
> containing an unexecuted write proposal, while the same agent blindly paginated 179 KiB despite
> clear Coding guidance. Core now exposes a confirmed accounting-only **Acknowledge provider error**
> action that never resumes work and permits inert terminal write/edit proposals only when no tool
> receipt or pending effect exists. Reviewed retry remains a separate capability. File reads are
> capped at 32 KiB, and nonzero offsets in large files require proximity to an authenticated prior
> search match. Strict typecheck and the adjacent provider/review/tool/TUI gate are **161/161**;
> rationale and evidence are append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Steerable supervised proof recovery — 2026-07-19 (`primary-integrator/root`):** the Updog
> canary proved that a graph-pinned `--silent` test command can hide the causal component stack and
> turn an exact reviewed rework into repeated fixture guessing. **Retry reviewed blocker** now
> accepts bounded multiline operator steering, persists it on the supervised rework record, and
> injects it beside the unchanged reviewer contract without broadening authority. Bundled Coding
> planning/preparation/review guidance now forbids diagnostic-suppressing proof commands. Focused
> evidence is scheduler **9/9**, authority **2/2**, native prompt **1/1**, Coding **8/8**, bundles
> **5/5**, plus strict Core/Coding typechecks. Details are append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Budget-abort assignment recovery — 2026-07-19 (`primary-integrator/root`):** the live Updog
> Reviewer proved that Pi token ceilings settle as `aborted`, while Core's safe explicit Resume
> recognized only `failed` infrastructure attempts. Core now reopens exactly the failed assignment
> for settled canonical budget aborts, preserving completed predecessors and immutable lineage;
> the palette coalesces duplicate run/stage `retry_blocked` controls. Strict typecheck, exact live-
> shape recovery **1/1**, and control-center **57/57** are green. Details are append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Live post-effect derivation regression — 2026-07-19 (`primary-integrator/root`):** the Medium
> canary's implementation Review produced an `implemented` change and `passing` linked proof, but
> its same compiler evaluation derived a redundant `establish-proof` ticket from the pre-effect
> graph. That ticket reran both proof execution and model review. Core/default Coding must derive
> from the post-effect graph or prune only a now-obsolete unstarted ticket; no Updog overlay is
> authorized. The dashboard also incorrectly counts accepted historical expected-red receipts as
> current failed-check attention. Exact timestamps and artifact evidence are recorded append-only
> in [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Schema-1 compiler-ownership and release-gate correction — 2026-07-19
> (`primary-integrator/root`):** target compiler ownership is now unioned after legacy graph-array
> merge, so an old delivery node cannot strip the authenticated `spec.target_branch` binding while
> project-authored semantics remain preserved. The exact current Coding 0.7 development source is
> named in the retirement allowlist, Coding 0.8 republishes at `sha256:1d142a10…a29e6`, and the TUI
> operator test accepts its intentional authority reconnect callback. Profile bundles **5/5**,
> release/operator/package **55/55**, focused adoption/migration, Coding **8/8**, workspace
> typecheck, and diff check pass. Full evidence is append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Reissued-ticket session isolation — 2026-07-19 (`primary-integrator/root`):** a live
> compiler-reissued proof ticket inherited its already-terminal Pi conversation, compacted the old
> history, and wasted 57,486 uncached input tokens before returning no terminal call. Tickets and
> assignment attempts now carry execution epochs: a fresh obligation starts a fresh Pi root,
> retries inside that obligation may still branch, and all old transcripts/receipts remain intact.
> Exact compatibility and evidence are append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Cross-ticket proof evidence without cross-ticket chat — 2026-07-19
> (`primary-integrator/root`):** the live proof Reviewer correctly rejected a green-only context
> because the independently reviewed expected-red preparation lived on an earlier ticket. Core
> now injects a bounded, hash-sealed `historicalPreparation` envelope from the same authenticated
> snapshot and source-currentness chain used by `proof_preparation_current`, while keeping the
> current ticket in `predecessorExecution` and starting no inherited Pi conversation. Default
> Coding contracts recognize this evidence split. Native compiler **18/18**, Coding **8/8**, and
> strict Core typecheck are green; exact rationale and compatibility are append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Fresh roots for supervised independent rereview — 2026-07-19
> (`primary-integrator/root`):** the canary reached `merge_ready`, but the explicit rereview forked
> its rejected Reviewer chat and paid 67,346 uncached input tokens despite receiving complete
> compiler-authenticated evidence. The first attempt after a supervised `review_only` recovery now
> starts at a fresh Pi root; normal producer-to-review handoff and retries within that new attempt
> retain their intended lineage. Strict typecheck, focused recovery **1/1**, and full authority
> engine **62/62** are green. Details are append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **First Medium canary published + clean admission — 2026-07-19
> (`primary-integrator/root`):** the exact Updog smoke published commit `14b7a7a29e` with 4/4
> tickets and eight accepted checks. Its final merge exposed an untracked local `.koni` profile;
> new run admission now rejects any dirty checked-out target before planning spends tokens and
> explains commit/stash/ignore. The action palette coalesces duplicate semantic merge controls,
> and terminal runs expose no invalid current-success stage. Strict typecheck, Git **41/41**,
> controls **58/58**, and explicit publication **1/1** are green. Details are append-only in
> [`agent-collab/primary-integrator.md`](agent-collab/primary-integrator.md).

> **Fresh-baseline re-validation of the three fixes on Claude models — 2026-07-20
> (`harness-fix-validation/root`):** re-proved the 2026-07-19 fixes (dirty target-checkout
> admission guard, terminal runs exposing no current stage, coalesced duplicate merge controls)
> against a fresh baseline off `14b7a7a29e`, without launching a new token-spending run. Installed
> the current dev build (bundle `b4404d49…`); confirmed all three fixes in the sealed dist and
> **173 targeted tests** green across `isolated-git-lifecycle`, `stage-capability`,
> `control-center-surfaces`, `run-authority-engine`, with a named per-fix proof for each.
> Additionally ran the shipped terminal-current determinant + the installed
> `assertStageCapabilityCatalog` over all six real `run.json` records: `completed`/`deleted` runs
> project to no current stage (incl. `run-ad4d4319`, stored current `promotion`), the two `blocked`
> runs keep `orchestrate` current, and a pre-fix projection of the completed run is correctly
> rejected. Also switched the fresh project's `.koni` to the provider-agnostic Claude config (Opus
> lead/planner/reviewer, Sonnet workers; workers raised to `xhigh` because this Pi catalog exposes
> only `xhigh`/`max` for the Claude models) and `config validate` passes; live model admission was
> not exercised. No run was launched and the six existing runs were only read (never
> resumed/paused/deleted) — the shared common-dir authority (pid 5780, bundle `c4dbfe67`) owns them
> and Live-run safety forbids the restart a new run would require. The reinstall version-skewed that
> authority; the CLI launcher was rolled back to `c4dbfe67` and `koni status` reconnects cleanly
> (revision 3895, 6 runs). Koni docs still pinning `openai-codex` as the only provider are stale
> post-Pi-port and need updating. Full details, thinking-level reconciliation, environment state,
> and remaining gaps are append-only in
> [`agent-collab/fix-revalidation-claude.md`](agent-collab/fix-revalidation-claude.md).

> **Superseded by → authority deployed on `b4404d49` (fixes live) — 2026-07-20
> (`harness-fix-validation/root`):** the operator then asked to bring the fixes live, superseding the
> "rolled back to `c4dbfe67` / not deployed" statement above. The shared authority was restarted onto
> `b4404d49` (all three fixes) **from the durable `projectRoot` (the harness-testing worktree)**; it
> reused the existing read-only runtime stage `1b946f6b…` (no rename, no EACCES) and reached ready
> (new pid 5483, startup sha `45f9d712…`, revision 3899, runCount 6). All six run phases/revisions
> are preserved (the two blocked forensic runs stay blocked, never resumed). Authority = CLI = Pi
> registration = `b4404d49`, so `/koni` now handshakes. The first `b4404d49` start had failed only
> because I used the wrong operator root (main updog → "different Git repository") plus a transient
> stage race — not a koni bug; `pi-peer-loader.js` already reuses an existing stage and catches the
> EACCES publication race. A fresh Claude plan→merge run is now unblocked but was not run. Details
> append-only in [`agent-collab/fix-revalidation-claude.md`](agent-collab/fix-revalidation-claude.md).

> **Claude-model smoke: 5 fresh Small runs driven, harness validated end-to-end, clean merge not
> reached — 2026-07-21 (`harness-fix-validation/root`):** on the deployed authority (rebuilt to
> bundle `1aba254e` carrying the guidance fix) I drove runs #9–#13 (`2329dc3a`, `ffe8e1c3`,
> `276b5102`, `719553ab`, `04999c02`) through a standalone `koni tui` (the in-Pi `/koni` control
> center froze after the authority restart — old client bundle `c4dbfe6` crashed in
> `authority/client.js #receive` on a pre-fix-b payload; version skew, restart Pi after a koni
> reinstall). Each run surfaced one real issue; all config/harness issues were fixed and
> re-validated. **Fixed + validated:** (1) gameable `failed`-schema reverted, implementers now do
> real work via write-grant guidance (koni `374d44c`); (2) ticket worktrees now link the primary
> `.sst` in `workspace.bootstrap` (updog `8aa85f70a0`) — was dangling `@sst/platform` crashing
> apps/books vitest; (3) reviewer `max → xhigh` (updog `8aa85f70a0`) — `max` blew the 120K new-token
> cap; (4) Small worker budget raised 240K→1.2M as a stopgap for the `attemptTokenBudget`
> `envelope/2` bug that gives the heaviest role half the planner's budget. **Proven:** plan →
> questions → approval → orchestrate → implement (real work) → `xhigh` review → ticket-complete all
> run correctly on Claude (Opus lead / Sonnet workers); run #11 completed a full ticket incl. review.
> **Not reached:** a clean `merge_ready`, blocked by (a) Sonnet diligence variance (occasional terse
> `failed` blockers "probe"/"test" even with guidance — same task succeeded other runs), (b) no
> operator recovery for a terminal semantic failure (retry no-ops), and (c) the approval gate
> approving a plan that then fails deterministic compile (`recovery_required`: unclosed
> `contract.applies_to`). Recommended follow-ups (code): decouple worker budget from `planning/2`
> and/or exclude reasoning from the new-token spend cap; add "re-issue failed step" recovery;
> validate plan compilability at the approval gate. All runs preserved under `updog/.git/koni/runs/`
> (not deleted). Full detail append-only in
> [`agent-collab/tui-smoke-ux-findings.md`](agent-collab/tui-smoke-ux-findings.md).
