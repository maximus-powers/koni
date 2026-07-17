# Control-center surfaces coordination

Owner: `control-center-surfaces/root`

Status: active on branch `pi-native-port`.

## Lease

- Own new/edited files under
  `packages/core/src/control-center/{controller,component,standalone,markdown,input}.ts`.
- Own focused offline tests for those modules.
- A small `packages/core/src/cli.ts` integration hook requires advance coordination with root.
- Consume `view-model.ts` as the semantic source; do not edit it in this lane.
- All mutations go through `AuthorityClient` RPC. The UI is never a workflow authority.
- Never open cmux, tmux, another terminal, or a TUI automatically.
- Do not touch live runs, installed binaries, Rust, manifests, credentials, or unrelated changes.

## Decisions and findings

### 2026-07-16 — audit before implementation

The lane will target the exact public `@earendil-works/pi-tui@0.80.10` component contract present
in the workspace, verify it from installed declarations/source, and keep rendering testable
without a terminal. One controller and one component tree will serve both Pi and standalone hosts;
host-specific lifecycle code remains a thin adapter.

### 2026-07-16 — shared surface implemented

The lane now provides five private Core modules:

- `controller.ts` is a revision-aware, event-refreshing `AuthorityClient` controller. It owns
  selection, focus, scroll, question drafts, confirmation/help state, and nothing authoritative.
  Pause/resume, deletion, manual merge, question answers, and later transcript steering cross
  revisioned RPC with unique idempotency keys.
- `component.ts` is the single Pi TUI `Component` used by both hosts. Wide terminals receive three
  peer columns whose widths differ by at most one cell; compact terminals devote the viewport to
  the focused panel. The middle column owns Details plus conditional Questions, and the right
  column owns Agents, timestamped Recent Activity, and the autoresearch-style relationship graph.
- `markdown.ts` adapts Pi's native Markdown renderer to either the active public Pi `Theme` or a
  standalone ANSI palette.
- `input.ts` translates the public Pi 0.80.10 key API into semantic actions, including rich
  question-option and multiline-notes editing.
- `standalone.ts` mounts the same controller/component in a `TUI`/`ProcessTerminal`, but only after
  the caller explicitly invokes `start()`. It never creates a pane or terminal.

Focused offline evidence is 6/6 surface tests plus the existing 4/4 view-model tests. Tests assert
exact line widths, equal 50/50/50 columns at 150 cells, conditional rich questions, full Markdown
plans, inactive Lead retention, cache-distinguished usage, timestamped activity, concise graph
labels over relationship lines, revisioned effects, and a standalone host that does not enter raw
mode before explicit start.

Two read projections remain integration dependencies rather than UI-owned filesystem reads:

1. `run.graph {runId, ticketId?}` — the controller feature-detects this read-only RPC and shows a
   clean empty graph until Core authority exposes it.
2. A canonical Pi session transcript projection for the selected attempt — the Chat tab keeps the
   selection binding but must receive complete native Pi messages from the authority/session lane,
   never lossy transport-event reconstruction.

Root still owns exporting these modules, registering Pi's `/koni` command with `ctx.ui.custom`, and
wiring `koni tui`; this lane did not edit `extension.ts`, `index.ts`, `cli.ts`, or manifests.

## Mailbox

Leave overlap questions and interface changes below rather than editing leased files.
