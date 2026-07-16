# Oracle/schema hardening final review

## 2026-07-15 — independent read-only review (`oracle-final-review/root`)

- Status: `in_progress`.
- Scope: generic `FieldDef.subset_of`, `disjoint_from`, and `unique_by` profile-compilation and
  graph-validation behavior; globally bounded MCP-safe schema diagnostics; bundled Software 0.5
  proof-oracle schema, wording, and focused tests.
- Boundary: no Rust, profile, fixture, live state, binary, TUI, process, or semantic-rebind source
  will be edited. This append-only coordination journal is the only write in this lane.
- Review method: trace each declarative primitive from deserialization and recursive definition
  validation through concrete graph-node validation and safe diagnostic projection, then compare
  the Software template and tests against that actual contract.

### Questions / findings

1. **P1 — path disjointness is lexical-case-sensitive, not filesystem-identity-safe.**
   `normalized_collection_scalar` normalizes path components but preserves case and Unicode
   normalization; `normalized_authority_paths_overlap` then compares `Path` values lexically.
   The current macOS filesystem was independently confirmed case-insensitive (`CaseProbe` aliases
   `caseprobe`). A proof can therefore declare alternate-case spellings such as source
   `SRC/seam.rs` and covered product `src/seam.rs`; graph validation accepts them as disjoint, but
   worker authorization against the exact source spelling ultimately joins and canonicalizes to
   the same covered file. That converts the allegedly read-only production seam into proof-source
   write authority. Unicode normalization aliases have the same class of risk. Bind authority
   comparisons to actual filesystem identity/case behavior (including not-yet-created children via
   their nearest existing ancestor), or fail closed on ambiguous aliases, and add an
   aliasing-filesystem regression shared by generic path authority and Software proof dispatch.

2. **P3 — the generic keywords remain undocumented on the installed profile-authoring path.**
   Repository search finds `subset_of`, `disjoint_from`, and `unique_by` in Rust, Software YAML,
   Software engineering history, and collaboration notes, but not in `docs/configuration.md` or
   the installed `configure-koni` references. Add the same-root reference rule, compatible scalar
   list types, normalized path-membership semantics, bidirectional path-authority overlap, and
   required direct scalar identity constraints to those author-facing resources.

- Remaining compile/runtime, safe-projection, Software-profile, and regression inspection is in
  progress.

## 2026-07-15 — filesystem identity fix shape and verification

The existing Koni helpers do not already provide the needed shared abstraction:

- `reject_project_path_symlink_components` is the correct no-follow precheck, but carries no file
  identity;
- `authorized_worker_file_path` and the read/write path manifest builders canonicalize containment,
  but `canonicalize()` was independently observed to preserve the caller's alternate case on this
  case-insensitive macOS volume;
- `control::same_control_root_identity` and `persistent_lock::same_file_identity` are private,
  Unix-only special cases; the latter also requires a regular single-link file and therefore cannot
  represent directory ancestry or catch hard-link aliases.

`same-file` 1.0.6 is already locked transitively through `walkdir`. Making it a direct Koni-core
dependency is the smallest portable option. `same_file::Handle` compares `(device,inode)` on
macOS/Linux and volume/file-index identity while Windows handles remain open. A rare Windows false
positive fails closed, which is appropriate for authority; unsupported targets return an error and
must also fail closed. Handles should remain short-lived per validation/comparison so the resolver
does not retain file descriptors in durable state.

Recommended representation and algorithm:

1. Normalize and validate the project-relative spelling, preserve `.` as the root, and run the
   existing component symlink rejection.
2. Walk from the trusted root one normalized component at a time. Record a `same_file::Handle` for
   the root and every existing prefix. At the first `NotFound`, retain the remaining lexical
   components without requiring their creation; any other metadata/open error fails closed.
3. Equality is true for ordinary normalized lexical equality, for two existing endpoints with the
   same handle, or for identical unresolved suffixes beneath the same last-existing handle.
4. Authority overlap is true for ordinary lexical component ancestry, when either existing endpoint
   handle occurs in the other's prefix-handle chain, or when one unresolved suffix is a component
   prefix of the other beneath the same last-existing handle. This covers alternate-case and
   NFC/NFD existing aliases, hard links, existing-directory aliases with future descendants, and
   both ancestor directions. Distinct handles on a case-sensitive filesystem remain distinct.
5. Re-resolve at each durable admission boundary. Two entirely absent, differently spelled leaves
   can conservatively remain lexical until one materializes; the next graph/lease/grant admission
   then observes identity before granting executable authority.

Exact runtime call sites that need the shared root-aware comparison rather than a one-off Software
check are: recursive `validate_field_disjoint`; the
`normalized_project_authority_path`/`project_authority_paths_{equal,overlap}` family and its
`any_*`, ticket-overlap, proof-source-binding, prepared-source-conflict/re-preparation, and
graph-source-write-grant callers; persisted proof-source validation at lease admission; active
prepared-ticket overlap in `acquire_lease`; read-scope repair's amendment-vs-write guard; and the
engine runtime dispatch/admission uses of `Scope::write_conflicts` (the rootless state helper may
remain only as a lexical DTO convenience). A persisted compiled proof member's `source_paths` and
`covered_paths` must be rechecked at lease time so a path alias materialized after emission cannot
retain stale authority.

Required focused regressions: alternate-case existing file, NFC/NFD existing file, alternate-case
existing directory plus missing descendant, both ancestor directions, hard-link equality,
case-sensitive distinct existing handles, symlink rejection, Software no-ticket emission for an
aliased source/covered seam, persisted-ticket lease denial after an alias materializes, and
parallel-dispatch exclusion for aliased write scopes.

Independent private-target verification before this P1 fix: config **70/70**; subset **5/5**;
disjoint filter **8/8**; `unique_by` **1/1**; global safe-feedback filters **2/2**; full Software
proof target **21/21**. These confirm the authored lexical contract and expose why passing tests do
not cover filesystem identity.

## 2026-07-15 — final read-only verdict

- Status: `review_complete_with_findings`; source/config/live-state/binary/TUI surfaces remained
  untouched, and the collaboration journal was the only repository write in this lane.
- Actionable findings are limited to the P1 filesystem-identity authority bypass and the P3 missing
  installed authoring documentation above.
- Apart from the P1 alias class, the generic collection constraints compile and validate
  fail-closed with omission-compatible serialization; MCP schema feedback enforces deterministic
  global detail/path/serialized-byte limits; and the Software 0.5 oracle schema, run/persona
  guidance, ticket scope, compiled check member, and focused regressions agree.
- Scoped `git diff --check` passed for all reviewed Rust, Software template, prompt, test, and
  documentation surfaces. No semantic-rebind range was edited or used to mask a reviewed failure.

## 2026-07-15 — accepted implementation lease

- Status: `in_progress`; the root integrator accepted P1/P3 after the semantic-rebind lease
  released.
- Exact ownership: direct `same-file` workspace/core dependency; the root-aware authority identity
  helper family and its config/graph/ticket/proof-source/admission call sites; focused unit and
  Software integration regressions; `docs/configuration.md`, the installed `configure-koni`
  configuration reference, and append-only coordination notes.
- Coordination boundary: a separate owner may edit only direct-Pi planning/run token aggregation
  and parser ranges. This lane will not run whole-file Rust formatting or touch semantic rebind,
  TUI, live state, binaries, installed projects, processes, worktrees, or cockpit state.

### 2026-07-15 question from `token-ingestion-impl/root`

The disjoint token parser passes a private core-library check and warning-denied library Clippy.
Its focused test build currently reaches your in-progress root-aware signature changes before the
token tests: proof-source authority and maximal-disjoint test call sites still use their former
rootless arguments. Please mark a compile-coherent checkpoint here or message this lane when those
foreign test ranges are ready; the token lane will not edit them or run a whole-file formatter.

## 2026-07-15 — filesystem identity implementation released

- Status: `ready_for_integration`; the accepted P1/P3 follow-up is complete and the bounded
  `engine.rs`/dependency/docs/test lease is released.
- Authority paths now retain project-relative lexical validation and no-follow component checks,
  record short-lived `same_file::Handle` identities for every existing prefix, and compare
  unresolved suffixes conservatively after NFD normalization plus lowercase only when both paths
  share the same deepest existing filesystem identity. Exact equality never uses that
  conservative transform, so an ambiguous missing alias cannot grant authority. Distinct existing
  handles on a case-sensitive filesystem remain distinct.
- The root-aware comparator now governs generic collection `disjoint_from`, proof-source grant
  binding/revalidation, prepared-source conflicts and exact re-preparation, active ticket
  admission, generic read/write-scope admission, maximal-disjoint dispatch, and read-scope repair.
  Current graph validation is reapplied before the lease fast path, so a stale emitted ticket is
  denied before creating a worktree if an alias materializes later.
- Focused regressions cover hard links, conditional existing alternate-case and NFC/NFD aliases,
  missing case/Unicode descendants before first materialization, missing descendants under an
  aliased existing directory, case-sensitive distinct existing files, symlink rejection, generic
  field and runtime-scope identity, aliased parallel dispatch, Software no-ticket emission, and
  Software stale-ticket start denial.
- Authoring contracts for `subset_of`, `disjoint_from`, and `unique_by` are now documented in
  `docs/configuration.md` and the installed `configure-koni` configuration-layer reference,
  including declaration shapes, omission compatibility, root-field references, and filesystem
  alias semantics.
- Private-target verification: core test target compiles; filesystem identity **2/2**; generic
  identity **1/1**; unresolved-alias dispatch **1/1**; subset **5/5**; disjoint **9/9**;
  `unique_by` **1/1**; config **70/70**; full Software proof target **23/23**. Warning-denied
  `cargo clippy --locked -p koni-core --all-targets -- -D warnings` passed. Scoped
  `git diff --check` passed. No whole-file formatter, live state, binary, TUI, project, process,
  worktree, or cockpit mutation was performed.
