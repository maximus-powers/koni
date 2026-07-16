# Pi-native migration architecture

## Lease — 2026-07-16 (`pi-native-migration-audit/root`)

This persona owns a read-only audit of Koni's current Pi/Rust runtime boundary and the exact
`@earendil-works/pi-coding-agent@0.80.7` APIs, plus append-only migration architecture and
coordination documentation. Intended documentation scope is this mailbox, `docs/AGENT_COLLAB.md`,
one dedicated migration decision document, and dated transition notes beside the historical
credential-source statements in `docs/pi-runtime.md` and `docs/getting-started.md`.

No runtime/source code, profile, installed/global binary, live state, project checkout, Git ref,
credential, provider call, terminal surface, or cmux process is in scope. Existing coherent
changes are preserved. This lane will release with a migration matrix, boundary ADR, smallest safe
vertical slice, compatibility/security consequences, deletion gates, and P0/P1 implementation
risks.

## Current corrected direction

- Pi is the canonical provider credential and authentication authority wherever the selected
  provider is supported by Pi.
- Rust stores no provider access token, refresh token, API key, authorization code, or verifier.
- Rust may retain only nonsecret provider/account capability bindings, an auth-generation or
  credential fingerprint, and compatibility-migration state.
- Koni's Rust credential store is a temporary guarded import/fallback seam, not the target source
  of truth, and needs explicit deletion gates.
- Rust remains the only authority for workflow, graph/compiler/tickets, grants, CAS/replay,
  receipts, Git, questions/approvals, lifecycle, and meaningful effects.

## Questions for other personas

<!-- Append signed questions here. Preserve answered entries. -->

## Release state

`released_to_root` — documentation audit and architecture decision are complete. No source
implementation is authorized by this lease.

## 2026-07-16 release handoff

The complete decision, migration matrix, staged slice, compatibility model, branching contract,
security consequences, verification matrix, deletion gates, and source-scope recommendation are
in [Pi-native session, resource, and authentication migration](../pi-native-migration.md).

### Exact pinned findings

- Audited the exact npm artifact `@earendil-works/pi-coding-agent@0.80.7`; packed tarball SHA-256:
  `c010db218d57d561765651bf42ec13adc22736693880b46cf1919b9bfc260ab3`.
- The pin exports `createAgentSession`, `AgentSession`, `AgentSessionRuntime`, `SessionManager`
  (JSONL version 3), `ResourceLoader`/`DefaultResourceLoader`, async inline extensions, semantic
  tool/message/entry renderers, `AuthStorage`, exported `AuthStorageBackend`, and `ModelRegistry`.
- It does not export `ModelRuntime`; that is newer documentation terminology. Exact 0.80.7 source
  and declarations must govern implementation.
- `createAgentSession` defaults are ambient/permissive unless Koni supplies `noTools: "all"`, an
  exact allowlist, minimal custom loader, in-memory settings/model registry, run-local session
  manager, exact model/thinking, and sanitized environment.
- The stock auth backend uses cross-process `proper-lockfile` locking, including around refresh,
  but rewrites `auth.json` in place. The exported backend interface permits a Pi/Node-owned atomic
  implementation, subject to exact stock-Pi lock interoperability tests.
- `SessionManager` is an append-only `id`/`parentId` tree. Its exact branch/tree/fork/custom-entry
  APIs support native history, but Pi's leaf is not an authorization primitive.

### Boundary decisions

- Pi owns session/model/resource/extension/native-chat/authentication mechanics; Rust remains the
  sole graph/compiler/ticket/grant/CAS/receipt/Git/question/approval/lifecycle/effect authority.
- Pi is canonical for credentials wherever supported. A supervised Pi-owned credential backend/
  service is preferred; autonomous sandboxes never mount or discover all of `~/.pi/agent`. Rust
  retains only provider/model, a nonsecret opaque account/auth-generation binding, and migration
  state.
- One Pi session tree belongs to one immutable agent assignment attempt, not one ticket. Rust adds
  one authoritative active branch epoch. In-file branches are allowed only while the attempt is
  live and before terminal compiler submission. Plan revision after a candidate, worker rework,
  retry, reviewer execution, or any authority/resource/context change creates a new attempt,
  session, grant, and call-ID namespace.
- Rust chooses ready assignments and enforces `max_parallel`; deterministic Lead courier turns
  retire only after journal/replay/crash/pause/recovery and truthful semantic-Lead parity.
- New runs pin runtime, conversation, launch/resource, Pi artifact, and auth-binding versions.
  Existing active/paused runs remain on their old host unless an explicit safe-boundary migration
  passes; no upgrade interprets them in place.
- The installed extension uses one lazy, bounded, read-only-first Rust bridge and never opens a
  terminal, pane, cmux/tmux, or TUI. The autonomous runner remains separately contained.

### P0/P1 handoff

P0 gates are zero ambient tools/resources, no extension-as-authorization, no ambient credential-
directory mount, one Rust schema authority, full launch/context/grant/auth/branch binding, no old-
epoch or post-terminal grant reuse, one credential writer, run-format compatibility, and deletion
that proves zero later provider requests/tokens/effects.

P1 gates are Pi 0.80.7 auth-file atomicity/interoperability, bounded and symlink-safe session JSONL,
exact-pin/latest-doc API drift, bridge lifecycle/backpressure/version skew, transcript privacy,
compaction accounting/context reissue, package/native compatibility, and deterministic Lead cost.

### Documentation evolution

- Added `docs/pi-native-migration.md` as the dated target ADR without replacing direct-Pi history.
- Added adjacent 2026-07-16 supersession notes to `docs/pi-runtime.md` beside both Koni-owned
  credential-source passages.
- Added an adjacent 2026-07-16 target note to `docs/getting-started.md` beside the Koni auth paths.
- Preserved all earlier credential and runtime decisions as causal history.

### Verification and exclusions

- `git diff --check -- docs/pi-native-migration.md docs/pi-runtime.md docs/getting-started.md
  docs/agent-collab/pi-native-migration.md docs/AGENT_COLLAB.md` — clean.
- No runtime/source/profile/test/binary/install/project/run/ref/process/credential/provider/TUI/cmux
  action was performed. No live test or dependency change was needed for this docs-only audit.
- The exact npm artifact was unpacked only under `/tmp` for source/declaration inspection; no repo
  dependency or lockfile changed.

### Recommended implementation order

1. `@koni/pi` plus a bounded read-only extension server, one status command, one Rust-schema graph
   tool, semantic renderer, lifecycle tests, and explicit `koni tui` alias.
2. Runtime/session/launch compatibility metadata plus one opt-in read-only AgentSession assignment.
3. Pi-session transcript projection, steering/cancellation/compaction/branch parity.
4. Pi-owned atomic auth backend/service and guarded single-writer credential migration.
5. Deterministic Rust scheduling and only then legacy-host/MCP/credential/Lead deletion gates.
