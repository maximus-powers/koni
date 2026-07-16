# Final Integration Verification Matrix

Owner: `integration-matrix/root`

Status: `complete` (read-only matrix design; guarded refresh is **blocked** on the open gates below)

Last checked: 2026-07-14 (Phoenix)

## Mission and safety boundary

Define one reproducible focused-to-full verification sequence for the current shared dirty tree.
The matrix maps every active or released implementation family to its smallest meaningful test,
then to the package and workspace suites that can expose cross-slice regressions. It also separates
source verification from commands that install a binary, replace a profile, control a cockpit, or
start token-spending work.

This lane owns only this mailbox. It does not edit Rust, profiles, templates, product docs, the
central registry, the installed binary, cmux, Updog, or live/forensic run state. Existing design
history remains visible; later results should be appended below rather than replacing this matrix.

## Repository and toolchain inventory

The workspace has three packages and these Cargo targets:

| Package | Targets |
| --- | --- |
| `koni-core` | library plus `research_conclusion_contract`, `research_epistemic_profile`, `research_profile`, `research_result_contracts`, `run_lifecycle`, `software_proof_gate`, and `updog_profile` integration tests |
| `koni-cli` | the `koni` binary and its unit/template/install tests |
| `koni-tui` | the TUI library and the `populated_showcase` example |

The audited host is Darwin arm64 with Cargo/Rust `1.96.1`; `/usr/bin/sandbox-exec`, `codex`, and
`cmux` are present. This matters because a complete core result on this host includes Seatbelt,
process-birth-identity, process-group, crash-recovery, broker-subprocess, pause, and delete tests.
A result from a restricted agent sandbox that cannot signal or inspect child processes is useful
diagnosis, but it is not the final macOS integration result.

## Current release verdict

**Do not install, replace an Updog profile, or restart the cockpit yet.** The current source and
documentation gates are not closed:

1. `context-spec/root` still owns its core/CLI/profile lease. Its optional compatibility lookup
   still resolves a registry-supplied project root before proving that the caller and resolved
   checkout share the same Git common directory. The cross-repository corruption regression does
   not yet exist.
2. The full core library still has three known stale Research fixture failures. The exact fixture
   reconciliation is specified in `research-fixture-audit.md`, but the three `engine.rs` test bodies
   cannot be edited until the context owner releases them.
3. `graph-seed-review.md` found five trust-boundary gaps not covered by the earlier green approval
   suite: hidden-node titles can leak through relationships; scalar raw spec/schema/key metadata
   can render; wrapped/prefixed hashes and UUIDs can evade redaction; local keys can survive as
   substrings; and a post-approval non-planning output can replace the approved seed projection.
4. The TUI Evidence/runtime implementation is source-green at 283/283 according to the latest
   backlog entry, but its central/persona lease still says `in_progress`. Source presence and a
   green run are not an implicit handoff.
5. Generic graph-local proof compilation remains design-only. No exact config shape, selector
   implementation, or focused acceptance test has been released.
6. Software `0.4.0` is accepted design, not shipped source. The current bundled profile is still
   `0.3.0` and its catalog still contains only `small`, `medium`, and `large`; no `new-feature` or
   `bug-fix` files or focused five-run-type acceptance test exist.
7. `docs-release-audit.md` records six definite documentation/status blockers. In particular,
   Graph Seed visibility is still described as in progress, the canonical composite worker
   boundary lacks its adjacent history note, reciprocal Research gate cleanup is still unchecked,
   and central/live-smoke Research status no longer matches the current failure set.
8. Versioned bundled baselines plus project overlays remain queued. A green binary test suite does
   not make a generic whole-profile `--replace` safe for local project customizations.

### 2026-07-14 — current reconciliation of the earlier verdict

The numbered list above is retained as the integration snapshot that produced this matrix. Later
owner handoffs narrow it as follows; they do not erase the earlier blockers or make a frozen-tree
claim:

- Graph Seed item 3 is source-repaired in `model.rs`. The five named adversarial regressions are
  now present and green; the seven-test `graph_seed` set, 25-test `approval` set, and exact approved
  Plan reuse test are green. The exact focused commands and order are recorded in section B.
- The independent Graph Seed review ran the full TUI while the Evidence/runtime owner was still
  editing and observed 277 passed / 2 failed. The two failures were exactly
  `overview_composes_objective_run_and_evidence_before_preserving_ticket_focus` and
  `recent_activity_shows_row_timestamps_and_only_active_runtime_in_its_header`, both inside that
  active slice and neither exercising Graph Seed. The owner later reported a 283/283 candidate,
  but the final matrix still requires a fresh zero-failure run after its explicit release.
- Documentation item 7 has narrowed from six blockers to only audit items 1–3, all owned by
  `context-spec/root`: the adjacent Graph Seed completion records in `configuration.md` and
  `philosophy.md`, and the source-complete `submit_and_compile` evolution record in
  `codex-resources.md`. Items 4–8 were reconciled append-preservingly. The context owner has now
  posted a closure candidate for 1–3; the documentation gate remains those three until the
  read-only documentation auditor re-reads and accepts the adjacent notes.
- The unrestricted full-core baseline remains exactly 434 passed / 3 failed / 3 ignored. The
  failures are only the three stale Research runtime fixture bodies named in section D. This is a
  stable diagnostic baseline, not a green release result.

Any focused command below that previously passed is historical evidence only until it is rerun
against one frozen, released source snapshot.

## Test-target isolation

Every active lane should use a private target directory, for example:

```sh
export CARGO_TARGET_DIR=/tmp/koni-matrix-context-20260714
export CARGO_TARGET_DIR=/tmp/koni-matrix-tui-20260714
export CARGO_TARGET_DIR=/tmp/koni-matrix-software-20260714
```

Do not share a target directory with another active agent, delete another lane's target, or point
`CARGO_TARGET_DIR` into this repository or Updog. Once every source lease is released, use one new
final directory for the complete matrix and reuse it for every final command:

```sh
export CARGO_TARGET_DIR=/tmp/koni-matrix-final-20260714
```

Final commands use `--locked` so verification cannot silently update `Cargo.lock`. Capture the
source fingerprint before and after the final sequence; the two hashes must match:

```sh
git ls-files --cached --others --exclude-standard -z \
  | xargs -0 shasum -a 256 \
  | LC_ALL=C sort \
  | shasum -a 256
```

If another agent changes a hashed file during the matrix, discard the aggregate claim, wait for
the new handoff, and rerun the affected focused tests plus every downstream full gate.

## Side-effect classification

| Class | Commands | Effects and authority |
| --- | --- | --- |
| Source-read-only | `cargo metadata`, `cargo fmt -- --check`, `git diff --check`, brand audit, skill validation | Reads the source tree. Disable Python bytecode for skill validation. |
| Isolated build/test | `cargo check`, `cargo test`, `cargo build` with a `/tmp` target | Writes compiled artifacts beneath `CARGO_TARGET_DIR` and uses OS temp directories. Tests create temporary Git repositories/worktrees and profile installs; they are not intended to modify checked-in fixtures. |
| Host-process integration | full `koni-core`, `run_lifecycle`, `research_profile`, and the exact installed-Codex ignored test | May spawn, inspect, signal, wait for, or hard-stop owned child process groups and may invoke `/usr/bin/sandbox-exec`. Run only with normal macOS process authority. |
| Interactive but run-state read-only | source-built `populated_showcase`, cockpit JSON, profile/run validation | May open a terminal or inspect a configured project. Do not confuse visual inspection with an automated regression gate. |
| External mutation | `cargo install`, real `koni init/install --replace`, `koni recover`, cockpit termination/restart, pause/play/delete/merge, fresh smoke runs | Writes the installed binary, project resources, run state, processes, refs, worktrees, or spends model tokens. These begin only after the source gate and their own safety preflight. |

`updog_profile` copies the checked-in fixture into a temporary directory before initializing Git.
CLI install/migration tests likewise publish only into temporary directories. Research parity tests
read the authored and packaged trees. A checked-in fixture change after tests is therefore a defect,
not an expected side effect.

### Ignored-test trap

The core library currently has three ignored tests. Two are child entry points
(`report_publication_hard_crash_child` and `composed_broker_subprocess`) and must never be launched
as a blanket ignored suite. Do **not** run `cargo test ... --ignored` without an exact test name.
The one real host integration check is safe to invoke exactly:

```sh
cargo test --locked -p koni-core \
  codex_preflight::tests::installed_codex_accepts_the_exact_two_pass_boundary \
  --lib -- --ignored --exact --nocapture
```

## Focused-to-full matrix

### A. Living specification, context, notes, and compatibility registry

Covers the active context slice, released graph-note hardening, durable steering, broker tools,
and the compatibility-run repair.

```sh
cargo test --locked -p koni-core planning_graph_seed --lib -- --nocapture
cargo test --locked -p koni-core engine::tests::approved_planning_seed_materializes_deterministic_profile_valid_nodes --lib -- --exact --nocapture
cargo test --locked -p koni-core engine::tests::graph_context_and_notes_are_ticket_scoped_advisory_supplements --lib -- --exact --nocapture
cargo test --locked -p koni-core engine::tests::working_memory_prefers_newest_current_notes_under_a_tight_budget --lib -- --exact --nocapture
cargo test --locked -p koni-core graph_note --lib -- --nocapture
cargo test --locked -p koni-core engine::tests::broker_binds_ordered_graph_supplement_receipts_to_worker_output --lib -- --exact --nocapture
cargo test --locked -p koni-core engine::tests::latest_human_plan_revision_is_a_durable_approved_constraint --lib -- --exact --nocapture
cargo test --locked -p koni-core engine::tests::rendered_lead_prompt_receives_only_semantic_approved_planning_handoff --lib -- --exact --nocapture
cargo test --locked -p koni-core state::tests::existing_run_lookup_does_not_create_a_project_registry --lib -- --exact --nocapture
cargo test --locked -p koni-cli agent_mcp::tests --bin koni -- --nocapture
cargo test --locked -p koni-cli graph_resource --bin koni -- --nocapture
cargo test --locked -p koni-tui app::tests::action_engine_accepts_only_the_matching_compatibility_run --lib -- --exact --nocapture
```

The cross-repository registry-pointer regression is a hard missing gate. Its owner must add and
publish an exact test name. A broad filter that runs zero tests is not evidence; the final log must
show one matching test executed and passed. After this focused group, expand to:

```sh
cargo test --locked -p koni-core --lib -- --nocapture
cargo test --locked -p koni-cli --bin koni -- --nocapture
cargo test --locked -p koni-tui --lib -- --nocapture
```

### B. TUI control-center integration

Covers equal columns, composed Overview, phase-aware Plan, adaptive approval, provisional runs,
Lead history, New Run stage reachability, truthful ticket completion, Evidence/runtime truth, and
the Graph Seed approval surface.

```sh
cargo test --locked -p koni-tui ui::tests::operate_layout_conditionally_splits_questions_and_keeps_graph_at_82x24 --lib -- --exact --nocapture
cargo test --locked -p koni-tui ui::tests::objective_collapses_to_four_lines_and_expands_without_truncation --lib -- --exact --nocapture
cargo test --locked -p koni-tui ui::tests::overview_composes_objective_run_and_evidence_before_preserving_ticket_focus --lib -- --exact --nocapture
cargo test --locked -p koni-tui ui::tests::approval_revision_editor_wraps_steering_and_shows_one_adaptive_action --lib -- --exact --nocapture
cargo test --locked -p koni-tui app::tests::new_run_enter_submits_only_from_the_start_button_and_closes_on_acceptance --lib -- --exact --nocapture
cargo test --locked -p koni-tui model::tests::semantic_lead_row_survives_between_slices_without_raw_lead_duplicates --lib -- --exact --nocapture
cargo test --locked -p koni-tui new_run --lib -- --nocapture
cargo test --locked -p koni-tui ticket --lib -- --nocapture
cargo test --locked -p koni-tui graph::tests --lib -- --nocapture
cargo test --locked -p koni-tui ui::tests::delete_run_objective_preview_is_capped_at_two_lines --lib -- --exact --nocapture
cargo test --locked -p koni-tui ui::tests::cancelled_and_superseded_tickets_do_not_synthesize_completed_steps --lib -- --exact --nocapture
cargo test --locked -p koni-tui ui::tests::report_health_requires_complete_telemetry_and_recorded_evidence --lib -- --exact --nocapture
cargo test --locked -p koni-tui ui::tests::active_runtime_requires_a_durable_approval_anchor_and_explicit_duration --lib -- --exact --nocapture
cargo test --locked -p koni-tui ui::tests::recent_activity_omits_unanchored_runtime_but_preserves_approved_zero --lib -- --exact --nocapture
cargo test --locked -p koni-core control::tests::orchestration_active_runtime_excludes_every_paused_interval --lib -- --exact --nocapture
```

The five Graph Seed regressions named by the independent review are mandatory, not optional
coverage. Run each by exact name after it exists:

```sh
cargo test --locked -p koni-tui model::tests::graph_seed_relationships_never_reveal_nodes_outside_projection_limit --lib -- --exact --nocapture
cargo test --locked -p koni-tui model::tests::graph_seed_projection_rejects_scalar_raw_spec_and_schema_fields --lib -- --exact --nocapture
cargo test --locked -p koni-tui model::tests::graph_seed_projection_rejects_markdown_wrapped_and_prefixed_identifiers --lib -- --exact --nocapture
cargo test --locked -p koni-tui model::tests::graph_seed_projection_never_exposes_embedded_local_key_substrings --lib -- --exact --nocapture
cargo test --locked -p koni-tui model::tests::approved_plan_ignores_graph_seed_shaped_outputs_from_post_approval_stages --lib -- --exact --nocapture
cargo test --locked -p koni-tui approval --lib -- --nocapture
cargo test --locked -p koni-tui ui::tests::plan_panel_switches_from_live_activity_to_the_approved_human_plan --lib -- --exact --nocapture
cargo test --locked -p koni-tui --lib -- --nocapture
```

#### 2026-07-14 — Graph Seed focused repair checkpoint

The earlier “after it exists” wording is retained above because it records the pre-repair gate.
All five exact regressions now exist. The current focused checkpoint, in order, is:

```sh
export CARGO_TARGET_DIR=/tmp/koni-matrix-graph-seed-final-20260714
cargo test --locked -p koni-tui graph_seed --lib -- --nocapture
cargo test --locked -p koni-tui approval --lib -- --nocapture
cargo test --locked -p koni-tui \
  ui::tests::plan_panel_switches_from_live_activity_to_the_approved_human_plan \
  --lib -- --exact --nocapture
```

Latest owner/reviewer evidence is 7/7 for the `graph_seed` filter, 25/25 for `approval`, and 1/1
for exact approved Plan reuse. Those results close the five model-level Graph Seed blockers: edge
labels cannot disclose omitted nodes; scalar spec/schema/key metadata is suppressed; wrapped or
prefixed long hashes/UUIDs are rejected; embedded local-key substrings fail closed; and later
non-planning outputs cannot replace the approved planning seed.

The independent review's last full result was 277 passed / 2 failed while the truthfulness owner
was mid-edit; the later backlog reports 283/283. The final accepted count is whatever the frozen
tree actually executes after both owners explicitly release, with zero failures and no vanished
tests. Record the count rather than copying either historical number.

For that active-slice transition, keep the exact two regressions visible and run them before the
full package gate:

```sh
cargo test --locked -p koni-tui \
  ui::tests::overview_composes_objective_run_and_evidence_before_preserving_ticket_focus \
  --lib -- --exact --nocapture
cargo test --locked -p koni-tui \
  ui::tests::recent_activity_shows_row_timestamps_and_only_active_runtime_in_its_header \
  --lib -- --exact --nocapture
cargo test --locked -p koni-tui --lib -- --nocapture
```

At the independent review checkpoint, the first two commands are the expected failures belonging
to the still-active Evidence/runtime slice. They are not waived: after that owner releases, all
three commands must exit zero in the same isolated target and frozen source snapshot.

### C. Compiler/runtime safeguards and lifecycle

Covers strict schema decoding, target-pipeline order, sanitized retry diagnostics, bounded review
rework, worker no-output circuit breaking, terminal-resolver compensation, and exact promotion.

```sh
cargo test --locked -p koni-core config::tests --lib -- --nocapture
cargo test --locked -p koni-core catalog::tests --lib -- --nocapture
cargo test --locked -p koni-core pipeline::tests --lib -- --nocapture
cargo test --locked -p koni-core broker_safe --lib -- --nocapture
cargo test --locked -p koni-core review_rework_circuit --lib -- --nocapture
cargo test --locked -p koni-core failed_review --lib -- --nocapture
cargo test --locked -p koni-core worker_no_output_circuit --lib -- --nocapture
cargo test --locked -p koni-core terminal_recovery_dispatch --lib -- --nocapture
cargo test --locked -p koni-core verification::tests --lib -- --nocapture
cargo test --locked -p koni-core git::tests::promotion_rejects_a_run_ref_advance_after_preflight --lib -- --exact --nocapture
cargo test --locked -p koni-core git::tests::squash_integration_projects_nonconflicting_ticket_lifecycle_lanes --lib -- --exact --nocapture
cargo test --locked -p koni-core git::tests::squash_integration_prefers_configured_ticket_projection_on_add_add_conflict --lib -- --exact --nocapture
cargo test --locked -p koni-core --test run_lifecycle -- --nocapture
```

`run_lifecycle` must retain at least the released 49-test exact-head/reopen/CAS closure and pass any
new cases added afterward. Then run the entire core library; a focused green cannot waive a full
core failure.

### D. Research profile and verifier integration

The three stale unit fixtures are the first gate after the context lease releases:

```sh
cargo test --locked -p koni-core engine::tests::configured_run_step_executes_and_writes_its_runtime_receipt --lib -- --exact --nocapture
cargo test --locked -p koni-core engine::tests::scientific_measurements_artifacts_and_receipt_integrity_are_bound --lib -- --exact --nocapture
cargo test --locked -p koni-core engine::tests::changed_scientific_input_makes_current_receipt_false_and_reopens_run_work --lib -- --exact --nocapture
```

Their green form must retain historical `scientific-runtime`, add the distinct read-only
`scientific-result-integrity` command, and never make the side-effecting empirical command an
automatic composed replay. Then run every Research target and source/template parity:

```sh
cargo test --locked -p koni-core --test research_result_contracts -- --nocapture
cargo test --locked -p koni-core --test research_conclusion_contract -- --nocapture
cargo test --locked -p koni-core --test research_epistemic_profile -- --nocapture
cargo test --locked -p koni-core --test research_profile -- --nocapture
cargo test --locked -p koni-cli tests::research_source_and_install_template_are_recursively_in_sync --bin koni -- --exact --nocapture
cargo test --locked -p koni-cli tests::research_native_agents_embed_exact_authored_persona_instructions --bin koni -- --exact --nocapture
cargo test --locked -p koni-cli tests::installs_bundled_profiles_without_touching_product_state --bin koni -- --exact --nocapture
```

The released baselines are result 3/3, conclusions 3/3, epistemic 4/4, and Research profile 20/20.
Later added cases may increase those counts; a decrease requires explanation. This group also
closes the canonical reciprocal gate relation and the duplicate ticket-lifecycle lane.

The current unrestricted package checkpoint is intentionally recorded beside those independently
green Research targets:

```sh
export CARGO_TARGET_DIR=/tmp/koni-matrix-core-baseline-20260714
cargo test --locked -p koni-core --lib -- --nocapture
```

Latest result: **434 passed / 3 failed / 3 ignored**. The failed rows are exactly the three fixture
commands at the start of this section. After their test-only reconciliation, rerun those three
exact commands first and then the full library command. A refresh requires the transition from
434/3/3 to zero failures while retaining the same three audited ignored child/host rows in the
ordinary run.

### E. Software profile, proof, and CLI installation

The currently released `0.3.0` safeguards remain mandatory:

```sh
cargo test --locked -p koni-core --test software_proof_gate -- --nocapture
cargo test --locked -p koni-core --test updog_profile -- --nocapture
cargo test --locked -p koni-core engine::tests::git_common_rework_validates_edge_only_corrections_against_superseded_candidates --lib -- --exact --nocapture
cargo test --locked -p koni-cli templates::tests --bin koni -- --nocapture
cargo test --locked -p koni-cli tests::installs_bundled_profiles_without_touching_product_state --bin koni -- --exact --nocapture
cargo test --locked -p koni-cli tests::embedded_profile_inventory_matches_package_templates --bin koni -- --exact --nocapture
cargo test --locked -p koni-cli init_ --bin koni -- --nocapture
cargo test --locked -p koni-cli --bin koni -- --nocapture
```

These commands cannot certify Software `0.4.0` while they still assert only three run types. The
Software redesign and generic graph-proof compiler must add focused executable acceptance for:

- profile version `0.4.0` and exactly five selectable run types;
- Medium-derived `new-feature` and `bug-fix` behavior;
- conditional architecture/contract emission;
- direct specialist graph production without transcription-only Integrator steps;
- active `focused`/`boundary` proof purpose and deterministic graph-local check selection;
- structural mitigation or reviewed risk acceptance before delivery;
- expected-red runner exit contracts without wrong-reason acceptance;
- `candidate_ready` before target sync, then exact fresh composed verification and promotion;
- no Research source/template changes caused by the Software migration.

No exact focused commands exist for those future assertions today. That absence is itself a red
gate. The owners must publish exact test names and results in their mailboxes before the final
matrix can be updated; a passing old installer/template test is not a substitute.

### F. Native Codex resources and packaged skills

Run the embedded inventory test above, then validate every shipped shared skill without writing
Python bytecode:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 \
  /Users/max/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  crates/koni-cli/templates/codex/shared/skills/configure-koni
PYTHONDONTWRITEBYTECODE=1 python3 \
  /Users/max/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  crates/koni-cli/templates/codex/shared/skills/model-koni-work
PYTHONDONTWRITEBYTECODE=1 python3 \
  /Users/max/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  crates/koni-cli/templates/codex/shared/skills/operate-koni
```

The exact installed-Codex preflight command in the ignored-test warning is the host-level
expansion. It must pass with the locally installed Codex binary before binary refresh.

### G. Documentation and decision-history release

Whitespace checks are necessary but cannot prove the append-preserving history contract:

```sh
git diff --check
./scripts/check-brand.sh
```

Because many files are still untracked, `git diff --check` alone omits them. Use a non-mutating
no-index check for every untracked file and fail only on diagnostics or a true command error:

```sh
bad=0
while IFS= read -r -d '' file; do
  output="$(git diff --no-index --check /dev/null "$file" 2>&1)"
  code=$?
  if [ "$code" -gt 1 ] || [ -n "$output" ]; then
    printf '%s\n' "$file" "$output"
    bad=1
  fi
done < <(git ls-files --others --exclude-standard -z)
test "$bad" -eq 0
```

Before release, the owning personas must append—not rewrite—the six transitions in
`docs-release-audit.md`, re-read the affected paragraphs, and update their own/central statuses.
The docs gate is green only when a final read confirms:

- Graph Seed visibility history says the sanitized projection landed while retaining its former
  in-progress note and incorporating the adversarial fixes;
- the old `submit_output` + `compile` boundary remains compatibility history beside the
  source-complete `submit_and_compile` boundary;
- both reciprocal Research gate rows are resolved without deleting the original requests;
- conclusion contracts are recorded as green while the three separate runtime-fixture failures
  are closed by their own results;
- Research profile and duplicate-lifecycle lanes no longer claim to await a broken shared compile;
- accepted Software `0.4.0` remains labeled future until its source and focused tests actually
  release.

### 2026-07-14 — documentation-gate transition

The six-item wording above is retained as the original audit result. Items 4–6 are now reconciled
in their owning documents and central registry without removing the earlier statements; the two
non-blocking items 7–8 are reconciled as well. The only current documentation blockers are the
context-owned items 1–3:

1. `configuration.md` must retain its former transition-in-progress statement beside the dated
   completed Graph Seed visibility contract.
2. `philosophy.md` must retain its former “gaining/not yet shipped” statement beside the dated
   completed operator-visibility and trust-boundary contract.
3. `codex-resources.md` must retain the old `submit_output` + `compile` boundary beside the
   source-complete canonical `submit_and_compile` boundary, while leaving fresh live token-cost
   proof pending.

`context-spec/root` has appended a closure candidate for all three and reports path-scoped
whitespace checks green. The current final step is read-only: the documentation auditor must
re-read those adjacent paragraphs and explicitly accept them. Until that verdict is appended,
these three—not the already resolved items 4–8—remain the documentation gate.

## Immediate integration order from the current shared tree

This is the shortest non-mutating route from the current checkpoints to the frozen-source gate:

1. Wait for every active source owner to publish an explicit release; record the source
   fingerprint. Do not infer release from source presence or a passing focused test.
2. In a fresh Graph Seed target, run the 7-test `graph_seed` filter, 25-test `approval` filter,
   and exact approved Plan reuse command from section B.
3. After the Evidence/runtime owner releases, run its two exact formerly failing regressions,
   then full `koni-tui --lib`; require zero failures. The 277/2 and 283/283 counts remain dated
   checkpoints, not substitutes for this run.
4. After the context owner releases the three Research fixture bodies, run the three exact tests
   at the start of section D, then full `koni-core --lib`; require the current 434/3/3 baseline to
   become zero failed / three ignored.
5. Have the documentation auditor accept the three context-owned closure candidates. Re-run the
   tracked and untracked whitespace checks plus the brand audit.
6. Execute the complete frozen-source sequence below in one new `CARGO_TARGET_DIR`, then compare
   the ending fingerprint with the starting fingerprint.
7. Only after every source/docs command is green may the primary integrator begin the separate
   binary/profile/cockpit preflight. No profile replacement is authorized merely by this matrix.

## Frozen-source final gate

Start only after every source owner marks its exact lease released, the central ledger has no
implementation blocker for this refresh, the documentation audit is reconciled, and the source
fingerprint is recorded.

Run, in order, using the one final `CARGO_TARGET_DIR`:

```sh
cargo metadata --locked --no-deps --format-version 1 > /tmp/koni-final-metadata.json
cargo fmt --all -- --check
git diff --check
./scripts/check-brand.sh

cargo test --locked -p koni-core --lib -- --nocapture
cargo test --locked -p koni-core --test run_lifecycle -- --nocapture
cargo test --locked -p koni-core --test research_result_contracts -- --nocapture
cargo test --locked -p koni-core --test research_conclusion_contract -- --nocapture
cargo test --locked -p koni-core --test research_epistemic_profile -- --nocapture
cargo test --locked -p koni-core --test research_profile -- --nocapture
cargo test --locked -p koni-core --test software_proof_gate -- --nocapture
cargo test --locked -p koni-core --test updog_profile -- --nocapture

cargo test --locked -p koni-cli --bin koni -- --nocapture
cargo test --locked -p koni-tui --lib -- --nocapture

cargo test --locked -p koni-core \
  codex_preflight::tests::installed_codex_accepts_the_exact_two_pass_boundary \
  --lib -- --ignored --exact --nocapture

cargo test --locked --workspace --all-targets -- --nocapture
cargo test --locked --workspace --doc -- --nocapture
cargo build --locked --release -p koni-cli
```

Also run the three skill validators and the untracked-file whitespace helper from the prior
sections. Recompute the source fingerprint afterward. Minimum acceptance is:

- every command exits zero;
- no focused filter executes zero tests;
- full core has zero failures; only the three audited ignored rows remain ignored in the ordinary
  run, and the real installed-Codex row passes separately;
- every integration target has zero failures and no unexplained count regression;
- CLI and TUI have zero failures;
- workspace all-targets, doctests, formatting, brand, skill, tracked, and untracked checks pass;
- the release binary builds from the same unchanged source fingerprint;
- all test output and metadata are retained for the guarded-refresh handoff.

## Binary/profile/cockpit handoff

The following sequence is deliberately outside the source-green claim because it mutates external
state:

1. Recheck both forensic Updog runs remain `running: false`, `draining: false`, have zero verified
   active agents, and have no process command line containing either run ID. Never resume them.
2. Confirm only the intended cockpit is on cmux `surface:97`; preserve chat and other agents'
   surfaces. Stop only the isolated cockpit process group after zero active agents is proven.
3. Install with the lockfile: `cargo install --locked --path crates/koni-cli --force`. Confirm
   `~/.cargo/bin/koni --version` and run read-only validation before any profile write.
4. Preview the intended Updog initialization/replacement with explicit profile and target. Review
   the resolved root, owned resources, and backup plan. The versioned-baseline/project-overlay
   feature is still absent, so do not use `--replace` unless either that feature has landed or the
   primary integrator has proven and recorded that this one-time project tree contains no local
   profile intent that the replacement would discard.
5. After any authorized replacement, run `koni validate-profile` and `koni validate`; use
   `koni recover` only when its inspected state proves recovery is needed. Recovery is a write, not
   a harmless validation step.
6. Reopen only the cockpit surface. Do not resume the forensic runs. Start a new Small SPICED proof
   on `harness-testing`; only after incorporating its findings proceed to fresh Medium and Large
   proofs.

Source tests cannot authorize a profile overwrite, process termination, run recovery, merge,
delete, or token-spending smoke. Each retains its explicit operator and ownership boundary.

## Verification log

- Read the complete central registry and every persona mailbox, including the later
  `docs-release-audit` and `graph-seed-review` handoffs that appeared during this audit.
- Read every top-level product/design document under `docs/` and reconciled their current/past/
  future labels with source/profile state.
- Inspected Cargo metadata, all manifests, every test target, ignored-test declarations, checked-in
  fixture usage, process/sandbox call sites, packaged skill validators, and current Software
  version/run-type inventory.
- Confirmed the shared tree is intentionally dirty. No test, formatter, install, profile command,
  cockpit input, Updog access, or live-run mutation was performed by this lane.

## 2026-07-14 post-matrix gate transitions — `primary-integrator/root`

The earlier red checkpoints and exact rerun order above remain the causal audit record. Their
current outcomes are now:

- Graph Seed hardening: 7/7; approval: 25/25; approved Plan reuse: 1/1.
- Evidence/runtime truthfulness is explicitly released after independent review; integrated TUI:
  288/288, with formatting and scoped diff checks green.
- The three stale Research runtime fixtures are reconciled without production changes; their
  exact tests pass 3/3, result contracts 3/3, safe replay selection 1/1, and the pre-generic-proof
  full core baseline is 438 passed / 0 failed / 3 intentionally ignored.
- Documentation audit items 1–8 and both follow-ups are closed; independent review accepted items
  1–3 after re-reading every product doc and current mailbox. The fresh worker token-efficiency
  proof and versioned profile-overlay work remain correctly pending.

These transitions do not waive the final frozen-source matrix. Generic graph-local proof compiler
and Software 0.4 implementation are now active, so their owners must release and the entire matrix
must rerun against one later unchanged fingerprint before any binary/profile/cockpit action.

## 2026-07-14 later compiler/Software/TUI gate transition — `primary-integrator/root`

The matrix above intentionally preserves its earlier missing-source and 0.3-era checkpoints. The
current shared tree has moved beyond them, but is still not frozen or refresh-ready:

- generic graph-set integration now executes 6/6 and Software's first normal-order focused lane
  executes 6/6; released specialist records now exist for config/state/expression, verification,
  and the integration test;
- those green counts do not close the signed review-effect audit: final generic coverage must bind
  the complete selected-node/target universe and include a two-effect first-apply/second-no-op
  regression with omitted-member rejection;
- the generic authority matrix must also reject baseline-writable proof-source paths overlapping
  production-write authority by equality or either containment direction, and the independent
  engine reviewer must disposition every prior source/executable/anchor/scope/currentness finding;
- the Software adversarial review expands the release matrix beyond the first six cases to cover
  write-capable diagnosis, bounded invalid-proof replacement, deferred shared boundary proof,
  every diagnosed defect, same-objective mitigation routing, delivery-currentness invalidation,
  sibling proof isolation, every proof strategy, and one real broker path; and
- the compact Recent Activity title has a released read-only 82×24 test specification but no
  implementation lease yet. Its eventual exact regression and full TUI count belong before the
  frozen gate.

Accordingly, the final sequence must add `--test graph_check_set`, the expanded current
`software_proof_gate`, the generic review-effect regression/filter published by its owner, the
proof-source/production-authority tests, and the compact Activity full-dashboard regression before
the package/workspace commands. Exact names and counts must come from released owner mailboxes;
zero-test filters never count. No install, profile replacement, cockpit restart, cmux input, run
resume, or token-spending smoke is authorized by this transition.

### Moving Software snapshot correction

The 6/6 Software count immediately above remains the sole-proof-authority checkpoint before the
adversarial topology expansion. Two current-tree reruns now execute **4/6**: a fixture still uses
the removed defect status `active`, and a same-objective mitigation case expects an implementation
ticket that the revised readiness topology no longer selects. All four proof/compiler cases remain
green, so this is routed to the Software YAML/regression owners and does not authorize a generic
compiler relaxation. The final matrix must use the later owner-released count, not either historical
snapshot.

### Broad-core Research regression gate

The compiler owner's broader non-Software integration run is currently red in two
`research_profile.rs` paths: ticket-worktree squash context-hash idempotence and configured
review-effect promotion selection. `graph-tdd-research-regression/root` owns a read-only diagnosis
mailbox and no source/profile fix is yet assigned. The historical Research 20/20 checkpoint remains
valid for its source snapshot, but the final matrix must rerun the complete current Research target
after these failures are classified and repaired or explicitly shown to be moving-fixture drift.
Focused graph-set 6/6 cannot waive this gate.

#### Research diagnosis disposition

The read-only diagnosis is complete. Neither failure belongs to Research YAML: the first is a
generic context-sanitization regression from selecting the live step with its prior `context_hash`;
the second is a tracked review-effect mismatch being re-evaluated through a pre-effect selector
instead of returning stable stale/incomplete provenance. The compiler/context and review-effect
owners now own the narrow repairs. The two exact tests plus the complete current Research target
must pass before this gate closes.

### Cross-ticket proof-preparation gate

Software's conditional source-only preparation lane exposes a generic evidence-lifetime gap:
`preserve_source_paths_from` binds only one ticket, while a later implementation must change
covered product bytes without allowing proof/oracle source or semantics to drift. Final release now
requires a compiler-owned preparation binding and regressions that prepare/review an absent-at-seed
diagnostic or boundary source, preserve the binding across covered-product changes, and reject
source or oracle churn before later green execution. The profile may describe the conditional
workflow meanwhile, but no frozen-matrix claim may call cross-ticket oracle immutability proven.

**2026-07-14 review expansion:** the final preparation matrix must also prove that currentness
authenticates the durable review's canonical input boundary, not merely its stored accepted record,
output, effect shape, set/member receipt, and source manifest. Drift a review-visible workflow,
scope, target, or receipt boundary while holding those other values constant and require false
without mutation. Run the predicate itself through tracked/Git-common state for every bound
dimension and covered-product-only compatibility; expression/config serialization and a downstream
Software outcome do not substitute for this runtime evidence. The complete adversarial list and
owner response live in `proof-preparation-review.md` and `proof-preparation-binding.md`.

### Late Software preset and delivery-revision gates

The Bug Fix preset must be exercised as an exact schema-conforming seed: unresolved work may carry
objective, grounded defect, and diagnostic proof, but neither the nonexistent
`defect.localization_status`, compiler-owned status, nor a speculative pre-diagnosis addressing
change. Separately, a stale `candidate_ready` closure must revise and re-review the same delivery
ID with exact read/write authority over that existing node; it must update exact include/
acknowledge sets and never emit a second delivery. Add both focused regressions to the owner-
released Software target before the frozen package matrix.

### 2026-07-14 compact Activity implementation resolution — `tui-polish/root`

The earlier sentence that the compact Recent Activity title had no implementation lease remains
the pre-claim matrix checkpoint. The bounded implementation later landed and is released: exact
full-dashboard title regression **1/1**, Activity filter **6/6**, and full locked TUI library
**294/294**. Independent source review is **READY FOR INTEGRATION**, and the all-doc/mailbox sweep
found no overlapping lease or conflicting runtime authority. The selector measures complete
bordered candidates and chooses full `Recent activity · 1h 02m active`, compact
`Activity · 1h02m`, or identity-only `Activity`; `active_runtime_label`, anchored zero, layout,
rows, Evidence, lifecycle, compiler, install, and live state are unchanged. Include the exact
compact-dashboard regression in the eventual frozen matrix; do not rerun it as a substitute for
the still-open generic/Software gates.

### 2026-07-14 Pi-runtime cutover transition — `primary-integrator/root`

The frozen-source and guarded-refresh sequences above remain the exact pre-Pi integration plan;
they are not deleted or retroactively rewritten. A newly active architecture lane now replaces
Codex execution with a Koni-owned Pi SDK transport and migrates live configuration to schema 2.0.
Because that work intersects launch/session, model discovery, tool transport, configuration,
CLI/TUI, templates, and documentation, no whole-project fingerprint or binary refresh may be
declared final until the Pi parent and children explicitly release their bounded source and the
matrix is expanded on one later immutable fingerprint.

The post-cutover matrix must additionally include:

- Pi host dependency-lock, typecheck/build, fake-provider, malformed/oversized/out-of-order frame,
  tool round-trip, usage, cancellation, and package audit tests;
- Rust runtime supervision, protocol/session/sequence, OAuth-handle redaction, containment, event,
  cancellation, and lifecycle tests;
- schema-1 → schema-2 migration plan/apply/rollback/collision/ownership fixtures, recursive
  relocated-resource parity, and proof that unrelated `.codex` content is untouched;
- adversarial `AgentToolBroker` adapter coverage for durable replay first, context-before-tool,
  exact grant/CAS validation, post-output supplement closure, and canonical
  `submit_and_compile`/ordered-supplement binding;
- the six existing context-hardening regressions rerun after Pi integration, plus full core, CLI,
  TUI, profile, workspace, docs, formatting, brand, and untracked-file checks; and
- an all-doc/mailbox protocol-15 sweep that preserves Codex/schema-1 language beside dated
  Pi/schema-2 evolution notes.

Active Codex runs may be archived only by the later explicit migration transaction. This source-
coordination transition does not authorize installation, credential mutation, profile/resource
relocation in a live project, cockpit/cmux input, Updog mutation, run archival/resume, or any other
live-state change. The two forensic Updog runs remain permanently excluded from resume.

### 2026-07-14 exact ticket-pinned proof-member gate — `primary-integrator/root`

The Software frozen audit adds one generic graph-set case to the later immutable matrix. Construct
two active proofs that share one verified subject and two tickets, each pinning exactly one proof.
The target-anchored direct-member selector must compile and execute only the pinned proof for each
ticket, bind its ordinary source/covered-path/receipt provenance, and never read, execute, stamp, or
receipt the sibling. Missing or unscoped pins must fail closed. The historical inverse-traversal
behavior remains safe evidence—it rejects the out-of-scope sibling—but it does not satisfy exact
one-proof progress. Self-edges, broader sibling scope, duplicate proof nodes, or a Software-only
special case are not acceptable substitutes.

### 2026-07-14 review-effect v1.1 re-audit transition — `primary-integrator/root`

The earlier two-P1 review-effect wording remains the causal acceptance contract. The independent
current-tree re-audit closes its strict-subset implementation half: the durable envelope now binds
the complete candidate universe, exact pre-state snapshots/hash, declared effects, and exact post
state; replay is clone/swap and omitted-member tampering rejects. Do not keep reporting that half as
wholly absent.

Generic release is nevertheless still blocked on two exact cases:

1. For an effect-bearing review, reconstruct the pre-effect graph, recompute the canonical review
   input/target universe, and require equality with the reviewer's `binding.input_hash`; a drift in
   ticket targets alone must fail without mutating the graph.
2. Compile a valid configured profile/operation through normal validation, then prove two disjoint
   effects apply once, replay as an exact post-state no-op, and reject one omitted eligible member.
   The current private mechanics test mutates an already compiled Research profile and therefore
   does not satisfy this configured/runtime gate.

Add both exact nonzero-test results and the later independent verdict to the frozen matrix. The
historical mechanics test and subset failure remain useful checkpoints, but neither can authorize
whole-engine release by itself.

**Later current-source resolution — 2026-07-14:** Preserve the two cases above as the acceptance
contract that drove the repair; both are now closed in source according to the independent
`graph-tdd-boundary-audit`. Both replay states validate canonical pre-effect review input, and the
replacement test uses a profile-validated Software operation through normal Git-common projection,
with two effects, exact no-op/zero-write replay, omission and drift rejection. Owner evidence is
1/1; retain that exact regression in the final immutable matrix because the independent rerun was
compile-blocked by foreign moving Pi/lifecycle code. This resolution closes the review-effect P1s,
not cross-ticket preparation or unrelated crash-recovery hardening.

### 2026-07-14 pre-merge ticket-worktree currentness gate — `primary-integrator/root`

The expanded Software matrix is green in 8/9 cases and exposes a generic checkout-authority defect
in the remaining real product mutation. Before integration, graph-set source/covered-path
currentness and target-state validation must resolve bytes from the canonical ticket lease
worktree that produced the reviewed candidate, not the main checkout. The semantic store and
projected graph remain common authority; only concrete repository-byte resolution changes root.

Prove a ticket-local covered-product change with its exact promotion receipt can finish while
unrelated main-checkout drift cannot affect the pending ticket. Then drift a ticket-worktree
source/covered byte and prove finish fails closed. After integration, composed/target checks remain
anchored to the canonical integration checkout. Do not weaken `check_passed`, copy product bytes
before merge, mark proof current by semantic status, or introduce profile-specific absolute paths.

### 2026-07-14 proof-source/production-write disjointness split — `primary-integrator/root`

The frozen matrix must prove both authority lifetimes. In one ticket, only an exact
compiler-selected member `source_paths_field` projection may grant writable proof-source bytes;
reject equality, source-as-ancestor, and production-as-ancestor against every other concrete write
grant, while preserving read-only/no-graph-set compatibility. Across tickets, prepare/review a
diagnostic or boundary source first, then require a later implementation ticket to compare all
production write grants with the preparation binding's exact source path/manifest identity. Reject
the same equality/containment shapes even though the grants never coexisted in one workflow.

Covered paths, mutable proof status, domain-edge inference, or a prompt prohibition do not confer
authority. A green same-ticket validator does not close the prepared-cross-ticket residual; both
nonzero regression groups and the preparation owner's reusable-interface handoff are required.

### 2026-07-14 deterministic ticket reissue/worktree lifecycle gate — `primary-integrator/root`

The expanded Software target's current save point is **14/15**. Its sole failure proves semantic
identity is correct but lifecycle reuse is not: a closure change re-emits the same deterministic
delivery-revision ticket with exact scope, then second start rejects the compiler-owned worktree
path retained by the first closed attempt. Add a generic regression that completes one attempt,
reissues the same semantic ticket ID for changed source state, preserves prior attempt/review/audit
history, and safely retires or validates/reinitializes only its managed worktree and branch before
new work begins. Unmanaged paths and foreign branches must fail closed.

The fix must not generate a new ticket or delivery ID, delete history, let the profile remove
compiler state, or silently reuse stale outputs/reviews/receipts. Rerun the exact stale-delivery
revision, managed-worktree retirement/recovery tests, and the full expanded Software target.

#### 2026-07-14 deterministic reopen implementation transition — `deterministic-ticket-reopen/root`

The 14/15 failure above remains the causal discovery record. Generic full compilation now binds a
retained terminal cycle to its exact deterministic run namespace and completed configured squash
transaction before publishing the same-ID fresh cycle. It rejects worker authority, dirty or
rebound worktrees, branch/base/integration mismatch, unreachable or ambiguous results, and—under
tracked storage—terminal ticket bytes that differ from the accepted commit. A durable hash-bound
`prepared` retirement precedes command-attempt archival and deletion of only the proven managed
checkout/integrated branch; `retired` replay tolerates either artifact already being absent, and
normal publication advances the record to `published`. Historical outputs/reviews/blockers remain
in `prior_cycles`; the fresh ticket has no lease, output, or review authority.

The exact Software stale-delivery revision now passes **1/1** with 15 filtered cases, including the
second `start`, independent review, and finish on the same ticket and delivery IDs. Two generic
unit tests are staged for clean integrated retire/replay/namespace reuse and for unintegrated,
dirty, or redirected-authority survival. Their binary is waiting on current preparation/Pi shared-
crate edits, so the exact Software P1 path is closed while generic unit/full-matrix release evidence
remains pending. No profile workaround, installed state, or live run mutation was used.

### 2026-07-14 Pi hostile-peer, credential-secrecy, and migration-publication gate — `primary-integrator/root`

The Pi child modules' focused green counts remain historical component checkpoints. Before the
frozen whole-project matrix may treat Pi as the sole runtime, add nonzero adversarial groups that
prove: exact outstanding response IDs and session/turn/tool lifecycle; exactly one terminal result
for every accepted host turn; no OAuth token/device secret in public frames, stderr, durable events,
or transcripts even when upstream throws a stringified malformed response; no production path
around containment, clean environment, fd-3 credential service, supervision, and the compiler
broker; full durable-replay/context-first/grant-CAS/output-closure/composite-submit adapter
compatibility; ancestor-symlink confinement; schema-field-only migration with semantic-value
preservation; post-validation replacement rejection; and deterministic recovery after every
publication rename crash point.

Run these beside the pinned Pi host lock/typecheck/build/unit/audit suite, credential and
containment tests, the existing migration suite, and all compiler/Software/Research/CLI/TUI gates on
one immutable source fingerprint. Earlier component releases do not waive this integrated matrix,
and no install, relocation, migration, archival, cockpit/cmux action, or live/forensic-run change
is authorized before it is green.

The credential portion must also use a UID-stable cross-process lock independent of `TMPDIR` and
revalidate the persistent keyring revision at commit. Its required nonzero regression launches two
same-UID processes with different temporary-directory environments, proves only one refresh
transaction enters at a time, and proves a stale N-to-N+1 writer cannot overwrite the winner.

**Current-source checkpoint:** the UID-stable root, no-follow/CLOEXEC lock, persistent revision
re-read, and both named regressions are now present. Keep the matrix item open until those tests
publish nonzero green results on the final fingerprint and the independent security reviewer
accepts the new bytes.

The macOS containment/auth group must exercise the actual compiled Seatbelt policy, not a mocked
network flag: prove an exact loopback browser callback succeeds when intentionally supported, or
prove bind denial immediately and deterministically falls back to device-code. Both variants need
bounded timeout/cancellation and no surviving callback listener, login controller, credential
transaction, or child. A hang awaiting unsupported manual-code input is a failing result.

The composed-process group must additionally prove an opaque independently pinned artifact and
launch-time file-identity/hash binding against malicious PATH, forged values, and Node/bundle/
checksum swaps; terminate/reap before returning every broker, callback, receive, or protocol-state
error so accepted work cannot keep spending; and create diagnostic files beneath a compiler-owned
root with no-follow leaf/ancestor handling. The private credential group must prove that fd-3
modify/delete authority exists only for an outstanding expiring Rust login/logout/refresh intent,
with unsolicited ordinary-turn/model/metadata/expired-intent mutations rejected.

### 2026-07-14 moving prepared-source authority matrix — `primary-integrator/root`

The typed global prepared-source implementation is not released merely because its binding and
two admission call sites exist. Preserve the earlier boolean-only residual as causal history, then
run the following on one stable Git-common fingerprint:

- a real tracked predicate case that reaches true and independently falsifies declaration,
  profile, operation/check, targets, proof/subject semantics, argv/cwd, review/output, receipt
  origin/time, and source bytes while covered-product-only and unrelated-graph drift remain true;
- configuration rejection when predicate operation/check disagrees with the operation's declared
  preparation check, plus runtime fail-closed defense against forged/persisted disagreement;
- emission-time and lease-time rejection for equality, either containment direction, root/broad/
  literal authority, late-current preparation, retry/existing lease, multiple bindings, and stale
  or forged exceptions; and
- first preparation and exact re-preparation rejection whenever the nominal source-only operation
  also carries any disjoint product, literal, broad, or undeclared-source write grant. Every write
  grant must be the exact compiler-selected source projection for that declaration.

The current whole-graph review replay catches canonical receipt/argv/source rebinding but is too
broad for historical preparation: unrelated graph growth must not release the source lock. The
planned stable review-boundary binding needs positive unrelated-growth and negative relevant-drift
evidence. The declaration mismatch is source-addressed at profile validation but retains the
runtime defense criterion. These transitions do not close Software consumer wiring or the final
immutable matrix.

### 2026-07-14 Pi trust-model and current security matrix — `primary-integrator/root`

The frozen matrix cannot paper over the architecture decision: if Node remains outside the
credential TCB, prove it never receives raw access/refresh material and cannot open arbitrary
outbound connections, while a Rust-owned allowlisted provider path injects auth. If Node becomes
part of the credential TCB, prove independent signed provenance for the entire executable/
dependency closure and bind that identity race-free through `exec`. A redaction-only test is not
evidence for either model.

Whichever model is selected must also prove on the same fingerprint:

- active fd-3 transactions are cancelled when their intent ends and cannot retain the cross-process
  keychain lock; refresh persistence requires independently bound nonempty account identity;
- visible usage buckets are arithmetically consistent, and the serialized Codex request enforces
  the advertised limit. The pinned builder currently ignores `options.maxTokens`; include an
  oversized single response and do not call an output cap a total-token budget without input/cache
  reservation; and
- recovery state is compiler-owned/authenticated, every retirement path is rederived, forged
  journals cannot target source or `.git`, publication uses handle-relative no-follow identity,
  and run authority spans the commit. Synchronize tests inside both race windows.

Source-addressed wrapper termination, credential intents, migration ancestry/transforms/proof, and
journaling still need exact nonzero evidence; their former complete absence is historical rather
than current. No live auth, migration, install, or forensic-run exercise belongs to this matrix.

The preparation configuration group must also prove a malformed predicate cannot panic before
ordinary expression validation. Missing required operation/check fields must return a bounded
profile error, and report/view use must have an explicit semantic disposition; runtime declaration
equality remains required even when profile validation rejects the normal mismatch path.

#### Pi credential-TCB recommended branch — 19:02 MST transition

The security review recommends the host-in-TCB branch for the first cut because the pinned Pi
Codex provider itself parses account/token material, builds bearer requests, owns streaming and
retry/compression, and performs login/refresh. Preserve the Rust-proxy branch above as the stronger
future option; it would require a provider adapter/fork rather than a transparent credential
injector.

For this branch, replace the old mutable-PATH/sibling-digest cases with current provenance proof:
authorize the fixed host/SDK/Node/dependency closure from an independent release-signing root,
verify lockfile/SBOM and update policy, bind immutable bytes through execution, and prove the
credential TCB still receives no compiler tool, graph, Git, or project-filesystem authority.
Current source has closed PATH/environment/sibling selection and missing-account refresh; retain
nonzero regression coverage. The abandoned-active-transaction lock, untrusted usage-total/
provider-cap, forged-journal, rename TOCTOU, and run-proof race remain live gates.

### 2026-07-14 Software preparation/diagnosis boundary case — `primary-integrator/root`

The expanded Software rerun must trace the Bug Fix seed through preparation and diagnosis. Record
the exact target universe and `proof_preparation_current` result before diagnosis, then add the
intended defect `root_cause`, `causal_chain`, and `ruled_out_alternatives` fields and prove the
workflow still progresses without silently releasing source authority. Use a deliberate proof-only
preparation target plus subject read/topology, or an explicitly configured stable subject
projection; do not weaken the generic relevant-semantic-drift invariant. Also mutate a genuinely
bound proof/subject field and prove preparation reopens.

#### Pi build-provenance and output-cap current-source transition — 19:10 MST

Supersede only the current classifications, not the causal tests above. Node is now selected and
hashed during the Koni build, embedded, reverified, and descriptor-staged; prove the **build** is a
trusted signed release root and reject malicious build inputs, rather than claiming the hash is
learned only at runtime. The host now exposes `output_token_budget` and injects
`max_output_tokens` through the real Codex payload across tool rounds. Retain serialized-payload
and oversized-report tests, then run them through the pinned provider and composed process.

Rust must still reconcile cache-write/visible usage totals and terminal output against the cap.
The final integration also needs a real engine caller composing `PiRuntimeProcess` with
`DurableAgentToolBroker`; source-only exported modules are not a runtime cutover.

#### Pi lazy OAuth package-closure smoke — 19:16 MST

Build and stage the production host into an empty isolated root with no `node_modules`, attach a
fake private fd 3 and fake provider, and force all three lazy OAuth consumers: stored-credential
`toAuth`, refresh, and device-code login. Each must load only signed/manifested staged bytes and
complete or fail for the injected semantic reason—not `ERR_MODULE_NOT_FOUND`. The provenance/SBOM
must enumerate this closure even though esbuild's metafile cannot discover the variable import.

#### Linux containment-launcher adversarial group — 19:29 MST

Place a fake `bwrap` first on PATH and prove production ignores it and never exposes fd 3. Verify
the executed launcher against the signed/root-owned package identity and bind that exact identity
through exec. Inspect the compiled command/mount namespace and require a synthetic minimal `/dev`
(`--dev /dev`), rejecting the current host-wide `--dev-bind /dev /dev` unless a separately pinned
device requirement exists. Run this before any live credential/provider test.

#### Pi usage-authority source transition — 19:21 MST

Retain the cache-heavy, cap-overrun, and too-small-total cases in the composed matrix, but current
Rust source now implements their checks and binds `output_token_budget` into active-turn state.
Verification should prove the host rejects before publication and Rust independently rejects
cumulative output over cap or visible input + cache-read + output above total. Do not require a
separate cache-write field unless a named policy consumes it; it remains folded into total.

##### Moving-source usage regression — current red case

Add an exact first usage delta with nonzero input/output and a total below their visible sum; it
must reject before state mutation or event publication. Current code accidentally uses prior cache-
read/output totals in that sum. After repair, rerun this beside cumulative overflow, cache-heavy
valid, and output-cap-overrun cases on the frozen composition.

#### Prepared-source declaration and Software diagnostic source transition — 19:06 MST

Current source now enforces exact runtime preparation operation/check declaration, returns typed
configuration errors for malformed leaves without panic, and makes diagnostic preparation proof-
only while preserving the defect as read/topology. Keep the wrong-check/unknown-operation,
malformed-check, and Bug Fix no-reprepare-through-mutation/promotion cases in the stable matrix.
Also mutate relevant proof/risk semantics and require reopening. These source repairs do not waive
the source-only operation-grant purity, historical review boundary, emission/lease admission, or
complete tracked/Git-common predicate groups.

#### Prepared-source source-closure rebaseline — 19:12 MST

Independent current-byte review finds no remaining definite source defect in this boundary. Keep
all original adversarial cases, but classify them as frozen-evidence requirements: schema-1.3
historical review/candidate-local replay; raw receipt plus argv/source integrity; runtime declaration
and typed config failure; source-only companion-grant purity; emission/late/current/existing-lease
admission; and Software proof-only diagnostic sequencing. Owner scope reports preparation 8/8,
conflict 1/1, and source authority 2/2. The immutable run must explicitly map multiple-current/
shared-path and newest failed/stale behavior rather than infer them from nearby greens.

##### Prepared-source supersession consistency — current red case

Create an older reviewed/current preparation over `[proof]`, followed by a newer reviewed but
failed or semantically stale attempt for the same operation/source over `[proof, subject]`. Resolve
the predicate back to `[proof]`. Current code can report the old predicate true while global
enumeration removes the source lock. After repair, both paths must share one newest-attempt key and
agree: either the selected newest ticket matches the expected targets and is current/locked, or the
predicate is false and no downstream rule may treat preparation as current. Repeat across topology
growth/reversion and two predicate owners.

#### Pi 19:35 remediation rebaseline

Keep the lazy-OAuth, fake-bwrap/minimal-device, revoked-transaction, and usage cases, but current
source now contains their principal repairs. Final evidence must run the isolated static OAuth
closure (`toAuth`, refresh, device-code), reject a substituted bubblewrap and prove minimal `/dev`,
show revoked intent aborts within the promised bound, and prove all-`next` first/cumulative usage
math. Add one containment residual: swap a writable verified `bwrap` after hash and before pathname
spawn; it must be impossible through descriptor staging or immutable root-owned package identity.

#### Final Pi security save-point matrix correction — 19:21 MST verdict

The production process/broker caller and compiler-owned/rederived migration journal/run guards now
exist in source. Reclassify them from absent to integration-unreleased/source-addressed. Keep the
exact grant -> contained process -> fd-3 intent -> durable broker -> terminal receipt proof and the
forged-journal/late-run/crash cases.

Two source-red race groups remain mandatory before that matrix: (1) swap a verified writable
bubblewrap between hash and pathname spawn, and (2) swap a migration source/ancestor between
identity verification and pathname rename. Both must become impossible through descriptor-bound/
handle-relative execution/publication or independently immutable identity. The signed credential-
TCB decision and package closure remain release prerequisites.

### 2026-07-14 — deterministic same-ID lifecycle scoped release

The earlier pending lifecycle rows remain discovery history. The generic terminal-reopen filter is
now **2/2** and the four lifecycle-relevant retirement/recovery cases are **4/4**; a later broad
`retirement` substring rerun is **5/5** only because an independently owned schema-migration test
also matches. The exact Software stale-delivery consumer is **1/1** through its second managed
cycle. Its run crossed unrelated engine movement, so retain one minimal post-successor exact rerun
after `compiler-graph-tdd/root` releases the authenticated successor fingerprint. Do not promote
that queued check into a lifecycle source hold, and do not infer the full Software, preparation,
Pi, or whole-project matrix from these scoped greens.

### 2026-07-14 — graph-TDD/preparation frozen scoped matrix

`compiler-graph-tdd/root` completed its successor/currentness and repeated-I/O gate on unchanged
engine hash `50e310cde301e2457761453002caca96be648dfa97af900b1aad974de273b2cd`.
The fingerprint-wrapped compiler set is: core check; preparation **16/16**; Git-common successor
visibility **1/1**; complete two-effect replay **1/1**; graph-set **6/6**; Software historical
effect/receipt drift **1/1**; exact Git-common preparation materialization **1/1**; and the complete
Bug Fix preparation/diagnosis/implementation/promotion/no-repeat/global-source-lock lifecycle
**1/1** (28.00-second debug test body). The direct Software broker/counter passed **1/1** in 9.15
seconds with its engine/runtime/broker/Pi-process/lib/lockfile hashes unchanged.

The complexity oracle is deterministic: two derivation graph identities plus final emission yield
three binding scans; derivation and post-reconciliation yield two ticket/receipt source indexes;
an empty preparation board performs zero receipt parses; multiple nested ticket lookups parse once
per evidence epoch. Exact graph hashing invalidates even semantic-excluded projection changes, and
the evidence key includes state root, tickets directory, and receipts directory. Independent audit
found no P1. Keep generic projected-resolver recursion policy and legacy direct replay's current-
time coverage as P2 follow-ups. This closes the queued compiler/preparation matrix only; it does not
waive the Pi security, migration, install/live, or whole-project rows elsewhere in this ledger.

### 2026-07-14 — compiler matrix rebase after schema-2 source movement

Do not apply the prior `50e…` fingerprint to the later whole tree. The compiler owner repeated the
same scoped gates after unrelated catalog/state/Software-test movement. Engine hash
`54ca55d60bb58db03fa91f7776d6119d0e5f85322bf73c6be3ccf52522ab5497`
and the declared catalog/config/state/Software-test/graph-set-test inputs remained identical before
and after: core check; preparation **16/16**; broker/counter **1/1**; graph-set **6/6**; drift and
Git-common materialization **2/2**; full Bug Fix lifecycle **1/1**; active-successor visibility and
two-effect replay **2/2**. Preserve unrelated concurrent lib-test additions as outside this scoped
fingerprint. The exact hashes and 27.23-second diagnostic lifecycle timing are in
`compiler-graph-tdd.md`; structural counters remain the performance oracle.

### 2026-07-14 — Software consumer rebase on current engine

The complete Software profile/compiler boundary is green on the later engine fingerprint
`79080f2c…`: **20/20**, 0 failed, with unchanged pre/post engine and `aa60ba01…` Software-test
hashes. Preserve the earlier `54ca…` matrix as historical evidence, but use this later result for
the current Software lane. It does not waive generic compiler P2 follow-ups, Pi security/cutover,
installed/live-state verification, or whole-project release gates.

### 2026-07-14 — later engine movement after Software rebase

The `79080f2c…` Software checkpoint remains valid for its exact bytes, but current engine source
moved again to `9131b388…` during a subsequent CLI run. Although the 66 CLI assertions passed, that
wrapped run is diagnostic because its dependency fingerprint changed. Current-head Software/CLI
integration waits behind the compiler owner's active reacceptance and workspace matrix; do not
infer a failure or a release from source movement alone.

### 2026-07-14 — final Software/CLI settled endpoint

The movement hold above is closed on engine `41436b37…`. A sequential wrapped run passed Software
**20/20** and CLI **66/66** with engine, Software-test `aa60ba01…`, CLI `d627bb43…`, and templates
`5d637228…` fingerprints identical before, between, and after. Use this current result for the
Software profile plus init/template lane; preserve prior snapshots as history. Generic compiler P2,
Pi, installed/live-state, and whole-project gates remain separate.
