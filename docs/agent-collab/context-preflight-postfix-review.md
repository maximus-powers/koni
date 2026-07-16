# Overview

Reviewer: `context_preflight_postfix_review/root`

Reviewed snapshot: 2026-07-16 10:41 MST, after the primary integrator's formatting pass

Status: **changes requested — no P0; one P1 release-evidence blocker**

## Vision

- **Purpose/objective:** A policy-enabled direct-Pi Worker must receive its exact selected-step
  context only after a bounded pack has been built and bound, but before any grant, process,
  provider session, or provider turn can exist.
- **Priorities:** Prevent token waste on oversized context, preserve exact ticket/step/pack
  currentness across replacement Workers, force one monotonic context traversal, reserve 128
  durable receipts for informed product work, and preserve policy-absent Worker/Lead behavior.
- **Implied outcome:** A failed preflight spends no model tokens, while a successful Worker cannot
  act on partial, replaced, or differently sized context bytes.
- **Major decisions:** Registered-run authority spans preflight through launcher entry; the grant
  hashes ticket/step/context/path/body-SHA/body-length; Rust and Pi independently bound repeat
  behavior; pre-EOF supplements are denied; the 4,000,000-byte cap is policy-specific.
- **Vision match:** Static production-path inspection found all prior behavioral P1s closed and no
  current production caller that bypasses `spawn_direct_pi_agent_with`.
- **Vision drift:** The required production-spawn evidence was not implemented. The only
  production-shaped Software broker test still creates an unbound grant after a host process
  exists, so the corrected boundary can regress while every current focused test remains green.

## Domains

| Domain | Review source | Process or capability | Files | What it implements | Relation to vision | Confidence or concern |
| --- | --- | --- | --- | --- | --- | --- |
| Worker preflight and durable broker | local-only fallback; agent thread limit was saturated | Prelaunch context construction, pack binding/currentness, receipt admission, continuation delivery | `crates/koni-core/src/engine.rs`, `agent_tool_broker.rs`, `agent_runtime.rs` | Exact bounded pack before launch; one-shot cursor; durable 128/128 receipt partition | Core safety boundary | Static flow is strong; P1 production-seam test is absent |
| Pi observation and compatibility | local-only fallback; agent thread limit was saturated | Provider-observation latch, local repeat limit, optional wire policy | `runtime/pi-host/src/runtime.ts`, `validation.ts`, `wire-types.ts`, `test/runtime.test.ts` | Policy-true quarantine; one retry then termination; absent/false compatibility | Prevents stale siblings and legacy regressions | High confidence from 60 focused tests and source inspection |

## Integration

| Integration surface | Touch | Why sensitive | Blast radius | Review focus |
| --- | --- | --- | --- | --- |
| `agent.spawn` production branch | Direct | It is the last boundary before grant/process/provider authority | Every Software Worker | Wrapper-only routing and order of side effects |
| Run authority + compiler + grant locks | Direct | A split snapshot could bind stale ticket/context bytes | Pause/delete/steer and concurrent supervision | Run barrier remains held; order is run, existing compiler lock, then grant lock |
| Durable broker receipts | Direct | Exhaustion can strand context or eliminate terminal capacity | Long-context Workers and recovery | Pre-EOF non-context calls are denied; context deliveries cap at 128; exact replay does not add a receipt |
| Runtime start wire contract | Direct | Missing-field compatibility affects historical sessions and Leads | Pi sessions across upgrades | False is omitted/defaulted; only claimed policy-true catalog sets the bit |
| Context artifact namespace | Direct | Mutated path/body could change what the model sees | Replacement and recovered Workers | Ticket issuance plus path/SHA/length is revalidated on every bound read |

# Philosophical Review

## Changes Paradigm

| Paradigm | Where it appears | Fit assessment | Elegance/coherence | Risk if wrong |
| --- | --- | --- | --- | --- |
| Fail-closed capability binding | Preflight binding and grant hash | Excellent fit | One object carries all relevant identities | Token waste or stale-context execution |
| State-machine delivery | Rust cursor and Pi latch | Excellent fit | Provider-neutral authority plus host-local quarantine | Cursor rewind or uninformed work |
| Compatibility by optional policy | Grant/session serialization | Good fit | Missing/false preserves old wire identity | Silent upgrade regression |
| Test-as-contract | Focused Rust/Pi tests | Incomplete fit | Cursor tests are precise, spawn tests stop before the new seam | Highest-risk ordering is not regression-protected |

## Integration Alignment

| Touched process/config | Existing paradigm | New-change paradigm | Alignment | Consequence |
| --- | --- | --- | --- | --- |
| Run mutation authority | Reentrant run barrier outside compiler/grant locks | Same barrier spans preflight and launcher | Aligned | Pause/delete cannot split the bound snapshot |
| Broker effects | Revalidate, reserve, execute, receipt | Bound context revalidated before each delivery | Aligned | Mutation/deletion/path substitution fails before a new receipt |
| Pi runtime | Explicit start-session capabilities | Optional compiler-bound context bit | Aligned | No prompt/role inference and legacy sessions stay unchanged |
| Software integration test | Direct claimed broker fixture | Still uses policy-without-pack compatibility path | Misaligned | It does not prove new production launch ordering |

# Implementation Review

## Elegance Scoring

- **Overall score:** `3/5`
- **Rationale:** The implementation is focused and coherent, but release confidence is capped by
  the complete absence of a test at the exact boundary that motivated the correction.

| Area/domain | Score | Effective choices | Unnecessary or excessive changes | Concrete simplification |
| --- | --- | --- | --- | --- |
| Worker preflight/binding | 4/5 | One binding, continuous authority, refreshed ticket prevents stale PID overwrite | No material excess found | Make one production-shaped fixture the canonical proof instead of relying on arithmetic/helper tests |
| Cursor/receipt discipline | 4/5 | Default-closed pre-EOF gate and durable context classification preserve 128 product slots | Recovery-ledger scan is acceptable at this 4 MB bound | Add one populated-ledger recovery regression |
| Pi policy/compatibility | 4/5 | Explicit bit, omitted false, bounded local repeats | No material excess found | Keep current shape |
| Verification | 2/5 | Narrow cursor and Pi suites are strong | The named Software test preserves the old unsafe ordering | Replace/extend it through `spawn_direct_pi_agent_with` |

## Code Conventions

| Convention | Existing pattern | Change alignment | Concern |
| --- | --- | --- | --- |
| Authority ordering | Run barrier before compiler/grant locks | Aligned | No lock inversion found |
| Durable identity | Hash exact normalized compiler-owned objects | Aligned | Optional pack remains necessary only for historical/test grants |
| Compatibility | `serde(default, skip_serializing_if)` | Aligned | Rust and TypeScript both default false |
| Test seams | Inject effect/launcher boundaries, test real consumers | Partially aligned | The injected launcher exists but has no test caller |
| Error handling | Fail before effect and return bounded diagnostics | Aligned | No P0/P1 behavior defect found in the static path |

## Database Load

Not applicable. This change touches filesystem/Git-common durable state and the Pi transport, not
a database or query surface.

## Testing

| Behavior/process | Covered by | Regression protected | Missing case or confidence gap |
| --- | --- | --- | --- |
| Rust cursor, pre-EOF default-close, malformed continuation | Independent private-target run: `agent_tool_broker::tests::context_` | 10/10 passed | No durable reopened 128-entry ledger |
| MAX arithmetic and policy-specific response ceiling | `context_budget_pages_largest_multibyte_document_and_rejects_next_byte`; `policy_absent_context_preserves_the_bounded_legacy_ceiling` | 2/2 passed | Tests helpers, not production spawn/compile ordering |
| Pi latch, repeats, legacy Worker, Lead | `npm test -- test/runtime.test.ts` | 60/60 passed | No blocking gap found |
| TypeScript wire shape | `npm run typecheck` | Passed | None material |
| Existing Software broker lifecycle | `bundled_software_direct_pi_broker_submits_and_compiles_once` | Passed | Constructs an unbound grant after `/bin/sleep` host creation at `engine.rs:96581-96642`; it does not cross the corrected wrapper |
| Production Worker preflight | Static inspection only | Current call graph has no bypass | **P1:** no MAX/MAX+1 launcher/grant/agent/pack/ticket snapshot test; no dirty replacement/bound-pack mutation test |

# Proposed Tweaks

| Priority | Tweak | Reason | Affected domains/files | Expected impact | Before commit |
| --- | --- | --- | --- | --- | --- |
| P1 | Add a production-shaped test that directly invokes `spawn_direct_pi_agent_with` with a counted launcher and exact real run/ticket context. Prove MAX launches once with the exact binding, while MAX+1 leaves launcher count, grant namespace, agent records, context pack/receipt namespace, and ticket bytes unchanged. | The wrapper at `engine.rs:59491-59512` has no test reference; arithmetic at `95500-95555` cannot prove ordering or absence of effects. | `crates/koni-core/src/engine.rs` tests | Makes the token-waste correction release-verifiable | **Yes** |
| P1 | In the same production fixture, dirty one authorized in-scope path before replacement launch, prove a fresh bound pack/current ticket survives PID publication, then mutate/delete/substitute the pack and ticket context hash and prove every continuation fails before receipt/dispatch. | The required replacement/currentness behavior is implemented at `44279-44330`, `44808-44825`, and `59520-59692` but has no direct test. | `engine.rs` tests | Protects exact binding and recovery behavior | **Yes** |
| P2 | Populate/reopen a grant at the 128 context-receipt ceiling and prove exact replay remains possible while a distinct delivery is denied and 128 product slots remain. | Current admission code is sound, but recovery evidence is synthetic/in-memory. | `engine.rs` broker tests | Hardens durable recovery confidence | No |
| P2 | Add actual >4 MiB `compile_context` fixtures for policy-absent Worker and unscoped observer/Lead paths. | Current compatibility test exercises the response-size helper only. | `engine.rs` tests | Prevents accidental global-cap regression | No |

## Commit Boundaries

| Suggested commit | Domains/files | Why this boundary is clean |
| --- | --- | --- |
| Context spawn contract and its production-seam regressions | `engine.rs`, `agent_tool_broker.rs`, `agent_runtime.rs` plus focused tests | The safety implementation and the evidence that authorizes release should land together |
| Pi observation compatibility | `runtime/pi-host/src/*`, `runtime/pi-host/test/runtime.test.ts` | Independent wire/runtime contract with its own green suite |

## Frozen Follow-up Re-review — 2026-07-16 11:37 MST

Status: **changes still requested — no P0; one P1 test-as-contract blocker remains**.

The follow-up materially closes the original wrapper-ordering gap. The focused regression now
uses a real active Software run, production ticket/step/context compilation, and the actual
`spawn_direct_pi_agent_with` seam. Exact MAX reaches the injected continuation once. MAX+1
reaches it zero times and preserves the captured context, receipt, grant, response, agent, log,
and semantic ticket state. The accepted case refreshes the stale `PiAgentSpawnSpec.ticket`,
publishes one new context receipt plus one manifest/document pair, and binds the exact 4,000,000
bytes. Static inspection still finds no production bypass, lock inversion, or currentness defect.

The production implementation is currently correct, but the regression overstates the remaining
integration evidence:

| Priority | Finding | Exact evidence | Why it still matters | Minimum correction |
| --- | --- | --- | --- | --- |
| P1 | Production pregrant and PID-publication wiring are not exercised. | The injected continuation calls `validate_prepared_worker_context_current` itself at `engine.rs:95881-95909` and returns without entering `spawn_preflighted_direct_pi_agent` at `59727-59769` or the refreshed-ticket PID publication at `59817-59909`. | Removing/reordering the production launcher validator or reintroducing a stale-ticket write would leave this regression green. | Share the real production pre-effect validator with the wrapper test, and factor the existing PID/active-worker publication callback into a production helper tested with the refreshed ticket. |
| P1 | Bound-pack adversaries validate a helper, not either production delivery route. | The test calls `bound_worker_context_document` directly at `95982`, `96007`, `96016-96021`, and `96033-96048`; production consumers are the bound `read_file` route at `44849` and the `context` route at `45757`, beneath durable broker reservation/dispatch. | Either consumer could stop calling the validator, or call it after durable dispatch, while the helper assertions and final unchanged-receipt assertion remain green. | Route the same path/body/delete/ticket adversaries through claimed broker ingress for both `context` and bound `read_file`, and prove rejection occurs without a new receipt/effect. |
| P1 | SHA identity is not independently protected. | The only body mutation appends one byte at `96014`, changing both length and SHA; length validation alone rejects it. No other test mutates bound bytes without changing length. | The central exact-byte guarantee could lose its SHA check while this suite remains green. | Add a same-length one-byte substitution and require both pregrant and delivery paths to reject it before effect/receipt. |
| P2 | The new canonical helper's tracked-storage/relative-path branch is unexercised. | The wrapper fixture derives from the Software `git_common_dir` profile (`95705` via `read_scope_recovery_fixture`); Research uses `storage.backend: tracked`. | A relative-path regression would affect Research Workers without failing the new test. | Add a small tracked-store canonical-path variant; it need not repeat the 4 MB calibration. |
| P2 | Two documented zero-effect assertions are weaker than their wording. | `context_spawn_test_tree` records files only (`95630-95645`), so an empty directory is invisible; MAX+1 compares `normalized_hash(Ticket)` at `95925/95943`, not raw ticket bytes. | Empty namespace creation or a semantic-no-op ticket rewrite would not be detected. | Snapshot directory entries and the ticket file's raw bytes, or narrow the documentation to semantic/file-content preservation. |

Independent evidence on the frozen follow-up:

- `CARGO_TARGET_DIR=/tmp/koni-context-preflight-postfix-rereview-target cargo test -p koni-core production_worker_spawn_preflights_exact_max_and_rejects_stale_bound_packs --lib -- --nocapture`
  — **1/1 passed**.
- `cargo fmt --all -- --check` — **passed**.
- Scoped `git diff --check` for `engine.rs` and the context collaboration notes — **passed**.

No source, runtime, live state, binary, worktree, process, ref, grant, receipt, or cmux surface was
changed by this re-review.

## Final Production-call-site Re-review — 2026-07-16 12:11 MST

Status: **accepted — no P0; no P1**.

The bounded final delta closes the preceding test-as-contract blocker without launching a real
Pi/provider:

| Previously retained P1 | Final production evidence | Disposition |
| --- | --- | --- |
| Pregrant validator could be removed while the counted fixture stayed green | `spawn_direct_pi_agent_with` now calls `validate_prepared_worker_context_current` itself at `engine.rs:59552-59554`, under the held run barrier and immediately before every injected/production launcher. The MAX closure at `95903-95962` no longer self-validates; production retains a second defense-in-depth check at `59780-59782`. | Closed |
| Refreshed context could be clobbered during PID publication | Production bootstrap calls the factored `publish_direct_pi_runtime_ticket_start` helper at `59925-59932`; the exact-MAX fixture calls that same helper at `95935-95942` and verifies selected-step hash, `issued_context_hashes`, worker PID, and active-worker publication at `95943-95960`. | Closed |
| Pack drift only exercised pure helpers, not broker delivery/receipts | `bundled_software_direct_pi_broker_submits_and_compiles_once` now obtains a real preflight binding at `97152-97159`, issues/claims a bound grant, and traverses actual `context` plus exact `read_file` paging to EOF at `97237-97292`. Distinct claimed-broker calls reject canonical-path, equal-length body, deletion, and ticket-context drift while sequence, receipts, in-flight state, ticket, response files, and compiler events remain unchanged at `97316-97491`. | Closed |
| Length failure masked missing SHA enforcement | Both focused fixtures substitute one byte without changing length and assert a different SHA (`96067-96077`, `97414-97440`). The claimed broker must reject the equal-length body before a durable effect. | Closed |

Independent private-target evidence on the final frozen source:

- `CARGO_TARGET_DIR=/tmp/koni-context-preflight-postfix-rereview-target cargo test -p koni-core production_worker_spawn_preflights_exact_max_and_rejects_stale_bound_packs --lib -- --nocapture`
  — **1/1 passed**.
- `CARGO_TARGET_DIR=/tmp/koni-context-preflight-postfix-rereview-target cargo test -p koni-core bundled_software_direct_pi_broker_submits_and_compiles_once --lib -- --nocapture`
  — **1/1 passed**.
- `cargo fmt --all -- --check` — **passed**.
- Scoped `git diff --check` across `engine.rs` and the context collaboration notes — **passed**.

Static reinspection finds no production bypass, lock-order regression, or currentness regression.
The tracked-storage relative-path variant, empty-directory/raw-ticket-byte snapshot precision,
physically populated 128-entry recovery ledger, and separate large Lead/observer fixtures remain
P2 hardening only. No source or live/release surface was changed by this independent review.
