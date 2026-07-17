# Pi-managed autonomous sessions

Owner: `pi_managed_sessions/root`

Status: implementation complete and ready for authority integration on branch `pi-native-port`.

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

## 2026-07-16 — recovery contract and verification

The contained runtime now uses the exact pinned Pi 0.80.10 high-level primitives:
`createAgentSession`, `ModelRuntime`, `SessionManager`, and an explicit sealed `ResourceLoader`.
Fresh attempts create their session and resource roots exclusively. Recovery is a separate API and
cannot silently downgrade to a fresh launch.

Before a recovered attempt may construct a provider-capable session, Core now authenticates:

- the regular, non-symlink Pi JSONL session file, exact header ID, and exact worktree;
- a strictly linear parent chain with exactly one `koni.attempt-session-map` entry;
- the complete launch-spec, grant, generation, epoch, state, resource, model, and session mapping;
- every materialized compiler-issued resource byte;
- the persisted initial prompt, terminal-call cardinality, and cache-inclusive usage totals; and
- a fresh durable `koni.attempt-recovery.v1` authority projection bound to the same immutable spec.

Authority-accepted terminal output completes without another model call. Revoked attempts abort,
in-flight terminal submissions fail closed for reconciliation, an empty transcript receives its
initial prompt once, and a transcript ending in the persisted user/tool-result boundary uses Pi's
native `agent.continue()` without replaying the prompt. Ambiguous assistant-tail and authority /
transcript terminal disagreements fail closed. Already exhausted recovered token budgets cannot
spend another token.

Deletion is tombstoned before awaiting an in-progress factory, and both fresh and recovered
sessions are aborted/disposed idempotently. Pi usage retains separate new-token and cached-token
totals. Compaction remains structured and always reissues the exact hash-bound authoritative
context before the next provider request.

Verification at handoff:

- focused Pi tests: **26/26** across five files;
- complete `@koni/core` test suite: **122/122**;
- Core strict TypeScript check: green;
- Core build: green;
- whitespace check: green.

The production-construction tests use a network-disabled, isolated `ModelRuntime`, exercise real Pi
session persistence/reopen behavior, and make no provider call. They cover mapping drift, resource
drift, crash-after-session-create, and crash-after-persisted-user-turn behavior. No Pi credentials,
settings, live run, installed binary, terminal, or product repository was touched.

## 2026-07-16 — post-review recovery and terminal-contract hardening

Supersession note for the recovery paragraph and 26-test evidence above: the implementation was
independently reviewed after that checkpoint and the stronger contract below is now authoritative.
The old paragraph remains as the historical integration checkpoint.

- Fresh persistence atomically writes the Pi header and immutable attempt/session mapping before
  `SessionManager` can append runtime entries. A crash at exactly that boundary recovers as an
  unprompted session and issues the initial prompt once.
- Recovery obtains an atomic, single-owner authority claim before constructing any provider-capable
  object. Active recovery holds the claim through the session runtime; terminal/revoked projections
  release it immediately. A torn JSONL tail cannot replay authority-accepted work.
- Continuation no longer calls low-level `agent.continue()`. Pi 0.80.10 has no public high-level
  no-message continuation, so the pinned compatibility seam invokes `AgentSession._runAgentPrompt([])`
  only after checking that exact API. This retains AgentSession retry, compaction, persistence,
  queues, abort waiting, idle state, and lifecycle events.
- Recovery accepts only the exact mapping, bound model/thinking changes, validated Koni compactions,
  and standard user/assistant/tool-result messages. Context-bearing custom entries, branch topology,
  duplicate/unmatched/outstanding tool calls, mixed terminal batches, and unaccepted terminal calls
  fail closed.
- The terminal output is the terminal tool's validated argument object. It is JSON-cloned,
  byte-bounded, and checked against the actual hash-bound TypeBox schema. The tool's
  `AgentToolResult` is a distinct authority receipt. Terminal execution is sequential, must be the
  only call in its assistant batch, and a successful receipt is forced to terminate Pi's batch.
- Token cancellation now awaits Pi's abort acknowledgement. Provider output is proactively capped
  to remaining output/new/all-token headroom, recovered attempts with no headroom cannot call a
  provider, cache tokens remain included in total accounting, and an unconfirmed abort becomes a
  failed attempt rather than a false stopped outcome.
- Observer exceptions are isolated. Abort, runtime release, and disposal are memoized and
  failure-safe. Provider/extension resources and recovery claims are released immediately after an
  outcome while the durable Pi transcript remains available to history/chat views.
- Compaction is bounded as a complete 4 MiB artifact and digest-binds its summary. Recovery opens
  session/resource files with `O_NOFOLLOW`, checks private modes and inode stability, and rejects
  nested symlink substitution or byte drift.

Current focused evidence is **45/45** across the five Pi files, including real network-disabled Pi
session construction. It covers atomic-mapping crash recovery, structured-compaction continuation,
torn-tail terminal acceptance without model loading, context-entry injection, incomplete terminal
calls, schema/mixed-batch/termination violations, observer failures, abort acknowledgement/failure,
runtime cleanup failure, nested symlinks, and total compaction size. The full shared Core check was
not re-claimed at this checkpoint because the authority integrator was actively editing
`run-engine.ts`; no live provider, credential, project, run, process, terminal, or installed binary
was touched.

### Attempt lineage addition

The immutable launch boundary now also requires a hash-bound lineage object: initial attempts are
epoch zero roots, while retry, rework, review, recovery, and integration attempts require a positive
epoch plus paired parent attempt/session identities and may bind a specific parent Pi entry. Missing,
unpaired, cyclic, or malformed lineage fails with a typed launch-spec error before session creation.
The lineage is repeated in the atomic attempt mapping and authoritative compaction header, so recovery
cannot silently attach a different branch.

Pi's session-header `parentSession` field is deliberately not populated from Koni's
`parentSessionId`: Pi 0.80.10 defines that field as the source session **file path**, not a logical
session identity. Koni therefore keeps identity lineage canonical in the authority record, launch
spec, and mapping. A future/native caller may set a Pi parent path only when it has separately
validated that exact path; it must never reinterpret the ID as a path.

> **Current linear-session clarification — 2026-07-16:** every autonomous attempt starts a fresh
> linear Pi JSONL session. The lineage above authenticates relationships between separate attempts;
> it does not authorize Pi in-session branching, tree navigation, or reuse of a parent's provider
> conversation. Ordinary interactive Pi sessions retain their normal branching features.

## 2026-07-16 — durable rejected outcomes and transcript-result budgets

Supersession note for the earlier terminal/cardinality wording: a terminal *attempt* may now be
rejected and retried; only one authority-accepted terminal receipt may end the attempt. Every
authority result uses the exact `koni.tool-receipt.v1` accepted/rejected union. The durable result
ledger repeats that outcome, Pi persists `isError` from it, and recovery authenticates the receipt,
arguments, rendered text, outcome, and error bit byte-for-byte. A rejected result is therefore a
first-class model-visible no-effect decision rather than an exception that becomes ambiguous after
a crash. The obsolete mutable `replayed` receipt flag is gone.

Each immutable tool binding now includes `maxResultBytes`. Before any effect, a serialized
per-turn reservation accounts for the full worst-case result plus JSONL framing across sequential
or parallel calls. If the normal result cannot fit but a small rejection can, the runtime asks
authority to durably record `transcript_result_budget` and does not execute the tool. The catalog
also checks actual canonical result bytes against the same hash-bound cap. Recovery applies the
same reservations before repairing missing results.

Recovery now uses Pi 0.80.10's exact `validateToolArguments` conversion/validation behavior rather
than a merely similar TypeBox check. Pinned schema-validation failures and output-limit-truncated
tool calls are deterministic no-effect Pi errors: they can be reconstructed and fsynced without
contacting authority. Custom `prepareArguments` hooks remain prohibited in contained tools so no
unhashed mutation can sit between the persisted call and the authority argument digest.

Current provider-free evidence is **74/74** across the eight managed-session, production-session,
launch-spec, catalog, resource, compaction, atomic-file, and transcript files; strict Core
TypeScript checking is green. Added adversarial cases cover accepted and rejected receipt repair,
outcome/error-bit drift, schema-error repair without authority, and a worst-case result reservation
that records a durable rejection while proving the underlying effect was never invoked.

Concurrent-integration note: the lane reached a green complete Core typecheck after authority
adopted the envelope. A later shared rerun, while the process supervisor was being wired into
`run-engine.ts`, surfaced only structural supervisor-port mismatches in that actively edited file;
there were no managed-session, receipt, catalog, launch-spec, or focused-test type errors. The
primary integrator owns that final composed adapter seam.
