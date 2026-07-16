# Koni TUI cleanup backlog

This is the durable checklist for the accumulating control-center feedback. New feedback extends
this list; it does not replace unfinished work.

> **Runtime-presentation transition — 2026-07-14:** Codex-native/JSONL chat and transcript items
> below remain the schema-1 and historical-run presentation contract. The unreleased Pi/schema-2
> runtime supplies Koni-owned typed events rather than a Codex transcript; preserve old readers,
> but route new sessions through the native event model described in
> [`pi-runtime.md`](pi-runtime.md). Exact event lifecycle, credential trust, usage/budget truth,
> migration, and the frozen TUI/runtime matrix remain release gates, so this note does not mark the
> Pi control-center cutover complete.

## 2026-07-14 regression audit — authoritative latest behavior

The items in this section supersede older checked-off requirements below when they disagree. A
fix is not complete until its tests and operator documentation assert the behavior described here.

### Latest explicit constraints

- [x] Use equal-width dashboard columns at every roomy terminal width.
- [x] Give Review Plan one primary adaptive action. With no steering it approves; once steering
  contains text its label and action change to revise.
- [x] Render Run Overview as one vertically scrollable page with Objective, Run, and Evidence
  sections in that sequence—never nested mini-tabs. Put Objective first with a four-line collapsed
  preview, place Run metadata and then Evidence below it, and expand the complete wrapped Objective
  when that region is focused.
- [x] In Ticket Overview, show the first useful typed durable `Blocker.message` in array order.
  Suppress generic, placeholder-only, raw structured, and malformed/untyped messages. Replace
  known run/ticket/stage/agent/graph/question/action IDs with fixed generic phrases; redact unknown
  IDs, paths, hashes, embedded raw records, and control characters. Hard-wrap without truncation
  by Unicode terminal display width. `+N more` counts every other typed durable record, including
  records whose messages were suppressed; when nothing useful survives, retain count-only copy.
  - **Prior count-only behavior:** “Ticket Details only says `N blockers need attention`.”
  - **Resolved 2026-07-14:** The old disclosure remains the fail-closed fallback. The normal view
    now adds the first safe actionable reason and typed-durable remainder count without exposing
    compiler representation or inventing prose from unsafe data.
- [x] Make Evidence trivalent. Recorded issues; failed or blocked run, ticket, or pipeline state;
  and failed current review take red `Attention` precedence. Green `Evidence recorded` requires
  every monitored telemetry channel explicitly present and zero plus durable current ticket output,
  current compiler `review_status=passed` with no configured review step pending, succeeded
  verification output, or succeeded final-report output. Compact and expanded views name the basis.
  Otherwise render muted `No recorded issues` and `Evidence pending`; a configured report view
  alone says `No final report yet`, not ready.
  - **Current completeness boundary:** Telemetry includes a stages array and a fully shaped compiler
    `ticket_workflows` row for every ticket. Stale historical review passes do not qualify.
  - **Prior behavior before 2026-07-14:** “Evidence can claim `HEALTHY` solely from the absence of
    recorded errors, before positive evidence exists.”
  - **Superseded 2026-07-14:** Absence is now neutral; complete zero-valued telemetry and durable
    positive evidence are both required for green health.
  - **Intermediate candidate recorded 2026-07-14:** “Green `HEALTHY` requires every monitored
    telemetry channel explicitly present and zero plus durable current ticket output, a passed
    current review, succeeded verification output, or succeeded final-report output.”
  - **Superseded after independent review 2026-07-14:** The positive badge is now `Evidence
    recorded`, never generic `HEALTHY`; compiler-shaped telemetry and current-review authority
    prevent stale or partial state from qualifying.
- [x] Put the Details tabs directly on its left-aligned title line as
  `Details: Overview - Plan - Stages`; render the active tab white and the inactive tabs light grey.
- [x] Make Plan phase-aware: during planning it shows the quiet live planning-activity stream;
  after durable plan approval it shows the approved human-readable plan artifacts as vertically
  scrollable Markdown so the operator can continue reviewing the execution contract.
  - **Superseded 2026-07-14:** “Render legacy Review Plan artifacts without the seven-item /
    180-character reduction; all plan text remains reachable through wrapping and scrolling.” The
    current rule preserves the reachability requirement without maintaining a separate
    fallback-format contract that the user did not specify.
- [x] Conditionally append a sanitized `Graph Seed` section to Review Plan and the approved Plan
  when planning produced a seed. Show total counts, up to 6 safe top-level root facts, 12 semantic
  nodes by type/title/authored purpose, 16 title-resolved relationships, and explicit omitted
  counts. Keep the entire bounded section scroll-reachable at 82x24 and reuse it after approval.
  Never render local keys, IDs, hashes, paths, structured/raw spec/schema, or storage metadata.
  - **Transition completed 2026-07-14:** The prior current surface contained Architecture, Risk,
    and Verification. Profiles and runs without a seed retain those three sections; seeded runs
    append `Graph Seed` so the semantic state being approved is inspectable without exposing its
    compiler/storage representation.
- [x] Show a compact timestamp on every Recent Activity row. Replace the panel header's event count
  and visible-range summary with total active runtime since durable plan approval, subtracting all
  intervals in which the run was durably paused.
  - **Prior behavior before 2026-07-14:** “No-run Activity says `0s active`.”
  - **Transitioned 2026-07-14:** Keep timestamps, but include runtime only for a selected run that
    is neither planning nor provisional and has a parseable durable `active_runtime_approved_at`
    anchor plus a numeric lifecycle duration. Approved numeric zero remains `0s active`; no
    selection prompts the operator to select a run.
- [x] Select the Recent Activity title against the actual bordered Unicode display-width budget.
  Use full `Recent activity · 1h 02m active` when it fits, compact `Activity · 1h02m` at 82×24,
  and identity-only `Activity` when an extreme exact duration cannot fit. Preserve every unit and
  anchored `0s`; omit an overlong suffix instead of clipping, clamping, or approximating it.
  `active_runtime_label` authority gates remain unchanged.
  - **Prior compact-layout finding:** “At 82 columns, the equal right column is about 27 cells,
    yet `Recent activity · 1h 02m active` exceeds 30 before borders.” The reproduced old title
    clipped to `┌ Recent activity · 1h 02m┐`, and approved zero could leave only `0s act`.
  - **Resolved title-only slice — 2026-07-14:** Complete measured candidates replace clipping.
    This does not close the rest of visual-audit finding 7: footer feedback priority, long
    Runs/ticket titles, and other Unicode-width calculations remain unresolved.
- [x] Insert a provisional Runs-list row synchronously when a new run is submitted, before planning
  or the first durable snapshot, then reconcile it with the compiler-assigned run identity.
- [x] Keep the complete New Run stage flow visible or scrollable. Never silently clip stages to the
  remaining vertical space behind an unscrollable `showing 1-N of M` summary.
  - **Implemented 2026-07-14:** The viewport scrolls stable rendered stage rows, so every wrapped
    continuation line remains reachable at the minimum 82x20 terminal size without hiding the
    explicit Start action or the contextual footer.
- [ ] Polish TUI Markdown: preserve indentation for nested bullets and numbered lists, color
  filenames, and add vertical space between blocks.
- [x] In run-deletion confirmation, show only a truncated Objective preview; never let the complete
  Objective displace the confirmation choices.
  - **Verified 2026-07-14:** The integrated library run included
    `ui::tests::delete_run_objective_preview_is_capped_at_two_lines` among its 276 passes; the only
    failure was the pre-recorded unrelated compatibility fixture. The focused regression proves the
    preview stays within two wrapped lines.
- [ ] Add versioned bundled profile baselines plus project-owned overlays so Koni upgrades preserve
  project configuration. `--replace` must not swap away `.codex/koni` customizations wholesale.
- [x] Finish research reciprocal-edge cleanup: represent the gate/target same fact once through a
  canonical bidirectional relationship, and remove instructions that require both `target.gates`
  and `gate.applies_to`.
  - **Resolved 2026-07-14:** Research now stores only canonical `gate.applies_to`; the configured
    bidirectional inverse exposes `gates` without a second target-authored edge. Operations,
    workflows, gate-designer/integrator prompts, cockpit labels, source/template mirrors, and the
    focused Research profile checks agree on that one-fact contract.
- [x] Give the approval modal the neutral title `Review plan` and the exact complete footer
  `←→/[] sections · ↑↓/jk/PgUp/PgDn scroll · Tab focus · Enter · Esc`.
  - **Prior combined backlog item:** “Finish keybinding normalization: approval help includes both
    arrows and `[]`/`jk`, and Configure copy must not tell operators to use uppercase `L` or `D`.”
  - **Immediately superseded Review Plan title/help:** “Review planning and approve” and
    “[] plans · ↑↓/jk scroll · Tab focus · Enter action/newline · Esc”.
  - **Earlier help history:** “←/→ sections · ↑/↓/Pg scroll · Tab action · r resume · Esc close.”
  - **Transitioned 2026-07-14:** The neutral title names the inspection state; the adaptive button
    still names the authority-crossing action. The footer now advertises the existing reachable
    section, scroll, focus, activation, and dismissal handlers, including compact aliases.
- [ ] Finish the remaining keybinding normalization: Configure copy must not tell operators to use
  uppercase `L` or `D`.

### Partial implementations to finish

- [ ] Bring agent chat presentation to exact native Codex CLI parity where the native transcript
  has a representable TUI equivalent; document any deliberate terminal-only exception.
- [ ] Replace generic long-lived agent work labels such as `Execute compiled work` with the current
  concrete boundary (for example `Preparing ticket`) throughout ticket setup.
- [ ] Reconcile an identity-verified exited worker to interrupted/inactive durable state instead of
  leaving a stale `running` row indefinitely.

### Contradictory coverage reconciled

- [x] Replace the Objective truncation regression with coverage for the expandable complete text.
  - **Prior audit task, completed 2026-07-14:** “Replace the Objective test that requires six-line
    selected truncation.” The replacement now asserts the current four-line preview and complete
    focused Objective.
- [x] Replace obsolete approval-action coverage with the single adaptive action contract.
  - **Prior audit task, completed 2026-07-14:** “Replace the Review Plan test that requires both
    buttons to remain visible.” The replacement asserts one action whose label and behavior follow
    the steering editor.
- [x] Rewrite the older completed requirements below for equal columns and the vertically composed
  Objective/Run/Evidence page so they no longer contradict this audit.
  - **Prior audit task, completed 2026-07-14:** “Rewrite the older completed requirements below
    for 28/30/42 columns and Goal/Run/Evidence mini-views so they no longer contradict this
    audit.” The original product statements remain below as visibly superseded history.
- [x] Update `docs/control-center.md` to describe the current Review Plan content and adaptive
  approval flow.
  - **Prior audit task, completed 2026-07-14:** “Update `docs/control-center.md` to remove the
    obsolete Decisions panel and two-button plan approval flow.” The operator guide now retains
    the old contract only inside a dated specification-history note.

## Queued TUI nits

- [x] Make Objective a wrapped, multiline input. Long objectives wrap within the modal, explicit
  line breaks are editable and preserved, and the active caret remains visible.
- [ ] Finish the non-title remainder of compact-rendering finding 7: reserve footer space for
  active feedback, give long Runs and ticket titles display-width budgets, and use terminal-cell
  width consistently in remaining CJK/emoji-sensitive calculations.
- [ ] If a source-built smoke exposes a printable ANSI tail such as `[31m` after blocker control
  characters are removed, strip the complete CSI sequence in a separately claimed presentation
  slice. The current projection is terminal-safe; this is cosmetic hardening, not a release block.

## Related non-TUI follow-up

- [x] The research profile now models experiment/ablation `target_claims` as one bidirectional edge
  with the inverse `tested_by`, and the authoring instructions prohibit redundant reciprocal edges.
  Audit the remaining workflow language that still requires reciprocal `gate.applies_to` and
  `target.gates` links; either convert the same-fact pair to one canonical bidirectional edge or
  document and enforce why those are genuinely independent facts.
  - **Resolved 2026-07-14:** The audit chose the same canonical-one-fact model for gates:
    `gate.applies_to` is stored and inverse `gates` is derived. The original question remains above
    as decision history; no workflow or agent instruction now requires both stored directions.

## Current implementation pass

- [x] Keep control tips on the bottom edge of modals and panels (or in the global contextual
  footer); panel titles and body copy contain state and content instead of embedded key hints.
- [x] Selector navigation accepts both arrow keys and the matching `j`/`k` or `[`/`]` aliases;
  literal text inputs preserve those printable characters instead of stealing them for navigation.
- [x] Navigation copy consistently says `select`; submit-like actions retain explicit labels such
  as `confirm`, `submit`, `start`, or `publish`.
- [x] Contextual TUI commands use lowercase letters (or explicit modifier/function keys), without
  separate Shift-letter commands for ordinary actions.
- [x] Agent chat resolves compiler-owned prompt and Codex JSONL artifacts beneath the selected
  `.git/koni/runs/<run>` root, so relative artifact paths work from the project cockpit.
- [x] New Run calls the field `Objective`, and Run Overview places the Objective first in one
  vertically scrollable Objective/Run/Evidence page. Its four-line collapsed preview expands to the
  complete wrapped text when focused.
  - **Superseded 2026-07-14:** “New Run calls the goal field `Objective`, and Run Overview places
    the objective after compact metadata and health/evidence so a long prompt does not displace
    operational state.” The latest user direction makes Objective the first section while bounding
    it with the collapsed preview.
- [x] New Run labels the question-policy row exactly `Questions`; the pending-question panel and
  footer advertise both arrow and `j`/`k` or `[`/`]` selector bindings.
- [x] Agents renders the compiler-derived two-to-three-word work title when the ticket/run prefix
  alone does not explain the agent's current work.
- [x] Run Overview uses the animated cog beside a live run status whenever an agent may be spending
  tokens, while quiet planning/input/approval states retain a non-active status marker.
- [x] New Run omits guided-intake prose, run-type descriptions, the redundant workflow selector,
  and the old “What should Koni build?” label; only the two major Objective and Run Config section
  dividers remain.
- [x] New Run keeps white subsection labels beside their controls where space permits, separates
  the agent matrix from the explicit start button with a rule, and uses non-sentiment categorical
  colors for run/question/model choices plus one increasingly saturated pink reasoning axis.
- [x] Configure groups semantic resources into nested intent-based sections, combines each agent's
  prompt/model/reasoning/permissions in one resource, keeps raw files in Advanced, and shows state
  only for resources with unpublished or invalid changes. `Ctrl-D` discards the draft set.
- [x] Node-type configuration requires human-readable descriptions so agents receive explanations
  of the graph primitives they are expected to author.
- [x] Agent chat renders the Koni-owned `codex exec --json` transcript as Codex-style user,
  assistant, reasoning, operation, error, usage, Markdown, and code blocks rather than raw JSONL.
- [x] Fix run pause so it remains durably paused across refreshes and automatic supervision does
  not reactivate or schedule work until the operator explicitly resumes it.
- [x] Clear the transient “active agents are draining” footer once a paused run reaches zero live
  agents; the durable Paused state is correct, but the old footer message currently lingers.
- [x] Run deletion uses a compiler-owned stop-then-delete boundary: pause scheduling, revoke every
  run-owned broker/chat grant, terminate only identity-verified process groups, prove zero live
  agents, then retire worktrees and state; unverifiable processes remain fail-closed blockers.
- [x] Ticket Overview places the live/current work status directly below the ticket title.
- [x] A step row contains its status glyph, step name, status text, and persona on one line.
  - **Transitioned 2026-07-14:** Nonterminal rows retain their useful status labels, while a
    completed row omits the redundant literal `done`; its completion glyph and outcome already
    communicate that terminal state.
- [x] A completed step shows a short, green outcome summary below the row instead of only `done`
  or its configured expectation.
  - **Superseded 2026-07-14:** Green is now reserved for recorded typed, file, receipt, graph, or
    review outcomes. A configured expectation describes intended work and is never promoted into
    an accomplishment.
- [x] Workers are instructed to submit a two-to-eight-word, past-tense `summary`; existing outputs
  receive useful semantic fallbacks in the UI.
  - **Superseded 2026-07-14:** Fallbacks may summarize only recorded outcomes from those durable
    sources. When none exists, the UI renders muted `No outcome summary recorded` instead of
    fabricating success or reusing the configured expectation.
- [x] Recent Activity is removed from ticket Overview and becomes a scrollable right-column panel
  directly below Agents.
- [x] Recent Activity includes durable graph edits and compiler lifecycle work, newest first:
  additions are green, modifications are yellow, deletions are red, and compiler events are white.
- [x] Activity entries use human node types/titles and ticket titles, never internal IDs.
- [x] The Graph remains a separate right-column panel below Recent Activity.
- [x] Selecting an agent temporarily turns Details into that agent's chat: a semantic Codex
  transcript, an active-agent composer routed through the configured compiler-mediated steering
  action, read-only history for inactive agents, and restoration of the prior Details tab when
  agent focus is left. The composer explicitly says guidance enters the next authorized context
  boundary rather than pretending to mutate an already-issued one-shot turn.
- [x] Research and coding graphs use autoresearch-v2's layered relationship canvas by default:
  semantic nodes occupy stable rows while compact connector routes show their relationships.
  Colored badges and compact muted titles are painted last so their letters replace line cells.
- [x] Graph parity uses canonical full titles for stable ordering, configured hierarchy and parent
  preferences, reciprocal-edge collapse, reverse-edge projection, and the fixed node-color
  palette. Geometry fixtures protect both the default canvas and the optional nested outline.
- [x] Short node titles are painted over connector lines (text wins at intersections), with title
  text muted relative to the node-type marker.
- [x] Legacy reciprocal graph edges collapse into one visible relationship.
- [x] Label the graph's actual scope. Ticket projections say `ticket checkout`; the merged run view
  says `integration`, so candidate graph state is not mistaken for merged state.
- [x] During planning, Plan projects a quiet operator timeline: milestones, safe reasoning
  summaries, substantive agent messages, failures, and conclusions remain; item-start and
  token-usage stream noise is hidden and consecutive duplicate outcomes are counted once.
  - **Terminology transitioned 2026-07-14:** “Planning Details projects a quiet operator timeline:
    milestones, safe reasoning summaries, substantive agent messages, failures, and conclusions
    remain; item-start and token-usage stream noise is hidden and consecutive duplicate outcomes
    are counted once.” The behavior remains; only the exact tab name changed to `Plan`.
- [x] Narrow Stage cards wrap their title deliberately and keep status/category together on an
  indented metadata row instead of allowing terminal wrapping to detach `Pending` from its stage.
- [x] Recent Activity collapses consecutive identical compiler events with a visible count so
  recovery/dispatch churn cannot crowd graph additions and modifications out of the mini panel.
- [x] Historical agent chat scopes transcript diagnostics to the selected Codex session, hides
  known CLI/model-catalog banner noise, and groups genuinely malformed transport into one notice.

## Regression requirements from earlier passes

- [x] Active and historical agents remain in one scrollable panel; inactive entries are muted.
- [x] Agents follows the durable selection scope: run selection shows every run agent with a
  `Ticket · Persona` prefix (`Run · Persona` for run-level work); ticket selection shows only that
  ticket's agents without the redundant ticket prefix. Chat selection uses the same filtered list.
- [x] Pending questions use their conditional bottom-third middle-column panel and do not become a
  permanent history tab.
- [x] The Questions panel reuses the answer modal's wrapped prompt, option cursor, muted
  descriptions, and custom-answer affordance; selected options may also carry durable notes.
- [x] Details exposes `Overview`, `Plan`, and `Stages` directly on the left-aligned title line as
  `Details: Overview - Plan - Stages`, with white active text and light-grey inactive text.
  - **Superseded 2026-07-14:** “Details keeps Overview, Planning, and Stages; Overview combines
    report and metadata.” The phase-aware tab is now named exactly `Plan`, and Overview's current
    composition is specified separately.
- [x] Run Overview composes Objective, Run, and Evidence vertically in one scrollable page instead
  of hiding them behind another selector.
  - **Superseded 2026-07-14:** “Details exposes all three top-level tabs at once, makes each
    directly clickable, and gives run Overview separate Goal, Run, and Evidence mini-views. It
    opens on the operational Run view; long objectives remain bounded and one selector away
    instead of displacing telemetry.” The transcript-audited rule instead composes all three
    sections vertically with Objective first.
- [x] A durably paused run projects its still-open pipeline stage as `Paused`, not `Running`, unless
  an identity-verified agent is actually draining work; the durable stage record remains unchanged.
- [x] Roomy operate layouts use three equal-width dashboard columns; compact terminals remain
  responsive without changing that information hierarchy.
  - **Superseded 2026-07-14:** “Roomy operate layouts reserve 42% of the desktop for the graph
    while keeping Runs/Tickets/Agents at 28% and Details at 30%; compact terminals retain equal
    thirds. The added width preserves the autoresearch-v2 connector map and title-over-line
    geometry.” The latest user direction requires equal roomy columns because no explicit user
    decision protected the agent-selected ratio.
- [x] Header shows run type, stage, ticket progress, tokens, and approval state, but not the
  Objective.
  - **Terminology transitioned 2026-07-14:** “Header shows run type, stage, ticket progress,
    tokens, and approval state, but not the goal.” The information contract is unchanged; the
    visible field name is now exactly `Objective`.
- [x] Runs expose pause/resume, delete, and abbreviated total token usage.
  - **Token terminology superseded 2026-07-15:** The historical “total” requirement above meant
    the only aggregate available at the time. Current Runs rows and the header abbreviate
    cache-excluding `new_tokens`; Overview labels that operator headline separately from cached
    input and provider total. This keeps provider throughput available without presenting cache
    reuse as fresh model work.
  - **Compact-label clarification — 2026-07-16 (`token-accounting-ui`):** The 2026-07-15
    distinction remains authoritative, and the abbreviated header/row value now names itself
    (`250K new tks`) instead of relying on hidden context. The expanded Overview breakdown is
    unchanged.
- [x] Every panel, including Recent Activity, has contextual `h` help and keybindings.
- [x] New Run keeps visible run-type badges, a complete scrollable stage flow, question policy,
  unbounded positive parallelism, independently selectable model/reasoning badges, and an explicit
  start button.
  - **Requirement reopened 2026-07-14:** “New Run keeps visible run-type badges, full stage flow,
    question policy, unbounded positive parallelism, independently selectable model/reasoning
    badges, and an explicit start button.” The requirement remains, but its checkbox was reopened
    after smoke evidence showed the purported full flow could clip hidden stages without a working
    scroll path.
  - **Completed 2026-07-14:** Stable rendered-row scrolling now makes wrapped stage continuations
    reachable at 82x20 while preserving the Start action and footer.
- [x] No raw run, ticket, node, process, worktree, or hash identifiers leak into normal UI.

## Verification before handoff

- [x] Smoke the source-built Objective editor in the populated Updog cockpit: wrap long prose,
  insert explicit lines, move and edit the caret, scroll its viewport, leave/re-enter with Tab, and
  cancel without starting or modifying a run.
- [x] Focus, keyboard, mouse, scrolling, help, and narrow-terminal tests cover the new Activity
  panel and revised right-column layout.
- [x] A fully populated live TUI was visually inspected for the earlier consolidated dashboard
  pass.
- [x] Source-focused New Run stage-scrolling regressions pass, and the focused ticket presentation
  suite passes 22/22 for the completed-row status and outcome-evidence contract.
- [x] Rerun the full TUI suite after these two slices. The prior full baseline has only the known,
  unrelated compatibility-run fixture failure.
  - **Transitioned 2026-07-14:**
    `CARGO_TARGET_DIR=/tmp/koni-tui-polish-target cargo test -p koni-tui --lib` ran 277 tests:
    276 passed and 1 failed only in the pre-recorded unrelated
    `app::tests::action_engine_accepts_only_the_matching_compatibility_run` fixture because the
    planned run returned `NotFound`.
  - **Superseded by the completed integration 2026-07-14:**
    `CARGO_TARGET_DIR=/tmp/koni-tui-polish-target cargo test -p koni-tui --lib -- --nocapture`
    passed 279/279 after the compatibility repair and Graph Seed projection were integrated.
- [x] `cargo test -p koni-tui approval --lib -- --nocapture` passes 23/23 for the bounded,
  sanitized, compact-scrollable Graph Seed approval section and its post-approval Plan reuse.
- [x] Evidence/runtime focused suites pass: Activity 3/3, report 3/3, Overview 1/1, and runtime
  filtering 2/2. The full TUI library passes 283/283; `rustfmt` and diff checks are clean.
  - **Checkpoint retained as design history 2026-07-14:** This was the first green-`HEALTHY`
    trivalent candidate before the stronger badge, telemetry-shape, and review-authority rules.
- [x] Strengthened Evidence regressions cover a missing workflow row, stale historical pass, failed
  current review, and failed or blocked stages. Report passes 3/3, Activity 3/3, Overview 1/1, and
  the latest shared full TUI passes 288/288, including parallel Graph Seed hardening tests.
  - **Superseded as the latest shared checkpoint — 2026-07-14:** The 288/288 result above remains
    the Evidence and Graph Seed release baseline. After the independently reviewed Ticket Overview blocker-reason
    projection and its wrapping/sanitization regressions were added, the full locked TUI library
    passed 292/292. No final rerun for that released TUI slice remains pending; the separate
    compiler/Software frozen-tree matrix is still required before a guarded binary refresh.
  `rustfmt` and diff checks are currently clean; their final rerun remains pending.
- [x] The released blocker projection passes 2/2, `ticket_overview_` passes 3/3, and each of the
  four exact blocker regressions passes 1/1. The independently rerun locked full TUI passes
  292/292 with zero failures or ignored tests; targeted `rustfmt --check` and path-scoped
  `git diff --check` are clean. The independent final review found no remaining P0/P1 issue in
  this bounded presentation slice.
- [x] The exact Review Plan title/footer regression passes 1/1, the approval suite passes 26/26,
  and the full locked TUI suite passes 293/293.
  - **Blocked checkpoint retained — 2026-07-14:** The first verification attempt stopped with
    E0425 before any TUI test ran because active generic-core code called
    `ticket_with_step_path_scope` without defining it; no pass was claimed from that attempt.
  - **Resolved 2026-07-14:** After the generic-core compile boundary stabilized, the source owner
    reran the exact, approval-filtered, and full locked suites with the green results above.
- [x] The exact compact Activity-title regression passes 1/1, the Activity filter passes 6/6,
  and the full locked TUI suite passes 294/294; targeted `rustfmt --check` and the source diff
  check are clean.
  - **Pre-claim blocked checkpoint retained — 2026-07-14:** A read-only auditor's redundant Cargo
    attempt waited behind the shared active build and was cancelled before completion. It supplied
    no test evidence; the green results above come from the source owner's completed reruns.
- [ ] After the main agent installs the latest source-only pass, visually verify the exact Questions
  label and compact aliases, agent work titles, live Overview cog, Objective placement, and a real
  run-root agent transcript in the populated cockpit.
- [x] Smoke processes are drained before reinstalling the binary, and no stale test process is left
  running after the audit.
