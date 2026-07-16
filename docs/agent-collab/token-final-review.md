# Token ingestion final review

## 2026-07-15 — independent read-only review in progress

Owner: `token-final-review/root`

Scope is an independent, read-only audit of the shared native-Codex/direct-Pi token normalizer in
`crates/koni-core/src/engine.rs` and the preserved paused acceptance run
`019f66a9-df5a-7302-a3e1-00482d37a7ab`. This lane does not edit Rust, live run state, binaries,
processes, the cockpit, or worktrees.

### Preliminary findings sent to the implementation owner

1. **Legacy untyped Pi delta was omitted.** The first implementation admitted nested
   `event: "usage"` only when the envelope had `type: "pi.event"`. The preserved run also contains
   older compiler-owned envelopes with `runtime: "pi-sdk"` and no `type`. One such Lead turn has
   only an untyped usage delta and no terminal. Omitting it understated the run by exactly `628`
   provider/new tokens (`578` input, `50` output, `34` reasoning). The implementation owner agreed
   to admit the type-less legacy form only after the strict runtime, root, and filename ownership
   gates, at the same lowest per-turn precedence as typed deltas.
2. **Malformed higher-precedence usage needed to fall through.** Saturating subtraction accepted
   internally inconsistent native or Pi totals and could understate a planning budget. The owner
   agreed to reject malformed usage candidates before storing them, so a malformed committed or
   checkpoint record cannot suppress a valid lower-precedence checkpoint, legacy terminal, or
   delta. Native requires numeric input/output, cache no greater than gross input, and reasoning no
   greater than output. Pi requires numeric total and visible buckets, checked
   `input + cache + output <= total`, and reasoning no greater than output. Equality is deliberately
   not required because a provider total may include an additional token bucket.

### Preserved-run cross-check before those corrections

Strict discovery found 84 compiler-owned logs: six agent `stdout.jsonl` logs and 78 validated
`worker.<agent-id>.attempt-<positive-u32>.log` files. A separate one-pass reconstruction found 76
terminal/checkpoint turns plus seven partial delta-only turns and no malformed usage records. With
the omitted legacy delta, the implementation-shaped calculation was:

- provider total `6,506,091`
- cache-excluding/new `1,379,947`

Restoring the one valid 628-token legacy delta produces the previously audited truth:

- gross input `6,389,393`
- cached input `5,126,144`
- output `117,326`
- reasoning output `64,317`
- provider total `6,506,719`
- cache-excluding/new `1,380,575`
- completed terminal/checkpoint turns `76`

Final source inspection, focused private-target tests, cache/turn-count checks, and exact live-log
reconstruction remain pending until the implementation owner declares a compile-stable freeze.

## 2026-07-15 — final independent verdict: clean

The implementation owner froze the token ranges after addressing both preliminary findings. A
second source inspection and private-target rerun found no remaining release-blocking defect.

### Source contract verified

- `normalize_usage_log` reads each admitted file once and retains separate native-Codex and
  direct-Pi buckets. Pi state is keyed by durable turn ID within that file.
- Selection is exactly committed compatibility completion, then checkpoint, then legacy terminal,
  then summed deltas. Invalid higher-precedence candidates are not stored, so they cannot mask a
  valid lower-precedence record.
- A committed/checkpoint/legacy terminal contributes one completed turn. A delta-only interrupted
  turn contributes spend and zero completed turns.
- Native arithmetic is gross input plus output for provider total and
  `gross input - cached input + output` for new tokens. Pi arithmetic is provider `total_tokens`,
  `total_tokens - output_tokens` for normalized gross input, and
  `total_tokens - cached_input_tokens` for new tokens. Reasoning remains a subset of output.
- Native and Pi records reject impossible cache/reasoning/visible-total relationships with checked
  arithmetic. Pi provider total may exceed the named visible buckets; this is conservative and
  preserves providers with an additional bucket.
- Log discovery remains closed to `work/tickets/**/{worker.log, validated attempt log}` and
  `agents/**/{stdout.jsonl,resume-*.log}`. Product-shaped lookalikes and planning transcript/YAML
  mirrors are not admitted. Canonical-path deduplication is retained.
- Planning and whole-run aggregation call the same cached normalizer. The cache key retains the
  existing canonical path plus file size/mtime invalidation contract.
- Legacy nested usage and terminal envelopes are admitted only with `runtime: "pi-sdk"`, inside an
  already admitted compiler-owned file, and when their `type` key is genuinely absent. Null,
  non-string, or unrelated types are not treated as legacy compatibility records.

### Independent verification

Using `CARGO_TARGET_DIR=/tmp/koni-token-final-review-target`:

- `usage_normalizer`: **4/4 passed**;
- `run_token_usage`: **4/4 passed**, including unchanged-cache reuse, append invalidation, strict
  discovery, and compact preserved-run arithmetic;
- planning/run normalization parity: **1/1 passed**;
- checkpoint/failure/delta planning-ledger accounting: **1/1 passed**.

The final read-only reconstruction of the actual paused run scanned exactly six admitted agent
logs and 78 admitted worker-attempt logs. It found no malformed usage record or JSON parse error,
and produced:

- gross input `6,389,393`
- cached input `5,126,144`
- output `117,326`
- reasoning output `64,317`
- provider total `6,506,719`
- cache-excluding/new `1,380,575`
- completed terminal/checkpoint turns `76`
- partial delta-only turns `7`

Planning independently reconstructs `434,867` provider / `333,312` cached / `101,555` new with
two completed turns, byte-for-value matching `planning/session.yaml`. The three legacy turns that
have both deltas and terminals have delta sums equal to their terminal totals; terminal precedence
therefore loses no spend. The lone legacy delta-only Lead turn contributes the corrected `628`
tokens and does not claim completion.

Known non-blocking boundaries remain the ones already documented by the original audit: identity
is per file because native logs and future cross-file Pi mirrors lack a shared current ownership
contract, and a worker log truncated before a terminal can provide only a delta lower bound. No
preserved acceptance log is truncated or mirrored. Final verdict: **ready for guarded integration**.
