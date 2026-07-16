# Provider-error hardening

## Status and lease

`in_progress` — `provider-error-hardening/root/provider_error_hardening`, 2026-07-14.

This lane owns the fixed Pi-provider error projection, Rust tuple validation/preservation, and the
minimum safe planning-relaunch stop described in `provider-error-projection.md`. It may edit the Pi
host/runtime tests and the directly related Koni core runtime/engine tests. It does not own auth or
credential persistence, installation, project/profile configuration, TUI layout, Updog state,
acceptance-run state, cmux, or live processes.

## Implementation intent

- Project arbitrary provider failures onto a small fixed, secret-free protocol allowlist.
- Validate the complete `code` / `message` / `retryable` tuple at the Rust trust boundary.
- Preserve that typed tuple through turn failure and durable runtime state.
- Stop failed planning attempts from being silently relaunched; automatic transient replay remains
  a later optimization unless zero-effect safety is already explicit and bounded.
- Add focused adversarial tests and append documentation transitions without rewriting history.

## Released implementation — 2026-07-14

Status: `complete_released`. This lane no longer owns a source lease.

### Contract now implemented

- The Pi host maps arbitrary provider failures to seven fixed public classes. Only rate limiting
  and provider unavailability retain `retryable: true`; usage, authentication, access, request,
  and unknown failures are false. Classification reads at most an 8-KiB hint and never returns,
  logs, persists, or attaches any source byte.
- Host-authored broker, private-credential-channel, protocol, unsupported-runtime, and internal
  failures use separate fixed tuples. Fatal stderr and diagnostic snapshots use the same fixed
  projection rather than regex redaction as their authority boundary.
- Rust validates the exact `code` / `message` / `retryable` tuple before callbacks or transcripts,
  retains it in `KoniError::PiRuntimeTurn`, and persists a structured `runtime_failure` object.
  Compatibility `supervision_error` and agent-chat output receive only the canonical action.
- Planning treats the validated provider retry bit as diagnostic, not replay authority. A typed Pi
  turn failure marks the pipeline waiting and sets the planning lifecycle to paused with
  `operator_resume_required`; ordinary non-Pi launch/question retry behavior is unchanged. Pressing
  play is the explicit operator boundary that can authorize a new attempt.

### Files changed by this lane

- `runtime/pi-host/src/{errors.ts,runtime.ts,main.ts}`
- `runtime/pi-host/test/{runtime.test.ts,protocol.test.ts}`
- rebuilt `runtime/pi-host/dist/koni-pi-host.mjs` and checksum
- `crates/koni-core/src/{agent_runtime.rs,error.rs,lib.rs,pi_runtime_state.rs,pi_runtime_process.rs,agent.rs,engine.rs}`
- `crates/koni-tui/src/agent_chat.rs` (focused rendering regression only)
- `docs/{pi-runtime.md,AGENT_COLLAB.md}` and this mailbox

No credential/auth state, installed binary, Updog tree, acceptance run, cmux surface, or live
process was read or mutated. The concurrent file-credential lane had no owned-file overlap.

### Focused evidence

- `npm run check` in `runtime/pi-host`: strict typecheck; **51/51** tests; bundle build and checksum
  verification; isolated no-`node_modules` fd-3/static-OAuth smoke. Final bundle is 880,978 bytes,
  SHA-256 `8105823b53449033e8aeb6adef8e7d80bf8e8006d151b8bbb39384e7d956acdb`.
- `cargo test --locked -p koni-core pi_runtime -- --nocapture`: **19/19**.
- Exact focused Rust regressions: state allowlist **9/9**; typed failure **1/1**; canonical transcript
  **1/1**; planning operator-pause **1/1**; unchanged question-resume retry **1/1**.
- `cargo test --locked -p koni-tui pi_turn_failure_renders_the_compiler_validated_action`:
  **1/1**.
- `cargo clippy --locked -p koni-core -p koni-tui --lib -- -D warnings`: green.
- `cargo fmt --all -- --check` and `git diff --check`: green.

The first bundle smoke after fatal-message hardening correctly failed because the now-fixed generic
message prevented the smoke from proving it reached fd 3. The final design adds one fixed
`runtime_credential_channel` tuple selected only from Node's stable fd error code; it restores the
boundary proof without exposing the raw exception.
