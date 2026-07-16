# TUI documentation reconciliation

Owner: `tui-docs-sync/root`

Status: `ready_for_integration`

Last checked: 2026-07-14 15:18 Phoenix

## Current ownership

- `docs/control-center.md`
- `docs/tui-cleanup-backlog.md`
- This coordination file and this persona's row in `docs/AGENT_COLLAB.md`

This is a documentation-only reconciliation of the transcript-audited TUI constraints delegated
by `primary/root`. It will not touch Rust/source, install or run Koni, restart the cockpit, send
cmux input, or mutate the preserved Updog runs.

## Coordination

- Checked `context-spec.md`, `primary-integrator.md`, and `tui-polish.md` before editing.
- `tui-polish/root` owns the concurrent New Run stage-scrolling implementation; this lane will
  document that requirement without touching its source ranges.
- No unresolved file overlap. Questions for this lane may be appended below.

## Documentation-history convention

- Never silently delete or rewrite a meaningful prior product requirement merely because a newer
  constraint supersedes it.
- Keep the current authoritative rule unambiguous, preserve the former statement nearby as
  history, and add a dated supersession or transition note that names the replacement and why the
  change was made.
- Pure copy fixes, duplicate prose, and implementation-status updates do not need fabricated
  product history, but a changed layout, interaction, naming, or information contract does.

## Current audit

- Re-audit this lane's edits to `docs/control-center.md` and `docs/tui-cleanup-backlog.md` against
  their pre-edit wording.
- Restore displaced Details, Objective naming/placement, Review Plan, column-layout, and New Run
  stage requirements only as visibly superseded history adjacent to the authoritative replacements.
- Do not touch Rust/source or live state.
- Independent handoff follow-up: restore the prior Runs/New Run key/base behavior and Configure
  publish behavior beside dated transitions, then verify the New Run stage-history note remains
  adjacent to the current complete-scroll requirement.
- Source-complete reconciliation: check the stable-row New Run stage-scrolling contract and record
  the completed-row outcome transition without modifying or erasing the prior checked statements.
- Preserve the open deletion-preview checkbox exactly as-is. Record the focused ticket suite as
  22/22 and leave the full-suite rerun explicitly pending against the known compatibility fixture.
  - **Transition audit opened 2026-07-14:** Preserve this prior pending instruction, replace its
    active status with the integrated 277-test result, and check deletion preview only if that run
    demonstrably includes its focused regression among the passes.
- Graph Seed reconciliation: append the conditional sanitized Review Plan/approved Plan projection
  to the current three-section contract, preserve seedless behavior, record its hard bounds and
  redactions, and close the documentation integration dependency against the 23/23 approval and
  279/279 full-library results.

## Inbox

<!-- Append dated questions here; do not rewrite another persona's decisions. -->

### 2026-07-14 — `primary-integrator`

The user has made the documentation history itself a coordination contract. In
`control-center.md` and `tui-cleanup-backlog.md`, do not simply replace an older requested behavior
with the newer one. Preserve the old statement and add a dated **Superseded by** note naming the
new behavior and rationale. Mechanical stale key/path corrections may be direct only when no
design decision is erased. Report any ambiguous contradiction here before release.

Read-only diff audit confirms the existing Details, Objective naming, and approval changes already
carry useful history notes. Still annotate the silently replaced Configure contract (`Ctrl-S`
formerly validated/published; now save/publish/discard are separate), and preserve the former Runs
key/branch-intake contract beside the new `m`, `v`, lower-case `d`, and selected-target behavior.
Keep mechanical arrow-label cleanup direct, but do not make the authority changes look original.

Follow-up from `docs-evolution-watch`: when `tui-polish` records the integrated focused deletion
preview test, mark the existing two-line Objective-preview backlog item complete with that evidence;
retain the original requirement and append status instead of rewriting it.

## Verification

- `git diff --check -- docs/control-center.md` — passed.
- `git diff --no-index --check /dev/null docs/tui-cleanup-backlog.md` — no whitespace
  diagnostics (exit 1 is expected because the backlog is an untracked nonempty file).
- Pre-edit-history search confirms every meaningful displaced requirement is present beside a
  dated `superseded`, `transitioned`, `reopened`, or completed-audit note: Details naming, Objective
  naming/placement, Review Plan sections/actions, legacy Plan projection, column ratios,
  mini-views, header terminology, and complete New Run stage flow.
- Current-rule search confirms the authoritative equal-column, exact Details title,
  Objective-first Overview, phase-aware Plan, adaptive action, activity/runtime, provisional-row,
  stage-access, Markdown-polish, and deletion-preview contracts remain explicit.
- Handoff-history follow-up confirms the current lowercase `d` / `v` / `m`, explicit target and
  promotion, and split `Ctrl-S` / `Ctrl-P` / `Ctrl-D` contracts precede adjacent dated callouts that
  retain the exact prior `D`, `--base HEAD`, and `Ctrl-S`-publishes requirements.
- The New Run “full stage flow” history note remains immediately nested beneath the current
  complete-scroll requirement; `rg -A 8` confirms there is no intervening requirement.
- The now-complete stage item records stable rendered-row scrolling at 82x20 without hiding Start
  or the footer; both the authoritative and regression checkboxes are checked, while the prior
  “full stage flow” wording remains immediately nested as dated reopen history.
- The pre-existing checked step-row, completed-outcome, and semantic-fallback statements remain
  verbatim. Adjacent 2026-07-14 notes establish the current contract: completed rows omit `done`,
  nonterminal labels remain, green requires recorded typed/file/receipt/graph/review evidence,
  absent evidence is muted `No outcome summary recorded`, and expectations are not accomplishments.
- Focused ticket presentation suite: 22/22. The full TUI rerun remains pending; its prior baseline
  has only the known unrelated compatibility-run fixture failure.
  - **Transitioned 2026-07-14:** The integrated command
    `CARGO_TARGET_DIR=/tmp/koni-tui-polish-target cargo test -p koni-tui --lib` ran 277 tests;
    276 passed and 1 failed only in the pre-recorded unrelated
    `app::tests::action_engine_accepts_only_the_matching_compatibility_run` fixture because the
    planned run returned `NotFound`.
  - **Superseded by the completed integration 2026-07-14:**
    `CARGO_TARGET_DIR=/tmp/koni-tui-polish-target cargo test -p koni-tui --lib -- --nocapture`
    passes 279/279 after the compatibility repair and Graph Seed projection were integrated.
- `cargo test -p koni-tui approval --lib -- --nocapture` — 23/23 for Graph Seed bounds,
  sanitization, 82x24 reachability, seedless three-section behavior, and post-approval Plan reuse.
- The completed Graph Seed documentation records total counts, limits of 6 safe root facts / 12
  semantic nodes / 16 title-resolved relationships, explicit omitted counts, and the prohibition
  on local keys, IDs, hashes, paths, structured/raw spec/schema, and storage metadata.
- The deletion-preview checkbox remains open and unchanged in this pass.
  - **Transitioned 2026-07-14:** The integrated run includes
    `ui::tests::delete_run_objective_preview_is_capped_at_two_lines` among the 276 passes, so the
    existing backlog item is now verified and checked.
- No Rust/source, installed binary, cockpit, cmux, or live-run state was touched.

## Handoff

- The authoritative backlog now checks completed transcript-audited slices and leaves New Run
  stage scrolling, Markdown polish, and the deletion-preview constraint open.
  - **Superseded 2026-07-14:** Stage scrolling and deletion preview are now checked; Markdown polish
    remains open.
- `docs/AGENT_COLLAB.md` still has an older unclaimed legacy-plan-truncation inbox row outside this
  lane's substantive file scope; `primary/root` was notified to remove or reframe it.
- The second pass applied the documentation-history convention: prior product statements now stay
  visible as dated history rather than disappearing when a newer rule wins.
- The independent handoff follow-up added the two missed Configure and Runs/New Run transitions;
  no other product language changed.
- The source-complete reconciliation checked New Run stage scrolling and documented the stricter
  evidence-backed completed-step presentation without erasing prior checked history. Only
  `docs/tui-cleanup-backlog.md` and this mailbox changed in this pass.
- Graph Seed is no longer a transition-in-progress in the claimed TUI docs. Review Plan
  conditionally appends it, approved Plan reuses it, and seedless profiles/runs retain the prior
  Architecture/Risk/Verification surface beside the dated transition note.
- No pre-existing Graph Seed row existed in `tui-cleanup-backlog.md`; this pass added one already
  checked against the supplied green results rather than inventing an earlier backlog state.

### 2026-07-14 — released-backlog follow-up from `primary-integrator/root`

After the independent release-state audit, I changed only the two already-released reciprocal
Research rows in `tui-cleanup-backlog.md`. Their original requests remain verbatim, their
checkboxes now reflect the released result, and adjacent dated notes record canonical stored
`gate.applies_to` plus compiler-derived inverse `gates`, including the aligned workflows/prompts
and focused profile evidence. No Control Center prose, TUI source, binary, or live state changed.
