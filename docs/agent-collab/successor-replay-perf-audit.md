# Successor Replay Performance Audit

Owner: `successor-replay-perf-audit/root`

Status: `complete — read-only diagnosis and bounded design released`

Last checked: 2026-07-14 America/Phoenix

## Scope and coordination

This lane read the central registry plus the complete current successor/preparation coordination
tails before inspecting `crates/koni-core/src/engine.rs` and the exact Software Bug Fix regression.
It changed no Rust, profile, test, installed, Git-ref, or live-run state. The active
`compiler-graph-tdd/root` lease continues to own every successor/currentness symbol; this file is
advice and acceptance criteria only.

## Finding: the blow-up is repeated authenticated I/O, not an unbounded stack

The sampled stack agrees with current source. One evaluation of one latest preparation binding
performs all of the following:

1. `current_proof_preparation_bindings_with_successor` loads and parses the complete ticket board,
   then `latest_reviewed_proof_preparation_attempts_before` scans it by each declared preparation
   operation/source.
2. `reviewed_proof_preparation_ticket_binding_with_successor` calls
   `review_input_binding_matches_historical_preparation`, which calls
   `load_receipt_rows_for_ticket` once for the base preparation ticket.
3. The base review-effect replay authenticates the recorded preparation transition.
4. `authenticated_successor_review_effects` loads and parses the complete ticket board again. For
   every later application whose declared effect touches the prepared subject/path, it parses that
   successor ticket's receipts, re-opens its durable agent record/output, and replays the configured
   effect.
5. Back in `reviewed_proof_preparation_ticket_binding_with_successor`, the historical baseline
   lookup calls `load_receipt_rows_for_ticket` a second time for the same preparation ticket, then
   recompiles its exact graph-set/member and recomputes the source manifest.

`load_receipt_rows_for_ticket` is not ticket-indexed on disk: every call walks the whole receipt
directory, reads and YAML/JSON-decodes every receipt, filters by `ticket_id` only after decoding,
then hashes/sorts the matches. If `R` is total receipts, `B` is latest preparation bindings, `S_b`
is the count of later path-touching review applications for binding `b`, and `M` is the number of
independent predicate/currentness evaluations, receipt decoding is approximately
`M * sum_b(2 + S_b) * R`, before graph-set recompilation, source hashing, and durable-agent reads.

Current source has already made one useful partial correction: the final full-compile emission loop
computes `current_preparations` once and injects it into each rule resolver. That does not close the
whole multiplier. `materialize_derivations` still creates one fresh `GraphResolver` per derivation
rule without the prepared slice; the Software profile currently has seven derivation-bearing rules,
and their named queries can reach `proof_preparation_current` more than once per candidate. The
resolver's existing `receipt_cache` is both resolver-local and keyed by ordinary `receipt_type`;
the preparation/successor path bypasses it with direct per-ticket loads. Review, finish,
integration, and prospective-effect boundaries also create fresh resolvers and therefore need an
explicit evaluation-snapshot seam rather than an assumption that the final emission-loop cache
covers them.

## Replay cutoff: finite depth, potentially repeated DAG expansion

`REVIEW_EFFECT_REPLAY_CUTOFF` is a thread-local stack of strict
`(reviewed_at, ticket_id, review_id)` orders. Historical replay rejects the same order and any order
not strictly older than the current cutoff. That correctly prevents self/future authentication and
bounds recursion depth by the finite number of review applications in the ticket snapshot.
`visited_projections` separately rejects a repeated destination projection in one linear lineage.

Neither mechanism memoizes a subproblem. If a configured coverage selector re-enters preparation
currentness, the same older ticket, receipt set, and review application can be rediscovered from
many descending paths. Thus depth is bounded while total work can still grow with the number of
paths through the ordered replay DAG. The current Software prepare/diagnose/establish effects do
not themselves require such recursive coverage to explain the observed regression: repeated
top-level derivation/rule evaluations plus full-directory receipt parsing are already sufficient.
The generic implementation must nevertheless memoize by cutoff to keep a future legal profile
from reintroducing path expansion.

## Smallest semantics-preserving design

Introduce one operation-scoped `RuleEvaluationContext` (or equivalently named immutable
evaluation snapshot) and share it across derivation matching, final rule emission, and every
resolver created inside that one compiler/review boundary. Do not add a process-global or
cross-compile cache.

The context should lazily own:

- the already authenticated ticket snapshot, indexed by ticket ID and by latest preparation key
  `(preparation_operation_id, source_node_id)`;
- one parse of the complete receipt directory, grouped by `ticket_id` while preserving the current
  fail-closed behavior that a malformed receipt anywhere in the scanned authority set is an error;
- parsed review-effect candidates indexed by touched `subject_id`, sorted by `ReviewEffectOrder`,
  with declared touched paths retained for cheap disjoint filtering;
- successful static provenance checks per exact current review (canonical historical input,
  durable agent result, structural application); and
- current preparation results/replay results keyed by the complete evaluation identity.

The complete key must include at least compiled profile hash, canonical evaluation root, semantic
graph epoch, ticket snapshot epoch, receipt snapshot epoch, full replay cutoff order, prospective
ticket plus application hash, and materialization-ticket hash/status. Source-manifest results may
be reused only inside the same boundary after its filesystem snapshot/currentness checks; never
across compile calls. A review replay result must additionally be keyed by its exact review order
and application/input hash. `None`/false may be memoized only under that complete key; I/O or parse
errors must remain errors, not be converted into a cached stale result.

At minimum, extend the partial current-source approach so `materialize_derivations` and the final
emission loop consume the same lazily authenticated preparation slice for one unchanged semantic
epoch. If derivation materialization changes the profile's semantic graph hash, invalidate and
recompute; Software's `obligations`, `readiness`, and `compiler` projections are explicitly
semantic-hash-excluded, so its ordinary derivation pass should remain one epoch. This epoch check is
safer than blindly passing one vector across arbitrary generic derivations.

For successors, index first but authenticate fail closed. It is safe to omit applications whose
*declared* touched subject/path is disjoint. It is unsafe to prefilter on whether untrusted
pre/post snapshots appear to join the current projection: a forged or malformed path-touching
application that currently poisons authority must still be validated and rejected, not disappear
from the candidate set. Process each candidate at most once per exact `(review order, graph epoch,
cutoff, materialization identity)` and apply the already authenticated sorted applications to each
base projection.

This yields bounded work rather than an arbitrary history cap: one ticket/receipt parse per
snapshot, one authentication/replay per candidate/key, and one preparation binding per
operation/source/key. A fixed maximum successor count would reject valid long-lived histories and
is not the preferred fix; if a resource ceiling is later required, it must be explicit policy and
fail closed with a diagnostic.

## Deterministic regressions (no flaky elapsed-time assertion)

1. Add test-visible evaluation counters owned by the operation-scoped context (not process-global
   atomics). Run the existing exact Bug Fix lifecycle through preparation, disjoint diagnosis,
   implementation, durable passing successor, zero duplicate work, and final prepared-source
   overlap rejection. Assert that adding many irrelevant derivation rules/tickets does not increase
   preparation-binding authentication, successor replay, or receipt-directory parse counts.
2. In a focused context test with one reviewed preparation and one path-touching successor, assert
   exactly one ticket-snapshot load, one receipt-directory parse/index build, at most one base
   binding authentication per semantic epoch, and at most one replay of each successor order. Call
   the same preparation predicate through two queries and multiple rule resolvers; the counters
   must remain unchanged after the first result.
3. Add a cutoff-key test with a small ordered successor chain and a coverage selector that re-enters
   preparation currentness. Assert every `(review order, cutoff)` subproblem is evaluated at most
   once, self/future authentication remains false, a forged intermediate application remains
   fail-closed, and the total count is bounded by the number of distinct keyed subproblems rather
   than paths through them.
4. Add invalidation cases: semantic graph change, ticket/review/input change, receipt addition or
   mutation, source-manifest change, different canonical worktree root, prospective application
   change, materialization-ticket visibility change, and cutoff change must miss the relevant
   cache. Compiler-owned semantic-excluded derivation projection alone should retain the hit.

A generous outer test-process timeout can remain a deadlock watchdog, but elapsed wall time should
not be the regression oracle. Structural counters make the complexity guarantee deterministic
across debug/release builds and CI hardware.

## Correctness hazards to preserve during optimization

- Never key by deterministic ticket ID or `prior_cycles`; only the current ticket/review/effect
  boundary is authority.
- Never share cached results across canonical roots: Git-common materialization visibility and
  source manifests differ between the run root and ticket worktree.
- Include the replay cutoff in every recursive memo key. Reusing an unrestricted result inside an
  older cutoff could let a transition authenticate itself or a future review.
- Include prospective and materialization identities. Durable-terminal visibility, current-ticket
  visibility, and a not-yet-persisted exact effect are intentionally different semantics.
- Preserve newest-attempt selection before caller-specific target filtering, and keep predicate
  truth plus global prepared-source locking on the same cached typed slice.
- Do not make an index silently skip malformed path-touching applications or malformed receipts.
  Indexing changes cost, not fail-closed authority semantics.
- Do not cache across a filesystem/source epoch. The source-only manifest is the substantive global
  lock, not merely an optimization input.
- Pop the replay cutoff on every normal error path as today; an RAII guard would make this safer
  against future early returns. Memoization is not a substitute for the strict descending-order
  guard or `visited_projections` cycle rejection.

## Verdict

The performance hold is valid. The current one-vector final emission-loop change attacks one
multiplier but is incomplete while derivation and nested boundary resolvers bypass it and the
preparation path repeatedly scans/parses the entire receipt directory. Release should require the
operation-scoped indexed snapshot plus deterministic bounded-work counters, followed by the exact
Bug Fix semantic regression on one immutable source fingerprint. No Software profile change is
indicated.

## 2026-07-14 — compiler-owner disposition (`compiler-graph-tdd/root`)

The sampled filesystem multiplier is now closed at the compiler boundary without a process-global
cache. Graph-dependent bindings key on the complete normalized graph; a reentrant source-evidence
guard keys on state root plus ticket and receipt directories, loads tickets once, and lazily parses
and groups all receipts once across derivation graph identities. Reconciliation creates the second
source epoch used by final emission/write admission. Projected/prospective/historical resolvers use
local reentrant indexes and retain graph/materialization/cutoff-specific evaluation.

Deterministic tests prove exact graph invalidation, store separation, one receipt parse per source
epoch, three binding scans/two evidence indexes/zero empty-board parses for a fresh compile, and the
full successor lifecycle on an immutable engine fingerprint. The complete stable results are in
`compiler-graph-tdd.md`; independent audit found no P1. The broader memoization proposal for every
possible recursive `(review order, cutoff)` replay subproblem remains a generic P2 because the
strict descending cutoff already bounds depth and the current Software chain no longer repeats
receipt I/O. Legacy direct replay's current-time coverage and generic projected-resolver recursion
policy remain explicit P2s rather than being silently claimed closed.
