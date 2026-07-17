# Legacy adoption hardening

Owner: `legacy_adoption_hardening/root`

Status: in progress

Last checked: 2026-07-16 23:58 MST

## Claimed scope

- authenticated live legacy-registry byte binding at adoption and first resume;
- exact archived Git-common-directory/state/registry/run-root path binding;
- legacy tree directory-race hardening and focused adversarial tests;
- test-only operator dependency injection needed to run the adoption suite without ambient Pi
  package environment state.

## Exclusions

Compiler context assembly, run-program prompt/context construction, resource selection/binding,
compaction, provider behavior, live project/run state, Pi credentials/settings, installed binaries,
and terminal processes are read-only. Production `resolvePiPeerRuntime` remains the sole default
operator authentication path; tests may inject an exact authenticated fixture through the existing
operator dependency boundary.

## Acceptance contract

The canonical live registry path is derived only from the repository identity returned by Git. Its
stable exact bytes must still match the migration binding before a successor can be admitted and
again while the first-resume run tree is reverified. Archived `commonDirectory`, `stateRoot`,
`registryPath`, and every run `sourceRoot` must equal the corresponding authenticated common-dir
paths before any archived source path is opened. Tree traversal must inspect the live filesystem
type and stable directory identity on every descent rather than trusting `Dirent` type bits.

## 2026-07-17 00:11 MST — frozen implementation handoff

Status: **complete; source lease released for independent review**.

The adoption assessment now derives `commonDirectory/koni/project.yaml` only from a fresh
authenticated Git identity, reads that live file through a no-follow stable-handle check, compares
its exact SHA-256 to the migration binding, verifies the selected run tree, and reads the registry
again before accepting the assessment. Both authority admission (including its final pre-commit
assessment) and first successor resume use this path, so registry drift returns a typed blocker,
creates no successor when it precedes adoption, leaves a successor paused when it precedes resume,
and makes zero provider prompt calls.

Archived evidence loading now rejects `commonDirectory`, `stateRoot`, `registryPath`, or any
`run.sourceRoot` that differs from `authenticated-common-dir/koni[/runs/<id>]`. Those string checks
happen before canonicalizing or opening any archived source path. Run-inspection material also
revalidates its self-hash. The tree walker reads entry names only, then uses live `lstat`; each
directory descent captures `lstat -> realpath -> lstat` identity and rechecks path/dev/inode/mode/
size/mtime/ctime before and after directory reads and child hashing. Its observer seam can only
inject extra work between checks and cannot bypass verification; the regression deterministically
replaces a descended directory with a symlink and proves fail-closed rejection.

The production operator default still calls `resolvePiPeerRuntime`. Only the legacy operator
wrappers gained the same optional dependency injection already used by other operator tests. The
fixture authenticates exact Pi `0.80.10`, TypeBox `1.1.38`, and the real Core preload without
setting ambient `KONI_PI_PACKAGE_ROOT`.

Frozen files:

- `packages/core/src/profile/migration.ts`
- `packages/core/src/profile/run-adoption.ts`
- `packages/core/src/operator/authority-bootstrap.ts`
- `packages/core/test/profile-migration.test.ts`
- `packages/core/test/legacy-run-adoption.test.ts`
- this mailbox and the append-only central registry note

Evidence on the frozen tree:

- `cd packages/core && npm run typecheck`: pass;
- confirmed `KONI_PI_PACKAGE_ROOT` absent, then exact package-local adoption suite: **4/4**;
- composed `legacy-run-adoption.test.ts` + `profile-migration.test.ts`: **9/9**;
- deterministic directory-to-symlink race regression: pass inside the **5/5** migration suite; and
- scoped `git diff --check`: pass.

No compiler context, run-program prompt/context, resource binding, compaction, provider, live
project, credential/settings, installed binary, or process state was changed.
