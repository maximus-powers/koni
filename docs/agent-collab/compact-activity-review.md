# Compact Recent Activity title review

Owner: `compact-activity-review/root`

Status: `complete — READY FOR INTEGRATION`

## Scope and preserved contract

- Read-only adversarial review of the current central row, `tui-polish.md`, the released compact
  smoke audit, the TUI truth/visual audit notes, and only the `recent_activity_title` selector, its
  call from `draw_recent_activity`, and the adjacent focused Activity regressions in
  `crates/koni-tui/src/ui.rs`.
- This reviewer owns only this mailbox. No Rust, product documentation, central coordination,
  profile, binary, cockpit/cmux surface, forensic run, or live state was edited.
- The reviewed contract is the measured candidate order
  `Recent activity · 1h 02m active` -> `Activity · 1h02m` -> `Activity`, retaining authoritative
  significant units and anchored zero, and omitting an oversized suffix wholesale rather than
  clipping, clamping, or approximating it. Runtime authority, layout proportions, rows,
  timestamps, lifecycle, and Evidence remain outside this slice.

## Initial findings — preserved

1. **No P0/P1 implementation defect found.** `recent_activity_title` subtracts the two horizontal
   border cells before selection and measures each complete padded candidate with
   `UnicodeWidthStr`, so Ratatui receives a title that fits the actual 25-cell title budget of the
   27-cell Activity panel at 82 columns. It does not use byte or scalar-value length.
2. The candidate semantics are exact. An authority-valid runtime first tries the full title,
   removes only the known ` active` suffix for compact presentation, joins the formatter's
   whitespace-separated significant units, and then falls back to padded identity-only
   `Activity`. It never truncates a duration fragment or adds an unlabeled approximation.
3. The ordinary one-hour compact title is 18 display cells and fits the 25-cell budget. The full
   one-hour title is 33 cells and is retained at the exact 35-cell panel / 105-column dashboard
   threshold. Approved numeric zero becomes complete `Activity · 0s`. `u64::MAX` milliseconds is
   formatted with safe unsigned division and deterministically selects complete identity-only
   `Activity` at 82 columns.
4. No-runtime semantics remain fail-neutral. At the supported compact geometry the 17-cell
   `Recent activity` identity fits, while no runtime suffix can be constructed without the
   pre-existing `active_runtime_label` authority gates. Existing Activity tests retain no-run,
   planning, missing/malformed-anchor, missing/nonnumeric-duration, approved-zero, and elapsed
   checks.
5. The full-dashboard regression inspects the exact Activity top-border row, not a loose rendered
   substring. It proves the real 82x24 layout still yields a 27-cell Activity panel, proves compact
   one-hour and zero titles without clipping, proves the exact roomy threshold keeps the full
   title, and proves extreme duration falls back without ellipsis or a surviving duration
   fragment.
6. The only non-blocking coverage observation is that the new full-dashboard test does not repeat
   a no-runtime 82x24 border-row case. The pre-existing Activity/authority tests cover the branch,
   and the selector's 17 <= 25 fit is direct, so this is not a release gap and does not justify
   expanding the bounded slice.

## Authority and change-boundary audit

- `draw_recent_activity` still obtains the selected typed run, computes the same items, viewport,
  scroll start, block, inner area, empty-state copy, timestamps, tones, and row truncation. The only
  title-side call is `recent_activity_title(run, area.width)`.
- The selector is presentation-only and delegates runtime eligibility/value construction to the
  existing `active_runtime_label`. It does not read new snapshot fields, alter approval/provisional
  or planning gates, mutate state, change focus/help, or affect panel rectangles or row capacity.
- Fixed candidate text contains only one-cell presentation characters, but using terminal display
  width remains the correct invariant and keeps the budget correct if label glyphs evolve.

## Verification and coordination history

- Independently clean:
  - `rustfmt --edition 2024 --check crates/koni-tui/src/ui.rs`
  - `git diff --check -- crates/koni-tui/src/ui.rs`
- I started the module-qualified exact compact-dashboard regression in the shared default target.
  It waited behind the active shared build, reached the test executable, and was still waiting for
  completion. At `primary/root`'s request I cancelled only my redundant Cargo process because the
  owner's full locked run was already queued/running. That interrupted attempt is **not** counted
  as test evidence.
- Owner evidence supplied for this source state: the module-qualified exact compact-dashboard
  regression passes **1/1**, the Activity filter passes **6/6**, and the full locked TUI library
  passes **294/294**. The primary owner retains the final integration matrix.

## Final verdict — 2026-07-14

**READY FOR INTEGRATION.** No P0/P1 finding remains in the reviewed selector, call site, or focused
regressions. The code satisfies the published full/compact/identity hierarchy, Unicode border
budget, anchored-zero, extreme-duration, no-runtime, and authority-preservation requirements. The
small no-runtime snapshot duplication noted above is optional P2 test hardening, not a correctness
or release blocker.
