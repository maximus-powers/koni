# Context/read-discipline implementation

Owner: `context-read-discipline-impl/root`

Status: `active`

Last checked: 2026-07-16 America/Phoenix

## Lease

This lane owns the smallest safe correction from `cognition-efficiency-audit.md`: Worker and
bundled Implementer context-EOF/read-strategy instructions, matching broker tool copy, and a
bounded compiler-enforced `context_incomplete` correction before product operations. It also owns
focused compatibility and paging tests for those changes.

This lane does **not** own raw provider rendering, search offset metadata, current-worktree change
manifests, speculative instruction projection, live Updog state, installed or acceptance binaries,
processes, cmux, Git refs, or profile installation. Existing grants/catalogs must remain compatible;
same-batch stale-sibling handling, terminal semantics, exact scope, and frame bounds remain intact.

## Decisions and progress

- Preserve pinned legacy grants by making context-completion enforcement an explicit catalog/grant
  capability rather than inferring it for historical state.
- Treat only the exact context continuation as eligible while incomplete; every product-facing
  read/list/search/mutation/check/submission receives one bounded retryable correction.
- Do not reject redundant searches in the broker: transcript-retention guidance is instructional,
  because post-read product drift can make a repeated compiler-receipted search legitimate.

## 2026-07-16 08:54 MST — disjoint supervisor-latency coordination

`live-supervision-fastpath-impl/root` is editing only the pre-authority supervisor decision and new
exact-live-worker helpers/tests. It will not touch context completion, broker catalogs/descriptions,
tool dispatch/currentness, or Pi batch behavior. Please leave a note in
[`live-supervision-fastpath.md`](live-supervision-fastpath.md) if your implementation needs the
same supervisor symbols; otherwise these leases are intentionally disjoint.

## 2026-07-16 09:18 MST — implementation released

This source/template/test/docs lease is complete and released to the integrator. Newly issued
Worker grants carry an optional, hash-bound `complete_before_product` context policy. The policy
is absent from historical serialization, so existing grant hashes and old tool catalogs keep
their pinned behavior; Lead grants never receive it. The provider-neutral broker starts new
Workers at `AwaitingContext`, advances only through the exact compiler `document_path` and returned
`next_offset`, and permits product work after `eof:true`. A premature product read/list/search,
mutation, configured check, or submission receives exactly one retryable `context_incomplete`;
an uninformed repeat is nonretryable. Existing Pi retryable-error handling still skips stale
sibling calls, while an exact continuation followed by product work proceeds sequentially.

**Evolving to an observation boundary — 2026-07-16:** The final clause above described execution
order, not model observation, and is superseded. Every successful compiler-context delivery now
quarantines later siblings from the same assistant message in Pi without broker dispatch. Product
work may proceed only from the next provider request after EOF has been observed. The compiler also
accepts at most 4,000,000 context bytes, requires at least 32 KiB per exact continuation, budgets at
most 128 of 256 receipts to context, and reserves at least 128 for product/check/terminal work.

The compiler-appended Worker assignment, bundled Software Implementer, and `context`, `read_file`,
and `search_files` catalog copy now teach the same contract. Known literals in large files should
be searched before broad reading, and a complete `eof:true` result should not be searched merely
to relocate text already retained in the transcript. Exact path/directory authority, no-follow
checks, configured validation, terminal outcomes, and frame limits are unchanged. No raw provider
renderer, search-offset metadata, current-worktree manifest, installed profile, live run, binary,
process, cmux surface, worktree, or Git ref was touched.

Verification:

- provider-neutral broker tests: **15/15**;
- real bundled Software direct-Pi context paging and terminal compile: **1/1**;
- Worker assignment, legacy grant, and Lead compatibility focused regressions: **5/5**;
- embedded CLI template suite: **8/8**;
- Pi stale-sibling retry regression: **1/1**;
- warning-denied Core all-target Clippy, `cargo fmt --all -- --check`, and `git diff --check`: green.

A composed Core pass after the fixes passed 660 tests with three intentional ignores; its three
remaining subprocess tests failed closed only because a separate concurrent Cargo process relinked
the compiler-pinned test executable mid-run. All three passed individually once Cargo was idle.
The integrator should use its final isolated full-suite gate as the single-fingerprint release
count.
