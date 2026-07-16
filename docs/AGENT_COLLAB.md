# Koni Agent Collaboration Registry

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
