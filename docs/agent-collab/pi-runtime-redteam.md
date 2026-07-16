# Pi runtime red-team

## Status

`released_to_primary_integrator` — independent adversarial review and the narrowly delegated
bounded-stderr repair are complete.

## Lease

- `crates/koni-core/src/agent_runtime.rs`: replace the runtime host's unbounded stderr file with a
  continuously drained, bounded diagnostic prefix and prove a stderr-spamming host cannot block.
- This mailbox only. No engine, worker-broker, migration, profile, CLI, TUI, release, or installed
  state is owned by this lane.

## Review decisions

- Public frames, runtime-state events, planning logs, and worker logs have independent byte or
  cardinality ceilings. Host stderr previously bypassed every one of them and could fill disk during
  a one-hour turn.
- The supervisor now pipes stderr to a dedicated drain thread. It preserves a diagnostic prefix,
  reserves room for an explicit truncation marker, stops writing at 256 KiB, and continues reading
  and discarding until EOF so the child cannot block on pipe backpressure.
- The stderr thread is joined on normal termination and all post-spawn failure paths. Capture/write
  errors are surfaced after the child is killed and reaped rather than causing the drain to stop
  while the child is live.
- macOS can return `EPERM` from `killpg` after a naturally exited leader becomes a zombie. That is
  accepted only when an independent `/bin/ps` scan proves the unreaped process group has no live
  member. A live same-group helper remains a hard termination error.

## Verification

- `rustfmt --edition 2024 crates/koni-core/src/agent_runtime.rs` — clean.
- `git diff --check -- crates/koni-core/src/agent_runtime.rs` — clean.
- `cargo test -p koni-core agent_runtime::tests::supervised_host_drains_stderr_without_blocking_and_caps_diagnostics --lib -- --exact --nocapture`
  — passed 1/1. The fake host writes four times the capture limit before reading its compiler
  request; it still answers, terminates, and leaves an exact 256 KiB prefix-plus-marker file.
- `cargo test -p koni-core agent_runtime::tests --lib -- --nocapture` — passed 9/9, including
  timeout termination, exited-leader descendant cleanup, fd-3 inheritance, and descriptor hygiene.
- `cargo check -p koni-core --lib` — passed. Existing unrelated dead-code warnings remain.

## Remaining coordination note

- `worker.log` is bounded at 8 MiB, but it is shared across all worker sessions for one ticket.
  Once cumulative history reaches the cap, later agent records point at a permanently truncated
  stream; the marker is also absent when an older file already leaves insufficient marker space.
  Prefer a per-agent log path or reserve/rotate a compiler-owned marker slot. This lane did not edit
  that worker-owned range.

### Resolution — 2026-07-14, `pi-worker-tools/root`

- Direct-Pi production launches now use a unique same-directory
  `worker.<agent-id>.attempt-<n>.log`, while each durable agent record continues to store that exact
  stdout/stderr path and parent-derived `worker.pid` recovery remains unchanged.
- The 8 MiB writer reserves the complete truncation-marker slot. On reopen, an unmarked legacy file
  already inside that reserve is shortened only to the payload ceiling and sealed with the marker;
  a sealed attempt remains immutable. Scoped Git exclusions and runtime cleanup recognize the new
  compiler-owned filename without hiding similarly named product files outside the runtime root.
- Focused marker/path and cleanup regressions pass, as does `cargo check -p koni-core --lib`.
