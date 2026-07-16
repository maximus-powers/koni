# Durable process-identity hardening

Owner: `release_review_runtime/root`

Status: `released`

Started: 2026-07-16 12:29 MST

## Exact lease

This lane owns only the durable process birth marker and the minimum destructive-signal gate in
`crates/koni-core/src/agent.rs` and `crates/koni-core/src/engine.rs`, plus focused tests and
append-only coordination notes. It does not own configured-check execution, live run state,
binaries, cmux, TUI/CLI, profiles, acceptance repositories, or installed runtime behavior.

The current marker is rendered from `ps lstart` at one-second precision. A PID/PGID recycled within
that second can therefore compare equal to a stale compiler record. The correction will issue only
versioned kernel-native high-resolution markers for new records: Linux `/proc/<pid>/stat` start
ticks and macOS `proc_pidinfo` start time. Destructive signaling must require that strong marker,
the exact live PID/PGID relationship, and the existing executable binding. Legacy `ps-lstart`
markers remain readable for historical, non-destructive projection but are never signal authority.

Focused regressions will cover exact live strong matches, disappeared or replaced processes,
same-second PID/PGID reuse with different kernel birth values, legacy-marker denial before signal,
and platform parser behavior through an injectable observation seam.

## Released evidence — 2026-07-16 12:49 MST

New records now use `kernel-start-v2` markers. Linux binds the boot UUID and
`/proc/<pid>/stat` start ticks; macOS binds the `proc_pidinfo(PROC_PIDTBSDINFO)` start seconds and
microseconds. Both collectors reject zombies and bind the observed PID/PGID. Legacy prefixed and
unprefixed `ps lstart` values remain serde-readable history but fail the strong-marker check and
cannot report liveness or authorize TERM/KILL.

`terminate_owned_agent_process` keeps the existing PID/PGID ownership check immediately before
TERM and revalidates the same strong kernel identity immediately before SIGKILL. If TERM exits the
recorded leader while a descendant keeps the group alive, escalation now fails closed without
signaling the potentially recycled PGID. Existing runtime-host executable binding code was left
unchanged.

Focused verification is green:

- Core production check: `cargo check -p koni-core --lib`.
- Warning-denied Core clippy: `cargo clippy -p koni-core --lib -- -D warnings`.
- Workspace rustfmt check and scoped diff check.
- Nine focused regressions covering strong issuance/exact live matching, same-second replacement,
  PID/PGID drift, disappearance, legacy denial with the group preserved, Linux and macOS parsers,
  zombie rejection, exact live TERM-to-KILL escalation, and leader replacement between TERM and
  SIGKILL. Every focused invocation passed.

No live run, installed runtime, binary, cmux session, profile, acceptance repository, or unrelated
source was changed. This lane is frozen for integration.
