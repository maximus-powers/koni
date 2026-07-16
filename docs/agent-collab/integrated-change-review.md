# Integrated change review

Owner: `integrated-change-review/root`

Status: read-only review in progress; final fingerprint held while `primary-integrator/root`
finishes the scoped planned-context currentness and broader core rerun

## Scope and safety boundary

This lane independently reviews the current shared Köni worktree as one integrated product:
compiler/runtime authority, default profiles, project installation and upgrade behavior, cockpit
projection, documentation, and the preserved Medium Updog acceptance evidence. It owns only this
append-only mailbox. It does not edit Rust, TypeScript, YAML profiles/templates, tests, product
documentation, installed binaries, project configuration, live run state, processes, worktrees,
branches, refs, or cmux surfaces.

The worktree is intentionally large and shared. Findings below are based on current source and
durable live evidence, not on historical review prose alone. The final source fingerprint and
release disposition will be appended only after the active `engine.rs` range is explicitly
released.

## Token-accounting interpretation

Compact Header/Runs telemetry is intentionally cache-excluding `new_tokens`, labeled `new tks`.
The compiler computes new work as uncached input plus output; expanded telemetry reports cached
input and provider total separately. Provider total includes cached input, and reasoning is already
a subset of output. Therefore cached provider input must not be described as fresh or wasted model
cognition.

The current implementation and regressions agree on this split:

- `crates/koni-core/src/control.rs` defines `new_tokens` separately from cached input;
- `crates/koni-tui/src/model.rs` preserves provider total and derives cache-excluding new work;
- `crates/koni-tui/src/ui.rs` labels the compact value `new tks` and exposes cached/provider values
  in the expanded overview.

All cost findings below name uncached/new tokens separately from cached input.

## Provisional findings

### P1 — default orchestration still spends model cognition on deterministic compiler effects

The compiler has already selected every current Lead effect before inference. `LeadSliceBoundary`
contains only `DispatchBatch`, `WaitWorkers`, `Recover`, exact-ticket `SpawnWorker`, exact-ticket
`Review`, and exact-ticket `Finish` (`crates/koni-core/src/control.rs:364-376`).
`next_lead_boundary` deterministically selects the exact effect and ticket
(`crates/koni-core/src/engine.rs:39882-39949`), and `lead_packet_commands` then renders the exact MCP
call plus `yield_lead` (`crates/koni-core/src/engine.rs:35525-35549`). No current boundary exposes a
bounded semantic choice for a Lead model to make.

The preserved Medium run now records at least **82,968 uncached Lead tokens** across 66 Lead turns,
with zero cached input for those fresh one-boundary sessions. The transcripts relay prescribed
spawn/recover/review/finish calls; independent worker and Reviewer cognition is a different and
necessary category. No `boundary_driver` or compiler-owned orchestration-boundary executor exists
in current source.

Disposition: this is a default-flow cost/cohesion P1, not a cached-token accounting issue. Replace
the model courier with the replay-safe compiler boundary executor designed in
`docs/agent-collab/lead-cognition-audit.md`; retain process-bound workers, independent Reviewer
inference, action journals, pause/replay checks, and historical Lead readers. Reserve a future
coordinator model for an explicit structured decision boundary that cannot itself perform the
chosen effect.

### P1 — no supported upgrade contract preserves project-owned profile customization

The requested versioned bundled-baseline plus project-overlay model is still explicitly queued in
`docs/AGENT_COLLAB.md` and `docs/tui-cleanup-backlog.md`. Current schema-2 replacement stages a
complete new `.koni` tree (`crates/koni-cli/src/main.rs:1652-1753`). Publication moves the entire
existing destination to `staging/backup/koni`, publishes the complete staged directory, and removes
the staging root—including the successful backup—after publication
(`crates/koni-cli/src/main.rs:2548-2695`). `prior_owned` protects external repository skills; it
does not three-way merge editable `.koni` run types, personas, graph rules, workflows, checks, or
project resources.

There is no schema-2 replacement regression that edits project configuration and proves it
survives a bundled profile update. Ordinary `koni init` safely verifies an existing installation,
but it also provides no upgrade path; `--replace` is whole-tree replacement.

Disposition: hold any claim that Köni can safely upgrade configured projects. Store an immutable,
versioned bundled baseline separately from a project-owned overlay, resolve them deterministically,
and upgrade the baseline with conflict-aware three-way validation. Keep explicit destructive
profile switching separate from ordinary version upgrades.

### P2 — cockpit refresh cost still scales with every registered run

The draw loop is already dirty/event driven and caps live animation at 500 ms, so the former
unconditional 10 Hz redraw diagnosis is obsolete. The remaining hot path is snapshot projection.
Every completed refresh waits two seconds, then `project_snapshots` opens **every** registered run
and computes a complete `cockpit_snapshot` (`crates/koni-tui/src/app.rs:603-614` and
`crates/koni-tui/src/model.rs:4795-4820`).

The optimized single-run acceptance snapshot still takes about 1.41 seconds, and contemporaneous
read-only samples put the cockpit at roughly 77–153% CPU while the model host slept. A multi-run
control center—the intended product—will repeat full inactive-run graph/ticket/receipt projection
on the same cadence and scale linearly.

Disposition: cache immutable/inactive snapshots by compiler generation or sidecar fingerprint;
refresh selected and live runs eagerly, and project inactive run rows from the registry until the
operator selects one or its generation changes. Add populated one-run and many-inactive-run CPU/
latency regressions. This is controller CPU, not token spend.

### P2 — current authentication documentation contradicts the implemented Pi-style flow

`README.md:62-63` currently says OAuth login is device-code-only. Current CLI source and its focused
test select `OAuthLoginFlow::BrowserPkce` (`crates/koni-cli/src/pi_control.rs:54` and the
`login_uses_pis_default_browser_pkce_flow` regression), matching the user's explicit request and
the superseding browser-flow note in `docs/getting-started.md`.

Disposition: append an adjacent README supersession and make the current quick-start instruction
say browser PKCE on supported local macOS, while retaining device code only as a supported
headless/fallback capability where actually available. Do not rewrite away the dated migration
history in the longer docs.

### P1 — exact-file search semantics and correctionless retry wasted a complete worker turn

The live baseline Implementer `worker-019f6b0a-a146-7293-9c6c-9fa642f4fb29` ran for 7m27s,
performed useful bounded reads, then batched several `search_files` calls. Three searches against
exact authorized files succeeded. The first directory search against
`apps/books/src/pages/companies/[companyId]/home/questionnaire` was correctly denied as
`forbidden_scope`; the Pi host then stopped without a compiler-committed terminal boundary. Its
final durable usage was **55,708 uncached/new tokens**, **25,088 cached input**, and **80,796
provider-total tokens**. Lead automatically started a replacement Implementer with the same input
hash and no visible corrective context.

This is an instruction/tool-contract mismatch, not a reason to weaken scope enforcement. The
assignment prints `Ticket read paths: {:?}` but does not state whether each entry is an exact file
or a directory capability (`crates/koni-core/src/engine.rs:28219-28236`). The tool description says
that `search_files` searches “across ... product files inside ... read scope” and accepts any
nonempty string `path` (`crates/koni-core/src/agent_tool_broker.rs:782-793`), which naturally
suggests a directory search. Enforcement instead requires the requested path to equal or descend
from one issued entry (`crates/koni-core/src/engine.rs:19108-19139`); a parent of several authorized
exact files is outside authority even though traversal could theoretically be filtered.

Disposition: make invalid calls difficult to express. Prefer a grant-specific schema or a
`search_files` mode that searches exactly the issued authorized-file set, with an optional narrow
prefix only when that prefix itself is authorized. At minimum, state explicitly in both the worker
protocol and tool description that a file-only grant must be searched one exact path at a time.
The broker must continue denying arbitrary parent/out-of-scope traversal. A request that is only a
parent of already disclosed exact files may receive one bounded corrective response without
widening authority; arbitrary forbidden probes remain terminal. Any no-output replacement must
receive the prior compiler-safe failure class/correction so it cannot automatically repeat an
identical context and mistake.

## Non-blocking cognition observation

The closed graph-authoring contract ticket carried a 71,045-byte / 1,632-line context for three
read paths and two directly scoped graph nodes. The product-execution schema-1.1 compaction is
working and deliberately excludes cached-token totals from new work, but graph-authoring contexts
still include the complete authoring schema plus root planning prose and expanded typed closure.
This is not an authority defect and much of repeated provider input is cached. It is nevertheless
worth a later structured projection pass that retains every allowed field/edge/mutation contract
while hashing and bounding already-materialized planner prose and deduplicating graph bodies. Track
prompt bytes, context paging/tool rounds, uncached input, output, retries, and wall time separately.

## Current accepted dispositions

- The Software Small/Medium/Large model and reasoning defaults match the requested matrix.
- Research reciprocal facts use canonical bidirectional relationships rather than redundant
  authored reverse edges.
- Current compact token telemetry is truthful: `new tks` excludes cached input, while Overview
  reports cached input and provider total separately.
- The current planned-new read-path repair now lets a graph-only contract ticket bind exact absence
  without pretending a compiled proof source may be absent. The live contract ticket closed and
  passed independent review. Final source/currentness disposition remains pending the active
  engine-range release and broader rerun.
- `git diff --check` is clean at this checkpoint. No old harness branding was found outside
  preserved migration/history semantics.

## Final frozen-source disposition — 2026-07-16

This section supersedes provisional severity and currentness claims above where they conflict.
The source was frozen for this review at the following SHA-256 fingerprints:

- `engine.rs`: `52b65090ff0b87fc0be57d073b3e3ff7de7139e132dbd27ffb36300ab1e89743`
- `agent_tool_broker.rs`: `681e44e7860f03435a071a312a6fd861b42ba50da52b298d7921f98c510bb563`
- TUI `app.rs`: `21203101db937d831693e309f7f515120089779550d30b0bd7c2d4a06d023e23`
- TUI `model.rs`: `a7cf8e45608de73c8fab3366aeebd9c89d213a67c520c8c0098b574a2a2e49a3`
- TUI `ui.rs`: `351405eaf7d8e5adc1596046cd7e4c5e523fd0f961ac7a723d9788f5766c9202`
- TUI `help.rs`: `b14ce4d64c9fef02ee22e6aa3378ceebd27fdf0787ebe7561712c8f3c38fb36d`
- runtime `runtime.ts`: `29375ccd9f89ab39d99861e58eb1f4f1307162f1f6e9ded7b83ac31776b82570`
- runtime `wire-types.ts`: `afed19dd9ab56f9925c24a48d0051b6fc6fcee2c274bac853c62fe9f973ff2f4`
- bundled host: `98e3c30c9aaa450266747f4717cc5ab4ab3118761a8571e579f5d404652c0fc4`

The frozen verification closure is green: 656 core library tests, 306 TUI library tests, 55
runtime tests plus typecheck and bundle smoke, `cargo fmt --all --check`, `git diff --check`, and
all-target `clippy -D warnings` for `koni-core` and `koni-tui`. The existing intentionally ignored
core tests were unchanged. One compact Agents-help assertion found during the gate was corrected;
the focused and full TUI reruns passed.

### Token-accounting clarification

The compact Runs/Header number intentionally excludes cached input and is labeled `new tks`.
Overview separately reports uncached input, output, reasoning, cached input, and provider total;
reasoning is a subset of output. Therefore cached input must not be described as fresh or wasted
cognition. For the failed worker described above, the precise accounting is **55,708 new/uncached
tokens + 25,088 cached input = 80,796 provider-total tokens**. Provider billing implications may
still differ, but the fresh-work efficiency finding applies only to the 55,708-token component.

### Superseded source finding — file-scope correction

The exact-file parent-directory mistake remains useful live evidence about first-shot cost, but it
is no longer an open source defect on the frozen bytes. The broker/assignment contract now names
the distinction between issued files and issued directories, permits descendants only for issued
directories, and never widens authority to an unlisted ancestor. A proven unlisted read ancestor
gets one retryable `file_scope_retry`; a repeated same-tool mistake becomes terminal
`file_scope_retry_limit`, while unrelated forbidden paths remain terminal immediately. The runtime
also skips stale sibling calls after the first retryable error in a model-authored batch and lets
the informed correction run on the next provider request. The regression proves that only the
first bad call and the corrected call reach the broker. This is the desired repair: bounded
correction without authority expansion.

### Remaining release findings

**P0: none.** The current live acceptance run is not blocked, and this review found no reason to
pause, recover, delete, or restart it.

**P1 — deterministic Lead courier cost remains architectural.** Most Lead boundaries are already
fully selected by compiler state: dispatch a specific batch, wait, recover, or spawn/review/finish
an exact ticket, with authorization enforcing the exact effect and order. Yet each boundary still
invokes the Lead model to emit the predetermined command. The observed acceptance run consumed at
least 82,968 new/uncached Lead tokens across 66+ turns with zero cached input at the measurement
point. Independent Worker and Reviewer cognition remains necessary; the redundant portion is the
model-mediated deterministic coordination. Move replay-safe deterministic boundaries into the
compiler/controller executor and reserve a coordinator model for explicit semantic choices.

**P1 — upgrade-safe project overlays remain absent.** Profile installation stages and publishes a
complete `.koni` tree, and `--replace` replaces that destination. External-resource hashes protect
Codex-facing `.agents` resources, not the user's editable `.koni` run types, personas, graph rules,
workflows, and checks. There is still no versioned bundled baseline plus project overlay and no
three-way upgrade regression. Ordinary binary updates do not mutate project configuration, and
`--replace` is explicitly destructive today, but that does not satisfy the requested promise that
project-specific configuration survive Koni upgrades. Do not present `--replace` as a preserving
upgrade path until this model exists.

**P2 — cockpit snapshot work still scales with every registered run.** Rendering is now
event/dirty-driven, with a 500 ms cadence only for visible live cues; the earlier unconditional
redraw criticism is superseded. However, each completed refresh still opens every registered run
and builds a full cockpit snapshot. Cache inactive snapshots by compiler generation or sidecar
fingerprint, keep selected/live runs eager, and add populated many-run latency/CPU regressions. The
previous 77–153% CPU samples came from an older installed binary and must not be attributed to the
frozen event-driven source.

**P2 — authentication quick-start text contradicts the implementation.** The README still says
OAuth is device-code-only, while the current CLI and regression use Pi-style browser PKCE. Append a
current-state note beside the old language and describe device code only as a supported fallback
where it actually remains available.

**P2 — source installation publishes a multi-file closure non-atomically.** `install-dev.sh`
publishes the binary, host/checksum/SBOM, Node assets, and licenses sequentially into the existing
prefix before its final smoke test. An interruption or concurrent install can expose mismatched
artifacts. Stage and smoke-test a complete versioned directory, atomically switch `current`, and
retain a rollback target.

### Release recommendation

The frozen core/runtime/TUI changes are verification-green and suitable for controlled internal
Updog use, including continuation of the healthy live run. The overall product is not yet
completion-clean against the user's full harness contract because upgrade-safe configuration
overlays and deterministic Lead-token efficiency remain unresolved. Until those land, use guarded
binary refreshes only at quiescent boundaries, do not run `--replace` expecting local configuration
preservation, and treat the remaining Lead fresh-token cost as an explicit operational caveat.

This review lane is now released and remains read-only.
