# TUI visual audit

Owner: `tui-visual-audit/root`

Status: `released`

Last checked: 2026-07-14 15:49 Phoenix

## Mission

Audit the source-built Koni TUI as an operator surface: preserve explicit user decisions, keep
compiler truth distinct from agent interpretation, and identify concrete places where redundant,
generic, misleading, clipped, or unattributed presentation makes orchestration harder to judge.

## Safety and ownership

- This lane made no Rust/source edits, installed no binary, sent no cmux input, and did not mutate
  the preserved Updog runs.
- `tui-polish/root` currently owns `crates/koni-tui/src/model.rs`,
  `crates/koni-tui/src/app.rs`, and the New Run / ticket-step presentation ranges in `ui.rs`.
- Findings that overlap the released approval, Details, activity, or timestamp slices are proposals
  for the owning agent, not implicit permission to edit those ranges.

## Protected user constraints

- Keep equal dashboard columns and `Details: Overview - Plan - Stages`.
- Overview is one vertically scrollable Objective / Run / Evidence document.
- Approval has one adaptive Approve/Revise action.
- Every New Run stage must remain visible or reachable.
- Normal UI must not leak internal IDs, hashes, storage paths, or worktree paths.
- Completed steps need a short semantic outcome; literal `done` is redundant beside a green
  completion glyph and outcome.
- Compiler state, agent interpretation, evidence, and operator authority must remain visibly
  distinct.

## Evidence collected

- Read `docs/philosophy.md`, `docs/control-center.md`, `docs/architecture.md`, the collaboration
  ledger, cleanup backlog, live-smoke findings, and current TUI implementation/tests.
- Built and ran the read-only source showcase with:
  `CARGO_TARGET_DIR=/tmp/koni-tui-visual-audit-target cargo run -q -p koni-tui --example populated_showcase`.
- The build passed. Because the process was not attached to a true terminal, the example emitted
  `plain_snapshot` rather than exercising the Ratatui layout.

## Findings

### P0 — semantic correctness

1. **A cancelled or superseded ticket can be presented as successfully completed.**
   `ticket_progress` falls back to every step being `Done` whenever compiled board state is absent
   and `ticket_is_closed` is true; `ticket_is_closed` includes cancelled and superseded tickets.
   Ticket Details can therefore invent green completion summaries. Split successful terminal
   statuses from non-success terminal statuses and never synthesize an outcome from absence.

   **Resolution — 2026-07-14:** Resolved. Cancelled and superseded tickets no longer synthesize
   completed steps when board state is absent. The exact truth regressions passed 3/3; the full
   TUI suite at that boundary passed 275 tests with one known unrelated failure.

2. **Evidence can claim `HEALTHY` without positive evidence.**
   `report_text` derives health mostly from the absence of blockers/errors/recovery. An empty or
   early planning run can therefore appear green and healthy before a report, ticket result, or
   verification evidence exists. Prefer a neutral `No recorded issues` state until deterministic
   evidence supports a stronger claim; render nonzero exceptions rather than a wall of zeroes.

   **Resolution — 2026-07-14 (`tui-polish/root`):** Resolved with a narrower three-state evidence
   contract. Known failures take red **Attention** precedence. A muted **No recorded issues** /
   **Evidence pending** state covers missing, partial, and merely empty telemetry. Green now says
   **Evidence recorded**, never generic `HEALTHY`, and names the durable current ticket, compiler-
   current review, verification, or final-report basis in both layouts. It requires shaped stage
   telemetry plus a compiler workflow row for every ticket; a stale passed review or configured
   report view is not positive proof. Zero-valued exception rows are omitted. The adversarial
   report matrix passes 1/1, the report filter passes 3/3, and the integrated TUI passes 288/288.

3. **Planning clocks silently display UTC as if it were local time.**
   `compact_planning_timestamp` strips the RFC3339 date and zone while core timestamps are UTC.
   In Phoenix this can be seven hours away from the operator's clock. Convert to `chrono::Local`
   or retain an explicit UTC label. This overlaps the primary timestamp slice.

4. **No-run state can claim active runtime.**
   `active_runtime_label(None)` returns `0s active`; Recent Activity can consequently describe an
   unapproved or nonexistent lifecycle as active. Omit runtime until a run/approval anchor exists,
   while preserving a genuine zero-second runtime after that boundary.

   **Resolution — 2026-07-14 (`tui-polish/root`):** Resolved. Recent Activity omits its runtime
   suffix for no selection, provisional/planning runs, a missing or malformed durable approval
   timestamp, or a missing numeric lifecycle duration. No selection now prompts the operator to
   select a run. A parseable approval anchor plus explicit numeric zero still renders `0s active`.
   The two exact runtime regressions and all three Recent Activity tests pass; the full TUI passes
   288/288. Timestamp-zone conversion remains the separate open finding 3.

### P1 — operator comprehension and compact layouts

5. **Ticket completion rows repeat status and often say nothing concrete.**
   Current rows render `● Step done · Persona` followed by a green outcome. Remove textual `done`
   only for completed rows; retain active/failed/ready/waiting labels. Replace fallback
   `Completed <step id>` / `Produced <expected>` copy with a typed semantic summary or an honest
   `No outcome summary recorded` state. A current test explicitly asserts the redundant `done`.

   **Resolution — 2026-07-14:** Resolved. Completed rows omit the literal `done`; nonterminal
   labels remain visible. Outcomes now come only from recorded semantic summaries, with muted
   `No outcome summary recorded` when none exists. The ticket suite passed 22/22; the latest full
   TUI suite passed 276 tests with one known unrelated failure.

6. **Blocker summaries hide the reason the operator needs.**
   Ticket Details only says `N blockers need attention`. Show the first sanitized durable blocker
   reason, wrapped to width, plus `+N more`; continue redacting control-record IDs.

   **Resolution — 2026-07-14 (`tui-polish/root`):** Resolved without deleting the count-only
   behavior above. Ticket Overview now selects the first useful typed durable blocker message in
   array order, sanitizes known and unknown control IDs, paths, hashes, embedded raw records, and
   control characters, then hard-wraps the complete semantic reason by terminal display width.
   Additional typed records render as `+N more`. If every message is malformed, raw, generic, or
   reduced to redaction placeholders, the prior `N blockers need attention` disclosure remains as
   the honest fallback. Four exact regressions pass 1/1 each, blocker projection passes 2/2,
   Ticket Overview passes 3/3, and the full locked TUI passes 292/292. The preserved initial
   adversarial verdict and final independent acceptance are recorded in
   [`blocker-reason-review.md`](blocker-reason-review.md).

7. **Compact rendering clips the most useful information.**
   At 82 columns, the equal right column is about 27 cells, yet `Recent activity · 1h 02m active`
   exceeds 30 before borders. Its ten-cell timestamp leaves roughly thirteen cells for content.
   The footer composes a long key list first, so transient status/errors disappear entirely.
   Runs and ticket titles also lack a display-width budget, and several calculations count Unicode
   characters rather than terminal cells. Use adaptive labels, reserve footer space for active
   feedback, and use `short_display_width` consistently. Add 82x24 plus CJK/emoji regressions.

   **Partial resolution — 2026-07-14 (`tui-polish/root`), Activity title only:** The broader
   footer, row-density, Runs/title, and CJK/emoji findings above remain open. For the bounded panel
   title, a read-only smoke audit proved the 82×24 right column is 27 cells with a 25-cell bordered
   budget; the old 33-cell one-hour title rendered as `┌ Recent activity · 1h 02m┐`. Title
   selection now measures terminal display width and chooses complete full
   `Recent activity · 1h 02m active`, compact `Activity · 1h02m`, or identity-only `Activity` when
   an extreme exact duration cannot fit. It never clips, clamps, or approximates runtime;
   `active_runtime_label` authority and anchored zero are unchanged. Exact regression 1/1,
   Activity filter 6/6, and full locked TUI 294/294 pass. The original audit and interrupted
   pre-claim Cargo attempt remain in
   [`compact-activity-smoke-audit.md`](compact-activity-smoke-audit.md).

8. **The Runs mouse hitbox includes the control-hint row.**
   Drawing reserves the last inner row for controls, but the click handler treats it as a run row;
   its window calculation also differs from drawing. Share one run-list geometry/window helper and
   add a multi-run mouse regression that clicks the hint row.

9. **Agent chat loses identity and durable live/history state.**
   Moving focus from Agents to Details removes the selected-row marker; Chat titles use persona
   only, so repeated Builder/Reviewer sessions are ambiguous. The activity cog is derived from a
   parsed running operation rather than durable `agent.live`, so a live waiting/thinking agent can
   look inactive. Keep the selected row visible while Chat is focused and label the chat with
   work/ticket plus explicit `live` or `read-only` state.

10. **Merge Review leaks implementation details and can bury its controls.**
    It displays an absolute target checkout path and abbreviated commit hashes, contrary to the
    normal-UI redaction constraint. A fixed-height, non-scrolling body also shows the first four
    tickets rather than prioritizing blockers/incomplete work. Present semantic checkout state,
    prioritize exceptions, and keep the action row reachable; expose hashes/paths only through an
    explicit diagnostic surface if one is intentionally added.

### P2 — density, consistency, and auditability

11. **Overview repeats progress and zero-state noise.**
    A progress bar and `N/M tickets complete` are immediately followed by `N complete`; zero
    blocked/recovery/working counts are always rendered. Empty Overview separately says no
    objective, no overview, and no evidence. Collapse each into one honest state and show zero
    counters only when their absence is materially informative.

12. **Stages announces the current stage twice.**
    `▶ Current <category> stage` plus a blank line sits directly above an active stage card that
    already shows the title and Working state. Remove the banner or make it carry unique context.

13. **Recent Activity humanizes unknown compiler event names mechanically.**
    This can surface compiler jargon and generic entries such as `Steering recorded`. Use an
    operator-facing allowlist/map with ticket context; hide audit-only events. If timestamps are
    absent, avoid repeated `--:--:--` placeholders and do not alphabetically reorder legacy items.

14. **Help copy still describes removed Overview mini-views.**
    `help.rs` says Details moves between Objective, metadata, and health and selects a run
    mini-view. It should describe scrolling the single Objective/Run/Evidence document and the
    focused Objective expansion.

15. **Large or long agent interactions fail abruptly.**
    A worker log over 8 MiB is rejected wholesale instead of showing the selected bounded session;
    the guidance editor clips its single input line with no caret/end viewport despite a tall
    dialog. Stream/extract the selected session with a truncation notice, and give guidance a
    wrapped or end-following input viewport.

16. **The showcase is not a visual regression surface.**
    Non-TTY `run_read_only_snapshot` calls `plain_snapshot`, omitting Details, Activity, Stages,
    footer, colors, clipping, and Chat. The fixture also uses stale event vocabulary, lacks useful
    timestamps/outcome summaries, and produces duplicate agent titles without persona labels.
    Add a deterministic Ratatui `TestBackend` dump at 82x24 and a roomy size using the exact
    `ui::draw`, seeded with long titles, explicit outcomes, paused/failure states, and read-only
    chat. This would make future smoke-test visual audits reproducible without touching live state.

## Coordination questions

- Which P0/P1 item should `tui-polish/root` claim after its current New Run/step slice? No source
  range should be taken from the list without an explicit handoff.
- Approval's modal title remains `Review planning and approve` even when the action changes to
  Revise, and its help line omits arrow keys. This overlaps a completed primary slice; the owner
  should decide whether to rename it neutrally to `Review plan` and add the authoritative arrows.

  **Resolution — 2026-07-14 (`tui-polish/root`):** The observation above remains the causal
  record. The modal now says neutral `Review plan`; the adaptive button alone names `Approve run`
  or `Revise plan`. Its compact footer is exactly
  `←→/[] sections · ↑↓/jk/PgUp/PgDn scroll · Tab focus · Enter · Esc`, replacing the immediately
  prior `[] plans · ↑↓/jk scroll · Tab focus · Enter action/newline · Esc` presentation while
  leaving all key dispatch and approval authority unchanged. The 65-cell footer is fully visible
  inside the 76-cell 82×24 modal interior. Exact regression 1/1, approval suite 26/26, and full
  locked TUI 293/293 pass; the independent initial finding and accepted verdict remain in
  [`review-plan-presentation-audit.md`](review-plan-presentation-audit.md).
- The living-spec Graph Seed request conflicts on one detail: `context-spec` initially requested a
  hash/count projection, while `primary-integrator` explicitly excluded hashes from the ordinary
  Plan view. The latter constraint should win; show semantic node/relationship facts and counts,
  keeping the hash behind diagnostics.

## Verification

- Source showcase compiled and completed successfully.
- No repository source, installed binary, profile, run, or cockpit state was changed by this audit.

## 2026-07-14 docs-evolution note — `primary-integrator`

This audit remains historical evidence after fixes land. Mark findings resolved or superseded with
dated notes; do not delete or rewrite the original observations into the new behavior.

## 2026-07-14 prioritization response — `primary-integrator`

After `tui-polish` releases its current New Run viewport, P0 item 1 is the next bounded source
claim: split successfully completed tickets from cancelled/superseded terminal tickets in
`ticket_progress` / `ticket_is_closed`, and never synthesize green step outcomes from missing board
data. Require focused model/UI coverage before claiming another finding. Items 2 and 4 form the
next truthfulness slice (neutral evidence without positive proof; omit active runtime without an
approval anchor), while local-time conversion is a separate timestamp slice.

For the overlapping approval nit: use the neutral modal title **Review plan** and advertise the
authoritative arrow aliases in its footer. Record the former title/help as superseded in the TUI
docs rather than silently replacing it. `tui-polish` may claim those exact presentation strings
after its current viewport work; no broader approval-state logic is released by this answer.

## 2026-07-14 release — `tui-visual-audit/root`

Findings 1 and 5 are annotated with their resolving behavior and verification above. This
read-only audit lane is released with all remaining findings preserved as open historical audit
evidence. No Rust source, installed binary, live run, or cockpit state was changed for this update.
