# Smoke Run Efficiency Audit

## Scope and lease

- Owner: `smoke-run-efficiency-audit/root`
- Date: 2026-07-15 MST
- Scope: read-only audit of Medium run `019f66a9-df5a-7302-a3e1-00482d37a7ab` through proof ticket `TK-63a91afabf98af03` in `/Users/max/Desktop/updog-koni-acceptance-1`.
- Allowed writes: this coordination note and an append-only summary in `docs/AGENT_COLLAB.md`.
- Excluded: source, live run state, worktrees, binaries, processes, cmux, and installed profiles.

## Questions being answered

1. Where did the run spend avoidable model cognition or lifecycle retries?
2. Which causes dominate the waste, with exact evidence paths and reproducible counts?
3. Does the current corrected proof artifact exercise the real product behavior honestly enough for independent review and later integration?

## Findings

Audit complete. All counts below are read-only measurements from durable run artifacts. The stable
accounting cutoff is the third rejected proof candidate, immediately before the primary integrator
deliberately reopened the exhausted review circuit for a fourth candidate at
`2026-07-16T02:28:47Z`. The later fourth attempt is assessed separately and is not included in the
stable token totals.

## Executive result

The run spent **4,892,433 provider tokens**, including **1,191,697 uncached/new tokens**, from
planning through the third rejected proof. Direct Implementer/Reviewer work dominated at
4,393,978 provider tokens and 1,026,554 new tokens. Planning used 101,555 new tokens and produced a
coherent semantic requirement; it was not the principal cost.

The three dominant avoidable causes are:

1. **Worker lifecycle/protocol churn.** Ten of sixteen Implementer launches failed at the runtime
   boundary. Failed Implementers consumed 59.2 summed agent-minutes—the same as the six completed
   Implementers—and 438,634 new tokens. With two failed Reviewer launches, failed direct-agent
   attempts consumed 451,905 new tokens, **44.0% of all direct proof-agent cognition** and 37.9% of
   all new run cognition through the cutoff.
2. **An execution context much larger than the selected proof step needed.** Thirteen workers read
   1,201,164 context-document bytes before product inspection, then read 5,644,995 product bytes
   and scanned 2,985,420 search bytes. The independently measured useful context projection is
   28,249 bytes versus 111,684 bytes for a representative live pack (74.7% smaller); see
   [`context-pack-compaction-audit.md`](context-pack-compaction-audit.md).
3. **A proof obligation without an executable, compiler-authorized seam.** The graph correctly
   required a real mutation, but the proof node, selected step, ticket read paths, and compiled
   check scope omitted `apps/books/src/components/ThreadQuestionInput.tsx`, which owns the actual
   blur-to-upsert behavior. Later steering also narrowed the task to inspecting a rendered element
   and explicitly said not to simulate a mutation. The third worker followed that instruction and
   predictably failed the unchanged mutation obligation.

The completed Reviewers were comparatively cheap and useful: three valid reviews took 4.7 summed
minutes and 89,221 new tokens. The first valid review already identified all three substantive
classes of defect—order, real mutation/isolation, and production completion predicates. Repeated
review was caused by partial rework and lifecycle loss, not by reviewer indecision.

## Evidence locations and accounting method

The preserved run root is:

`/Users/max/Desktop/updog-koni-acceptance-1/.git/koni/runs/019f66a9-df5a-7302-a3e1-00482d37a7ab`

The audit used only:

- `planning/session.yaml` and `planning/transcript.jsonl` for planning usage;
- every proof-ticket `agents/*.yaml` binding and its corresponding
  `work/tickets/TK-63a91afabf98af03/*.log` for direct Pi usage, tool I/O, and elapsed time;
- `lead-slices/*.yaml` and Lead logs for orchestration-model usage;
- `events.jsonl`, receipts, ticket YAML, and the ticket branch history for lifecycle chronology;
- the typed proof node, selected workflow step, compiled ticket scope, and ticket checkout for
  obligation/scope comparison.

“Provider tokens” uses each runtime's durable total. “New tokens” normalizes the two provider
schemas to uncached input plus output: planning records cached input as a subset of input, while
direct Pi records cached input separately. Reasoning tokens are a subset of output, not an
additional amount. Summed agent-minutes are per-process elapsed time and may overlap; they measure
active agent cost, not wall-clock duration. Long operator/development pauses in the live smoke run
are therefore excluded from causal attribution.

## Stable cognition totals through the third rejected candidate

| Work class | Launches/slices | Summed active time | New tokens | Provider tokens |
| --- | ---: | ---: | ---: | ---: |
| Planning | 2 turns | about 8 min | 101,555 | 434,867 |
| Direct proof agents | 21 launches | 123.3 min | 1,026,554 | 4,393,978 |
| Deterministic Lead orchestration through generation 55 | 55 slices | not added to direct time | 63,588 | 63,588 |
| **Total** |  |  | **1,191,697** | **4,892,433** |

Planning recorded 409,442 input, 333,312 cached input, 25,425 output, and 18,163 reasoning tokens.
Direct proof agents recorded 967,437 uncached input, 3,367,424 cached input, 59,117 output, and
31,828 reasoning tokens.

### Direct proof-agent outcome split

“Completed” here means the runtime reached its configured terminal boundary. It does not mean an
Implementer candidate passed review; all three completed Reviewer verdicts rejected their
candidate.

| Runtime outcome | Launches | Summed time | New tokens | Provider tokens |
| --- | ---: | ---: | ---: | ---: |
| Implementer completed | 6 | 59.2 min | 485,428 | 2,565,172 |
| Implementer failed | 10 | 59.2 min | 438,634 | 1,633,642 |
| Reviewer completed | 3 | 4.7 min | 89,221 | 181,893 |
| Reviewer failed | 2 | 0.2 min | 13,271 | 13,271 |
| **Total** | **21** | **123.3 min** | **1,026,554** | **4,393,978** |

Eight failed Implementers were classified as “direct Pi agent stopped without one
compiler-committed terminal tool boundary”; two completed a turn with an unfinished
compiler-brokered tool call. More importantly, two failed process records nevertheless contain a
`submit_and_compile` call that produced durable committed output. The host's later terminal
protocol failure still sent orchestration into recovery. Useful compiler-owned progress was
therefore available but was not authoritative enough to prevent duplicate cognition.

The two failed Reviewer launches were infrastructure/capability failures rather than review
judgment: one ended before meaningful stdout and one spent 13,271 tokens before stopping inside
the tool path. The adjacent missing-future-path review admission defect was subsequently fixed by
the primary integrator, but its cost remains part of this historical run.

## Deterministic orchestration cost

At the audit snapshot, generations 1–56 contained 56 durable Lead slices and 64,834 tokens. The
stable run total above excludes the deliberate fourth-candidate generation 56 and therefore uses
63,588 tokens through generation 55. The current all-slice split was:

| Boundary | Slices | Completed boundaries | Failed Lead agents | Tokens |
| --- | ---: | ---: | ---: | ---: |
| `dispatch_batch` | 3 | 1 | 1 | 3,762 |
| `recover` | 20 | 18 | 2 | 21,295 |
| `review` | 5 | 3 | 1 | 5,068 |
| `spawn_worker` | 21 | 16 | 4 | 23,665 |
| `wait_workers` | 7 | 0 | 6 | 11,044 |
| **Total** | **56** | **38** | **14** | **64,834** |

These boundaries were already fully selected by the compiler; no Lead slice made a semantic
choice. The 38.4 summed minutes in `wait_workers` are especially clear lifecycle overhead. The
passive-wait repair already addresses future waits. The broader compiler-owned boundary design and
replay invariants are documented in [`lead-cognition-audit.md`](lead-cognition-audit.md).

## Lifecycle and rework chronology

- The ticket lease began at `2026-07-15T17:14:09Z`; the first worker began at `17:14:53Z`.
- Candidate commits landed at 19:09, 19:26, 19:52, 20:21, 21:19, 21:53, 00:13, and 02:20 UTC.
- The first valid independent review did not publish until 00:04 UTC, after six candidate commits.
- Rework then landed at 00:13, was rejected at 00:19, and the next accepted worker output did not
  land until 02:20. The third review rejected it at 02:26.
- The primary integrator deliberately recorded exact review rework at 02:28:47, recovered the
  ticket at 02:28:54, and explicitly retried orchestration for the fourth candidate. That action is
  an operator response to the exhausted circuit, not an autonomous retry counted as pre-cutoff
  waste.

The eight committed proof outputs changed 419 inserted and 222 deleted lines—641 line changes to
arrive at a 197-line third candidate, or 3.25 times the final file size. This is not inherently bad
by itself, but beside ten runtime-failed Implementers and three repeated substantive review
failures it is concrete evidence that attempts were re-authoring the proof rather than resuming a
small unresolved obligation.

The run emitted dozens of deterministic orchestration events: 54 Lead-spawn and 54 matching
spawn-Lead actions by the fourth-attempt snapshot, 40 recover actions, 17 spawn-worker actions, 15
context issues, and only 8 accepted output actions. Those counts should be treated as historical
evidence rather than a target; concurrent guarded refreshes and explicit operator recoveries also
contributed to the event stream.

## Why the proof was not first-shot executable

### The semantic plan was stronger than the compiled execution scope

The typed proof obligation required each optional SPICED field to be mutated through its own
storage identity while preserving Sales Notes. The review contract repeated that requirement. But
the proof node's `covered_paths`, the selected step's read paths, the ticket scope, and the compiled
check set did not include:

`apps/books/src/components/ThreadQuestionInput.tsx`

That file owns the production `onBlur` callback and `api.thread.upsert` request. The scope also did
not include the repository's existing DOM-test pattern at
`apps/books/src/components/review/use-close-control.test.tsx` or the Books Vitest configuration.
Consequently, a contained worker was asked to prove a seam it was not equipped to inspect. The
graph expressed the right outcome but the compiler did not validate that every proof condition had
an authorized implementation seam and test pattern.

This distinction matters for earlier-stage instructions: the planning agent did not need more prose
saying “test mutation.” It needed a structured obligation-to-seam mapping that the compiler could
reject when the relevant production path was absent.

### Later steering weakened an existing obligation

At `02:11:10Z`, ticket-scoped implementation guidance told the worker to call each production
`renderInput`, recursively inspect the returned React tree, and explicitly “do not simulate a
mutation in a helper.” That concrete guidance retained completion checks but replaced the stronger
mutation/isolation oracle with a route-identity inspection. It appeared later in the context than
the typed graph and review obligation and therefore dominated the worker's behavior.

The third candidate did exactly that: it inspected the actual `ThreadQuestionInput.threadName`,
but performed no edit, blur, upsert, or storage isolation assertion. The third Reviewer correctly
rejected it. A steering event must not silently narrow a still-open typed proof obligation; the
compiler should either reject the conflict, preserve both as a cumulative checklist, or require an
explicit graph/contract revision.

### Rework was not represented as a cumulative blocker matrix

The first valid review found:

1. the order assertion reconstructed the expected order and could not detect a production reorder;
2. the mutation helper constructed an after-state itself instead of exercising production, making
   Sales Notes preservation vacuous;
3. the completion aggregate was test-local rather than the production predicates.

The second review confirmed order was fixed but found the production mutation and completion seams
were still copied. The third confirmed actual completion predicates and renderer routing were now
used, but mutation/isolation remained missing. A cumulative condition → seam → action → assertion
matrix would have made the remaining blocker explicit across attempts and prevented a later
instruction from dropping it.

## Independent artifact assessment

### Third committed candidate (`ad587977`)

The 197-line proof was meaningfully improved:

- its expected-red assertion honestly failed because the five production descriptors did not yet
  exist;
- order was compared directly from the production descriptor list;
- `isRequired` and `isComplete` were called from the production descriptors;
- each production renderer was inspected for the expected `ThreadQuestionInput.threadName`;
- only the scoped proof file was changed.

It was still not independently acceptable. No textarea value was changed and no production blur or
upsert path executed. The claim that Sales Notes remained unchanged compared an untouched fixture
to itself. My prediction from the artifact alone is “reject and do not integrate”; the recorded
third Reviewer verdict independently reached the same result.

### Fourth in-progress candidate, snapshots through 2026-07-15 19:48 MST

The fourth worker remained live; this audit did not signal or modify it. Its uncommitted diff is
directionally correct: it renders each actual `item.renderInput` with React DOM, changes the real
textarea through the native setter, dispatches input/change/focusout, lets the imported
`ThreadQuestionInput` reach a mocked `upsert.useMutation`, checks the request's thread name, and
checks every non-target sentinel including Sales Notes.

Two concrete blockers remained in the 19:43 snapshot:

1. The test does not declare `// @vitest-environment jsdom`. `apps/books/vitest.config.ts` does not
   configure a DOM environment, so `document`/`HTMLTextAreaElement` will fail once the earlier
   expected-red descriptor assertion starts passing. Existing DOM tests use the explicit header.
2. The proof checks the request name and every non-target sentinel, but it does not assert that the
   selected target sentinel actually changed to the entered/serialized value. A no-op or malformed
   target write can therefore pass the isolation half of the oracle.

The primary integrator recorded both corrections as steering at `02:39:13Z`, ten minutes after the
worker's context was issued at `02:29:53Z`. The worker independently added the jsdom directive and
ran the configured check at 02:44. The compiler correctly classified the result as
`invalid_result`: Vitest executed no test because the contained environment could not resolve
`/@vite/env`. The worker then removed the directive and restored a passing expected-red check.
That pass is not evidence that the DOM oracle is executable: the missing production descriptors
fail earlier, before `document` is reached. Once production makes the prefix green, the current
source returns to a Node-only environment and the DOM path fails.

This makes the underlying defect stronger than a missing header. The prescribed jsdom recipe is
not executable under the actual contained configured-check environment. At `02:46:02Z`, the
primary integrator recorded a plain-Node alternative: find the real `ThreadQuestionInput` element,
invoke the imported production component under the existing API mock, find its production
`QuestionnaireLongTextInput.onBlur`, invoke that real closure, and assert both the positive target
write and non-target stability. That correction also postdates the issued context. No durable
evidence shows a live-worker steering channel, so the active worker can finish unaware of either
late correction while the run state records them. Independent review should reject the current
DOM-based source even if the expected-red gate passes; integration should wait for an executable
plain-Node production-seam oracle and the positive target-write assertion.

## Recommended changes, in impact order

1. **Honor durable terminal progress before host epilogue status.** When a process has successfully
   crossed `submit_and_compile` and compiler receipts/output are current, reconcile from that
   durable boundary even if the Pi host later exits incorrectly. Resume from the exact failed
   check/review state instead of launching a fresh authoring attempt. The observed failed direct
   bucket represents up to 451,905 new tokens of avoidable retry cost.
2. **Compile a proof-obligation matrix before dispatch.** Every condition must name its production
   seam, authorized read path, test action, and discriminating assertion. Compilation should fail
   if a required seam is outside `covered_paths`/step scope. For environment-sensitive seams, add
   the project configuration and one canonical pattern path or an exact compiler-authored recipe,
   and prove that recipe runs inside the same contained configured-check environment before worker
   dispatch.
3. **Make rework cumulative and authority-checked.** Carry all unresolved Reviewer findings as
   typed obligations. Reject or visibly escalate steering that weakens a graph condition, review
   finding, or gate without an explicit contract revision.
4. **Define live-steering semantics.** Either deliver a new bounded instruction to the active agent
   with a receipt and acknowledgement, or label it “next attempt.” Recording late steering as if it
   influenced the active worker creates false operator confidence and another review cycle.
5. **Ship the step-relevant context projection.** Preserve hashes/receipts and full compiler-side
   validation while reducing the representative 111,684-byte model document to the measured
   28,249-byte product-execution projection. This removes duplicate graph bodies, full authoring
   schemas on a graph-forbidden step, repeated planning text, and repeated review history.
6. **Move deterministic orchestration boundaries into the compiler.** Keep real Implementer and
   Reviewer cognition, but eliminate model launches for spawn, recover, review wrapping, finish,
   and waiting. Reuse the replay-safe journal and compatibility design in the Lead audit.
7. **Review the first durable candidate promptly.** Six commits preceded the first valid review in
   this run. Once lifecycle admission is reliable, one early independent review plus a cumulative
   rework contract is cheaper and more informative than multiple unreviewed rewrites.

## Disposition

This audit changed no source, profile, test, live run, process, binary, worktree, branch, broker
grant, or cmux surface. It claims no implementation seam. The live fourth worker was still running
at the final read-only snapshot. This document and its append-only central registry note are the
only audit writes.
