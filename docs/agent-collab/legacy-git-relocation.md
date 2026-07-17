# Legacy Git relocation executor

Owner: `legacy_git_relocation/root`

Status: complete; lease released

Last checked: 2026-07-16 19:34 MST

## Claimed scope

- `packages/core/src/state/legacy-run-git-migration.ts` and a dedicated executor module if needed;
- the minimum Git client/lifecycle intent and recovery extensions needed for legacy relocation/deletion;
- authority admission/recovery/deletion integration limited to this compatibility boundary;
- focused legacy relocation, recovery, and deletion tests;
- append-only collaboration and migration notes.

Excluded: control-center/configuration surfaces, report compilation, profile contents, Pi credentials,
provider/session implementation, live projects, installed binaries, processes, refs outside ephemeral test
repositories, and terminal panes.

## Pinned contract

The migration adapter's existing proof-only `LegacyRunRelocationPlan` remains the immutable source of
authority. The executor will hold the run authority lane, re-prove its source hash/repository/ref/HEAD/
registration/cleanliness/absence predicates, prepare a durable crash-forward intent, move the registered
checkout source -> staging -> canonical integration, re-lock and verify it, then atomically settle both
the Git lifecycle and compatibility state. Recovery must roll forward from either path boundary without
guessing or deleting ambiguous data. Explicit deletion must recognize unrelocated legacy state and use
its own proof-bound journaled cleanup rather than passing the old namespace to the new-layout cleanup.

Questions or overlap concerns from adjacent agents should be left below; this file is append-only.

## Completion handoff — 2026-07-16 20:02 MST

Implemented the journaled compatibility executor, both-hop and lock-boundary recovery, admission
quiescence, atomic authority settlement/lifecycle restoration, ticket-projection clearing, and
legacy-source-aware explicit/already-durable deletion. Exact focused evidence and the transition
contract are appended to `legacy-run-git-migration.md` and `runtime-and-git.md`. No live resources
were used. Source lease is released after root integration.

## Planning-resume addendum — 2026-07-16 20:13 MST

Root authorized the final compatibility-only compiler projection after review found that restoring
legacy prior phase `planning` would otherwise point at a retired detached checkout that never
existed in the old runtime. `attemptWorkspace` now selects the locked integration checkout only for
a settled `relocated` compatibility record; native planning semantics remain unchanged and fail
closed without a ready detached checkout. The real native-program regression is green **6/6** and
the final composed native/legacy/Git/store gate is **47/47**; strict Core TypeScript is green.

## Provider-free parity proof lane — 2026-07-16 20:18 MST

Root assigned this persona the bounded closure of `KPAR-GIT-0002/A02`,
`KPAR-LIF-0001/A02+A03`, `KPAR-LIF-0002/A02+A03`, `KPAR-TKT-0001/A01+A02+A03`,
and `KPAR-SWF-0001/A03`. `executable_parity_runner/root` confirmed it will not touch these proof
entries and supplied the manifest/hash/blocker-count protocol. This lane may map exact existing
provider-free production tests or add a narrowly composed Core fixture only when no existing test
executes the entire invariant. It will not weaken assertions, synthesize a capture, invoke a
provider, or mutate live state.

## Provider-free parity proof handoff — 2026-07-16 20:46 MST

The assigned nine blockers now have executable target evidence. The compiler retains each
profile-authored failed-review owner through the derived ticket contract, durable tickets record
step kinds plus one bounded rework history, and the scheduler/authority reopen that owner exactly
once before requiring a fresh reviewer attempt. A second failed review blocks instead of creating
an unbounded loop; the failed review ID remains durable and a stale completion cannot close work.

Controlled provider-free authority fixtures additionally prove: pause drains cached/new usage,
survives authority restart, and emits one fresh successor on resume; deletion revokes a retained
write tool and ignores late terminal/receipt/ticket/filesystem/usage activity; and a target-side
conflict preserves both histories while compiling exactly one bounded integration ticket. Existing
production tests cover the one-squash ticket transaction and explicit operator target publication.
The composed compiler/scheduler/authority/native/Git/lifecycle set is **54/54** and strict Core
TypeScript is green. `reference/parity/proofs.json` dropped from 17 to 8 blockers; the central
runner owns the final manifest digest after the adjacent proof lane lands. No provider, live state,
installed binary, credential, user ref, process, or terminal surface was touched.

The final TKT-A02 audit also closed a production omission: `compileAssignmentOutput` now requires
every configured validation check to have an accepted, passing record bound to the current attempt.
New check records durably distinguish protocol acceptance from semantic pass; legacy records remain
readable but an absent pass bit cannot establish closure. The native Research fixture proves the
same terminal output is rejected without its current scoped check and accepted after that exact
receipt is installed. The **54/54** count and strict typecheck remain green after this hardening.
