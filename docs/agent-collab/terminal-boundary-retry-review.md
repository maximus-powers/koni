# Terminal-boundary retry review

**Owner:** `terminal-boundary-retry-review/root`  
**Scope:** read-only direct-Pi host/Rust catalog design review  
**Status:** recommendation complete; source remains owned by the integrator/implementer

## Recommendation

Add one compiler-authored, transcript-visible correction prompt inside the **same accepted runtime
turn** after the first Pi agent loop has fully settled, but only for sessions whose claimed Rust
broker catalog explicitly declares terminal tools. Do not turn the model's prose into an output or
tool call. After the correction agent loop settles, continue directly to the existing single
`turn_completed` reconciliation; never evaluate the correction predicate a second time.

The stable seam is `runtime/pi-host/src/runtime.ts:632-648`: the first
`await session.agent.prompt(message)` has returned, Pi has exhausted its ordinary tool/follow-up
loop, and `await session.eventChain` has published the complete transcript and usage, while
`terminalEventPending` has not yet been set. A second `agent.prompt(compilerCorrection)` here keeps
the same session transcript, tools, cumulative output budget, usage, broker receipts, runtime turn
ID, and terminal latch. It is safer than enqueueing from `message_end`, where an ordinary queued
follow-up may still mean the agent has not actually stopped.

"Exactly one follow-up" should mean exactly one compiler-injected correction prompt. Pi may still
perform its normal tool-result continuation inside that one prompt; those calls remain bounded by
the existing runtime timeout, durable receipt ceiling, and per-tool rejection limits. If the
product requirement instead means exactly one additional provider HTTP stream even after a
nonterminal/malformed tool response, that is a different fail-fast policy and needs an explicit
post-correction provider-request latch. It would strand otherwise-correctable tool errors and is
not recommended for this repair.

## Wire contract and compiler derivation

Add this field to both Rust and TypeScript `RuntimeSessionStart`:

```text
terminal_boundary_tools: string[]
```

- Rust: `#[serde(default)] pub terminal_boundary_tools: Vec<String>`.
- TypeScript parser: missing means `[]`; otherwise require an array of at most eight unique tool
  IDs, using the same safe-ID grammar as tool names, and require every entry to be an exact member
  of the already parsed `tools` catalog. Preserve compiler/grant order.
- Empty means artifact/read-only mode and disables automatic correction. Nonempty means that the
  compiler expects an actual terminating broker outcome before the direct turn may succeed.
- This field grants no capability and must never come from persona text, profile text, agent IDs,
  or Node-side name guessing. It only describes a subset of capabilities already issued by Rust.

Derive the list from the **claimed and validated `AgentRuntimeToolCatalog`**, sharing the exact
`terminal_boundary_tool()` predicate that currently converts successful `compile`,
`submit_and_compile`, and `yield_lead` calls into `AgentToolOutcome::Terminate`
(`agent_tool_broker.rs:283-287,649-651`). Expose that filtered list from the concrete durable
broker before `spawn_direct_pi_agent` constructs `RuntimeSessionStart` (`engine.rs:58560-58576`).
Do not rederive it from `PiAgentSpawnSpec.broker_role`; a second role switch can drift from the
actual grant.

The resulting current catalogs are:

- worker: `submit_and_compile`, `compile` (not `submit_output`);
- every Lead slice: `yield_lead` (the boundary action such as `finish` or `review` remains
  nonterminal until Lead yields);
- read-only planning/review launched through `agent.rs:841-862`: empty.

This agrees with the final Rust product check: a direct worker/Lead succeeds only if the durable
grant is `Consumed`, has no in-flight operation, and passes terminal product validation
(`engine.rs:58690-58701`).

## Exact host predicate

After the first prompt and event-chain drain, issue the correction only when all of these are true:

1. `session.terminalBoundaryTools.length > 0`;
2. `session.terminalToolCallId === undefined` (actual broker outcome, not prose or a tool name);
3. `session.cancelRequested === false`;
4. `session.outputBudgetExhausted === false`;
5. the final state message has `role === "assistant"`;
6. its `stopReason === "stop"` (exclude `length`, `error`, and `aborted`);
7. it contains at least one `text` block whose `text.trim()` is nonempty; and
8. it contains zero `toolCall` blocks.

The predicate intentionally examines only the **final** assistant message. Earlier successful
reads, checks, edits, notes, or Lead actions do not disqualify the correction: the purpose is to
recover a turn that did useful work and then ended in prose. A terminal outcome already aborts Pi,
is latched at `runtime.ts:755-817`, and normally leaves a terminal tool result last, so both the
explicit latch and message shape fail closed.

Use a fixed compiler-authored correction whose only interpolated data is the validated ordered
terminal-tool list, for example:

> Your previous response ended in prose without the required compiler terminal boundary. Continue
> the same compiler-issued assignment using the existing transcript, product state, and tool
> receipts. Do not repeat completed effects or finish with another prose summary. Invoke the
> appropriate issued terminal tool before stopping. Issued terminal tools: [...].

Set no accepted-output state from the prose and call no broker tool on the model's behalf. The
original prose and correction remain separate semantic transcript messages.

The second prompt must reuse `session.activeUsage` and `activeOutputTokenBudget`; the existing
stream function already subtracts cumulative output before every provider request
(`runtime.ts:364-398`). If fewer than the provider minimum tokens remain, that stream function
must stop locally and the runtime must report `output_token_budget`, not exceed the cap. Publish
only the existing one `turn_started` and one `turn_completed` for the outer runtime turn.

## Safety and compatibility disposition

- **No automatic effects:** only the model can author a tool call, and Rust remains the sole tool
  authority. Prose never becomes a receipt or accepted output.
- **No blind replay:** the correction says to use current state/receipts. Exact receipt replay,
  whole-file CAS, grant sequencing, and terminal consumption remain authoritative if the model
  nevertheless repeats a call.
- **No recursive recovery loop:** the source contains one conditional second prompt and no loop or
  post-correction predicate. A second prose answer falls through to Rust's existing missing-terminal
  supervision failure.
- **Planning is unaffected:** its compiler-built session carries an empty list even if future
  planning prompts mention words such as "compile" or "finish".
- **Old isolated run after guarded refresh:** compatible and fail-safe. `RuntimeSessionStart` is an
  ephemeral host command, not durable run state. New Rust plus its embedded new host constructs the
  field for every replacement process from the claimed catalog. Historical accepted worker
  catalogs already contain `submit_and_compile`/`compile`; current Lead catalogs contain
  `yield_lead`, so catalog-based derivation works without changing their authority. An older
  serialized/session fixture missing the field deserializes as empty and simply retains the old
  no-correction behavior. The current Node parser reconstructs known fields rather than rejecting
  unknown ones, so a new Rust field sent to an old host is also ignored safely. A live old Pi
  process cannot be binary-refreshed in place and must still be drained/paused under the existing
  guarded-refresh procedure.

## Focused test matrix

| Layer | Case | Required assertions |
| --- | --- | --- |
| TS validation | field absent / empty | Parses to `[]`; ordinary read-only prose uses one provider call |
| TS validation | malformed list | Reject non-array, duplicate, unsafe ID, over eight, or name absent from parsed tools before session start |
| Rust catalog | current worker | Exact ordered terminals are `submit_and_compile`, `compile`; `submit_output`, file, check, and note tools excluded |
| Rust catalog | all Lead boundary variants | Exact terminal list is only `yield_lead`; action tool is excluded |
| Rust catalog | pre-edit/minimal historical worker views | Existing compatible catalogs still derive their present terminal tools without gaining `edit_file` or other authority |
| Host happy path | first response is plain prose; correction calls terminal tool | Provider starts twice; correction is a user transcript message; broker sees only model-authored terminal call; one outer `turn_started`/`turn_completed`; cumulative usage includes both; no runtime error |
| Host bounded failure | first and correction responses are plain prose | Exactly two provider starts and one injected correction; no third prompt; one terminal event; Rust-side terminal validation remains red |
| Host planning exclusion | empty terminal list + identical prose | Exactly one provider start; no correction text |
| Host already terminal | first response calls a terminal tool returning `terminate` | Exactly one provider start; no correction; late tools/events remain suppressed |
| Host useful-work recovery | first Pi loop executes nonterminal read/edit/check/note calls and finally emits prose | One correction only after the complete first loop; prior tool results remain in its context; no tool call is auto-replayed |
| Host message shape | whitespace-only, empty/thinking-only, `length`, provider `error`, or `aborted` final assistant | No correction |
| Host cancellation | cancel is accepted before the correction branch | No correction; one `turn_completed` with `aborted` |
| Host budget floor | first prose leaves 1..15 Codex output tokens | No second provider stream; no cap overrun; terminal stop reason is `output_token_budget`; exact first usage preserved |
| Host budget accumulation | enough budget remains | Second request receives only the remaining output allowance; terminal usage equals the sum of both assistant messages and still separates cached input correctly |
| Host retryable terminal error | correction attempts terminal tool but broker returns retryable validation feedback | Normal Pi tool-result handling may continue inside the one correction prompt; no second compiler-injected correction; existing rejection bounds still stop repeated invalid calls |
| Rust composition | direct worker/Lead `RuntimeSessionStart` | Field equals concrete durable broker catalog filter; read-only planner constructor explicitly supplies empty |
| Rust terminal product | correction succeeds / correction stays prose | Successful correction leaves grant consumed and product-bound; prose-only correction still fails `validate_agent_broker_terminal_boundary` without fabricating output |

## Risk verdict

- **P0:** none found for the design above.
- **P1 if violated:** inferring terminal requirement from persona/prompt/name heuristics can spend
  planning tokens; retrying `length`/error/abort/budget exits can exceed authority or budget;
  treating prose or a merely attempted tool as terminal can fabricate success; reevaluating the
  predicate after the correction creates a token loop; resetting usage between prompts breaks the
  provider cap; deriving the list separately from role can drift from durable grant semantics.
- **P2:** an explicit semantic event such as `terminal_correction_started` could improve telemetry,
  but the transcript-visible compiler user message is sufficient for the bounded repair.

No source, live state, binary, process, cmux, worktree, or Git-ref changes were made by this review.

## Stable implementation disposition — 2026-07-16

The independently reviewed stable snapshot implements the recommended contract. Exact reviewed
fingerprints are:

- `agent_runtime.rs` `005476f5cf7f489f6e7542dde6bd380a7db649b8573668b4a5179e420beaa962`;
- `agent_tool_broker.rs` `05b5342c10045d6772051bfde513ff2793af039f8710ac6c2fbc1771fdd43988`;
- `agent.rs` `38ac833709ccdc94b52477567922c097c0e0ab90bcf3834b6cd6983bea0fef68`;
- `engine.rs` `dc713c3ed6a2dcb09f11509270ac4f714195a423e3196a4e2c55616584b74262`;
- `pi_runtime_state.rs` `5084ce088bb9c6211dfc18b1f41b34b48d4bbfe901c3f6c6e3b620e23fd94474`;
- Pi wire/validation/runtime/test `5fb50e24…0635`, `13ace87e…f979`, `e90faf99…db8d`,
  and `abce66ba…7778`; and
- generated embedded bundle plus manifest `5d8a43767ca53964d85ac7019f5eab7833e1af51ebc6e4281523575239a8c121`.

### Findings

- **P0: none.**
- **P1: none.** A mid-edit stop-reason issue was corrected before this snapshot: final assistant
  role/normal-stop/nonempty/no-tool eligibility now runs before the low-remaining-budget branch, so
  an error/length/empty response cannot be relabeled `output_token_budget`.
- **P2 tests only:** add a correction-specific assertion that terminal cumulative token buckets
  equal the two published usage events (including a nonzero cached-input fixture), a
  terminal-policy cancellation race, every Lead boundary variant, and an explicit unsafe-ID parser
  case. Production accumulation was not changed; the same `activeUsage` crosses both prompts, Pi
  state tests enforce separate cache buckets and terminal equality, compact `new tks` therefore
  remains uncached input plus output, and provider total remains the cache-inclusive measure.

Rust derives the ordered list from the already claimed `AgentRuntimeToolCatalog` through the same
predicate that wraps a successful call in `Terminate`; the direct worker/Lead constructor sends
that list beside an unchanged clone of the same catalog, while the read-only planning constructor
explicitly sends empty. The Node parser defaults absent input to empty and rejects duplicate,
over-eight, unsafe, or non-catalog names. The host performs one post-first-loop conditional second
prompt and never reevaluates it. Actual terminal outcome, cancellation, exhaustion, error, length,
empty prose, and tool-bearing final messages remain excluded; one outer runtime start/completion
and the existing cumulative budget remain authoritative. The correction is a visible user message,
not an output conversion or broker call. Surgical `edit_file` authority and replay semantics are
unchanged; its broker suite remains green.

### Independent verification

- Pi typecheck, **65/65** tests, artifact verification, and isolated bundle smoke passed.
- Broker suite passed **11/11**; Pi state suite passed **9/9**.
- Exact Rust backward-compatibility and catalog-projection regressions passed **1/1** each.
- `cargo fmt --all --check` and scoped diff whitespace checks passed.

Two preliminary `--exact` invocations used incomplete Rust module paths and selected zero tests;
they are excluded from evidence. The fully qualified exact reruns above selected and passed the
intended tests.

**Guarded-refresh verdict:** no terminal-boundary correction blocker. The snapshot is acceptable
for the isolated acceptance binary after the primary integrator completes the full composed gates
and follows the existing pause/drain, backup, atomic replacement, cockpit restart, and resume
procedure. This review authorizes no global install or unguarded live-process replacement.

The read-only review lease is released.
