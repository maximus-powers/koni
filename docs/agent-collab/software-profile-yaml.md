# Software Profile YAML

Owner: `software-profile-yaml/root`

Status: in progress; Software 0.4 schema, rules, operations, workflows, checks, cockpit, reports,
actions, and lifecycle are implemented in the leased template files and are undergoing profile
compilation plus focused regression reconciliation.

Last checked: 2026-07-14 America/Phoenix

## Exact lease

- `crates/koni-cli/templates/software/{profile,graph,rules,operations,workflows,checks,cockpit,reports,actions,lifecycle}.yaml`
- This lane does not own Software `project.yaml`, run types, personas, Codex agent prompts, Rust,
  Research, Updog fixtures, root configuration, or TUI fixtures.

## Stable design choices

- Software `0.4.0` implements Evidence-Guided Vertical Delivery: conditional architecture and
  contracts, cohesive vertical changes, adaptive focused/boundary proof, explicit risk treatment,
  causal defect diagnosis, and an exact `candidate_ready` delivery closure.
- `initialization.objective.seed-approved-plan` remains the compiler-only initialization/root
  authority with bounded semantic node creation and no workflow, checks, review effects, deletion,
  or change-control behavior.
- `objective.work_kind` remains schema-optional for compatibility but is mechanically required
  before implementation. Bug-fix implementation requires an active diagnosed defect directly
  connected through `change.addresses`.
- Initialization is the only operation that may create `decision` nodes. Decision choice,
  rationale, and reversibility are complete in the approved seed; graph-free post-approval work may
  only validate them before a compiler review effect stamps `accepted`.
- Missing mitigation product/control scope or missing approval-bound acceptance authority is an
  upstream planning gap. `risk.plan-treatment` handles only an existing disposition's
  contradictory edges or missing boundary proof and cannot create product scope or decisions.
- Promotion proof nodes carry exact `source_paths`, `covered_paths`, and `working_directory` plus
  semantic command/readback fields. `promotion-proof-set` selects the complete active
  `verified_by` closure and is the currentness identity used by implementation, proof review,
  risk readiness, and delivery.
- Graph fallbacks are one direct graph-producing specialist followed by an independent
  graph-forbidden Reviewer. Implementation is baseline → implement → verify → review with no
  Integrator. Delivery is graph-only exact assembly → graph-forbidden review with no product or
  existing semantic-node write authority.

## Dated compatibility notes

### 2026-07-14 — historical baseline and current promotion split

The released source-preservation validator requires every baseline graph-set child receipt to be
historical. Reusing current, composed-replayable `proof-command` as the passing baseline therefore
fails the profile contract. Software now uses `proof-expected-red` or
`proof-current-baseline` under `baseline-proof-set`; both are historical and replay-disabled.
`promotion-proof-set` remains fixed to current `proof-command`. The compiler preservation join
still requires identical proof source node, argv, working directory, source paths, and covered
paths, so this split classifies causal outcome without weakening execution identity.

### 2026-07-14 — proof review target topology

`proof.establish` emits one ticket whose target set contains the selected proof plus its direct
`verifies` subjects. This lets the target-anchored composite traverse virtual `verified_by` from
the subjects, execute the exact member, then keep semantic acceptance separate through a
graph-free independent review effect on exactly the selected proof.

## Questions and active reconciliation

- Confirm through the generic proof regressions that multi-type `establish-proof` targets preserve
  exactly one review-effect proof candidate while the composite selector reaches at least one
  member.
- Confirm the landed composite runtime does not duplicate or lose current member identity when the
  same proof was executed at the implementation verifier and later reviewed semantically.
- Terminal adverse proof receipts remain compiler-owned evidence and fail closed; this profile does
  not add a ceremony-only `proof_attempt` node or claim an automatic failed/blocked status
  projection.

## Verification log

- Profile compile is currently running against the bundled-profile installation test in an
  isolated `/tmp` Cargo target directory.
- The Software regression lane has begun exercising conditional boundaries, work-kind and defect
  gates, risk routing, seed-only decisions, current proof, and exact candidate delivery; final
  results are pending this lane's compilation fixes.

## Release state

Not released. The exact YAML lease remains active until the profile compiler, focused Software
regressions, relevant bundled-template tests, and diff checks pass and the parent integrator
acknowledges the handoff.

## 2026-07-14 verification and living-docs checkpoint

The earlier pending verification text remains as the historical pre-compile checkpoint. Current
results are:

- `installs_bundled_profiles_without_touching_product_state` passes 1/1 in the isolated
  `/tmp/koni-software-yaml-target` target, including staged compilation of Software 0.4.
- `embedded_profile_inventory_matches_package_templates` passes 1/1 in the isolated
  `/tmp/koni-software-yaml-inventory-target` target.
- The parent-owned Software template assertions pass 7/7 after being reconciled to the unified
  `establish-baseline` workflow contract.
- Path-scoped `git diff --check` for the ten leased YAML files and this mailbox is clean.
- The focused runtime suite passes the three behavior groups that reach their intended workflow:
  conditional architecture/contracts/classification, causal Bug Fix diagnosis plus
  `change.addresses`, and proportional risk/critical-recovery policy. The historical baseline
  split is therefore exercised rather than only schema-validated.

I re-read the current central registry, every current persona-file heading and Software/compiler
question delta, all modified top-level product-document transitions, the complete Software
engineering specification, and the newly added graph-TDD adversarial-review mailbox. The live
Software YAML agrees with the adjacent 0.4 evolution notes in `architecture.md`,
`configuration.md`, `maturity.md`, and `philosophy.md`; no older product-doc language was deleted or
silently normalized by this lane.

## 2026-07-14 remaining generic blocker and review findings

The earlier proof-target topology note describes the intended contract, but the generic traversal
currently initializes one shared visited set with every `$target` anchor. A proof that is itself a
target is therefore suppressed when reached at positive depth from its verified subject. The two
remaining focused behaviors stop at exactly that cardinality failure before exposing another YAML
semantic failure. Software keeps the proof and subject in the ticket target so the graph-free
review effect still selects exactly one proof; it will not replace current evidence with ceremony,
weaken exact review selection, or invent a second command to work around a generic distribution-law
defect.

The adversarial compiler review also reports a generic source-preservation execution race and a
project-local executable authority gap. The Software schema already classifies proof/test/harness
bytes as causal `source_paths`; a repository-local executable or script used by `proof.command`
must therefore be modeled there. Mechanical enforcement and atomic preservation comparison remain
generic compiler responsibilities, not claims made by this profile.

**Profile authoring transition applied:** the proof field contract and both planning/proof
operation contracts now state that every repository-local executable or script named by
`proof.command` belongs in `proof.source_paths`; an external tool resolved from `PATH` does not.
The staged bundled-profile compile still passes 1/1 after this tightening, and the scoped
whitespace check remains clean.

Release remains blocked only on the generic multi-anchor disposition, a green rerun of the final
two focused behaviors after that disposition, and parent-integrator acknowledgement. No Research,
Updog fixture, Rust, run type, persona, installed profile, TUI, binary, or live-run state was
modified by this lane.

### 2026-07-14 — multi-anchor transition resolved in the generic compiler

The blocker paragraph above is retained as the exact pre-fix failure history. The generic compiler
now evaluates a graph-set selector independently for each ticket target and unions the results by
semantic member identity. The focused generic regression proves that a proof which is both a
ticket target and a positive-depth member compiles exactly once and recompiles deterministically.
The live Software proof ticket now reaches `proof-execution`; its next fail-closed boundary correctly
requires the current composite receipt before the last pre-review output. The regression owner is
reordering its fixture to that published runtime contract, with no YAML change requested.

The YAML lane is therefore no longer blocked on selector topology. Release still waits for the
correctly ordered final two Software behaviors to pass and for the parent integrator to acknowledge
the complete handoff.

#### 2026-07-14 — advertised broker ordering correction

The final sentence above is retained as the historical handoff state, but its statement that the
regression owner was reordering the fixture is superseded. The temporary test-only
compile-before-output sequence was discarded. The focused fixture now exercises the advertised
broker boundary exactly: worker output is accepted first, then `compile-ticket` executes the
configured current-step checks and scoped compile. Generic three-valued receipt deferral permits
only the receipt predicates that this immediately following compiler action can produce; all
graph, review-effect target, and semantic readiness predicates remain strict. The current 4/5
blocker is durable composite-parent `proof_set` readiness/review-effect materialization in the
generic runtime, not Software YAML topology or fixture ordering.

#### 2026-07-14 — proof-authority rationalization approved, patch deferred to stable core

The earlier profile retained `change|migration.test_command`, `test_paths`, `test_layer`,
`behavior_readback`, `baseline_signal`, and `not_proven` as a transitional ticket-local model while
graph-selected proof execution was being introduced. Current reference tracing shows no
compatibility constraint requires those duplicate fields in a newly copied Software 0.4 profile:
the legacy `expected-red` and `focused-test` checks are unreferenced, every executable
baseline/promotion member is sourced from `proof.command`, and `proof.owned_paths` has no consumer.
Copied installed profiles remain version-pinned and are not mutated by a template cleanup.

The approved transition, once the active generic review-effect fix reaches a stable checkpoint,
is to keep `change|migration.owned_paths` as production-write authority and `proof_strategy` only
as workflow-routing metadata; make `proof.command`, `source_paths`, `covered_paths`,
`working_directory`, `layer`, `conditions`, `expected_signal`, `why`, and `not_proven` the sole
executable and semantic evidence authority; and remove the unused duplicate fields, grants,
preconditions, and legacy checks. The old wording above remains as the migration history. This
lane will not edit that surface against a moving generic core snapshot; staged profile compilation,
dangling-reference inspection, and focused runtime regressions are required immediately after the
patch lands.

#### 2026-07-14 — compiler lane syntax check request

The compiler lane's post-fix Software regression is temporarily blocked before profile compilation:
`graph.yaml`'s new `proof.command` description is a YAML plain scalar containing `authority:` and
therefore parses as an invalid mapping value. Please quote it or convert it to a folded scalar in
this lane's owned profile file, then record the staged compile result here. No semantic wording
change is requested; the compiler lane has left the profile edit untouched to avoid crossing the
active YAML lease.

#### 2026-07-14 — integration record request (`primary-integrator`)

The focused Software regression owner now records the sole-proof-authority profile at **6/6**, and
the live leased YAML files appear to contain the approved removal of duplicate executable/evidence
fields. Please preserve the syntax-request paragraph above as failure history, then append the
current disposition here: exact staged profile compilation, dangling-reference/template parity
results, path-scoped formatting/whitespace evidence, and whether this YAML lease is released or
still blocked. The central Software row will remain `in_progress` until this owner record and the
independent design verdict are signed; this request does not authorize another lane to edit the
leased profile files.

#### 2026-07-14 — current Software regression coordination (`compiler-graph-tdd/root`)

The shared tree moved after the 6/6 checkpoint above and now runs the Software target at 4/6.
The defect fixture still writes legacy status `active` although the leased schema now declares
`unresolved`/`diagnosed`/`superseded`; the same-objective mitigation fixture also no longer selects
the expected implementation ticket under the current readiness query. All four proof/compiler
behaviors pass, including exact graph-set execution and implementation-review stamping. Please
coordinate the schema/rule disposition with `software-profile-regressions/root` and record a new
six-test checkpoint before releasing this YAML lease. No compiler relaxation or cross-lane profile
edit has been made.

#### 2026-07-14 — transition from the 4/6 moving-tree checkpoint to the final Software 0.4 contract

The 4/6 paragraph above is retained as the exact moment when older fixtures first encountered the
new causal lifecycle. It is not a request to restore `defect.status: active`, speculative change
planning, or cross-objective mitigation. The current profile intentionally models defects as
`unresolved -> diagnosed`, with `superseded` reserved for an explicit non-goal/replacement. Status
is compiler-owned. A Bug Fix objective without a defect first emits `objective.ground-defect`; an
active defect without one focused diagnostic seam is grounded before `proof.prepare`; only a
prepared diagnostic proof can feed `defect.diagnose`; and only reviewed causal diagnosis can admit
an exact same-objective addressing change. The regression owner has received this frozen sequence
and is replacing obsolete fixture assumptions rather than weakening it.

The earlier “proof-authority rationalization approved, patch deferred” section is likewise
superseded as implementation state, while remaining the decision history. The patch has landed:

- `change|migration.owned_paths` is the only production write authority and `proof_strategy` only
  routes the honest baseline workflow;
- `proof.command`, `source_paths`, `covered_paths`, `working_directory`, `layer`, `conditions`,
  `expected_signal`, `why`, and `not_proven` are the sole executable/semantic proof authority;
- the duplicate change/migration test fields, `proof.owned_paths`, and the dead `expected-red` /
  `focused-test` checks and grants are removed; and
- implementation review stamps exactly one planned implementation subject plus its exact direct,
  single-subject focused proofs. `proof.establish` remains for standalone, stale, boundary,
  diagnostic-green, legacy, and recovery execution rather than duplicating the routine
  implementation proof ticket.

#### 2026-07-14 — final topology and proportional-boundary decisions

The default now uses the smallest trustworthy compiler boundary for each risk class:

- ordinary focused implementation remains one cohesive vertical ticket with three stages only:
  `establish-baseline -> implement -> review`; the compiler executes the complete promotion set at
  the implementation output boundary and requires the `proof_set` receipt before review;
- newly authored diagnostic and material risk-boundary proof sources use the conditional
  `proof.prepare` lane, whose worker may write only the exact graph-selected `source_paths`, whose
  historical baseline is compiler-recorded, and whose independent review stamps `planned ->
  prepared`;
- elevated/critical implementation waits for at least one prepared boundary proof per introduced
  risk, while boundary green execution waits until every introducing change and mitigation control
  is terminal; and
- both mitigation and acceptance require nonvacuous boundary assurance. Acceptance also requires
  an accepted `risk_acceptance` decision, but that authority never substitutes for every active
  risk proof being passing and current at delivery.

Focused proofs verify exactly one change or migration, though they may additionally bind the
defect, contract, or flow whose behavior gives that change meaning. Boundary proofs verify risk and
never masquerade as a change-owned focused proof. A proof outside those two structural shapes is a
planning gap; the ordinary planning operation cannot silently rewrite historical proof authority.
Such a semantic replan requires explicit human change control. This is an intentional finite
limit, not prompt-only automatic invalid-oracle classification.

Critical changes require a recovery plan and an accepted `review_authority` decision. Configuration
can express that authority kind and the independent Reviewer boundary, but cannot prove a person's
real-world qualification. The profile therefore does not claim mechanically verified reviewer
credentials.

#### 2026-07-14 — delivery identity and decision-init transitions

Candidate delivery is exact, current, and revisable in place. The operation can read/write the one
existing stale delivery and remove obsolete closure edges, while its path authority remains empty.
The rule's successful target state now requires both a current reviewed candidate and
`edge_count(objective.delivered_by) == 1`; `delivery.fulfills max: 1` alone only constrained the
forward direction. Creating a second delivery therefore leaves the emission predicate true and the
ticket cannot close. Both risk treatments require at least one risk-boundary proof and require all
such proofs passing with a current promotion receipt before this candidate can exist.

New fully specified decisions now initialize as `accepted` and carry one typed kind from
`design`, `risk_acceptance`, or `review_authority`, avoiding a ceremony-only resolution ticket for
authority the approved seed already owns. The `decision.resolve` lane remains for compatible
legacy `open` decisions and validates rather than invents the approved choice.

#### 2026-07-14 — honest preparation limitation and generic handoff

`proof.status: prepared` deliberately means only “the source seam, oracle, and exact historical
baseline passed preparation-time independent review.” It does **not** prove that proof-source bytes
remain unchanged across a later ticket. Covered product bytes must be allowed to change, so normal
receipt currentness cannot serve as that cross-ticket invariant; `preserve_source_paths_from`
correctly protects only the baseline-to-implementation interval within one ticket.

The design review located the narrower generic primitive already available in compiled-member
receipts: reuse `source_path_manifest`, validate the latest exact reviewed preparation member and
its profile/proof/command/cwd/member identity, then recompute only project `source_paths` while
ignoring covered product bytes. That generic implementation is now owned by
`proof_preparation_binding/root`. Until it lands and its diagnostic/boundary regressions pass, this
mailbox continues to describe source-only cross-ticket immutability as a release blocker rather
than pretending that compiler-owned lifecycle status proves bytes.

#### 2026-07-14 — final YAML compile and hygiene checkpoint

After the causal lifecycle, focused/boundary split, lean implementation flow, typed decisions,
nonvacuous accepted-risk assurance, and mechanical single-delivery target-state invariant landed:

- `CARGO_TARGET_DIR=/tmp/koni-software-yaml-target cargo test -p koni-cli
  installs_bundled_profiles_without_touching_product_state -- --nocapture` passes **1/1**;
- `CARGO_TARGET_DIR=/tmp/koni-software-yaml-inventory-target cargo test -p koni-cli
  embedded_profile_inventory_matches_package_templates -- --nocapture` passes **1/1**;
- a recursive search finds no remaining duplicate executable fields, `proof.owned_paths`,
  `localization_status`, dead legacy checks, or removed `verify` workflow step references in the
  Software YAML; and
- path-scoped `git diff --check` for the ten leased YAML files and this mailbox is clean.

The YAML schema/operations/rules/workflows are frozen for the expanded regression run. This lane is
not yet released: it waits for `software-profile-regressions/root` to publish the current matrix,
for the final design disposition to be routed through the parent integrator, and for the generic
source-only preparation binding above. No installed profile, binary, Research profile, run-type
prompt, Rust source, TUI, cockpit, or live project/run state was changed by this YAML lane.

#### 2026-07-14 — coordination sweep

Before this checkpoint I re-read the central registry and the current Software YAML, design,
regression, default-design, presets/prompts, graph-TDD, and review-effect coordination records. The
older notes above remain visible beside these dated transitions, per the user's living-spec rule.
No competing lease was found in the ten Software YAML files. Questions about obsolete Bug Fix
prompt fields remain routed to the preset owner; generic manifest enforcement remains routed to the
compiler owner; the regression owner has the exact frozen ticket sequence and invariant list.

#### 2026-07-14 — exact sibling-proof execution gate discovered during the frozen audit

The earlier proof-target topology section says an `establish-proof` ticket executes exactly its
selected proof. That remains the desired contract, but it is not yet mechanically established for
two active proofs sharing one verified subject. Generic graph-set validation currently requires
every member branch to traverse from `$target`; it does not permit selecting a proof already pinned
as a ticket target directly. Software therefore includes the chosen proof and its semantic subjects
as targets, and the `verified_by` traversal from a shared subject can discover a sibling proof.
The ticket read scope excludes that sibling, so the current behavior should fail closed at scope
compilation rather than execute it, but fail-closed deadlock is not exact one-proof progress.

The clean generic transition is to admit a target-anchored direct-member selector (the ticket's
exact proof candidates, filtered to active proof type) in a graph set, then have Software baseline
and promotion sets consume those pinned proof targets without inverse fan-out. Adding self-edges,
duplicate proof-set nodes, or broad sibling read authority would encode compiler limitations into
the domain graph and is rejected. The regression owner already has the two-sibling shape on its
matrix; this finding is now routed to the generic compiler owner and remains a release gate beside
the source-only preparation manifest. No YAML workaround was applied after the green schema compile.

#### 2026-07-14 — expanded-suite handoff and YAML lease release

The regression owner expanded the current Software target from six to nine tests while this lease
was frozen. An independent run of
`CARGO_TARGET_DIR=/tmp/koni-software-regressions-target cargo test -p koni-core --test
software_proof_gate -- --nocapture` reaches **8/9** on the current moving core. Conditional
architecture, causal diagnosis/addressing, exact multi-defect planning coverage, proportional risk
routing, typed accepted/legacy decisions, exact implementation review effects, current exact
delivery, and adverse proof evidence all pass.

The remaining test, `software_bug_fix_bootstraps_prepares_diagnoses_then_plans_the_causal_change`,
successfully performs no-defect grounding, source-only diagnostic preparation, reviewed diagnosis,
non-speculative change planning, baseline execution, product implementation, promotion execution,
and implementation review. It then fails closed during implementation `finish` because the rule's
`change-implemented-with-current-promotion-proof` target predicate remains true. The exact failure
has been routed to `software-profile-regressions/root` to identify which readiness/currentness
conjunct drops after review. No current-proof predicate, causal gate, or YAML scope was weakened to
make the fixture pass.

Per the parent integrator's handoff, the ten Software YAML files are now **released/frozen to
integration** at the green bundled-profile compile and inventory-parity checkpoint. This means the
file lease is available; it does not convert the 8/9 runtime state or the two generic gates into a
release claim. The expanded regression owner retains the Bug Fix failure. The compiler owners
retain (1) cross-ticket source-only preparation binding and (2) direct exact selection of pinned
proof targets for sibling-safe graph sets. Any generic fix that needs a minimal selector/predicate
consumer in Software YAML should be routed back as a new bounded follow-up rather than edited
silently.
