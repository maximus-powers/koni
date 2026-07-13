# Control center and CLI

Running `koni` with no subcommand opens the project control center. It
discovers the enclosing project root and combines `.codex/koni/` with native
Codex agents, settings, and skills.

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
| Details | Overview, durable planning activity, and pipeline stages |
| Questions | Appears only while the selected run needs a decision |
| Agents | Live model work followed by durable agent history |
| Project graph | The profile-defined typed hierarchy and relationships |

Selecting another run replaces all dependent panels as one projection. It does
not pause, mutate, or hide the previously selected run.

An animated cog means a model is starting, running, or resuming and may be
spending tokens. A quiet circle means the run is waiting for approval, input,
manual progress, or retry. Token totals are reconstructed from durable Codex
turn records rather than inferred from run status.

The minimum interactive layout is 82 columns by 20 rows. Click to focus a
panel; the mouse wheel scrolls the panel beneath the pointer.

### Main keys

| Key | Effect |
| --- | --- |
| `q` | Save valid configuration drafts, then quit |
| `r` | Refresh |
| `Tab` / `Shift-Tab` | Move focus through visible panels |
| `1` … `5` | Focus Runs, Tickets, Details, Agents, or Graph when unclaimed by the profile |
| `j` / `k`, arrows | Move or scroll in the focused surface |
| `PageUp` / `PageDown` | Scroll by a page |
| `[` / `]`, Left / Right | Change the active tab, detail view, or question |
| `h` | Open help for the focused panel |
| `F1` | Open help while a text editor needs literal `h` input |
| `n` | Open New run |
| `a` | Open configured actions for the current selection |
| `c` | Switch between Operate and Configure |
| `?` | Answer the selected pending question |
| `Space` on Runs | Pause or resume the selected run |
| `D` on Runs | Open run-deletion choices |
| `Enter` | Activate the focused, explicit action |

Profiles may add orchestration keybindings. Protected panel keys win, and the
footer and contextual help show only reachable bindings.

### New run

Press `n` to open the run form. It contains:

- the goal and profile-defined intake fields;
- selectable complete run-type peers;
- the ordered pipeline, including skipped stages;
- question behavior;
- maximum parallel agents;
- model and reasoning selectors for Planner, Lead, Worker, and Reviewer.

Changing run type refreshes its effective defaults. Edits in this dialog are
one-run overrides; they do not mutate the reusable run type. The base commit,
configuration files, effective role policy, and overrides are pinned when
planning begins.

Enter on an ordinary field edits it. Work is submitted only by focusing and
activating the bottom **Start Planning** or **Start Work** button. A synchronous
validation error keeps the form and its content open.

### Planning and approval

Planning agents run in a detached read-only worktree through a structured
output boundary. Their durable activity appears in Details. A valid question
pauses the originating stage, appears in Questions, and resumes the same Codex
session after an answer.

Approval is an informed review surface, not a confirmation prompt. It separates
resolved decisions, architecture, risks, and verification. Browse with the tab
and scroll keys; Enter while browsing cannot approve. Focus the explicit
**Approve run** action first.

Approval is disabled while required planning passes or questions are
incomplete.

### Pause, resume, and delete

Space on the selected run closes or opens its scheduler gate. Pausing is a
graceful drain: no new work is dispatched, while work already beyond a safe
boundary may finish. Planning processes are resumed from their captured Codex
session where possible; otherwise Köni explains that the pass will restart.

Deletion always requires confirmation. The safe default removes runtime state
and owned worktrees while preserving committed branches. Deleting proven
Köni-owned branches is a separate choice. Live agents, dirty worktrees,
unproven ownership, or mismatched process identity block deletion.

## Configure

Press `c` to edit the project contract. Configure groups resources by intent:

- Project
- Run Types
- Agents
- Workflows & Tickets
- Graph Model & Rules
- Actions & Checks
- Reports & Views
- Advanced

Guided forms expose common typed settings. Agent cards keep instructions,
model, reasoning, sandbox, permissions, and skills together. Advanced provides
contained YAML/Markdown editing and explicit create, rename, or delete
operations.

All edits enter one restartable draft set. `Ctrl-S` validates the complete
catalog, profile, native agents, and referenced skills before publishing the
set. A validation failure leaves the active configuration unchanged and
retains the draft for correction.

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

### Plan and approve

```sh
PLAN_JSON="$(koni plan-run \
  --root /path/to/project \
  --run-type medium \
  --base HEAD \
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

### Questions

```sh
koni --run <run-id> answer-question <question-id> \
  --option <option-id> --root .

koni --run <run-id> answer-question <question-id> \
  --custom "A project-specific answer" --root .

koni --run <run-id> resolve-questions --root .
```

Exactly one option or custom answer is accepted. `resolve-questions` performs
an explicit tick for due non-pausing defaults; there is no hidden background
timer.

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

## Projection failures

UI and JSON projections fail closed. If one run has malformed records, its row
remains visible with a validation error while other runs continue rendering.
The selected run's detail view shows the diagnostic. JSON returns the load
error rather than substituting empty questions, stages, agents, or tickets.
