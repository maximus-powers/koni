# TUI and documentation completion audit

Owner: `tui-docs-completion-audit/root`

Status: `complete` — read-only audit released; findings routed to `primary-integrator/root`

Last checked: 2026-07-16 06:14 MST

## Mission and safety boundary

Audit the current TUI, configuration install path, tests, product documentation, cleanup backlog,
and isolated Updog cockpit against the accumulated user requirements. Distinguish current defects
from items that older audits still call missing even though they have since landed.

This lane changed only this append-only mailbox. It did not edit Rust, tests, profiles, templates,
product documentation, the central registry, installed binaries, the preserved Updog checkout or
run, processes, Git refs, or cmux/cockpit state. The shared worktree was already heavily dirty and
was preserved without reset, formatting, or broad mechanical changes.

## Executive verdict

The control center is substantially more complete than the eight-missing/four-partial audit made it
sound. Equal columns, the adaptive approval action, vertically composed Overview, provisional run
rows, scrollable New Run stages, canonical Research edges, branch-targeted promotion, conditional
Questions, semantic Pi chat, stable Lead history, and cache-excluding token headlines are present
in the source-built isolated cockpit.

It is not completion-clean yet. Two operator-facing regressions should lead the next cohesive TUI
pass:

1. the cockpit redraws the complete dense dashboard every 100 ms and currently consumes roughly
   100–210% CPU even when the Pi child is idle;
2. post-approval Details > Plan reuses the concise approval projection instead of the complete
   durable human-readable plan, and a regression test explicitly requires the full plan to be
   absent.

Versioned bundled baselines plus project overlays remain a separate, real product-integrity gap.
The remaining visual/help/lifecycle issues are bounded follow-ups rather than reasons to reopen all
previously completed TUI work.

## Frozen evidence boundary

- `target/release/koni` and the isolated cockpit binary
  `/Users/max/Desktop/.koni-acceptance-runtime.b3LDDO/bin/koni` were byte-identical at
  `8f0542d9de67b24f849e4ae5b1ce5cf1dbffd06c4ace092cfed5e18e8a725752`.
- The global `~/.cargo/bin/koni` remained intentionally untouched and older at
  `59ccb8611efed62f392981e9d85ebdd791870829b8d130f2c4781a11d5051ed0`. Do not use that global
  binary as evidence for this cockpit, and do not refresh it while preserving the live acceptance
  boundary.
- The isolated cockpit was PID 23897 on cmux workspace 5, right pane/surface 111, operating on
  `/Users/max/Desktop/updog-koni-acceptance-1`.
- The live Medium run showed three equal columns, `Details: Overview - Plan - Stages`, Objective / Run
  / Evidence vertically, timestamps and active runtime in Recent Activity, one stable historical
  Lead row, one verified active Implementer, target `harness-testing`, and the current branch/run
  token headline.

## Token accounting is correct

The reported values are different measures, not a missing-token defect:

- Header and Runs rows use canonical `new_tokens` and now label it `new tks`.
- Overview says that value excludes cache and separately shows uncached input, output, reasoning,
  cached input, and provider total.
- In the observed cockpit, about 1.4M uncached input plus 139K output explained the roughly 1.6M
  new-token headline, while about 5.5M cached input explained why provider total was about 7M.
- Reasoning is an output breakdown, not another bucket to add to output.

The TUI should continue consuming the compiler-owned `new_tokens` field rather than re-deriving it
from provider envelopes, whose input conventions differ. The current language in
`docs/control-center.md:157-178` and the token-accounting mailboxes records the intended distinction.

## Prior regression audit: current disposition

| Earlier item | Current disposition | Evidence |
| --- | --- | --- |
| Unequal dashboard columns | Fixed | `ui.rs:3774-3803` divides the operate area into thirds. The nearby 30/42/28 percentages are vertical Runs/Tickets/Agents heights, not column widths. |
| Two Review Plan buttons | Fixed | `ui.rs:1138-1161` renders one action whose label changes between Approve and Revise; `app.rs:2026-2140` routes the matching authority. |
| Overview mini-tabs / truncated focused Objective | Fixed | `run_overview_details` composes Objective, Run, and Evidence; the four-line preview expands when Details is focused. |
| New run appears only after refresh | Fixed | `app.rs:2588-2590` inserts the provisional row synchronously; model reconciliation preserves it until the durable run arrives. |
| Hidden, unscrollable New Run stages | Fixed | `workflow_stage_window`, `stage_scroll`, and keyboard/page handlers make every rendered stage row reachable. |
| Upgrade-safe project overlays | **Open** | Current schema-2 `--replace` still publishes a complete staged `.koni` directory over the installed profile. |
| Research reciprocal-edge cleanup | Fixed | Canonical bidirectional storage and derived inverses are aligned across the Research profile and prompts. |
| Keybinding normalization | Partial | Review Plan's compact aliases are fixed; two Configure messages still advertise uppercase `L` and `D`. |
| Full agent chat | Substantially fixed | Direct-Pi `message_completed`, reasoning, tool, result, usage, and final assistant output are rendered semantically; the historical Codex reader remains compatibility support. The all-or-nothing 32 MiB transcript cap is still a scale limit. |
| Untruncated approval artifacts | Intentionally superseded | Review Plan is supposed to use planner-authored concise `review` headings/descriptions. The full plan belongs in post-approval Details > Plan, where it is currently missing. |
| Concrete active-agent work titles | Open | The stable Lead still projects `Execute compiled work` for long periods. |
| Durable exited-agent reconciliation | Partial | Cockpit projection repairs the visible state, but the durable record can remain `running`. |

Later requests that are also present include the conditional Questions panel and shared answer
renderer, run-vs-ticket agent filtering, ticket prefixes in run scope, full Pi message projection,
target-branch selection and explicit `m` promotion review, token totals, stable inactive Lead row,
run-deletion stop/revoke semantics, graph/activity split, timestamps, and phase-aware Details tabs.

## Priority findings

### P1 — unconditional redraw saturates a CPU core (or more)

`crates/koni-tui/src/app.rs:270-272` draws the entire dashboard at the beginning of every loop,
then `app.rs:558-559` advances the activity color and polls for only 100 ms. The read-only showcase
duplicates the same loop at `app.rs:653-657`. `ui.rs:4531-4543` makes a four-color pulse from
`activity_tick`; this tiny animation therefore causes the full 13-node relationship renderer,
every Markdown document, and every panel to be rebuilt at 10 frames per second.

Read-only `ps` samples during the audit showed PID 23897 between roughly 114% and 210% CPU while
its direct-Pi child was at 0%. This is the TUI redraw loop, not evidence of token spending.

Minimal correction accepted by `primary-integrator/root`:

- retain <=100 ms input and worker-event latency;
- draw initially and mark the screen dirty only after a snapshot/worker event, user input, mouse,
  resize/focus change, or a due visible animation frame;
- animate only when a compiler-projected live-work cue is actually visible, not merely because a
  run has pending tickets or an active status;
- cap the animation deadline around 500 ms (and either accept the current `/ 2` one-second color
  step or simplify that index deliberately);
- use the same event-driven loop in `run_read_only_snapshot`.

Required tests should exercise the loop policy rather than colors alone: idle time causes no
repeated draw/animation; a live cue causes at most two animation redraws per second; worker/input
causes an immediate dirty draw; and the showcase follows the same rule.

### P1 — approval mini-plan and approved full plan are conflated

The durable source is intact:

- `model.rs:5666-5717` builds `ApprovalPlanningPass` records;
- each pass's complete body comes from `planning_stage_output` at `model.rs:5770-5810`;
- its independently authored concise projection comes from `planning_stage_review` at
  `model.rs:5812-5868`.

`approval_draft` correctly prefers the authored `review` objects for the Review Plan modal.
However, `ui.rs:5609-5627` implements post-approval Plan by calling that same `approval_draft`, so
the complete bodies are discarded from the operator view. The test
`ui::tests::plan_panel_switches_from_live_activity_to_the_approved_human_plan` at
`ui.rs:15590-15692` explicitly asserts that `Complete compiler-facing plan text` is absent.

The correct two-projection contract is:

- **Review Plan modal:** concise, planner-authored structured items with individual heading and
  description fields; legacy plans may receive an honestly labeled bounded fallback.
- **Approved Details > Plan:** every successful durable planning-pass body once, rendered as
  scrollable Markdown under its pass title, followed by the existing bounded/redacted Graph Seed.
  A Medium run's one combined plan must appear once, not be copied into three inferred sections.

Reuse the existing control-metadata redaction boundary without removing useful product paths. Add
one fixture with distinct `MINI-ONLY` and `FULL-ONLY` sentinels: the modal must show only MINI, and
the approved Plan must show FULL plus Graph Seed with all content scroll-reachable.

Documentation currently contradicts both the code and the latest user decision:

- `docs/control-center.md:338-340` says Review Plan itself contains the complete plan;
- its dated note at `control-center.md:383-397` incorrectly says the concise projection was later
  superseded;
- `docs/configuration.md:347-353` repeats that incorrect supersession;
- `docs/tui-cleanup-backlog.md:59-65` correctly requires the full approved Plan but marks it fixed.

Preserve that history, then append a current transition distinguishing modal MINI from approved
Plan FULL. Do not rewrite the original entries as though the distinction was always present.

### P1 — profile replacement still cannot preserve project-owned customization

The user required Koni updates to preserve repo-specific profile decisions. The documentation
honestly says this is not implemented at `docs/configuration.md:458-470`, and the authoritative
backlog remains unchecked at `docs/tui-cleanup-backlog.md:109-110`.

In schema 2, `install_schema2_profile` stages a complete `.koni` tree
(`crates/koni-cli/src/main.rs:1652-1753`). `publish_staged_install` then backs up and replaces the
complete destination (`main.rs:2548-2667`). Hashed ownership preserves independently modified
external skills/agents, but it does not merge profile configuration.

This deserves its own design lane rather than an incidental TUI patch: persist the versioned
bundled baseline identity, keep a project-owned overlay, resolve future run snapshots from both,
and make upgrades report a semantic three-way diff/conflict rather than swapping the project tree.
Pinned runs must continue using their resolved snapshot.

## P2 operator-quality findings

### Contextual help describes removed behavior and the old runtime

`crates/koni-tui/src/help.rs:184-226` still tells operators to select an Overview mini-view and
move between Objective, metadata, and health. It calls the tab `Details · Planning`, although the
visible tab is `Plan` and becomes the full approved plan after approval. `help.rs:105-120` calls
all sessions Codex sessions even though schema-2 work is direct Pi.

This matters because `h` was explicitly intended to teach the current panel. Update it to explain
the one vertically scrollable Objective / Run / Evidence document, phase-aware Plan behavior, and
Koni-owned Pi sessions with historical Codex compatibility. Internal comments at
`model.rs:100` and `model.rs:1579` also still say mini-view.

### The real graph remains unreadable at equal-column width

The live 13-node integration graph occupies about 40 inner columns. Its nested projection shows a
dense wall of `<relation>` labels, vertical lanes, crossings, and truncated two-to-four-word titles.
Although the renderer implements title-over-line geometry, the real Medium topology is not
operationally scannable. Existing unit geometry fixtures do not protect the whole dashboard at this
density.

There is also a documentation/config mismatch: `docs/tui-cleanup-backlog.md:254-259` calls the
layered relationship **canvas** the default, while bundled Software, Research, fixture, and the
isolated Updog `cockpit.yaml` all configure `layout: nested`.

Do not solve this by removing semantic titles. Add a deterministic TestBackend fixture using a
sanitized 12–15-node Software topology at the actual 39–41-cell panel width, then choose and
document one current layout. Likely bounded improvements are adaptive relation-label suppression or
abbreviation, a focus-expanded/horizontally scrollable graph surface, and collapsing repeated
secondary lanes while preserving edge identity and ticket diff colors.

### Long-lived Lead work remains generic

`RunData::agent_summaries` chooses the stage title before `active_step`
(`crates/koni-tui/src/model.rs:723-734`). The orchestration stage is titled `Execute compiled work`,
so the live stable Lead row still says exactly that while it is preparing a checkout, dispatching,
reviewing, or recovering.

Persist a small compiler-owned Lead action boundary (or prefer a trustworthy active boundary over
the generic orchestration title), and regress the setup/dispatch/review/recovery transitions. Do
not infer a specific action from process IDs or raw event noise.

### Exited-agent repair is presentation-only

`snapshot_agent_records` at `crates/koni-core/src/engine.rs:50743-50779` projects a dead `running`
record as completed/exited/exited-before-output for cockpit snapshots.
`reconciled_snapshot_agent_records` deliberately does not mutate durable control state. This fixes
the visible active count but leaves stale lifecycle authority on disk, matching the unchecked
backlog item.

The durable fix belongs in an identity-verified supervisor/reaper/recovery transition under the
existing control locks, not in TUI refresh. It should be journaled and idempotent and must never let
a stale UI read recreate a deleted run.

### Compact controls still visibly truncate

At the roomy 122-column live screen, the Runs panel hint ended in `d delete · n n`, and the global
footer ended with a clipped `automation …` fragment. Long run/ticket titles were also aggressively
cut. This is the still-open non-title portion of compact-rendering finding 7 at
`docs/tui-cleanup-backlog.md:165-167`.

Reserve space for current status/errors before low-priority key lists, choose complete width-aware
control groups, and add 82x24 plus 122-column CJK/emoji tests that forbid partial labels and border
collisions.

### Two Configure messages advertise uppercase keys

Actual handlers use lowercase ordinary keys, but `model.rs:3248` says `press L in Configure` and
`model.rs:3605` says `press D to undo`. Change the copy and add direct assertions. This is the only
definite remainder of the earlier keybinding-normalization item.

### A large transcript can still disappear wholesale

`agent_chat.rs:23` caps a transcript at 32 MiB, and `read_project_file` at
`agent_chat.rs:332-360` rejects the entire file above that limit. Current Updog logs are below the
cap, so this is not the cause of the observed chats, but a sufficiently long run can regress from a
full semantic transcript to only a notice/final-output fallback.

Select or stream the requested session within a bounded memory budget and show an explicit older-
history truncation marker instead of discarding the entire conversation. The old backlog phrase
“exact native Codex CLI parity” should not be used as the acceptance criterion for this work.

## Documentation and backlog corrections that do not require product code

1. **Markdown polish is already implemented but still unchecked.** The shared renderer now keeps
   nested list indentation/hanging wraps, adds block spacing, colors filenames, and has focused
   tests at `agent_chat.rs:2608-2685`. Mark the old backlog item complete with an adjacent dated
   transition; do not delete the original request.
2. **Exact native Codex CLI parity is obsolete as a current schema-2 goal.** Production sessions
   are direct Pi. Reframe the unchecked item as faithful Koni-owned Pi semantic transcript
   projection plus historical Codex compatibility. Terminal styling need not clone an unrelated
   private Codex UI implementation.
3. **Review Plan docs need the MINI/FULL distinction** described above.
4. **Graph-default docs need to agree with configured `nested` or the profiles need to move back to
   the claimed canvas.** Preserve the prior graph-history note whichever direction wins.
5. Help tests should assert the current information architecture, not merely that help exists.

## Why the green TUI suite does not catch these findings

The last frozen source gate passed 303/303 TUI tests, but several assertions cover the mechanics
rather than the current operator contract:

- the approved-Plan test explicitly requires the complete durable plan text to be absent;
- animation tests inspect color selection, not the event loop's redraw count or CPU cadence;
- graph tests protect small geometry fixtures, not a real dense Software graph inside one equal
  dashboard column;
- contextual-help tests do not reject `mini-view`, `Details · Planning`, or schema-2-as-Codex copy;
- the uppercase Configure status messages have no convention regression;
- cockpit reconciliation tests intentionally assert that the raw stale agent record remains
  `running`.

The suite is therefore valuable but not evidence that these higher-level behavior contracts are
closed.

## Recommended cohesive implementation order

For one Medium-sized TUI pass:

1. land the event-driven redraw policy and cadence tests first;
2. separate approval MINI from approved Plan FULL, invert the misleading regression, and append
   the documentation transition;
3. correct contextual help and lowercase Configure copy;
4. add one full-dashboard visual fixture, then address graph density, footer priority, and concrete
   Lead labels against that fixture;
5. rerun focused tests, the complete TUI library, warning-denied TUI Clippy, formatting, and
   whitespace checks before the next guarded isolated-binary refresh.

Keep upgrade overlays and durable exited-agent reconciliation as explicit architectural follow-ups.
They cross installer/runtime authority boundaries and should not be rushed into the presentation
pass merely to reduce the checkbox count.

## Release handoff

`primary-integrator/root` has accepted the redraw and MINI-vs-FULL findings for implementation.
This read-only lane releases all inspection scope. No action from this report authorizes pausing,
restarting, deleting, promoting, or otherwise mutating the preserved acceptance run.
