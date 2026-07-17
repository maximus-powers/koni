# Pi community resource bindings

Status: implemented as profile-owned, opt-in policy in Coding 0.7.0 and Research 1.0.11.

This note records how Koni composes with an existing Pi setup. It does not replace the earlier
runtime migration history. Koni assumes the operator already uses Pi normally: authentication,
settings, installed packages, personal extensions, prompts, themes, and ambient skills remain
user-owned. Profile installation and upgrade never read, copy, edit, delete, enable, disable, or
install anything beneath `.pi`.

Pi packages may contain executable extensions, so neither package installation nor extension
loading is a harmless configuration read. Pi's documentation explicitly treats extensions and
packages as trusted code and explains that Pi itself is not a sandbox. Koni therefore represents
community integrations as inert project policy until the user independently installs a package
and explicitly enables a binding. See [Pi packages](https://pi.dev/docs/latest/packages),
[Pi skills](https://pi.dev/docs/latest/skills), and
[Pi security](https://pi.dev/docs/latest/security).

## Profile contract

Each official profile includes `resources/pi-packages.yaml` using
`koni.pi-resource-bindings.v1`. A binding names:

- the ordinary Pi package name;
- whether this project explicitly enabled it;
- the allowed integration mode (`skills_only`, `interactive_only`, `explicit_tools`, or
  `not_recommended`);
- the eligible resource kinds, workflow stages, and personas;
- whether it requires network authority; and
- the architectural reason for that boundary.

All bundled bindings default to `enabled: false`. Resolution joins enabled bindings to a caller-
supplied inventory of packages Pi already has. It returns enabled, unavailable, and disabled
sets; it has no installation effect. Contained attempts still receive only the exact resources
selected by the compiled ticket and bound into their immutable launch specification. Unrelated
ambient Pi resources never enter an autonomous attempt.

> **Executable compiler transition — 2026-07-16 (`community_resource_integration`):** The
> paragraph above originally described the intended resolver boundary. Current TypeScript Core
> now authenticates this catalog inside `CompiledConfiguration`, resolves only package roots and
> resource paths that Pi's ordinary package manager already knows about, and always answers Pi's
> missing-package callback with `skip`. It never calls install/update/remove, flushes settings, or
> imports an extension module. An enabled autonomous binding that is missing or unsafe now blocks
> run creation with a typed unavailable result instead of being silently omitted. Disabled and
> `interactive_only` bindings never cause an inventory read.

An enabled autonomous binding must add exact non-glob selectors:

```yaml
select:
  skills: [skills/review/SKILL.md]
  prompts: [prompts/review.md]
  tools: []
```

> **Guided-editor completion — 2026-07-16:** Every bundled binding now includes these three
> selector lists explicitly, initially empty. The Configure surface can therefore choose exact
> resources before switching `enabled` on; users do not need to hand-add hidden YAML keys. Empty
> selectors preserve the disabled default, and an autonomous binding still fails compilation if
> enabled without the exact resource or adapter required by its integration mode.

A selected `SKILL.md` pins its complete no-symlink, bounded UTF-8 closure; a prompt pins its exact
Markdown bytes. Those bytes, package identity, package-manifest hash, eligibility, and adapter
contracts are copied into the immutable run artifact. Eligible attempts then copy the selected
bytes into `AgentLaunchSpec.resources.entries`; `resources.setHash` and `specHash` cover them.
Package updates can therefore affect a future run but cannot mutate an issued run or attempt.

`explicit_tools` never means “load this package's extension.” Its `select.tools` values name
Koni-owned compatibility adapters. Each adapter identifies one existing authority-backed Koni
tool and its schema hash. A network adapter is accepted only through `koni_run_check` and only
when that exact attempt already has a compiler-issued networked configured-check grant. Core ships
no default adapter for the evaluated browser/web packages yet, so enabling those bindings fails
closed as unavailable; their arbitrary package APIs are not represented as safe merely because
the package is installed.

## Evaluated packages

| Package | Default Koni fit | Profile policy |
| --- | --- | --- |
| [pi-web-access](https://pi.dev/packages/pi-web-access) | Useful bounded web, repository, PDF, and source retrieval. Its network and credential behavior requires explicit authority. | Coding and Research `explicit_tools`; disabled; only selected planning/research stages with a network grant. |
| [context-mode](https://pi.dev/packages/context-mode) | Useful interactive context compression, but it must not rewrite compiler-bound context or Koni's authoritative compaction snapshot. | `interactive_only`; disabled; never loaded into contained attempts. |
| [pi-subagents](https://pi.dev/packages/pi-subagents) | Conflicts with Koni's deterministic ticket scheduler, grants, max-parallel policy, and receipts when used inside autonomous attempts. | `not_recommended`; cannot be enabled by the binding parser. It remains available for an operator's unrelated interactive Pi use. |
| [bigpowers](https://pi.dev/packages/bigpowers) | Some engineering skills and prompts may complement a coding ticket, while its independent lifecycle must not replace Koni's graph or workflow. | Coding `skills_only`; disabled; selectively eligible for planning, implementation, and review. |
| [@ff-labs/pi-fff](https://pi.dev/packages/@ff-labs/pi-fff) | Convenient interactive fuzzy search, but it replaces ambient search tools rather than honoring an attempt's exact tool/path grant. | Coding `interactive_only`; disabled; not supplied to contained attempts. |
| [pi-agent-browser-native](https://pi.dev/packages/pi-agent-browser-native) | Useful for browser-backed UI evidence, with meaningful network and external browser effects. | Coding `explicit_tools`; disabled; eligible only for an explicitly granted verification attempt. |
| [@companion-ai/feynman](https://pi.dev/packages/@companion-ai/feynman?name=research) | Selected research skills/prompts can help literature work, critique, and reporting. Its own agents, loop, credentials, and output authority must not replace Koni. | Research `skills_only`; disabled; selected skills/prompts only for eligible evidence/report tickets. |

This matrix is deliberately not a dependency list. A user's existing Pi package setup is
preserved, missing optional packages are reported rather than fetched, and installing any package
remains an ordinary user-controlled Pi action.

## Why profiles stay broad packages

Koni ships one `@koni/core` package containing the compiler, authority runtime, sessions, control
center, and lifecycle mechanisms, plus broad domain packages such as `@koni/coding-profile` and
`@koni/research-profile`. Run types, runtime adapters, and individual integrations are not split
into tiny packages. A profile package is a passive registrar plus one immutable complete baseline;
its project material is editable only after installation as a `.koni` overlay.

That boundary lets someone evolve a full software-engineering or research domain independently
without creating another workflow authority or forcing users to assemble many internal packages.
