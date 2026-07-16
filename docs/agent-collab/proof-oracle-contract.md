# Software proof oracle contract

## 2026-07-15 — active bounded lease (`proof-oracle-contract/root`)

- Status: `in_progress`.
- Exact source/config lease: `crates/koni-cli/templates/software/graph.yaml`,
  `operations.yaml`, and `workflows.yaml`; only the proof-oracle paragraphs in
  `crates/koni-cli/templates/codex/software/agents/run-planner.toml`,
  `change-designer.toml`, `risk-analyst.toml`, `reviewer.toml`, and
  `implementer.toml`; the corresponding proof-contract assertions/helper in
  `crates/koni-core/tests/software_proof_gate.rs`; and only exact matching
  proof-contract additions in `fixtures/updog-repo/.codex/koni/graph.yaml`,
  `operations.yaml`, and `workflows.yaml` if fixture parity requires them.
- Run-type prompt lease: only concise Software-0.5 oracle-case requirements in
  `crates/koni-cli/templates/software/run-types/{small,medium,large,new-feature,bug-fix}.yaml`;
  no model, reasoning, parallelism, question, stage, or intake changes.
- Codex guidance lease: append-only Software-0.5 clarification blocks only in
  `crates/koni-cli/templates/codex/shared/skills/model-koni-work/references/software-projects.md`
  and `execution-contracts.md`; preserve their Software-0.4 wording as transition history.
- Documentation lease: this append-only mailbox, an append-only coordination entry in
  `docs/AGENT_COLLAB.md`, and one append-only Software-0.5 transition at the end of
  `docs/software-profile-engineering.md`. No existing design language will be removed or
  normalized.
- Explicit exclusions: no `engine.rs`, live project/run state, worktree, branch, process, binary,
  TUI/token surface, Research profile, compiler authority broadening, or automatic union of a
  linked system's `owned_paths`.
- Contract: every new Software proof names structured oracle cases binding a condition and claim
  to the invoked production seam, exact project-relative `seam_paths`, action, assertions, and
  any material environment/recipe. `source_paths` remains the only proof/test write authority;
  `covered_paths` remains read-only semantic product coverage; every `seam_path` must be an exact
  member of `covered_paths` before dispatch.
- Compatibility: existing installed profiles remain version-pinned. The bundled default will
  require the richer field for newly generated graph state; legacy live tickets are outside this
  lane and require the separately owned explicit recovery/scope mechanism.
- Coordination sweep: read the central protocol and current claims/status/questions across all
  persona mailboxes, then read the complete current proof-preparation, path-disjointness,
  recovery-dispatch, smoke-efficiency, Software YAML/regression/default-design, and primary-
  integrator deltas before claiming these ranges. Released historical leases remain preserved.

## Questions / dependencies

- The current generic profile expression language cannot compare nested scalar path lists, so
  profile YAML alone cannot mechanically prove `oracle_cases[*].seam_paths ⊆ covered_paths`.
  `primary-integrator/root` owns the narrow generic validator/recovery seam; this lane will expose
  the closed typed field and a focused malformed-proof contract test for that validator rather
  than weakening the requirement to prompt prose.

## 2026-07-15 — version transition decision

The required oracle-case field is a breaking bundled Software graph contract, not a wording-only
tune. The current bundled default therefore evolves from Software `0.4.0` to `0.5.0`; the graph,
operations, and workflows modules evolve with it because their schema, review preconditions, and
step acceptance changed. Rules and checks remain independently versioned at `0.4.0` because their
configured semantics did not change. Existing installed projects remain pinned to their prior
profile source/version and are not rewritten. The repository has no Software-0.4 fixture mirror:
`fixtures/updog-repo` is an intentionally distinct legacy Updog `0.1.x` profile, so changing its
identity would be false parity rather than compatibility.

## 2026-07-15 — implementation complete; lease released

- Status: `ready_for_integration`. The bounded Software profile, prompt, guidance, regression,
  and documentation ranges above are released to `primary-integrator/root`.
- `crates/koni-cli/templates/software/{profile,graph,operations,workflows}.yaml` now ships the
  Software `0.5.0` oracle contract. A proof requires closed structured `oracle_cases`; each case
  names its condition, claim, production seam, exact path list, action, assertions, and optional
  environment/recipe. `oracle_cases[].seam_paths` uses the generic `subset_of` constraint against
  root `spec.covered_paths`.
- The five Software planning/review/implementation personas and all five bundled run-type prompts
  teach the same least-privilege rule. The two model-koni-work references preserve the earlier
  Software-0.4 language and add an adjacent 0.5 transition. No model, reasoning, stage,
  parallelism, question, intake, Research, or live-project configuration changed in this lane.
- `crates/koni-core/tests/software_proof_gate.rs` proves the fail-closed boundary: an exact seam
  omitted from `covered_paths` rejects compilation before a `prepare-proof` ticket exists; adding
  it makes the author step and receipt member read it, while neither the seam nor unrelated linked
  system ownership enters write scope. The shared proof helper now produces valid oracle cases.
- `docs/software-profile-engineering.md` records the append-only 0.5 transition. The legacy
  `fixtures/updog-repo` profile remains untouched because it is not a bundled Software fixture.

### Verification

- Exact oracle regression: **1 passed / 0 failed** (20 filtered), rerun after formatting.
- Complete `software_proof_gate` target: **21 passed / 0 failed**.
- CLI bundled-profile install and embedded-template inventory regressions: **1/1** and **1/1**.
- Ruby YAML parsing passed for the profile, graph, operations, workflows, and all five run types.
- Targeted `rustfmt --check` and scoped `git diff --check` passed. Whole-file formatting of
  `engine.rs` was deliberately left to the active scope-recovery owner; this released lane did not
  edit or format that concurrent range.

### Final coordination sweep

The central registry and current `field-subset-constraint`, `scope-replan-recovery`, and
`primary-integrator` mailboxes were re-read before release. The generic subset owner reports its
validator and broker-safe projection complete and released, including normalized nested field
diagnostics. The legacy recovery owner still exclusively owns its engine range. No unanswered
cross-lane question or contract conflict remains.
