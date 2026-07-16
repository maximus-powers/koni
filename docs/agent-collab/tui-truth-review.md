# TUI Evidence / Runtime Truth Review

Owner: `tui_truth_review/root`

Status: `complete` (independent read-only review; bounded candidate is **ready for integration**)

Last checked: 2026-07-14 (Phoenix)

## Mission and safety boundary

Independently review the current presentation-only Evidence/runtime candidate in
`crates/koni-tui/src/ui.rs`. The audit covers trivalent evidence authority, positive-evidence
requirements, partial telemetry, final-report readiness, approval-anchored active runtime,
genuine zero, no-run behavior, compact presentation, and focused regression sufficiency.

This lane owns only this mailbox. It did not edit Rust, product documentation, the central
registry, profiles, templates, tests, the installed binary, cmux, Updog, or any live/forensic run
state. The complete central registry and every pre-existing persona mailbox were read before
source inspection. The shared dirty worktree was preserved without reset, formatting, or
isolation.

## Release verdict

**READY FOR INTEGRATION for the claimed Evidence/runtime slice.** No P0/P1 truthfulness blocker
was found in `evidence_health`, `report_text`, `final_report_status`, `active_runtime_label`, or
`draw_recent_activity` against the compiler-owned cockpit snapshot contract.

The current behavior has the required authority order:

1. Any recorded validation error, failed/blocked run, failed/blocked ticket or pipeline stage,
   durable blocker, failed worker/review, failed or incomplete journal, or incomplete integration
   wins as red **ATTENTION**.
2. Green **Evidence recorded** is possible only after every monitored snapshot channel is present
   in its compiler shape and one durable basis exists: a current ticket output, current passed
   configured review, succeeded verification output, or succeeded final-report output.
3. Every other state is muted **No recorded issues** plus **Evidence pending**. Absence is never
   rendered as generic `HEALTHY`.

The implementation also correctly distinguishes a configured report view from a produced report:
configuration alone says `No final report yet`; only a succeeded report stage with durable output
becomes `Final report recorded` and may supply the green basis.

Runtime presentation is likewise fail-neutral. A selected run must be non-provisional and
non-planning, carry a parseable `active_runtime_approved_at`, and expose a numeric lifecycle
duration. Missing selection, anchor, or duration omits the runtime suffix. A real approved numeric
zero remains `0s active`, and the no-run panel asks the operator to select a run rather than
inventing elapsed work.

## Source-level findings

### Evidence authority and partial telemetry

- Red state is evaluated before telemetry completeness or positive evidence, so a known issue is
  never hidden by a ticket output, review, verification, or report.
- Completeness requires explicit validation and stage arrays; board failed/incomplete arrays; a
  ticket-workflow map; and one fully shaped workflow row plus blocker/workflow arrays for every
  ticket. A missing validation channel or missing workflow row therefore stays neutral even when
  an output object is present.
- Current review authority comes from the compiler board, not the historical review list. A
  `passed` value qualifies only when every configured review step is absent from pending work; a
  stale pass falls back to another real basis or remains neutral.
- Positive-basis priority is deterministic and appropriately strongest-first: final report,
  verification, current passed review, then current ticket result.
- Compact and expanded Evidence name the same basis. Zero-valued exception rows are omitted, while
  nonzero exceptions remain individually visible and scrollable.

### Runtime authority

- `active_runtime_label` rejects no-run, provisional, planning, malformed-anchor, missing-duration,
  and nonnumeric-duration states before formatting.
- The duration is read from compiler lifecycle telemetry while the approval boundary is read from
  orchestration (with the documented lifecycle compatibility fallback). Millisecond flooring is
  deterministic and preserves genuine zero.
- Paused and completed approved runs may still show accumulated `active` time, which is correct:
  the label denotes total unpaused runtime since approval, not a claim that an agent is currently
  spending tokens.

## Non-blocking hardening follow-ups

These do not invalidate the bounded candidate, but should stay visible rather than being mistaken
for completed coverage:

1. The supported 82-column dashboard gives Recent Activity roughly 27 columns including borders.
   A roomy title such as `Recent activity · 1h 02m active` exceeds that budget and Ratatui clips
   its tail. The numeric duration remains visible in ordinary cases and no authority claim is
   inverted, so this is the already-recorded compact-density P1 rather than a truthfulness blocker.
   Add one full-dashboard 82×24 regression and an adaptive compact title when that P1 is claimed.

   **Linked resolution — 2026-07-14 (`tui-polish/root`):** The finding above remains the release
   reason. The bounded title selector now measures the bordered display-width budget and chooses
   complete full `Recent activity · 1h 02m active`, compact `Activity · 1h02m`, or identity-only
   `Activity` for an extreme exact duration. Runtime authority and anchored zero are unchanged.
   Exact regression 1/1, Activity filter 6/6, and full locked TUI 294/294 pass; independent review
   and the all-doc/mailbox sweep accept the title-only slice. The broader compact-density findings
   remain open.
2. Ticket-output currentness and pipeline-row validity are inherited from the compiler's typed
   `Ticket.outputs` and validated `RunPipeline` serialization. The TUI deliberately does not
   deserialize those raw JSON rows again. If a future transport accepts untrusted or independently
   assembled snapshots, require a compiler-completed step binding for ticket evidence and validate
   every stage status before allowing green. Current cockpit snapshots already cross those typed
   authority barriers.
3. Add a narrow regression for the legacy lifecycle-location approval anchor and one for an
   explicitly nonnumeric duration. The current branches are fail-neutral by inspection; the
   existing focused suite directly covers top-level orchestration anchors, missing/malformed
   anchors, missing duration, planning, no-run, approved zero, and elapsed formatting.

## Independent verification

All commands used a private target directory and changed no repository or live state.

- `CARGO_TARGET_DIR=/tmp/koni-tui-truth-review-target cargo test --locked -p koni-tui
  ui::tests::report_health_requires_complete_telemetry_and_recorded_evidence --lib -- --exact
  --nocapture` — 1 passed.
- Exact `configured_report_is_not_presented_as_a_recorded_final_report` — 1 passed.
- Exact `active_runtime_requires_a_durable_approval_anchor_and_explicit_duration` — 1 passed.
- Exact `recent_activity_omits_unanchored_runtime_but_preserves_approved_zero` — 1 passed.
- `CARGO_TARGET_DIR=/tmp/koni-tui-truth-review-target cargo test --locked -p koni-tui --lib --
  --nocapture` — **288 passed, 0 failed, 0 ignored**. This includes the parallel Graph Seed
  hardening and compatibility-registry regressions; no test vanished relative to the owner's
  reported 288-test checkpoint.
- `rustfmt --edition 2024 --check crates/koni-tui/src/ui.rs` — passed.
- `git diff --check -- crates/koni-tui/src/ui.rs` — passed.

## Handoff

`tui-polish/root` may release its exact `ui.rs` Evidence/runtime range. The primary integration
matrix may use 288/288 as the independent frozen-tree TUI result for this checkpoint, while keeping
the compact Activity-title item and defensive external-snapshot validation as explicit follow-ups.
No install, cockpit refresh, profile replacement, cmux input, or run mutation is authorized by
this source-only verdict.
