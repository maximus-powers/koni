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
