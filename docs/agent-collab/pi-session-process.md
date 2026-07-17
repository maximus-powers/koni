# Pi autonomous-session process containment

Owner: `pi_session_process/root`

Status: active implementation on `pi-native-port`.

## 2026-07-16 — bounded lease and boundary

This lane owns new process-boundary modules under `packages/core/src/pi/` plus focused offline
tests. It does not edit `managed-session.ts` or `supervisor.ts`, which remain owned by the
Pi-managed-session lane.

Each immutable compiler-issued attempt runs in one detached Node child/process group. The child
uses the existing sealed `ManagedPiSession` construction, Pi's normal credential/model runtime,
and only the exact Koni tools/resources named by the launch specification. The child never loads
ambient project tools, extensions, prompts, skills, filesystem, shell, or network tools.

The parent remains the authority boundary. Tool calls, context reads, compaction authorization,
and recovery claims cross a versioned, size-bounded JSON-lines protocol and execute through
parent-owned callbacks. Steering, follow-up, lifecycle events, cache-inclusive usage, terminal
outcome, abort, and disposal cross the same channel. A disconnected child loses its recovery
claim and all in-flight authority calls are aborted.

Deletion first tombstones the local handle, asks Pi to abort, then escalates to process-group
`SIGTERM` and `SIGKILL` (or the platform tree-kill equivalent) and does not resolve until the child
and its process group are gone. No terminal pane or installed/live Koni process is touched.

## 2026-07-16 — implemented process and run boundaries

The implementation now consists of a strict protocol/decoder, one-process handle, child entry, and
run-level process pool. Every frame is attempt/spec-hash bound and monotonically sequenced. The
parent validates tool membership and exact arguments again before calling authority. Context,
compaction, and recovery requests stay parent-owned; recovery claims are revoked on deletion or
disconnect. A terminal outcome is not exposed as settled until the child has exited.

Steering and follow-up use the complete durable `KoniAuthorizedMessage` record, not raw text. The
parent and child both validate its mode, order, byte count, content digest, and size. The child then
passes that exact record to `ManagedPiSession`, whose managed-session lane persists the non-context
mapping before Pi queues the message.

The run pool mirrors authority-engine lifecycle semantics: launch/recover/get/list, committed
steer/follow-up, pause/resume, synchronous deletion tombstones, idempotent run deletion, disposal,
and ordered lifecycle/usage/outcome observation. Pending launches participate in pause/deletion and
cannot publish themselves after their run epoch changes.

Focused offline evidence is **12/12**. It covers fragmented/truncated/oversized framing, ordered
cache-inclusive usage, accepted effects and no-effect transcript-budget rejection round trips, exact
committed steering, normal provider-environment preservation without ambient Node code injection,
child crash, stuck-child escalation, descendant process-group removal, pool event/lookup behavior,
deletion racing a pending launch, and one deletion stopping multiple concurrent attempts. All
children are fixtures; no provider, credential, live run, project worktree, installed executable,
or terminal pane was touched.

## 2026-07-16 — final authority-engine handoff

All public integration types are exported by `@koni/core`:

- `PiAttemptProcessSupervisor` — run-level production supervisor.
- `PiAttemptProcessLaunchOptions` — `{ terminalOutputSchema, authority, timings?, runtime? }`.
  Production must omit `runtime`; it is a packaging/test seam for the child entry only.
- `PiAttemptProcessAuthority` — `{ invokeTool, rejectTool, contextProvider }`. `rejectTool` records
  the exact no-effect `transcript_result_budget` rejection; it is not an exception shortcut.
- `PiAttemptProcessHandle` — `{ session, outcome }`.
- `PiAttemptProcessSessionView` — immutable `spec`, authenticated `sessionFile`, current `status`,
  plus `abort(reason?)` and `dispose()`.
- `PiAttemptProcessSupervisorEvent` — flattened immutable attempt identity plus `event`, where event
  is a managed lifecycle/usage/terminal/compaction event or `{type:'outcome', outcome}`.

The engine call shape is:

```ts
const pool = new PiAttemptProcessSupervisor();
const handle = await pool.launch(spec, {
  terminalOutputSchema,
  authority: { invokeTool, rejectTool, contextProvider },
});
// Recovery has the same options and calls pool.recover(spec, options).
```

The rest of the structural supervisor port is `get/list`, `steer(attemptId, committedMessage)`,
`followUp(attemptId, committedMessage)`, `abortByRun`, `resumeRun`, `deleteRun`, `isDeleted`,
`subscribe`, and `dispose`. Both message methods require a complete `KoniAuthorizedMessage` already
committed by authority. No function-valued Pi tool definition, model runtime, factory, credential,
or extension crosses the process channel.

Final verification after the stabilized accepted/rejected receipt envelope and per-tool result
budgets: Core strict typecheck green, focused containment tests **12/12**, Core build green, emitted
child entry/protocol/pool declarations present, and repository whitespace check green.
