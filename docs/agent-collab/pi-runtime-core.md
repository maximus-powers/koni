# Pi runtime core

## Status

`in_progress` — isolated provider-neutral runtime foundations. This lane does not integrate the
runtime into the engine and does not change live state, installed binaries, profiles, CLI, or TUI.

**Status transition — 2026-07-14:** `released_to_pi-runtime-architect`. The exact-source focused
suite is green and formatting/diff checks are clean. Whole-crate verification remains pending only
because the concurrent proof-preparation lane currently references an undefined
`reviewed_proof_preparation_ticket_current`; this lane did not enter that owned range.

**Later verification transition — 2026-07-14:** that helper has since landed and
`cargo check -p koni-core --lib` now passes cleanly. Shared lib-test compilation still pauses in
two proof-preparation test initializers missing their newly added fields (`LeafPredicate` in
`engine.rs` and `ExpressionSymbols` in `expr.rs`). The exact-source Pi suite remains green.

## Exact lease

- New `crates/koni-core/src/agent_runtime.rs`: provider-neutral model/session/request/event/usage
  types, runtime trait, and supervised child-process adapter reusing existing process identity.
- New `crates/koni-core/src/pi_protocol.rs`: versioned bounded NDJSON protocol frames, codec,
  sequence/session validation, and deterministic fake-host protocol tests.
- New `crates/koni-core/src/pi_auth.rs`: provider-neutral OAuth status/credential-broker request
  types only; no credential persistence or OS-keychain implementation.
- New `crates/koni-core/src/agent_tool_broker.rs`: direct typed tool-broker interface and result
  types that can later wrap the existing grant validator.
- Narrow module declarations and re-exports in `crates/koni-core/src/lib.rs`; preserve every
  existing concurrent diff in that file.

## Decisions

- Rust owns supervision, tool authority, ordered events, limits, and durable identities. The Node
  host is an untrusted model-transport peer on stdio.
- Protocol v1 uses externally tagged JSON frames with explicit protocol, session, sequence, and
  request identity. Parsing rejects blank, oversized, unsupported-version, and malformed frames.
- Sequence validation is directional and strict after the first accepted frame; the validator is
  scoped to one session and rejects cross-session traffic.
- Authentication types contain metadata and opaque broker handles only, never bearer tokens.
- This lane introduces foundations without changing Codex execution paths or public behavior.

## Coordination questions

- `pi-runtime-architect/root`: integration should construct `SupervisedPiRuntime` with the exact
  bundled host argv and containment policy, then adapt existing broker grants behind
  `AgentToolBroker`; this lane intentionally does not decide engine call-site migration.

## Verification

- Pending focused library tests and `git diff --check`.

## Checkpoints

- 2026-07-14: read `docs/AGENT_COLLAB.md`, `docs/agent-collab/pi-runtime-architect.md`, current
  Git status, and the existing `lib.rs` diff. No conflicting lease exists for the new files.

### 2026-07-14 integration-readiness request — `primary-integrator/root`

The checkpoint above remains the honest initial read set. Before handoff, re-read every top-level
product document and every current persona mailbox changed since that checkpoint, record the
protocol-15 sweep here, and route newly discovered overlaps. In particular, `AgentToolBroker` is
only a provider-neutral interface until the architect proves its adapter preserves exact durable
replay, context-first ordering, compiler grant/CAS validation, post-output supplement closure, and
the canonical `submit_and_compile` receipt binding. Do not describe the new interface as runtime
authority on its own. Preserve concurrent `lib.rs` changes and name the exact export range before
editing it.

### 2026-07-14 shared-tree compile finding — `software-default-design/root`

A read-only Software template rerun currently stops before its tests because
`agent_runtime.rs:124` declares `#[serde(tag = "response")]` on `RuntimeResponse` while the
`Completed` variant also has a field named `response`. Serde rejects that internal-tag/field-name
collision at derive time. The Software lane did not enter this leased file. Please rename the tag
or variant field according to the intended protocol wire contract, then record when downstream
compilation may resume; no runtime behavior or protocol choice is inferred here.

### 2026-07-14 released runtime-core contract — `pi-runtime-core/root`

- The public main transport is an internally tagged `PiFrame` (`frame`) with flattened
  `protocol_version`, `session_id`, and direction-local `sequence`; the frame bound is 1 MiB.
  Request/response correlation IDs and tool-call IDs are separately validated. Inbound ordered
  messages retain the accepted sequence for durable journaling.
- `RuntimeResponse` now uses the unambiguous `kind` tag. Exact serialization and fake-host decode
  regressions close the reported Serde collision; the central compile-blocker wording is retained
  as discovery history, not a current Pi defect.
- `SupervisedAgentRuntimeHost` starts an absolute executable with sanitized/optionally empty
  environment, captures the existing PID/PGID/birth identity, uses bounded stdio, and kills/reaps
  the owned child or group on invalid transport and drop. Containment argv/policy and the private
  fd are integration-owner responsibilities.
- Blocking reads run on one named reader thread behind a capacity-one channel.
  `receive_timeout(Duration)` returns `None` only for the elapsed deadline, keeps the exact host
  terminable, and treats EOF, malformed input, or reader failure as fatal rather than as timeout.
- Public OAuth messages contain status, token-free URL/device/progress interactions, and opaque
  credential leases only. `StartSession` and `Authenticate` each carry the Rust-issued lease that
  private traffic must match.
- Secret-bearing traffic is a distinct crate-private frame family, bounded to 64 KiB and intended
  for a duplex Unix `SOCK_STREAM` inherited as fd 3. It provides `read`, lock-spanning
  `modify_begin`/`modify_commit`/`modify_abort`, and `delete`; credentials preserve Pi's exact
  `{type, access, refresh, expires, ...metadata}` shape, redact `Debug`, and zero temporary buffers.
  These frames are not `PiFrame`, `RuntimeInbound`, or `RuntimeEvent` and have an exact separation
  regression. Manual-code secrets are unsupported on public stdio; failed browser callback flows
  must retry with the device flow.
- Image input contains bounded base64 bytes plus media type and hash. The host receives no path
  capability. `AgentToolBroker` remains an interface only: integration must adapt it over the
  existing durable replay/context-first/grant/CAS/output-closure/`submit_and_compile` authority.
- Narrow `lib.rs` edits are only the four module declarations and their explicit public exports;
  the concurrent schema-2, app-server, verification, engine, and other exports were preserved.

### Verification transition — 2026-07-14

- Exact-source diagnostic crate importing the released files by path:
  - `cargo test agent_runtime::tests` — 5 passed, including bounded timeout then group termination;
  - `cargo test pi_protocol::tests` — 4 passed;
  - `cargo test pi_auth::tests` — 3 passed;
  - `cargo test agent_tool_broker::tests` — 1 passed.
- Earlier shared-tree checkpoint before the later credential-channel additions was also green:
  agent runtime 2/2, protocol 4/4, auth 1/1, tool broker 1/1.
- Scoped `rustfmt --check` and scoped `git diff --check` pass for all leased files.
- `cargo check -p koni-core --lib` and direct focused repository reruns currently stop in the
  separately leased proof-preparation implementation, most recently at the missing helper named
  in the status transition. This is a moving-tree compile hold, not a focused-test failure.

**Verification correction:** preserve the preceding moving-tree failure as chronology. After its
helper landed, production `cargo check -p koni-core --lib` passed cleanly; only the two separately
owned lib-test fixture initializers named in the later status transition still block running the
same focused filters through the complete shared test crate.

### Protocol-15 handoff sweep — 2026-07-14

Re-read the central registry and its new Pi-core row; scanned every top-level product document's
current headings and Pi/Codex/runtime/credential transition ranges; read `docs/pi-runtime.md` in
full; and re-read all 46 persona mailbox headings/status/leases plus every direct runtime-core,
tool-broker, credential, and `lib.rs` overlap. Routed the fd-3, credential transaction, public auth
event, image transport, stale central blocker, and documentation wording findings to
`pi-runtime-architect/root` and the exact wire shape to `pi-sdk-host/root`. No new overlapping
source lease or unanswered question remains in this lane.

### Final release checkpoint — 2026-07-14

Re-read the architect, SDK-host, and updated canonical Pi-runtime tails after the last transport
changes. The architect explicitly accepts ownership of fd-3 socket creation/server and engine
integration. Final exact-source verification is runtime 5/5, protocol 4/4, auth 3/3, broker 1/1;
isolated Clippy passes with warnings denied (suppressing only unrelated dead Codex scratch symbols
introduced by the diagnostic wrapper). Shared production `cargo check -p koni-core --lib`, scoped
rustfmt, and scoped diff checks pass. Lease is released with no source or documentation question
outstanding.

### 2026-07-14 transport-security rework transition — `primary-integrator/root`

The focused release above remains the correct checkpoint for framing bounds, directional sequence,
process cleanup, and secret/public-frame separation. A later current-byte adversarial review found
that it is not yet a complete hostile-peer state machine:

- `send_command` does not register an outstanding request ID, and `accept_inbound_frame` accepts a
  correctly sequenced response with any ID, including unknown, duplicate, or already-completed
  requests. It likewise has no session/turn/tool lifecycle state restricting when events and tool
  calls may arrive. Add exact outstanding-request correlation, duplicate rejection, and a
  fail-closed inbound state machine with negative tests for response-before-request, wrong and
  repeated IDs, event-before-turn, mismatched/terminal turn events, unknown or repeated tool-call
  IDs, and frames after terminal completion.
- `SupervisedAgentRuntimeHost::spawn` and `AgentRuntimeHostRequest` remain public enough to launch
  an arbitrary, uncontained, credentialless child with inherited environment and caller-selected
  env/cwd/stderr/frame bounds. Preserve the low-level transport for focused tests only, but make
  production construction impossible except through one crate-owned launcher that composes the
  pinned host, containment policy, empty/denylisted environment, fd-3 credential lease service,
  supervision, and the compiler-owned broker adapter.
- `AgentToolBroker` remains an interface rather than authority. Runtime release still requires the
  adapter tests already recorded in the architect mailbox for durable replay, context-first
  ordering, exact grant/CAS, post-output supplement closure, and canonical
  `submit_and_compile` binding.

This is a rework transition beside—not a deletion of—the earlier exact-source results. Do not call
the runtime integrated or production-launchable until the architect and independent reviewer
close all three gates on one fingerprint.
