# `@koni/core`

`@koni/core` is Koni's single authoritative Pi extension package. It owns the typed profile and
graph compiler, durable workflow state, ticket scheduling, grants, receipts, Git effects, native
Pi integration, and the shared control-center view model.

Coding and research behavior are supplied by separately versioned profile packages. Those
packages can describe resources, but they cannot authorize effects or mutate Koni state.

## Operator surfaces

Inside Pi, invoke `/koni` to open the control center. The extension does no startup work before
that command and leaves Pi's credentials, providers, settings, tools, skills, prompts, and other
packages unchanged.

The same control center is available explicitly from a shell:

```sh
koni init coding
koni tui
```

Useful noninteractive commands are `koni status`, `koni config validate`, `koni update`, and
`koni run --goal "…" --type small --target main`. `koni tui` renders only in the terminal where it
is invoked; Koni never opens a pane or another terminal.

The launcher follows ordinary npm, pnpm, bun, yarn, and direct/symlinked `pi` installations and
reuses that runtime's bundled SDK peers. If a version manager exposes only an opaque wrapper, set
`KONI_PI_PACKAGE_ROOT` to the verified `@earendil-works/pi-coding-agent` package directory; Koni
still validates its package identity and exact supported version before importing anything. It
never falls back to a Pi copy nested beneath Koni.

## Native Pi resources

Installing this package through Pi also publishes the general `configure-koni`,
`model-koni-work`, and `operate-koni` skills. They are ordinary interactive Pi resources and do
not replace or rewrite a user's other packages, skills, prompts, settings, or credentials.

Contained autonomous attempts use a stricter path: Core selects exact profile resources, copies
their bytes into the immutable run artifact, and includes their hashes in each launch
specification. Ambient user and project resources are never inherited by an attempt merely
because they are available in the operator's Pi session.
