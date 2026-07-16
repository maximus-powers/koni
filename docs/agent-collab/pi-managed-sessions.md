# Pi-managed autonomous sessions

Owner: `pi_managed_sessions/root`

Status: active on branch `pi-native-port`.

## 2026-07-16 — implementation lease

This lane owns only:

- `packages/core/src/pi/launch-spec.ts`
- `packages/core/src/pi/resource-loader.ts`
- `packages/core/src/pi/managed-session.ts`
- `packages/core/src/pi/supervisor.ts`
- `packages/core/src/pi/compaction.ts`
- focused offline tests for those modules under `packages/core/test/`

The target is one fresh, persisted, linear Pi `AgentSession` per immutable compiler-authorized
attempt. The exact model, thinking level, budgets, terminal contract, authority grant/state
bindings, and hash-bound resource inventory are captured in a versioned launch specification.
Autonomous sessions load only the Koni inline extension and compiler-issued resources; ambient Pi
extensions, skills, prompts, context files, themes, built-in filesystem/shell/network tools, and
project resources remain unavailable. Pi's normal credential/auth source is used unchanged.

The session supervisor owns lifecycle streaming, steering/follow-up, abort/dispose, complete Pi
session/transcript mapping, and fail-closed run deletion. A Koni compaction hook may summarize
conversation, but it must retain structured workflow references and request authoritative context
reissue after compaction.

Out of scope: manifests, `extension.ts`, authority/state/compiler/Git modules, existing Rust, live
runs, installed binaries, terminals, and credential files.

