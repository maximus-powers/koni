# Executable TypeScript parity runner

Owner: `executable_parity_runner/root`

Status: active on branch `pi-native-port`.

## Lease

This lane owns `reference/parity/**`, `scripts/parity-*.mjs`, their focused
tests, and append-only collaboration notes. It does not edit Core authority,
Git/state, control-center, profile implementation or manifests, Rust source,
live projects, credentials, installed binaries, processes, terminals, or cmux.

## 2026-07-16 — fail-closed execution audit

The checked-in v1 ledger currently validates 24 case/action specifications but
does not dispatch any of the 126 actions and has no TypeScript checkpoint
captures. The release gate must execute exact current TypeScript contracts,
bind each assertion to its proof, normalize only environment entropy, and
refuse `release` while any assertion lacks executable evidence. A passing test
name alone will not be presented as a checkpoint snapshot.

Several target behaviors already have close Core contracts (profile install,
graph reciprocity, deterministic scheduling, grants, isolated Git, native Pi
sessions, and control-center semantics). Full ticket rework/closure, complete
software delivery, and scientific evidence/report/conclusion currently require
an exact public Core fixture/action seam before their ledger actions can be
executed honestly. Missing seams will be reported as explicit blocker
contracts to `pi-native-port/root`; no synthetic capture will be substituted.

## 2026-07-16 — assertion gate and first normalized execution green

`reference/parity/proofs.json` now binds all 65 assertions to exact current
TypeScript tests plus frozen Rust tests/command captures, or to one explicit
blocker contract. Validation initially reported 27 blockers; two provider-free
composed fixtures now close profile-upgrade run-state preservation and
post-terminal exact grant replay; the native report compiler closes the
byte-stable research-ledger assertion, leaving 24. `release` mode rejects any
blocker and also requires every ledger case to be `passing`. The target runner
invokes only mapped files in a detached provider-free test process and emits a
canonical capture containing relative test identity, semantic outcome,
assertion contract hash, and oracle result—never duration, PID, absolute path,
temporary root, Git OID, or raw output.

The native Pi session case (`KPAR-SES-0001`) executes 4/4 assertions and
produced byte-identical captures twice (`e8463bdc…`). Focused parity evidence is
12/12 green across ledger and runner tests. A full frozen Rust semantic-suite
capture generator uses a detached tagged worktree, disposable HOME, zero
provider calls, semantic test-name normalization, and secret scanning.

One historical contract was corrected explicitly, not silently:
`KPAR-RUN-0001/A02` revision 2 plus `KBUG-GIT-0001` supersede eager permanent
run refs with detached planning and first-ref-at-approval semantics.

### Product gaps handed to the primary integrator

1. `plan.revise` currently steers a running planning session; the locked
   contract requires a fresh successor attempt/session/grant with immutable
   predecessor linkage.
2. No explicit recovery operation was found that records rollback as a new
   forward Git transaction while preserving prior evidence.

The remaining blockers appear to be isolated fixture/action adapters around
already-present authority behavior (upgrade/run-state preservation, budget and
usage counters, terminal broker closure, ticket rework/closure/integration,
pause/delete boundaries, complete Software/Research flows, and two UI state
matrices). They stay blocked until those complete compositions actually run.

## 2026-07-16 — forward-only Git compensation extension

Parent explicitly expanded this lane to close `KPAR-RCV-0001/A02`. This lane
now also owns the minimum forward-compensation additions in
`git/lifecycle.ts`, its isolated provider-free fixture, and the narrow journal/
receipt projection in `authority/run-engine.ts` and `state/run-record.ts`.
Config, control-center, report, profile, and legacy-relocation implementation
remain excluded. The required topology is `prior -> failed candidate ->
compensation`, where the compensation commit has the prior tree; the ref may
only CAS from candidate to compensation. The original failure settlement and
compensation settlement remain append-only, recovery is exactly once, and any
checkout bytes that cannot be proven equal to the prior or candidate tree are
preserved without reset or ref mutation.

## 2026-07-16 — remaining usage proofs claimed

After closing `KPAR-PLN-0002/A01+A02` and `KPAR-RCV-0001/A01+A02`, this lane
owns only `KPAR-PLN-0001/A03` (planning budget) and `KPAR-SCH-0002/A02`
(zero-relay usage) among the remaining proof blockers. The legacy relocation
lane owns GIT/LIF/TKT/SWF-delivery entries; the community-resource lane owns
RES and the other SWF entries. Shared `proofs.json` edits require a coordinated
final digest before updating the ledger and runner blocker expectation.

## 2026-07-16 — planning budget and zero-relay proofs closed

Planning repository discovery is no longer a dead YAML field. New agent-planning
launch specs hash-bind `budgets.repositoryCalls.max` from
`planning.max_repository_tool_calls` (with a bounded compatibility default),
and retain the existing hash-bound new-token ceiling. The Rust-free authority
counts accepted `koni_read_file`, `koni_list_files`, and `koni_search_files`
receipts inside its serialized mutation boundary. Exact idempotent replay does
not spend the budget again; a new over-budget call is rejected before any
repository, graph, or durable receipt effect. Old specs without the optional
field remain resumable.

`KPAR-PLN-0001`, `KPAR-SCH-0002`, `KPAR-TUI-0001`, and `KPAR-TUI-0003` now
have executable exact-test mappings and passing normalized captures. The
deterministic scheduler proof covers ticket dispatch/reconciliation without a
Lead or supervisor attempt or token ledger, and the end-to-end authority flow
confirms no relay persona is launched. The two TUI mappings bind the already
green ticket-aware agent-title and multiline-plan-revision contracts.

The manifest is temporarily at 17 explicit blockers, exactly those claimed by
the legacy-lifecycle and community/profile lanes. Those owners will patch only
their entries. This lane retains ownership of the final manifest digest and
will change the runner release expectation to zero only after both sets land
and validate, avoiding a knowingly false intermediate release gate.

## 2026-07-16 — release gate frozen green

Both collaborating implementation lanes completed their executable fixtures.
The final proof manifest binds all 65 assertions to exact passing TypeScript
evidence and exact frozen Rust evidence where the oracle is authoritative; it
has zero blockers and SHA-256
`1781f13f0ff1c772fbfa4bb8eadd38b22fd9ac3b5f45c0ec8dd03941cbcf9359`.
The parity ledger is now `release`, with all 24 cases marked passing.

`scripts/parity-runner.mjs gate` reruns the entire mapped provider-free corpus,
requires every result to pass, and compares every normalized case plus oracle,
normalization, and isolation provenance against the reviewed all-case capture.
The gate passed 24 cases / 65 assertions. The reviewed
`reference/parity/captures/KPAR-ALL.typescript.json` file SHA-256 is
`a207fc6b99a23149f6dfda27a8e85d371c6d14e250fe6056486d894286caa8e7`;
its internal canonical capture SHA-256 is
`fa8a2cf061e95c12bd161e8c415e5c7347b5a572e52b0959e4a439d79dfd458d`.
Root `check`, Pi-native CI, the frozen-oracle job, and release validation now
invoke the executable gate. The run used no providers, live projects,
credentials, installed binaries, terminal panes, or cmux state.

Final composed verification is green: root `npm run check` reran the 24/65
executable parity gate, 5 profile-bundle tests, 18 parity infrastructure tests,
45 Core test files / 334 Core tests, Core typecheck and build, Coding 2/2,
Research 4/4, and the 2 stock-Pi/package smoke tests. `git diff --check` is
clean. Post-check digest verification reproduced both frozen hashes above.
