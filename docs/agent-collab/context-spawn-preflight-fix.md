# Worker context spawn-boundary correction

Owner: `context_spawn_preflight_fix/root`

Status: `in_progress`

Started: 2026-07-16 10:10 MST

## Exact lease

This lane owns the post-fix P1 corrections identified by the independent context reviewer:

1. New `complete_before_product` Workers must compile, size, and bind their exact selected-step
   context before any grant, AgentSessionRecord, Pi process, provider session, or provider turn is
   created. The broker must reuse that exact pack rather than recompiling it after launch.
2. A policy-enabled broker context session is monotonic and one-shot. `context` is admitted only
   from `AwaitingContext`; it cannot rewind `Paging` or `Complete`, vary page sizes to consume the
   product reserve, or alter the provider-observation cursor. A fresh recovered broker session may
   begin at `AwaitingContext` and receive the existing pack as `already_issued`.
3. Pi's successful-context observation latch is activated only by the explicit compiler-bound
   `context_completion_required` bit carried from the claimed ingress/catalog into
   `RuntimeSessionStart`. Missing/false legacy sessions and Leads retain their prior same-message
   behavior; true sessions retain quarantine-after-delivery.
4. The 4,000,000-byte receipt-derived cap applies only to new policy-enabled direct-Pi Worker
   context. Historical/no-policy Worker, Lead, and unscoped observer context preserve their prior
   bounded 64 MiB compatibility ceiling rather than receiving an implicit migration.

Owned source/test ranges are context-specific symbols and regressions in
`crates/koni-core/src/{engine,agent_tool_broker,agent_runtime,agent,pi_runtime_state}.rs` and
`runtime/pi-host/src/{runtime,validation,wire-types}.ts` plus its focused runtime tests. No live
state, installed or isolated binary/runtime bundle, cmux surface, acceptance fixture, product
worktree, process, grant, ref, or profile publication is in scope. Preserve all concurrent edits;
use private Cargo targets and narrow tests only.

## Required production evidence

- A real production Worker-spawn boundary rejects MAX+1 with zero grant, agent record, launcher /
  Pi bootstrap, or provider-turn invocation, while MAX can cross that boundary.
- Dirty in-scope replacement-worker context is recompiled and rebound before launch; delivery
  reads the exact preflight pack without a duplicate compile/publication.
- Repeated `context` during Paging and after Complete is rejected before durable dispatch. Varying
  continuation sizes cannot exceed the straight-line context receipt bound, and the product
  reserve remains intact.
- Policy true quarantines same-batch siblings after every successful delivery. Legacy false
  dispatches its historical same-batch context/product sequence; a Lead/no-context session never
  activates the latch.
- More-than-4-MiB no-policy/Lead/observer compilation remains accepted up to the historical bound
  without starting provider work.

The primary integrator owns composed gates, independent re-review, and any later guarded refresh.

## Completion transition — 2026-07-16 10:37 MST

Current status: `complete; exact source lease released to primary-integrator/root`.

The frozen implementation now makes the compiler's selected-step context pack part of the
production Worker spawn boundary. `spawn_direct_pi_agent_with` holds the registered run-agent
barrier continuously across preflight and launcher entry. The preflight compiles with the
policy-specific 4,000,000-byte limit, reloads the ticket, proves the selected step is still ready,
and returns a binding containing ticket, step, context hash, document path, body SHA-256, and byte
length. Oversize compilation reaches neither the final ticket write nor the launcher, grant,
agent record, bootstrap/log, Pi session, or provider surface. The launcher revalidates the exact
ticket/hash/body binding before its first side effect; the grant carries that same binding, and
every context continuation rereads and verifies the exact path, SHA-256, and length rather than
recompiling or trusting a mutable derived path.

Context delivery is now monotonic in both broker and Pi. A policy-enabled broker admits
`context` only from `AwaitingContext`; Paging/Complete repetition gets one bounded correction and
then a terminal rejection without durable tool dispatch. Before EOF, no product or supplement
tool is admitted: `graph_context` and `record_note` intentionally move behind Complete so at most
128 persisted context-delivery receipts leave at least 128 of the 256-receipt ledger for informed
work. Exact continuations require at least 32 KiB and retain the document identity across pages.
Pi independently rejects a repeated `context` locally once, terminates on the second repetition,
and never sends either call to the compiler.

The observation latch is no longer inferred from a tool name. The claimed catalog projects an
explicit `context_completion_required` bit into `RuntimeSessionStart`; only true activates Pi's
context-delivery quarantine. The field defaults false and is omitted when false, so legacy wire
serialization, policy-absent Worker same-batch context/product dispatch, and Lead behavior remain
unchanged. Likewise, the 4,000,000-byte document/read-offset ceiling is selected only for a
policy-enabled Worker. Absent-policy Worker, Lead, and observer compilation retain the prior
bounded 64 MiB compatibility ceiling.

### Exact verification

- `CARGO_TARGET_DIR=/tmp/koni-context-spawn-preflight-target cargo test -p koni-core agent_tool_broker::tests::context_ --lib`
  — **10/10 passed**.
- `CARGO_TARGET_DIR=/tmp/koni-context-spawn-preflight-target cargo check -p koni-core --lib`
  — **passed cleanly**.
- `npm test -- test/runtime.test.ts` from `runtime/pi-host`
  — **60/60 passed**.
- `npm run typecheck` from `runtime/pi-host`
  — **passed cleanly**.

No live state, installed binary/runtime bundle, cmux surface, acceptance fixture, product
worktree, process, grant, ref, or profile publication changed in this lane.

### Integration caveats retained explicitly

- The focused tests prove the exact MAX/MAX+1 arithmetic, broker policy, Pi latch/retry behavior,
  and source compilation, but this lane did not add the requested new end-to-end production-spawn
  fixture with a launcher counter at both byte boundaries. The primary integrator's composed gate
  and independent review must exercise that wrapper boundary before guarded release.
- The compatibility regression directly covers an absent-policy document above 4 MiB through the
  legacy 64 MiB response ceiling; it does not add separate real Lead and observer compilation
  fixtures at that size.
- The adversary proves pre-EOF supplements never reach ingress and the durable code caps context
  delivery at 128. A crash/reopen test with a physically populated 128-entry receipt ledger is
  still useful P2 integration evidence.
- Broad workspace, composed-process, package/bundle, and live acceptance matrices were
  intentionally left to `primary-integrator/root` under the lane boundary.

## Follow-up production-seam evidence lease — 2026-07-16 10:46 MST

Current status: `in_progress; exact test-seam lease reacquired from primary-integrator/root`.

The independent post-fix review accepts the production design but correctly retains one P1
evidence blocker: no regression invokes `spawn_direct_pi_agent_with`, so the ordering and exact
binding can regress while helper/cursor tests remain green. This follow-up owns only a direct
wrapper fixture with an injected non-launching continuation (and the minimum test seam needed to
observe it) in `crates/koni-core/src/engine.rs`, plus focused test/doc updates. It will prove:

1. an exact-maximum policy-enabled selected-step pack reaches the injected continuation once;
2. MAX+1 fails before continuation, grant, agent/log/bootstrap/receipt namespace, context-pack
   publication, or ticket mutation;
3. dirty authorized selected-step state is freshly compiled/bound and handed to the continuation
   once without a second compilation/publication; and
4. pack bytes/path and current ticket/hash mutation fail exact bound delivery before receipt.

No real Pi/runtime launch, live state, installed binary, bundle, cmux surface, product worktree,
process, Git ref, profile publication, or broad formatter is authorized. Use the private Cargo
target and preserve concurrent source changes.

### Lease expansion — canonical pack path, 2026-07-16 10:52 MST

The required path-substitution adversary exposed one narrow production defect: the two exact-body
validators accepted a rehashed binding to a different regular file under run work storage when
that file copied the expected bytes. `primary-integrator/root` explicitly expanded this lease to
add one shared canonical-path check in `validate_prepared_worker_context_current` and
`bound_worker_context_document`. The accepted path is exactly the selected run store's
`work/tickets/<ticket>/context/<first-16-context-digest>/context.md`, while the existing regular-
file, no-symlink, containment, SHA-256, length, ticket, step, and issued-hash checks remain. The
same-bytes alternate-path test must fail; it may not be weakened into a body-only assertion.

## Follow-up completion transition — 2026-07-16 11:08 MST

Current status: `complete; source frozen and exact lease released for independent re-review`.

The P1 production-seam evidence now invokes `spawn_direct_pi_agent_with` against a real active
Software run, compiler-generated ticket, ready production step, selected run store, and dirty
authorized `src/existing.ts` prestate. Its injected continuation does not launch Pi, but it calls
the real `validate_prepared_worker_context_current` before observing the binding. Three fixed-
shape steering events deterministically calibrate the emitted document: the accepted case is
exactly 4,000,000 bytes and reaches the continuation once; changing the final ASCII payload by
one byte produces exactly 4,000,001 bytes and never reaches it.

The accepted case proves a freshly issued selected-step context hash replaces the previously
issued hash, the stale `PiAgentSpawnSpec.ticket` clone is refreshed to that exact hash, the body
SHA-256 and byte count match, prior-attempt recovery guidance and the authorized dirty path are in
the pack, and exactly one context receipt plus one manifest/document pair are published. The
MAX+1 case snapshots and preserves ticket bytes, context-pack tree, context receipts, broker grant
tree, broker response tree, AgentSessionRecords, and log absence, with a zero continuation count.
That one-receipt delta also proves the wrapper did not compile/publish the accepted pack twice.

The captured accepted binding then exercises both the pregrant and delivery validators. Same-byte
alternate path, appended body, deleted body, selected-step context-hash drift, and
`issued_context_hashes` drift all fail while the receipt namespace remains byte-identical. The
shared canonical-path helper now derives only
`work/tickets/<ticket>/context/<first-16-context-digest>/context.md`; a same-byte alternate file
inside otherwise allowed run work storage no longer passes either validator. Existing
regular-file/no-symlink/containment and body/ticket checks remain layered behind it.

### Follow-up verification

- `CARGO_TARGET_DIR=/tmp/koni-context-spawn-preflight-target cargo test -p koni-core production_worker_spawn_preflights_exact_max_and_rejects_stale_bound_packs --lib -- --nocapture`
  — **1/1 passed**.
- `CARGO_TARGET_DIR=/tmp/koni-context-spawn-preflight-target cargo check -p koni-core --lib`
  — **passed cleanly**.
- `cargo fmt --all -- --check` — **passed**.
- `git diff --check -- crates/koni-core/src/engine.rs docs/agent-collab/context-spawn-preflight-fix.md docs/AGENT_COLLAB.md`
  — **passed**.

No real runtime process/provider session, live state, installed binary/bundle, cmux surface,
product worktree, Git ref, profile publication, grant, or receipt outside the temporary test
fixture was created or changed. The separately documented P2 128-entry crash/reopen ledger and
large real Lead/observer fixtures remain outside this P1 evidence lease.

## Final production-call-site evidence lease — 2026-07-16 11:16 MST

Current status: `in_progress; exact context spawn test/helper lease reacquired`.

Independent re-review accepts the behavior but retains a final P1 test-as-contract gap: the
counted closure performed its own pregrant validation, PID ticket publication remained inline,
and pack drift called helpers rather than the claimed broker's production `context`/bound
`read_file` paths. `primary-integrator/root` authorized only these bounded corrections:

1. `spawn_direct_pi_agent_with` itself calls the shared prepared-pack validator under the held run
   barrier immediately before any injected/production launcher; production keeps its second
   defense-in-depth validation;
2. the existing PID/`active_worker` ticket mutation becomes one production helper and a refreshed-
   ticket test proves issued context survives PID publication;
3. the claimed Software `DurableAgentToolBroker` lifecycle uses a preflight-bound grant, then real
   `context` and exact bound `read_file` calls prove path/body/delete/ticket drift reaches no new
   receipt/effect; and
4. a same-length byte substitution proves SHA identity independently from the length cap.

No real Pi/provider launch, live state, installed binary/bundle, cmux, product checkout, ref,
profile publication, or unrelated broker/runtime redesign is in scope.

## Final production-call-site evidence completion — 2026-07-16 11:55 MST

Current status: `implementation complete and source frozen; independent re-review pending`.

The counted launcher seam now owns the exact pregrant validation: `spawn_direct_pi_agent_with`
holds the registered run-agent barrier, performs bounded Worker preflight, refreshes the launch
ticket, validates the prepared pack against current path/body/ticket identity, and only then calls
the injected or production launcher. The counted MAX fixture no longer validates inside its test
closure. The production launcher retains its existing second immediately-pre-grant validation as
defense in depth.

Production PID/`active_worker` ticket publication is now one shared
`publish_direct_pi_runtime_ticket_start` helper used by the real bootstrap callback. The exact-MAX
fixture invokes that same helper and proves the refreshed selected-step `context_hash` plus
`issued_context_hashes` binding survive PID/lease/active-worker publication unchanged.

The existing bundled Software direct-Pi integration now obtains its Worker context binding from
the real preflight wrapper before creating a fake host, issues and claims a context-bound runtime
grant, and delivers the real `context` preview plus every exact bound `read_file` continuation to
EOF. Four fresh adapters replay that durable delivery to EOF before distinct non-replay calls
exercise the claimed broker under same-byte alternate-path drift, same-length one-byte body
substitution, document deletion, and selected-ticket context drift. Each failure snapshots and
preserves grant sequence, receipt map, in-flight state, ticket state, broker-response namespace,
and scoped compiler-event count; the restored valid session then submits and compiles exactly
once. The equal-length substitution independently proves SHA-256 binding rather than relying on
the byte ceiling.

### Final focused verification

- `CARGO_TARGET_DIR=/tmp/koni-context-spawn-preflight-target cargo test -p koni-core --lib bundled_software_direct_pi_broker_submits_and_compiles_once -- --nocapture`
  — **1/1 passed**.
- `CARGO_TARGET_DIR=/tmp/koni-context-spawn-preflight-target cargo test -p koni-core --lib production_worker_spawn_preflights_exact_max_and_rejects_stale_bound_packs -- --nocapture`
  — **1/1 passed**.
- `CARGO_TARGET_DIR=/tmp/koni-context-spawn-preflight-target cargo check -p koni-core --lib`
  — **passed cleanly**.
- `cargo fmt --all -- --check` — **passed cleanly**.
- `git diff --check -- crates/koni-core/src/engine.rs docs/agent-collab/context-spawn-preflight-fix.md docs/AGENT_COLLAB.md`
  — **passed cleanly before this append-only ledger update**.

No real Pi/provider session, live state, installed binary/runtime bundle, cmux surface, product
checkout, Git ref, profile, or non-test process was created or changed. The Software test's
bounded `/bin/sleep` identity fixture is reaped by its existing composed-child guard.
