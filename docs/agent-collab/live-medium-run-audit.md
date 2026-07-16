# Live Medium run audit

Owner: `live-medium-run-audit/root`

Status: read-only audit complete; no live or source mutation authorized

## 2026-07-16 06:15 MST / 13:15 UTC — active acceptance-run snapshot

### Scope and disposition

This is a read-only audit of Updog acceptance run
`019f66a9-df5a-7302-a3e1-00482d37a7ab` under
`/Users/max/Desktop/updog-koni-acceptance-1`. I inspected the isolated runtime, process tree,
pipeline, lifecycle, tickets, graph, Journals, events, receipts, broker grants, agent records,
transcripts, worktrees, refs, and Git state. I did not pause, resume, recover, kill, signal, write,
checkout, merge, install, or otherwise mutate the live project/run, its product worktrees, source
repository, binary, or cockpit. This audit file is the only write.

**Disposition:** the run is currently healthy and making forward progress. There is no durable
ticket blocker and no safe reason to interrupt it. The current Implementer should be allowed to
reach its compiler-owned terminal boundary. Historical execution was highly inefficient, but the
post-refresh path has advanced from the closed proof ticket through a recovered contract ticket
and into the real implementation ticket without repeating either newly completed ticket.

### Exact progress at the snapshot

- Profile/run type: Software `0.4.0`, Medium, `high_impact_only` questions.
- Target: `refs/heads/harness-testing` at initial/base commit `bb99311bda...`.
- Integration ref: `refs/heads/koni/runs/can-you-make-the-last-section-of-the-questionnai-2d37a7ab`.
- Run/lifecycle/orchestration are all active. The orchestration stage is `waiting`, cursor `4`,
  attempt `22`; this is a passive wait on the active ticket worker, not an approval or deadlock.
  Target sync, composed verification, report, and promotion remain pending.
- Approved active runtime was approximately **12h 52m** by 13:13 UTC. Wall time since approval
  was approximately 20h 10m; guarded refreshes, explicit steering, and paused intervals make this
  acceptance run unsuitable as a clean end-user wall-time benchmark.

Ticket state:

| Ticket | Operation | State | Durable result |
| --- | --- | --- | --- |
| `TK-63a91afabf98af03` | `prepare-proof` | closed | Sales Notes compatibility proof is `prepared`; final source was squash-integrated. |
| `TK-9410d997b2fc96c6` | `specify-contracts` | closed | Shared schema compatibility contract was added and independently passed review. |
| `TK-5ec6ad45ffe5072b` | `implement-change` | in progress | `establish-baseline` is running; `implement` and `review` remain dependency-ordered behind it. |

The graph is coherent and compiler-readable: 13 nodes total — 1 objective, 3 systems, 1
interface, 2 contracts, 1 flow, 1 decision, 1 change, 1 risk, and 2 proofs. The decision is
`accepted`, the compatibility proof is `prepared`, the implementation change and focused proof
are still `planned`, and systems/contracts/flow/risk remain active. The contract-designer's newly
added `ND-6d23...` contract has one canonical `applies_to` edge to the schema-owning system.

### Current agent and transcript health

At 13:13 UTC the only live model process was Implementer
`worker-019f6b0a-a146-7293-9c6c-9fa642f4fb29`, PID `49919`, model
`gpt-5.6-terra` / `high`, in the dedicated `TK-5ec6ad45ffe5072b` worktree. Its process-bound grant
`grant-019f6b0a-ad67-7411-92cf-5c66fe232485` was the only claimed run grant. Context issuance and
all observed bounded reads succeeded. The transcript showed one compact 37,715-byte
product-execution context, its required continuation page, scoped reads of the ten authorized
product/schema paths, then seven bounded searches for the actual questionnaire/proposal seams.
There was no write, check, submission, repeated prompt, or tool failure yet. The worktree remained
clean at `12fcfa501e...` while discovery was in progress.

The generation-69 Lead had already durably yielded `boundary-complete` after exactly
`start(ticket)` and `spawn-worker(ticket)`; its host process exited and its grant was consumed.
The orchestration projection correctly says `waiting_workers`, has no PID, and reports one active
worker. No old Lead, Reviewer, or worker process remained alive.

The preceding contract worker is an important lifecycle anomaly rather than a current blocker.
It made one coherent graph submission, whose output was durably recorded and later passed an
independent 93-second review. Its scoped compile then recovered with the exact diagnostic
`dynamic command read scope path does not exist: packages/schemas/src/uplinq/spiced-framework.ts`.
Because `submit_and_compile` did not return a compiler-committed terminal tool boundary, the Pi
agent itself is labeled `failed` / `validation_stop` even though its useful output survived. The
compiler recovered once, reviewed the durable output, closed the ticket, and did **not** launch a
duplicate contract designer. This is functionally safe but misleading in agent lifecycle/UI
history.

### Runtime and Git isolation

- Cockpit PID `23897` is running only from the isolated binary
  `/Users/max/Desktop/.koni-acceptance-runtime.b3LDDO/bin/koni`.
- Isolated binary SHA-256 is
  `8f0542d9de67b24f849e4ae5b1ce5cf1dbffd06c4ace092cfed5e18e8a725752`; it is byte-identical to
  the current source release build. The active worker host is a per-agent temporary Pi runtime
  bound to the configured Node executable/hash.
- The ordinary Updog acceptance checkout is clean on `harness-testing` at `bb99311bda...`, one
  local commit ahead of `origin/harness-testing` because of acceptance initialization.
- Integration is clean at `12fcfa501e...` and contains exactly one added 222-line historical
  proof file relative to the run base.
- The closed proof ticket branch retains ten incremental candidate commits ending at
  `f18d575ce8...`; only one squash commit reached integration. Contract and current implementation
  ticket refs are clean at the integration head. No branch or worktree had uncommitted product
  changes at the snapshot.

One non-token runtime anomaly is definite: repeated samples put the cockpit process between about
77% and 153% CPU (including a 77.5% one-second `top` sample), about 121 MiB resident, even while
the model host itself slept at 0% CPU. Its accumulated CPU time exceeded elapsed time. This looks
like cockpit/controller redraw or polling churn, not model cognition, but should be profiled after
the live run is quiescent. It is not a reason to restart the current run.

### Grants, receipts, and recovery health

At the last complete grant count there were 89 run-bound broker grants: 68 Lead grants and 21
worker grants. Historical state was 51 consumed / 17 revoked Leads, 8 consumed / 11 revoked proof
Implementers, 1 revoked contract designer, and the one current claimed Implementer. There was no
older claimed or in-flight grant after the guarded relocation recovery.

There were 57 compiler receipts at 13:11 UTC:

- 19 context packs;
- 3 passed worktree-setup receipts;
- 9 passed scoped-compile receipts;
- 19 passed expected-red proof receipts;
- 6 `invalid_result` and 1 `invalid_contract` expected-red receipt.

The current ticket's worktree setup ran successfully and its context-pack receipt is durable. The
sidecar Git history advances at meaningful action boundaries rather than every render frame.

The full event/Journals history contains 47 complete `recover` actions, 12 explicit
`compiler.recovery.required` events, and three worker-circuit openings. Recovered Journals retain
specific causes, including the old Pi-host digest mismatch, invalid proof results, read-scope
repair, prepared/focused proof-source collision, planned-proof relocation quiescence, unrelated
tracked-symlink handling, and the current graph-only missing future path. The final relocation and
read-scope-rebind markers are complete. No unsealed relocation transaction or current recovery
quarantine was present.

### Token accounting and retry cost

Token comparisons use the intended cache-excluding metric. Compact Header/Runs telemetry is
`new_tokens`; expanded telemetry separately shows cached input and provider total. Provider total
includes cached input, and reasoning is already a subset of output. Where only Pi-agent records
were available, this audit used `provider total - cached input`, which is the same normalized new
work boundary without assuming whether a runtime's raw `input_tokens` field is gross or already
split.

The guarded-resume cockpit snapshot recorded approximately **1.5M new tokens**, **5.4M cached
input**, and **6.9M provider total**. Those figures are not contradictory; the latter total
includes the cache. Specific durable lower bounds explain where the real work went:

- Planning session: 101,555 new, 333,312 cached, 434,867 provider total over two completed turns
  and 7m58s.
- Closed proof-preparation ticket: at least **1,250,902 new**, **4,770,304 cached**, and
  **6,021,206 provider total** across the 24 of 26 worker/reviewer sessions with recoverable usage
  records. This is the dominant cost center.
- Contract ticket: 42,802 new, 34,304 cached, 77,106 provider total across its designer and
  Reviewer. The designer itself used 26,141 new and 34,304 cached before the post-output compiler
  stop.
- Deterministic Lead records: at least **82,968 new tokens**, zero cached, across 66 Lead turns
  with usage. Current Lead boundaries did not make semantic choices; they invoked already selected
  start/spawn/recover/review/finish effects.
- The current implementation worker had accumulated a changing partial total of roughly 55.7K
  new and 25.1K cached by the final usage read; this is productive discovery, not yet a retry.

Historical proof-preparation retry evidence is unambiguous:

- 19 Implementer sessions: 8 completed and 11 failed;
- 7 Reviewer processes: 5 produced accepted structured results and 2 failed at runtime;
- 5 recorded substantive reviews: 3 failed and 2 passed, with the first pass later invalidated by
  authoritative steering because its claimed mutation path never executed under the exact check;
- 3 worker circuits opened after pairs of no-output sessions;
- 26 expected-red check receipts for one final prepared source;
- 10 candidate commits on the ticket branch for one integration squash;
- 69 durable Lead slices by current dispatch, including 22 completed recover boundaries.

The three failed substantive reviews repeatedly found the same missing production-seam class:
ineffective ordering, test-local mutation/completion replicas, then renderer inspection without an
actual mutation. Nine operator steering events eventually supplied the cumulative, executable
plain-Node seam and repaired its read authority. This validates the existing collaboration
recommendation: producer instructions and compiled scope should map each proof condition to its
actual production seam, action, and discriminating assertion before the first worker runs. Review
rework must remain cumulative so a later correction cannot drop an earlier open obligation.

These counts should not be treated as a pristine default-profile benchmark. The same run was also
used to develop and exercise host containment, circuit breaking, review currentness, scope rebind,
proof-source disjointness/relocation, symlink validation, guarded binary refresh, and recovery.
Nevertheless, the repeated worker/reviewer cognition and proof receipts are real costs, and the
compiler-owned recovery/Lead courier counts expose avoidable orchestration overhead.

### Blockers and anomalies

1. **No current run blocker.** The active ticket has `blockers: []`, a live identity-bound worker,
   a clean worktree, successful context/read receipts, and forward-moving transcript output.
2. **Historical first-shot proof contract was under-specified.** The semantic obligation required
   a mutation/isolation proof, but initial scope/instructions omitted or weakened the executable
   production seam. This caused the dominant rework loop.
3. **Useful-output agent can be labeled failed.** A graph output survived, but a later scoped
   compile error caused the contract-designer host to be marked failed. Durable terminal progress
   should dominate host-epilogue status or at least render as “output accepted; compile recovered.”
4. **Graph-only future read-path absence reached runtime.** The missing planned schema file was a
   legitimate future owned path for a graph-only contract ticket. Scoped receipt construction
   should record bounded absence without converting a useful graph submission into a failed agent;
   executable commands and compiled proof sources must remain strict.
5. **Cockpit CPU is abnormally high.** Profile polling/redraw/controller scheduling after the live
   run; do not conflate it with token spend and do not restart solely to investigate it now.
6. **Deterministic Lead cognition remains waste.** Current boundary packets already choose every
   effect. The compiler-boundary driver described in `lead-cognition-audit.md` would remove these
   fresh uncached model turns while retaining worker and independent Reviewer cognition.

### Recommended next safe action

**Do nothing disruptive.** Leave PID `49919` and the isolated cockpit running. Let the current
`establish-baseline` worker either publish its compiler-owned expected-red boundary or fail once
with a bounded diagnostic. Monitor only for a durable output/check/compile receipt, a transition to
the `implement` step, or a genuinely repeated identical failure fingerprint.

Do not refresh the binary, pause/resume, recover, or replace the cockpit while the current grant is
claimed. If the process disappears, first reconcile its agent record, grant, ticket output,
Journals, and receipts; do not infer failure from PID death alone. If the same no-progress cause
opens another worker circuit, stop and inspect the first-shot ticket instructions/scope before
authorizing another expensive attempt. After the worker reaches a durable boundary and the run is
quiescent, recheck ticket/graph/Git closure and separately profile the cockpit CPU loop.

