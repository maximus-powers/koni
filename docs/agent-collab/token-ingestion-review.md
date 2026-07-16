# Token ingestion review

## 2026-07-15 23:07 MST — read-only audit complete; source lease released

Owner: `token-ingestion-review/root`

Scope was read-only inspection of core run-token aggregation and the preserved acceptance run
`019f66a9-df5a-7302-a3e1-00482d37a7ab` under
`/Users/max/Desktop/updog-koni-acceptance-1`. No Rust, profile, TUI, live state, binary, process,
worktree, or cockpit surface was changed. In particular, this lane did not cross the active
`scope-replan-recovery/root` lease in `crates/koni-core/src/engine.rs`.

### Current source findings

1. `run_token_usage` recursively scans only two compiler-owned roots:
   `work/tickets/**` and `control/agents/**` (`engine.rs:48167-48215`). That ownership boundary is
   correct and should remain closed. Canonical-path deduplication already prevents the same file
   from being merged twice.
2. Worker discovery admits only literal `worker.log` (`engine.rs:48280-48289`), while every current
   direct-Pi Lead slice and ticket worker writes a validated
   `worker.<agent-id>.attempt-<positive-n>.log`. The existing strict filename validator is
   `is_direct_pi_worker_log_name` (`engine.rs:54456-54468`) and should be reused; a broad
   `worker*.log` match would admit product-shaped files unnecessarily.
3. The general log accumulator accepts only top-level `turn.completed`
   (`engine.rs:48292-48343`). It therefore omits:
   - direct-Pi `pi.turn_usage` terminal checkpoints;
   - legacy direct-Pi nested `event.event == "turn_completed"` records;
   - summed `pi.event/event.usage` fallback deltas when a timeout, host loss, or runtime-state
     failure occurs before a terminal checkpoint.
4. Planning already has the desired checkpoint-over-delta accounting precedence in
   `direct_pi_planning_usage` (`engine.rs:46374-46540`), and the caller reconstructs and syncs that
   ledger even when the planning process returns an error (`engine.rs:5172` onward). Thus planning
   budget recovery is not losing these tokens. The cockpit/run aggregate still loses them because
   it uses the narrower general accumulator, then deliberately does not merge a `pi-*` planning
   session (`engine.rs:48194-48214`) to avoid double counting. The two accounting paths need one
   shared normalizer.
5. The raw field conventions differ by runtime:
   - native Codex `turn.completed.usage.input_tokens` is gross input and already contains cached
     input; canonical total is input plus output and canonical new usage is
     `input - cached + output`;
   - Pi `RuntimeUsage.input_tokens` is uncached input, `cached_input_tokens` is a separate bucket,
     and `total_tokens` contains uncached input + cached input + output. Normalize Pi as
     `gross_input = total - output`, `provider_total = total`, and
     `new_tokens = total - cached`. Reasoning remains a subset of output and is never added again;
   - Koni's compatibility `turn.completed` writer deliberately converts Pi into the legacy gross
     input shape only after the output artifact is durable (`agent.rs:1127-1157`), while
     `pi.turn_usage` is an earlier exact provider-usage checkpoint that survives schema-invalid or
     otherwise failed publication (`agent.rs:927-956`).

### Smallest shared parser contract

Read each admitted file once and retain a bounded per-Pi-turn accumulator keyed by its durable
`turn_id`. At end of that one file pass, choose exactly one usage source per turn in this order:

1. direct-Pi committed compatibility `turn.completed` (prefer its nested RuntimeUsage; fall back to
   the gross top-level usage only for compatibility);
2. `pi.turn_usage`, or a legacy compiler-owned nested `turn_completed` record;
3. the sum of `pi.event` usage deltas when neither terminal form exists.

Native Codex top-level `turn.completed` records remain independent occurrences because legacy
Codex JSONL does not expose a stable turn ID. A committed/checkpoint/legacy-terminal Pi record
increments `completed_turns`; a delta-only partial turn contributes spent tokens but not a
completed turn. Malformed/non-runtime records remain ignored as today. The same normalizer should
serve both `direct_pi_planning_usage` and cached run-log aggregation so the budget and cockpit can
never diverge again. Preserve the current per-file size/mtime cache.

The direct worker discovery change is only:

- Agent root: retain `stdout.jsonl` and `resume-*.log`.
- Worker root: retain literal `worker.log` and additionally accept only
  `is_direct_pi_worker_log_name(name)`.

Do not scan `planning/transcript.jsonl` or agent YAML result objects; both mirror events already in
the admitted logs and would introduce a second accounting authority.

### Identity and compatibility ambiguities to keep explicit

- Modern Pi records have compiler-generated UUID turn IDs, so checkpoint/delta/compatibility
  deduplication within one log is exact. Native Codex records have no equivalent ID and cannot be
  deduplicated beyond canonical file ownership without inventing identity.
- The smallest implementation keys Pi turns within each canonical log. No current producer mirrors
  an admitted turn into two admitted log files: the planning transcript is outside the scan and an
  agent result is YAML, not a usage log. If a future resume mechanism copies the same Pi turn into
  another admitted log, the normalizer should evolve to return run-global `(runtime, turn_id)`
  records before merging rather than silently count both.
- Three preserved logs use the older untyped envelope
  `{runtime:"pi-sdk", event:{event:"turn_completed", ...}}`. Accept this only inside the already
  validated compiler-owned log roots and let it supersede same-turn usage deltas. Modern writers
  use `pi.turn_usage`; the legacy form remains necessary for historical-run truth.
- Direct-Pi worker transcripts cap at 32 MiB (`engine.rs:54440-54444`). Once the truncation marker
  is sealed, a later exact checkpoint cannot be appended. Delta fallback is therefore only a lower
  bound for a truncated pre-checkpoint log. None of the preserved acceptance logs is near that cap.
  Exact accounting for such a future case requires either a separately uncapped compiler-owned
  usage ledger or a reserved terminal slot; it should not be solved by trusting mutable provider
  state or blindly summing an agent YAML duplicate.

### Preserved-run arithmetic

At the paused, zero-agent audit boundary, the current scanner reports only five top-level agent
completions:

- gross input `303,168`
- cached input `181,760`
- output `43,133`
- reasoning output `34,374`
- provider total `346,301`
- cache-excluding/new tokens `164,541`
- completed turns `5`

Applying the parser contract to all 6 owned agent logs and all 78 validated direct-worker attempt
logs yields:

- gross input `6,389,393`
- cached input `5,126,144`
- output `117,326`
- reasoning output `64,317`
- provider total `6,506,719`
- cache-excluding/new tokens `1,380,575`
- terminal/checkpoint turns `76`
- partial delta-only turns `7`

Breakdown as `provider total / cached / new`:

- planning: `434,867 / 333,312 / 101,555` (exactly matches `planning/session.yaml`);
- review/other agents: `265,836 / 120,832 / 145,004`;
- Lead slices: `69,687 / 0 / 69,687`;
- ticket workers: `5,736,329 / 4,672,000 / 1,064,329`.

The ingestion correction is therefore `+6,160,418` provider tokens and `+1,216,034` new tokens
over the current scanner. This does not change the display contract: `1,380,575` new tokens is the
headline, while `5,126,144` cached input and `6,506,719` provider total remain secondary telemetry.

### Focused regression matrix for the implementation owner

1. Mixed native Codex and direct-Pi records prove both input conventions normalize to the same
   canonical buckets and reasoning is not double counted.
2. One Pi turn containing deltas, `pi.turn_usage`, and compatibility `turn.completed` counts only
   the committed terminal usage once.
3. A checkpoint without compatibility completion (schema/publication failure) counts exact usage
   once and increments the terminal/checkpoint turn count.
4. A delta-only timeout/runtime failure sums deltas once, contributes token spend, and does not
   increment completed turns.
5. The legacy untyped nested `turn_completed` envelope supersedes same-turn deltas.
6. Recursive worker discovery admits both a ticket attempt log and a nested Lead-slice attempt log,
   rejects malformed/direct-product-shaped names, and retains legacy literal `worker.log`.
7. Planning reconstruction and general run aggregation return the same result for an identical Pi
   log; preserve the existing `direct_pi_planning_ledger_charges_terminal_failures_and_timeout_deltas_once`
   regression.
8. An unchanged refresh reuses the cache; appending a new terminal invalidates only the changed log.
9. A compact preserved-run-shaped fixture asserts the exact category arithmetic without copying
   conversation content or live state.

Status: audit complete and read-only lease released. Implementation is intentionally deferred until
the active semantic-rebind owner releases `engine.rs`.

## 2026-07-15 — implementation transition

The semantic-rebind lease released and `token-ingestion-impl/root` implemented the audited
contract in the exact parser/discovery/cache ranges named above. The former deferral remains as
handoff history; current verification and release status live in
[`token-ingestion-impl.md`](token-ingestion-impl.md).

### 2026-07-15 — superseding review findings closed

The implementation owner also incorporated the independent frozen-source findings: an exact
628-token legacy untyped Lead delta and fail-closed bucket validation with lower-precedence
fallback. The original audit's arithmetic is therefore restored rather than revised; see the
superseding release checkpoint in `token-ingestion-impl.md`.
