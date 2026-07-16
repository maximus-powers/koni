# Token accounting UI

Owner: `token-accounting-ui/root`

Status: `ready_for_integration` — exact source symbols released; focused Cargo rerun pending the
separately owned compiler save point

Last checked: 2026-07-16 (Phoenix)

## Exact lease

- `crates/koni-tui/src/ui.rs`: only `draw_header`, `draw_runs`, a narrow formatter for compact
  cache-excluding token headlines, and focused assertions for those renderers.
- Append-only token-display evolution notes in `docs/control-center.md` and
  `docs/tui-cleanup-backlog.md`.
- This mailbox and the matching central-ledger row.

The underlying accounting is explicitly out of scope. `RunSummary.new_tokens` remains canonical
for compact headlines. Overview continues to expose uncached input, output, reasoning, cached
input, and provider total separately. This lane does not touch `model.rs`, core ingestion,
`engine.rs`, profiles, live/project state, installed or global binaries, processes, worktrees,
cockpit, or cmux.

## Coordination checkpoint

Before claiming the lease, I read the central registry, scanned every persona mailbox for active
TUI/token ownership, and read the token-display, token-ingestion, TUI truth, polish, visual-audit,
and primary-integrator histories in full. The prior token-display lease is released. The active
primary/compiler and Pi lanes exclude these exact presentation symbols. The shared worktree is
heavily dirty, so edits remain range-scoped and formatting will be check-only.

## Decision

The current header and Runs row correctly consume `new_tokens`, but render only `250K tks`; that
label is visually indistinguishable from a cache-inclusive/provider total. Compact headlines will
retain the abbreviated count and explicitly call it `new`, without changing arithmetic or
removing Overview telemetry.

## Inbox

<!-- Append signed, dated coordination questions or findings below. -->

## 2026-07-16 release checkpoint

Implemented only the presentation distinction:

- the selected-run header now renders, for example, `250K new tks`;
- every Runs row uses the same explicit compact label;
- the ordinary compact-count formatter remains unchanged for Overview buckets, agent-chat input /
  output, and planning-budget metrics;
- Overview still leads with cache-excluded new use and separately lists uncached input, output,
  reasoning, cached input, and provider total.

Focused assertions now prove the new compact formatter, both rendered headline locations, absence
of provider total from those locations, and the unchanged Overview breakdown. Append-only notes
beside the earlier token-display contract make the label clarification explicit without rewriting
the prior decision.

Verification:

- `rustfmt --edition 2024 --check crates/koni-tui/src/ui.rs` — passed.
- scoped `git diff --check` for the TUI and owned documentation — passed.
- exact renderer test
  `ui::tests::header_and_runs_panel_show_cache_excluding_token_usage` — dispatched in the private
  target `/Users/max/Desktop/.koni-token-accounting-ui-target`, but compilation stops in the
  separately leased `crates/koni-core/src/engine.rs` before TUI code because the active relocation
  transaction currently references three not-yet-implemented symbols. This is the known main-lane
  save point, not a TUI diagnostic. Rerun the exact test and the full TUI library once that owner
  restores compilation.

Final coordination sweep re-read every mailbox's owner/status/lease digest and the full current
primary/relocation/token/TUI histories. No new presentation overlap appeared. The exact symbols
above are released to `primary-integrator/root`; no live state, installed/global binary, core,
model, process, profile, worktree, cockpit, or cmux surface was touched.
