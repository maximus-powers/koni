# Token display contract

## 2026-07-15 21:54 MST — active implementation lease

Owner: `token_display_contract_audit/root`

Exact source lease:

- `crates/koni-tui/src/model.rs`: add the cache-excluding run-summary projection and preserve the
  independent provider-total breakdown; carry the configured planning-budget metric into the UI
  projection.
- `crates/koni-tui/src/ui.rs`: make the main header and Runs rows render cache-excluding/new usage;
  make Overview lead with new usage while labeling cached input and provider total as secondary;
  render `processed_tokens` budgets as processed rather than incorrectly calling them new; add
  focused rendering regressions.
- append-only token-semantics transition notes in `docs/control-center.md`,
  `docs/tui-cleanup-backlog.md`, and `docs/AGENT_COLLAB.md`.

No core aggregation, agent-chat/timeline copy, profile, installed binary, project state, live run,
process, or cockpit surface is in this lease. The tree is shared and dirty; unrelated edits remain
untouched. Verification uses a private Cargo target only.

Read-only overlap scan found no other persona claiming `RunSummary`, `PlanningBudgetProgress`, or
the main-cockpit token renderers. The pre-existing `primary-integrator` note establishes the product
decision: new/uncached usage is the cockpit headline, while cached/provider totals remain explicitly
labeled forensic telemetry.

## 2026-07-15 22:01 MST — implementation complete; lease released

`RunSummary` now preserves both `total_tokens` and `new_tokens`; the header and Runs rows use only
the latter. Overview leads with new/cache-excluded usage, breaks out uncached input/output/reasoning,
and labels cached input plus provider total as secondary telemetry. Historical snapshots derive the
same distinction from their available buckets and safely treat a total-only record as all-new when
no cache bucket exists.

Planning budget progress now carries its configured metric through the model. Default
`new_tokens` budgets remain labeled `new`, while a custom `processed_tokens` budget is labeled
`processed` in both header and Overview rather than silently claiming to exclude cache.

Evidence, all using `/tmp/koni-token-display-contract-target`:

- five focused model/rendering regressions passed;
- complete `koni-tui` library suite: **303/303 passed**;
- `cargo clippy -p koni-tui --all-targets -- -D warnings` passed;
- repository-wide format check and `git diff --check` passed.

No live process, run, state, installed binary, profile, core aggregation, agent chat, or planning
timeline was touched. The exact implementation lease above is released.

## 2026-07-15 22:48 MST — accounting distinction confirmed; ingestion follow-up

The operator confirmed the intended interpretation of the two totals. The cockpit headline is
cache-excluding `new_tokens` (uncached input plus output; reasoning remains an output breakdown),
while the larger provider/processed total includes cached input. The headline must not be changed
back to provider total.

A read-only acceptance-ledger audit also found two provider event conventions that core must
normalize before projection: native Codex terminal events report cached input as a subset of
`input_tokens`, while direct-Pi checkpoints report uncached `input_tokens` beside
`cached_input_tokens` and include both in `total_tokens`. The explicit run-snapshot `new_tokens`
field is therefore canonical for the TUI; it must never be re-derived from ambiguous raw provider
fields when present. A separate core-ingestion follow-up remains pending after the active
`engine.rs` recovery lease: include Koni-owned `worker.<agent>.attempt-<n>.log` direct-Pi terminal
checkpoints exactly once, normalized to the canonical aggregate, without summing per-message usage
deltas alongside the terminal checkpoint.
