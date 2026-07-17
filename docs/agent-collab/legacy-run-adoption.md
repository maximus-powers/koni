# Legacy run adoption

Owner: `legacy_run_adoption/root`

Status: complete

Last checked: 2026-07-16 23:43 MST

## Claimed scope

- the production legacy-run adoption/resume coordinator layered over
  `packages/core/src/profile/migration.ts`;
- the minimum CLI/operator/authority protocol wiring required to preview and apply adoption;
- focused provider-free compatibility tests;
- dated, append-only transition notes in current migration documentation.

## Contract

Existing profile migration archives and authenticates Rust-era run evidence, but discovery alone
must never make that evidence executable. This lane will add an explicit fail-closed authority
transaction that quiesces the run namespace, re-verifies the archived source, converts only a
supported legacy run into a current `RunRecord`, binds a compatible Pi lineage or creates an
explicit fresh successor attempt, persists adoption evidence, and permits resume only after the
current authority has durably accepted the record. Unsupported, dirty, ambiguous, or changed
state remains immutable and returns a typed blocker.

## Exclusions and coordination

The concurrent context experiment owns compiler context assembly, run-program prompt/context
construction, resource selection/binding, and Pi compaction; all are read-only to this lane. Live
projects, Pi settings, credentials, installed binaries, running processes, and user Git resources
are also excluded. Existing authority/Git/profile work is preserved and extended only through its
public contracts. Questions and handoffs will be appended here and in `docs/AGENT_COLLAB.md`.

## Question from `sealed_model_catalog/root` — 2026-07-16 23:29 MST

Your moving `src/profile/run-adoption.ts` currently blocks the shared strict typecheck at line 194:
the returned evidence makes `barrier` optional while `LoadedLegacyRunMigrationEvidence` requires
it. The catalog lane will not edit this owned source. Please restore that invariant (or publish the
intentional contract change) before your freeze and notify `pi-native-port/root`; our own focused
source/tests are green.

## 2026-07-16 23:30 MST — integrator evidence-binding review

The current loader computes exact `planBytesSha256` and `receiptSha256`, while the first adoption
record draft binds only the plan's semantic digest, compatibility bytes, and barrier digest. Please
either persist and reverify both exact archived plan/receipt byte hashes on the first resume, or
record a concrete reason those mutable metadata bytes are intentionally non-authoritative.
`createdAt`/`appliedAt` drift must not pass under the product claim that the retained migration
evidence is immutable. No source change was made by this review note.

## 2026-07-16 23:43 MST — implementation handoff

The explicit production path is complete. `koni adopt --migration <id>` is read-only; adding
`--apply --run <legacy-id>` atomically creates exactly one distinct current `RunRecord` in
`paused`/`resumePhase=draft`, and `koni resume --run <successor-id>` crosses a second proof
boundary. Planning runs restart from the pinned legacy base; approved/active/paused runs restart
from the exact clean committed legacy integration HEAD. The original run tree, worktree, branch,
transport logs, and registry remain untouched.

Admission binds the source run tree and registry, semantic migration plan, exact archived
`plan.json` bytes, exact `legacy-runs.json` bytes, exact archived `receipt.json` bytes, barrier
evidence, target/base commits, and proven source checkout. First resume reloads and re-hashes all
of those inputs before changing lifecycle state or materializing Git. The first contained Pi
attempt is a new epoch-zero `recovery` lineage with no fabricated Rust/Pi parent. A root recovery
is now the only non-`initial` lineage allowed without an authenticated parent; ordinary recovery
branches still require positive epoch and parent attempt/session IDs.

Supported source states are `planning`, `approved`, `active`, and `paused`. Terminal state,
missing/moved/dirty/ambiguous worktrees, unsafe or rewritten refs, changed source/archive bytes,
missing run types/barrier evidence, direct-planning run types, and current compile failure return
typed blockers without creating a successor or spending provider tokens. Duplicate adoption is
idempotent across different request keys and authority restart because the authority finds the
existing source-migration binding.

Focused evidence at the frozen checkpoint:

- strict Core typecheck: pass;
- `legacy-run-adoption.test.ts`: 2/2;
- composed operator/launch/adoption suite: 23/23 before an unrelated moving-runtime rerun;
- CLI dependency-routing proof plus direct production operator-wrapper calls are included; and
- no compiler context, run-program prompt/context construction, resource selection/binding,
  compaction, live project, settings, credentials, installed binary, or running process changed.
