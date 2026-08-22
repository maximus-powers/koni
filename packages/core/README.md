# `@koni/core`

`@koni/core` is Koni's single authoritative Pi extension package. It owns the typed profile and
graph compiler, durable workflow state, ticket scheduling, grants, receipts, Git effects, native Pi
integration, and the shared control-center view model.

The supported development/runtime contract is Node `>=22.19`, Pi `0.80.10`, and TypeBox `1.1.38`.
The package reuses those Pi-owned SDK peers. It does not install a second Pi runtime.

Coding and research behavior are supplied by separately versioned profile packages. Those packages
can describe resources, but they cannot authorize effects or mutate Koni state.

## Operator surfaces

Inside Pi, invoke `/koni` to open the control center. Before that command, the extension only
registers inert Koni command/tool schemas and profile-discovery listeners. It does not authenticate,
read a project, start an authority, or mutate Pi. The read tools are `koni_project_status`,
`koni_run_status`, `koni_graph_context`, and `koni_ticket_context`. Credentials, providers,
settings, skills, prompts, and other packages remain unchanged.

> **Surface clarification: 2026-07-17:** The initial listener-only description predated these four
> read-tool schemas. Registration itself remains side-effect free. A tool invocation still requires
> Pi trust plus an already sealed project authority and never starts or resumes one automatically.

> **Transcript/status expansion: 2026-07-17:** The structured set now also includes
> `koni_agent_transcript`. `koni_run_status` v2 carries bounded recent activity, active work titles,
> and attention state. Transcript pages are available only for explicit requests for transcript,
> reasoning, or detailed historical activity. Those five status/context/transcript tools remain
> read-only and connect only to an already-running authority. `koni_proposal_inspect` separately
> reads one compiler-authored proposal and never records a decision. `koni_proposal_decide` is the
> sole mutating chat tool: it freshly inspects an actionable proposal, requires Pi's native TUI
> confirmation, and submits exactly one idempotency- and revision-CAS-bound approval or rejection.
> Cancellation or a stale revision records no decision and is never replayed automatically.

> **Background companion transition: 2026-07-17:** The listener-only wording above is retained as
> the original safety boundary, but the current TUI extension may attach a keyed read-only widget in
> an already trusted, initialized Koni project. That attach cannot start/recover an authority, load
> a model, or create work. `/koni-run` is the explicit guided start boundary, `/koni-runs` opens the
> focused status/decision overlay, and `/koni` still opens the full shared control center.

If Pi sees multiple Core origins, Koni emits a non-mutating warning and disables Koni commands until
one current source remains. Ordinary Pi commands and chat continue to work.

The same control center is available explicitly from a shell:

```sh
koni init
koni tui
```

After `pi install npm:@koni/core` and `pi install npm:@koni/coding-profile`, bare `koni init`
initializes Coding in the current Git project. Install `npm:@koni/research-profile` only when you
need Research, then use explicit `koni init research`. Globally installed packages are passive
outside initialized repositories: they create no project, run, authority, or provider attempt.
Inside Pi, `/koni init` immediately installs and validates Coding by default, then enters guided
Configure. Approval gates only Configure's later project-specific edits; no run is created.

Useful noninteractive commands are `koni status`, `koni config validate`, `koni update`, and
`koni run --goal "…" --type small --target main`. `koni tui` renders only in the terminal where it
is invoked. Koni never opens a pane or another terminal.

Koni refuses to overwrite an unmanaged `.koni` directory. Profile updates never overwrite a local
customization: `koni conflicts` and Configure's **Upstream changes** comparison show both documents
before the operator chooses **Keep project** or **Use update**.

The launcher follows ordinary npm, pnpm, bun, yarn, and direct/symlinked `pi` installations and
reuses that runtime's bundled SDK peers. If a version manager exposes only an opaque wrapper, set
`KONI_PI_PACKAGE_ROOT` to the verified `@earendil-works/pi-coding-agent` package directory. Koni
still validates its package identity and exact supported version before importing anything. It never
falls back to a Pi copy nested beneath Koni.

## Native Pi resources

Installing this package through Pi also publishes the general `configure-koni`, `model-koni-work`,
and `operate-koni` skills. They are ordinary interactive Pi resources and do not replace or rewrite
a user's other packages, skills, prompts, settings, or credentials.

Contained autonomous attempts use a stricter path: Core selects exact profile resources, copies
their bytes into the immutable run artifact, and includes their hashes in each launch specification.
Ambient user and project resources are never inherited by an attempt merely because they are
available in the operator's Pi session.

Each autonomous attempt owns one immutable, linear Pi session. Retry, rework, review, recovery, and
integration create new Koni-authorized lineage records rather than switching branches inside an
active attempt. Provider admission permits one request transport and configures zero automatic
provider retries. Ambiguous exposure remains durably reserved instead of being retried invisibly.

Same-scope retry, rework, and recovery lineage may also create a new Pi child session from the exact
authenticated parent conversation prefix. The child still has a fresh immutable launch spec, grant,
session identity, and usage ledger. Inherited Koni authority metadata is excluded. Initial attempts,
independent Review, and integration remain fresh roots, and contained sessions never expose mutable
Pi tree navigation.
