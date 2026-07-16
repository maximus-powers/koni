# Runtime efficiency audit

Owner: `broker-read-latency-audit/root`

Status: `in_progress` — read-only diagnosis; no source, live-state, binary, worktree, process,
Git-ref, or cmux authority

## 2026-07-16 — exact lease

Trace the preserved Medium acceptance worker's batch of ten `read_file` calls from the Pi host
through the compiler broker and explain the observed roughly 27–35-second spacing. The audit may
read source and durable evidence and append findings here. It must not alter source, the active
acceptance run, broker files, binaries, product worktrees, processes, Git refs, or cockpit state.
Any proposed repair remains unimplemented pending integrator disposition.

## 2026-07-16 — completed read-only diagnosis

Status: `complete` — lease released; no product source, live state, binary, worktree,
process, Git ref, or cmux state changed

### Verdict

The roughly 34-second cadence is not a Pi/provider delay, a file-size cost, or a deliberate
per-read sleep. Pi intentionally executes a model-authored tool batch sequentially, and every
individual call then crosses Koni's expensive durable ingress separately. On this populated live
run that ingress repeatedly contended for the exclusive run-authority barrier with the cockpit's
automatic supervisor while both the supervisor and the broker also recomputed accumulated
run/quarantine state. The result is an emergent liveness/performance defect: one otherwise cheap
read or search finishes per authority-contention cycle. The safety-motivated serialization is
intentional; the tens-of-seconds cost per read is not.

The source proves the serialization, repeated barrier/currentness work, and recurring competing
supervision paths. The preserved receipts and live read-only sampling prove the cadence and the
hot cockpit owner. Because this audit was forbidden to attach a profiler or instrument the live
binary, the exact split of each interval between barrier wait and quarantine/currentness CPU is an
inference rather than a measured phase breakdown. Both are in the same compiler ingress path; the
supervisor is the only recurring cockpit path shown in source holding that barrier across the
expensive preflight.

### Durable evidence

Grant `grant-019f6b81-5628-7803-b895-9dea1ac5535b` for run
`019f66a9-df5a-7302-a3e1-00482d37a7ab`, ticket `TK-5ec6ad45ffe5072b`, contains 33 successful
ordered receipts. Receipt `recorded_at` is written after the whole broker call, so adjacent
receipt times measure the settled end-to-end cadence for an already-issued sequential batch:

- Sequences 2–11 are the ten `read_file` calls. Their deltas are 34.547, 27.743, 33.955,
  34.113, 34.009, 34.001, 34.620, 33.839, 34.085, and 33.972 seconds.
- Read response sizes range from 1,667 to 34,782 bytes without a corresponding latency change.
- Sequences 12–17 are six `search_files` calls and exhibit the same 33.860–39.701-second
  cadence. This rules out file decoding and response size as the dominant mechanism.
- Later `edit_file` calls settle in a variable 7.900–17.923 seconds after the first edit. That
  changing cadence is consistent with scheduler/lock interleaving, not a fixed Pi sleep.
- The worker completed successfully at the compiler boundary, so this was latency rather than a
  retry storm or broker rejection loop.

Read-only process sampling while the batch was live showed the cockpit/broker owner consuming
roughly one to two CPU cores while the Pi child was effectively idle. Repeated read-only
`cockpit --json`/`inspect` projections took about 3.5–4.2 seconds; graph/profile validation took
about 0.04–0.13 seconds. The expensive surface is accumulated run projection/currentness, not
profile compilation or filesystem reads. Polling the stable run-authority lock descriptor also
showed the cockpit process repeatedly opening and releasing it. No process was attached, paused,
or modified.

Token accounting is separate and agrees with the operator's clarification. This attempt emitted
19 usage events totaling 813,568 cached input, 59,640 uncached input, and 6,734 output tokens
(2,319 reasoning tokens are already a subset of output). Therefore compact `new tks` should be
66,374, while the provider-inclusive total is 879,942. Cached context explains the larger total;
it does not explain the broker wall-clock cadence.

### Exact source chain

1. Pi constructs the session with `toolExecution: "sequential"` and every exposed tool with
   `executionMode: "sequential"` (`runtime/pi-host/src/runtime.ts:339-365,794-868`). Each execute
   awaits one `protocol.executeTool`; the protocol sends one frame and awaits its exact promise
   (`runtime/pi-host/src/protocol.ts:178-210`). Rust likewise handles one inbound `ToolCall`,
   synchronously calls the broker, and only then sends its result
   (`crates/koni-core/src/pi_runtime_process.rs:423-425,553-563`).
2. This ordering is a safety contract, not an accidental default. After a retryable tool error,
   later siblings from the same model-authored batch are stale until the model sees the result and
   issues a corrected request; terminal outcomes abort later siblings
   (`runtime/pi-host/src/runtime.ts:820-865`; regression coverage at
   `runtime/pi-host/test/runtime.test.ts:724-800`). Globally switching the host to parallel would
   violate these semantics.
3. The Rust broker also serializes ingress behind its state mutex
   (`crates/koni-core/src/agent_tool_broker.rs:259-292`). The durable call path takes a per-grant
   operation lock, fully revalidates, durably reserves, performs the operation, and durably writes
   the receipt (`crates/koni-core/src/engine.rs:46394-46475`). The grant has one `in_flight`
   reservation and a strictly increasing sequence, so arbitrary concurrent dispatch is not
   compatible with its current CAS design.
4. One call acquires the exclusive run-agent authority barrier during ingress revalidation
   (`engine.rs:43207-43255`), again during reservation (`engine.rs:46117-46127`), and again during
   receipt persistence (`engine.rs:46276-46286`). Full currentness always runs global quarantine,
   opens the run, checks registry/agent/process identity, and for a Worker reopens the ticket
   checkout and verifies the exact lease (`engine.rs:42539-42628`). The bounded `read_file`
   implementation itself has no delay (`engine.rs:43846-43891`).
5. Broker authority waits use `RUN_AUTHORITY_ACTION_TIMEOUT = 30s`
   (`engine.rs:1071-1076`). The lock loop is a non-fair 10 ms `try_lock` retry that succeeds when
   the barrier becomes available or errors at the deadline (`engine.rs:55091-55144`). The timeout
   is a ceiling, not a built-in 30-second sleep, but it explains why contention clusters near that
   duration.
6. The cockpit refreshes every two seconds (`crates/koni-tui/src/app.rs:42-47,605-608`) and active
   runs are explicitly excluded from the snapshot cache
   (`crates/koni-tui/src/model.rs:5065-5069`). Each active refresh opens the run and rebuilds the
   cockpit projection (`model.rs:5194-5200`; `engine.rs:12249+`), including board, graph, tickets,
   events, agents, token usage, and validation.
7. Independently, the cockpit automatically supervises eligible runs with a minimum five-second
   post-completion polling interval (`app.rs:549-574,1351-1392`). Each tick runs on its own thread
   (`app.rs:1093-1110`). The supervisor takes its lease, then the run-authority barrier, opens the
   run, and runs `ensure_registered_run_quarantine_clear` before dropping authority
   (`engine.rs:6380-6419`). That quarantine opens the run and traverses unfinished transaction,
   planned-proof sealing, command-journal, and authority-receipt state
   (`engine.rs:32649-32652,69969-70124`). Thus a known-live worker is repeatedly subjected to a
   full scheduling preflight that competes directly with all three broker publication phases.

### Smallest safe repair boundary

Do not parallelize arbitrary Pi tool batches and do not remove the durable one-in-flight CAS.
Those are correctness boundaries.

The smallest low-risk repair is to make automatic supervision cheap while an exact, compiler-owned
agent identity is still demonstrably alive. Under the existing supervisor lease, a conservative
fast path should verify the current registration/orchestration state plus the exact durable agent
record/process identity and return the existing `Waiting` outcome without acquiring global run
authority or rebuilding quarantine/board state. Any missing, stale, dead, mismatched, paused,
deleted, questioned, blocked, or terminal identity must fall through to today's full fail-closed
tick. Durable terminal events and the next poll invalidate the fast path. This removes the direct
recurring lock holder without weakening broker authorization.

Secondarily, active cockpit snapshots should use a durable fingerprint/incremental projection or
adaptive backoff so their refresh period cannot remain shorter than their own projection cost.
That reduces CPU pressure but does not by itself remove the supervisor's direct barrier
contention.

Only after those changes are measured should broker ingress be optimized. A narrowly reviewed
read-only currentness tier could cache immutable compiled profile/run/ticket projections while
still rereading the mutable grant, registration, agent/process identity, lease, scope, reservation,
and receipt on every call. Skipping global mutation quarantine for `read_file`, `list_files`, or
`search_files` is security-sensitive and should not be the first unmeasured fix.

Add non-sensitive phase telemetry around `revalidate.runtime`, `barrier_wait`,
`currentness/quarantine`, `reserve`, `execute`, and `receipt`, plus supervisor preflight. Current
durable `in_flight.started_at` begins only after reservation and is discarded at completion, so
the preserved receipt cannot separate pre-reservation contention from currentness CPU.

### Deterministic verification plan

- With an identity-owned live Worker, invoke automatic supervision repeatedly and assert the
  known-live path performs no global quarantine/board projection and does not acquire the global
  run-authority barrier.
- Make the process dead, identity mismatched, paused, deleted, awaiting a question, or terminal;
  assert every case falls back to the full tick, remains fail-closed, and never double-dispatches.
- Submit a ten-read model-authored batch; assert strict tool order, exact durable sequences,
  response hashes, and receipts remain unchanged. Preserve the existing retryable-stale-sibling
  and mixed-terminal-batch tests.
- Under a forced supervisor/barrier contention fixture, assert a read makes bounded progress well
  below the 30-second authority ceiling while revocation, deletion, grant drift, and lease drift
  still reject it.
- Instrument counters rather than asserting fragile wall time: no full supervisor quarantine per
  known-live poll, no repeated active projection without fingerprint change, and one expected
  mutable-currentness/reservation/receipt sequence per accepted read.
- Add one active-snapshot invalidation test proving durable agent/event changes surface
  immediately even when unchanged heavy components are cached or backed off.

No implementation or live acceptance action was performed by this audit.

### Implementation transition — 2026-07-16 09:27 MST

The preceding sentence remains the historical boundary of the audit itself. The separate
`live-supervision-fastpath-impl/root` lane has now implemented and released the first recommended
repair in source. Its exact-live double snapshot skips global run authority and quarantine only for
an already published, compiler-owned passive Worker binding; every negative or ambiguous case uses
the original full supervisor tick. The implementation deliberately leaves Pi batching, broker
mutable-currentness, grant serialization, durable receipts, and one-in-flight CAS unchanged.

Deterministic boundary counters and a pause/question/mismatch/blocker/deletion/death/terminal
fallback matrix are green, together with lifecycle **51/51** and final Core library **664 passed /
0 failed / 3 intentional ignores**. Guarded live latency measurement and any cockpit projection
backoff remain separate integrator-owned work; this lane did not touch acceptance state, installed
binaries, processes, cmux, refs, profiles, or product worktrees. See
[`live-supervision-fastpath.md`](live-supervision-fastpath.md) for the exact proof and release.
