# Deterministic Lead Audit

## Lease — 2026-07-16

`deterministic-lead-audit/root` owns this report only. The lane is a read-only architecture audit
of the current Lead orchestration/slice implementation and the preserved Medium-run evidence. It
will not edit source, profiles, other documentation, live state, binaries, processes, worktrees,
or Git refs. The audit will propose a replay-safe way to move deterministic compiler-boundary
transport out of model cognition while preserving independent planner/worker/reviewer cognition,
durable journals and recovery, user-visible Lead semantics/chat, configured orchestration actions,
and compiler authority.

Token accounting in this report follows the current contract: `new_tokens` is uncached input plus
output, provider total additionally includes cached input, and reasoning tokens are a subset of
output rather than an extra bucket.

## Executive verdict

The current Lead slice is not a coordinator. The compiler has already selected the complete
operation and its ticket before the Lead process starts; the model is permitted only to translate
that packet into the matching broker call and yield. The smallest safe change is therefore an
explicit, pinned run-type driver which lets the orchestration supervisor execute those same
configured actions directly. It must not create a second action language, a second effect journal,
or a compiler bypass.

The safe cut is:

1. Add `boundary_driver: legacy_lead | compiler` to the run-type orchestration policy. A missing
   field deserializes as `legacy_lead` so every historical/custom snapshot keeps its current
   semantics.
2. Extract the existing deterministic selection into a driver-neutral selector. In compiler mode,
   execute one compiler-selected, compiler-revalidated operation through the existing configured
   `start`, `spawn-worker`, `recover`, review, and `finish` paths. Existing action Journals,
   reviewer records, ticket state, and integration transactions remain the effect authorities.
3. Make configured review exactly resumable by its existing `ReviewInputBinding` before enabling
   compiler mode. Review is the one current boundary where a supervisor retry can otherwise create
   another independent model session for identical input.
4. Persist only one additional recovery-control fact: the last exact no-progress recovery cause
   fingerprint. It prevents an unchanged board from spinning through recovery forever; it is not
   an effect receipt.
5. Preserve a stable user-facing **Lead** row and chat as a semantic orchestration surface, while
   making it truthful: no model, reasoning level, PID, session, spinner, or token usage in compiler
   mode. It displays compiler activity and durable user steering, never invented assistant prose or
   reasoning.

Planner, ticket worker, and independent Reviewer cognition remain unchanged. A future coordinator
model is appropriate only for a new, explicitly compiler-issued `Decision` boundary whose output
is a validated choice—not for transporting already-selected effects.

## What the token evidence actually says

The user's accounting correction is right and materially important. The compact TUI metric is not
the provider headline total. The source contract computes:

```text
provider total = input + output
new_tokens     = (input - cached input) + output
reasoning      ⊆ output
```

That contract is explicit in `crates/koni-core/src/control.rs:242-272`. In the preserved Medium
trace, the broad run snapshot was approximately **1.5M new**, **5.4M cached input**, and **6.9M
provider total**. The 6.9M figure is therefore not 6.9M newly processed tokens, and reasoning must
not be added again.

This correction does not weaken the deterministic-Lead finding. The later durable audit counted at
least **82,968 new tokens**, **zero cached input**, across 66 Lead turns with usage
(`docs/agent-collab/live-medium-run-audit.md:127-150`). Those Lead packets prescribed
start/spawn/recover/review/finish and made no semantic choice. At an earlier generation-52
checkpoint, the same trace contained 49,865 uncached input plus 3,165 output = **53,030 new** Lead
tokens; reasoning was 1,583 of that output, not additional usage
(`docs/agent-collab/lead-cognition-audit.md:17-47`). The already-landed passive-wait repair removed
one historical class, but the remaining deterministic wrappers still had a measured 45,100-new-
token floor at that checkpoint. The optimization is justified by cache-excluding work, not by
mistaking cache reuse for fresh spend.

## Current architecture and why the boundary is deterministic

### Selection and slice state

`LeadSliceBoundary` currently has only six variants
(`crates/koni-core/src/control.rs:364-376`):

- `DispatchBatch { tickets }`
- `WaitWorkers { tickets }`
- `Recover`
- `SpawnWorker { ticket }`
- `Review { ticket }`
- `Finish { ticket }`

There is no decision payload, alternative set, ambiguity, or model-authored intent in any variant.
`next_lead_boundary` (`crates/koni-core/src/engine.rs:39899-39966`) ranks the board and chooses the
exact variant. The stage input hash already binds the run, stage definition, resolved run-type hash,
and complete orchestration policy (`engine.rs:40087-40099`). `LeadSliceState`
(`control.rs:386-413`) then binds that selection to a generation, one-way token hash, process
identity, raw agent record, action list, and accepted yield.

`drive_orchestration_stage_once` (`engine.rs:40139-40689`) owns the run barrier, pinned pipeline
attempt, compile action, board inspection, pause gate, selection, slice creation, configured Lead
launch, and process reconciliation. Passive worker waiting is already performed without a model at
`engine.rs:40532-40560`; that is the local proof that observation does not need a Lead process.

### The Lead broker is a deterministic adapter

The Lead arm of `execute_agent_broker_operation` (`engine.rs:44674-44784`) maps each compiler packet
to exactly one known implementation:

- dispatch calls configured `start`, then configured `spawn-worker`;
- spawn calls configured `spawn-worker`;
- recovery calls `execute_action("recover", ...)`;
- review opens the ticket worktree and calls `review_ticket`;
- finish calls configured `finish`;
- wait polls the issued ticket set;
- yield closes the already-completed slice.

`execute_broker_ticket_action` (`engine.rs:43237-43256`) resolves the profile action, chooses its
declared ticket parameter name, and delegates to `Engine::execute_action`. The compiler broker does
not grant the Lead discretion to discover another action. `commit_agent_broker_lead_operation`
(`engine.rs:44789-44858`) merely records that the exact issued operation crossed its capability
boundary.

### Existing effect authorities must remain authoritative

`Engine::execute_action` (`engine.rs:12498` onward) is the important boundary, not the Lead slice.
It validates the pinned profile and run identity, deletion/conclusion, quarantine, question pause,
change-control admission, checkout/worktree placement, and configured recipe. It writes a `Running`
Journal before recipe effects (`engine.rs:12718-12790`), checkpoints each completed recipe step
(`engine.rs:12924-12943`), and records `Complete` plus the compiler action event
(`engine.rs:14251-14284`). Finish additionally has the integration transaction boundary beginning
at `engine.rs:14354`. Those records already answer whether a real effect was prepared, in flight,
committed, failed, or recovered.

The compiler driver must call these configured paths. Calling primitives directly would silently
discard profile behavior: Software `start` acquires a lease and transitions the ticket, Research
`start` also validates scope, creates the worktree and compiles context; Research `finish` applies a
graph delta, snapshots, and integrates. `ActionDef.actor: lead` can continue to mean the semantic
role responsible for the event. It is audit vocabulary, not proof that a model must be the caller.

### Review is independently cognitive but not yet exactly resumable

`review_ticket_with` already computes a strong semantic `ReviewInputBinding` and hashes it at
`engine.rs:11140-11141`. It writes a Reviewer `AgentSessionRecord` before launch, binds the live PID
to the ticket, validates bounded structured output and evidence pointers, records `review_ready`,
then invokes the configured review action with `TicketReviewAuthorization`
(`engine.rs:11347-11579`). This independent judgment must remain.

The restart gap is at `engine.rs:11196`: the Reviewer record ID contains a fresh UUID. A second call
for the same current input does not first reconcile the prior `starting`, `running`, output-ready,
or publication state. A compiler driver must not expose that gap more frequently.

## Proposed compiler-boundary driver

### 1. Compatibility-gated policy

Add a serde enum beside `RunTypeOrchestrationPolicy` in
`crates/koni-core/src/catalog.rs:373-413`:

```rust
#[serde(rename_all = "snake_case")]
enum OrchestrationBoundaryDriver {
    LegacyLead,
    Compiler,
}
```

`boundary_driver` uses a default function returning `LegacyLead`, not `derive(Default)` whose future
ordering could accidentally change compatibility. It is included automatically in the existing
run-type hash and `orchestration_stage_input_hash`; a run therefore pins its driver.

Cross-reference validation at `catalog.rs:941-983` and local validation at
`catalog.rs:1881-1902` should enforce:

- `compile_action` and `report_action` remain required in both modes;
- legacy mode keeps requiring `lead_action` and positive `max_boundaries_per_lead`;
- compiler mode must not silently ignore a custom `lead_action`. For the first release, accept only
  the canonical/default `spawn-lead` compatibility value and reject another value with an explicit
  “legacy-only in compiler driver” diagnostic;
- compiler mode validates that the profile resolves `start`, `spawn-worker`, `recover`, `finish`,
  and the configured review action/recipe through the same public-action resolution used today;
- `max_boundaries_per_lead` is compatibility-only in compiler mode and the TUI/config editor labels
  it that way rather than implying it controls compiler work.

Keep `spawn-lead` in bundled profiles while old snapshots may still execute. Do not remove the Lead
MCP/CLI tools, broker grants, slice readers, or reconciliation code during this rollout.

### 2. A driver-neutral selector with atomic effects

Extract the board logic from `next_lead_boundary` into a driver-neutral typed selection such as:

```text
StartTicket(ticket, binding)
SpawnWorker(ticket, step, binding)
WaitWorkers(tickets)
Recover(cause_fingerprint)
Review(ticket, step, review_input_hash)
Finish(ticket, binding)
Terminal | Blocked(reason)
```

Legacy mode adapts these facts into the existing `LeadSliceBoundary` protocol without changing its
wire format. Compiler mode executes one real effect, reacquires authority, re-inspects, and selects
again. It should never persist a second “boundary journal”; its correlation key is attached to the
existing action Journal or Reviewer record.

There is one non-obvious ordering requirement. The existing selector returns `WaitWorkers` as soon
as any worker is live. That works because one `DispatchBatch` Lead starts and spawns every ticket in
the batch before yielding. A naive one-action compiler replacement would start/spawn the first
ticket, observe a live worker, and serialize every Medium/Large run.

Compiler mode must instead reproduce batch filling as replay-safe pairs:

1. With no unresolved recovery and free capacity, select the highest-ranked eligible ticket and
   execute its configured `start` action.
2. Re-inspect. The newly active ticket's ready non-review step selects configured `spawn-worker`.
3. Re-inspect. If capacity remains, admit the next ranked eligible ticket even while earlier
   workers are live, then spawn its worker.
4. Once capacity is full or no ticket is eligible, passively wait.

Review, recovery, and finish stay deferred while unrelated workers are live, preserving today's
coarse ordering. A started ticket owns an admitted slot; a later reduction in `max_parallel` does
not strand it before spawn, while it prevents any further `StartTicket`. A pause is stronger: after
the currently running action/model reaches its durable boundary, no new start, spawn, review, or
finish begins until play resumes.

One supervisor call may execute a single effect and return, or loop through a small internal work
budget. Either way, it must re-inspect after every action and must never treat
`max_boundaries_per_lead` as that budget. One-effect-per-tick is the simplest first release and
still fills parallel capacity across ticks because live workers no longer mask eligible dispatch.

### 3. Exact correlation without a parallel journal

The `Engine` already carries private `compiler_action_context`; the Lead launch uses it for hidden
slice bindings at `engine.rs:40600-40615`. Reuse that seam with a typed compiler-driver context
whose normalized effect key includes:

- run ID, orchestration stage ID and attempt, and stage input hash;
- selected configured action and ticket;
- current ticket semantic hash, ready step/persona, and causal receipt/output binding where
  applicable;
- current graph semantic hash for graph-dependent admission;
- the exact review input hash or recovery cause fingerprint for those boundary kinds.

Hidden context is included after public parameter validation and therefore participates in the
action Journal input hash. Add a driver-specific correlated replay check in `execute_action`:

- exact `Complete`: validate that its result is still current, project the prior outputs, and do
  not execute the recipe again;
- exact `Running`/`Compensating`: expose recovery-required/waiting, never start a duplicate;
- exact `Failed`: require configured recovery before a retry;
- exact `Recovered`: a new attempt is allowed and remains linked by the same logical input.

Do not apply that deduplication globally to every action: some manually requested actions are
legitimately repeatable. Gate it on the private compiler-driver context. Existing action Journals
remain the sole effect receipt.

Before `execute_action` mints a Journal, it must revalidate that private context under the action's
own run barrier and compiler lock: exact pipeline attempt/input, live registration, no deletion or
conclusion, no question pause, `orchestration.running == true`, ticket/current-step binding, and
current capacity for `StartTicket`. This closes the present release/reacquire window between
selection and action. Review performs the equivalent pre-launch revalidation under its review
barrier. Once a worker or Reviewer has started, a later pause lets it drain; deletion/conclusion
still wins before semantic publication through the existing identity checks.

### 4. Exact Reviewer resumption

Refactor `review_ticket_with` before compiler-mode rollout. Define one exact review identity from
run, ticket, step, persona, pinned profile/run type, `ReviewInputBinding` hash, output schema, and
read-scope binding. A stable record key can include the hash; retry attempts live below that stable
logical record rather than producing unrelated UUID records.

Under the review barrier, scan exact matching records before launch:

- **zero**: create `prepared/starting`, write prompt/schema/paths, then launch;
- **one `starting`/`running` with a live owned process**: wait;
- **one terminal process with a durable completed turn and valid output**: parse and validate that
  same output; do not call the provider again;
- **`review_ready` or `application_failed`**: recreate the same
  `TicketReviewAuthorization` and retry/reconcile only the configured review action;
- **configured review Journal complete but record not `accepted`**: validate current ticket review
  and reconcile the diagnostic record;
- **one terminal no-output attempt**: enter the existing bounded worker/reviewer failure circuit;
  only a circuit-authorized retry may create the next attempt;
- **more than one live/nonterminal exact match or conflicting output hashes**: fail closed as
  ambiguous.

A failed semantic verdict still follows the configured rework workflow. “Resume” never means
reusing a verdict after its input binding changed.

The current synchronous launcher is acceptable: cockpit supervision invokes it from its mutation
worker while refresh is separate. The correctness requirement is exact resumption, not converting
review to a second scheduler.

### 5. Bounded no-progress recovery

Extend `OrchestrationState` (`crates/koni-core/src/control.rs:346-362`) with one optional, serde-
defaulted typed checkpoint for the latest no-progress recovery. Its cause fingerprint should be a
normalized set of authoritative unresolved facts, not timestamps or fresh recovery Journal IDs:

- non-recovery incomplete/failed Journal logical keys (`action`, input hash, state, stable error
  hash);
- incomplete integration transaction identity and bound heads;
- dead worker/reviewer assignment, attempt, process identity, and lease state;
- ticket workflow recovery causes and exact semantic bindings;
- pipeline stage attempt/input and relevant graph/ticket state.

Canonicalize repeated recovery-action failures by logical input and stable diagnostic, otherwise a
fresh failed recovery Journal ID would change the fingerprint and permit an infinite loop.

After configured `recover` returns, re-inspect. If the authoritative cause set is unchanged, store
the no-progress fingerprint and set the semantic Lead/stage to `awaiting_operator`. The same
fingerprint cannot execute recovery again. A new steering event, changed ticket/graph/lease/process
identity, newly failed action, or other real cause change produces a new fingerprint and permits
one attempt. A progress-making recovery clears the checkpoint. This state throttles retries; the
recovery action Journal remains the authority for what actually ran.

## Truthful Lead semantics and chat without a Lead model

The TUI already recognizes the stable aggregate record `orchestration-<stage>` as the semantic Lead
and suppresses raw per-slice duplicates (`crates/koni-tui/src/model.rs:679-755`). Preserve that key
and persona so the user's mental model and selection do not jump during an upgrade.

In compiler mode, `lead_agent_record` (`engine.rs:39816-39866`) should instead project:

- `persona: lead`, stable stage ID, `model: null`, `reasoning_effort: null`;
- no Codex/Pi session, PID, process identity, prompt, or model output;
- `result.orchestration_driver: compiler`;
- semantic statuses such as `compiling`, `executing`, `waiting_workers`, `reviewing`,
  `between_boundaries`, `awaiting_operator`, and `completed`.

The row is semantic control-plane history, not a live agent. It must not increment
`active_agents`, animate a token-spend cog, or receive usage. The actual Reviewer appears as its
own live row during review. Existing TUI liveness already limits `live` to
`starting|running|resuming` at `model.rs:721`; retain that truthfulness.

Do not forge a model transcript. Project a bounded semantic chat from existing authoritative
events/Journals/reviewer records and the completed `steer` events, deduplicated by their source
keys. It can render compiler notices such as “Started Implement questionnaire,” “Reviewer checking
focused proof,” “Waiting for 3 workers,” or “Recovery made no progress,” plus the user's exact
guidance and a compiler acknowledgement that it was recorded for the next authorized context. It
must not emit `Assistant` or `Reasoning` blocks for compiler activity. Missing cosmetic projection
after a crash is reconstructed from its source receipt; the projection never authorizes an effect.

`agent_guidance_form` currently requires `agent.live` (`model.rs:2801-2806`). Split this into
`guidance_available` versus process liveness. A compiler-driven semantic Lead accepts run-level
steering whenever the run is live and not concluded, including passive wait; the configured
`steer` action remains the durable path. A worker/reviewer chat retains its existing ticket binding.
The user sees an acknowledgement, not an invented reply. A real model reply is reserved for a
future explicit `Decision` session.

Legacy aggregate records continue pointing to their real raw Lead logs. Historical Lead usage and
chat remain visible and are never relabeled as compiler activity.

## Exact source seams

| Seam | Required change |
| --- | --- |
| `crates/koni-core/src/catalog.rs:373-413` | Add the compatibility-defaulted driver enum/field. |
| `catalog.rs:941-983, 1881-1902` | Driver-aware action and legacy-field validation; clear diagnostics for custom Lead launchers. |
| `crates/koni-core/src/control.rs:346-413` | Add optional no-progress recovery checkpoint; retain all legacy slice types/readers. |
| `crates/koni-core/src/engine.rs:39816-39974` | Make semantic Lead projection driver-aware; extract driver-neutral selection and atomic capacity filling. |
| `engine.rs:40087-40689` | Branch orchestration stage driving by pinned driver; direct mode revalidates and calls existing configured effects, legacy mode remains byte/behavior compatible. |
| `engine.rs:12498-12943` | Recognize private compiler-driver correlation, revalidate it under authority, and reconcile exact action Journals. |
| `engine.rs:11015-11579` | Add exact-input Reviewer record discovery/resumption and publication reconciliation. |
| `engine.rs:43237-43256, 44674-44858` | Extract the configured effect adapter for reuse; keep legacy broker commit logic unchanged. |
| `crates/koni-tui/src/model.rs:679-775, 2801-2835` | Preserve semantic Lead row, distinguish liveness from guidance availability, and exclude compiler activity from token/active-agent cues. |
| `crates/koni-tui/src/agent_chat.rs` | Render typed compiler notices/user steering without fake assistant/reasoning blocks. |
| bundled Software and Research run types | Explicitly pin `boundary_driver: compiler` only after the compatibility/replay gates pass. Keep `spawn-lead` actions for legacy snapshots. |

The Lead CLI/MCP/broker surface is deliberately absent from the deletion list. It remains an
execution dependency for pinned legacy runs and a reader dependency for historical state.

## Required test matrix

### Selector, concurrency, and authority

1. Reuse existing board fixtures to prove the driver-neutral selector preserves ticket ranking and
   the legacy adapter emits the same boundaries.
2. Starting from three eligible tickets at `max_parallel: 3`, prove direct mode executes
   `start A, spawn A, start B, spawn B, start C, spawn C`, re-inspecting between each action, then
   passively waits. It must not stop filling capacity because A is live.
3. Reduce capacity between every pair: no new ticket is admitted above the new cap; an already
   admitted ticket may receive its worker. Pause at every seam: no new model/effect begins after
   pause, while an owned live worker/Reviewer can publish its terminal boundary.
4. Use sentinel custom recipes for Software and Research to prove the driver calls configured
   actions, preserves actor/event/compensation behavior, and cannot invoke primitives directly.
5. Race deletion, conclusion, registration loss, question pause, target branch/config drift, and
   two supervisor callers against each operation. They must fail closed or reconcile one existing
   receipt, never create a second effect.

### Crash/replay matrix

For `start`, `spawn-worker`, `recover`, and `finish`, interrupt:

- before Journal creation;
- after `Running` Journal creation;
- after each recipe checkpoint;
- after `Complete` but before semantic Lead projection;
- for finish, after Git transaction/commit but before Journal/event/ticket closure.

Every case must converge through the existing Journal/integration recovery to one semantic effect.
The cosmetic Lead activity projection may be reconstructed but cannot cause a retry.

Recovery tests need identical-cause/no-progress, progress with remaining causes, repeated recovery
failure with fresh Journal IDs but the same logical diagnostic, and a genuine new cause/steering
fingerprint. Only the last case may reopen recovery.

### Reviewer restart matrix

Interrupt exact-input review at `prepared`, `starting`, live process, completed turn before output
parse, valid output before `review_ready`, `review_ready` before action, review action `Running`,
review action `Complete` before `accepted`, and diagnostic publication after concurrent deletion.
Assert one provider result and one applied verdict. Add ambiguous duplicate records, changed input,
failed semantic verdict/rework, terminal no-output circuit, and output-schema/read-scope changes.

### Compatibility and presentation

1. Deserialize old run-type snapshots with no driver and assert `legacy_lead`; execute preserved
   `Spawning`, `Active`, broker-in-flight, committed-before-yield, and `Yielded` slices through the
   current reconciliation path.
2. Preserve custom legacy `lead_action`, slice grants/receipts, historical transcripts, and usage.
   Reject rather than ignore a custom launcher in compiler mode.
3. Assert compiler mode creates zero Lead provider sessions, raw Lead processes, slices, or Lead
   token deltas across complete Software and Research fixtures, while Planner/worker/Reviewer
   settings and outcomes are unchanged.
4. TUI tests keep one stable Lead row between boundaries, mark it non-live, show actual Reviewer
   liveness separately, accept run-level guidance during wait, render compiler notices without
   assistant/reasoning attribution, and preserve legacy chat.
5. Token tests assert `new_tokens = uncached input + output`, provider total includes cached input,
   reasoning is a subset of output, and compiler events never increment any model bucket.
6. Catalog/template tests cover driver hashing, source/template parity, unknown actions, compiler-
   mode legacy-field diagnostics, and Software/Research opt-in.

## Migration and staged rollout

### Stage 0 — behavior-neutral extraction

Add the enum with `legacy_lead` default, extract selection/effect-adapter helpers, and keep every
bundled run type legacy. Golden tests must show no serialized historical state or runtime behavior
change.

### Stage 1 — Reviewer recovery first

Land exact-input Reviewer reconciliation under the existing Lead flow. Exercise all interruption
states before any driver can call it automatically. This independently reduces duplicate Reviewer
spend and removes the largest correctness prerequisite.

### Stage 2 — compiler driver behind explicit opt-in

Implement direct execution and semantic Lead projection, but enable it only in dedicated test run
types. Prove action-recipe sentinels, crash matrices, pause/capacity behavior, and zero Lead model
usage.

### Stage 3 — bundled profiles, new runs only

Explicitly set `boundary_driver: compiler` in the bundled Software and Research small/medium/large
run types. Existing pinned runs with the missing field remain legacy. Do **not** rewrite an active
run's policy, convert an active slice, consume/revoke its grant merely for migration, or reinterpret
its transcript.

### Stage 4 — clean canaries

Run one new Medium Software canary and one Research canary from clean state. Compare ticket order,
parallel occupancy, worker/reviewer inputs and verdicts, graph deltas, Journals, recovery, Git
integration, semantic Lead UX, and token partitions against legacy fixtures. The direct runs should
have zero Lead model usage; cache-inclusive provider totals remain reported separately.

### Stage 5 — deprecation, not deletion

Only after old snapshots no longer require execution should new configuration stop advertising
legacy mode. Historical readers and transcript rendering can remain indefinitely. An optional
future in-place migration would require a quiescent run, no slice/grant/broker in flight, exact
pipeline input rebind, and its own compiler-authored migration receipt; it is unnecessary for the
first release and should not be inferred from a pause.

## Risks and rejected shortcuts

- **Do not launch a cheaper Lead model.** It still spends tokens and leaves an avoidable provider,
  auth, process, grant, and crash boundary around a predetermined call.
- **Do not add an orchestration-effect journal.** It would disagree eventually with action
  Journals, Reviewer records, or integration transactions. Correlation belongs on those existing
  authorities.
- **Do not call action primitives directly.** Profiles intentionally vary their recipes and safety
  checks.
- **Do not globally dedupe actions by params.** Some compiler/user actions are repeatable; exact
  replay is gated by the private orchestration effect binding.
- **Do not naively keep `WaitWorkers` first in atomic mode.** That silently collapses configured
  parallelism to one worker.
- **Do not treat the semantic Lead as a live model.** A stable control-center object is useful; fake
  provider identity, reasoning, transcript, or token usage is not.
- **Do not remove Lead configuration yet.** Lead model defaults can remain as dormant configuration
  for a future explicit `Decision` boundary and are required by legacy snapshots in the meantime.

## Disposition

This lane made no source, profile, test, run-state, binary, process, worktree, branch, ref, or TUI
change. The report is the only write. Implementation ownership is released; any implementation
should take narrow leases in the exact seams above and coordinate with active runtime/profile/TUI
lanes before editing shared files.
