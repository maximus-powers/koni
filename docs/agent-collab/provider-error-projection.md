# Provider-error projection audit

## Status and lease

`in_progress_read_only` — `provider-error-projection/root`, 2026-07-14.

This lane owns only this mailbox and, if useful at handoff, one append-only signed checkpoint in
`docs/AGENT_COLLAB.md`. It may inspect the Pi host, Rust runtime consumer, tests, and documentation,
but must not edit source, run auth/inference, install a binary, migrate a project, or touch live or
forensic run state.

## Coordination checkpoint

Read the central registry and the current Pi SDK-host, runtime-security, final-runtime-audit, and
primary-integrator mailboxes before substantive inspection. The shared tree is intentionally dirty;
all source bytes belong to other released/integration lanes and remain untouched.

## Initial finding

The normal provider-stream failure is currently safe only by being unhelpfully collapsed. In
`runtime/pi-host/src/runtime.ts::runTurn`, an assistant `stopReason === "error"` becomes the fixed
`"Pi provider turn failed"`, while every emitted `runtime_error` uses the single code
`pi_runtime_error` and `retryable: false`. Conversely, an exception caught around the broader
provider/listener/protocol path is projected from raw `Error.message` through pattern redaction.
Pattern redaction is useful defense in depth but is not a safe authority boundary for arbitrary
provider/OAuth response bodies.

The Rust consumer also discards the wire `retryable` bit in
`PiRuntimeProcess::run_turn_inner`, stores only `(code, message)`, and turns that into an ordinary
`KoniError::Process` in `finish_turn`. Planning dispatch at `engine.rs:4216+` then falls through from
a failed direct-Pi planning record into a fresh attempt without consulting error class or a bounded
retry policy. A correct classifier therefore needs both fixed secret-free host projection and an
explicit Rust retry disposition; a boolean that is serialized and then ignored is not operational
retry semantics.

## Current-byte audit

The primary integrator intentionally changed the source during this read-only audit after the first
isolated live turn exposed a zero-token request rejection. The current relevant fingerprints are:

- `runtime/pi-host/src/runtime.ts` `140f8cbad27679dd9c57728ad617253913fd8fa91f1cb8bb3f041c1400ff18f4`
- `runtime/pi-host/src/errors.ts` `b15c2e50b65f2f3091a44da24bfee2f4619082a5d5f07a503091b2cc60a6f5c7`
- `runtime/pi-host/src/redaction.ts` `56cc977ff3bddeb07374a9c1a1020997738534cd73004666fb02767edea50c4f`
- `runtime/pi-host/test/runtime.test.ts` `606db5b80a201b1b08fe04354b74bf23ab8ba406cddd7891d9c7b6f83b83585f`
- rebuilt host artifact `5cc542d7a3e01af391af688ebba8ab0a35805f184544e923a0cf111a94aa415c`

The sibling `pi-model-failure.md` audit proves that the failed packaged artifact injected
`max_output_tokens` even though Pi 0.80.7's ChatGPT Codex request builder intentionally omits it.
Current source removed that injection and adds the exact payload regression at
`runtime.test.ts:539-615`. This audit accepts that correction and does not reopen it.

### Exact current projection path

1. Pi turns an upstream provider exception/body into an assistant `errorMessage`
   (`openai-codex-responses.js:310-318`). The pinned provider may include normalized HTTP body text.
2. Pi Agent stores that message in its assistant failure object (`pi-agent-core/dist/agent.js:338-353`).
3. Koni's `runTurn` observes only `stopReason === "error"` and replaces it with the generic
   `HostError(PROVIDER_ERROR, "Pi provider turn failed")` (`runtime.ts:547-592`). This loses auth,
   entitlement, request-shape, usage-limit, and transient-outage distinctions.
4. A thrown listener, protocol, usage-validation, or other outer error instead reaches the same
   event through `redactor.redact(errorMessage(failure))`. The fixed/structured regexes cover known
   bearer/JWT and selected OAuth field shapes, but no regex list can safely authorize arbitrary
   provider response bodies.
5. Rust accepts any runtime-error code/message tuple (`pi_runtime_state.rs:418-422`), drops the
   event's `retryable` member (`pi_runtime_process.rs:500,582-590`), and persists the resulting
   formatted `Process` error as `supervision_error` (`engine.rs:51285-51329`). The compact transcript
   keeps code/retryable but deliberately omits the message (`agent.rs:1020-1030`), so the current TUI
   agent chat falls back to `Agent turn failed` (`agent_chat.rs:465-477`).

## Recommended smallest secure classifier

Add one pure, bounded classifier in `runtime/pi-host/src/errors.ts`:

```text
projectProviderFailure(raw: unknown) -> { code, message, retryable }
```

It may inspect at most the first 8 KiB of a safely stringified error solely to choose one tuple.
It must never return, interpolate, log, attach as a cause/detail, or persist any part of that text.
The fallback is fixed and non-retryable. Matching order is significant:

| Code | Fixed public message | Retryable | Allowlisted evidence |
| --- | --- | --- | --- |
| `provider_usage_limit` | `Your ChatGPT Codex usage limit has been reached. Wait for it to reset, then resume the run.` | false | friendly `ChatGPT usage limit`; `usage_limit_reached`; `usage_not_included`; `insufficient_quota`; monthly/quota/budget/billing exhaustion |
| `provider_authentication` | `OpenAI Codex rejected the stored sign-in. Run koni auth login, then resume the run.` | false | 401/unauthorized; missing/invalid/expired token; OAuth refresh/authentication failure; no provider credential |
| `provider_access_denied` | `OpenAI Codex denied this account or model. Check ChatGPT subscription and model access, then retry.` | false | 403/forbidden; model-access/entitlement denial |
| `provider_request_rejected` | `OpenAI Codex rejected the request. Check the selected model and Koni runtime compatibility before retrying.` | false | 400/404/422; invalid request/model; unknown/unsupported parameter; context-window rejection |
| `provider_rate_limited` | `OpenAI Codex is temporarily rate-limiting requests. Retry after a short delay.` | true | non-terminal 429/rate-limit/too-many-requests text, after the usage-limit class above |
| `provider_unavailable` | `OpenAI Codex is temporarily unavailable. Retry this turn.` | true | 5xx/524; overload/service/internal server; fetch/network/upstream/connection/socket/WebSocket/timeout/reset; explicit retry guidance |
| `provider_error` | `OpenAI Codex failed for an unclassified reason. Retry manually; if it repeats, reauthenticate and check service status.` | false | everything else, including malformed/non-string/throwing values |

The messages above are suggested exact protocol constants; wording may be shortened once, but the
chosen tuple must then be shared as protocol truth and tested exactly. Never include a provider
request ID, body, field name/value, email/account, URL, header, retry body, model-auth payload, or
raw error fragment. In particular, adding more redaction regexes is defense in depth, not a
substitute for this projection.

`runTurn` should classify `last.errorMessage` when the final assistant stop reason is `error`.
Its broader catch should pass through a second fixed `projectRuntimeFailure` table for Koni-authored
`HostError` classes (for example broker timeout versus host protocol/internal failure); unknown
exceptions must map to one fixed internal failure and never expose `Error.message`. `formatFatalError`
and the protocol `onFatal` stderr path must use the same fixed projection rule. This closes stdout,
stderr, transcript, durable-agent-result, and TUI paths together rather than trusting one sink's
redactor.

### Retry semantics

Here `retryable` means only **the provider cause is plausibly transient for the same request**. It is
not proof that replaying an agent stage is side-effect-free. Therefore:

- only the rate-limited and unavailable classes are true;
- auth, usage-limit, access, request, and unknown classes are false;
- Rust must preserve the bit in a typed Pi turn failure and durable agent result instead of dropping
  it;
- current planning dispatch must not continue its unconditional failed-record relaunch;
- an automatic stage retry is permitted only with a compiler-proven zero-effect attempt (no broker
  tool dispatch/receipt, no assistant completion, and zero published usage), must be delayed and
  capped (recommend at most two automatic retries after the original attempt), and must otherwise
  become an operator-resumable waiting state;
- a true bit with partial output, nonzero usage, or any tool activity remains manual/compiled replay,
  never a blind process restart.

This distinction prevents a transient-classifier improvement from creating duplicate compiler
effects or another unbounded token loop.

## Exact implementation seams and tests

### TypeScript host

- `runtime/pi-host/src/errors.ts`
  - add the public projection type and `projectProviderFailure` / `projectRuntimeFailure`;
  - keep `HostError` for internal control flow, but never use `toHostError`'s raw fallback as public
    text.
- `runtime/pi-host/src/runtime.ts::runTurn`
  - retain the last assistant object, classify its `errorMessage`, and emit the exact projected
    code/message/retryable tuple;
  - project caught non-provider errors through fixed host categories.
- `runtime/pi-host/src/main.ts::{formatFatalError,runKoniPiHost}`
  - replace arbitrary outer `Error.message` stderr projection with a fixed tuple.
- `runtime/pi-host/test/runtime.test.ts`
  - table-test all seven classes, ordering (usage before generic 429), and exact booleans;
  - drive a faux assistant `stopReason: "error"` for each class and assert exactly one
    `runtime_error` followed by exactly one error `turn_completed`;
  - inject adversarial JSON/body/cause text containing bearer/JWT plus `access_token`,
    `refresh_token`, `id_token`, `authorization_code`, `code_verifier`, `device_auth_id`,
    `client_secret`, cookie, email, URL query, prompt, and an arbitrary unknown secret; assert none
    occur in serialized events, formatted stderr, or runtime snapshot exported for diagnostics;
  - assert malformed objects and a throwing `toString` map to fixed `provider_error` without
    throwing the classifier.
- `runtime/pi-host/test/protocol.test.ts`
  - pass a raw provider rejection through the real public peer and assert only the exact fixed tuple
    crosses stdout; assert no secret byte exists in the complete captured stream.

### Rust consumer and lifecycle

- `crates/koni-core/src/pi_runtime_state.rs::accept_event`
  - validate runtime-error code/message/retryable against the exact protocol allowlist; unknown or
    mismatched tuples terminate the host before callback/persistence.
- `crates/koni-core/src/pi_runtime_process.rs::{run_turn_inner,finish_turn}`
  - retain `(code, message, retryable)` and return a typed Pi runtime failure rather than erasing it
    into an unstructured `Process` string.
- `crates/koni-core/src/engine.rs::{reconcile_failed_pi_launch,reconcile_direct_pi_agent_exit}`
  - persist a structured `runtime_failure` object and derive the compatibility
    `supervision_error` only from its canonical fixed message.
- `crates/koni-core/src/agent.rs::{write_pi_compat_event,compact_pi_runtime_event}`
  - once Rust has validated the tuple, include the canonical fixed message at the location the
    existing TUI error renderer reads; keep raw provider text impossible by construction.
- `crates/koni-core/src/engine.rs` planning dispatch around `4216-4364`
  - stop blind relaunch of non-retryable/unknown failures and bound only compiler-proven zero-effect
    transient retries.

Required Rust regressions: every valid tuple passes; unknown code and code/message/boolean mismatch
fail closed; a malicious host message containing secrets never reaches callback/transcript/agent
result; typed error preserves true and false; non-retryable planning failure does not increment its
attempt on repeated ticks; transient zero-effect failure retries only to the cap; transient
nonzero-usage/tool attempts do not auto-replay; the TUI chat renders the canonical action rather
than `Agent turn failed`.

## Output-budget documentation transition discovered during this audit

The earlier output-cap claims are now historical. `docs/pi-runtime.md:286-293`,
`runtime/pi-host/README.md:90-99`, `pi-runtime-architect.md:350-351`,
`primary-integrator.md:740-741`, the central rows near `AGENT_COLLAB.md:95-98`, and the integration
matrix near `935-936` say Koni serializes `max_output_tokens`. The first isolated acceptance request
showed that invented field is rejected by the ChatGPT Codex backend, and current source/test now
proves it is absent.

Preserve each older statement and append an adjacent transition: `output_token_budget` remains an
honest compiler/local cumulative output-accounting and between-round continuation bound. Koni still
passes Pi's `maxTokens` option, stops another model/tool round when the remaining allowance is below
the provider floor, rejects inconsistent/over-budget published usage, and accounts for everything
reported. The pinned ChatGPT Codex adapter does **not** serialize a provider-side output cap, so a
single response can exceed the local allowance before post-response rejection/billing; Koni must
not claim a hard provider/billing cap. The exact payload-absence regression replaces the former
payload-presence gate.

## Final handoff — 2026-07-14 22:50 MST

Status: `review_complete_released`. The repository-root cutover to `/Users/max/Desktop/koni` is
complete; all paths above are repository-relative and remain valid. No source lease is claimed.

The minimum safe implementation is smaller than the optional automatic-retry policy described
above: land the fixed host classifier and secret-negative tests, preserve/validate its tuple in
Rust, surface the canonical action in durable agent/TUI state, and stop the existing unconditional
failed-record relaunch. It is safe for **all** classified failures to wait for explicit resume in
that first patch. Bounded automatic retry of compiler-proven zero-effect transient attempts is a
separate ergonomic optimization; do not delay the secrecy/diagnostic fix or infer replay safety
from `retryable: true` alone.

No test command was run because this was a read-only design audit on a moving primary-integration
fingerprint. No auth/inference, provider request, credential access, source edit, build/install,
project mutation, cockpit action, or live/forensic run action occurred.
