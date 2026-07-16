# Context observation/budget post-fix review

Reviewer: `context-fix-reviewer/root`

Reviewed snapshot: 2026-07-16 10:10 MST

Status: **changes requested — three P1 domains block guarded release; no P0**

## Scope and non-authority

This was an independent read-only review of the corrections described by
[`context-observation-budget-fix.md`](context-observation-budget-fix.md), against the two original
P1s in [`context-read-discipline-review.md`](context-read-discipline-review.md). It inspected the
provider-neutral context cursor, durable grant/receipt reservation, context-pack construction and
Worker dispatch order, direct-Pi batch execution and wire contract, Worker/Lead/historical grant
projection, bundled Software actions and Implementer copy, and focused tests. It did not edit
production source, profiles, runtime assets, binaries, installed projects, live runs, fixtures,
processes, cmux, worktrees, or refs. This report and the adjacent central-ledger entry are the only
review writes.

## Verdict

The direct-Pi happy path is materially improved. For a new policy-enabled Worker, a successful
full context result establishes a local latch before any later sibling can reach Rust; every exact
continuation does the same, including EOF; and `streamFn` clears only the observation latch at the
next provider request while retaining the paging cursor. The two focused Pi adversaries pass and
prove the next informed provider request can continue. The straight-line arithmetic is also
correct: a 4,000,000-byte UTF-8 document, 32 KiB requests, and at most three bytes of boundary
rollback require at most 123 page-bearing deliveries, or 124 with a path-only recovery result.

The implemented system does not yet enforce that straight-line model on its actual lifecycle or
call graph. Software can start the model before it discovers that the context is oversized,
repeated `context` calls can rewind the cursor and spend more than the advertised context
allowance, and both the Pi latch and new global size cap bypass the optional policy that was meant
to preserve historical behavior. Those are P1 correctness/upgrade blockers for a harness whose
guarded refresh promises not to waste tokens or strand resumed work.

## P1 findings

### P1 — Software rejects an oversized context only after Worker/provider dispatch

`compile_context` checks the 4,000,000-byte bound before writing its pack
(`crates/koni-core/src/engine.rs:23317-23330`), but that is not necessarily before Worker dispatch.
The bundled Software `start` action leases and transitions the ticket without compiling context
(`crates/koni-cli/templates/software/actions.yaml:39-52`). Its exact selected-step context is first
compiled only when the already-running Worker calls `koni_runtime.context`, through
`execute_agent_broker_operation` and the Software `context` action
(`engine.rs:45537-45570`; `actions.yaml:53-62`). No other production call to `compile_context`
preflights the selected step before the grant/process is issued.

Therefore the first byte above the cap can create a grant, launch Pi, spend a provider response,
and only then return a nonretryable context failure. The test named
`context_budget_pages_largest_multibyte_document_and_rejects_next_byte` merely calls the size
helper and asserts its error text (`engine.rs:95025-95038`); it does not execute Software
start/spawn or prove absence of a grant, agent record, process, or token usage. The source comment
and docs claiming rejection before Worker eligibility are false for the primary coding profile.

Minimum correction: once the compiler has selected the exact ticket step/persona but before grant
or process publication, build or preflight that same context projection and fail the dispatch
transaction closed. Preserve replacement-worker reissuance over authorized dirty in-scope work.
Add an end-to-end Software regression proving an oversized exact context leaves no broker grant,
AgentSessionRecord/Pi process, or provider usage.

### P1 — repeated large-context delivery can exceed 128 receipts and erase the product reserve

The receipt math assumes one monotonic pass. The broker instead admits `context` in every
incomplete state (`agent_tool_broker.rs:240-250`), and `observe_success` applies any paged context
response regardless of whether the cursor is already `Paging` or `Complete`
(`agent_tool_broker.rs:316-361`). `Complete` also returns early from `gate`, so a repeated context
remains dispatchable. Direct Pi mirrors this behavior: every successful `context` response replaces
its local continuation cursor (`runtime/pi-host/src/runtime.ts:183-207`).

A Worker can therefore:

1. receive the preview;
2. request the first continuation with `max_bytes:32768`;
3. replay `context`, which is the same durable receipt but rewinds both cursors;
4. request the same offset with `max_bytes:32769`, producing a distinct durable `read_file`
   receipt; and
5. repeat with other allowed page sizes until the 256-receipt grant is exhausted.

This crosses the claimed 128-receipt delivery allowance and can leave no terminal/product
capacity. Prompt copy saying “exactly once” is not an enforcement boundary. Recovery does not
require cursor regression inside one broker session: a fresh recovered broker begins at
`AwaitingContext` and can reconstruct from exact durable replay.

Minimum correction: make context observation one-shot and cursor advancement monotonic within a
broker/runtime session. Repeated context during `Paging` or after `Complete` must not regress either
cursor or create a new required delivery route. Add differing-page-size adversaries during Paging
and after Complete, plus a real durable-receipt assertion that context delivery cannot exceed its
allowance. Preserve fresh-broker `already_issued` recovery from exact offset zero.

### P1 — policy-absent historical Workers are changed by both the Pi latch and the 4 MB cap

The optional `context_policy` correctly preserves historical grant serialization and makes
`AgentBrokerIngressView.context_completion_required` false. That flag is not carried in
`RuntimeSessionStart`, however. Pi infers context delivery solely from tool name and any successful
outcome, so a production direct-Pi historical Worker with no policy still skips later
same-message siblings. A low-remaining-output-budget legacy Worker can consequently lose its
terminal sibling and fail before another provider request. The current historical regression
exercises only Rust grant/catalog behavior, not the direct-Pi host.

The size change has the same compatibility problem. The former 64 MiB ceiling has been replaced by
one global 4,000,000-byte validator. `compile_context` invokes it for every projection, including
unscoped observer/Lead packs, and `broker_context_tool_response` invokes it before transport or
policy distinctions. An already-issued policy-absent context between those bounds now fails, and a
large unscoped observer/Lead context also changes despite the handoff's “historical grants and Lead
grants remain unchanged” claim.

Minimum correction: carry the hash-bound context-completion policy explicitly into the Pi
start-session contract and activate the observation latch/cursor only when it is true. Add direct-Pi
legacy-false and Lead regressions. Scope the receipt-derived 4 MB preflight/delivery cap to new
policy-enabled Worker contexts, retain a bounded historical/observer behavior, or perform an
explicit compatible migration before refresh. Do not infer policy from mutable prompt or tool
description text.

## Accepted properties

- New Worker grants opt into `CompleteBeforeProduct`; Lead grants reject that grant field.
- Absent historical policy remains omitted from YAML and its normalized grant hash.
- The broker's pre-EOF partition is now default-closed: only `context`, its exact continuation,
  `graph_context`, and `record_note` can cross; future Worker tools do not silently gain product
  authority.
- Exact continuation requests require the current path/offset and at least 32 KiB. Valid responses
  preserve the path, offset, SHA identity, and non-EOF forward progress.
- One-byte product reads at a multibyte scalar make scalar progress rather than returning an empty
  non-EOF page.
- The Worker assignment, runtime catalog descriptions, and bundled Software Implementer teach EOF,
  observation, minimum-page, search-first, and retained-result behavior consistently.
- The Pi latch precedes retryable-error handling, does not dispatch stale siblings, and is cleared
  at the provider-request boundary rather than after mere sequential execution. Existing terminal
  and retryable latches remain separate.

## Nonblocking hardening and coverage gaps

- **P2 — malformed trusted responses can still fail open.** An initial
  `status:paged,eof:true` response marks context complete before validating a string document,
  path, offset, or SHA. An EOF continuation validates path/offset/SHA but not that its content and
  terminal offset actually deliver the remaining bytes. Production currently constructs valid
  responses, so this is trusted-boundary defense rather than a demonstrated external escalation,
  but the “malformed cursor fails closed” test matrix is incomplete.
- **P2 — observation coverage omits two named boundaries.** Tests cover full initial delivery and
  middle/EOF continuations, but not a paged initial response with a product sibling or a path-only
  `already_issued` recovery response with a sibling. The implementation shape covers both once the
  policy/monotonic fixes land; explicit regressions would prevent drift.
- **P2 — maximum-budget evidence is arithmetic-only.** No test sends the largest accepted context
  through a real grant, persists every page receipt, retains 128 usable non-context slots, and
  rejects the first over-bound context through the actual dispatch transaction. The existing real
  direct-Pi paging test uses a much smaller document.
- Search results still omit a UTF-8 byte offset/current file hash, so the search-to-narrow-read
  instruction remains ergonomic guidance rather than a complete random-access primitive.

## Independent verification

- `npx vitest run test/runtime.test.ts -t 'makes a successful full context result an observation
  boundary before product work|makes every paged context continuation including EOF an observation
  boundary'` — **2/2 passed**.
- Exact source inspection proves the straight-line constant arithmetic (`123`, recovery `124`,
  allowance `128`, total `256`) and the three lifecycle/call-graph counterexamples above.

No guarded refresh should include this context lane until all three P1 domains have independent
focused regressions and a composed serialized gate.
