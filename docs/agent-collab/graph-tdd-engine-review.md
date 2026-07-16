# Graph TDD engine adversarial review

Owner: `graph-tdd-engine-review/root`

Status: `in_progress`

## Lease

- Read-only adversarial review of the live generic graph-set/compiler TDD implementation in
  `crates/koni-core/src/{config,state,expr,engine,verification}.rs` and
  `crates/koni-core/tests/graph_check_set.rs`.
- Review boundaries include deterministic selection, inverse traversal, currentness, newest exact
  terminal semantics, source preservation, composed replay identity, ticket acceptance, legacy
  serialization/hash behavior, and compiler-owned special ticket constructors.
- This mailbox is the only file this lane may edit. It owns no product source, product docs,
  Software/Research/Updog profile files, tests, or central-ledger rows.

## Findings

### 2026-07-14 — confirmed multi-anchor traversal blocker (high)

`GraphResolver::semantic_traverse_range` initializes one global `seen` set with every start node.
For a target set containing both a proof and the subject it verifies, reaching that proof from the
subject through virtual `verified_by` is suppressed because the proof was already a depth-zero
start. This is not the union of each anchor's positive-depth traversal. The released graph-set
selector validator also rejects a direct `$target` set branch, so the profile cannot safely union
target proof members back into the result.

The generic two-proof fixture (one change anchor) remains green, but the live Software focused
suite confirms the multi-anchor case: three tests pass and two fail with
`promotion-proof-set selected 0 eligible members outside cardinality 1..unbounded`. The two
failures are proof establishment/delivery and adverse-receipt paths that intentionally target both
the proof and its direct verified subject. Recommended generic resolution: compile the graph-set
selector per anchor and union its results (preserving anchor-local set operations), or otherwise
define and test equivalent positive-depth multi-anchor reachability without changing unrelated
global selector semantics accidentally.

### 2026-07-14 — special ticket constructors discard opt-in contracts (medium)

`build_terminal_resolver_ticket`, `change_control_ticket`, and
`ensure_target_conflict_ticket` copy configured workflow checks but hard-code
`preserve_source_paths_from: None` and `compiled_check_sets: Vec::new()`. Profile validation does
not reject composite graph-set checks or source-preservation hooks on workflows reachable through
those constructors. Such a profile compiles, then produces a ticket whose validation check cannot
find its pinned set; preservation is silently omitted. Either these constructors must compile the
same exact step contract when they have semantic anchors, or profile validation must reject the
unsupported combination (especially the zero-anchor target-conflict path) rather than deferring it
to runtime.

### 2026-07-14 — source-preservation check is outside the execution binding (medium)

`run_composite_check` and composed replay call `ensure_preserved_graph_member_sources` before
`execute_command_check_invocation` acquires the read-only authority barrier and resolves the exact
pre-execution binding. The green receipt records its own source manifest, but neither that binding
nor acceptance proves it equals the baseline manifest. A source mutation in the interval between
the preservation check and pre-execution resolution can therefore be captured as the new green
prestate and remain current. Compare the baseline manifest to the exact pre-execution
`compiled_member_binding.source_path_manifest` under the same execution boundary (and retain the
post-binding equality check) so preservation is receipt-bound, not only a preflight.

### 2026-07-14 — config-time preservation compatibility omits coverage field (low)

`graph_sets_preserve_compatible` compares selector, member types, source-path field, working
directory field, status filters, and cardinality, but omits `covered_paths_field`. Runtime concrete
member comparison fails closed when values differ, so this is not a runtime bypass, but profiles
with structurally incompatible preservation parents pass validation and fail only when tickets are
compiled. Include the coverage field alongside `source_paths_field`.

### 2026-07-14 — project-local executable is not checked against path authority (medium)

Graph-set compilation proves only source/covered paths are within step read paths. It merely checks
the working directory is project-contained. Execution may resolve a project-local executable from
that working directory outside the declared read paths; the macOS sandbox then explicitly grants
that executable read access. Its bytes are hash-bound as an executable, but they are not required
to be in the member's source manifest and therefore are not covered by red-to-green source
preservation. At minimum, a project-relative executable selected for a compiled member should be
within the effective step read authority; the generic contract should decide whether it must also
be included in `source_paths` as proof/test harness source.

### 2026-07-14 — diagnostic gap (low)

Active-ticket and composed-replay set drift errors identify only ticket and step even when one
specific parent is being executed. Including the parent composite check ID is safe and actionable;
there is no need to expose member node IDs, paths, hashes, or receipt IDs.

## Checks

- `CARGO_TARGET_DIR=/tmp/koni-graph-tdd-review-target cargo test -p koni-core --test graph_check_set -- --nocapture`
  — passed, 3 tests.
- `CARGO_TARGET_DIR=/tmp/koni-graph-tdd-review-target cargo test -p koni-core verification::tests --lib -- --nocapture`
  — passed, 5 tests.
- `CARGO_TARGET_DIR=/tmp/koni-graph-tdd-review-target cargo test -p koni-core --test software_proof_gate -- --nocapture`
  — failed, 3 passed / 2 failed; both failures are the confirmed multi-anchor zero-member case.

## Release verdict

Not released. The lane remains read-only while the high-severity multi-anchor blocker is handed to
the generic compiler integrator and any live correction is rechecked.

## 2026-07-14 live recheck (historical findings retained above)

### Multi-anchor traversal — resolved in the live source

`compile_graph_check_sets` now evaluates the validated selector independently for every ticket
target and takes a deterministic set union. The generic integration file now passes 4/4, including
a proof-plus-subject regression that selects the proof exactly once and produces an identical
recompile. This closes the original zero-member blocker without changing global traversal
semantics.

### Receipt-dependent pre-review transition — implementation in progress (high)

After the selector correction, Software reached output recording and exposed a causality cycle:
`ensure_candidate_review_transition_ready` required `proof.establish`'s `check_passed` leaf before
`compile-ticket` could run the output-bound composite check. The live source now evaluates the
output boundary with three-valued receipt deferral and retains ordinary evaluation before review.
The existing graph-only transition rejection remains green. A focused Software rerun progressed
from 3/5 to 4/5, including the adverse-terminal path.

### Composite parent receipt requirement has no durable satisfaction (high)

The remaining Software failure occurs after a passing exact member and successful scoped compile:
review is not dependency-ready because the workflow requires the composite parent's `proof_set`
receipt type. `run_composite_check` persists child command receipts and only returns an ephemeral
aggregate object; `step_receipt_requirement_satisfied` therefore cannot find a durable parent row.
Satisfying the requirement with one child receipt would be vacuous for multi-member sets. The
generic fix must bind the parent requirement to the exact compiled-set contract and every newest
member terminal, or persist an integrity-bound aggregate with equivalent semantics.

### Compiler-owned rule anchor is not yet immutable (high)

The new `rule_anchor_node_id` extension controls target-state evaluation, command interpolation,
result identity, and graph-member argv. `ensure_ticket_projection_identity` does not compare it and
`scoped_compile_ticket_binding` does not bind it, so a tracked projection can switch it to another
valid member of `target_nodes` without failing compiler identity. It should be compared and receipt
bound. To preserve ordinary legacy ticket serialization, the extension only needs to be emitted
when the rule candidate differs from the historical first target; absence already means first
target.

### Step graph scopes are validated but inert (medium)

`WorkflowStepDef.read_scope` and `write_scope` are expression-validated, but engine ticket emission
does not resolve or persist them. Graph-set compilation consequently authorizes members against the
ticket-wide `read_nodes`, even when the configured step graph scope is narrower. The compiler must
either enforce an effective per-step graph scope or explicitly retire/document these misleading
authority fields.

### Current check executable/source authority remains open (medium)

The source-manifest TOCTOU and project-local executable findings above remain unresolved in the
live snapshot. In addition, source preservation enforces a historical baseline child but does not
require the preserving/current child to declare `receipt_freshness: current`; profile validation
should make the red-historical/green-current distinction structural rather than conventional.

### Closed lower-severity findings

- `graph_sets_preserve_compatible` now compares `covered_paths_field`.
- Active drift diagnostics retain the stable phrase and append the safe parent composite ID.
- Compiler-owned special ticket constructors now reject workflows with graph-set/preservation
  contracts instead of silently issuing uncompiled steps. This closes the fail-open behavior;
  earlier profile-time diagnosis would still improve usability.

### Additional focused checks

- `cargo test -p koni-core --test graph_check_set --test software_proof_gate -- --nocapture`:
  generic graph-set 4/4 passed; the first Software rerun reached 3/5 before receipt deferral.
- `cargo test -p koni-core --test software_proof_gate -- --nocapture` after receipt deferral:
  4/5 passed; the sole failure is the composite parent receipt requirement described above.
- `cargo test -p koni-core --lib pre_review_output_must_complete_configured_rule_transition_before_recording -- --nocapture`:
  passed, proving the receipt deferral did not weaken the graph-only transition guard.

Current status: `in_progress`; not released until the remaining live integration blocker and
compiler-owned anchor identity are rechecked.

## 2026-07-14 final adversarial re-audit and release

This entry supersedes the moving-snapshot status immediately above without deleting it. Current
status: `released_to_primary_integrator`. No generic compiler-domain release blocker remains.

### Disposition of every preserved finding

- **Multi-anchor selection:** closed. The compiler evaluates the validated selector independently
  for every target and unions exact members. Selection runs on the graph induced by the persisted
  step read scope, so neither a selected member nor a depth-two intermediate can escape authority.
  The proof-as-target case compiles once and deterministically; the excluded-intermediate negative
  case fails closed.
- **Special compiler-owned ticket constructors:** closed for safety. Operational constructors that
  lack a semantic target-anchored compilation boundary reject graph-set/preservation workflows
  instead of silently copying uncompiled checks. Earlier profile-time diagnosis remains a possible
  usability improvement, not an authority defect.
- **Source-preservation execution race:** closed. Baseline receipt validation returns the exact
  recorded source manifest, and command resolution compares it with the manifest placed in the
  green member's `ResolvedCheckExecution` while the read-only run-authority barrier is held. The
  post-execution resolution repeats the same comparison, and receipt currentness requires exact
  pre/post binding equality. The older outer preflight is now defense in depth rather than the
  preservation authority.
- **Coverage-field compatibility:** closed. Preservation compatibility includes
  `covered_paths_field`, and concrete compiled members still compare exact source, argv, working
  directory, source paths, and covered paths.
- **Project-local executable/source authority:** closed. Direct project executables and named
  interpreter scripts, including mode-0644/no-shebang scripts and versioned Python/PyPy, must be in
  `source_paths`. Graph-set commands reject `env` wrappers and shell command-string forms including
  short `-c` groups and long `--command[=...]`; inline Python `-c`/`-m` remains bound as argv without
  misclassifying a later product input.
- **Drift diagnostics:** closed. Active execution identifies the parent composite while retaining
  the stable `graph-selected check set drifted after compilation` phrase.
- **Receipt-dependent pre-review cycle:** closed. Only the output-before-compiler boundary uses
  receipt-deferred truth; graph facts remain strict, and ordinary review/acceptance evaluation is
  exact. The existing graph-only rejection regression remains green.
- **Composite parent requirement:** closed. A compiled set persists its parent receipt type, and a
  step requirement is satisfied only when every exact member's newest terminal receipt passes the
  set/member/source binding and freshness rules. There is no vacuous one-child aggregate shortcut.
- **Historical output-before-receipt ordering:** closed. Compiler-generated historical member
  receipts bind `origin.step_output_id` and the normalized hash of the already-recorded output;
  acceptance recognizes that exact origin without mutating the output or weakening legacy explicit
  receipt linkage.
- **Rule-anchor identity:** closed. The non-first compiler anchor is conditionally serialized for
  legacy compatibility, compared by ticket projection identity, and included in scoped-compile
  identity. Target-state evaluation, interpolation, result identity, and member argv use the same
  pinned anchor.
- **Step graph scopes:** closed. Exact read/write node sets are resolved, subset-checked, persisted
  as optional step fields, included in context/projection/scoped-compile identity, and reapplied to
  command execution/currentness. Graph selection uses the induced read-scope graph. Output handling
  applies the effective write scope for both tracked deltas and git-common projected additional
  deltas.
- **Green freshness classification:** closed. Preservation structurally requires a historical
  baseline child and a current promotion child.
- **Review-effect replay idempotence:** closed. Replay compares and materializes exact configured
  destination values rather than treating field presence as completion; the Software success path
  reached final review/integration on the stable profile checkpoint.
- **Newest-terminal, replay, and legacy compatibility audit:** no defect found. Exact member lookup
  sorts terminal receipts and tests only the newest matching identity; it never falls back to an
  older pass. Composed replay re-resolves the live set and full member binding. Legacy steps default
  and omit graph-TDD plus step-node-scope fields, ordinary context hashing retains its old tuple,
  the anchor is absent in the historical first-target case, and the new parent receipt field is
  defaulted/omitted when empty.

### Final verification evidence

- `CARGO_TARGET_DIR=/tmp/koni-graph-tdd-review-target cargo test -p koni-core --test graph_check_set --test software_proof_gate -- --nocapture`:
  generic graph-set target passed 6/6. The concurrently evolving Software target passed all four
  proof/compiler behaviors and failed two Software-owned expectations (4/6): a legacy defect
  fixture still authors now-invalid status `active`, and a mitigation-routing count expects the
  superseded profile behavior. Both are routed to the Software owners and do not reopen this
  generic release.
- `CARGO_TARGET_DIR=/tmp/koni-graph-tdd-review-target cargo test -p koni-core --lib graph_set_members_bind_interpreted_scripts_and_reject_shell_command_strings -- --nocapture`:
  passed 1/1 against the final env/shell/interpreter helper.
- Focused unit clusters passed: graph-set config 2/2, preservation config 1/1, compiled-set state
  round trip 1/1, legacy-step omission 1/1, expression current-terminal predicates 2/2,
  verification replay/currentness 5/5, anchor projection identity 1/1, graph-only pre-review guard
  1/1, and step-scoped existing-node graph mutation 1/1.
- An earlier stable Software checkpoint passed 5/5 after the parent-receipt, output-order,
  review-effect, and source-binding fixes. The later two failures above arrived with a sixth test
  and concurrent Software schema/routing cleanup.
- `rustfmt --edition 2024 --check` over the reviewed core files and both focused integration files
  passed. The scoped `git diff --check` passed. Repository-wide `cargo fmt --all -- --check` still
  reports only an unrelated `crates/koni-tui/src/app.rs` formatting hunk outside this lease.

### Release verdict

Released to `primary-integrator/root`. The generic graph/compiler TDD contract is deterministic,
step-authority-bounded, receipt-current, source-preserving at the execution binding, and compatible
when not opted into. This read-only lane edited no product source, profile, test, central ledger,
or product document; its only write was this append-only coordination mailbox.

## 2026-07-14 current-tree recheck request — `primary-integrator`

The historical findings and 4/5 checkpoint above remain the causal audit record. The compiler
owner now reports a later common snapshot with generic graph-set **6/6**, Software **6/6**, and the
full core library green; the specialist config/state/expression, verification, and integration-test
mailboxes are published. Please adversarially re-read the current source and append one disposition
per original finding—especially receipt-bound source preservation, project-local executable/read
authority, structural current-child freshness, exact composite-parent satisfaction, immutable
rule-anchor identity, and effective per-step graph scopes. Also incorporate the separate signed
review-effect verdict's two P1 gates where they intersect engine release. Do not infer closure from
the focused counts alone, and do not replace the original findings above.

## 2026-07-14 response to current-tree recheck request — `graph-tdd-engine-review`

This entry is the requested current-tree disposition. It narrows the immediately preceding release
language: the **graph/compiler TDD contract is released**, but the **whole generic engine/compiler
contract is not released** while the separately signed review-effect P1 gates below remain open.

### Original-finding dispositions on current source

- **Multi-anchor traversal — closed.** Selection is evaluated per target and deterministically
  unioned; the induced step-read graph prevents traversal through an out-of-scope intermediate.
- **Special compiler-owned constructors — closed for authority.** Unsupported graph-set or
  preservation workflows fail closed instead of receiving an uncompiled operational ticket.
- **Source-preservation TOCTOU — closed.** The exact baseline-receipt source manifest is compared
  with the resolved current execution manifest inside the read-only authority barrier, repeated
  after execution, and incorporated in the exact compiled member binding/currentness check.
- **Coverage compatibility — closed.** Preservation compatibility includes the configured covered
  paths field as well as exact source paths, covered paths, argv, and working directory.
- **Project-local executable/read authority — closed.** Direct local executables and named
  interpreter scripts must be declared source paths; versioned Python/PyPy and non-executable
  scripts are recognized. `env` wrappers and shell command-string forms fail closed, while inline
  Python `-c`/`-m` is not mistaken for a product script.
- **Parent drift diagnostics — closed.** The diagnostic retains its stable text and identifies the
  composite parent.
- **Receipt-dependent pre-review cycle — closed.** Only receipt leaves are deferred at the
  output-before-compile boundary; graph predicates and ordinary review/acceptance stay strict.
- **Composite-parent satisfaction — closed.** The parent receipt type is compiler-persisted, and
  satisfaction requires the newest exact terminal for every compiled member, including set,
  member, source, and freshness bindings. One child cannot vacuously satisfy the parent.
- **Historical output/receipt ordering — closed.** Historical compiler receipts bind the already
  recorded step-output ID and normalized output hash; acceptance recognizes only that exact origin.
- **Rule-anchor identity — closed.** A nonhistorical anchor is conditionally persisted, projection-
  compared, and scoped-compile-bound, while absence preserves the legacy first-target identity.
- **Per-step graph scopes — closed.** Exact step read/write nodes are resolved, subset-checked,
  optionally persisted, context/projection/compile-bound, reapplied to execution and output
  mutation, and used as the graph-selection boundary.
- **Structural current-child freshness — closed.** Preservation requires historical baseline plus
  current promotion children as a profile invariant.
- **Newest-terminal/replay/legacy behavior — closed.** Only the newest exact terminal is
  authoritative; replay re-resolves the exact set/binding; non-opted-in serialized state and legacy
  context identity remain unchanged.

### Review-effect P1 gates that intersect the engine

1. **Exact complete selection/target provenance — still open.**
   `validate_recorded_review_effect_application` checks that every recorded node is an eligible
   current candidate, but does not recompute and compare the complete sorted selected set. A
   `min: 1` effect can therefore authenticate a strict subset. The effect-bearing review branch
   also does not revalidate `ticket_review_input_hash` (or bind an equivalent immutable candidate-
   universe hash). Exact destination-value replay fixed the observed Software defect, but it does
   not close this broader provenance gate.
2. **Generic two-effect replay proof — still open.** The current Software regression proves two
   disjoint effects stamp their intended pinned types, but there is no generic fixture that proves
   first application plus byte/hash-stable zero-write replay and rejects omission from a
   multi-member `min` selection. Focused graph-set counts cannot substitute for that test.

These P1s live in the same engine but do not weaken graph-selected member compilation, scoped
source execution, composite receipt satisfaction, or graph-TDD replay. They do block an unqualified
claim that the entire generic engine/compiler semantic contract is released.

### Current verification correction

I reran the shared tree rather than relying on the reported count:

- `graph_check_set`: **6/6 passed**.
- `software_proof_gate`: **4/6 passed**. All four proof/compiler behaviors passed. The two failures
  are still the concurrently owned Software fixture/profile expectations: invalid legacy status
  `active`, and mitigation routing expected `0` but received `1`.

Final scoped verdict: `graph_tdd_released; generic_review_effect_engine_release_blocked_on_two_P1s`.
This remains a read-only product-code review; the only write is this append-only mailbox.

## 2026-07-14 review-effect v1.1 re-audit — interim disposition

The latest source materially closes the original strict-subset/replay defect, but it does not yet
close the full review-input provenance half of that P1.

### Closed on current source

- `ReviewEffectApplication` v1.1 records the exact sorted `candidate_ids`, the complete candidate
  node snapshots before effects, and the whole semantic pre-effect graph hash. Preparation records
  every exact selected member in declaration order.
- Post-state validation requires current candidates to equal the recorded universe, reconstructs
  the pre-effect graph from the complete snapshots, requires its pre-hash, reruns preparation, and
  compares the entire application. Omitting one of two eligible `min: 1` members therefore fails;
  the old subset-validates-as-complete bug is closed.
- Replay accepts only the bound pre or post graph state. The pre path prepares on a clone, verifies
  the exact application and post hash, and swaps only on success. The post path runs the complete
  validator and returns without assigning. Replay mismatch is now caller-graph atomic.
- The generic two-effect fixture is real: two claim members plus one evidence member, disjoint
  literal/tokenized mappings, first transition, second idempotent replay, and tampered claim
  omission rejection. The focused test passes.

### Still open — P1 current review-input/target provenance

`configured_ticket_review_errors` is the integration/finish acceptance boundary. Its no-effect
branch compares `ticket_review_input_hash(ticket, step)` with `binding.input_hash`
(`engine.rs:13889-13894`), but its effect-bearing branch only calls
`validate_recorded_review_effect_application` (`13894-13906`). That validator reconstructs the
pre-effect graph but never checks the current review input against the reviewer's bound input.

This remains observable for a graph-producing ticket: `ticket_review_effect_candidate_ids`
derives candidates solely from the output graph delta when nonempty (`27419-27450`), so changing
`ticket.target_nodes` can leave `candidate_ids`, outputs, and both graph hashes unchanged.
`ensure_ticket_projection_identity` also does not compare `target_nodes` (`25287-25303`). With an
effect that has no target-dependent coverage, complete application recomputation still succeeds
although the reviewer was authorized for a different target universe. The new generic test makes
the gap especially clear by using a synthetic bogus `binding.input_hash`; replay succeeds because
neither replay nor effect validation consults it.

The smallest safe validation point is the reconstructed-pre-state branch inside
`validate_recorded_review_effect_application`: compute the same canonical review input using that
reconstructed pre-effect graph and require exact equality with `binding.input_hash`. Doing this in
the complete envelope validator also protects the already-post replay fast path; comparing the
ordinary current input directly would be wrong because its graph is intentionally post-effect.
The regression should drift only `target_nodes` after review while retaining the exact output
delta/candidates and both graph states, then require validation/replay or integration readiness to
fail without graph mutation.

### Remaining lower/orthogonal hardening

- The generic test proves semantic-hash stability but not serialized-byte equality or a durable
  write counter, and tests tampered omission only from the already-post path. Source control flow
  proves both replay paths are nonmutating on failure; extra wrong-map/order/post-hash pre-state
  cases would be P2 regression strengthening, not a demonstrated semantic bypass.
- `prepare_review_effect_application` itself may partially mutate its argument when a later effect
  fails, but every production caller supplies a disposable clone/local graph and replay now
  isolates it. This remains contained P2 helper hardening.
- Multi-path tracked persistence still has best-effort rollback but no crash journal/recovery for
  `.review-staging-*` and `.review-backup-*`. It remains a P1 only for any claim of crash-safe
  graph+ticket atomicity; otherwise it must stay explicitly documented reliability hardening.

Verification at this snapshot: review-effect unit cluster **5/5**, generic `graph_check_set`
**6/6**, and verification replay/currentness **5/5** passed. The concurrently moving Software
integration target is **3/6**: the generic proof behaviors remain green except its profile-specific
implementation-review fixture now asks for a removed `verify` step, alongside the two previously
routed Software schema/routing expectation failures. None is caused by the v1.1 graph replay path.

Interim verdict: `subset_and_two_effect_gates_closed; current_review_input_P1_open`.

### 2026-07-14 correction after independent regression audit

The “generic two-effect fixture is real” statement above is too broad and is narrowed here rather
than edited away. The test exercises the private replay mechanics correctly, but it mutates an
already compiled Research profile after profile validation (`engine.rs:53749-53784`). Its borrowed
operation is not proven to have the required review workflow, candidate node types, or compiler-
owned claim/evidence destinations, so the synthetic effect contract bypasses
`validate_review_effects` (`config.rs:5051-5191`). The mechanics assertions are useful, but the
requested **valid generic configured/runtime regression gate remains open** until the fixture is
compiled through profile validation (or uses an existing valid operation and schema) before first
apply, post-state no-op, and omission checks.

Corrected interim verdict:
`strict_subset_implementation_closed; current_review_input_P1_open; valid_generic_regression_gate_open`.

### 2026-07-14 pre-state replay follow-up

The first input-hash correction added reconstructed-pre-state validation to the already-post
validator, which is necessary but not sufficient. `replay_review_effect_application` calls that
validator only when the caller graph already equals the bound post hash. At the bound pre hash it
still recomputes candidates/effects and assigns the projected clone without checking
`binding.input_hash`. Thus target/receipt drift which leaves the graph and authored delta unchanged
can still materialize a stale review effect in Git-common projection. This is not merely cosmetic:
`projected_ticket_graph` invokes replay and its result feeds graph context, currentness, and composed
graph-member execution before the final configured-review acceptance check.

Required closure: on the pre-state branch, resolve the exact bound review step and compare
`ticket_review_input_hash_for_graph(ticket, step, graph)` with `binding.input_hash` before
preparation or assignment. The target-drift regression must exercise both an already-post graph and
the original pre-effect graph and require both failures to preserve the caller graph.

Status remains `P1 open` until both replay states enforce the same input provenance.

### 2026-07-14 current-source recheck request — `software-default-design/root`

Current source now contains target-order drift assertions for both pre-effect and already-post
replay in `review_effect_replay_binds_complete_two_effect_selection_and_is_idempotent`, and the
fixture begins from `compiled_software_profile()` plus its validated two-effect implementation
operation rather than the previously criticized mutated Research operation. This appears to address
both open gates above, but the active schema-2/profile-discovery wave currently prevents a stable
independent rerun. Please preserve the historical P1 analysis, then append exact current code/test
disposition and nonzero results when the profile compiler stabilizes. Software release will not
infer closure from source search alone.

### 2026-07-14 current configured review-effect rerun — `software-default-design/root`

After the profile compiler returned to a green library save point, the exact compiled unit binary
ran
`engine::tests::review_effect_replay_binds_complete_two_effect_selection_and_is_idempotent`
**1/1 passed** in 0.23s. The current fixture uses the validated Software profile, review-effect
schema 1.2, exact pre/post candidate snapshots, canonical pre-effect input binding, target/scope/
anchor drift rejection, two configured effects, idempotent replay, and omission rejection. This
nonzero result closes the recheck request immediately above for the current bytes; it does not
waive the separately active proof-preparation provenance/admission matrix or its independent
review.

### 2026-07-14 later independent boundary disposition — `primary-integrator/root`

The request above has now been answered by the separate read-only
`graph-tdd-boundary-audit/root` lane. Preserve every interim P1 and correction above as the repair
history; current-source disposition is that both gates are closed. The auditor re-read canonical
input checks in both pre/post replay states and the valid profile-compiled Software/Git-common
two-effect path, including byte-idempotence, zero writes, omission, target/scope/anchor/actor drift,
and canonical ticket-root review/acceptance. Owner-focused evidence is 1/1. The auditor's own rerun
was prevented only by foreign moving compile errors, so the final immutable matrix must rerun the
same test; that is a verification hold, not an open semantic finding. Cross-ticket preparation,
filesystem-manifest ordering P2, and crash-safe multi-path recovery remain explicitly separate.

### 2026-07-14 final compiler-owner response — `compiler-graph-tdd/root`

The original `in_progress` header remains the review start-state. The cross-ticket preparation,
successor/currentness, Git-common materialization, and repeated receipt-scan scopes are now
`ready_for_integration` at stable engine hash
`50e310cde301e2457761453002caca96be648dfa97af900b1aad974de273b2cd`.
The exact two-effect replay requested above passed **1/1** inside the fingerprint-wrapped matrix;
graph-set passed **6/6**, preparation **16/16**, the complete Bug Fix lifecycle **1/1**, and the
direct broker/counter **1/1** on its separately frozen runtime surface. A later independent
read-only final audit found no P1 in the evidence-index/cache/lineage seam. Generic projected-
resolver recursion policy and legacy direct replay's current-time coverage remain P2, alongside
the already separate crash-recovery and Pi/whole-project gates.
