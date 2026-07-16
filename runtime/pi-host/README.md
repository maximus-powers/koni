# Koni Pi SDK host

This package is Koni's direct TypeScript host for Pi. It imports
`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` at exactly `0.80.7`;
it does not invoke the Pi CLI/RPC, `pi-coding-agent`, extensions, project resources,
or ambient tools.

The Rust process remains authoritative for tools, compiler state, receipts, Git,
containment, credentials, and recovery. The host owns only provider transport,
Pi agent turns, streaming normalization, OAuth flow callbacks, and in-memory session
context.

## Process contract

- Node `>=22.19.0` is required.
- Public control is bounded NDJSON on stdin/stdout, with a maximum encoded frame of
  1 MiB. Stdout contains protocol frames only; diagnostics use stderr.
- Private credentials use a duplex Unix `SOCK_STREAM` inherited as file descriptor 3,
  with a maximum encoded frame of 64 KiB. Production launch must fail closed if fd 3
  is absent or is not the dedicated credential socket.
- Public and private frames are different tagged unions and cannot parse as one
  another. Credential material must never be copied to public frames, events,
  transcripts, argv, environment, project files, or diagnostics.
- Each public direction has an independent sequence beginning at 1. A gap, replay,
  cross-session frame, wrong protocol version, malformed JSON, oversized frame, or
  compiler/host direction violation is fatal.
- Compiler requests execute serially in inbound order. `tool_result` frames bypass
  that request queue so a brokered tool can resolve while a turn is active.
- A successful `start_turn` response is written before `turn_started` or any other
  event for that turn. The response write is the commit point that starts provider work.
- Every accepted turn attempts exactly one terminal `turn_completed` event. Runtime
  errors precede that terminal event; if the terminal write itself fails, the public
  transport is aborted and the session cannot accept another turn.

The public wire exactly mirrors the Rust types in `pi_protocol.rs`,
`agent_runtime.rs`, and `agent_tool_broker.rs`:

- compiler to host: `request`, `tool_result`;
- host to compiler: `response`, `event`, `tool_call`;
- commands: pre-session `list_models` and `metadata`, then `start_session`,
  `start_turn`, `control`, `authenticate`, and `shutdown`;
- response payloads use the `kind` tag and events use the `event` tag;
- tool outcomes are `success`, `error`, or `terminate`.

`list_models` returns only provider/model capability metadata; `metadata` returns
the pinned host/Pi versions and explicit ambient-resource/credential assertions.
Neither command reads credentials or requires a started runtime session.
The model capability list includes Pi's `max` thinking level when the selected model
advertises it; `start_session` accepts the same level without a Koni-specific alias.

Every declared model-facing tool is a schema-only Pi `AgentTool`. Its implementation
sends a `tool_call` frame to Rust and waits for the matching compiler-owned outcome.
Tools run sequentially. No filesystem, shell, Git, MCP, or network tool exists inside
this package. The first compiler `terminate` outcome is a turn-wide latch: Pi is
aborted immediately, later calls in the same mixed tool batch are not brokered, and
no later model request is made. After that call's matching `tool_completed`, the next
public turn event is the terminal `turn_completed`.

## Credential boundary

The public `authenticate` command contains only an opaque `credential_lease` and
token-free status or interaction data. Browser URLs, device codes, and progress may be
public runtime events; access and refresh tokens may not.

Pi's `CredentialStore` is implemented over fd 3:

1. `read` / `read_result` reads the credential bound to the opaque lease.
2. `modify_begin` / `modify_begin_result` asks Rust to hold its per-user credential
   lock across Pi's asynchronous mutation callback.
3. `modify_commit` / `modify_commit_result` persists the complete type-tagged OAuth
   credential, including provider metadata; `modify_abort` releases the lock on an
   unchanged value or error.
4. `delete` / `delete_result` performs logout through the Rust persistence authority.

The host retains returned credentials only as JavaScript values needed by the active
Pi request. The private reader zeroes temporary input buffers, and the shared error
redactor registers observed access/refresh values. JavaScript strings cannot be
reliably zeroized, so OS process isolation and prompt process termination remain part
of the security boundary.

OpenAI login uses Pi's provider-owned OAuth implementation. The selected option IDs
are verified against the pinned SDK (`browser` and `device_code`). Browser login uses
the local callback; v1 deliberately does not accept pasted authorization codes on the
public protocol, and fails manual-code fallback immediately with a direction to retry
device-code login. Login has a ten-minute hard deadline and host shutdown aborts the
provider controller. Upstream OAuth response bodies are never forwarded: failures map
to a stable public message, while structured access/refresh/code/verifier/device fields
are defensively redacted from events and outer stderr.

> **Provider-error projection transition — 2026-07-14:** The generic/redaction-first wording above
> is retained as implementation history. Accepted-turn provider failures now cross public stdio
> only as one of seven exact fixed code/message/retryable tuples. Arbitrary provider bodies are used
> solely as an 8-KiB-bounded classification hint and are never returned, logged, persisted, or
> included in diagnostic snapshots. Host-authored broker/protocol/internal failures use a separate
> fixed projection; fatal stderr uses the same rule. Rust validates the full tuple before any
> callback or durable transcript consumes it.

Provider usage must be finite, non-negative, safe-integer, internally consistent, and
non-overflowing before Koni emits a usage event. `output_token_budget` is explicitly a
cumulative generated-output cap, not a total-token cap: input and cache tokens remain
truthfully accounted but do not consume it. Each provider request receives the remaining
output allowance as Pi's `maxTokens`; for the pinned Codex adapter the host also injects
the same value as the serialized `max_output_tokens` request field. OpenAI Codex budgets
below 16 are rejected before acceptance instead of being clamped above the requested cap.
Reaching the cap prevents another tool/model iteration. If a provider ignores the cap
and reports cumulative output above it, the accepted turn fails closed with one error
terminal event and no assistant-completed or usage success event for the oversized
message. Usage accounting is transactional: that terminal repeats only the cumulative
usage deltas already published to Rust, so an overrun cannot make terminal reconciliation
claim tokens that were intentionally rejected.

## Development

Install without lifecycle scripts and run the complete package check:

```sh
npm install --ignore-scripts
npm run check
```

`npm run check` runs strict TypeScript checking, fake-provider/runtime/protocol tests,
the distributable ESM build, checksum verification, and an isolated startup smoke.
The production build is one self-contained `dist/koni-pi-host.mjs` bundle plus a
deterministic `dist/koni-pi-host.sha256` record. Only Node built-ins remain external;
the bundle does not require `node_modules` at runtime, and the build rejects every
non-Node external. TypeScript declarations are emitted separately under `dist/types/`
for package consumers.
The private package's root import is the executable entrypoint, not a side-effect-free
library surface.

Pi Agent internally imports the side-effectful legacy `pi-ai/compat` module only to
obtain a default stream and two shared utilities. The production bundle aliases that
module to `src/pi-compat-shim.ts`: the utilities remain direct Pi AI exports, while
the unused ambient stream default throws fail-closed. Koni's injected
`createModels`/`openai-codex` stream is therefore the only production model path.

`npm run artifact:verify` recomputes the bundle digest and fails on a missing,
malformed, or stale checksum. `npm run smoke:bundle` copies only the bundle into a
fresh temporary directory, starts it with no dependency path and fd 3 closed, and
requires module evaluation to reach the intentional private-credential boundary
without writing to stdout.

Tests cover exact frame tags and sequences,
accepted-before-event ordering, request serialization with re-entrant tool results,
broker-only tools, mixed-batch terminating outcomes, steering, ordered events,
transactional credentials, OAuth redaction, bounded OAuth cancellation, serialized
Codex output caps, adversarial provider overruns, validated usage, `max` thinking,
exactly-one terminal turns,
oversized/replayed frames, and private/public protocol separation.

## Hardening transition — 2026-07-14

This section supersedes the narrower packaging/control descriptions above while retaining
them as implementation history.

- `start_turn` and `control` side effects occur only after their `accepted` response is
  successfully written. A deferred control captures the active turn ID; if that turn reaches
  terminal publication while the response is backpressured, the side effect becomes inert and
  cannot steer, queue follow-up work for, or cancel a later turn. A control parsed after terminal
  publication is pending or complete is rejected with `terminal_race` so Rust can correlate and
  drain the response without reopening the turn.
- Outbound sequence numbers are committed only after a frame encodes within the bound, so a
  locally rejected oversized frame cannot create a sequence gap. Pi tool calls rejected locally
  before Rust dispatch produce an explicit `tool_rejected` event (`pi_tool_validation` or
  `pi_tool_truncated`) and never fabricate a compiler-owned tool outcome.
- OpenAI Codex accepts no provider request below its 16-output-token minimum. A turn whose first
  tool round leaves only 1–15 tokens stops as `output_token_budget` before another provider call,
  while preserving the last published cumulative usage.
- The standalone bundle no longer relies on Pi's lazy relative OAuth loader. Koni's provider
  adapter statically binds the OAuth implementation from the exact `0.80.7` dependency and the
  ordinary Codex response stream. Build and checksum verification reject the former opaque local
  dynamic-import markers and require the device/refresh closure to be present.
- The package root is now dual-purpose: direct execution starts the fd-3 host, while ESM import is
  side-effect-free and exposes the statically bound provider for artifact verification. The
  isolated smoke copies only `koni-pi-host.mjs`, supplies no `node_modules`, and exercises ordinary
  `toAuth`, expired-token refresh, and device-code login with intercepted transport before also
  proving direct execution reaches the intentional fd-3 boundary.

These changes close the source/artifact lazy-OAuth and stale-control defects. They do not by
themselves authorize production cutover: the signed credential-TCB provenance, Rust composition,
containment, migration, and stable-fingerprint release matrix remain integration-owned gates.
