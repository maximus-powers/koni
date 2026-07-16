# Compact Recent Activity smoke audit

Owner: `compact-activity-smoke-audit/root`

Status: `released — read-only verdict`

## Exact lease and safety boundary

- Read-only inspection of `docs/AGENT_COLLAB.md`, `agent-collab/tui-polish.md`,
  `agent-collab/tui-visual-audit.md`, `control-center.md`, `tui-cleanup-backlog.md`,
  `live-smoke-findings.md`, and the current layout, Recent Activity, display-width, showcase, and
  `TestBackend` code in `crates/koni-tui/src/ui.rs`.
- This audit changes only this mailbox. It does not claim or edit Rust, product documentation, the
  central ledger, profiles, binaries, cockpit/cmux surfaces, worktrees, or live/forensic runs.
- The central queued row still says **unclaimed**. `tui-polish/root` has released its former
  `draw_recent_activity` / `active_runtime_label` truthfulness range and explicitly claims no next
  TUI source slice. `tui-truth-review/root` and `orchestration-philosophy/root` are read-only and
  released. I found no competing source lease.

## 82×24 reproduction

This is deterministic from the same geometry and Ratatui rendering used by the existing full-
dashboard `TestBackend` tests; no installed cockpit is needed.

- `draw` reserves 4 header rows and 1 footer row, leaving operate area
  `Rect { x: 0, y: 4, width: 82, height: 19 }`.
- Equal thirds produce widths **28 / 27 / 27**. Recent Activity is
  `Rect { x: 55, y: 4, width: 27, height: 8 }`.
- `Borders::ALL` leaves **25 display cells** for the top title. Ratatui renders a left-aligned title
  into that exact area and clips its right tail; the body remains 25 cells wide.
- Current `" Recent activity · 1h 02m active "` is **33 cells**. Its exact 27-cell panel-top
  capture is:

  ```text
  ┌ Recent activity · 1h 02m┐
  ```

  The elapsed number happens to survive, but the word `active` and trailing separation disappear.
  The result looks like a title cut off at the border rather than an intentional compact label.

Other authority-valid values show why this is not just decorative trailing-space clipping:

| Runtime | Current padded title width | Exact 82-column panel top | Lost meaning |
| --- | ---: | --- | --- |
| no authoritative runtime | 17 | `┌ Recent activity ────────┐` | none |
| `0s active` | 29 | `┌ Recent activity · 0s act┐` | partial word |
| `1h 02m active` | 33 | `┌ Recent activity · 1h 02m┐` | active-runtime qualifier |
| `23h 59m active` | 34 | `┌ Recent activity · 23h 59┐` | unit and qualifier |
| `12d 23h active` | 34 | `┌ Recent activity · 12d 23┐` | unit and qualifier |

For total dashboard width `W`, the current right-panel title budget is
`floor(W / 3) - 2`. The current semantic title (allowing only its trailing padding to clip) first
fits at **90 columns for `0s active`**, **102 columns for a one-digit hour/day form**, and
**105 columns for a two-digit hour/day form**. The complete padded strings need 93, 105, and 108
columns respectively. Thus every authority-valid runtime shape clips at the supported 82-column
minimum; longer elapsed values can lose a unit, not merely the word `active`.

The title occupies the border and does **not** remove an activity row. Separately, the 25-cell body
spends 10 cells on the timestamp and 2 on marker/spacing, leaving 13 for event text. That is the
broader visual-audit density finding, not part of this bounded title repair.

## Verdict and smallest truthful adaptive contract

**Fix in the next bounded TUI presentation slice.** Preserve `active_runtime_label` and every
existing approval/provisional/planning/malformed/missing-duration gate exactly. Adapt only how its
already-authoritative `Some(runtime)` is presented:

1. Measure with `UnicodeWidthStr`, using the actual bordered title budget; never rely on Rust
   character count or on one sample duration.
2. Prefer the full semantic label: `Recent activity · 1h 02m active`.
3. If it does not fit, use the exact compact label: `Activity · 1h02m` (preserve all significant
   units and anchored `0s`). With normal one-cell title padding it is 18 cells and renders cleanly
   at 82 columns:

   ```text
   ┌ Activity · 1h02m ───────┐
   ```

4. If an extreme day count makes even the compact candidate exceed the measured budget, render
   identity-only `Activity`. Omit the runtime suffix rather than clip it, clamp it, discard a
   significant unit, or show an unlabeled approximation.

This full → compact → identity hierarchy follows the independent philosophical review recorded
adjacent in `tui-polish.md`: panel identity outranks secondary runtime metadata, row timestamps
already establish recency, and compact copy should not repeat `active`. That omission is also more
precise for paused or completed approved runs: this number is accumulated approved, unpaused
runtime, not a claim that an agent is active now. Authority is unchanged because only the existing
`Some` value may enter candidate selection.

## Exact regression recommendation

Claim only the title selection inside `draw_recent_activity`, one adjacent private display helper,
and focused `ui.rs` tests. Do not include `active_runtime_label`, layout proportions, activity-row
text/timestamps, Evidence, help/footer, lifecycle, compiler, or product docs in the same source
lease.

Minimum matrix:

1. A real full-dashboard `TestBackend::new(82, 24)` snapshot with a selected approved active run,
   `active_runtime_milliseconds = 3_723_000`, and one compiler event. Call top-level `draw`; assert
   the Activity rect remains width 27, the complete `Activity · 1h02m` candidate appears, and no
   clipped full-title fragment appears.
2. The same full dashboard at the exact roomy threshold (or a safely roomy width) retains
   `Recent activity · 1h 02m active` rather than compacting early.
3. At 82×24, approved numeric zero renders complete compact `Activity · 0s`; the existing no-run,
   provisional/planning, malformed-anchor, and missing/nonnumeric-duration cases still render no
   runtime.
4. An authority-valid extreme `u64` duration that cannot fit the compact candidate falls back to
   complete `Activity`, with no ellipsis or clipped duration fragment.
5. Assert candidates by terminal **display width** and inspect the exact Activity top-border row,
   so a test cannot pass merely because a substring survived somewhere else in the dashboard.

## Verification history

- Static reproduction checked the current top-level layout, exact equal-column arithmetic,
  Ratatui 0.29 bordered-title area/clipping behavior, current runtime formatter, and current
  `TestBackend` helpers/tests.
- A focused existing layout test was started only after the tree was reported at TUI 293/293, but
  the shared default Cargo target was held by another agent's long core build. Per integrator
  instruction, I did not wait or rerun; I interrupted only this audit's two blocked Cargo
  processes. No test result is claimed from that attempt.
- No repository source, product/central documentation, installed binary, cockpit, cmux surface,
  or live/forensic state changed.

## Status transition — 2026-07-14

The earlier statement that the central row still said **unclaimed** remains the exact pre-claim
checkpoint for this audit. The bounded implementation later landed under `tui-polish/root` using
the measured full `Recent activity · 1h 02m active` → compact `Activity · 1h02m` → identity-only
`Activity` candidate order; see the [source-owner claim and history](tui-polish.md#2026-07-14-compact-recent-activity-title-claim),
the independent [READY FOR INTEGRATION verdict](compact-activity-review.md#final-verdict--2026-07-14),
and the [release-approved living-doc sweep](activity-mailbox-release-sweep.md#verdict--2026-07-14).
The exact full-dashboard regression passes 1/1, the Activity filter passes 6/6, and the full locked
TUI library passes 294/294. The implementation changed title selection only: runtime-authority
gates, equal-column layout, Activity rows, binary/cockpit state, and live or forensic runs were not
changed. The original geometry and interrupted pre-claim Cargo attempt above remain causal history.
