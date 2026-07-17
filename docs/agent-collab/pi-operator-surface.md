# Pi operator surface coordination

Owner: `pi_operator_surface/root`

Status: implementation complete on branch `pi-native-port`; lease ready to release.

## Lease

- Own `packages/core/src/{extension,cli,index}.ts`.
- Own new modules under `packages/core/src/operator/` and focused operator tests/docs.
- Consume, but do not edit, compiler/run-engine/session internals.
- Add only control-center host glue; the shared controller/component remain the presentation source.
- Never open cmux, tmux, another terminal, or launch a TUI except in direct response to
  `koni tui` or the user-invoked Pi `/koni` command.
- Never read or modify Pi credentials, settings, packages, prompts, skills, or ambient resources.
- Never touch a live project, installed binary, or running Koni process while implementing/tests.

## Decisions

### 2026-07-16 — operator boundary

Both operator surfaces are clients of the one authority leased per Git common directory. A
project's authenticated profile package is copied into a hash-addressed cache under that Git
authority root before the daemon starts. This lets recovery validate the exact package baseline
without treating editable `.koni` metadata as trust and without depending on mutable package paths.

The installed Pi extension is inert until a user invokes `/koni`: registration adds only the
command and a profile-descriptor event listener. It does not register model tools, alter the active
tool set, inspect auth, load ambient resources, or start background processes at session startup.

## Mailbox

Leave operator/authority/profile-resolution overlap questions below rather than editing leased
files.

## 2026-07-16 — implementation handoff

The Pi-native operator layer is complete:

- `/koni` mounts the existing shared `ControlCenterController` and `ControlCenterComponent` through
  Pi 0.80.10's public `registerCommand` and `ctx.ui.custom` APIs. Subcommands expose guided new-run
  intake plus status, config validation, profile init/update, and explicit authority startup.
- `koni tui [--root]` mounts the same component in the invoking terminal. The CLI also provides
  provider-free `init`, `update`, `start`, `status`, `config validate`, and revisioned `run` commands.
- The first invoked client connects to the single authority lease for the Git common directory or
  starts a detached authority daemon. Later Pi/CLI/TUI clients connect to that same endpoint.
- Verified profile packages are copied to a bundle-hash-addressed cache under the Git authority
  root before installation or daemon startup. Recovery therefore has immutable package authority;
  project configuration remains an editable overlay and Pi's own files remain untouched.
- The internal daemon writes only a repository-scoped authority log and survives UI exit.
  Signal shutdown disposes managed sessions and releases the authority lease. No terminal manager
  or pane API exists in the implementation.

Evidence:

- focused operator tests: **5/5**;
- Core strict TypeScript: green;
- Core production build: green;
- whitespace validation: green;
- npm package dry run includes the CLI, extension, operator modules, control center, and attempt
  process entry;
- disposable Git project smoke: profile init, effective config compile, stopped status, detached
  authority startup, connected running status, explicit SIGTERM, and zero leftover process.

Final lease-release rerun kept the focused operator suite **5/5** and scoped whitespace clean. Core
typecheck/build had already passed with this operator tree, but the simultaneous final rerun met
the separately leased, syntactically incomplete `src/git/lifecycle.ts` (`TS1005` at line 538).
That owner and the root integrator were notified; broad verification should be repeated after the
Git lifecycle lane completes rather than editing or reverting its work here.

Remaining UI work is intentionally outside this lease: New Run/config/plan-review/chat modal
parity belongs to the control-center parity lane. This operator layer already consumes
`project.status`, `branches.list`, `run.list`, `run.graph`, `run.transcript`, and the controller's
existing revisioned mutations; the parity lane can add presentation without changing bootstrap.
