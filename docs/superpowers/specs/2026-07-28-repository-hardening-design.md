# Repository hardening design

Date: 2026-07-28

## Objective

Bring the current Köni repository migration to release-grade correctness, consistency, and
maintainability. Preserve the intended Rust-to-TypeScript and Pi-native transition, repair every
reproducible defect, establish enforceable source-quality standards, and reduce structural
complexity without weakening authenticated profile, authority, Git, process, or lifecycle contracts.

The final working tree must be organized into semantic commits whose boundaries explain the
resulting product changes.

## Starting point

The settled handoff contains approximately 700 changed tracked paths, 89 untracked paths, and 112k
lines of TypeScript under `packages/core/src`. The change retires the Rust workspace, legacy
profiles, parity material, the standalone Pi host, and the documentation application while
consolidating the shipping product into three TypeScript packages.

The current baseline has these properties:

- root profile-manifest verification passes;
- all workspace TypeScript projects type-check;
- `git diff --check` passes;
- the profile release-upgrade suite has eight failures because its reconstructed Coding and Research
  prior-release fixtures do not reproduce their pinned authenticated bundle identities;
- no repository-wide lint or format gate exists;
- several central modules range from roughly 3k to 17k lines.

Existing dirty-tree changes are user-owned. Cleanup work must preserve their intent and must not
discard or overwrite unrelated edits.

## Strategy

The work combines three approaches in a strict order.

### 1. Gate-first release hardening

Establish the complete verification baseline, classify failures, and fix correctness defects before
large refactors. Each bug fix follows root-cause analysis and test-driven development. Authenticated
manifests, historical release bundles, durable formats, authority boundaries, process containment,
and Git transactions are compatibility contracts rather than values to update until a test passes.

The historical profile test must use exact immutable prior-release assets. It must not approximate a
published release by reversing an open-ended sequence of edits against the current baseline.

### 2. Tooling-first consistency

Introduce a small, explicit repository-wide quality gate after existing behavior is green. Prefer
tools that understand TypeScript and can run deterministically in the current npm workspace. Rules
must target correctness, unsafe suppression, imports, unreachable code, promise handling, and stable
formatting. Avoid rules that create large subjective churn without improving maintenance.

Generated, bundled, fixture, archive, and authenticated baseline content must be excluded or handled
with purpose-built verification. Formatting must never rewrite bytes that participate in a pinned
bundle identity unless the corresponding release is intentionally republished.

### 3. Architecture renovation

Refactor oversized modules only behind passing characterization tests. Extract cohesive units with
one responsibility and narrow interfaces. Prioritize boundaries that reduce security or correctness
risk:

1. profile package and lifecycle publication;
2. authority persistence and run transitions;
3. process/session supervision;
4. compiler run-program construction;
5. Git lifecycle transactions;
6. control-center controller and component presentation.

File size alone does not justify an extraction. Each change must improve ownership, make invariants
more local, and preserve public and durable contracts. Refactors must be behavior-neutral unless a
separately tested defect requires a behavior change.

## Workstreams

### Release and profile integrity

- Reproduce and repair the historical profile-upgrade fixture failures.
- Verify current Coding and Research baseline inventories, hashes, sizes, migrations, and package
  metadata.
- Verify upgrade, overlay preservation, replay rejection, archive tamper rejection, and same-version
  source rejection against exact historical assets.
- Keep release fixtures immutable and independent of future current-baseline edits.

### Source correctness and safety

- Run the full existing source, package, profile, and boundary suites.
- Audit production TypeScript for unsafe casts, ignored errors, incomplete cleanup, unbounded input,
  authority confusion, path escapes, symlink races, non-atomic publication, ambiguous retry, and
  process-lifecycle leaks.
- Remove dead compatibility code only when no runtime, package, fixture, or documented migration
  consumer remains.
- Keep public errors and fail-closed checks precise and test-covered.

### Quality tooling

- Add deterministic lint and format-check commands at the root and applicable workspaces.
- Configure scoped exclusions for authenticated baselines, historical fixtures, generated output,
  package bundles, and archived snapshots.
- Fix all enabled-rule findings rather than adding broad suppressions.
- Add the quality commands to the root `check` path once the tree passes.

### Structural refactoring

- Use dependency and responsibility analysis to identify extraction seams in the largest modules.
- Add characterization tests before moving behavior.
- Extract pure validation, serialization, state-transition, protocol, and presentation units first.
- Avoid circular dependencies and broad shared utility modules.
- Keep exports narrow and internal by default.
- Re-run focused and full verification after every extraction group.

### Documentation and repository hygiene

- Reconcile README and architecture documentation with the final package and runtime shape.
- Remove stale references to deleted Rust, parity, docs-app, and standalone-host surfaces.
- Preserve historical documentation only when it still serves an explicit migration or release
  purpose.
- Verify package contents and ignore rules do not include local scratch or audit artifacts.

## Verification

Verification is layered:

1. focused regression for each defect or extraction;
2. workspace type-check and relevant workspace test;
3. profile bundle and Pi-host boundary tests;
4. root build and package smoke;
5. lint, format check, `git diff --check`, and brand checks;
6. final full `npm run check`;
7. independent review of correctness, security boundaries, tests, integration, and maintainability.

A passing command is evidence only for the exact source snapshot on which it ran. Any later
applicable edit invalidates that evidence and requires rerunning the affected layer.

## Commit design

Commits must be cohesive, independently explainable, and ordered by dependency. Expected groups are:

1. migration and repository-shape changes already present at handoff;
2. profile release integrity and exact historical fixtures;
3. individual correctness or safety fixes by subsystem;
4. quality-tool configuration and mechanical conformance;
5. architecture extractions by subsystem;
6. documentation and repository hygiene;
7. final integration adjustments.

Tests belong in the same commit as the behavior they prove. Generated manifest updates belong with
the source change that requires them. Do not create catch-all “cleanup” or “miscellaneous” commits.
Before committing, inspect both staged and unstaged diffs and preserve user-owned intent.

## Completion criteria

The work is complete when:

- all known and newly discovered defects are resolved or explicitly documented as external blockers;
- the full verification stack passes on the final source snapshot;
- authenticated package and migration identities are internally consistent;
- enabled lint and format checks pass without broad suppressions;
- completed refactors have characterization coverage and clearer boundaries;
- documentation matches the shipping implementation;
- no scratch, local cache, or accidental generated artifact is tracked;
- every repository change is included in a semantic commit with a precise message;
- the final working tree is clean.
