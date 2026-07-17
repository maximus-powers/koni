# Executable parity contract coordination

Owner: `parity-contract-audit/root`

Status: active on branch `pi-native-port`.

## Lease

This lane owns `reference/parity/**`, `scripts/parity-ledger.mjs`,
`scripts/parity-ledger.test.mjs`, `scripts/capture-rust-oracle*.mjs`, and
append-only coordination notes. It does not own Rust behavior, `packages/**`,
root package/workspace files, live projects, credentials, installed binaries,
runs, models, terminals, or cmux.

## Frozen boundary

- Annotated oracle tag: `rust-oracle-baseline`
- Tag object: `d46ab2fc9fe67d0a6b9238c47c60e3fe753f522e`
- Commit: `fcc425e51114bcedb9aeae44d6e8c8418a525e6b`
- Tree: `2d96962668275f8e180f6d66cb574354ac0b0cda`
- Oracle execution must use a clean detached worktree, disposable Git project,
  disposable Pi home, and no provider/model call.

## 2026-07-16 — initial executable ledger green

The legacy seven prose scenarios remain intact and are now surrounded by a
machine-checked v1 ledger: five JSON Schemas, strict normalization v2, one
oracle fingerprint, eight narrowly scoped issue records, and 24 typed
case/action pairs. Current inventory is 29 checkpoints, 65 assertions (51
oracle and 14 specification), and 126 typed actions across configuration,
planning, scheduling, grants, tickets, Git, lifecycle, recovery, native Pi
sessions, TUI behavior, Software, and Research.

Known Rust behavior is not a blanket golden master. Ordinary assertions are
oracle-authoritative. Desired behavior may depart only through an exact
disposition; defect/supersession classifications bind concrete case,
assertion, and capture paths plus closure proof. Release mode refuses
quarantine.

Evidence:

- `node scripts/parity-ledger.mjs validate --json`: green; 24 cases, 29
  checkpoints, 65 assertions, 126 actions, 8 issues.
- `node --test scripts/parity-ledger.test.mjs`: 7/7 green.

Next work is the first no-model oracle capture adapter for deterministic
install, validate, compile, and run-control projections. Capture generation is
not permitted to use the mutable port checkout as the oracle or to touch a
user project/Pi home.

## 2026-07-16 — deterministic command capture green and reproducible

The first executable oracle artifact is checked in at
`reference/parity/oracle/rust-oracle-baseline/deterministic-command-surfaces.json`.
It was independently regenerated twice from detached tag `rust-oracle-baseline`;
both complete normalized files have SHA-256
`04c01423ebf329331f5d7f3a663d411df841c9bc9d6693fb91904fa85eb716c8`.

The driver captures the fresh Software install tree, successful profile
compiler output, initialized compatibility-run validation, the empty registry
projection, and exact fail-closed unknown-run pause/play/cockpit errors. All
but one installed resource use raw byte digests. The sole exception is
`.koni/migration-receipt.json`, whose generated migration UUID/path is
narrowly normalized; repeat testing showed every other installed byte was
identical.

Positive behavior is also executable without a provider: the capture runs the
tagged exact Core contracts
`selected_proof_that_is_also_a_ticket_target_compiles_once_deterministically`
and `selected_run_play_pause_is_durable_across_planning_and_active_phases` and
records only their semantic pass results, excluding build/timing noise.

An attempted use of `plan-run` was rejected from the capture design because
the frozen CLI crosses into planning-agent/Pi-host execution after durable
setup. It is not acceptable to risk a provider call merely to seed a positive
control fixture. The final driver statically forbids planning, spawn, approval,
resume-planning, and supervision commands; positive CLI lifecycle projections
remain specified by `KPAR-LIF-*` until a no-provider fixture adapter can expose
them, while the underlying positive Rust contract is already executable.

Evidence:

- Two isolated generation passes: byte-identical capture digest above.
- `node --test scripts/capture-rust-oracle.test.mjs`: 5/5 green.
- `node --test scripts/parity-ledger.test.mjs`: 9/9 green, including capture
  provenance/isolation rejection tests.
- `node scripts/parity-ledger.mjs validate --json`: green.
- `npm run check`: green; Core 108/108, both profile packages, manifest tests,
  parity validation, and ledger tests.

**Concurrent-state note:** a later composed check after the managed-session
lane began requiring `KoniContextProvider.loadRecoveryState` is temporarily
red in three mocks owned by that lane (`pi-compaction`, `pi-managed-session`,
and `pi-production-session`). The owner and primary integrator were notified;
no package source or test was changed from this parity lease. All parity-only
validation and 14 tests remain green.
