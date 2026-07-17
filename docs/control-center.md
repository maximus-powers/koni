# Control center and CLI

Running `koni` with no subcommand opens the project control center. It
discovers the enclosing project root and combines `.codex/koni/` with native
Codex agents, settings, and skills.

> **Pi/schema 2 transition in progress — 2026-07-14 (`pi_product_docs_transition`):** The control
> center described here is the executable schema-1/Codex interface and remains the projection for
> pinned historical runs. The unreleased schema-2 target discovers `.koni/` plus provider-neutral
> agents and uses the direct Pi host in [Direct Pi runtime](pi-runtime.md). A migrated project will
> not fall back to Codex. Cutover remains blocked on ownership-safe migration and active-run
> archival, historical readers, the unresolved credential-TCB decision (Rust-owned allowlisted
> auth proxy versus signed/pinned host dependency closure), Pi runtime/security re-review, and one
> frozen host/Rust/CLI/TUI/profile fingerprint.

> **Release-candidate supersession — 2026-07-14 (`pi_product_docs_transition`):** The preceding
> unreleased/blocked status is historical. Current source is the schema-2/direct-Pi release
> candidate for macOS, and its control center reads `.koni` and Pi-native state with no production
> Codex fallback. The accepted first-cut credential TCB is the exact Köni Rust binary, bundled Pi
> host, pinned Pi SDK 0.80.7 dependency closure, and official pinned Node 22.19.0 runtime; Node has
> no compiler-tool, graph, Git, receipt, or project-file authority. Linux login/inference fail
> closed until allowlisted outbound egress exists. Installation or live migration is a separate
> guarded operator action, never authority inferred from protected forensic Updog state.

```sh
cd my-project
koni

# Open an explicit project.
koni cockpit /path/to/my-project
```

In a non-interactive session or `TERM=dumb`, the command prints a plain
snapshot. Use `--json` for a deterministic automation surface:

```sh
koni --run <run-id> cockpit /path/to/my-project --json
```

Without `--run`, JSON mode uses the compatibility current-run selection.
`koni runs` always returns the complete project registry.

## Operate

Operate is the default view:

| Surface | Contents |
| --- | --- |
| Runs | Every planning, active, paused, blocked, failed, and concluded run |
| Tickets | The selected run's compiled board, filtered by lifecycle state |
| Details | `Overview`, the phase-aware `Plan`, and pipeline `Stages` |
| Questions | Appears only while the selected run needs a decision |
| Agents | Live model work followed by durable agent history |
| Recent Activity | Timestamped graph changes and compiler lifecycle work |
| Project graph | The profile-defined typed hierarchy and relationships |

Selecting another run replaces all dependent panels as one projection. It does
not pause, mutate, or hide the previously selected run.

At roomy terminal widths, the three dashboard columns have equal width. The
left-aligned Details title exposes all of its tabs on one line as
`Details: Overview - Plan - Stages`; the active tab is white and the inactive
tabs are light grey. Run Overview is one vertically scrollable document:
Objective first, followed by Run and Evidence. Its collapsed Objective preview
uses four lines, and focusing it makes the complete wrapped Objective reachable
without switching to a nested mini-view.

Ticket Overview shows the first useful typed, durable `Blocker.message` in array order. A durable
display candidate is an object row with string `kind`, `message`, and `created_at`; generic,
placeholder-only, raw structured, and malformed or untyped messages are suppressed. Known
run/ticket/stage/agent/graph/question/action identifiers become fixed operator-facing phrases,
while unknown identifiers, paths, hashes, embedded raw records, and control characters are
redacted. The reason hard-wraps without truncation by Unicode terminal display width. `+N more`
counts every other typed durable blocker record, including a record whose message was suppressed.
If no useful reason survives, Ticket Overview keeps the count-only disclosure.

> **Prior count-only behavior:** “Ticket Details only says `N blockers need attention`.”
>
> **Resolved 2026-07-14.** The count remains the fail-closed fallback, while the normal view now
> adds the first safe actionable reason and the typed-durable remainder count described above.
> The original finding remains here because malformed, raw, or placeholder-only data must never
> be promoted into an invented explanation.

Evidence is trivalent. Recorded issues; failed or blocked run, ticket, or pipeline state; and a
failed current review produce red **Attention** and take precedence over positive evidence. Green
**Evidence recorded** appears only when every monitored telemetry channel is explicitly present
and zero and Köni has durable current ticket output, current compiler `review_status=passed` with
no configured review step pending, succeeded verification output, or succeeded final-report
output. Both compact and expanded Evidence name which basis was recorded; the UI never substitutes
generic **HEALTHY**.

Complete telemetry includes a stages array and a fully shaped compiler `ticket_workflows` row for
every ticket. A stale historical review pass is not current proof. Without a qualifying positive
basis, the neutral state is muted **No recorded issues** with **Evidence pending**. A configured
report view without succeeded final-report output says **No final report yet**; its configuration
alone is not evidence that the run is ready.

> **Prior Evidence behavior:** “Evidence can claim `HEALTHY` solely from the absence of recorded
> errors, before positive evidence exists.”
>
> **Superseded 2026-07-14.** Absence of recorded issues is now neutral. A green claim requires both
> complete zero-valued telemetry and one of the durable positive evidence sources above.
>
> **Intermediate candidate recorded 2026-07-14:** “Green **HEALTHY** appears only when every
> monitored telemetry channel is explicitly present and zero and Köni has durable current ticket
> output, a passed current review, succeeded verification output, or succeeded final-report
> output.”
>
> **Superseded after independent review 2026-07-14.** The positive badge now says **Evidence
> recorded** and names its basis. Telemetry and review authority also require the complete compiler
> shapes described above, preventing stale passes or partial state from becoming green.

Plan changes with the run phase. Before approval it shows the quiet planning
activity stream. After approval it shows the approved human-readable plan
artifacts as wrapped, vertically scrollable Markdown, so the execution contract
remains reviewable while work proceeds. Every Recent Activity row begins with a
compact timestamp.

Recent Activity includes runtime only for a selected run that is neither planning nor provisional
and has both a parseable durable `active_runtime_approved_at` anchor and a numeric lifecycle active
duration. An approved numeric zero remains **0s active**. Without a selected run, the panel prompts
the operator to select one; it does not invent runtime.

The panel title uses its actual bordered Unicode display-width budget. It shows the full
`Recent activity · 1h 02m active` when that fits, the exact compact `Activity · 1h02m` at the
82×24 dashboard minimum, and identity-only `Activity` when an extreme exact duration cannot fit.
Every significant unit and anchored `0s` is preserved; the title omits an overlong suffix instead
of clipping, clamping, or approximating it. This selection does not change the
`active_runtime_label` authority gates above.

> **Prior compact-layout finding:** “At 82 columns, the equal right column is about 27 cells, yet
> `Recent activity · 1h 02m active` exceeds 30 before borders.” A read-only smoke reproduction
> observed the clipped title `┌ Recent activity · 1h 02m┐`, with approved zero able to
> degrade to a partial `0s act`.
>
> **Resolved title-only slice — 2026-07-14.** Complete width-fitting title candidates replace
> terminal clipping. This closes only Recent Activity's title within the broader compact-rendering
> finding; footer feedback priority, long Runs/ticket titles, and other Unicode-width calculations
> remain separate unresolved work.

> **Prior runtime requirement:** “Its header reports total active runtime since durable plan
> approval, excluding every interval in which the run was durably paused.”
>
> **Transitioned 2026-07-14.** That calculation remains authoritative after its approval anchor,
> but the header now omits runtime until the selected run proves the anchor and numeric duration.

> **Specification history — superseded 2026-07-14.** The prior Details contract was
> “Overview, durable planning activity, and pipeline stages.” That unnamed activity view is now
> the phase-aware `Plan`, and the latest transcript-audited layout requires the exact title
> `Details: Overview - Plan - Stages` so its information architecture stays visible.

An animated cog means a model is starting, running, or resuming and may be
spending tokens. A quiet circle means the run is waiting for approval, input,
manual progress, or retry. Token totals are reconstructed from durable Codex
turn records rather than inferred from run status.

> **Token-display transition — 2026-07-15 (`token-display-contract`):** The sentence above is
> retained as aggregation history; “token totals” did not say which total the operator saw. The
> header, Runs rows, and Overview headline now report `new_tokens`—uncached input plus output—so
> cache reads do not inflate the cockpit's primary work measure. Overview keeps cached input and
> the provider-processed total as separately labeled secondary telemetry. A planning budget still
> follows its configured metric and says `processed` when that metric includes cache reads.

> **Compact-label clarification — 2026-07-16 (`token-accounting-ui`):** The accounting contract
> above is unchanged. The header and Runs row no longer present an unlabeled abbreviation such as
> `250K tks`; they render `250K new tks`, making the cache-excluding meaning visible without
> requiring the operator to open Overview. Overview retains the full uncached input, output,
> reasoning, cached-input, and provider-total breakdown.

> **Token-ingestion correction — 2026-07-15 (`token-ingestion-impl`):** The display contract above
> is unchanged, but its durable source now covers every compiler-owned runtime path. The run scan
> recursively admits only agent `stdout.jsonl`/resume logs, legacy `worker.log`, and validated
> `worker.<agent-id>.attempt-<positive-n>.log` files. One shared normalizer serves both planning
> budgets and cockpit snapshots. For each durable Pi turn it counts committed compatibility usage,
> otherwise an exact checkpoint or legacy terminal, otherwise summed pre-terminal deltas. A
> delta-only failed/timeout turn contributes spent tokens without claiming completion. Native
> Codex gross-input terminals remain independent historical occurrences. Cached input is removed
> exactly once from `new_tokens`; provider total remains the cache-inclusive secondary figure.

> **Token-ingestion review hardening — 2026-07-15:** The correction above now also accepts the
> older compiler-owned Pi envelope whose `type` key is absent, including delta-only interrupted
> turns, while rejecting explicit null/unknown types. Higher-precedence usage with impossible
> cache/output/reasoning buckets is ineligible rather than saturating to an understated headline;
> the same turn then falls through to its next valid durable source. Provider total may legitimately
> exceed Pi's visible buckets, so that safe surplus remains counted.

> **Native-event transition in progress — 2026-07-14 (`pi_product_docs_transition`):** Durable
> Codex turns remain the token/event source for schema-1 and historical views. Schema 2 projects
> Köni-owned Pi message, tool, retry, compaction, usage, and terminal events instead of parsing a
> Codex transcript. That projection is not shipped until request/turn correlation, exactly-one
> terminal closure, cache/token accounting, secret-safe failures, cancellation teardown, and TUI
> compatibility tests pass on the frozen cutover fingerprint.

> **Native-event supersession — 2026-07-14 (`pi_product_docs_transition`):** Those correlation,
> terminal, accounting, teardown, secret-safety, and TUI requirements now pass for the release
> candidate. Schema-2 rows are projected from durable Pi events; schema-1 Codex turns remain
> historical-reader input only after migration and never provide an execution fallback.

> **Agent-chat transcript transition — 2026-07-15 (`primary-integrator`):** A live Pi acceptance
> run exposed that the generic native-event projection above rendered repeated “Pi event” rows while
> hiding the actual conversation. Current chat reads the compiler-owned per-agent artifact and
> renders the complete prompt, assistant/reasoning messages, compiler tool inputs/results, usage,
> and fixed failures. Raw transport envelopes are suppressed. Older compact Pi logs fall back to
> the authoritative final output artifact, while new logs retain complete-message payloads without
> reintroducing streaming-delta noise.

> **Direct-agent envelope closure — 2026-07-15 (`primary-integrator`):** Live acceptance then
> exposed one remaining writer/reader mismatch: planning wrapped its retained payload as
> `type: pi.event`, while direct Lead and ticket-worker logs stored the same complete payload in
> an older envelope without `type`. The data was present, but chat rendered an empty-state notice.
> All Pi paths now write one canonical compiler-owned record shape. The reader also recognizes the
> older direct envelope so already-running and completed agents immediately regain their full
> reasoning, assistant messages, tool calls, and tool results after a cockpit upgrade. Intermediate
> usage checkpoints remain accounting transport rather than chat rows; the terminal total stays
> visible without flooding the conversation.

> **History-navigation closure — 2026-07-15 (`primary-integrator`):** The complete transcript is
> navigable, not merely durable. `Home` enters an explicit top-relative history position;
> `Down`/`PageDown` advance from it, `Up`/`PageUp` move back, and `End` returns to the live tail.
> This replaces the former maximum-integer sentinel, which could reach the first message but could
> not page forward through a long prompt. Unexecuted calls from a terminal tool batch render as
> muted `Skipped` rows rather than an active cog.

The minimum interactive layout is 82 columns by 20 rows. Click to focus a
panel; the mouse wheel scrolls the panel beneath the pointer.

Control hints follow one placement rule throughout the control center: they
live on the bottom edge of their modal or panel, or in the global contextual
footer for the focused panel. Titles identify the surface, while body content
is reserved for project state, choices, and explanations.

### Main keys

| Key | Effect |
| --- | --- |
| `q` | Save valid configuration drafts, then quit |
| `r` | Refresh |
| `Tab` / `Shift-Tab` | Move focus through visible panels |
| `1` … `5` | Focus Runs, Tickets, Details, Agents, or Graph when unclaimed by the profile |
| `↑` / `↓` or `j` / `k` | Move or scroll in the focused surface |
| `PageUp` / `PageDown` | Scroll by a page |
| `←` / `→` or `[` / `]` | Change the active tab, detail view, or question |
| `h` | Open help for the focused panel |
| `F1` | Open help while a text editor needs literal `h` input |
| `n` | Open New run |
| `a` | Open configured actions for the current selection |
| `c` | Switch between Operate and Configure |
| `?` | Answer the selected pending question |
| `Space` on Runs | Pause or resume the selected run |
| `m` on Runs | Review and authorize a ready run's merge into its target branch |
| `v` | Open the selected planning run's review whenever approval is ready |
| `d` on Runs | Open run-deletion choices |
| `Enter` | Activate the focused, explicit action |

> **Keybinding history — transitioned 2026-07-14.** The prior Runs requirement was “`D` on Runs:
> Open run-deletion choices.” The current contract uses lowercase `d` for deletion and adds `v`
> for Plan review plus `m` for promotion review, following the later user requirement that ordinary
> contextual actions use lowercase keys and that approval and promotion remain distinct actions.

Profiles may add orchestration keybindings. Protected panel keys win, and the
footer and contextual help show only reachable bindings.

### New run

Press `n` to open the run form. It contains:

- the Objective and profile-defined intake fields;
- selectable complete run-type peers;
- a target branch selected from recent user-owned local branches;
- the ordered pipeline, including skipped stages;
- question behavior;
- maximum parallel agents;
- model and reasoning selectors for Planner, Lead, Worker, and Reviewer.

> **Contained model-catalog clarification — 2026-07-16:** selectable models come from a fresh
> offline Pi `ModelRuntime` using the operator's normal Pi credentials, `models.json`, and cached
> model inventory—the same substrate a contained attempt constructs. In `/koni`, models supplied
> only by another ambient extension are shown as unavailable diagnostics rather than selectable;
> Koni does not copy that extension's provider functions into autonomous sessions. Standalone
> `koni tui` applies the same executable-catalog rule.

> **Naming history — superseded 2026-07-14.** The prior form requirement called the first item
> “the goal and profile-defined intake fields.” The user later required the visible product term
> `Objective` everywhere in the TUI, so `goal` remains only the compatible CLI flag name.

Changing run type refreshes its effective defaults. Edits in this dialog are
one-run overrides; they do not mutate the reusable run type. The base commit,
configuration files, effective role policy, and overrides are pinned when
planning begins.

The stage flow is complete rather than sampled. When it does not fit, it
scrolls so every configured stage, including wrapped stage names, remains
reachable alongside the rest of the form and its controls.

Enter on an ordinary field edits it. Work is submitted only by focusing and
activating the bottom **Start Planning** or **Start Work** button. A synchronous
validation error keeps the form and its content open. Activation inserts a
provisional Runs row immediately, before planning begins or a durable snapshot
exists. Refresh retains that feedback; the row is then reconciled with the
compiler-assigned identity or removed with a visible submission failure.

The target branch is pinned when planning begins. Köni creates an isolated run
branch and worktree from that exact head; agents never work directly in the
target checkout. The run row keeps showing the destination branch and adds a
ready-to-merge indicator only after the configured work and verification
boundaries are satisfied.

> **Run-namespace timing transition — 2026-07-14.** The paragraph above preserves the earlier
> shorthand that described the isolated run branch and worktree as beginning with planning.
> Current planning instead uses a detached worktree at the pinned target head. The permanent run
> branch and run worktree are created only after explicit plan approval; agents still never work
> in the target checkout, and later promotion remains a separate operator action.

> **Run-base history — transitioned 2026-07-14.** The prior CLI planning example pinned only a
> base with “`--base HEAD`,” and the prior New Run field list exposed no target-branch
> selector. The current workflow instead makes the destination branch an explicit operator choice,
> pins its exact head as the run base, and keeps target promotion behind the separate `m` review
> flow. This makes the branch agents work from and the branch the operator may later promote to
> visible before planning begins.

Selectors consistently accept both arrow keys and their keyboard aliases:
`↑`/`↓` or `j`/`k` vertically, and `←`/`→` or `[`/`]` horizontally. Literal text
inputs keep printable `j`, `k`, `[` and `]` characters available for typing.

### Planning and approval

Planning agents run in a detached read-only worktree through a structured
output boundary. Their durable activity appears in Details' Plan tab. A valid
question pauses the originating stage, appears in Questions, and resumes the
same Codex session after an answer.

> **Planning-session transition in progress — 2026-07-14 (`pi_product_docs_transition`):** The
> pause/answer/resume semantics remain the target behavior, but schema-2 runs resume a Köni-owned
> Pi session/event log rather than a Codex session. Existing schema-1 sessions remain readable and
> are archived rather than resumed across migration. Release requires canonical event order,
> question/turn identity, fail-closed abort and child cleanup, and the complete history-reader/TUI
> matrix in [Direct Pi runtime](pi-runtime.md).

> **Planning-session supersession — 2026-07-14 (`pi_product_docs_transition`):** The release
> candidate closes that event, identity, cleanup, and reader/TUI matrix. Schema-2 questions resume
> the same Köni-owned Pi session; migrated Codex sessions remain inspectable archival history and
> are never resumed under Pi. Existing installed projects do not change runtime until guarded
> migration.

Review Plan is an informed review surface, not a confirmation prompt. It shows
the complete human-readable plan as wrapped, vertically scrollable Markdown;
all plan content remains reachable. The modal opens once when the selected run
first becomes ready and remains available with `v`. Browse with the tab and
scroll keys; Enter while browsing cannot approve.

The modal title is exactly **Review plan**: it names the inspection state without presuming which
authority-crossing action the operator will choose. Its bottom-edge help is exactly
`←→/[] sections · ↑↓/jk/PgUp/PgDn scroll · Tab focus · Enter · Esc`, matching the
existing section, scrolling, focus, activation, and dismissal handlers at compact width.

> **Immediately superseded Review Plan title/help:** “Review planning and approve” and
> “[] plans · ↑↓/jk scroll · Tab focus · Enter action/newline · Esc”.
>
> **Earlier help history:** “←/→ sections · ↑/↓/Pg scroll · Tab action · r resume · Esc close.”
>
> **Transitioned 2026-07-14.** The neutral title now identifies the surface, while **Approve run**
> or **Revise plan** continues to identify the adaptive action. The complete footer exposes the
> already-supported arrow, bracket, `j`/`k`, and page aliases instead of advertising only a subset.

When planning produced a Graph Seed, Review Plan conditionally appends a
**Graph Seed** section after Architecture, Risk, and Verification. It starts with the total root
fact, semantic-node, and relationship counts, then shows at most six safe top-level root facts,
twelve semantic nodes by type, title, and authored purpose, and sixteen title-resolved
relationships. Explicit omitted counts disclose the remainder. At 82x24, vertical scrolling keeps
the complete bounded section reachable. After approval, Details' Plan reuses the same sanitized
section alongside the approved human plan.

The projection never renders local keys, IDs, hashes, paths, structured or raw spec/schema
payloads, or storage metadata.

> **Plan-section transition — completed 2026-07-14.** The prior current contract presented three
> plan sections: Architecture, Risk, and Verification. Profiles and runs without a Graph Seed retain
> those same three sections. Seeded runs now append the bounded fourth section because approval
> should not publish semantic authority the operator could not inspect; the earlier seedless
> behavior remains unchanged.

The action row has one primary action. With no steering text it reads
**Approve run** and crosses the approval boundary. As soon as the multiline
steering editor contains text, the same action reads **Revise plan** and sends
those requested changes instead. Enter adds a line in the editor, while
`Ctrl-Enter` invokes the adaptive action directly. Revision steering is stored
durably, reopens the planning prefix, resumes the same Codex thread where
available, regenerates dependent plans, and presents the review again.

> **Prior requirement:** “Approval is an informed review surface, not a confirmation prompt. Its
> fixed header keeps **Architecture · Decisions · Risk · Verification** visible and shows
> concise, skimmable projections. New planning outputs persist those human summaries separately
> from the complete plan; older runs are condensed by heading at display time. In both cases, the
> complete durable plan remains unchanged and drives compilation and execution.”
>
> **Prior action requirement:** “The action row keeps **Approve run** on the left and **Revise
> plan** on the right. Both use the same primary-button treatment as New Run's start action. Focus
> **Approve run** to cross the boundary. To decline without discarding the run, focus the multiline
> steering editor and type the requested changes; Enter adds a line, while `Ctrl-Enter` submits
> directly. You can instead Tab to **Revise plan** and press Enter.”
>
> **Superseded 2026-07-14.** The later transcript-audited user constraint replaced that
> agent-designed projection with the complete scrollable Plan and one adaptive action, removing
> redundant competing controls without weakening explicit approval.

> **Projection correction — 2026-07-16.** The preceding supersession conflated two intentionally
> different operator surfaces. **Review plan** uses the planning agent's separately authored,
> concise heading-and-description objects so approval is fast to skim; it never derives headings
> by truncating the execution prose. The complete durable planning-pass bodies remain unchanged
> for compilation and execution. Once approved, **Details · Plan** renders each successful full
> planning body once as scrollable Markdown, followed by the same bounded/redacted Graph Seed.
> This MINI-at-approval / FULL-after-approval split supersedes only the conflated projection claim;
> the single adaptive Approve/Revise action remains current.

Approval is disabled while required planning passes or questions are
incomplete.

### Pause, resume, and delete

Space on the selected run closes or opens its scheduler gate. Pausing is a
graceful drain: no new work is dispatched, while work already beyond a safe
boundary may finish. Planning processes are resumed from their captured Codex
session where possible; otherwise Köni explains that the pass will restart.

Deletion always requires confirmation. To identify the selected run without
letting an unbounded prompt dominate the dialog, the confirmation shows only a
truncated Objective preview. The safe default removes runtime state and owned
worktrees while preserving committed branches. Deleting proven Köni-owned
branches is a separate choice. Live agents, dirty worktrees, unproven
ownership, or mismatched process identity block deletion.

## Configure

Press `c` to edit the project contract. Configure groups resources by intent:

- Project
- Run Types — including Small/Medium/Large role models, reasoning, questions,
  stages, and parallelism
- Agents — shared Codex personas, prompts, permissions, and skills
- Workflows & Tickets
- Graph Model & Rules
- Actions & Checks
- Reports & Views
- Advanced

> **Configure transition in progress — 2026-07-14 (`pi_product_docs_transition`):** The Agents
> domain continues to edit Codex TOML for schema-1 projects. The schema-2 guided editor will expose
> provider-neutral `.koni/agents` instructions, model, `thinking_level`, capabilities, and skills
> while keeping run-type overrides in Run Types. Publishing that surface depends on field-scoped
> migration, historical schema-1 readers, credential/containment authority, and the frozen CLI/TUI
> matrix; source-in-progress Pi definitions are not an installed Configure contract yet.

> **Configure-surface supersession — 2026-07-14 (`pi_product_docs_transition`):** The current
> release candidate closes those source gates and exposes the schema-2 `.koni`/provider-neutral
> contract. A schema-1 installation continues to edit its existing Codex resources until an
> explicit migration publishes `.koni`; Configure never creates a dual runtime or Codex fallback.

Guided forms expose common typed settings. Agent cards keep instructions,
model, reasoning, sandbox, permissions, and skills together. Advanced provides
contained YAML/Markdown editing and explicit create, rename, or delete
operations.

All edits enter one restartable draft set. `Ctrl-S` saves that set without
publishing it. `Ctrl-P` validates the complete catalog, profile, native agents,
and referenced skills before publishing the set. `Ctrl-D` discards the entire
unpublished set and reloads the published configuration. A validation failure
leaves the active configuration unchanged and retains the draft for correction.

> **Configure history — transitioned 2026-07-14.** The prior requirement was: “All edits enter
> one restartable draft set. `Ctrl-S` validates the complete catalog, profile, native agents, and
> referenced skills before publishing the set. A validation failure leaves the active
> configuration unchanged and retains the draft for correction.” The current contract separates
> saving (`Ctrl-S`), validating and publishing (`Ctrl-P`), and discarding (`Ctrl-D`) so a draft can
> be preserved without implicitly changing the active configuration.

Renames do not guess at cross-document reference updates. Stage every required
reference change in the same draft. Published edits affect future runs only;
approved and planning runs retain their snapshots.

The installed `configure-koni` and `model-koni-work` skills are usually the
fastest way to make substantial changes. Use Configure to inspect and refine
the result.

## CLI workflow

### Project setup

```sh
koni init
koni init --profile research
koni init --from /path/to/custom-profile
koni init --target /path/to/project --dry-run
koni init --target /path/to/project --replace --open
```

`koni install` remains a lower-level profile installation command. New users
should prefer `koni init`, which adds discovery, idempotency, and migration.

> **Cutover installation hold — 2026-07-14 (`pi_product_docs_transition`):** These commands still
> install or validate the schema-1 layout in the current product. Do not use an ordinary guarded
> refresh to install the active Pi/schema-2 source as though it were released. Schema-2 activation
> requires the explicit migration transaction, authoritative archival of active Codex runs,
> ancestor-symlink/field-transform/publication/crash recovery proof, Pi security re-review, and one
> green frozen matrix. Historical runs remain readable; a migrated project has no Codex fallback.

> **Installation-hold supersession — 2026-07-14 (`pi_product_docs_transition`):** The current
> release candidate satisfies the named source and frozen-matrix gates, and current schema-2 CLI
> controls are the ones documented below. This is not an automatic refresh authorization: building
> or installing the candidate, migrating a live project, and running acceptance work are distinct
> guarded operator actions. Protected forensic Updog runs must remain untouched.

### Plan and approve

```sh
PLAN_JSON="$(koni plan-run \
  --root /path/to/project \
  --run-type medium \
  --target-branch main \
  --goal "Introduce an explicit cache invalidation boundary")"

koni runs --root /path/to/project
koni resume-planning <run-id> --root /path/to/project
koni approve-run <run-id> --root /path/to/project
```

`plan-run` returns the run ID and current planning-agent result. Retry or
resume incomplete planning before approval. Approval verifies every pinned file
and hash before creating the permanent run namespace.

### Supervise and inspect

```sh
koni supervise-run <run-id> --root .
koni retry-supervised-stage <run-id> <stage-id> --root .
koni --run <run-id> inspect --root .
koni --run <run-id> inspect --root . --ticket <ticket-id>
koni --run <run-id> cockpit . --json
```

Supervision advances at most a bounded, durable slice. It stops at questions,
approval, pauses, manual stages, external loops, or terminal failure. Call it
again from a scheduler if the TUI is not open.

### Merge a completed run

```sh
# Read-only preview of drift, checkout cleanliness, tickets, and blockers.
koni merge-run <run-id> --root . --preview

# Persist operator authorization for this exact run and target state.
koni merge-run <run-id> --root .
```

The TUI exposes the same flow with `m` on the selected run. Authorization does
not bypass checks: promotion still compares the expected target head, requires
a clean target checkout, and advances the target only to the sealed run head.
If the target moved, Köni returns to target sync. If sync conflicts, the
compiler creates the profile's integration-resolution ticket instead of
leaving either worktree in a conflicted Git state.

### Questions

```sh
koni --run <run-id> answer-question <question-id> \
  --option <option-id> --notes "Optional context for this choice" --root .

koni --run <run-id> answer-question <question-id> \
  --custom "A project-specific answer" --root .

koni --run <run-id> resolve-questions --root .
```

Exactly one option or custom answer is accepted. Notes may supplement a selected
option without replacing its structured ID. In the TUI, `←`/`→` or `[`/`]` switches
questions, `↑`/`↓` or `j`/`k` selects an option, and Enter opens the same decision view
shown in the Questions panel. `resolve-questions` performs an explicit tick for
due non-pausing defaults; there is no hidden background timer.

### Lifecycle controls

```sh
koni pause-run <run-id> --root .
koni play-run <run-id> --root .

# Read-only ownership and blocker preview.
koni delete-run <run-id> --root . --preview

# Safe default: preserve committed branches.
koni delete-run <run-id> --root .

# Stronger, ownership-checked removal.
koni delete-run <run-id> --root . --delete-owned-branches
```

### Validate and report

```sh
koni validate-profile .
koni --run <run-id> validate --root .
koni --run <run-id> report --root .
koni new-id --count 3
```

Profile validation compiles configuration only. Run validation inspects current
semantic and control state without deriving work.

### Advanced engine commands

The CLI also exposes low-level ticket and integration operations for automation
and profile development:

- `compile`, `start`, `context`, `output`, `review`, and `finish`;
- `spawn-lead`, `lead-next`, `yield-lead`, `spawn-worker`, and
  `wait-worker`;
- `action` for a configured lifecycle recipe;
- `drive-stage` for manual/checkpoint stages;
- `start-external-loop` and `drive-external-loop`;
- `recover`, `rollback --dry-run`, and `migrate`.

These commands still enforce the selected run snapshot, action effects,
receipts, and Git ownership. They are not escape hatches around the engine.
Run `koni <command> --help` for exact arguments.

> **Automatic-wait refinement — 2026-07-15:** `wait-worker` remains listed for explicit profile
> development and compatibility. The normal cockpit/supervisor path does not spend a Lead-model
> turn on this deterministic poll: it shows the run waiting while process supervision remains
> compiler-owned, then invokes the Lead only for the next meaningful orchestration decision.

## Pi runtime controls (schema 2 candidate, 2026-07-14)

The current control plane talks to the pinned Pi SDK host directly; it does not shell out to the
Codex CLI for model discovery or production agent turns. The TUI Configure model picker reads the
same contained Pi registry and falls back only to its compiled display catalog when the packaged
runtime is unavailable.

```sh
# Token-free provider/runtime inspection.
koni models
koni models --json
koni auth status
koni auth status --json

# ChatGPT-subscription OAuth; no API-key mode exists.
koni auth login
koni auth logout

# Explicit schema-1 inspection and one-way migration.
koni migrate-pi --root . --dry-run
koni migrate-pi --root . --apply
```

Login uses device authorization and prints only the verification URI/code. Access and refresh
credentials stay on the private fd-3 channel and in the OS keychain; public JSON never includes
them. `migrate-pi --apply` recompiles staged schema 2, archives active Codex-backed runs, and never
falls back to Codex if Pi startup fails.

## Projection failures

UI and JSON projections fail closed. If one run has malformed records, its row
remains visible with a validation error while other runs continue rendering.
The selected run's detail view shows the diagnostic. JSON returns the load
error rather than substituting empty questions, stages, agents, or tickets.
