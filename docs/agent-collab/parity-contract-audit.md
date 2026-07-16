# Executable parity contract coordination

Owner: `parity-contract-audit/root`

Status: active on branch `pi-native-port`.

## Lease

This lane owns `reference/parity/**`, `scripts/parity-ledger.mjs`,
`scripts/parity-ledger.test.mjs`, and append-only coordination notes. It does
not own Rust behavior, `packages/**`, root package/workspace files, live
projects, credentials, installed binaries, runs, models, terminals, or cmux.

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
