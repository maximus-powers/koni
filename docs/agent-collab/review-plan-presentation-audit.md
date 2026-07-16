# Review Plan presentation audit

Owner: `review-plan-presentation-audit/root`

Status: `accepted / ready for integration (initial changes-requested and compile-blocked checkpoints preserved below)`

Last checked: 2026-07-14 17:20 MST

## Scope and safety boundary

Read-only audit of the Review Plan modal's title, footer, compact geometry, implemented keyboard
dispatch, and focused render coverage. I inspected `docs/AGENT_COLLAB.md`, the TUI polish and visual
audit mailboxes, `docs/control-center.md`, `docs/tui-cleanup-backlog.md`, and the approval dialog,
key handling, and tests in `crates/koni-tui/src/{ui,app}.rs`.

This lane owns only this mailbox. It did not edit Rust, product documentation, the central ledger,
the installed binary, profiles, cockpit/cmux state, or any live or forensic run.

## Authority and philosophy verdict

- **Accepted title:** the source literal should be `" Review plan "`, rendering the neutral title
  **Review plan**. The dialog is an inspection surface; the existing adaptive **Approve run** /
  **Revise plan** button separately names the authority-crossing action. The old
  `Review planning and approve` title incorrectly pre-commits a review toward one outcome.
- The visible Architecture, Risk, Verification, and Graph Seed tabs are heterogeneous sections of
  one plan, not several plans. The footer should therefore call them **sections**, not **plans**.
- The authoritative non-editor section aliases are `Left` / `Right` and `[` / `]`. The
  authoritative non-editor scroll aliases are `Up` / `Down`, `j` / `k`, and `PageUp` /
  `PageDown`. `PgUp` / `PgDn` are the compact, conventional labels for the latter pair.
- The contextual note immediately above the footer already explains whether Enter inserts a
  newline, approves, or revises. A bare `Enter` footer hint is therefore truthful and avoids
  duplicating state-dependent prose.

## Exact recommended presentation

Title literal:

` Review plan `

Footer literal:

`←→/[] sections · ↑↓/jk/PgUp/PgDn scroll · Tab focus · Enter · Esc`

The 82-column frame gives `centered_box(110, 36, ...)` a 78-cell outer width and the bordered
dialog a 76-cell inner/footer width. The recommended footer is 65 terminal display cells, leaving
11 cells of safety. It advertises every implemented section and scroll alias without clipping.

## Finding against the in-flight candidate

At the audit checkpoint, `draw_approval_dialog` had the accepted neutral title but used:

`←→/[] plans · ↑↓/jk scroll · Tab focus · Enter action/newline · Esc`

That candidate is not complete: it omits the implemented `PageUp` / `PageDown` scroll aliases and
describes the tabs as multiple plans. Its focused test asserted only the prefix
`←→/[] plans · ↑↓/jk scroll`, so it could pass while the remaining footer was clipped or stale.

## Exact suggested render assertions

Keep the dedicated `TestBackend::new(82, 24)` approval regression and require the complete
presentation, not a prefix:

```rust
let controls =
    "←→/[] sections · ↑↓/jk/PgUp/PgDn scroll · Tab focus · Enter · Esc";
assert!(rendered.contains("Review plan"), "{rendered}");
assert!(!rendered.contains("Review planning and approve"), "{rendered}");
assert!(rendered.contains(controls), "{rendered}");
assert_eq!(UnicodeWidthStr::width(controls), 65);
```

The full-literal assertion is the important clipping guard. The width assertion documents why the
copy is safe at the minimum compact width. The existing app regression already proves `Right`,
`]`, `j`, and `PageDown` dispatch before action focus; this presentation-only slice need not change
key handling. A later key-map completeness test could symmetrically cover `Left`, `[`, `Up`, `k`,
and `PageUp`, but that is not required to change these strings.

## Ownership and overlap notes

- The central ledger now gives `tui-polish/root` the exact active lease for
  `draw_approval_dialog` title/footer strings and focused `ui.rs` render assertions. No second
  active approval-presentation or `ui.rs` lease was found in the current mailboxes.
- `orchestration-philosophy/root` independently accepted the neutral title and identified
  **sections** as the accurate noun. That read-only verdict is compatible with this audit.
- Released Graph Seed, adaptive approval, Evidence/runtime, blocker-reason, New Run, and ticket
  presentation ranges are adjacent but do not overlap this exact string/assertion lease.
- No question requires approval-logic work. The only handoff request is for `tui-polish/root` to
  use the complete 65-cell footer and full-literal compact assertion before releasing the slice.

## Final acceptance — 2026-07-14 17:20 MST

**Accepted within the exact presentation scope.** `tui-polish/root` incorporated the audit while
it was in flight. A fresh read of the live diff confirms:

- the title literal is `" Review plan "`;
- the footer is exactly
  `←→/[] sections · ↑↓/jk/PgUp/PgDn scroll · Tab focus · Enter · Esc`;
- the dedicated 82×24 test is named
  `approval_review_uses_neutral_title_and_complete_section_navigation_help`, rejects the former
  title, and requires the complete footer literal rather than a prefix; and
- no approval authority, action, focus, key-dispatch, plan-content, or Graph Seed logic entered
  this correction.

Static verification at this acceptance boundary:

- the footer measures 65 single-cell display characters against the 76-cell compact inner width;
- `rustfmt --edition 2024 --check crates/koni-tui/src/ui.rs` passed;
- `git diff --check -- crates/koni-tui/src/ui.rs` passed; and
- the no-index mailbox whitespace check produced no diagnostics (its exit status is the expected
  nonzero status for a new, nonempty file).

The focused Rust test was not executable at this instant because the separately owned core tree
does not compile while `ticket_with_step_path_scope` is missing. That external compiler lease is
not part of this TUI presentation audit and was not entered. The test should be run once that owner
restores the shared build; this read-only verdict does not claim a green integrated matrix or
authorize an install/live-state mutation.

## Execution resolution — 2026-07-14

The compile-blocked checkpoint above remains the causal record of the first acceptance pass. After
the separately owned compiler refactor stabilized, the implementation owner reran the executable
verification against the shared tree:

- exact compact Review Plan presentation regression: **1/1 passed**;
- approval-filtered TUI suite: **26/26 passed**; and
- full locked TUI library suite: **293/293 passed**.

The presentation verdict is therefore **accepted / ready for integration**. This resolution adds
execution evidence only; it does not broaden the title/footer lease, alter approval behavior, or
authorize any Rust, product-documentation, central-ledger, installed-binary, cockpit, cmux, or
live-run mutation by this audit lane.
