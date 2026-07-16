# Software Profile Design Review

- **Owner:** `software_design_review`
- **Status:** active — read-only adversarial review
- **Lease:** Software 0.4 profile, prompts, run presets, focused regression tests, and related design docs are inspection-only. This lane will not edit product, profile, test, or other documentation files.
- **Scope:** Find unreachable paths, vacuous predicates, authority mismatches, duplicated work, submit/check ordering defects, closure gaps, run-type drift, and ceremony without correctness. Separate Software-owned findings from generic compiler blockers.
- **Started:** 2026-07-14

## Findings and questions

Review in progress.

## 2026-07-14 adversarial design verdict — pre-disposition snapshot

This section preserves the findings against the live Software 0.4 snapshot after sole-proof
authority cleanup and the first normal-order 5/5 focused gate. Some fixes are already being
applied by the YAML and regression owners; later dispositions should be appended here rather than
rewriting this evidence.

### Release-blocking Software findings

#### 1. Bug Fix diagnosis cannot obtain evidence that requires a write

The design document explicitly says some defects need instrumentation or a write-based reproducer
and that a conditional diagnosis ticket closes that gap (`software-profile-engineering.md`, the
2026-07-14 refinement around lines 206–212). The executable profile does not provide that path:

- unresolved/hypothesized defects prevent `objective.plan-change` eligibility;
- `defect.diagnose` is the only emitted work;
- `design.defect.diagnose` permits no new nodes and only an existing defect update;
- `defect-diagnosis` uses the read-only `change-designer`, declares no write paths, and promises no
  product modification.

This works only when static inspection or an already-existing command is enough. If localization
requires adding a narrow reproducer, trace hook, fixture, or diagnostic harness, the ticket cannot
create the evidence needed to reach its own target. Repeating it eventually exercises a generic
worker circuit breaker, but that is not the documented evidence-acquisition path.

Minimum non-bloated contract:

1. Keep diagnosis conditional: a seed with a confirmed causal defect pays no diagnosis ticket.
2. For unresolved/hypothesized work, seed the defect plus one diagnostic/focused proof using the
   existing sole-authority proof fields; do not require a speculative product change before cause
   is known.
3. Use one write-capable diagnostician step plus the existing independent review. Grant writes
   only to the compiler-selected diagnostic proof `source_paths`; all `covered_paths` and
   change/migration `owned_paths` remain read-only. A read-only diagnosis simply writes nothing.
4. Reject concrete overlap between diagnostic/proof-source write authority and production write
   authority. Otherwise an agent can label a production file as proof source and edit behavior
   before the compiler records the baseline.
5. Preserve expected behavior, observed behavior, and reproduction signal. Successful transition
   requires confirmed localization plus nonempty root cause, causal chain, and ruled-out
   alternatives; when an executable diagnostic exists, bind its exact baseline receipt and let
   semantic review reject wrong-reason reds.
6. Plan the causal change only after confirmation, or explicitly revalidate/update an earlier
   hypothesis. The present diagnosis operation cannot repair a stale change plan created from an
   unresolved hypothesis.
7. If safe confirmation remains impossible, one bounded attempt should end in a typed compiler
   blocker with the missing-evidence reason. It must not fabricate confirmation or spend two blind
   retries merely to reach the generic no-output circuit.

#### 2. A bad proof seam has no bounded replan/supersession route

The profile tells Implementer and Verifier to stop and replan when the configured oracle is wrong,
and the design principle says recovery must change localization, plan, proof seam, or authority.
Mechanically, implementation and proof execution forbid graph mutation, `proof.status` is
compiler-owned, a design-ready objective no longer emits `plan-change`, and no Software operation
can replace or supersede an invalid existing proof. A green-but-vacuous command rejected by the
Reviewer therefore reopens the same immutable plan once and then blocks; an adverse command keeps
useful terminal evidence but likewise has no profile route that can change the seam.

Minimum bounded route:

1. Trigger only from current adverse terminal evidence or an exhausted review specifically
   classified as an invalid oracle/proof seam—not from every implementation failure.
2. Emit exactly one graph-only resolver/replan ticket for the pinned proof and one implementation
   subject. It may add at most one replacement proof and performs no product write; do not add a
   `proof_attempt` node or standing remediation lane.
3. Keep the old proof immutable. A passing independent review lets the compiler stamp it
   `superseded` only after the replacement has the same exact semantic subject closure and purpose,
   all sole-authority fields, and legal bounded paths.
4. Permit the one owning change/migration's `proof_strategy` to change only when the replacement's
   `baseline_check_id` changes coherently. Do not broaden product scope, mutate unrelated nodes, or
   create residual-risk acceptance authority.
5. Recompile/retire the blocked ticket and emit a fresh workflow from the replacement. Allow one
   replacement per original proof chain; a second same-class failure preserves both proofs and
   receipts and blocks for human change control.

#### 3. Implementation can execute and semantically stamp a shared boundary proof too early

Every active proof directly linked through `change.verified_by` enters the implementation ticket,
baseline/promotion set, and review effect. The assurance regression deliberately creates one
boundary proof verifying both the introducing change and risk, then declares the introducing
change implementation-ready while a distinct mitigation change is still `planned`. A passing
implementation review can therefore mark the risk boundary proof `passing` before the control—or
another change/migration subject of that proof—exists in terminal form. This conflicts with the
separate `executable_proofs` rule, which correctly waits for terminal subjects and controls.

Preferred simpler invariant:

- Direct implementation proof sets contain active `focused` proofs only.
- Each focused proof verifies exactly one change or migration implementation subject. It may also
  verify that subject's defect, contract, or flow.
- Elevated/critical readiness finds a distinct active `boundary` proof through an introduced risk,
  rather than making that proof part of the implementation review.
- Boundary proof executes only through `proof.establish` after every introducing change and every
  mitigation control is terminal, or the acceptance decision is accepted. Waiting only for
  mitigation controls is insufficient when a risk-only proof could run before the changed behavior
  exists.
- Implementation target state, graph-set selectors, ticket targets, and review effects all use the
  exact same active focused set. Delivery separately requires the risk boundary proof passing and
  current.

This preserves legitimate self-mitigation, shared risk/control boundary proof, and sibling controls
without deadlock. If two proposed changes truly need one focused implementation proof, they are one
reviewable slice and should be merged; shared boundary proof remains legal and deferred.

An alternative is to treat implementation review as atomic terminalization of its one subject and
require every direct proof to be executable under that hypothetical state. That is mechanically
sound but more complex and retains mixed focused/boundary execution. The topology above is clearer,
cheaper for routine work, and makes the local-versus-composed evidence distinction explicit.

#### 4. Multiple diagnosed Bug Fix defects can strand the objective

The `objective.plan-change` target state requires all active objective defects to be diagnosed but
only `exists` one objective change addressing any active defect. Delivery later requires every
active defect to have an objective-local implemented addressing change and passing/current proof.
With two diagnosed defects and one addressed defect, planning closes, the one change can implement,
delivery stays false, and no rule emits work for the second defect.

Planning acceptance must be per-defect: for every active objective defect, require at least one
active objective-local change that addresses it. The focused regression must use two diagnosed
defects and prove one addressing edge leaves planning open.

#### 5. Wrong-objective mitigation routes to a narrow ticket that cannot close

`upstream_risk_gaps` treats intersection with globally eligible controls as enough. A planned
change from another objective is globally eligible, so the risk avoids upstream routing; it is not
structurally valid and enters `risk.plan-treatment`. That ticket can update only the selected risk,
cannot create product/control scope, and its read neighborhood does not discover the correct
same-objective sibling control. Removing the bad edge merely turns the risk into the upstream gap
the ticket was not allowed to solve.

The upstream query must use the same same-objective/direct-required control eligibility as
structural validity. Add a cross-objective-control regression and require objective planning, not
an unclosable narrow repair.

#### 6. Proof-source authority can alias production authority

Software prose defines `proof.source_paths` as proof/test/harness bytes and `covered_paths` plus
change/migration `owned_paths` as product scope. The runtime freezes source bytes only after the
baseline. Nothing in the profile mechanically rejects a source path that equals or contains a
production path; the baseline step explicitly grants writes to source paths. Such a graph can
authorize a production edit before the expected-red/characterization receipt, defeating causal
ordering while remaining path-valid.

The compiler should reject concrete overlap between baseline-writable proof sources and the
implementation subject's production write scope. This is also required for the write-capable
diagnosis route above. Broad directory grants should force the planner to narrow one side rather
than make the distinction unverifiable.

### Important closure and efficiency findings

#### Stale `candidate_ready` delivery is not invalidated

`delivery.prepare.when` stops at the existence of any candidate-ready delivery for the objective.
Exact closure is checked only when that delivery is first reviewed. If later supported replan,
supersession, risk repair, or proof replacement changes active closure, the stale candidate
suppresses reassembly. The current active closure must be compared to the candidate's exact
`fulfills`/`includes`/`acknowledges` sets on every compile; a mismatch should supersede/reopen it and
emit one new delivery. This becomes release-blocking once the bounded replan route exists.

#### Decision validation spends two model boundaries without adding authority

Every decision is created only in the human-approved seed and already requires `choice`, `options`,
`rationale`, and `reversibility`, but its initial status is `open`. It then pays a read-only Change
Designer step and an independent Reviewer solely to compiler-stamp `accepted`. The mechanical
review-effect preconditions require nonempty fields but do not prove `choice` is one of `options`;
the same human approval already bound the choice.

The lean contract is for initialization/approval to compiler-stamp complete seeded decisions
accepted. An unresolved decision must block approval or enter explicit later human change control.
If post-approval validation is retained for risk reasons, collapse it to one genuine trust boundary
and mechanically validate option membership; do not use two models to restate a completed choice.

#### Implementation uses a duplicate execution-agent boundary

The Verifier manually executes the exact command, submits semantic readback, and then
`compile-ticket` immediately reruns the same graph-selected command for the authoritative receipt;
the Reviewer performs the independent semantic/correctness judgment afterward. For routine
red-green/characterization work, attach `promotion-proof-set` and source preservation to the
Implementer's implementation step, then let Reviewer consume the compiler receipt. Keep a Verifier
agent for standalone proof, current-verification baseline sufficiency, or genuinely independent
runtime observation. This removes one model boundary and one manual command execution from the
routine path without weakening compiler or review authority.

The deeper output-before-check duplication is generic: a worker cannot consume the authoritative
receipt before submitting its readback, so it often runs the command once itself and the compiler
runs it again. A future broker check capability or compiler-run receipt handoff could remove that
cost without changing Software semantics.

#### Defects outside `work_kind: bug_fix` are not required to close

Delivery exact-includes all active objective defects, but causal diagnosis/addressing/current proof
is enforced only when the objective's work kind is `bug_fix`. A general/new-feature objective with
an active defect can therefore reach candidate readiness while merely carrying the unresolved
defect. Either prohibit active defects outside Bug Fix or apply causal defect closure whenever an
objective has one; work-kind should not make a material defect informational.

#### Critical work cannot mechanically prove qualified review

The profile mechanically adds risk, boundary proof, and recovery for critical work, while qualified
domain review remains a prompt-only escalation. This is honestly documented, but the default can
still complete if the model Reviewer fails to report its lack of qualification. A conservative
default should require a human/domain-review decision for critical security/privacy/financial/
safety/regulatory work, or explicitly block critical completion until project customization binds
that authority.

### Sole-proof-authority trace

Removing the legacy `change|migration.test_command`, `test_paths`, `test_layer`,
`behavior_readback`, `baseline_signal`, and duplicate `not_proven`, plus `proof.owned_paths`, is the
correct direction:

- executable baseline and promotion members are sourced only from `proof.command`;
- proof path authority/currentness uses `source_paths`, `covered_paths`, and
  `working_directory`;
- change/migration `proof_strategy` only chooses the workflow;
- change/migration `owned_paths` remains the production-write authority;
- the removed fields had only dead checks, nonempty review preconditions, emitted path grants, or
  no mechanical consumer, so they could disagree with the proof that actually ran.

One prompt drift remains after the cleanup: `codex/software/agents/change-designer.toml` still asks
for exact “owned and test paths.” It should say change production `owned_paths` plus proof
`source_paths`/`covered_paths`, preserving the one-authority model.

### Generic compiler gates, not Software workarounds

The independent graph-TDD engine review still records the following domain-neutral concerns for
generic-owner disposition and current-tree recheck:

- source-preservation comparison must be bound to the exact green pre-execution source manifest
  under the same authority/execution boundary, not a separate preflight susceptible to mutation;
- a repository-local executable must be inside effective step read authority and, under Software's
  contract, included in `proof.source_paths`; hash-binding an otherwise unauthorized executable is
  not red-to-green preservation;
- per-step graph scope, compiler-owned rule-anchor identity, and current-side receipt freshness
  were previously validated-but-inert or incomplete and require the generic owner's final evidence.

Software prose already says local executables belong in source paths, but prose is not mechanical
enforcement. The profile should not add duplicate executable fields to hide a compiler authority
gap.

### Regression matrix still required

The normal-order focused suite reached 5/5, and the added two-sibling implementation regression
correctly proves one implementation review stamps only its pinned proof. That is valuable but not
coverage of the failure states above. Minimum additions are:

1. unresolved Bug Fix requiring a new diagnostic proof-source write;
2. two diagnosed defects with only one addressed;
3. shared boundary proof with a planned sibling change/migration or nonterminal mitigation control;
4. wrong-objective mitigation routes upstream;
5. invalid proof seam creates exactly one replacement and then blocks on a repeated same-class
   failure;
6. active closure change invalidates/reassembles `candidate_ready` delivery;
7. two sibling `proof.establish` tickets each select and stamp exactly one proof;
8. a proof-source/production-path overlap is rejected before baseline work;
9. at least one complete implementation path for each strategy through baseline, product edit,
   compiler promotion set, semantic review, exact effect replay, and finish;
10. a real broker `context -> output -> compile` path, not only direct action calls, for one normal
    Software implementation.

### Run-type review

The five run types are otherwise philosophically aligned. Small/Medium/Large are complexity
envelopes; New Feature and Bug Fix are Medium-derived intent presets; Large adds run-level composed
review; Bug Fix serializes implementation. Small's one-question limit and Medium's one-to-three
question policy remain prompt contracts rather than mechanical counts, which is acceptable if
documented as guidance. No Research profile change is recommended by this review.

## 2026-07-14 integrator acknowledgement — `primary-integrator`

The central Software row now preserves the earlier 6/6 checkpoint beside this expanded release
matrix instead of treating the focused lane as final proof. The concrete proof-source versus
production-write overlap invariant is routed to `compiler-graph-tdd.md` as a generic equality and
both-containment-direction gate; the Software owner is retaining the profile-level diagnosis,
bounded proof replacement, boundary-proof, per-defect, mitigation-routing, candidate-currentness,
and efficiency dispositions. Please append a signed final status after re-reading those owner
responses and the resulting tests. This acknowledgement claims no source, profile, test, or live
state.

## 2026-07-14 bounded proof-replanning assessment — `software-profile-design-review`

The proposed typed upstream change-control route is the right conditional architecture: an
ordinary implementation/proof operation may request a zero-mutation proposal, independent review
and explicit Lead/human approval bind the authority expansion, a narrow application performs the
graph-only repair, and compilation emits fresh implementation work. Routine runs pay no extra
model boundary.

The current generic engine does **not yet mechanically prove the complete advertised contract**:

1. `UpstreamChangeIntent.reason` is untyped prose. Although the engine binds the source ticket,
   step, output, context hash, targets, and audit record, it does not bind an
   `invalid_proof_oracle` classification to the exact current adverse receipt or failed semantic
   review. A Verifier request is emitted before its authoritative receipt exists, and a Reviewer
   cannot directly emit a step output request. Without a typed evidence reference, this must be
   described as a general human-authorized scoped replan rather than compiler-classified invalid
   oracle recovery.
2. `max_new_nodes: 1` limits one application, not one replacement chain. Resolved change-control
   history belongs to the source ticket; the fresh ticket compiled around the replacement has no
   inherited generation bound. Compiler-owned replacement provenance (old proof, replacement,
   generation) and uniqueness/generation enforcement are needed to prevent iterative proof
   weakening.
3. Approval binds the application operation, existing targets, scope, and summary, not the exact
   semantic shape of the future graph delta. A validator or exact contract must require one new
   proof with the same purpose and exact subject/`verifies` set as the pinned old proof while
   constraining which oracle fields may change.

No-product-write authority is already expressible with empty path scope, and the old proof can be
superseded through a passing application-review effect. One engine detail matters: when an
application emits a nonempty graph delta, review-effect candidates are the delta's authored node
IDs rather than the ticket targets. The application must therefore explicitly nominate/upsert the
pinned old proof (or candidate selection must change) for the effect to set it superseded.

Disposition: adopt this route, but do not call it mechanically sufficient until trigger evidence,
replacement-chain provenance, and same-purpose/same-subject delta validation are bound and
regressed. If the first binding is intentionally omitted, document the route as explicit human
change control whose reason may be invalid-oracle evidence, not automatic invalid-oracle
classification.

## 2026-07-14 focused/boundary topology follow-up — `software-profile-design-review`

The live split now correctly keeps implementation review focused on direct, single-subject
implementation proofs and makes risk boundary proof executable only after every introducing
change and mitigation control is terminal. That removes the earlier shared-proof early-stamping
defect.

It exposes a different blocking lifecycle gap: no operation can author a **new** boundary proof's
`source_paths`. Planning and risk treatment are graph-only; implementation writes only direct
focused-proof sources; and `proof.establish` is a read-only verifier/reviewer lane after governed
subjects are terminal. Pointing the boundary proof at an existing suite works, but a genuinely new
cross-boundary acceptance test deadlocks unless its source is incorrectly placed in production
`change.owned_paths`—precisely the alias the generic disjointness invariant should reject.

The clean risk-scaled remedy is a conditional proof-preparation/arming transition shared by
standalone diagnostic and boundary proofs:

1. a source-only worker may write exactly the pinned proof's `source_paths`, never production
   owned paths;
2. the compiler records the exact configured historical baseline and source manifest;
3. an independent Reviewer validates the oracle, expected signal, subject, and limits;
4. diagnosis consumes an armed diagnostic proof, while elevated/critical implementation waits for
   its boundary proof to be armed;
5. the existing green `proof.establish` transition remains gated on every governed subject/control
   becoming terminal.

This spends no routine boundary and avoids ambiguous shared-proof ownership or oracle churn across
sibling implementation tickets. A regression must use an absent-at-seed boundary source file;
reusing an existing suite does not exercise the missing authority. The red-green operation prose
also still says implementation passes the focused *and boundary* set, which contradicts the new
topology and should be amended beside the topology evolution record.

## 2026-07-14 Bug Fix preset/schema drift — `software-profile-design-review`

The Bug Fix preset currently instructs planning, in both its inherited planning instructions and
combined-plan prompt, to seed `defect.localization_status`. The live defect schema has no such
field: unresolved/diagnosed is now compiler-owned lifecycle status, while causal completion is
represented by optional `root_cause`, `causal_chain`, and `ruled_out_alternatives`. A planner that
faithfully follows the preset will therefore emit an invalid graph seed (and must not work around
it by seeding compiler-owned `status`).

The preset should say to seed expected behavior, observed behavior, the available reproduction
signal, and only causal fields supported by evidence; missing complete causal evidence naturally
initializes the compiler-owned unresolved state and emits diagnosis. Add a regression that
initializes a minimal schema-conforming seed derived from the exact Bug Fix prompt. Catalog and
inheritance tests alone cannot detect prompt-to-schema field drift.

The same preset says unresolved evidence should compile diagnosis but still unconditionally asks
planning to create “the smallest change that addresses the defect.” That is a speculative causal
claim before diagnosis. When cause is not confirmed, the seed should contain only the objective,
grounded defect, diagnostic proof, and material architecture; reviewed diagnosis must precede
creation of an addressing change. Only an already confirmed cause may seed the addressing change
and focused implementation proof in the initial plan.

## 2026-07-14 stale-delivery authority follow-up — `software-profile-design-review`

The currentness query correctly reopens a `candidate_ready` delivery whose exact reviewed closure
changed, but the emitted `delivery.prepare` ticket cannot perform its advertised revision. Its read
scope does not traverse objective `delivered_by`, and its write scope contains only the objective;
the existing delivery is outside both node authorities. Creation works, revision does not.

The rule must include the objective's exact existing active delivery in read and write node scope
while keeping path scope empty and enforcing one-delivery identity. The regression must prove the
same delivery ID is revised and re-reviewed after closure change, the exact include/acknowledge set
changes, and no second delivery is created.

The later scope patch makes in-place revision possible, but uniqueness still needs a target-state
invariant. `delivery.fulfills max: 1` caps each delivery's outgoing objectives, not the number of
deliveries pointing to one objective; `max_new_nodes: 1` still permits a second node beside a stale
candidate. Require `objective.delivered_by` cardinality exactly one at successful review, or split
creation (`max_new_nodes: 1`) from revision (`max_new_nodes: 0`).

## 2026-07-14 proof-preparation receipt semantics — `software-profile-design-review`

The first live preparation draft used `check_passed: baseline-proof-set` as both preparation
currentness and durable cross-ticket state. That cannot work because the binding deliberately
includes `covered_paths`: the production change that preparation enables necessarily makes the
historical command non-current. This would remove an elevated change from
`implementation_ready_risks` during its own target-state validation, re-emit preparation at higher
priority, and make a fixed defect's expected-red diagnostic proof impossible to “prepare” again.

Until the compiler can bind and compare a source-only preparation manifest, the finite honest
fallback is a compiler-owned `proof.status: prepared` set only by a passing preparation review
whose workflow required the exact historical baseline receipt. Preparation selects only planned
diagnostic/boundary proofs; cross-ticket readiness uses prepared status; later green establishment
may advance prepared to passing. This proves reviewed preparation-time evidence, not cross-ticket
source preservation, and the documentation must retain that limitation. A regression must mutate
covered product bytes after preparation and prove implementation still finishes, preparation does
not re-emit, and the diagnostic proof can later turn green.

## 2026-07-14 accepted-risk assurance gap — `software-profile-design-review`

The acceptance branch currently permits zero boundary proofs through a vacuous universal, despite
the elevated/critical contract requiring genuinely distinct boundary assurance. Its delivery branch
also ignores current risk-proof evidence. Delivery can therefore become `candidate_ready` beside a
still-planned boundary proof and require a second review after that proof changes the closure.

An acceptance decision grants authority for residual exposure; it does not replace tier-triggered
evidence. Require an explicit active risk-boundary proof for each tier-triggered risk, require it
prepared before implementation, and require every active risk proof passing/current before
delivery for both mitigation and acceptance. This keeps delivery downstream of assurance and
avoids knowingly stale candidate work.

## 2026-07-14 generic source-only binding feasibility and slot handoff — `software-profile-design-review`

The cross-ticket oracle-currentness blocker does not require a new node-manifest subsystem. Every
compiled graph member already records `CompiledMemberExecutionBinding.source_path_manifest`; the
engine builds it with `project_source_path_manifest`, validates its integrity, and uses the same
representation for within-ticket `preserve_source_paths_from` comparison. A narrow generic
predicate/decorator can reuse that authority across tickets:

1. select the latest valid historical preparation member receipt for the proof and configured
   baseline parent;
2. require a passing preparation review/effect (the compiler-owned prepared status is the cheap
   lifecycle witness) and validate receipt integrity, profile, source proof ID, semantic proof
   binding, command/cwd/member contract, and recorded pre/post equality;
3. recompute only the bound `source_paths` manifest with the configured exclusions and compare it
   to `source_path_manifest`;
4. deliberately ignore covered/product byte currentness, because those bytes are expected to
   change after a valid red or characterization baseline;
5. require this predicate at implementation dispatch/completion and later green establishment.

This preserves the exact reviewed oracle while allowing product evolution, and is materially
smaller than adapting Research's tree-oriented filesystem-manifest contract. The current
`status: prepared` fallback is finite and honest but must remain documented as preparation-time
evidence only until this predicate lands.

### Open findings at slot release

- **P1:** land and regress the source-only preparation predicate above; otherwise cross-ticket
  source preservation remains an explicit trust gap.
- **P1:** finish the Bug Fix no-defect/diagnostic lifecycle and update the preset so it neither
  emits nonexistent `localization_status` nor speculates an addressing change before diagnosis.
- **P1:** accepted tier-triggered risk must require boundary proof, and delivery must wait for its
  current passing evidence.
- **P1:** bounded proof replacement needs typed/admitted evidence (or honest general-human-change-
  control wording), compiler-owned replacement-chain provenance, and exact same-purpose/subject
  validation.
- **P2:** delivery revision now has node scope, but successful target state must enforce exactly one
  objective delivery so adding a second stale sibling cannot close.
- **P2:** reconcile remaining prompt vocabulary (`test paths`, `localization state`, `baseline
  signal`, proof `rationale`, and implementation passing boundary proof) with the sole schema
  authority.
- **P2:** critical qualified review is still model-enforced rather than mechanically bound; the
  default must block or explicitly require project customization rather than imply qualification.
- **P2:** expose a compiler-owned current-step check tool or retain an explicit efficiency debt:
  model semantic readback before compile otherwise causes manual command execution followed by a
  duplicate compiler execution.

Required final re-review evidence: bundled Software compilation; prompt/schema validation; the
expanded adversarial regressions (diagnostic source creation, post-product prepared proof, accepted
risk boundary, shared proof terminality, wrong-objective mitigation, stale in-place delivery,
multi-defect exact coverage, bounded replacement); and the complete existing normal-order suite.
This handoff makes no release claim.

### 2026-07-14 current-tree disposition request — `primary-integrator/root`

Your open findings above remain the signed acceptance contract, but current source and owner
records moved after the snapshot you reviewed. The Bug Fix run-type now contains exact diagnostic-
proof/no-speculative-change instructions and no `localization_status`; CLI assertions check those
literal constraints. Current rules also include `edge_count(objective.delivered_by) == 1`, and the
YAML owner says accepted mitigation/acceptance paths require nonvacuous current boundary proof.
These observations are not an integrator release verdict.

Please re-read the current frozen Software YAML/preset bytes and append an explicit per-finding
disposition: fixed as specified, partially fixed, still open, or superseded by a named honest
limitation. In particular, verify the edge direction/cardinality actually rejects a second
delivery, accepted-risk delivery cannot pass beside planned/stale boundary proof, the minimal Bug
Fix seed compiles without a speculative change, and prompt vocabulary matches the sole schema.
Then inspect the expanded regression owner's exact tests; source presence without the adversarial
test is not closure. Preserve every finding above as causal history.

Cross-ticket source-only preparation and bounded replacement-chain provenance remain separate
generic/open gates unless their owners publish green, independently reviewed implementations. No
Software source/profile, test, installed binary, cockpit/cmux surface, Updog state, or live/
forensic run was changed by this request.
