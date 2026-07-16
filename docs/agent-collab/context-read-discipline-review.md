# Context/read-discipline independent review

Reviewer: `context-read-independent-review/root`

Reviewed snapshot: 2026-07-16 09:32 MST

Status: **changes requested — two P1s block guarded release; no P0**

## Scope and non-authority

This was a read-only review of the released context/read-discipline lane. It inspected the optional
`AgentBrokerGrant.context_policy`, claim/catalog projection, provider-neutral cursor and gate,
direct-Pi tool-batch behavior, exact context paging, grant receipt limits, historical/Lead behavior,
the bundled Software Implementer copy, and focused tests. It did not edit source, profiles, runtime
artifacts, binaries, live Updog state, worktrees, refs, processes, or cmux.

## Verdict

The source correctly adds a hash-continuity cursor to new direct-Pi Worker grants, preserves absent
policy serialization for historical grants, excludes Lead grants, gates the complete current Worker
product-tool set, bounds the premature-call correction to one retryable result, and preserves Pi's
existing retryable-error sibling quarantine. The focused happy paths pass.

Two current production invariants remain false, however:

1. broker execution reaching EOF is not the same as the model observing the context before it
   authors product work; and
2. the advertised 64 MiB context-document bound cannot be paged within the 256-receipt grant.

Both can strand or misdirect a valid Worker without crossing filesystem scope, so they are P1
correctness/cognition blockers rather than P0 authority escalations.

## P1 findings

### P1 — a same-message product sibling can execute before the model has seen context

The direct Pi host configures `toolExecution: "sequential"` at
`runtime/pi-host/src/runtime.ts:365`. Sequential means sibling effects are invoked in order; all
calls in that assistant message were still authored before any sibling result reached a new model
request. The host quarantines later siblings only after an outcome with `retryable: true`
(`runtime/pi-host/src/runtime.ts:820-857`). A successful `context` or final context-page result does
not establish such a boundary.

The broker marks the cursor `Complete` as soon as a full context response contains `document`, or
the exact continuation returns `eof:true` (`crates/koni-core/src/agent_tool_broker.rs:281-339` and
`:350-395`). The next sibling call therefore passes `gate` because `Complete` is admitted at
`:234-241`. For an ordinary context of at most the 32 KiB preview threshold, a model-authored batch
such as:

```text
context({}), read_file({path: an issued product path})
```

dispatches the product read even though the model has observed zero bytes of the returned context.
The assignment already discloses exact read/write paths in `scope_prompt`
(`crates/koni-core/src/engine.rs:28317-28330`), so the second call need not guess an unknown path.
The same issue applies to a product sibling after the final continuation: the tail reaches the
broker but not the model before that sibling was authored.

This defeats the purpose of the read-discipline gate and permits avoidable uninformed edits,
checks, or submission attempts. It is especially relevant because Pi and the OpenAI provider can
emit multiple tool calls in one assistant message.

Minimum correction: make every successful compiler-context delivery a provider-observation
boundary. Later calls from that same model-authored batch must be rejected/quarantined without
dispatch, and the next provider request may proceed from the transcript containing the result.
This must cover both the initial full/paged `context` result and every exact context continuation,
including the page that reaches EOF. Preserve sequential execution and the existing product CAS;
do not treat execution order alone as observation.

Required adversarial regression: have one faux Pi assistant message emit `context` followed by a
valid product call and prove only `context` reaches the broker; then prove the next provider request
can issue the product call. Repeat with a final context continuation plus product sibling.

### P1 — valid large contexts exhaust the grant before EOF

The limits do not compose:

- compiler context documents may be up to 64 MiB
  (`crates/koni-core/src/engine.rs:42156`, enforced at `:43853-43859`);
- the initial direct-Pi preview is 32 KiB (`:42157` and `:43860-43873`);
- each `read_file` page accepts at most 64 KiB and defaults to 32 KiB
  (`crates/koni-core/src/agent_tool_broker.rs:1113-1126` and
  `crates/koni-core/src/engine.rs:45843-45862`); and
- one grant admits at most 256 durable tool receipts (`crates/koni-core/src/engine.rs:42154`), with
  new reservations rejected at `:46673-46676`.

One receipt is already consumed by `context`, and at least one must remain for the terminal
boundary. Even assuming no product reads, mutations, graph calls, notes, or configured checks, only
254 continuation pages remain. At the maximum 64 KiB page that reconstructs only 16,678,912 bytes
(about 15.9 MiB) including the preview. With the documented/default 32 KiB page it reconstructs
8,355,840 bytes (about 8.0 MiB). Real tickets need additional receipts, so their reachable bound is
lower. A compiler-valid context between that reachable bound and 64 MiB is now permanently barred
from product work by the new EOF gate.

Minimum correction: make the context-document maximum, page size, dedicated paging allowance, and
reserved non-context receipts one validated invariant. Reasonable implementations include a
separate bounded context-page ledger, a substantially larger page with the same transport bound,
or rejecting compilation before dispatch when the issued document cannot fit the grant budget.
Do not solve this by permitting product work before EOF.

Required regression: construct the largest accepted context and prove it can reach EOF while still
retaining enough grant capacity for its configured checks and terminal submission. Also prove the
first byte above the supported bound is rejected before a Worker starts.

## P2 findings and adversarial coverage

### P2 — a one-byte page can fail to advance at a multibyte UTF-8 scalar

The public schema permits `max_bytes: 1` (`agent_tool_broker.rs:1119-1125`).
`worker_utf8_page_with_identity` backs `end` down to a character boundary and can therefore return
an empty, non-EOF page with unchanged `next_offset` when the next scalar is multibyte
(`engine.rs:44384-44410`). Context observation then converts the validly shaped call into a
nonretryable projection failure because it did not advance (`agent_tool_broker.rs:383-390`). Pin a
safe minimum for context continuations or guarantee one-scalar progress, and add a multibyte test.

### P2 — future Worker tools fail open unless separately added to the product list

`context_bound_product_tool` is a second allowlist at `agent_tool_broker.rs:924-937`. A future
product/effect tool added to the Worker catalog but omitted there is allowed before EOF. Prefer an
explicit pre-context allowlist (`context`, narrowly intended graph-memory reads/writes, and the
exact continuation) so new Worker tools default closed, or add an exhaustive catalog-partition
test that fails when the inventories drift.

### P2 — “read only the required region” is not yet actionable from search output

The new prompt/tool copy directs a Worker to search a known literal and then read only the required
region. `search_files` returns path, line, column, and text but no byte offset or file hash
(`engine.rs:44538-44545`), while `read_file` pages by byte offset. For a match beyond page one, the
Worker must still page broadly, approximate a byte boundary, or rely only on the snippet. This was
explicitly outside the implementation lease, so it is not a release blocker, but the copy
overstates the available adaptive-read primitive. Add a UTF-8-safe byte offset and current file
hash before measuring this as a completed cognition optimization.

### P2 — malformed-page and policy-partition tests are thin

The cursor code rejects changed response path/offset, changed SHA after one is established, and
nonadvancing continuations, but focused tests cover only the happy path and one repeat rejection.
Add cases for wrong path, wrong offset, changed SHA, missing/invalid initial SHA, false EOF with no
advance, full-response `document:null`, repeated `context`, and an `already_issued` recovery path.
The initial paged response currently stores `sha256` as optional (`agent_tool_broker.rs:306-319`),
so the “hash-bound” description is stronger than the fail-closed parser for a malformed internal
response, even though the current engine always supplies the hash.

### P2 — the historical Codex/MCP test seam does not exercise this production policy

Production agent launch is unconditionally direct Pi when `!cfg!(test)`
(`engine.rs:28439-28477`). The old Codex/MCP branch is explicitly a test-only compatibility seam.
That CLI's `ToolCatalog` consumes role and enabled tools but discards
`AgentBrokerIngressView.context_completion_required`
(`crates/koni-cli/src/agent_mcp.rs:48-89`), so tests through the historical seam do not exercise EOF
gating. This is not a live compatibility blocker: historical grants deserialize with absent policy,
and production cannot select that launch path. It should nevertheless be documented or aligned so
test behavior cannot be mistaken for production coverage.

## Contracts accepted in this review

- New Worker grants opt into `CompleteBeforeProduct`; Lead grants reject a policy.
- The optional field uses `default` plus `skip_serializing_if`, so an absent historical policy does
  not appear in serialization or change the historical normalized hash.
- `AgentBrokerIngressView.context_completion_required` defaults false, preserving old catalogs.
- A policy-enabled catalog requires both `context` and `read_file`.
- Exact context continuation requires the issued path and current returned offset; subsequent pages
  keep the same SHA when the initial response was well formed.
- The current product-tool set covers file read/list/search, write/edit, configured checks, and all
  submission/compile variants. Graph context and advisory notes remain intentionally outside this
  product gate.
- One premature valid product call returns retryable `context_incomplete`; a second uninformed valid
  product call stops nonretryably. Pi's existing retryable-error handling skips remaining siblings.
- Worker assignment and bundled Software Implementer both carry the EOF/search/retention copy;
  Lead prompt copy does not inherit it.

## Read-only verification

- `cargo test -p koni-core agent_tool_broker::tests::context_ -- --nocapture` — **3/3 passed**.
- `cargo test -p koni-core direct_pi_worker_grant_pages_large_context_and_recovers_write_postimage_after_reopen -- --nocapture` — **1/1 passed**.
- `cargo test -p koni-core bundled_software_direct_pi_broker_submits_and_compiles_once -- --nocapture` — **1/1 passed**.
- `npx vitest run test/runtime.test.ts -t 'skips stale sibling calls after a retryable error and lets the model correct once'` — **1/1 passed**.

These results confirm the implemented happy paths. None constructs the successful-context plus
product-sibling adversary or the composed maximum context/receipt boundary, so they do not resolve
the P1 findings above.
