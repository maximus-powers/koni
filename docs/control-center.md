# Control center and CLI

Type `/koni` inside an ordinary Pi session, or explicitly run `koni tui [--root <path>]` in the
terminal that should host the standalone control center. Both mount the same TypeScript component
and controller over the same durable authority state. Koni never opens cmux, tmux, a pane, or
another terminal.

```sh
cd my-project
koni tui --root .

# Or, inside Pi:
# /koni
```

The extension is inert until a Koni command. Loading it does not authenticate, inspect credentials,
start an authority, mutate Pi settings or resources, or stop Pi. Globally installed packages remain
passive outside initialized repositories. Inert means no passive authority start, recovery, provider
request, model load, or durable effect.

`/koni init` enters guided Configure. It can collect and present initialization choices, but stays
at the explicit approval boundary and creates no run, authority run state, or provider attempt.

In a trusted initialized project, Pi TUI sessions attach a bounded read-only background-run widget
even when the authority is stopped and there are no runs. With runs present, the widget gives each
ongoing run its own line — planner-authored short name, phase glyph, stage, ticket progress, and
attention badges — ordered stuck-first and bounded to three rows plus a `+N more` hint, so the chat
stays a usable textual interface for Koni work. The one-slot status text summarizes fleet shape
(`Koni 2⚙ 1Ⅱ !1`). `/koni-run` owns guided creation. `/koni-runs` owns the compact actionable
overlay. Both stay separate from autonomous-agent steering and from the full `/koni` dashboard.

Inside Pi the mounted dashboard reserves one row for Pi's footer so its top border is never pushed
off-screen; operators with taller footer or status-line extensions can widen the reserve with
`KONI_COCKPIT_RESERVED_ROWS`.

Duplicate Core origins produce a warning and disable only Koni commands. Ordinary Pi stays available
while the operator removes one source and reloads.

The minimum interactive layout is 82 columns by 20 rows. Click to focus a panel. The mouse wheel
scrolls the panel beneath the pointer.

Control hints follow one placement rule throughout the control center. They live on the bottom edge
of their modal or panel, or in the global contextual footer for the focused panel. Titles identify
the surface, while body content is reserved for project state, choices, and explanations.

## Operate

Operate is the default view:

| Surface         | Contents                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------- |
| Runs            | Filter tabs over every run: Active by default, with Attention, Paused, Done, and All one arrow away |
| Tickets         | The selected run's compiled board, filtered by lifecycle state                                      |
| Agents          | Live model work followed by durable agent history                                                   |
| Recent Activity | Timestamped graph changes and compiler lifecycle work, closing out the left column                  |
| Details         | The `Graph` live feed (default), the phase-aware `Plan`, and `Overview` with pipeline stages        |
| Questions       | Appears under Details only while the selected run needs a decision                                  |

The Runs panel opens on its Active tab, so paused, blocked, and concluded runs stop crowding the
working set. `←`/`→` cycles the filter, tab counts stay visible, and the committed selection stays
pinned in the list even when a lifecycle change (for example pausing it) moves it out of the active
filter. Filtering never mutates a run.

Selecting another run replaces all dependent panels as one projection. It does not pause, mutate, or
hide the previously selected run.

Every run means the navigable product inventory, not eager in-memory materialization. The Runs panel
retains at most one compact 200-row, revision-bound window. Arrowing past a window edge follows an
opaque adjacent cursor. Ordinary refresh asks for one page beginning at the selected durable run,
then hydrates only that run with exact authority and run revisions. The title exposes the visible
ordinal range and the total. Global first and last arrows clamp. Provisional intake rows stay
immediate. Neither a compact row nor its readiness badges authorize a mutation.

The left column keeps one third of the terminal width for Runs, Tickets, Agents, and Activity; the
remaining two thirds are one tall Details section. The left-aligned Details title exposes all of its
tabs on one line as `Details: Graph - Plan - Overview`. The active tab is white and the inactive
tabs are light grey. Graph is the default tab and stays up while arrowing through runs; committing a
run or a ticket with `Enter` or a click switches to Overview. Run Overview is one vertically
scrollable document: Objective first, followed by Run and Evidence. Its collapsed Objective preview
uses four lines. Focusing it makes the complete wrapped Objective reachable without switching to a
nested mini-view.

The Run section renders as labeled components rather than plain key/value text: a status chip toned
by lifecycle phase, the target branch, ticket and cache meters, live agent and token counters, and
the operator-retired exposure line when it exists. Evidence keeps its exact operator copy behind a
tone glyph per line, and the Stages heading carries a compact dot rail with a done counter above the
numbered stage list.

### Blockers

Ticket Overview shows the first useful typed, durable `Blocker.message` in array order. A durable
display candidate is an object row with string `kind`, `message`, and `created_at`. Generic,
placeholder-only, raw structured, and malformed or untyped messages are suppressed. Known run,
ticket, stage, agent, graph, question, and action identifiers become fixed operator-facing phrases.
Unknown identifiers, paths, hashes, embedded raw records, and control characters are redacted.

The reason hard-wraps without truncation by Unicode terminal display width. `+N more` counts every
other typed durable blocker record, including a record whose message was suppressed. If no useful
reason survives, Ticket Overview keeps the count-only disclosure. That count remains the fail-closed
fallback, because malformed, raw, or placeholder-only data must never be promoted into an invented
explanation.

### Evidence

Evidence is trivalent. Recorded issues, failed or blocked run or pipeline state, a blocked ticket,
and a failed current review produce red **Attention**. Those take precedence over positive evidence.

Green **Evidence recorded** appears only when every monitored telemetry channel is explicitly
present and zero, and Köni also has one durable positive basis. A qualifying basis is current ticket
output, current compiler `review_status=passed` with no configured review step pending, succeeded
verification output, or succeeded final-report output. Both compact and expanded Evidence name which
basis was recorded. The UI never substitutes a generic **HEALTHY** badge, because absence of
recorded issues is neutral rather than green.

Complete telemetry includes a stages array and a fully shaped compiler `ticket_workflows` row for
every ticket. A stale historical review pass is not current proof. Without a qualifying positive
basis, the neutral state is muted **No recorded issues** with **Evidence pending**. A configured
report view without succeeded final-report output says **No final report yet**. Its configuration
alone is not evidence that the run is ready.

### Plan and activity

Plan changes with the run phase. Before approval it shows the quiet planning activity stream. After
approval it shows the approved human-readable plan artifacts as wrapped, vertically scrollable
Markdown, so the execution contract stays reviewable while work proceeds. Every Recent Activity row
begins with a compact timestamp.

Recent Activity includes runtime only for a selected run that is neither planning nor provisional.
That run must also have a parseable durable `active_runtime_approved_at` anchor and a numeric
lifecycle active duration. An approved numeric zero remains **0s active**. Without a selected run,
the panel prompts the operator to select one. It does not invent runtime.

The panel title uses its actual bordered Unicode display-width budget. It shows the full
`Recent activity · 1h 02m active` when that fits. It shows the exact compact `Activity · 1h02m` at
the 82x24 dashboard minimum. It falls back to identity-only `Activity` when an extreme exact
duration cannot fit. Every significant unit and anchored `0s` is preserved. The title omits an
overlong suffix instead of clipping, clamping, or approximating it.

### Graph live feed

The Graph tab is the run's live feed: the typed context graph on the left, the active tickets
exploring it in a column of cards on the right, and the agents working each ticket nested inside its
card — persona, catalog model name, thinking level, and provider-total tokens, with an animated gear
only while an attempt is actually running. Connector lanes in the shared gutter wire every in-flight
ticket (running or review) to the exact nodes it targets or writes; read context joins the focus
highlight but never gets a lane. Queued work is a count under the cards, not a card, and a blocked
run keeps its interrupted tickets visible with a warning bar instead of letting the feed go blank.
The projection is always run-wide: committing a ticket narrows nothing — it highlights.

Primary relationships form the nested outline; secondary relationships travel labeled vertical lanes
inside the graph column, turning with clean corner glyphs (`╮`, `╯`) instead of stamping a crossing
at every joint. `←`/`→` moves the feed's focus between the graph column and the ticket cards, and
`↑`/`↓` moves the cursor within the focused column. Focusing a node or a ticket lights up its whole
neighborhood — nodes, edges, lanes, and cards adopt the accent tone — while every unrelated node
title, marker, card, and lane drops to the dim tier, so the focus's local topology reads at a
glance. `[` and `]` still switch the details tabs from anywhere in the feed.

`Enter` on a focused node opens its card: the complete title, a status chip, the node's authored
spec facts (scalars and scalar lists as operator-safe text; nested structures reduce to a size
note), and every relationship in this view with direction arrows and title-resolved endpoints. Raw
node identifiers never render. `Enter` on a focused ticket card commits that ticket, exactly like
the Tickets panel.

### Contextual help

`h` opens documentation for the focused surface, not just a key list: what the surface is, a
repository-docs-style text diagram of how it fits the run pipeline, why it behaves the way it does,
and then the available keys. Long topics scroll with `↑`/`↓`.

### Agent activity and tokens

An animated cog means a model is starting, running, or resuming and may be spending tokens. A quiet
circle means the run is waiting for approval, input, manual progress, or retry. A session waiting on
a question, or holding an accepted terminal result, stays part of the live attempt lifecycle. It
does not animate the Runs cog. Only queued and running attempts that can presently issue another
provider request count as working in that row.

The header, Runs rows, and Overview headline report `new_tokens`, which is uncached input plus
output. Cache reads therefore do not inflate the primary work measure. The header and Runs row
render `250K new tks` rather than an unlabeled abbreviation, so the cache-excluding meaning is
visible without opening Overview. Overview keeps the full uncached input, output, reasoning,
cached-input, and provider-total breakdown as separately labeled secondary telemetry. A planning
allowance follows its configured metric and says `processed` when that metric includes cache reads.
For a continuous planning run, the planner row and Plan view distinguish cumulative totals from the
current revision's baseline-relative usage.

The durable source covers every compiler-owned runtime path. The run scan recursively admits only
agent `stdout.jsonl` and resume logs, legacy `worker.log`, and validated
`worker.<agent-id>.attempt-<positive-n>.log` files. One shared normalizer serves both planning
budgets and cockpit snapshots. For each durable Pi turn it counts committed compatibility usage,
otherwise an exact checkpoint or legacy terminal, otherwise summed pre-terminal deltas. A delta-only
failed or timed-out turn contributes spent tokens without claiming completion. Cached input is
removed exactly once from `new_tokens`, and provider total stays the cache-inclusive secondary
figure.

The normalizer also accepts the older compiler-owned Pi envelope whose `type` key is absent,
including delta-only interrupted turns, while rejecting explicit null and unknown types.
Higher-precedence usage with impossible cache, output, or reasoning buckets is ineligible rather
than saturating to an understated headline. That turn then falls through to its next valid durable
source. Provider total may legitimately exceed Pi's visible buckets, so that safe surplus stays
counted.

Rows are projected from durable Pi message, tool, retry, compaction, usage, and terminal events.
Turns recorded by the pre-Pi-native Codex CLI runtime remain historical-reader input only and never
provide an execution fallback.

### Chat and history

Chat reads the compiler-owned per-agent artifact and renders the complete prompt, assistant and
reasoning messages, compiler tool inputs and results, usage, and fixed failures. Raw transport
envelopes are suppressed. All Pi paths write one canonical compiler-owned record shape, and the
reader also recognizes the older direct envelope. Already-running and completed agents therefore
regain their full reasoning, assistant messages, tool calls, and tool results after a cockpit
upgrade. Intermediate usage checkpoints stay accounting transport rather than chat rows, so the
terminal total stays visible without flooding the conversation. Unexecuted calls from a terminal
tool batch render as muted `Skipped` rows rather than an active cog.

The control center retains one snapshot-bound window of at most 64 semantic blocks for each of four
recently viewed agents. It does not eagerly accumulate. `[` and Left move to the exact adjacent
older window. `]` and Right return through exact adjacent newer windows. Page Up and Page Down
scroll only the current window, and `r` reloads the current live head. Live appends leave an
operator's cursor-pinned older window in place. Session identity, terminal entry, snapshot hash and
count, total, and ordinals all stay stable across navigation.

Assistant and reasoning text, calls and results, compaction, and branch markers stay semantic. A
text item above 64 KiB becomes ordered lossless parts whose safe text reconstructs exactly across
pages. Terminal protocols and invisible direction controls are the only stripped or replaced display
bytes, and canonical Pi JSONL is unchanged. Image-only and mixed user or tool-result content retains
its authored order as type-and-decoded-size attachment rows without exposing base64. Agent switches
preserve recent windows. Stale responses cannot replace the selected run or session. Composer drafts
are run-scoped, and `Esc` closes composition before leaving Chat.

### Main keys

| Key                    | Effect                                                                           |
| ---------------------- | -------------------------------------------------------------------------------- |
| `q`                    | Save valid configuration drafts, then quit                                       |
| `r`                    | Refresh                                                                          |
| `Tab` / `Shift-Tab`    | Move focus through visible panels                                                |
| `1` … `5`              | Focus Runs, Tickets, Agents, Details, or Activity when unclaimed by the profile  |
| `6`                    | Jump to the Details panel's Graph feed                                           |
| `↑` / `↓` or `j` / `k` | Move or scroll in the focused surface                                            |
| `PageUp` / `PageDown`  | Scroll by a page                                                                 |
| `←` / `→`              | Change the active tab or question; on the Graph feed, switch graph/tickets focus |
| `[` / `]`              | Change the active tab everywhere, including the Graph feed                       |
| `h`                    | Open help for the focused panel                                                  |
| `F1`                   | Open help while a text editor needs literal `h` input                            |
| `n`                    | Open New run                                                                     |
| `a`                    | Open configured actions for the current selection                                |
| `c`                    | Switch between Operate and Configure                                             |
| `?`                    | Answer the selected pending question                                             |
| `Space` on Runs        | Pause or resume the selected run                                                 |
| `m` on Runs            | Review and authorize a ready run's merge into its target branch                  |
| `v`                    | Open the selected planning run's review whenever approval is ready               |
| `d` on Runs            | Open run-deletion choices                                                        |
| `Enter`                | Activate the focused, explicit action                                            |

Ordinary contextual actions use lowercase keys, and approval and promotion stay distinct actions.
Profiles may add orchestration keybindings. Protected panel keys win, and the footer and contextual
help show only reachable bindings.

### New run

Press `n` to open the run form. It contains:

- the Objective and profile-defined intake fields
- selectable complete run-type peers
- a target branch selected from recent user-owned local branches
- the ordered pipeline, including skipped stages
- question behavior
- maximum parallel agents
- model and reasoning selectors for Planner, Lead, Worker, and Reviewer

`Objective` is the visible product term everywhere in the TUI. `goal` remains only the compatible
CLI flag name.

Selectable models come from a fresh offline Pi `ModelRuntime` using your normal Pi credentials,
`models.json`, and cached model inventory. That is the same substrate a contained attempt
constructs. Whichever providers you authenticated in Pi are the providers you can select here:
Anthropic Claude, OpenAI Codex, and any other Pi provider appear on equal terms. In `/koni`, models
supplied only by another ambient extension appear as unavailable diagnostics rather than selectable
entries. Koni does not copy that extension's provider functions into autonomous sessions. Standalone
`koni tui` applies the same executable-catalog rule.

When the profile's declared role model is not executable under your credentials, the form opens on
an authenticated model instead and shows which selections were substituted. `koni run` performs the
same substitution and prints the same notice. You can still cycle any role to any executable model
before starting. When Pi can execute nothing, the configured value stays visible and Start refuses
with Pi's exact reason.

Changing run type refreshes its effective defaults. Edits in this dialog are one-run overrides. They
do not mutate the reusable run type. The base commit, configuration files, effective role policy,
and overrides are pinned when planning begins.

The stage flow is complete rather than sampled. When it does not fit, it scrolls. Every configured
stage, including wrapped stage names, stays reachable alongside the rest of the form and its
controls.

Enter on an ordinary field edits it. Work is submitted only by focusing and activating the bottom
**Start Planning** or **Start Work** button. A synchronous validation error keeps the form and its
content open. Activation inserts a provisional Runs row immediately, before planning begins or a
durable snapshot exists. Refresh retains that feedback. The row is then reconciled with the
compiler-assigned identity, or removed with a visible submission failure.

The destination branch is an explicit operator choice, and its exact head becomes the run base. Both
are pinned when planning begins. Planning uses a detached worktree at that pinned target head. The
permanent run branch and run worktree are created only after explicit plan approval. Agents never
work in the target checkout. The run row keeps showing the destination branch and adds a
ready-to-merge indicator only after the configured work and verification boundaries are satisfied.
Target promotion stays behind the separate `m` review flow.

Selectors consistently accept both arrow keys and their keyboard aliases: `↑`/`↓` or `j`/`k`
vertically, and `←`/`→` or `[`/`]` horizontally. Literal text inputs keep printable `j`, `k`, `[`,
and `]` characters available for typing.

### Planning and approval

Planning agents run in a detached read-only worktree through a structured output boundary. Their
durable activity appears in the Plan tab of Details. A valid question pauses the originating stage,
appears in Questions, and resumes the same authenticated planning session and revision after an
answer. The live provider process may be absent while the run waits; the stable attempt, Pi session
file, cumulative transcript, usage, evidence, and repository discovery remain durable.

Review Plan is an informed review surface, not a confirmation prompt. It shows the complete
human-readable plan as wrapped, vertically scrollable Markdown, and all plan content stays
reachable. The modal opens once when the selected run first becomes ready, and it stays available
with `v`. Browse with the tab and scroll keys. Enter while browsing cannot approve.

The modal title is exactly **Review plan**. It names the inspection state without presuming which
authority-crossing action the operator will choose. Its bottom-edge help is exactly
`←→/[] sections · ↑↓/jk/PgUp/PgDn scroll · Tab focus · Enter · Esc`. That matches the existing
section, scrolling, focus, activation, and dismissal handlers at compact width.

**Review plan** uses the planning agent's separately authored, concise heading-and-description
objects, so approval is fast to skim. It never derives headings by truncating the execution prose.
The complete current planning artifact stays unchanged for compilation and execution. Revision 0 is
a complete artifact; later revisions are patches against the latest validated artifact. Each
validated result is retained as an immutable checkpoint. The Plan view labels the current **Revision
N**, shows current-revision and cumulative token totals, and keeps the same bounded and redacted
Graph Seed.

When planning produced a Graph Seed, Review Plan conditionally appends a **Graph Seed** section
after Architecture, Risk, and Verification. It starts with the total root fact, semantic-node, and
relationship counts. It then shows at most six safe top-level root facts, twelve semantic nodes by
type, title, and authored purpose, and sixteen title-resolved relationships. Explicit omitted counts
disclose the remainder. At 82x24, vertical scrolling keeps the complete bounded section reachable.
Profiles and runs without a Graph Seed retain the same three plan sections.

The projection never renders local keys, IDs, hashes, paths, structured or raw spec and schema
payloads, or storage metadata.

The action row has one primary action. With no steering text it reads **Approve run** and crosses
the approval boundary. As soon as the multiline steering editor contains text, the same action reads
**Revise plan** and sends those requested changes instead. Enter adds a line in the editor, while
`Ctrl-Enter` invokes the adaptive action directly. Revision steering is stored durably, reopens the
same authenticated planning session, resets only the new revision's token allowance, patches the
current compiler-valid plan, and presents the review again. The prior checkpoint remains immutable
and superseded. Compiler failures stay correctable within the current revision and do not reset its
budget. The activity stream says **Planning session continued**, and planner history remains one row
with revision checkpoints rather than one row per revision.

Approval binds the exact latest validated checkpoint. Runs without a `planningSession` marker keep
their existing multi-attempt review and revise presentation; the control center does not coalesce or
rewrite their historical attempt lineage.

Approval is disabled while required planning passes or questions are incomplete.

Pending questions render in authored batch order with recommendations, saved and revised state,
optional notes, explicit advance, and one final Resolve boundary. Saving an answer does not silently
resume execution. Agents and Chat project authenticated Pi attempt lineage as semantic retry,
rework, review, recovery, and integration relationships. Opaque attempt and session identities are
retained for authority but are not operator copy.

### Pause, resume, and delete

Space on the selected run closes or opens its scheduler gate. Pausing is a graceful drain. No new
work is dispatched, while work already beyond a safe boundary may finish. Planning processes resume
from their captured Pi session where possible. Otherwise Köni explains that the pass will restart.

Deletion always requires confirmation. To identify the selected run without letting an unbounded
prompt dominate the dialog, the confirmation shows only a truncated Objective preview. The safe
default removes runtime state and owned worktrees while preserving committed branches. Deleting
proven Köni-owned branches is a separate choice. Live agents, dirty worktrees, unproven ownership,
and mismatched process identity all block deletion.

### Merge a completed run

Press `m` on the selected run to review and authorize promotion into its target branch.
Authorization does not bypass checks. Promotion still compares the expected target head, requires a
clean target checkout, and advances the target only to the sealed run head. If the target moved,
Köni returns to target sync. If sync conflicts, the compiler creates the profile's
integration-resolution ticket rather than leaving either worktree in a conflicted Git state.

### Actions and stages

The control center presents current compiler-authored stage and run actions through an Actions
palette and typed forms. Disabled actions stay visible with authority-authored reasons. Submissions
round-trip the opaque capability identity, the exact run revision and generation, typed values,
locked compiler context, and explicit destructive confirmation. Labels never become authority.

The Stages view shows the same catalog. A pipeline stage may be automatic, operator-driven, or
intentionally have no interaction, and the UI never invents a command.

Supervision advances at most a bounded, durable slice. It stops at questions, approval, pauses,
manual stages, external loops, or terminal failure. The supervisor does not spend a Lead-model turn
on a deterministic poll. It shows the run waiting while process supervision stays compiler-owned,
then invokes the Lead only for the next meaningful orchestration decision.

## Configure

Press `c` to edit the project contract. Configure groups resources by intent:

- Project
- Run Types, including role models, reasoning, questions, stages, and parallelism
- Agents, covering provider-neutral instructions, model, `thinking_level`, capabilities, and skills
- Workflows and Tickets
- Graph Model and Rules
- Actions and Checks
- Reports and Views
- Advanced

Guided forms expose common typed settings. Agent cards keep instructions, model, reasoning, sandbox,
permissions, and skills together. The guided editor exposes the provider-neutral `.koni/agents`
contract and keeps run-type overrides in Run Types. Advanced provides contained YAML and Markdown
editing plus explicit create, rename, and delete operations.

All edits enter one restartable draft set. `Ctrl-S` saves that set without publishing it. `Ctrl-P`
validates the complete catalog, profile, agents, and referenced skills before publishing the set.
`Ctrl-D` discards the entire unpublished set and reloads the published configuration. A validation
failure leaves the active configuration unchanged and retains the draft for correction.

Press `r` in Configure to open Project Resources, an expert screen organized as Domains, then
Resources, then Source Editor. It lists and reads only authority-owned configuration documents,
never filesystem paths. Raw saves, New, Rename, Delete, and the Run Type wizard all use exact
catalog, source, template, and preview tokens. They also use the global authority revision and
idempotency boundary. Dirty source cannot be abandoned, used as the base for another operation, or
discarded by closing Koni. Run types are cloned only from currently compiler-valid templates.

Renames do not guess at cross-document reference updates. Stage every required reference change in
the same draft. Published edits affect future runs only. Approved and planning runs retain their
snapshots.

The installed `configure-koni` and `model-koni-work` skills are usually the fastest way to make
substantial changes. Use Configure to inspect and refine the result.

## CLI workflow

The shipping command surface is `init`, `update`, `conflicts`, `start`, `stop`, `restart`, `status`,
`config validate`, `run`, `resume`, and `tui`.

### Project setup

```sh
koni init                           # Coding (default)
koni init research --root .          # optional Research profile
koni init coding --profile-package /path/to/reviewed-package
koni config validate --root .
koni update --root .
```

`koni update` performs an explicit three-way baseline and overlay upgrade. It accepts
`--preview <sha256> --apply` for a semantic-retirement preview.

### Conflicts

```sh
koni conflicts --root .
koni conflicts <path> --root . --keep-project
koni conflicts <path> --root . --accept-upstream
```

`koni conflicts` and Configure's **Open comparison** show the project and authenticated upstream
documents before **Keep project** or **Use update** is applied.

### Runs and authority

```sh
koni start --root .
koni status --root . --json
koni run --goal "Introduce an explicit cache invalidation boundary" --type medium --target main
koni run --goal "Prototype the new boundary" --target feature/cache --new-target --from main
koni resume --run <run-id> --root .
koni stop --root .
```

Available run types come from the project's compiled profile and configuration. `--new-target`
branches a not-yet-existing `--target` from `--from`, which defaults to the current branch. `resume`
restarts a paused run or retries a blocked run.

Run `koni <command> --help` for exact arguments.

## Projection failures

UI and JSON projections fail closed. If one run has malformed records, its row stays visible with a
validation error while other runs continue rendering. The selected run's detail view shows the
diagnostic. JSON returns the load error rather than substituting empty questions, stages, agents, or
tickets.

## Recovery and evidence behavior

Pi token-budget ceilings are durable contained-session aborts, not semantic review outcomes. The
operator-confirmed blocked-run recovery reopens only the exact failed assignment. It does so when
the abort is fully settled, terminal-effect-free, provider-accounted, and carries a canonical budget
reason. The palette presents one `Retry blocked work` entry even though the run and current-stage
capability catalogs both project the same `run.resume` authority.

Exhausted independent-review circuits disable generic Resume and expose only the exact
compiler-bound **Retry reviewed blocker** action. That action includes an optional multiline
recovery-steering field. Steering is bounded, durably recorded on the supervised rework, and
injected beside the immutable reviewer findings. It cannot alter the selected ticket, step, checks,
paths, or graph authority.

An accepted configured check whose allowed exit codes include a nonzero result returns bounded
authenticated stdout and stderr diagnostics to its assigned agent. Acceptance establishes the
exit-code envelope only. The author must verify that every reported failure is the intended product
red before submitting. Accepted all-green checks retain their compact receipt projection.

Managed Pi sessions already receive their exact immutable assignment and current dynamic graph
projection before every provider request. Autonomous agent inventories therefore do not expose the
redundant full `koni_context` read, which prevents duplicate context receipts from consuming review
budgets. Interactive Pi operators retain the context-inspection tool.
