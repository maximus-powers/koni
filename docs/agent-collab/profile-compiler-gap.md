# Profile compiler production-adapter gaps

Owner: `profile_compiler_gap/root`

Status: complete; lease released.

## Lease

- Coding profile rule configuration only where required to repair the shipped query-binding mismatch.
- `packages/core/src/compiler/domain-adapter.ts` and narrowly adjacent compiler-foundation seams needed to construct a fail-closed production `RuleDomainAdapter`.
- Provider-free acceptance tests for the two exact gaps reported in `native-run-program.md`.
- Append-only coordination notes in this mailbox and `docs/AGENT_COLLAB.md`.

This lane does **not** own `compiler/run-program.ts`, its tests, context assembly, prompt construction,
resource selection/binding, compaction, provider execution, live projects, credentials, installed
binaries, processes, or terminal surfaces. If the fix needs `run-program.ts`, the exact patch will be
posted to `native-run-program.md` and held until its owner releases or explicitly hands off the seam.

## Locked semantics

- Configured query variables must be internally consistent; an unknown binding remains a compile
  error rather than silently resolving to another node.
- Dynamic `check_passed` truth must come from authenticated production authority evidence through a
  domain adapter. Missing/stale evidence remains false/fail-closed; tests may not fabricate a pass.
- The active context-building experiment is external to this lease and will not be edited.

## 2026-07-16 23:21 MST — complete; lease released

The two reported failures were stale against the stabilized shared tree, so no production or
profile source was changed here. Current `run-program.ts` already constructs the production rule
domain adapter on its compile paths, and Coding's `ungrounded_objectives` query already uses the
query-local `$node` binding before the selected rule anchor is rebound as `$target`.

A new disjoint provider-free regression file pins both contracts:

- a Bug Fix objective with no active defect compiles exactly one `ground-defect` ticket without an
  unknown binding;
- Research `stage.formulation` fails with `expression.domain_adapter_required` when the adapter is
  absent, succeeds with the production adapter, and keeps non-graph `check_passed` false without
  authenticated evidence.

Evidence:

- `profile-compiler-gap.test.ts`: **2/2**.
- native Coding planned, Research planned, and Research direct-approval entry points: **3/3**.
- scoped whitespace check: green.
- full Core typecheck was attempted but the moving shared tree currently has an unrelated
  `control-center/component.ts:663` `JsonValue | undefined` to `string` error; this lane did not
  patch that concurrently owned surface.

Observed source fingerprints at handoff: `run-program.ts`
`c219fe0d1a6ae8e6a00625cf9e232ea28713189ff600f3985ac8b2b932ba1520`, production domain adapter
`34b46071fd8a5b2f555df14fffaec9628347e2e782c226be0ecfffe0d64eae34`, and Coding graph/profile
query source `173857dfcd378b8c24097cecc3ccf23f2e4e664d0f3164cc62a7b4e1acd4b86c`.

No context, prompt, resource, compaction, provider, live project, credential, installed binary,
process, or terminal state was touched. The compiler/profile lease is released.
