# Oracle/subset contract independent review

## 2026-07-15 22:34 MST — read-only review handoff (`oracle-subset-review/root`)

- Status: `review_complete_with_findings`; no Rust, profile, fixture, live run, binary, process,
  worktree, branch, or cockpit state was changed.
- Reviewed surfaces: generic recursive `FieldDef.subset_of` compilation/runtime validation and
  MCP-safe projection; bundled Software 0.5 proof schema, operations, workflows, prompts, run-type
  guidance, version transition, receipt/check compilation, and focused regressions.
- Coordination boundary: the active `scope-replan-recovery` / semantic-rebind ranges in
  `engine.rs` were not edited or formatted. This review is source-read-only except for these
  append-only coordination notes.

### Findings

1. **P1 — a covered production seam can still become proof-source write authority.**
   Software declares `source_paths` writable proof/test files and `covered_paths` read-only product
   files (`templates/software/graph.yaml:224-233`), but no compiler rule requires the two path sets
   to be disjoint. The preparation workflow projects `source_paths` to `write_paths` while also
   projecting `covered_paths` to reads (`workflows.yaml:82-96`). Graph-set compilation resolves both
   sets and checks only that both fit inside read authority (`engine.rs:49611-49630`); the existing
   source-write conflict check compares source grants only with *other write grants*, not covered
   read paths (`engine.rs:49412-49451`). Therefore a diagnostic or boundary proof may put a seam
   file, its parent directory, or an overlapping child in both fields; preparation can then modify
   the production seam despite the Software-0.5 read-only guarantee. The new regression proves the
   intended disjoint example only (`software_proof_gate.rs:216-258`). Reject equality and both path-
   prefix containment directions between each compiled member's source and covered paths, ideally
   through a generic profile-declared path-disjointness primitive or generic graph-set invariant,
   and add diagnostic/boundary regressions for all three overlap shapes.

2. **P1 — the advertised eight-path MCP diagnostic bound is per validation line, not global.**
   `MAX_SAFE_SCHEMA_SUBSET_PATHS` limits one parsed diagnosis to eight paths
   (`engine.rs:37451-37525`), but `agent_mcp_schema_validation_details` inserts every distinct
   rendered subset error into an unbounded `BTreeSet` and returns all of them
   (`engine.rs:37589-37730`); `agent_mcp_safe_error` then joins the entire set
   (`engine.rs:37749-37755`). Multiple invalid nodes or oracle-case lists can therefore project
   many groups of eight paths and a request-sized correction message across the broker boundary.
   Apply one global detail/path/byte budget with a deterministic omitted-count marker and test
   multiple distinct subset failures, not only one two-path line.

3. **P2 — Software says “exact/verbatim,” while Path subsets intentionally use normalized
   identity.** The validator normalizes path scalars before comparison (currently
   `normalized_subset_scalar` in `engine.rs`), and the generic regression deliberately accepts
   `src/./consumer.tsx` against `src/consumer.tsx`. Software's schema and prompts instead promise an
   exact/verbatim member (`graph.yaml:237,261-266`; matching agent/run-type prose). This does not
   broaden authority for dot-segment aliases, but it overstates the mechanical contract and makes
   agent guidance disagree with diagnostics. Either enforce raw canonical spelling or consistently
   say “same normalized project-relative path identity”; the latter matches compiled check path
   normalization.

4. **P2 — oracle-case IDs are described as unique but uniqueness is not enforced.**
   `graph.yaml:244-248` requires and pattern-checks each ID but has no list-level uniqueness
   constraint; neither generic field validation nor the Software regression rejects duplicate case
   IDs. Duplicate labels make review/rework references ambiguous even though seam coverage still
   validates. Add a generic `unique_by`/unique-item property contract, or remove the uniqueness
   claim if IDs are intentionally display-only.

5. **P3 — the new generic primitive is not in user-facing profile-authoring guidance.** A repository
   search finds `subset_of` only in source/profile YAML and coordination notes, not the installed
   `configure-koni` references or general configuration docs. Add its same-root, compatible
   `list<string|path>`, recursive-instance, and normalized-path semantics so custom profiles can use
   the primitive without reverse-engineering Software.

### Accepted behavior and compatibility assessment

- Omission of `subset_of` is serde-compatible. Profile compilation validates the constrained and
  referenced fields as same-node compatible scalar lists; graph validation is recursive and fails
  before rule/ticket dispatch.
- The Software profile correctly moves the profile plus graph/operations/workflows modules to
  `0.5.0`, leaves unchanged rules/checks at `0.4.0`, and does not rewrite the distinct legacy Updog
  fixture. Existing installs remain pinned unless the user explicitly replaces configuration.
- No linked system `owned_paths` union exists. In the intended disjoint case, the seam enters the
  author step's read scope and compiled member `covered_paths`, unrelated system ownership stays
  out, and only proof `source_paths` enter write scope.
- `CompiledCheckMember.source_semantic_hash` binds the complete proof semantic projection, including
  `oracle_cases`; its contract hash also binds normalized `covered_paths`. Current preparation
  re-compiles and compares that set, so oracle/path declaration drift revokes preparation while
  covered product-byte evolution retains the deliberately historical source preparation.

### Verification note

The owning lanes report subset **5/5**, config **69/69**, broker-safe **3/3**, Software proof
**21/21**, and warning-denied Clippy. An independent private-target `cargo test -p koni-core subset
--lib` attempt at 22:34 MST was intentionally treated as nondiagnostic: it compiled while the
separately owned semantic-rebind lane had calls to not-yet-published helper definitions and failed
with twelve missing-symbol errors in that active range. No reviewed subset/oracle symbol failed,
and no source was changed to work around concurrent partial edits. Re-run the focused tests after
the rebind owner publishes a coherent save point.

## 2026-07-15 22:43 MST — accepted hardening implementation lease

- Status: `in_progress` under `oracle-subset-review/root` after the independent findings were
  accepted by `primary-integrator/root`.
- Exact config lease: optional `FieldDef.disjoint_from` and `FieldDef.unique_by`, their recursive
  profile-definition validation and focused config tests in `crates/koni-core/src/config.rs`.
- Exact engine lease: the already released generic field-value validator helpers plus focused
  tests, and the released MCP safe-schema projection helpers plus focused tests in
  `crates/koni-core/src/engine.rs`. `scope-replan-recovery/root` confirmed these ranges are disjoint
  from its action/rebind helpers and tail tests at a coherent save point. No whole-file formatter
  will run while that lease is active.
- Exact Software lease: proof field declarations and normalized-path wording only in
  `crates/koni-cli/templates/software/graph.yaml`; matching exact/verbatim oracle-path wording in
  the five Software agents, five run types, operations/workflows, installed model-koni-work
  references, `docs/software-profile-engineering.md`, and the focused
  `crates/koni-core/tests/software_proof_gate.rs` regression. Software remains unreleased `0.5.0`.
- Contract: `disjoint_from` is declared in one direction. Compatible `list<string>` values reject
  exact intersection; compatible `list<path>` values reject equality and either normalized
  ancestor/descendant authority overlap. `unique_by` compiles only for `list<object>` whose named
  property is declared, required, scalar, and suitable for stable identity; runtime diagnostics
  expose only field shape and duplicate count, never raw values. Omission remains legacy-
  compatible.
- Safe projection contract: deterministic global caps independently bound total details, total
  disclosed paths, and final UTF-8 message bytes, with an omission count. Per-line caps remain
  defense in depth but cannot be mistaken for the global boundary.
- Exclusions: no recovery/rebind/grant/action code, Research or legacy Updog profile, TUI, live
  run/project state, worktree, process, binary, global install, or cockpit mutation.

## 2026-07-15 22:58 MST — hardening complete; lease released

- Status: `ready_for_integration`; the config, field-validator, safe-schema, Software text/schema,
  focused test, and append-only documentation leases are released.
- Generic config: optional `disjoint_from` and `unique_by` serialize only when configured, so
  omission preserves legacy profile behavior. Profile compilation requires compatible same-node
  `list<string|path>` fields for disjointness and a declared, required, direct scalar item property
  for `list<object>.unique_by`.
- Generic runtime: string disjointness uses exact identity; path disjointness uses normalized
  authority overlap and rejects equality or either ancestor/descendant direction. Duplicate object
  identities fail graph validation by field, property, and count without echoing raw values.
- Safe MCP feedback: schema correction output is deterministically capped at 12 distinct details,
  eight total disclosed normalized paths, and 4 KiB for the serialized complete safe-error
  response. Byte trimming removes complete detail strings only and always reports the omitted
  distinct-error count.
- Software 0.5: `proof.source_paths` is disjoint from `spec.covered_paths`, `oracle_cases` is unique
  by `id`, and schema/planning/review/run-type guidance consistently describes normalized
  project-relative membership. The version remains the unreleased `0.5.0`; installed projects are
  untouched.
- Private-target verification: config **70/70**; subset **5/5**; disjoint filter **8/8**; unique
  runtime **1/1**; broker-safe **6/6**; exact Software oracle/scope regression **1/1**; complete
  Software proof target **21/21**. Owned Rust ranges pass read-only rustfmt checks, and the wording
  sweep found no remaining raw exact/verbatim `seam_paths` membership promise.
- Warning-denied core Clippy found and prompted correction of this lane's sole suggestion
  (`selected.pop()?`). Its remaining two diagnostics were in the active semantic-rebind helper
  lease and were handed to `scope-replan-recovery/root`; no foreign range was edited. No live
  state, process, binary, TUI, Research/Updog profile, or installed project changed.
