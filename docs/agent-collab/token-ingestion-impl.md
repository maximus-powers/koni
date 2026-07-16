# Direct-Pi token ingestion implementation

## 2026-07-15 — active bounded source lease (`token-ingestion-impl/root`)

This lane consumes the completed read-only audit in
[`token-ingestion-review.md`](token-ingestion-review.md). It owns only:

- the shared direct-Pi/native usage normalizer used by `direct_pi_planning_usage` and
  `run_token_usage` in `crates/koni-core/src/engine.rs`;
- strict usage-log admission in `is_codex_usage_log`, including validated
  `worker.<agent-id>.attempt-<positive-n>.log` names;
- the existing per-file usage cache and focused token-ingestion test ranges adjacent to those
  symbols.

The implementation must read each admitted log once, choose one source per durable Pi turn in
committed-compatibility / checkpoint-or-legacy-terminal / delta-fallback order, retain native
Codex terminal events as independent occurrences, and preserve planning/run arithmetic parity.
It does not own path identity, profile configuration, semantic rebind, TUI, installed binaries,
project state, processes, worktrees, or cockpit surfaces. Verification uses a private Cargo target
and no whole-file formatter while the shared worktree remains dirty.

### Questions for other personas

<!-- Append signed questions or overlap warnings here. -->

## 2026-07-15 — implementation complete; lease released

The core now caches one normalized parse per admitted file with separate native-Codex and
direct-Pi buckets. Direct planning consumes only the explicit `runtime: pi-sdk` bucket; whole-run
aggregation combines both. Direct-Pi state is bounded to one accumulator per durable turn and
selects committed compatibility completion, otherwise `pi.turn_usage`, otherwise the legacy
nested terminal, otherwise summed usage deltas. Checkpoints survive schema/publication failures;
delta-only timeout/runtime failures contribute spend without incrementing `completed_turns`.

Worker discovery retains literal `worker.log` and additionally reuses the producer's strict
`worker.<agent-id>.attempt-<positive-n>.log` validator at any depth beneath the compiler-owned
ticket root. Agent discovery remains limited to `stdout.jsonl` and resume logs. Planning
transcripts, result YAML, malformed filenames, and product-shaped lookalikes remain excluded.

Private-target verification under `/Users/max/Desktop/.koni-token-ingestion-target`:

- usage-focused core tests: **10/10 passed**;
- exact planning/run normalization parity: **1/1 passed**;
- exact failed/checkpoint/timeout planning ledger: **1/1 passed**;
- warning-denied `koni-core --all-targets` Clippy: passed;
- scoped `git diff --check`: passed.

The compact regression fixture preserves the audited paused-run arithmetic exactly:
`6,506,719` provider total, `5,126,144` cached input, `1,380,575` new tokens, `76` terminal or
checkpoint turns, and seven additional delta-only partial turns. No live/project state, binary,
process, worktree, TUI, profile, path-identity, or semantic-rebind surface changed. The source
lease is `ready_for_integration` and released.

## 2026-07-15 — independent-review hardening supersedes the initial release checkpoint

The initial green checkpoint above is retained as history, but an independent frozen-source review
found two omissions before integration and the lane reopened to close both:

1. A higher-precedence native/Pi record with inconsistent buckets could previously win through
   saturating subtraction. Native usage now requires numeric gross input/output, cached input no
   greater than gross input, reasoning no greater than output, and checked arithmetic. Pi usage
   allows provider total to exceed the visible buckets, but any present bucket must be numeric,
   checked `input + cached + output` may not exceed provider total, and reasoning may not exceed
   output. An invalid committed/checkpoint/legacy record is ineligible, so the same turn falls
   through to the next valid checkpoint, legacy terminal, or deltas.
2. One preserved Lead slice contained a compiler-owned legacy untyped delta-only envelope worth
   exactly `628` provider/new tokens. Legacy nested usage and terminal envelopes are now accepted
   only when their `type` key is genuinely absent, after the existing `runtime: pi-sdk`, owned-root,
   strict-filename, and turn-ID gates. Explicit null/bogus types remain ignored. The untyped delta
   stays lowest precedence and does not claim a completed turn.

Superseding private-target verification:

- usage-focused tests: **12/12 passed**, including the exact 628-token legacy delta;
- shared-normalizer precedence/malformed suite: **4/4 passed**;
- exact planning/run parity: **1/1 passed**;
- exact failed/checkpoint/timeout planning ledger: **1/1 passed**;
- warning-denied `koni-core --all-targets` Clippy: passed;
- token-owned rustfmt deltas: none; scoped `git diff --check`: passed.

This is the current release checkpoint. No live/project state, binary, process, worktree, TUI,
profile, path-identity, or semantic-rebind surface changed.

### Independent release verdict

`token-final-review/root` independently reran the focused matrix and reconstructed the paused run
from exactly six admitted agent logs plus 78 validated worker-attempt logs. Its final result is
clean and byte-for-value matches the audited truth: `6,506,719` provider, `5,126,144` cached,
`1,380,575` new, 76 terminal/checkpoint turns, and seven delta-only partial turns. Planning
independently matches its durable session ledger at `434,867 / 333,312 / 101,555`
provider/cached/new. The independent verdict is `ready for guarded integration`; full evidence is
append-only in [`token-final-review.md`](token-final-review.md).
