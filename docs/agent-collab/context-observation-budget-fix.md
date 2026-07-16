# Context observation and budget repair

Owner: `context-observation-budget-fix/root`

Status: `ready_for_integration`; source lease released

Last checked: 2026-07-16 09:36 MST

## Lease

This lane owns the two P1 release blockers and cheap adjacent P2 hardening identified by
[`context-read-discipline-review.md`](context-read-discipline-review.md):

- every successful compiler-context response/page becomes a provider-observation boundary in the
  direct Pi host, so later siblings from the same assistant message are quarantined locally and
  never reach the broker;
- the largest compiler-accepted context must provably fit a bounded context-delivery receipt
  allowance while preserving a meaningful receipt reserve for product reads/checks/submission;
- context continuation must make UTF-8 progress, and future Worker product/effect tools must fail
  closed before context EOF;
- focused adversarial tests cover the Pi batch boundary, maximum/first-byte-over budget, and
  malformed path/offset/hash/nonadvancing cursor responses where tractable.

Expected edit ranges are context-specific symbols/tests in
`crates/koni-core/src/{agent_tool_broker,engine}.rs`,
`runtime/pi-host/src/runtime.ts`, `runtime/pi-host/test/runtime.test.ts`, and append-only
coordination/product documentation. The lane will preserve all concurrent changes and will not
touch live run state, binaries/runtime installations, processes, cmux, fixtures, refs, or product
worktrees.

## Initial decision boundary

The target arithmetic contract is 256 total durable receipts, at most 128 receipts for initial
context plus exact continuation pages, and at least 128 receipts reserved for product discovery,
edits, configured checks, and terminal submission.

**UTF-8 correction — 2026-07-16 09:38 MST:** The provisional exact-4-MiB statement above did not
reserve the three bytes a page may lose when backing down to a UTF-8 boundary. The implemented cap
is 4,000,000 bytes. With a 32 KiB minimum continuation request, guaranteed progress is 32,765 bytes
per non-final delivery, so the largest accepted multibyte context needs at most 123 page-bearing
deliveries. A path-only recovery response can precede those pages, making 124 of the 128 context
receipts the true worst case. The remaining four are slack; the full 128-receipt product reserve
remains unconditional.

The Pi host will keep sequential execution and the broker's existing CAS. It will add only a local
same-message latch: successful `context` delivery and each successful exact context `read_file`
continuation establish the latch; the next provider request clears it after the model can observe
the result. Later siblings receive a local quarantine result and are never broker-dispatched.

## Coordination

- Re-read the central registry, original implementation mailbox, independent review, and relevant
  shared diff before claiming this lane.
- `supervision-exit-guard-fix/root` owns disjoint runtime-supervision/exit-publication symbols in
  `engine.rs`; this lane will not edit those ranges.
- No broad Cargo run or whole-file formatter while parallel owners are active. Narrow tests only;
  the primary integrator owns final composed gates and guarded refresh.

## 2026-07-16 09:57 MST — implementation handoff

### Result

- Pi retains sequential tool execution and the broker's existing CAS. A successful full/paged
  `context` result or successful exact context `read_file` page sets a local latch. Every later
  sibling from that assistant message receives `stale_after_context_delivery`, is projected as
  `pi_tool_stale_after_context_delivery`, and never reaches compiler dispatch. The next provider
  request clears only that observation latch after the result is in the transcript; the exact
  continuation cursor persists until EOF.
- Compiler context is capped at 4,000,000 bytes before the context pack is published or its step
  can become Worker-eligible. The initial preview is 32 KiB and an exact continuation must request
  at least 32 KiB. UTF-8 rollback guarantees at least 32,765 bytes of non-final progress. Thus the
  maximum needs at most 123 page-bearing receipts, or 124 when a path-only `already_issued`
  response precedes paging from zero. The context allowance is 128; a separate 128 of 256 receipts
  is unconditionally reserved for product reads, edits, configured checks, and submission.
- A one-byte page beginning at a multibyte scalar now returns that one complete scalar (at most
  three bytes above the tiny request) instead of an empty non-EOF page with an unchanged cursor.
- The pre-EOF policy is now a small explicit allowlist (`context`, its exact continuation,
  `graph_context`, and `record_note`); all present and future Worker product/effect tools fail
  closed by default. Initial paged context requires a valid full SHA-256 identity. Focused tests
  cover wrong request/response path and offset, changed/invalid SHA, null full document,
  nonadvancing cursor, undersized continuation, and `already_issued` recovery.
- Worker assignment, broker catalog copy, and bundled Software Implementer all teach observation,
  EOF, and 32 KiB continuation behavior. Historical grants without the optional context policy and
  Lead grants remain unchanged.

### Verification

- `npx vitest run test/runtime.test.ts` in `runtime/pi-host`: **57/57 passed**.
- `npm run typecheck` in `runtime/pi-host`: passed.
- `CARGO_TARGET_DIR=/tmp/koni-context-observation-target cargo test -p koni-core
  agent_tool_broker::tests --lib -- --nocapture`: **21/21 passed**.
- The same private target passed the multibyte maximum/budget, one-byte UTF-8 progress,
  `already_issued`, Worker-prompt, and existing real direct-Pi paging/reopen regressions
  individually (**1/1** each).
- `CARGO_TARGET_DIR=/tmp/koni-context-cli-target cargo test -p koni-cli
  bundled_implementer_requires_complete_context_and_adaptive_product_reads -- --nocapture`:
  **1/1 passed**.
- Exact-file Rustfmt checks for `agent_tool_broker.rs`, `engine.rs`, and `templates.rs`, plus
  `git diff --check`: passed.

### Documentation sweep and residual P2s

The handoff re-read every documentation file changed since the 09:36 claim, including the active
proof-routing mailbox and its adjacent Software philosophy evolution. The lanes remain disjoint;
no question is outstanding. Historical 64 MiB and same-batch-success wording remains visible next
to dated superseding notes in `pi-runtime.md`, `pi-worker-tools.md`,
`cognition-efficiency-audit.md`, and `context-read-discipline.md`.

Search output still lacks a UTF-8 byte offset/current file hash, so search-to-narrow-read ergonomics
remain a nonblocking P2. The historical Codex/MCP branch remains an explicitly test-only seam and
does not mirror the production direct-Pi observation latch. Neither requires authority or safety
changes for this release. No runtime bundle/dist artifact was rebuilt and no live/installed state
was touched; the primary integrator owns serialized composed gates and any later guarded runtime
refresh.
