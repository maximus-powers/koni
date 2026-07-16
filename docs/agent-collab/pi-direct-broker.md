# Pi direct tool broker

## Status

`in_progress` under delegation from `pi-runtime-architect/root`.

## Exact lease

- `crates/koni-core/src/engine.rs` only:
  - the `AgentBrokerGrant` / `AgentBrokerIngress` identity metadata and accessors;
  - a new direct-Pi grant claim and revalidation adapter adjacent to
    `claim_agent_mcp_grant` / `revalidate_agent_broker_ingress`;
  - narrowly named broker-adapter unit fixtures/tests in the existing `engine.rs` test module.
- This mailbox and one adjacent status row in `docs/AGENT_COLLAB.md`.
- No launch call site, CLI, profile/template, graph/compiler semantic, Pi host/protocol module,
  installed binary, cockpit, cmux, Updog, or forensic run state is leased.

## Locked compatibility contract

- The Koni supervisor is the process-bound broker authority for direct Pi dispatch. The Pi SDK
  host is its exact owned direct child and is pinned by process birth plus immutable executable
  binding in the durable grant.
- Direct Pi calls reuse `AgentBrokerIngress` and `execute_agent_mcp_tool` unchanged so durable
  replay, one-way CAS, context-first, accepted-output closure, compiler-owned tool effects, and
  receipt persistence remain one authority path.
- Historical Codex/MCP grant fields, readers, and tests remain readable as compatibility history;
  no new production path claims through the MCP-child topology.
- Every claim and call fails closed on wrong grant/agent/attempt/checkout, wrong broker process,
  wrong host birth/session/image, dead/recycled/non-child host, mutable grant hash, currentness,
  or tool scope.

## Coordination

- 2026-07-14: read the central registry, `pi-runtime-architect.md`, active Pi mailboxes, the
  context-hardening handoff, current `git status`, and the live broker implementation/tests before
  editing. `engine.rs` is heavily shared; this lease uses only the exact symbols above and no
  whole-file formatter.
- 2026-07-14: sent the proposed function/data shape to `pi-runtime-architect/root` before source
  edits. The initial proposal accepts an exact host executable path and constructs/verifies its
  immutable binding inside core, avoiding exposure of the private historical binding type.

## Verification

- Pending: focused direct-claim identity/image/liveness tests.
- Pending: focused adapter replay/context-first/post-output tests.
- Pending: existing context-hardening regressions if shared compilation permits.
- Pending: scoped formatting and `git diff --check`.

## Release state

Released to `pi-runtime-architect/root` at the 2026-07-14 checkpoint below.

## 2026-07-14 implementation handoff

Implemented in the leased `engine.rs` symbols:

- `AgentBrokerGrant.runtime_host_binding` is an omitted-when-empty, hash-bound direct-host record.
  Legacy `expected_codex_parent` grants therefore retain their serialized shape and integrity hash.
- `AgentBrokerGrant::runtime_host_identity()` makes record, Lead-slice, recovery, commit, and run
  deletion checks provider-neutral while retaining the legacy fallback.
- `claim_agent_runtime_grant(cwd, grant_id, agent_id, attempt, broker_identity, host_identity,
  host_executable)` is the integration API. It independently resolves the live host executable,
  canonicalizes and hashes it, requires the host identity to remain an owned process-group leader,
  requires `ppid == broker_identity.pid`, validates the supplied broker birth/current PID and the
  compiler-pinned broker executable, repeats both image checks under the run barrier and grant
  lock, validates current run/record/lease authority, and atomically persists host binding plus
  the existing claimed-broker state.
- `revalidate_agent_broker_ingress` selects the direct-host proof when the ingress carries that
  binding. Every subsequent `execute_agent_mcp_tool` call therefore proves the same broker birth,
  exact live host birth/image/direct-parent topology, immutable grant hash, current record/lease,
  enabled tool, and existing one-way CAS before dispatch.
- No new tool executor was introduced. The provider-neutral adapter deliberately returns the
  existing `AgentBrokerIngress`; `execute_agent_mcp_tool` and all durable reservation/replay,
  context-first, post-output closure, effect, receipt, and terminal-product code are unchanged.

Adversarial coverage:

- `direct_pi_host_binding_rejects_wrong_session_parent_liveness_and_image` rejects a different
  Koni PID/birth, wrong direct parent, dead/recycled host, wrong executable path, wrong hash,
  recycled host session, and ambiguous legacy/direct identity.
- `broker_claim_scope_rejects_wrong_agent_attempt_checkout_and_repository` remains the shared
  exact agent/attempt/checkout/common-dir scope proof used by both claim paths.
- `direct_pi_worker_grant_preserves_context_replay_and_terminal_cas` uses a real owned direct child
  and real durable run/grant state. It proves non-context-before-context and post-output supplement
  attempts produce zero effects, exact context/output/compile requests replay without duplicate
  effects, and post-compile product drift fails before dispatch.
- Historical composed MCP tests and readers were not removed or routed into the new production
  topology.

Verification:

- `cargo test -p koni-core engine::tests::direct_pi_host_binding_rejects_wrong_session_parent_liveness_and_image --lib -- --exact --nocapture`
  — passed 1/1.
- `cargo test -p koni-core engine::tests::direct_pi_worker_grant_preserves_context_replay_and_terminal_cas --lib -- --exact --nocapture`
  — passed 1/1.
- Compilation completed with only pre-existing Pi credential-service dead-code warnings.
- `git diff --check -- crates/koni-core/src/engine.rs docs/AGENT_COLLAB.md
  docs/agent-collab/pi-direct-broker.md` — clean.
- `rustfmt --edition 2024 --check crates/koni-core/src/engine.rs` reports only the separately owned
  pre-existing `validate_graph_at_ticket_root` formatting delta at line 13952; every leased direct
  broker hunk matches rustfmt. No whole-file formatter was run.

Protocol-15 sweep: re-read every top-level product document and every persona mailbox changed
since this lane's initial checkpoint before handoff. The Software regression mailbox's previously
open “no provider-neutral adapter API” gate is now routed to the parent with the exact API above;
this child did not edit that active owner's test or release claim. No new overlapping question or
source lease was found. No binary, profile, project, process, run, cockpit, cmux, Updog, or forensic
state was changed.

## 2026-07-14 provider-neutral dispatch integration lease

Status: `in_progress` under a new bounded delegation from `pi-runtime-architect/root`.

Exact lease:

- `crates/koni-core/src/agent_tool_broker.rs`: a concrete provider-neutral broker owning one
  claimed `AgentBrokerIngress`, its trusted immutable `AgentToolContext`, safe model-facing result
  projection, bounded validation-rejection state, terminal-tool classification, tool-definition
  catalog, and focused tests.
- Minimal exports in `crates/koni-core/src/lib.rs`; only a minimal engine visibility helper if the
  existing public ingress/view/execute functions prove insufficient.
- This mailbox and the existing central direct-broker row.
- No engine claim/revalidation implementation, CLI MCP server, runtime host/protocol, profile,
  migration, TUI, product documentation, launch call site, or live state is leased.

Compatibility requirements:

- The concrete broker calls the existing `execute_agent_mcp_tool`; it creates no second tool
  authority or replay path.
- Model-facing successes retain MCP's bounded projections (`context` document only,
  `record_note` receipt fields, public `wait_worker`, and generic accepted status). Internal
  errors cross only through `agent_mcp_safe_error_for_tool`, including the existing three-strike
  bounded validation stop.
- Tool definitions are derived only from the immutable claimed ingress view and are expressed as
  `RuntimeToolDefinition`, ready for `RuntimeSessionStart.tools` without CLI imports.
- The same compiler-closing tools that end the current model boundary return
  `AgentToolOutcome::Terminate`; replay of those tools remains terminal.

## 2026-07-14 provider-neutral dispatch release

Status: `released_to_pi-runtime-architect`; the bounded follow-up lease above is closed.

Implemented contract:

- `AgentRuntimeToolCatalog::from_ingress_view` validates every enabled tool against the immutable
  compiler-issued role, rejects empty/duplicate/foreign catalogs, preserves grant order, and emits
  `RuntimeToolDefinition` values directly consumable by `RuntimeSessionStart.tools`.
- `DurableAgentToolBroker::new(ingress, trusted_context)` owns the claimed
  `AgentBrokerIngress`. The trusted context must be constructed by the Rust launcher from the exact
  launched session/run/agent/attempt and the same captured Pi host identity used for the direct
  claim. Every call requires full value equality before the adapter inspects its name, arguments,
  or call ID.
- Role-specific argument validation matches the historical MCP boundary and occurs before durable
  dispatch. Unknown capabilities and malformed context, graph-context, note, output, compile,
  dispatch, and yield arguments produce bounded model errors with zero engine effects.
- The adapter serializes calls through one owned ingress and invokes the existing
  `execute_agent_mcp_tool`; it therefore introduces no second replay, CAS, context, compiler, Git,
  or receipt authority. A successful `yield_lead` retains the existing spawned-agent reaper drain.
- Model-facing success projection remains bounded: context returns only the document or replay
  recovery path, graph context and the compact wait DTO pass through, record-note returns only its
  public receipt fields, and other successes return `{"status":"accepted"}`. Internal failures
  pass only through `agent_mcp_safe_error_for_tool`; the existing three-strike
  `revise_validation` ceiling is retained without a fourth durable dispatch.
- Successful `compile`, `submit_and_compile`, and `yield_lead` return
  `AgentToolOutcome::Terminate`, including durable replay, so the Pi runtime stops the current
  agent boundary without another model completion.

Integration shape for the Rust runtime owner:

```rust
let ingress = claim_agent_runtime_grant(/* exact compiler and host identities */)?;
let broker = DurableAgentToolBroker::new(ingress, trusted_context.clone())?;
let tools = broker.runtime_tools();
// Put `tools` in RuntimeSessionStart, then dispatch each validated host call through:
let outcome = AgentToolBroker::execute(&broker, &trusted_context, &call)?;
```

Verification:

- `cargo test -p koni-core agent_tool_broker::tests --lib -- --nocapture` — passed **6/6**. The
  matrix covers catalog order/role schemas, exact trusted-context rejection before inspection,
  malformed-argument rejection before dispatch, bounded success projection, consuming terminal
  tools, safe compiler diagnostics, and the three-call validation ceiling.
- That focused command compiled the current crate test target. A later fresh
  `cargo check -p koni-core --lib` was stopped by an active foreign `engine.rs` edit whose call to
  `ensure_managed_sidecar_directory_chain` had no current definition; it emitted no broker error.
  An earlier check at the broker checkpoint passed before that unrelated range moved.
- `rustfmt --edition 2024 --check crates/koni-core/src/agent_tool_broker.rs` — clean.
- Scoped `git diff --check` for the broker module, minimal library export, registry, and this
  mailbox — clean.

Protocol-15 release sweep: rescanned all documentation for current Pi/Codex/runtime/tool-broker
transitions, re-read every top-level product document changed since the preceding direct-claim
checkpoint, and re-read every persona mailbox changed after this follow-up lease began. The
Software mailbox's former “no stable provider-neutral adapter API” gate is now closed by the API
above; its requested Software-configured end-to-end case remains owned there. Concurrent owners
have since added a separate Pi runtime state/process layer, so this lane did not duplicate or edit
that work. The security review's host lifecycle, credential intent/secrecy, artifact trust,
containment/OAuth, and migration-publication holds remain integration gates and are not weakened
by this broker release. No binary, profile, project, credential, process, network, run, cockpit,
cmux, Updog, or forensic state was changed.
