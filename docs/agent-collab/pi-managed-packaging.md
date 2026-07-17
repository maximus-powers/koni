# Pi-managed packaging boundary

## 2026-07-16 — claim

`community_resource_integration/root` owns only the shipping/install boundary that makes the
operator's existing Pi runtime and package manager the sole source of Pi SDK modules. Scope is
`scripts/install-dev.sh`, the exact-tarball stock-Pi smoke under `scripts/`, package/release CI
wiring, package manifests only where packaging metadata requires it, and adjacent append-only
packaging documentation. The installer must retain an explicit manually invoked `koni tui`
command without using global npm to resolve or auto-install a second Pi SDK or TypeBox copy.

The release proof will pack exactly `@koni/core`, `@koni/coding-profile`, and
`@koni/research-profile`, install them through a disposable stock Pi 0.80.10 package home, preserve
ambient Pi resources, make zero provider calls, and construct then abort one real provider-free
`AgentSession`. This lane does not edit context assembly, compiler/authority/runtime source,
parity manifests/captures, live Pi state, credentials, installed binaries, user projects, or
terminal panes. Coordination questions and the final evidence remain in this file.

## Coordination

- `pi-native-port/root`: this supersedes only the earlier global-npm packaging assumption. Please
  leave the listed installer/smoke/CI/docs surfaces to this lane and continue other release work.
- `executable_parity_runner/root`: no parity file or capture is in scope here.

## 2026-07-16 — implementation checkpoint

The shipping boundary is one Pi-managed closure containing exactly the three coarse Koni packages.
Pi SDK packages and TypeBox are optional host peers, and the standalone `koni` command resolves the
first shell-executable Pi wrapper to exact Pi 0.80.10 instead of installing or guessing a second
runtime. The source installer creates one sealed, content-addressed closure and activates it with a
single proper-lock transaction: secret-free fsynced journal publication, atomic settings replace,
exact Koni-source CAS, atomic launcher switch, and idempotent rollback. Packed fixtures now cover
regular POSIX/Windows wrappers, opaque and non-executable PATH entries, full Pi auth byte/mode
preservation, legacy `settings.apiKeys` non-copy, SIGKILL at journal/settings/rollback boundaries,
malformed settings, concurrent/extra Koni source rejection, and originally absent settings.

Release docs now target only installed Koni sources (profiles before Core), require `/reload` or a
fresh Pi session after byte replacement, and explicitly resume paused runs. Release publication is
also profiles-first/Core-last, with a stock-Pi exact-tarball gate and a Koni-owned five-component
SBOM separated from the Pi host-compatibility attestation. Pending integration evidence owned with
`pi-native-port/root`: packed legacy+current duplicate-Core shutdown/remediation and one
provider-free production attempt through the packed authority/supervisor child path.

### Validation handoff

The final packed gate now includes both pending paths in code: a guard-unaware project-local legacy
Core alongside the packed current Core, and an installed-Core foreground authority that admits a
real production attempt child with provider activation withheld, verifies the Pi JSONL mapping and
launch-spec hash, then pauses, deletes, and shuts down at zero tokens. The first coordinated build
attempt stopped before packaging on shared Core TypeScript errors outside this lane
(`run-engine.ts`, `run-program.ts`, `graph/context-selector.ts`, and `state/run-record.ts`). These
were routed to `pi-native-port/root`; the exact tarball result remains pending a clean rebuilt dist.
