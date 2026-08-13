# Software projects

Use the installed Software profile as the baseline. The current bundled default is Evidence-Guided
Vertical Delivery: start with the smallest affected repository-native boundary and one cohesive
behavioral claim, then add interfaces, contracts, flows, risks, migrations, or extra proof only when
they change implementation authority or trustworthy evidence. Specialize it around the repository's
real domain boundaries, dependency directions, delivery process, and native verification commands.

## Resolve baseline compatibility first

The installed profile remains authoritative. Treat the model in this reference as the current
bundled default and a design option, not permission to upgrade an older installed profile silently.
If the installed Software version still requires universal architecture, Integrator transcription,
`pr_ready`, or another historical contract, present one explicit choice in the approval packet:

- preserve those semantics and customize only the requested project-specific surface; or
- migrate the installed profile coherently to the current default, naming every graph, rule,
  operation, workflow, check, run-type, agent, cockpit/report, fixture, and active-run compatibility
  consequence.

Never mix half of each model. Adopting the current graph or proof semantics requires auditing every
bound prompt and compiler layer that describes them. One run selects one resolved run type. Split
independent feature and defect outcomes into separate runs; when a defect is causally necessary to
one feature outcome, use the dominant intent preset and model the defect inside the same objective
rather than inventing a composable mixed preset.

## Map the architecture

Inspect workspace manifests, source entry points, dependency declarations, APIs, schemas,
migrations, event or file formats, CI, tests, deploy units, and ownership documentation. Verify
exact project-root-relative paths. Distinguish:

- a **system** or domain boundary with independent ownership or behavior;
- an **interface** that other boundaries consume;
- a **data model** whose evolution or ownership matters;
- a **contract** that constrains compatibility, invariants, or quality;
- a **flow** that connects multiple boundaries in an end-to-end behavior.

A directory is not automatically a system, and a function is not automatically an interface. Keep
details as fields when they have no independent lifecycle, queries, relationships, or proof.

Resolve a named product or repository surface before selecting its system and paths. Require
positive first-party evidence that binds the named surface to its selected owner, such as its exact
route or command registration, rendered label, maintained ownership declaration, or a consumer that
imports its entrypoint. A package, directory, or generic shared-component name identifies only a
candidate. Do not stop at the first lexically plausible package or directory. A failed or truncated
broad search does not select an owner. Enumerate the plausible first-party roots, search each with
bounded objective-specific terms, and follow the positive match to its owning entrypoint. A bounded
search with no objective-specific match counts against that candidate. Do not inspect or serialize
that candidate's generic implementation seams until positive objective-specific evidence selects it;
continue bounded owner discovery across the remaining plausible first-party roots. If no candidate
has positive ownership evidence, report the exact modeling gap instead of assigning generic seams
from a convenient package.

## Adapt the baseline ontology

Retain or refine these default roles when the repository evidence supports them:

| Type         | Durable meaning                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `objective`  | User or project outcome and success signals for the run.                                                          |
| `system`     | Owned code or runtime domain with exact paths and responsibilities.                                               |
| `interface`  | Public API, event, command, file, or boundary surface.                                                            |
| `data_model` | Persisted or shared schema whose compatibility matters.                                                           |
| `contract`   | Behavioral, compatibility, performance, security, or quality invariant.                                           |
| `flow`       | Material interaction across systems or interfaces.                                                                |
| `decision`   | Human-approved design, risk-acceptance, or review-authority choice; initialization is its only creation boundary. |
| `defect`     | Expected versus observed behavior and a diagnostic seam, becoming causal only after reviewed root-cause evidence. |
| `change`     | One reviewer-approvable vertical current-to-target product transition.                                            |
| `migration`  | Compatibility-sensitive transition with rollout or rollback semantics.                                            |
| `risk`       | Concrete failure mode with an explicit structural `mitigate` or `accept` disposition and residual exposure.       |
| `proof`      | One compiler-bound focused or boundary evidence obligation with a reproducible command and explicit limits.       |
| `delivery`   | Exact reviewed pre-sync composition that fulfills one objective.                                                  |

Add a project-specific type only when its identity changes compilation. Prefer fields such as owner,
exact paths, invariants, current state, target state, rollback, and proof strategy over synonymous
node types.

When adopting the current default, keep these compiler-relevant fields together rather than
scattering them through prose:

| Node        | Required current-default fields                                                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system`    | `kind`, `responsibility`, exact `owned_paths`, deliberate `contract_required: true                                                                                                                                            | false`, and a concrete `contract_reason` either way |
| `defect`    | Required `expected_behavior`, `observed_behavior`, and exact `reproduction_signal` or honest unavailable explanation; add `root_cause`, `causal_chain`, and `ruled_out_alternatives` only as one complete evidenced diagnosis |
| `decision`  | `kind: design                                                                                                                                                                                                                 | risk_acceptance                                     | review_authority`, question, options, already approved choice, rationale, and reversibility |
| `change`    | One-sentence `approval_claim`, current/target state, exact production `owned_paths`, blast radius, commit type, `proof_strategy`, `risk_tier`, concrete `risk_factors`, and a recovery plan for critical work                 |
| `migration` | Forward plan, exact production `owned_paths`, compatibility window, rollback plan, data-safety statement, and `proof_strategy`                                                                                                |
| `risk`      | `scenario`, `impact`, `likelihood`, `detection`, `treatment: mitigate                                                                                                                                                         | accept`, `treatment_rationale`, and `residual_risk` |
| `proof`     | `purpose`, `baseline_check_id`, claim, method, exact argv `command`, byte-causal `source_paths`, read-only `covered_paths`, contained `working_directory`, layer, conditions, expected signal, `why`, and `not_proven`        |
| `delivery`  | Target branch and summary; compiler-owned status becomes `candidate_ready` only after exact reviewed coverage                                                                                                                 |

> **Evolving to — Software default 0.5.0 (2026-07-15):** The proof row above records the
> Software-0.4 field contract. The current bundled default additionally requires one or more
> structured `oracle_cases`. Every case binds a stable ID, condition, bounded claim, callable
> production seam or real consumer, exact project-relative `seam_paths`, action, positive and
> material negative assertions, and any material environment/ordered recipe. Every seam path must
> resolve to the same normalized project-relative identity present in read-only `covered_paths`
> before ticket dispatch. `source_paths` remains the only proof/test write authority; a
> `uses`-linked system's other `owned_paths` never becomes proof capability by implication.

Do not initialize a Bug Fix with an untested suspicion written as `root_cause`, and do not seed a
speculative addressing change. A normal unresolved seed contains the objective, one grounded defect,
and exactly one focused diagnostic proof that verifies only that defect. If repository evidence
already establishes the complete causal triad, include it and skip diagnosis; otherwise omit all
three causal fields so the compiler schedules preparation and reviewed diagnosis before change
planning.

Use the current lifecycles literally when migrating to this model:

| Node        | Legal statuses and readiness meaning                                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defect`    | `unresolved`, `diagnosed`, `superseded`; status is compiler-owned and diagnosis review alone sets `diagnosed`                                                                                 |
| `decision`  | `open`, `accepted`, `superseded`; new approved seeds begin accepted, while `open` is a legacy validation path                                                                                 |
| `change`    | `planned`, `implemented`, `superseded`; passing implementation review alone sets `implemented`                                                                                                |
| `migration` | `planned`, `complete`, `rolled_back`, `superseded`; only `complete` is delivery-ready                                                                                                         |
| `risk`      | `active`, `superseded`; treatment readiness derives from edges, terminal controls, decisions, and current proof—not status                                                                    |
| `proof`     | `planned`, `prepared`, `passing`, `superseded`; `prepared` means preparation-time baseline and oracle were reviewed, while `passing` additionally requires current green execution and review |
| `delivery`  | `assembling`, `candidate_ready`, `superseded`; `candidate_ready` is pre-sync and remains valid only while exact reviewed closure is current                                                   |

Terminal adverse command outcomes remain durable compiler receipts rather than model-authored
failure statuses. Treat the installed schema as authoritative when customizing and never author a
compiler-owned status in a seed or graph delta.

## Store architecture facts once

Choose one authored direction and add an inverse alias when both directions are useful. Typical
canonical facts include:

- `interface.produced_by -> system`, inverse `exposes`;
- `data_model.owned_by -> system`, inverse `owns`;
- `contract.applies_to -> system|interface|data_model|flow`, inverse `constrained_by`;
- `flow.participants -> system|interface`, inverse `participates_in`;
- `change.realizes -> objective`, inverse `realized_by`;
- `change.introduces -> risk`, inverse `introduced_by`;
- `change.addresses -> defect`, inverse `addressed_by`;
- `delivery.fulfills -> objective`, inverse `delivered_by`;
- `proof.verifies -> change|migration|risk|defect|contract|flow`, inverse `verified_by`.

Scope every defect through canonical `defect.concerns -> objective` with virtual inverse `defects`
and exactly one objective. Require `defect.manifests_in -> system|interface|flow`; add
`defect.violates -> contract` only when a material contract exists. A malformed or legacy Bug Fix
with no defect or diagnostic seam receives one bounded graph-only grounding ticket. Every active
defect in every work kind must be diagnosed, addressed by a same-objective active change, and
currently proved before delivery; out-of-scope observations belong in non-goals, external
references, or a separate objective rather than as an active defect.

Use these risk directions and cardinalities:

- `change.introduces -> risk`, inverse `introduced_by`;
- `risk.threatens -> contract|flow|system|interface|data_model`, at least one;
- `risk.mitigated_by -> change|migration`, one or more only for `treatment: mitigate`;
- `risk.accepted_by -> decision`, exactly one only for `treatment: accept`, with schema maximum one.

Do not put edge-level predicates on the two treatment forms: a temporarily mismatched graph must
remain valid enough for a repair rule to classify it. Upstream gaps such as no eligible
same-objective control belong back in objective planning; the narrow risk lane may only repair
contradictory edges or a missing boundary proof. `implementation_ready_changes` selects only planned
design-complete changes whose dependencies are `implemented`, whose decision/migration prerequisites
are `accepted|complete`, and whose introduced risks are structurally valid with prepared boundary
proof. Acceptance remains residual-risk authority, never a substitute for boundary assurance.

Do not also store the reciprocal edge. Two directed edges are justified only when they are
independent facts that may differ, such as an interface's producer versus its many consumers.

For a revision or change-control patch, derive the delta from the exact validated base rather than
reconstructing the graph from the desired result. First place every affected base node and edge in
one disjoint ledger: retain, update, remove, or add. An existing identity belongs to exactly one
class. Omit retained facts from the patch, update an existing node in place when its semantic role
remains stable, remove only facts that must disappear, and add only genuinely new identities.

Check the serialized delta against that ledger before submission. One edge must not appear in both
the add and remove sets, and do not re-add retained edges. When replacing a node, classify each of
its incident edges after deciding whether the node identity survives. After a compiler rejection,
repair every named delta conflict without replaying the unchanged patch. Reconstruct the expected
result from base plus patch once; if it differs from the intended graph, correct the delta before
submitting it.

Every planned change should link to the exact systems, interfaces, models, contracts, or flows it
affects. Ticket scopes should project from verified owned paths, not human-readable boundary titles.

Compile the current conditional relationships explicitly:

- `objective.map-architecture` emits only when the objective's `systems` count is zero. Its
  read-only discovery step may read `.` to identify an unknown boundary, but graph and product
  writes remain narrowly operation-authorized.
- `system.specify-contracts` emits only when `contract_required` is true and virtual
  `constrained_by` is empty. `contract_reason` makes both true and false deliberate rather than
  inferred from a missing edge.
- Defect grounding emits only for a Bug Fix with no active defect or any objective whose active
  defect lacks exactly one focused defect-only diagnostic proof. It may add a missing defect/proof
  but no change. If more than one active diagnostic proof already exists, the same ticket is a
  fail-closed escalation: name the conflicting proof IDs and request human-authorized oracle
  selection or semantic replanning; never silently choose, delete, or supersede evidence.
- Diagnostic and risk-boundary proofs receive a conditional source-only preparation ticket whenever
  their compiler-bound reviewed source preparation is absent or stale. Diagnostic preparation binds
  the semantic proof node—including its exact `verifies` edge—while retaining the defect as
  review/read context, so reviewed diagnosis can add causal fields without circularly revoking the
  oracle. Risk-boundary preparation additionally binds the risk because its scenario and treatment
  must already be stable. Passing preparation review compiler-stamps `prepared`; focused
  implementation proof stays on the implementation lane and pays no preparation ticket.

> **Software-0.6 implementation-oracle correction (2026-07-16):** The sentence immediately above is
> retained as the Software-0.5 behavior but no longer describes the bundled default. A focused proof
> for `red_green` or `characterization` now uses the same source-only preparation lane before its
> linked change or migration can emit. That independent review must reject a narrow oracle which
> omits any declared render, query, mutation, persistence, or other material consumer route. The
> later implementation baseline may re-run but cannot rewrite the prepared source.
> `current_verification` remains the intentional exception: its existing proof is read-only and it
> receives no source-authoring preparation ticket.

- Change planning waits for at least one system, every contract-requiring system to be constrained,
  and every active defect to be reviewed `diagnosed`. It exact-covers all active defects with
  same-objective `change.addresses` edges.
- A `routine` change requires at least one active `focused` proof, each of which verifies exactly
  one change or migration. Prefer one primary cheapest trustworthy seam; add another only for a
  distinct remaining wiring, compatibility, runtime, UI, data, or operational gap. `elevated` and
  `critical` also introduce a risk with a distinct `boundary` proof that verifies the risk, not the
  change. A shared boundary proof may cover one real boundary, but green execution waits for all
  introducing subjects and controls; a focused proof spanning implementation subjects is
  structurally invalid.
- “Nonredundant” focused-proof plurality is a semantic independent-review judgment over claims,
  commands, layers, and `not_proven`; the compiler guarantees subject cardinality and
  execution/currentness, not that two differently shaped oracles add real information.
- A malformed risk emits one narrow treatment ticket. It must not reopen the objective or race
  implementation. Pair every mandatory `for_all` with explicit existence because an empty universal
  is true.

## Compile architecture gaps into work

The current progression is:

1. ground the smallest affected system when the approved seed does not already name one;
2. add only materially required contracts, interfaces, models, and flows;
3. ground any missing defect/diagnostic seam, prepare that source-only proof, and review causal
   diagnosis before planning a repair;
4. plan the fewest dependency-ordered vertical changes, each with a risk tier, adaptive focused
   proof, and one approval sentence;
5. prepare only newly authored diagnostic or risk-boundary proof; repair only malformed
   material-risk treatment or legacy open decisions;
6. run the honest focused baseline, implement the cohesive claim with compiler-run green promotion
   proof, then independently review—there is no routine duplicate Verifier or Integrator hop;
7. establish risk-boundary proof only after every introducing change and mitigation control is
   terminal;
8. assemble or revise exactly one current `candidate_ready` delivery, synchronize the target, replay
   safe composed proof, report, and await explicit promotion.

> **Software-0.6 ordering correction (2026-07-16):** Step 5 above previously limited preparation to
> diagnostic and risk-boundary proof. It now also prepares every red-green and characterization
> focused proof before step 6. A failed preparation review keeps product implementation ineligible.
> Passing preparation freezes the oracle source; ordinary final-review rework returns only to
> product implementation, not proof authoring.

Rules should emit only for observable gaps and stop emitting after satisfaction. Keep independent
changes parallel only when their graph and filesystem scopes are disjoint. Keep independent review
separate from implementation; add integration only for real composition.

Use one multi-system vertical change when the systems jointly deliver one atomic observable outcome,
share one proof seam and rollback decision, and their write scopes cannot produce independently
useful reviewed states. Split changes when any of outcome, dependency readiness, write authority,
evidence environment, risk tier, rollback, or independently releasable value differs. Never split
merely by file, layer, test versus production, documentation, or agent role.

Classify change risk independently of run size. `routine` needs one or more nonredundant focused
proofs, with every proof scoped to exactly one implementation subject. `elevated` and `critical`
need a distinct risk-boundary proof and at least one material risk; do not manufacture a risk merely
because a user selected Large. Every critical change needs a concrete recovery plan and an already
human-approved `review_authority` decision. That decision records operator-approved review authority
but does not mechanically prove specialist capability; if required domain expertise is unavailable,
review blocks and escalates. A material risk is delivery-ready only when its boundary proof is
passing/current and either `mitigate` names only terminal eligible controls or `accept` names
exactly one accepted `risk_acceptance` decision. Delivery must acknowledge the exact introduced-risk
set.

## Select an adaptive proof strategy

Give each product change one explicit strategy; do not pretend every task begins with a meaningful
red test.

Before dispatch, build one proof-construction ledger from the issued support evidence: command
ownership, the exact runner and working directory, required setup and environment, direct
dependencies, established harness conventions, and the real callable seams or consumers for every
oracle case. A proof-construction ledger is closed only when every material boundary has either an
authenticated repository input in its exact authority field or an evidence-backed `not applicable`
disposition. Proof source or covered product paths never stand in for missing support evidence. If
any material entry remains open, correct the model or request authority before asking a proof author
to guess.

Build that ledger from inspected repository content before serializing the proof. A filename in a
listing or search result authenticates identity, not its command, environment, or convention
semantics. Read the smallest authoritative manifests, runner configuration, setup, compilation or
module configuration, and established proof examples needed to support the chosen command and
harness. Place every repository input relied on by the selected proof in exactly the proof field
matching its authority role: executable or proof-owned bytes in `source_paths`, claimed product
seams in `covered_paths`, and read-only environment or convention evidence in `support_paths`.
Discard inspected alternatives that the selected proof does not use. Do not serialize the proof
while any command, environment, dependency, or harness claim remains supported only by a familiar
name or remembered convention. Reconcile the closed ledger against the downstream preparation
contract before submission so planning grants every read-only fact that proof construction and
review will require.

Design the proof as executable behavior, not source inspection. Exercise each declared route through
its production seam, keep the routes independently reachable, and isolate an expected absence so it
cannot hide setup failure or prevent existing behavior from executing. Accept a historical signal
only after the runner collects the intended cases and the authenticated receipt maps each failure to
the declared behavior. Judge diagnostic adequacy from that receipt: command spelling and ordinary
repository output preferences are not themselves evidence that diagnostics were preserved or
suppressed.

Perform a historical-executability audit before selecting the proof strategy. For every case, name
the input, transition or command, and observable that the application actually owns. The historical
harness must reach every unchanged application-owned boundary and every preservation assertion. Only
the intended target assertion may be absent or red before implementation. Fixture setup and every
unchanged or preservation route must remain executable without the missing target. The target
invocation itself may be the isolated red at its real application-owned seam and must execute there
after implementation. When the application owns a declarative transition and another system owns its
dispatch, assert the exact structured transition or command that the application owns, including
preserved unrelated state, only when that declaration is the bounded claim. A claimed runtime effect
still requires separate evidence that executes its actual owner.

Derive oracle polarity from the target contract: assert the desired behavior, not the historical
implementation. In a red-green proof, desired cases fail before the product change while
preservation cases remain green. Never encode the current output as the expected value merely to
make the fixture executable; that creates an oracle which stays unchanged after implementation.

Do not replace a production seam named by an oracle case with a test double or a local
reimplementation of its decisions. Substitute only dependencies outside the claim. A test double
must return values valid at the real consumer boundary and may expose an observable marker for a
selected downstream route; it must not return a foreign representation that the production runtime
would reject. Keep the parent-to-child consumer composition real when that composition is the
claimed behavior.

Construct the fixture in layers. First make one known existing preservation route execute through
the real parent and consumer so it proves the harness is viable. Then add every desired-red and
remaining preservation route without allowing one failure to short-circuit the others. After each
run, classify every diagnostic before editing. If the same harness failure recurs without changed
evidence, stop editing and reconstruct the fixture from the support ledger and reference proof; do
not cycle through unrelated invocation forms, mock representations, or assertion polarity.

Before accepting the historical signal, perform a future-green viability audit against the approved
target. Trace the target consumer contract across every harness boundary. A substituted boundary
must either delegate behavior outside the claim or expose the complete valid surface the target will
consume, and every configured substitute must be exercised. Reject a historical red that depends on
a harness boundary which will still reject the target contract after the product exists. The
intended behavior may be absent before implementation; the harness capacity needed to observe it may
not be.

Maintain a claim-to-observation ledger from each material approval claim to an observable assertion
at a real seam. A route marker proves selection, not the selected behavior's internal claim. If data
use, persistence, authorization, compatibility, or another claimed effect is outside the focused
proof, state that limit and remove the effect from the approval claim, or add the smallest distinct
evidence and authority needed to prove it. `not_proven` may bound a claim; it may not contradict
one.

Turn that ledger into a claim-to-owner audit. For each material claim, name the actual runtime owner
of the behavior, its input, its observable output, and whether the proof executes that owner or
substitutes it. A substituted target owner cannot prove its own behavior; it proves only selection
or routing to the substitute. Dependencies outside the claim may be substituted when their contract
is valid and exercised. When the target owner is substituted, mark the claim `not_proven`, narrow
the approval claim, or add the smallest distinct evidence that executes the real owner.

Review findings must be repairable by the authority they reopen. Before requesting producer rework,
intersect the demanded repair with that producer's graph and filesystem grants. Route a model,
command, scope, or other upstream-contract defect through configured change control instead of
spending bounded source rework on an impossible mutation.

### `red_green`

Use when a missing behavior can be expressed by a focused test that fails for the intended reason
before product edits. Bind one exact argv array to the focused proof. If an existing focused test
already reproduces the defect, the baseline step may make no file edit; do not churn the oracle
merely to manufacture a test delta. Otherwise edit only the proof `source_paths` or minimal harness
before recording red. Require an expected-red historical receipt, then the same graph-selected proof
passing with a current receipt after implementation. A `red_green` implementation subject must have
at least one genuinely expected-red proof; supplementary current or characterization proofs are
justified only by a distinct preservation or boundary gap and cannot substitute for that causal red
evidence. Reject environment failures, unrelated regressions, vacuous assertions, and weakened tests
as red evidence. When the observed failure cannot be reduced to a trustworthy command or typed
observation, ask for the missing oracle or block instead of treating any nonzero exit as
reproduction.

### `characterization`

Use when behavior exists but is poorly specified, legacy, or risky to change. First encode and
review the relevant current behavior or boundary observation, then implement the approved transition
and require current focused plus broader verification. A pre-change observation may explain
causality, but it does not remain current proof after inputs change.

### `current_verification`

Use only for mechanical edits or already-correct behavior directly exercised by the exact existing
focused check before and after the change. It cannot prove a genuinely new behavior merely because a
broad suite remains green. Record why expected red and characterization are not honest, then require
current project-native checks and independent review against the target contract. `not_proven` is an
explicit limitation, never a substitute for evidence.

Use proof nodes and risks to make missing coverage compile into tickets. Require broader contract,
integration, static, or end-to-end checks only when the focused command leaves a material boundary
gap.

An implementation ticket pins exactly one implementation subject plus its well-scoped focused proof
set. Its baseline step records the graph-selected historical baseline; its implementation step may
write only production `owned_paths`, preserves the baseline proof sources, and asks the compiler to
run the complete current promotion set before output advances to independent review. Passing review
stamps only that subject and its focused proof candidates. Ordinary implementation therefore emits
no duplicate proof-execution ticket. Keep `proof.establish` for prepared risk-boundary proof,
standalone/legacy evidence, stale recovery, and contracts or flows not accepted by implementation
review.

Preparation is deliberately narrower than passing proof. `proof.prepare` may author only a
compiler-selected diagnostic or boundary proof's `source_paths`, while `covered_paths` remain
read-only; its baseline receipt and independent review can set `prepared` but cannot set `passing`.
A safe compiler must also compare a source-only preparation binding across tickets so covered
product changes do not stale the preparation while command, subject, oracle, or proof-source churn
does. If the installed compiler lacks that predicate, disclose the limitation and do not imply that
`prepared` alone proves byte-current oracle identity.

> **Software-0.6 preparation scope (2026-07-16):** The diagnostic/boundary-only sentence above is
> historical. Preparation now also owns source authoring and oracle-completeness review for
> red-green and characterization focused proofs. Their implementation tickets receive only product
> `owned_paths`; proof `source_paths` are read-only at both baseline confirmation and final-review
> rework. Current-verification keeps the unchanged read-only implementation path.

> **Software-0.5 oracle-scope clarification (2026-07-15):** Before a proof reaches preparation or
> implementation, validate every structured oracle case against the real invocation chain. Missing
> invoked seams, test-local substitutes, or a `seam_paths` entry absent from `covered_paths` are
> graph-contract errors to correct before dispatch, not reasons to union system ownership or widen a
> worker's write scope. The workflow continues to project only `source_paths` and `covered_paths`;
> exact source paths are writable only in the proof-authoring step, while every product seam remains
> read-only.

> **Software-0.5 proof-source lifecycle transition (2026-07-16):** The oracle-scope clarification
> above remains authoritative but was incomplete about interactions between independent proofs.
> Diagnostic and risk-boundary proofs are independently preparation-managed, so their `source_paths`
> must be pairwise physically disjoint. Focused implementation proofs have a separate authoring
> lifecycle and must be physically source-disjoint from both preparation sets. Equality and
> ancestor/descendant containment all violate this authority boundary. Named tests or describe
> blocks within one file are not independent compiler authority; cases that intentionally share the
> file and lifecycle belong to one proof node. The bundled graph now compiles both separations as
> `path_sets_disjoint` constraints so a bad seam fails during graph validation, before any source is
> prepared or tokens are spent on a downstream correction.

Delivery exact-includes the objective-local active closure and exact-acknowledges every introduced
risk. It requires all active defects diagnosed/addressed/proved, all implementation subjects
terminal, all proof current, and both mitigation and acceptance risks to retain current boundary
evidence. Superseded proofs remain visible historical evidence but do not satisfy focused/boundary
purpose or enter `delivery.includes`. Reuse and revise one stale delivery rather than adding a
second. A reviewed delivery is only `candidate_ready`; closure or review-effect drift must reopen
it, and target synchronization, fresh composed replay, reporting, and explicit promotion remain
later compiler-owned boundaries.

## Preserve run-type intent

Keep Small, Medium, and Large as complexity envelopes rather than semantic work kinds. Small uses
one focused planning pass and low parallelism for a bounded outcome; Medium is the standard
combined-plan path; Large separates architecture, risk, and proof planning and adds run-level
independent review. Run size never manufactures architecture, risk, or boundary proof.

New Feature and Bug Fix are narrow Medium-derived intent presets. New Feature seeds
`objective.work_kind: new_feature`, acceptance examples, non-goals, the smallest vertical claims,
and contract/risk structure only when material. Bug Fix seeds `objective.work_kind: bug_fix`,
expected/observed/reproduction evidence, and a focused defect-only diagnostic proof; unresolved
cause blocks change planning. Do not compose selected run types at runtime or duplicate Medium
wholesale merely to alter intake and planning instructions.

When customizing, retain these five defaults unless the project has an independently meaningful
lifecycle or assurance mode. A new peer run type is justified by different pipeline boundaries,
approval, verification, promotion, or isolation behavior. A derived intent preset is justified when
intake, planner emphasis, or safe parallelism changes while the resolved lifecycle remains Medium.

## Keep authority proportional

- Planning and architecture producers are graph-write/product-read only; they submit complete typed
  deltas directly to review.
- `proof.prepare` is proof-source write/product-read only. Implementation baseline may write focused
  proof sources; implementation may write only the selected change or migration `owned_paths`.
- `proof.establish`, verification, and review are read-only. Review effects, not reviewer prose, own
  semantic status transitions.
- Delivery assembly is graph-only. Integrator exists for exact delivery composition and real target
  conflicts, not routine transcription.
- Baseline-writable proof source paths must be disjoint from production write paths by equality and
  directory containment in both directions. Never rely on prompt obedience for this boundary.
- Detect repositories whose normal oracles are inline with product bytes—for example Rust unit tests
  in the same source file, executable notebooks, or generated fixtures beside implementation—before
  proposing `red_green` or characterization authoring. Path-level authority cannot preserve one
  region while later rewriting another region of the same file. Prefer an existing repository-native
  external test/harness file when it provides the same trustworthy seam. If no such seam exists, ask
  the user to choose between introducing a separate harness and explicitly designing a different
  compiler/workflow authority contract; describe the lost byte-preservation guarantee and every
  affected check, operation, workflow, and review invariant. Never silently relabel new behavior as
  `current_verification`, grant the baseline step product-write authority, or pretend prompt
  discipline separates bytes inside one path.
- An invalid proof seam routes to explicit human-authorized scoped change control or a blocker. Do
  not claim automatic bounded oracle replacement unless the installed compiler binds trigger
  evidence, same-subject semantics, and replacement-generation provenance.

## Discover repository-owned commands

Resolve exact argv from CI, task runners, manifests, and maintained documentation. Model focused,
package, workspace, static, integration, or smoke checks only when the repository supports them.
Keep setup and dependency mutation in an authorized action or workflow step, not a read-only check.
Do not retain generic `pnpm`, `npm`, `cargo`, `pytest`, or browser commands from a default without
evidence.

Bind commands, working directory, relevant inputs, accepted exit codes, effect, and receipt type
explicitly. Changed code, config, command, or target must stale current proof.

For a graph-selected proof, separate byte-causal `source_paths` from claimed product
`covered_paths`. Include every repository-local executable or script named by the exact command in
`source_paths`; an external tool resolved from `PATH` is not project source. Keep the working
directory project-contained and the executable inside effective read authority. Do not claim source
preservation for a local harness whose bytes are omitted from the causal manifest.
