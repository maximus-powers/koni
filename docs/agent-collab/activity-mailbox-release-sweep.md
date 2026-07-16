# Compact Activity living-doc release sweep

Owner: `activity-mailbox-release-sweep/root`

Status: `complete — RELEASE APPROVED; append-only coordination status reconciliation required`

## Exact lease and safety boundary

- Read-only release audit of the compact Recent Activity title slice, except for this mailbox.
- Re-read the current central registry, every top-level product document under `docs/`, the full
  current persona-mailbox inventory, and the compact Activity source-owner, smoke-audit,
  independent-review, truth-review, visual-audit, documentation, and integration records. The
  sweep was repeated across deltas that appeared after the Review Plan release, including the
  17:48 operator-doc updates and the independent compact-title review.
- No Rust, product documentation, central-ledger row, other persona mailbox, profile, installed
  binary, cockpit/cmux surface, Git ref, Updog state, or live/forensic run was edited by this lane.

## Findings

### Source ownership and user constraints

- No competing TUI source lease exists. The only active presentation claim is the title selector
  inside `draw_recent_activity`, its adjacent Unicode-display-width helper, and focused/full-
  dashboard tests in `crates/koni-tui/src/ui.rs`. Released Evidence/runtime, Review Plan, Graph
  Seed, blocker-reason, ticket, New Run, layout, row, lifecycle, and approval ranges remain outside
  it.
- No user-authored constraint conflicts with the selector. Equal thirds and the 82-column minimum
  are preserved. Runtime authority still comes exclusively from `active_runtime_label`; anchored
  zero remains exact. The title-only hierarchy preserves every significant unit and omits an
  oversized suffix wholesale instead of clipping, clamping, or approximating it.
- The philosophical ordering is consistent with the broader harness contract: panel identity is
  primary, already-authoritative runtime is secondary metadata, and presentation must never create
  authority that compiler/runtime state has not supplied.

### Smoke and independent review evidence

- The only new smoke evidence is the bounded defect that motivated the slice: an 82×24 dashboard
  yields a 27-cell Activity panel and a 25-cell bordered-title budget; the former full one-hour
  title clipped to `┌ Recent activity · 1h 02m┐`, and approved zero could degrade to `0s act`.
  No later mailbox reports a different compact-title defect or a regression in Activity rows,
  timestamps, layout, or runtime authority.
- The implementation selects complete candidates by terminal display width in this order:
  `Recent activity · 1h 02m active` -> `Activity · 1h02m` -> `Activity`. The independent
  `compact-activity-review/root` verdict is **READY FOR INTEGRATION** with no P0/P1 finding.
- Owner execution evidence for the reviewed source state is exact regression **1/1**, Activity
  filter **6/6**, and full locked TUI library **294/294**. The independent reviewer also reports
  clean targeted `rustfmt --check` and `git diff --check`. Its own interrupted redundant Cargo
  attempt remains correctly excluded from evidence.

### Documentation history

- The operator docs are reconciled. `control-center.md` now keeps the clipped 82-column behavior
  as a quoted prior finding beside the current full/compact/identity contract and title-only
  resolution. `tui-cleanup-backlog.md` preserves the same history, explicitly leaves the broader
  compact-rendering remainder open, and records 1/1, 6/6, and 294/294.
- `tui-visual-audit.md` likewise retains the original broad compact-rendering finding and adds an
  adjacent **Partial resolution** limited to the Activity title, while leaving footer priority,
  row density, long Runs/ticket titles, and other CJK/emoji-sensitive calculations open.
- The original read-only smoke geometry and interrupted pre-claim Cargo wait remain intact in
  `compact-activity-smoke-audit.md`; the independent review preserves both as causal evidence.
- `primary-integrator.md` now contains the signed 1/1, 6/6, 294/294 source-owner handoff and routes
  the stale integration-matrix sentence to its owner with an explicit append-beside instruction.
- Required append-only status reconciliation for the implementation owner/integrator before the
  final handoff is purely documentary:
  1. append the release and 1/1, 6/6, 294/294 evidence to `tui-polish.md` after its existing claim;
  2. transition central rows 102 and 153 from claimed/in-progress to released/
     `ready_for_integration`, preserving their earlier unclaimed and claimed states;
  3. append a current transition beside the stale `integration-matrix.md` statement that no
     implementation lease exists; and
  4. retain the `compact-activity-smoke-audit.md` sentence that the row was then unclaimed, but add
     a dated linked transition saying the bounded implementation later landed and passed review.
  The older compact-title follow-up in `tui-truth-review.md` may likewise receive a linked dated
  resolution; it must not be deleted or rewritten.

### External moving-tree gates

- Generic graph-set/review-effect work and Software 0.4 still have independent authority,
  regression, documentation, and frozen-fingerprint gates. Their active files and tests do not
  overlap this title selector, and the full locked TUI 294/294 already executed against the current
  shared source state.
- Those external lanes remain gates for a later whole-project frozen matrix and guarded binary
  refresh. They are **not** a reason to hold this bounded source-only TUI release. No install,
  cockpit restart, cmux input, Updog mutation, or forensic-run resume is authorized here.

## Verdict — 2026-07-14

**RELEASE APPROVED for the compact Recent Activity title slice.** There is no source overlap,
conflicting user constraint, new smoke blocker, or unresolved P0/P1 review finding. The owner may
mark the exact selector/helper/tests ready for integration after appending the four coordination
status/history transitions above; no Rust change or rerun is requested by this sweep. Do not wait
for the unrelated generic/Software suites, and do not treat this source release as authorization
for installation or live-state mutation.
