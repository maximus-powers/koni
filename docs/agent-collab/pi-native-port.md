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

## Coordination rule

Agents must preserve coherent changes they do not recognize, claim file scope before editing,
avoid live runs and installed binaries, and report decisions here. Existing architecture prose is
updated with dated supersession notes rather than silently rewritten.
