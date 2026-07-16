# Pi-native port coordination

Owner: `pi-native-port/root`

Status: active on branch `pi-native-port`.

## Locked decisions

- The shipped endpoint is pure TypeScript/Pi with no Rust binary or native Koni addon.
- Public packages are only `@koni/core`, `@koni/coding-profile`, and
  `@koni/research-profile`; compiler/runtime/state/Git/UI remain private Core modules.
- Pi owns credentials, provider execution, session JSONL, normal resources, and interactive chat.
- One TypeScript authority service per Git common directory owns compiler state, tickets,
  scheduling, grants, receipts, lifecycle, Git, and recovery.
- Autonomous work uses one fresh linear Pi session per immutable attempt. Pi branching remains
  available to ordinary user sessions but is not Koni ticket authority.
- Existing Pi settings/packages/resources are preserved. Community integrations are never
  silently installed and cannot issue Koni receipts.
- Both `/koni` and `koni tui` remain required and share one view model/component system.

## Current gate

1. Preserve the exact shared worktree (`86c2ba5`, `pre-pi-native-wip-2026-07-16`).
2. Stabilize and tag a green Rust executable oracle before adding TypeScript port source.
3. Build the executable parity ledger before enabling TypeScript effects.

## Active delegated lanes

- `check_runner_containment_fix/root`: minimum Rust workspace stabilization only.
- `parity_contract_audit/root`: read-only parity-ledger and fixture inventory until oracle tag.
- `pi_extension_topology/root`: read-only profile/package scaffold inventory until oracle tag.

## Post-oracle implementation leases

- `pi_extension_topology/root`: root npm workspace, three public package manifests, profile
  registrar extensions, and deterministic Coding/Research baseline capture.
- `parity_contract_audit/root`: `reference/parity/**` executable ledger, schemas, cases, captures,
  and runner tests.
- `check_runner_containment_fix/root`: `packages/core/src/{contracts,shared,compiler}/**` and
  focused tests.
- `pi-native-port/root`: `packages/core/src/{authority,state}/**`, local protocol/journal/grant
  foundations, and integration of the three lanes.

### 2026-07-16 — contained Pi AgentSession lease

`pi_managed_sessions/root` owns the five new modules under `packages/core/src/pi/` for immutable
launch specifications, explicit zero-ambient resource loading, managed Pi sessions, supervision,
and Koni-aware compaction, plus focused offline tests. It will use the exact pinned Pi 0.80.10 SDK
surface, preserve Pi's normal credential/auth source, and make no provider calls in tests. It does
not own manifests, `extension.ts`, authority/state/compiler/Git modules, Rust, live runs, installed
binaries, or terminal surfaces. Mailbox:
[`pi-managed-sessions.md`](pi-managed-sessions.md).

## 2026-07-16 — coarse Pi package scaffold lease

`pi_extension_topology/root` now owns only the root npm workspace files and
`packages/{core,coding-profile,research-profile}` package manifests, profile registrar
extensions, oracle-derived normalized profile bundles, bundle-generation utilities, and focused
manifest/digest/materialization inventory tests. The frozen source is tag
`rust-oracle-baseline` (`fcc425e`). Core compiler/runtime/state/Git/control-center implementation,
all Cargo/Rust source, live projects, credentials, installed binaries, runs, and terminal surfaces
remain out of scope. Generated schema-2 baselines must come from fresh installs produced by the
tagged oracle; random migration receipts and legacy external-resource manifests are not authored
bundle inputs.

### 2026-07-16 — coarse package scaffold ready for integration

The `pi_extension_topology/root` lease is released. The root is now an npm workspace containing
only the three public packages. `@koni/core@1.0.0` is the single executable authority extension and
CLI package; its compiler/runtime internals remain other lanes' implementation. Coding `0.6.0` and
Research `1.0.10` are self-contained Pi profile packages whose tiny extensions only announce an
immutable manifest URL over the Pi event bus. They do not register tools, commands, or effects, and
they do not depend on or bundle a second Core module root.

Fresh installs from `rust-oracle-baseline`
`fcc425e51114bcedb9aeae44d6e8c8418a525e6b` were captured after the Rust schema-2 converter:

- Coding: 45 authored baseline files, bundle
  `sha256:850aedcdd53edeff41be7fcc8599b159b3516ac3772d5d8d3e22998d04ccade9`.
- Research: 48 authored baseline files, bundle
  `sha256:516ca34e79916431d44dd130201a4c84659df2bbf6f3dfd76b3d2c7d69f581f2`.

Each baseline includes the converted provider-neutral agent YAML and the exact 18 embedded shared
skill files. Random `migration-receipt.json` and the legacy external `resource-manifest.json` are
excluded. Their exclusion and the exact oracle commit remain recorded separately in
`koni/oracle-provenance.json`. Baseline file hashes and the NUL-delimited bundle digest use the
same `sha256:` contract as Core, and both official manifests pass Core's strict parser and
byte-verifier.

Reproducible capture and verification commands used:

```sh
CARGO_TARGET_DIR=/tmp/koni-rust-oracle-fcc425e \
  cargo build --locked --release -p koni-cli
capture_root="$(mktemp -d /tmp/koni-oracle-profile-capture.XXXXXX)"
mkdir "$capture_root/coding" "$capture_root/research"
git -C "$capture_root/coding" init -q
git -C "$capture_root/research" init -q
/tmp/koni-rust-oracle-fcc425e/release/koni init --profile software \
  --target "$capture_root/coding"
/tmp/koni-rust-oracle-fcc425e/release/koni init --profile research \
  --target "$capture_root/research"
node scripts/capture-profile-bundles.mjs --capture-root "$capture_root"
npm install --ignore-scripts
npm run check
npm pack --dry-run -w @koni/core
npm pack --dry-run -w @koni/coding-profile
npm pack --dry-run -w @koni/research-profile
```

The final check is green: the parity ledger validates; 5 independent baseline inventory and
materialization tests, 2 registrar tests, and all 65 current Core tests pass; all workspace
TypeScript compiles and Core builds. Dry-run package inventories contain the intended executable
or profile resources only. No live project, installed runtime, credential, run, process, or
terminal surface was changed.

## Coordination rule

Agents must preserve coherent changes they do not recognize, claim file scope before editing,
avoid live runs and installed binaries, and report decisions here. Existing architecture prose is
updated with dated supersession notes rather than silently rewritten.

## 2026-07-16 — native authority/state/Git foundation

`pi-native-port/root` added the first executable pure-TypeScript authority slice under
`packages/core/src/{authority,state,git,profile,pi}`. It now has canonical Git-common-dir
discovery, a single-owner local authority lease, bounded framed RPC, CAS/idempotent mutations,
crash-forward file journaling, immutable grant/replay checks, durable run records, a deterministic
dependency/max-parallel scheduler, Pi JSONL transcript projection, isolated run worktrees, and an
explicit two-phase target promotion (`prepare` then user-authorized publish). Git conflicts are
returned as compiler input rather than written into the target branch. Profile installation
verifies the package inventory and preserves edited/deleted project files, staging new upstream
bytes separately instead of overwriting them. Pi settings and credentials are never read or
modified by profile installation.

The authority service deliberately remains the only mutation serializer. Pi extension, CLI, and
TUI clients use the same protocol and never become authorization boundaries. No live Koni run,
installed binary, credential file, Pi setting, or terminal process was touched while establishing
this slice.
