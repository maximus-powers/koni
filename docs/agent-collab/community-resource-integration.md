# Pi community resource integration

Owner: `community_resource_integration/root`

Status: active

## Claimed scope

- `packages/core/src/profile/resource-bindings.ts`
- a narrowly scoped compiler module for safe installed-package resource projection
- the minimum `packages/core/src/compiler/run-program.ts` wiring required to pin the projection into immutable runs and attempts
- focused provider-free resource binding/compiler/launch tests
- append-only collaboration and transition notes

Excluded: control center, config surface, authority run engine, Git lifecycle, legacy migration,
report compiler, live projects, Pi homes/settings/credentials, installed packages, provider calls,
processes, terminal panes, and installed binaries.

## Contract

Koni never installs, enables, disables, imports, or mutates ordinary Pi packages or settings.
Interactive-only packages remain ordinary ambient operator resources and never enter contained
sessions. `not_recommended` bindings fail closed. `skills_only` may pin only exact declared text
skill/prompt files from an authenticated, already-installed package inventory. `explicit_tools`
may expose only exact Koni-authority-backed tool bindings with an explicit compatibility mapping
and the compiler's network grant; it never executes or imports a package extension. Package APIs
that cannot be projected without executing package code are reported unavailable.

Every selected byte and tool compatibility contract is copied into the immutable per-run pinned
artifact, then hashed again in each launch spec. Later package upgrades cannot change an issued
attempt. Unselected ambient resources never enter the pin or the autonomous `ResourceLoader`.

## Coordination

The primary integrator was notified before the narrow `run-program.ts` seam is edited. This lane
will preserve concurrent report imports and will not modify the authority engine.

## Completion handoff — 2026-07-16 20:10 MST

The executable boundary is complete. The effective authenticated profile may compile
`resources/pi-packages.yaml` into `pi_resource_bindings`, but Koni consults Pi's package manager
only when an enabled autonomous binding actually exists. Discovery uses Pi's existing settings
and package resolution in read-only `skip` mode: it never installs, updates, removes, enables,
disables, or imports a package. `interactive_only` stays ambient to the operator and does not even
trigger autonomous inventory discovery; `not_recommended` is rejected.

`skills_only` accepts only exact declared Pi-resolved skill or prompt paths. Koni snapshots bounded
UTF-8 bytes without following symlinks, includes a selected skill's local text closure, double-
reads it against package races, and pins package identity, manifest hash, bytes, stage/persona
eligibility, and network policy into the immutable run artifact. `explicit_tools` accepts only a
pre-registered Koni-owned adapter whose package, binding, tool schema, and network property match
exactly. Arbitrary community extension modules are never evaluated or copied. Network-capable
adapters can only project the authority-backed `koni_run_check` surface and still require the
attempt's compiler-issued network grant. The production adapter registry is empty until such an
adapter exists, so suggested web/browser extensions fail closed rather than silently acquiring
authority.

Eligible pinned resources enter every `AgentLaunchSpec` as ordinary exact `resources.entries`.
Their bytes therefore contribute to `resources.setHash`, and the complete draft (including that
set hash, tool schema hashes, grants, and lineage) contributes to `specHash`. Recovery reselects
from the pinned run artifact and compares the exact expected resource set and tool inventory; it
does not consult a newly upgraded installed package. Already-issued artifacts without the optional
community member remain readable for compatibility.

Source handoff:

- contracts: `packages/core/src/contracts/pi-resources.ts`, plus configuration/index exports;
- read-only Pi inventory and strict YAML parser: `packages/core/src/profile/resource-bindings.ts`;
- immutable projection, eligibility, and validation: `packages/core/src/compiler/community-resources.ts`;
- effective-config and run/attempt/recovery wiring: `packages/core/src/compiler/configuration.ts`
  and `packages/core/src/compiler/run-program.ts`;
- provider-free evidence: `packages/core/test/profile-resource-bindings.test.ts` and
  `packages/core/test/community-resources.test.ts`;
- user/architecture transitions: `docs/pi-community-resource-bindings.md`,
  `docs/configuration.md`, and `docs/architecture.md`.

Verification from the composed working tree: Core strict TypeScript is green; the focused
community/parser/native-run/launch/resource/configuration suite is **41/41** across six files;
`git diff --check` is clean. No live project, Pi home/settings/package, provider, credential,
process, installed binary, ref, run, or terminal pane was changed.

An adjacent legacy-planning compatibility regression landed immediately after that checkpoint.
After coordinating its valid-lineage fixture correction, the same composed six-file suite was
rerun and supersedes the count above at **42/42**; strict Core TypeScript remains green.

Final release-gate note: an explicit pre-community pinned-artifact recovery case was added, proving
the optional field is a working compatibility adapter rather than only a type annotation. The
six-file composition now supersedes the prior counts at **43/43**. The refreshed authenticated
profile manifests pass **10/10** Core package checks, and the coding/research profile packages pass
**2/2** and **4/4** respectively. The source lease is released.
