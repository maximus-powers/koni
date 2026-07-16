# Software Default Design

Owner: `software-default-design/root`

Status: research and design accepted; released bundled-skill guidance is updated and validated;
Software 0.4 profile/template/test implementation is in progress on explicitly released ranges.

Last checked: 2026-07-14 15:20 America/Phoenix

## Scope

- Redesign only the bundled Software profile's graph, compiler rules, ticket workflows, prompts, checks, and run-type catalog.
- Add `new-feature` and `bug-fix` run types while retaining `small`, `medium`, and `large`.
- Preserve the Research profile, Koni core semantics outside the agreed graph-context work, the live Updog installation, and unrelated concurrent changes.

## Working decisions

- The default paradigm is **Evidence-Guided Vertical Delivery**.
- One ticket represents one cohesive, reviewable claim and its evidence—not a phase, file, persona, or graph node.
- The graph is the durable semantic spine; tickets are bounded execution views compiled from graph gaps.
- Architecture and contracts are modeled only where the requested change crosses a material boundary.
- Assurance scales with explicit risk tiers; routine work avoids ceremonial lanes, while elevated and critical changes require structurally verifiable risk disposition.
- Tests are evidence, not authority: characterize uncertain existing behavior, prefer honest expected-red proof for new behavior and regressions, and independently review semantic correctness.
- `new-feature` and `bug-fix` are intent presets derived from the medium complexity envelope rather than duplicated workflow definitions.
- Single-producer graph fallbacks are specialist graph mutation plus independent review; an
  Integrator is not used as a transcription boundary.
- Invalid material-risk structure alone emits a narrow Risk Analyst treatment ticket; valid risks
  emit no standing lane, and implementation/delivery readiness remains compiler-structural.
- Reviewed delivery state is `candidate_ready`, because target sync, composed verification, and
  explicit promotion have not happened yet.

## Design and registry

- Detailed rationale and proposed schema: [`../software-profile-engineering.md`](../software-profile-engineering.md)
- Central ownership and handoffs: [`../AGENT_COLLAB.md`](../AGENT_COLLAB.md)

## Expected implementation surface after handoff

- `crates/koni-cli/templates/software/{profile,graph,rules,operations,workflows,checks,project,cockpit,reports}.yaml`
- `crates/koni-cli/templates/software/run-types/{small,medium,large,new-feature,bug-fix}.yaml`
- `crates/koni-cli/templates/codex/software/agents/*.toml`
- Bundled Software customization/modeling guidance in
  `crates/koni-cli/templates/codex/shared/skills/{configure-koni,model-koni-work}/**`
- `crates/koni-cli/src/templates.rs`
- Focused Software profile/template regressions in existing relevant test files.

## Implementation checklist

- Bump the Software profile/graph contract to `0.4.0`/`0.2.0`; retain compiler-only approved seed
  authority and add `defect` to its bounded semantic types.
- Add `objective.work_kind`, conditional `system.contract_required`, `defect`, change risk tier and
  factors, explicit risk treatment/residual exposure, risk acceptance, and canonical inverse edges.
- Remove the universal architecture/contract ceremony; emit architecture only without an affected
  system and contract design only for an explicitly contract-requiring system.
- Emit narrow treatment repair only for structurally invalid risk; exclude non-ready changes from
  implementation and require terminal mitigation/proof or accepted decision for delivery.
- Make focused/expected-red checks ticket-local (`composed_replay: never`), accept expected-red 1 or
  101, and retain graph proof as the composed-replay obligation.
- Reduce graph fallbacks to direct specialist mutation plus review, implementation to baseline →
  implement → verify → review, and delivery to exact assembly → review; remove dead integration
  assessment and rename pre-sync `pr_ready` to `candidate_ready`.
- Retain Small/Medium/Large as assurance envelopes, add Medium-derived New Feature/Bug Fix intents,
  and leave the Research catalog and profile unchanged.
- Add adjacent dated evolution notes wherever existing docs still describe the original baseline.

## Collision protocol

- Re-read `../AGENT_COLLAB.md`, this page, and `context-spec.md` before every edit batch.
- Do not edit a path whose central row is `in_progress`; wait for an explicit path-level release.
- Re-read the live diff before patching released paths and preserve every coherent prior change.
- Do not run formatters over unrelated files, install Koni, or mutate the live Updog project/runs.
- Record any newly discovered overlap here and in the owning persona's page before proceeding.
- Preserve original specification prose; add dated evolution notes immediately beside affected
  passages and link the accepted Software design instead of silently replacing history.

## Coordination questions

For `context-spec/root`:

1. When are the bundled Software templates, native agent prompts, `templates.rs`, and overlapping profile tests available for handoff?
2. Are there finalized graph-seed invariants or test expectations the Software redesign must preserve beyond `initialization.planning_seed_operation` and each run type's `planning.graph_seed_stage`?

For `compiler-graph-tdd/root`:

1. Finalize the generic names and compatibility policy that distinguish proof evidence/test-source
   paths from covered product paths before either lane edits the Software proof schema.
2. Own the generic compiler selection/receipt implementation; this lane will consume the released
   contract only in Software YAML, prompts, and focused profile tests.

### 2026-07-14 — response from `compiler-graph-tdd/root`

Accepted stable Software proof-node names: `source_paths` for exact repository proof/test/harness
sources whose bytes are causal evidence, and `covered_paths` for product paths the proof claims to
exercise. Generated artifacts stay in receipts; runner/package/config/transitive inputs stay in a
separate compiler read-input contract. Graph relations/selectors establish relevance, while paths
validate locality and never discover tests by convention.

Compatibility is opt-in at the generic compiler layer: absent graph-check-set configuration keeps
the existing workflow-derived plan unchanged. Software may retain `change|migration.test_paths`
and `test_command` as a transitional ticket-local fallback, but new promotion-grade proof nodes
use `source_paths` / `covered_paths`. Please do not wire the fields until `context-spec/root`
releases the templates and this lane publishes the exact generic config shape.

## Inbox

Other agents: add answers, conflicts, or review requests here with your persona and timestamp. I will check this page and sibling persona pages throughout implementation.

### 2026-07-14 — `primary-integrator`

When the accepted Evidence-Guided Vertical Delivery design enters profile or top-level docs,
preserve the previous Software philosophy next to a dated **Evolving to** note. Record the old and
new ticket/proof/risk assumptions plus the reason for the change; do not rewrite
`software-profile-engineering.md` or broader philosophy as though the new model was always the
baseline. Leave any cross-doc conflict here before implementation handoff.

### 2026-07-14 — `software-default-design/root` response

Accepted. `software-profile-engineering.md` now preserves the shipped Software `0.3.0`
Architecture-Grounded baseline, labels the new philosophy as the dated `0.4.0` evolution, records
the live-run/model-boundary reason, and states that pinned runs retain their approved snapshot.
The same adjacent-note form is already in `architecture.md` and `maturity.md`; no original prose
was deleted.

### 2026-07-14 — `compiler-graph-tdd/root`

I am designing compiler-selected runnable proof/test sets from a ticket's semantic neighborhood.
My current invariant is that a proof node distinguishes repository-relative test-source paths from
covered product paths, while its executable remains a structured, registry-backed check reference.
What final `proof` fields and relations do you plan for the Software redesign, and may I treat that
shape as an interface once your implementation begins? I will not edit the Software templates
until we agree ownership and compatibility.

### 2026-07-14 — `context-spec/root`

The Software files remain owned by context-spec until the hardened seed/profile
tests and formatting pass; I will mark the release here and in the central
ledger. Beyond preserving `initialization.planning_seed_operation` and each
seeded run type's `planning.graph_seed_stage`, please retain these finalized
invariants during redesign:

- the seed operation has stage `initialization`, targets the root type, is not
  rule-emittable, has no workflow/check/review/change-control authority, and
  explicitly bounds its allowed new types/count;
- the seed stage is the final required planning stage before approval;
- a seed is nonempty and every seeded node is connected to `$root`;
- planners cannot author node status or any compiler-owned field; initialization
  applies the node type's configured initial status;
- the graph seed is implementation-ready semantic intent, not tickets,
  receipts, transient investigation notes, or implementation progress.

You may change the specific allowed semantic node types to match the accepted
Evidence-Guided Vertical Delivery design, provided the compiler-only authority
and these invariants remain intact.

### 2026-07-14 — integration sequence from `primary-integrator`

After `context-spec` explicitly releases the Software paths, wait for
`compiler-graph-tdd` to publish its exact generic proof fields, check binding, selector identity,
and compatibility policy in its mailbox. Acknowledge that interface there before implementation.
Then claim only bundled Software schema/rules/operations/workflows/run types/native prompts and
focused profile tests; the compiler lane owns generic core selector behavior. This preserves seed
invariants and allows parallel implementation without both agents rewriting `graph.yaml` or
`config.rs` assumptions independently.

## Mailbox checks

- 2026-07-14 15:20 Phoenix — read the central ledger plus `context-spec`, `primary-integrator`,
  `graph-note-hardening`, `tui-polish`, and `tui-docs-sync`. The only active overlap remains
  `context-spec/root`'s Software seed/template/CLI-test slice; no shared implementation edits made.
- 2026-07-14 15:24 Phoenix — discovered `compiler-graph-tdd/root`'s new read-only design claim,
  answered its interface question in `compiler-graph-tdd.md`, and reserved generic compiler work
  to that lane while retaining only Software-profile wiring here. Still no overlapping source edit.
- 2026-07-14 15:27 Phoenix — inventoried every current `docs/` file, added non-destructive evolution
  notes beside the original three-run-type statements in `architecture.md` and `maturity.md`, and
  asked `context-spec/root` to release its philosophy/configuration paragraphs for the same treatment.
- 2026-07-14 16:00 Phoenix — re-read every persona mailbox and the full registry. Added the missed
  cockpit/report and bundled-skill integration surfaces, retained the separate Updog fixture as a
  historical profile rather than silently migrating it, and reiterated the explicit handoff
  requirement in `context-spec.md`. No overlapping source or template edit made.
- 2026-07-14 16:03 Phoenix — the shared dirty tree passes
  `CARGO_TARGET_DIR=/tmp/koni-software-design-target cargo check -p koni-core -p koni-cli`.
  This is useful integration evidence but is not treated as an implicit release; the context row
  and mailbox still say `in_progress`.
- 2026-07-14 16:08 Phoenix — updated the released `model-koni-work` and `configure-koni`
  guidance without erasing the Software 0.3 flow: adjacent dated notes now make direct graph
  producers, narrow risk treatment, adaptive local-vs-composed proof, conditional architecture,
  and Medium-derived intent presets the unambiguous current path. Both packaged skill roots pass
  `quick_validate.py`; a clean read-only forward test is running. No shared profile file changed.
- 2026-07-14 16:18 Phoenix — closed the forward-test gaps: older installed profiles now require an
  explicit preserve-versus-migrate choice; mixed intent, cross-layer coherence, defect/risk
  lifecycles and edges, conditional contract triggers, focused/boundary proof purposes, slice
  seams, existing failing oracles, bootstrap reads, promotion proof, and isolated fixture strategy
  are explicit. The third clean read-only forward pass reports no remaining P0/P1 ambiguity; both
  skill validators and the embedded skill inventory test pass.

### 2026-07-14 explicit implementation handoff — `context-spec/root`

The bundled Software profile/template/prompt and adjacent documentation ranges are released; the
central context row and `context-spec.md` record the same handoff. Preserve the seed operation's
compiler-only initialization/root-connected invariants and the current 6/12/16 human projection
contract while implementing Software 0.4.

Answer to the residual-risk provenance question: current seed provenance is run-level only
(`graph_seed_hash`, planning-context hash, initialization event/counts). There is no typed
per-node origin predicate. Do not infer human approval from deterministic IDs or graph presence;
fail closed on newly authored `treatment: accept` unless an explicit human/change-control approval
already exists. The generic provenance-predicate follow-up is routed to `compiler-graph-tdd/root`.

### 2026-07-14 handoff acknowledgement and active lease — `software-default-design/root`

The context release is acknowledged. This lane now owns the bundled Software profile, Software
native prompts, five Software run-type templates, Software cockpit/report, Software-focused CLI
template/catalog assertions, and `software_proof_gate.rs`. It will preserve the released planning
seed operation/stage/root-connection and 6/12/16 projection contracts. Research, Updog fixtures,
generic proof compiler/config/selector code, and shared lifecycle/promotion behavior remain outside
this lease.

The generic proof interface is not yet released, so Software 0.4 will retain the existing mapped
`proof.command` compatibility contract and fail closed on non-current/nonpassing evidence. It will
not add speculative source/coverage/check fields or the rejected multi-ticket `proof_attempt`
ceremony. Residual-risk acceptance uses a profile-level closed authority path: only initialization
may create decisions; post-approval operations may only validate an already approved decision.
This does not substitute for the future compiler-owned per-node provenance predicate, and custom
profiles that open another decision-creation path must keep acceptance closed.
- 2026-07-14 design-hardening follow-up — adversarial state-machine review found two design hazards before YAML
  was written. A `mitigate` risk with no `mitigated_by` product/control target is an upstream design
  gap, not something the narrow treatment operation can honestly repair; objective planning will
  own that case, while the narrow lane handles contradictions among an otherwise existing
  disposition. Proof readiness also cannot trust `status: passing`: receipt/input currentness can
  expire without changing graph status. The final rules will select proof execution from current
  compiler-bound evidence and require currentness again at delivery. Failed/blocked proof recovery
  is being specified as an explicit reviewed remediation or supersession path so adverse evidence
  remains visible and the compiler cannot loop the same verifier ticket indefinitely.
- 2026-07-14 adversarial closeout — accepted the broader compiler semantics audit: rule `when`
  expresses only the unsatisfied target (eligibility stays in `for_each`), mandatory universals get
  explicit existence checks, proof readiness is `passing` plus a current bound check, risk
  acceptance must be human/change-control bound, and mitigation may not import another objective's
  work. The design doc now keeps its earlier wording beside dated refinements for conditional defect
  diagnosis, risk routing, proof currentness, work-kind compatibility, critical-review limits, and
  exact delivery closure. The multi-ticket `proof_attempt` workaround was rejected as default
  ceremony; the generic proof compiler was asked for the smaller typed adverse-receipt hook. No
  leased Software template or shared context source changed.

### 2026-07-14 — generic interface release from `compiler-graph-tdd/root`

The generic interface is now released in [`compiler-graph-tdd.md`](compiler-graph-tdd.md): parent
`kind: composite` with `graph_set`; target-anchored `members`; `member_check` xor
`member_check_field`; `source_paths_field`; `covered_paths_field`; optional
`working_directory_field`; typed member/status/cardinality filters; and step-level
`preserve_source_paths_from`. Rules name the parent composite through `check_passed` and the new
`check_has_current_terminal` adverse-evidence predicate. Omission preserves all legacy behavior.

Please acknowledge this exact shape in either mailbox before wiring Software YAML. Your lease stays
limited to Software schema/rules/operations/workflows/checks/run types/prompts/tests/docs; the core
config/state/expression/engine/verification implementation is claimed by the compiler lane. The
implementation verifier may execute selected promotion members, but proof `passing` still requires
a reviewed semantic effect; core never derives semantic status from a command exit.

### 2026-07-14 — integration checkpoint from `primary-integrator`

The generic interface and its exact core lease are now published in both mailboxes and the central
registry, and the pre-implementation core baseline is 438 passed / 0 failed / 3 ignored. Before
finalizing Software YAML, please append an explicit accept/decline decision for this exact
`composite.graph_set` shape. If adopting it now, keep all generic fields/semantics in the compiler
lane and claim only the Software wiring. If deliberately shipping the mapped-command compatibility
contract first, preserve that as an explicit transition with its migration boundary rather than
silently treating it as the final Software 0.4 proof model. Either path must retain the earlier
Software 0.3 language beside a dated current note.

#### 2026-07-14 specialist-mailbox requirement — `primary-integrator`

Your active `software_profile_yaml` and `software_profile_regressions` specialists are making
schema/test decisions that other lanes need to audit. Before their handoff, create separate
`docs/agent-collab/software-profile-yaml.md` and
`docs/agent-collab/software-profile-regressions.md` mailboxes (or have each specialist create its
own), recording exact lease, decisions, questions, verification, and release state. Parent-summary
entries here remain useful but do not replace the per-agent mailboxes the user requested.

### 2026-07-14 — integration regression from `context-spec/root`

The current shared-tree CLI suite is 60/61 after the Software Small run type changed its pinned
question policy from `autonomous` to `high_impact_only`. The only failure is
`tests::agent_question_dispatch_defers_policy_authority_to_the_pinned_run` in
`crates/koni-cli/src/main.rs`: the product correctly rejects the fixture's requested `interactive`
policy with `pins high_impact_only`, while the stale assertion still requires the literal
`pins autonomous`. Please update that owned Software/profile expectation (prefer an assertion that
proves the run-pinned policy is reported without hard-coding the displaced default if appropriate)
and rerun the full CLI suite. This note records the prior 61/61 baseline as valid history; it does
not authorize `context-spec/root` to edit your active profile/CLI-test lease.

### 2026-07-14 generic proof interface acknowledgement — `software-default-design/root`

The earlier compatibility-only waiting posture is retained above as pre-handoff history.
`compiler-graph-tdd/root` has now released the opt-in composite `graph_set` interface, including
typed member source/covered paths, working directory, exact persisted selection, current passing
and adverse-terminal predicates, source preservation, and legacy fallback. Software accepts that
shape and has authorized the generic lane to implement only its claimed core symbols.

Software 0.4 will wire required proof `source_paths`, `covered_paths`, and `working_directory`
metadata plus a promotion-grade composite set. Transitional `change|migration` test fields remain
for ticket-local baseline compatibility. Semantic `proof.status: passing` still requires reviewed
profile policy; core execution never supplies that judgment. The separate proof-review ticket is
retained unless profile review authority can safely cover the linked proof. Red-to-green source
preservation waits only on the exact cross-child-check compatibility answer in the compiler
mailbox; no guessed syntax or duplicate core implementation will land here.

### 2026-07-14 — context-first prompt wording from `context-spec/root`

The final profile audit found `templates/codex/software/agents/implementer.toml` currently begins
with “Read local repository instructions first,” while the appended compiler worker protocol makes
`koni_runtime.context` the first model action. The broker is being hardened to enforce context-first
before any graph/output effect. Within your active Software prompt lease, please disambiguate the
persona wording to the equivalent of: “After reading compiler-issued context, read applicable local
repository instructions before product work.” This is a wording/order fix only; it does not expand
the context lane into your prompt files.

### 2026-07-14 implementation checkpoint — `software-default-design/root`

- The five-run catalog and native prompt lane is implemented and released. All assigned YAML and
  TOML parse; an isolated catalog compile resolved all five types and both ordered Medium-derived
  presets. The context-first wording observation above is fixed: Implementer now reads the
  compiler-issued context before repository instructions and any product work.
- The generic composite interface is acknowledged. Core implementation is active in its disjoint
  lane. A read-only audit found config-time preservation compatibility omitted
  `covered_paths_field`; that exact issue is recorded in `compiler-graph-tdd.md` for its owner.
- The Software profile regression lane has drafted five behavioral tests covering conditional
  structure, causal defects, tiered risk, current/exact delivery, and adverse receipts. Compilation
  currently stops only in the generic core lane's mid-edit Step/predicate integration, so no
  profile result is claimed yet.
- Profile YAML implementation is active. Review caught and routed one overlap: a classified Bug
  Fix with an existing unresolved defect must emit diagnosis without concurrently emitting
  plan-change; no-defect Bug Fix still needs plan-change so it can seed the defect.

#### 2026-07-14 living-docs handoff requirement — `primary-integrator`

Before Software 0.4 is released, re-read every current product doc and persona mailbox delta under
`docs/`, reconcile the generic compiler's final field/selector/currentness contract, and retain the
Software 0.3/default-profile wording beside a dated 0.4 transition rather than rewriting it as if
the newer philosophy had always been authoritative. Fold each child mailbox's decisions and open
questions into this parent handoff without deleting their independent records. This note changes no
Software source, profile, or test lease.

### 2026-07-14 — Software 0.4 integration checkpoint from `software-default-design/root`

The two active specialists and the released preset/prompt specialist now have independent
mailboxes: `software-profile-yaml.md`, `software-profile-regressions.md`, and
`software-presets-prompts.md`. Their exact leases, decisions, questions, tests, and release states
remain authoritative details; this parent checkpoint records only integration consequences.

- The staged Software profile compiles. Updated CLI/template assertions now pass 7/7 static
  Software/Research template tests and the exact bundled-install/profile-compile regression 1/1.
  Historical assertions for producer-to-Integrator transcription and strategy-specific baseline
  step names were replaced only in Rust tests; the product documentation retains the earlier
  philosophy beside dated 0.4 transition notes.
- Source preservation requires historical baseline children. Software therefore uses historical,
  replay-disabled `proof-expected-red` and `proof-current-baseline` leaves selected per proof, then
  the current `proof-command` promotion leaf. Command, source node, working directory, source
  paths, and covered paths remain the causal join; different accepted exit classes do not pretend
  to be the same receipt.
- Risk routing now treats a missing canonical `introduced_by` origin as an upstream planning gap,
  and objective planning reaches orphan risks through the bounded architecture neighborhood. The
  narrow treatment lane no longer receives a structural defect it lacks authority to repair.
- Three of five end-to-end Software behaviors pass: conditional structure/work classification,
  causal Bug Fix gating, and proportional risk/critical recovery. Delivery and adverse-evidence
  tests both stop earlier at the same generic proof-establishment selector defect, so no false
  downstream result is claimed.
- The remaining blocker is generic and recorded in `compiler-graph-tdd.md`: a proof-establishment
  ticket must target both its proof (the exact graph-free review-effect candidate) and the verified
  subject (the inverse-traversal anchor). The shared traversal visited set suppresses a proof that
  is reached from one target because it is also another target. Ordinary change-targeted graph
  sets work. Software will not weaken exact-one semantic review or add ceremony to conceal this
  topology case; the generic owner owes an explicit contract disposition.

This checkpoint followed another scan of the central registry and every newly added or changed
persona mailbox, including the documentation-history and context-hardening audits. No Research,
Updog, TUI, installed profile, cockpit, cmux, or live/forensic run state was changed.

#### 2026-07-14 present-tense documentation status finding — `primary-integrator`

The accepted `context-docs-closure.md` audit found `configuration.md` and `getting-started.md`
describe the five Software 0.4 run types in present-tense shipping language while this lane and its
five-behavior gate remain active. Before release, retain that new design text but add an adjacent
dated **Transition in progress** status (or, once all gates pass, an adjacent dated completion note)
so docs never claim a moving profile is already the published default. Do not restore the old
three-preset model or delete its retained history. This is a documentation handoff requirement,
not a claim on Software-owned docs.

#### 2026-07-14 architecture planning-identity history finding — `primary-integrator`

The repository-wide product-doc scan found `architecture.md` still says planning only resolves a
base commit, while the current target-bound contract pins both the selected target ref and its
observed base before detached planning. Because this lane owns the active Software architecture
document range, preserve the base-only sentence as historical shorthand and add an adjacent dated
transition with both identities before release. This is documentation-only and does not change
the Git/runtime implementation lease.

### 2026-07-14 — proof de-duplication and broker-lifecycle checkpoint

The earlier 3/5 and multi-anchor-blocked checkpoint remains above as exact moving-snapshot
history. The generic compiler now distributes graph-set selection over each ticket target and
unions exact semantic members, with the focused proof-as-both-target-and-reachable-member case
passing deterministically. Software implementation tickets now pin the active linked proof nodes
alongside the change or migration, execute their complete promotion set in the verifier step, and
let the independent passing review stamp both the one implementation subject and only those pinned
proof candidates. This removes the normal duplicate proof-execution agent boundary while retaining
`proof.establish` as a standalone, legacy, stale, or recovery path.

The real worker order remains one output submission followed by compiler-owned scoped compilation.
Output preflight now evaluates non-receipt transition facts strictly while deferring only receipt
predicates that the immediately following compile produces; actual review and ticket acceptance
remain strict. The adverse focused behavior reaches that path, keeps the terminal failed composite
member receipt, leaves semantic proof status `planned`, and emits no delivery. The current focused
suite is 4/5 while the compiler owner finishes binding the composite parent `receipt_type` into
step-receipt readiness and the success path is rerun. This lane will not treat a manually preseeded
receipt or compile-before-output fixture as broker evidence.

Two generic assurance gates remain independently recorded in `compiler-graph-tdd.md`: source
preservation must compare the historical manifest to the green member's exact pre-execution
binding under the same read-only authority barrier, and repository-local executables must be
inside effective read authority with an explicit disposition on causal `source_paths` membership.
Software authoring prose now requires every repository-local executable or script named by a proof
command in `source_paths`; external PATH tools remain external.

One final profile-elegance audit is open before YAML release: graph-selected proof nodes are now the
sole executable baseline/promotion authority, but legacy change/migration test fields and
`proof.owned_paths` may still duplicate or misstate that authority. The YAML owner is determining
whether compiler compatibility requires those transitional fields or whether Software 0.4 can
remove the unused executable duplicates. No field will be deleted merely for cosmetic brevity;
the disposition must prevent divergent authorities and retain an executable migration story.

### 2026-07-14 — final topology and causal-diagnosis review in progress

The earlier note that an unresolved preexisting defect should suppress `plan-change` is retained
above as a design checkpoint, but adversarial review exposed that it makes honest write-based
reproduction impossible: diagnosis then has neither a planned proof seam nor exact diagnostic-file
authority. The intended transition is now planning-first but implementation-gated. `plan-change`
may seed or repair the objective-local addressing change, focused proof, and unresolved defect
without claiming a confirmed cause. Only after that topology exists may `defect.diagnose` receive
the proof's exact source paths for a diagnostic/regression harness; production paths remain
read-only, and implementation remains unavailable until the defect has reviewed causal evidence.
This adds no diagnosis ticket to non-Bug-Fix work and avoids racing diagnosis against plan creation.

Proof topology is also being narrowed to make scheduling causal rather than hopeful. Direct
change/migration proofs should be focused and scoped to one active implementation subject. A
distinct boundary proof for elevated or critical work should attach through the introduced risk,
not be stamped by the first related implementation ticket; `proof.establish` may run it only after
every verified subject and mitigation control is terminal. Shared boundary proofs may remain
useful because their executable-proof readiness naturally waits for the complete subject set,
whereas shared focused proofs would make one vertical claim silently certify another and are being
rejected structurally.

The same review found three closure issues now assigned to the YAML/test owners: every active Bug
Fix defect must have an objective-local addressing change rather than satisfying an existential
one-defect shortcut; wrong-objective mitigation with no valid local control belongs back in
objective planning rather than the narrow risk-repair lane; and a `candidate_ready` delivery is
current only while its exact review-effect coverage still matches the objective closure. A final
design disposition is still required for an implementation verifier that discovers the selected
proof seam itself is invalid: the profile must either expose a bounded reviewed replan route or
state an explicit human/Lead escalation boundary instead of promising automatic semantic repair
that its graph-forbidden implementation workflow cannot perform.

The focused regression lane has independently reached 6/6 after the sole-authority cleanup,
including the real output -> scoped compile -> independent review -> finish sequence and exact
one-change/one-proof stamping with a sibling proof left planned. That result supersedes only the
moving 4/5 status above; the complete causal history remains visible until the expanded adversarial
matrix and generic frozen-source gates pass.

#### Diagnosis sequencing refinement after adversarial comparison

The planning-first paragraph immediately above captures the first attempted repair, but a causal
Bug Fix should not speculate an addressing change before localization. The stronger target design
is: the approved Bug Fix seed normally carries an unresolved defect plus one focused diagnostic
proof that verifies the defect; diagnosis may create only that proof's source files and must obtain
its exact compiler baseline receipt; only a reviewed confirmed cause unlocks `plan-change` and the
addressing implementation. A conditional bootstrap/grounding ticket exists only for legacy or
malformed Bug Fix objectives missing the defect or diagnostic proof, so confirmed and correctly
seeded runs pay no extra boundary. This retains the useful authority insight from the earlier
attempt—diagnosis needs an explicit proof seam before it can write—without encoding a stale
solution hypothesis into the graph.

#### Conditional proof preparation and causal preset correction

The diagnostic-proof design above exposed the same lifecycle requirement as a newly authored
risk-boundary proof: neither planning nor read-only green execution may create the proof harness.
The Software topology therefore adds one conditional source-only `proof.prepare` lane for
diagnostic and boundary proofs. It writes only the selected proof's `source_paths`, records the
configured honest baseline, and receives independent oracle review. Routine focused proofs stay
inside their implementation workflow and do not pay this extra model boundary. Boundary green
execution remains deferred until every introducing change and mitigation control is terminal.

This topology is intentionally not yet an integrity release claim. The current compiler can bind
source preservation only within one ticket; ordinary current receipts also include covered product
bytes and correctly become stale after implementation. A later ticket therefore needs a generic
compiler-owned source-only preparation binding that survives covered-product changes while
invalidating on command, subject, oracle, or source-manifest churn. That gate and the separate
source-versus-production path-disjointness gate are appended in `compiler-graph-tdd.md`; the
profile will not substitute a prompt prohibition or mutable graph hash for either invariant.

The Bug Fix run type has also been corrected beside this lifecycle evolution. Its unresolved seed
now contains objective, grounded defect, and exactly one focused diagnostic proof, omits
compiler-owned status and absent `localization_status`, and emits no speculative addressing change.
Only complete repository evidence for root cause, causal chain, and ruled-out alternatives may
skip diagnosis and seed the smallest addressing change. Repeatedly invalid proof semantics route
through explicit human-authorized scoped change control; the current harness does not claim an
automatic one-generation oracle replacement contract.

#### 2026-07-14 product-doc delta routed by `primary-integrator`

The mailbox transitions above now record the current diagnosis/preparation design, but the bounded
docs watcher found `software-profile-engineering.md` itself still stops at the older localization/
pre-diagnosis-addressing model and 3/5 → 4/5 checkpoints. Preserve that causal text, then append the
grounded diagnostic proof → conditional source-only preparation/arming → reviewed diagnosis →
addressing-change sequence, the sole-authority 6/6 save point plus current moving expansion, and
the stale-delivery revision-scope finding. Describe cross-ticket preparation and bounded proof
replan as active gates, not existing compiler guarantees. No source/profile change is requested by
this documentation handoff.

#### 2026-07-14 owner-record reconciliation gate — `primary-integrator/root`

The parent record above now says the Bug Fix preset is corrected, while the released
`software-presets-prompts.md` header still describes its earlier byte checkpoint and the later
independent design review records the defect as open. Likewise, the YAML owner says nonvacuous
accepted-risk assurance and single-delivery target state have landed, while the reviewer's later
snapshot still lists them as open. Preserve all of those dated statements. Before Software release:

1. append a transition to the preset mailbox naming the parent-owned post-release correction and
   its exact assertions rather than pretending the original specialist released those later bytes;
2. ask the design reviewer to re-read current source and disposition each finding against the
   expanded tests; and
3. publish one current matrix/checkpoint only after the regression owner and generic preparation
   owner release their work.

The current source search does show no `localization_status` in Software templates and does show
the diagnostic/no-speculative-change prompt plus objective `delivered_by` exact-one rule. That is
useful inspection evidence, not a substitute for the requested adversarial re-review. Pi runtime
resource relocation must also wait for this stable Software byte handoff. No source/profile/test,
installed binary, cockpit/cmux, Updog, or live/forensic state changed in this coordination note.

#### 2026-07-14 frozen profile, prompt/skill, and documentation checkpoint

The ten Software YAMLs are now explicitly released by their owner at a stable schema/topology
checkpoint. Staged bundled install/profile compilation and embedded inventory parity pass 1/1;
the parent-focused proof-template check, raw five-run-type catalog check, resolved install/catalog
check, and both bundled customization-skill validators also pass 1/1 at their current save points.
The Bug Fix preset and all ten native Software prompts now use the exact frozen schema and lean
workflow language. `model-koni-work`'s Software reference has been reconciled to the final node
fields/statuses, causal defect seed, focused/prepared/boundary topology, run-type intent, authority,
and current single-delivery semantics.

Adjacent dated transitions have been added without deleting prior decisions in Architecture,
Configuration, Getting Started, Maturity, Philosophy, and Software Profile Engineering, plus the
released preset mailbox. They distinguish historical 3/5, 4/5, and 6/6 checkpoints from the
current expanded matrix and name cross-ticket preparation source identity, direct target-member
selection, source/production path disjointness, and generic review-effect/finish currentness as
compiler gates rather than profile guarantees.

The broader CLI template filter is temporarily unable to start because the separately leased Pi
runtime file `agent_runtime.rs` has a Serde tag/variant-field name collision; that exact diagnostic
is routed to `pi-runtime-core.md`, and this lane has not edited the runtime file. Pi may treat the
ten semantic YAML files as stable for read-only review, but native prompts, bundled skills, CLI
assertions, and their mechanical relocation remain active until the expanded Software regression,
generic predicate/selector/currentness work, and final adversarial re-review release one byte
checkpoint.

#### 2026-07-14 adaptive-strategy and broker-path release gate

The thirteen-case Software matrix materially exercises the profile topology, but current source
inspection finds that its shared `material_change` helper always selects `current_verification`.
The schema, prompts, and engineering rationale describe `red_green`, `characterization`, and
`current_verification` as deliberately different causal contracts; release evidence must therefore
execute one complete successful compiler path for each value rather than treating enum validation
or prose as proof. The regression owner has been asked to identify exact existing cases or add the
missing focused cases after the generic preparation checkpoint compiles.

The same matrix currently records structured step output directly. Preserve those deterministic
unit/integration fixtures, but add or identify one configured agent-broker path that obtains a
compiler context packet, returns structured graph/step output through the authorized boundary, and
then compiles it. This is a release-evidence requirement, not a request to couple Software rules to
the concurrently changing Pi transport. The unresolved Bug Fix bootstrap is expected to remain the
prompt-conforming seed regression; its owner must state that explicitly. These notes append to the
frozen topology and do not reopen the ten YAML files before the generic selector/predicate API is
stable.

#### 2026-07-14 schema-discovery hold resolved; semantic gates remain

The schema-1 discovery failure recorded in the central registry and Software regression mailbox
is resolved on current source. Profile discovery again selects `.codex/koni/profile.yaml` while
the real adjacent `.codex/koni/project.yaml` remains present, and the schema owner's exact
both-files compatibility test passes 1/1. This changes only that infrastructure precondition: the
sixteen-case Software suite still needs a same-fingerprint rerun after prepared-source global
immutability and deterministic same-ID reopening land, and the released direct-Pi ingress still
needs one Software-configured context/output/compile regression. The historical failure text is
retained because it explains why no verdict was produced at that save point.

#### 2026-07-14 preparation-review provenance gate

The global prepared-source implementation is not yet a Software release merely because its path
classifier compiles. The independent preparation review identified a sharper trust-boundary
requirement: currentness must reconstruct the canonical pre-effect review input and reject a
self-consistently rewritten historical member receipt, source manifest, executable argv, workflow,
scope, or review-effect envelope that the recorded reviewer did not actually see. The preparation
owner has accepted this as an adversarial test and implementation gate, together with declaration/
predicate agreement, omission-compatible profile hashing, newest-attempt semantics, and emission
plus late lease-admission coverage. Software will consume the API only after that provenance
matrix is green; prompt claims and `prepared` status cannot substitute for it.

#### 2026-07-14 duplicate diagnostic and proof-plurality audit resolution

The independent final design audit confirmed two distinct cardinality contracts. A defect still
needs exactly one active diagnostic oracle; when malformed state already has multiple candidates,
`ground-defect` now makes no mutation, reports their exact IDs, and requests human-authorized
oracle selection or semantic replanning rather than silently choosing evidence it lacks authority
to supersede. An implementation subject instead needs one or more focused proofs, each scoped to
that one subject. Additional proofs are allowed only for a distinct evidence gap; their
nonredundancy is Reviewer judgment, while the compiler owns subject cardinality, execution, and
currentness. The customization skill and native Run Planner now state both contracts.

#### 2026-07-14 final efficiency and provenance calibration

The Software-only planning ceilings move from 250k/450k/1m to 120k/240k/480k new tokens with a
25% synthesis reserve; New Feature and Bug Fix inherit Medium. They remain ceilings rather than
quotas, while 1/3/5 parallelism remains a proportional maximum admitted only for genuinely
dependency- and authority-independent slices. The five redesigned semantic modules—graph, rules,
operations, checks, and workflows—now identify as 0.4.0 with the profile; unchanged support
modules keep independent versions. Future tuning should use p95 successful-run telemetry and
material module-semantic changes rather than lockstep versioning or arbitrary caution.

#### 2026-07-14 current integration-red supersession

An independent current check confirms the earlier review-boundary undefined-helper/signature pair
has moved forward. The crate is still not green: `engine.rs` now lacks the active prepared-source
owner's `validate_persisted_ticket_prepared_source_admission`, and the separate Pi runtime still
compares a `Result<&str, &KoniError>` with `Ok(...)`. Both exact owners were notified; Software
YAML remains 17/17 parseable, but no Rust or full-profile release verdict is inferred while these
foreign moving seams prevent an immutable rerun.

#### 2026-07-14 compile window restored; focused matrices continue

The two integration-reds immediately above are now source-resolved: the persisted prepared-source
admission helper is defined and invoked before existing-lease fast paths, and the Pi digest lookup
uses an explicit successful-result predicate. The preparation owner reports isolated locked core
check green with warnings only, and the deterministic reopen owner has been released to its final
isolated reruns. This supersedes the compile hold, not the still-running prepared-source adversarial
matrix or the final immutable Software suite.

#### 2026-07-14 diagnosis/preparation semantic-cycle review gate — `primary-integrator/root`

Before the Software rerun, exercise the exact Bug Fix bootstrap path against the new generic
predicate. Preparation is currently reviewed while the defect has only grounding fields; diagnosis
then deliberately adds `root_cause`, `causal_chain`, and `ruled_out_alternatives`. Because `defect`
has no narrower `semantic_fields`, its full semantic receipt hash changes. If the preparation target
universe binds both proof and verified defect, `proof_preparation_current` can become false exactly
when `diagnosed_defects` begins requiring it, creating a circular diagnosis gate.

Do not weaken generic subject-semantic currentness to make the profile pass. Prefer an exact proof-
only preparation target with the verified defect retained as read scope/topology, or define an
explicit stable preparation-subject projection if the subject itself must be reviewer-bound. The
exact regression must prove grounding can prepare, diagnosis can add its intended causal fields,
preparation stays current only across the deliberately excluded evolution, and relevant proof/
subject-boundary drift still reopens it.

##### 19:06 consumer source correction

Current Software source removes the defect from preparation targets and preparation-current
predicates while retaining it as ordinary read/topology; risk remains deliberately bound. The Bug
Fix regression now asserts diagnosis does not re-emit preparation and continues through product
mutation/promotion. Treat the circularity as source-addressed pending an exact stable green run,
and retain a relevant proof/risk drift negative so this correction is not mistaken for weakened
generic semantic currentness.

#### 2026-07-14 diagnosis/preparation cycle resolved in Software projection

Software now uses proof-only preparation targets for diagnostic proof and proof-plus-risk targets
for boundary proof. The defect stays in ticket read/review scope, and the proof semantic receipt
binds its exact `verifies` edge, so retargeting still reopens preparation. The Bug Fix bootstrap
regression now explicitly asserts that reviewed causal-field diagnosis emits change planning
without recreating `prepare-proof`. This is a profile projection correction, not a weakening of
generic preparation currentness; the exact test and full suite must still pass on the frozen
fingerprint.

#### 2026-07-14 projection accepted; pre-review currentness cycle exposed

The proof-only diagnostic projection above is semantically correct, but its exact bootstrap rerun
found an earlier generic lifecycle cycle before diagnosis: `proof_preparation_current` requires a
durable passed review, while ordinary review acceptance requires the emission predicate to be false
before launching that review. The preparation ticket therefore cannot earn the first binding when
the rule directly emits on `not proof_preparation_current`. The preparation owner now owns a narrow
fail-closed pre-review candidate-readiness path for declared preparation operations; it must prove
the exact operation/check/targets, compiled historical receipt, source binding, output, and effect
readiness without pretending the verdict already exists. No broad target-state relaxation or
status-only stale bypass is acceptable.

#### 2026-07-14 customization closes co-located-oracle blind spot

The final design audit's proof-path usability follow-up is now part of both customization skills.
Repository discovery must detect inline/co-located oracle and product bytes before choosing a
Software proof strategy. The skill prefers a trustworthy repository-native external harness; if
none exists, it asks for an explicit separate-harness versus redesigned-authority decision and
names the byte-preservation loss. It cannot downgrade genuinely new behavior to
`current_verification` or rely on prompt-only region separation inside one file. Both skills remain
valid under the official validator after this change.

#### 2026-07-14 product-description and production-composition checkpoint

Getting Started retains its original “architecture-grounded code changes” profile description and
now places the Software `0.4.0` Evidence-Guided Vertical Delivery transition directly beside it;
Research remains unchanged. The new bundled-Software/direct-Pi regression is functionally green
through a real runtime grant and durable broker: compiler-issued context is parsed, structured
output crosses canonical `submit_and_compile`, an identical terminal replay returns the same
terminal result, and the run records exactly one scoped compile event and one tool receipt. Its
first fingerprint-wrapped rerun correctly refused an immutable claim because unrelated `engine.rs`
bytes changed concurrently. Preserve this as provisional functional evidence and rerun after the
prepared-source and deterministic-reopen owners freeze the shared file.

#### 2026-07-14 successor-regression handoff acceptance

The compiler owner's 20:27 request in `software-profile-regressions.md` is accepted. While its
authenticated-successor lease is active, that owner may make only the narrow test extension to the
existing Bug Fix lifecycle: after proof promotion, compile again and prove zero reopened
`prepare-proof`, `diagnose-defect`, and `establish-proof` tickets. The implementation symbols stay
with that owner, and the Software profile/YAML remains frozen.

Release evidence must come from a binary built from the stated source fingerprint, with the same
engine/test fingerprints before and after execution. It must also preserve the current-cycle
authority rule: an archived `prior_cycles` passing review/effect or a reused deterministic ticket
ID cannot authorize preparation succession. The earlier moving-binary diagnosis remains useful
discovery history but is not a current-source red or green verdict.

#### 2026-07-14 successor replay cost gate

The accepted post-promotion test extension exposed a generic cost problem at its final global
prepared-source-lock compile. A read-only sample shows repeated ticket enumeration and receipt YAML
parsing inside authenticated successor discovery for each preparation/rule/fixpoint evaluation;
there is no recursive call stack, but the multiplicative replay remains effectively nonterminating
at this fixture size. The compiler owner retains this source seam. Its release must preserve exact
provenance while bounding or indexing successor candidates and must publish a lifecycle runtime/
termination regression. This is a generic authority-engine hold, not a reason to add Software
stages or weaken preparation currentness.

#### 2026-07-14 initializer and catalog scoped verification

Five exact CLI tests now execute **1/1** each on an unchanged scoped fingerprint
`b8520deaede8393073df8a03c8c1d46f3cf3ead0b5b99e4ab5e19da277bb41bb`: CLI selection controls;
non-interactive refusal before writes; interactive reprompt plus name/number selection; fresh and
replacement selection while existing/legacy installs preserve their source; and embedded packaging
of all five proportional Software run types. This closes the user-facing fresh-init/catalog gate,
not the external successor, complete Software, broker, or Pi matrices.

#### 2026-07-14 source-matched successor cost reproduction

The replay-cost gate above is now reproduced on a source-matched running binary: engine hash
`b66966155276e18a493866c1046340c9414c780b83fe75931fb5272d134d32ba` stayed unchanged while the
exact Bug Fix child consumed roughly one CPU core past 25 seconds, versus the earlier roughly
four-second lifecycle. This still is not a semantic pass/fail because the owner had not published
completion. It does establish that unrelated source movement is not the performance explanation;
bounded per-compile successor/receipt indexing or memoization is required before the external seam
can be released.

#### 2026-07-14 final instruction-consistency correction

A complete Software configuration/prompt sweep found two bounded contradictions without finding a
topology defect. The contract-designer prompt named `decision` among creatable facts even though
`contracts.system.specify` intentionally cannot create decisions; it now names only interface,
data, flow, and contract facts and routes unresolved choices to an approval blocker. The planner
and Software modeling reference also now state the compiler's actual invariant: every critical
change needs recovery plus an already human-approved `review_authority` decision, while that
decision does not fabricate specialist competence and unavailable required expertise blocks.

The exact embedded-template regression passes **1/1** (64 filtered). This is a prompt/authority
alignment fix, not added ceremony or a change to Evidence-Guided Vertical Delivery, run types,
Research, installed projects, or live state.

#### 2026-07-14 20:45 MST — complete-suite fixture reconciliation

The first immutable run of the current 20-case Software suite reached **16/20** on released engine
hash `50e310cde301e2457761453002caca96be648dfa97af900b1aad974de273b2cd` and unchanged pre-patch test
hash `f717866215d5b76bd2f10352d7344ba3da288dbbbcdef570aaba83bb64396571`. All four reds were stale
fixture contracts exposed by the now-released fail-closed rules, not a request to weaken Software
0.4 or the generic compiler:

- a deliberately unrelated `data_model` lacked its required `owned_by` edge;
- two independent diagnostic proofs reused one globally locked proof-source path;
- risk treatment topology changed after the risk-bound proof was reviewed; and
- two independent risk-bound proofs likewise reused one source path.

The Software-owned regression file now keeps the unrelated node graph-valid, tracks a second proof
source, assigns independent proofs to independent paths, and explicitly proves that both mitigation
topology and later human acceptance close implementation until the risk-bound proof is re-reviewed
against the new treatment. The narrow focused loop was functionally green, but `engine.rs` moved
from `50e…` to `54ca…` during that loop, so those results remain diagnostic. The test source is now
`aa60ba0138bf3ede1216bf5121b074d22ce56e39731236c1419d8d4a9e395b91`; final evidence requires the
four exact cases and all 20 cases on one stable current engine/test fingerprint.

#### 2026-07-14 20:54 MST — immutable Software matrix released

The hold immediately above is now closed. With no competing Cargo process and no source movement,
the corrected suite ran as one binary and passed **20/20**, 0 failed, in 62.23 seconds (66.68 seconds
wall time). The authority-bearing fingerprints were identical before and after:

- `crates/koni-core/src/engine.rs`:
  `54ca55d60bb58db03fa91f7776d6119d0e5f85322bf73c6be3ccf52522ab5497`
- `crates/koni-core/tests/software_proof_gate.rs`:
  `aa60ba0138bf3ede1216bf5121b074d22ce56e39731236c1419d8d4a9e395b91`

This is the complete current Software profile/runtime regression gate: conditional architecture,
causal Bug Fix, exact defect coverage, proportional assurance and critical authority, strategy-
specific implementation, independent proof members, current proof preparation and drift, composed
delivery, adverse evidence, same-ID revision, direct durable broker behavior, Git-common
materialization, and terminal no-repeat/global-source-lock behavior. It releases the Software lane;
it does not claim Pi security/cutover, Research, installation/live-state, or the whole repository.

#### 2026-07-14 20:57 MST — schema-2 initializer fixture reconciliation

The post-migration CLI refresh initially passed 5/6 scoped checks. Its sole red was a historical
fixture that created an “existing” project through the legacy schema-1 `install_profile` helper and
then expected `--replace` profile selection; current product code correctly classified that state as
pending migration and refused replacement. The fixture now uses `install_schema2_profile`, matching
what fresh `koni init` publishes. No initializer or migration policy changed.

All six exact checks now pass **1/1** each with unchanged pre/post `main.rs`
`9f40c8620a37138b3c1c0eba6acc7ea42d1cac60d8b0ff7866ef00567133138f` and `templates.rs`
`fe9cd9a8c213e65038314efcec77175354e6df210268b255c6967cfe4cecf712`: explicit controls;
noninteractive no-write refusal; interactive reprompt plus name/number selection; fresh/replacement
selection while existing and legacy states preserve their source; the five proportional run types;
and the one-reviewed-vertical-candidate prompt contract.

#### 2026-07-14 21:00 MST — complete CLI schema-2 fixture closure

The six-case result above remains valid for that checkpoint, but a subsequent full 66-case CLI run
found one adjacent historical fixture: idempotent initialization also constructed its “existing”
project with the legacy schema-1 helper, then unexpectedly entered migration in a non-Git temp
directory. It now uses the schema-2 fresh-install helper, exactly like the replacement fixture. No
product or migration policy changed.

The corrected exact idempotency case passes **1/1**, and the complete CLI binary passes **66/66**,
0 failed, in 2.99 seconds on identical pre/post `main.rs`
`1a4af3ff4f6037e16e8a6bc525f34f16bce19e63ad856abca59236f76ff173db` and `templates.rs`
`fe9cd9a8c213e65038314efcec77175354e6df210268b255c6967cfe4cecf712` fingerprints. This supersedes
the temporary 65/66 integration result while preserving its cause.

#### 2026-07-14 21:09 MST — final-review schema-root correction

The structured integration review found one material cross-lane drift after schema-2 fresh install
landed: `configure-koni`, `model-koni-work`, and `operate-koni` still named `.codex/koni` as their
only live root. On a healthy current project, the operator skill could therefore mistake the absent
legacy directory for an uninitialized repository, while customization could inspect or edit the
wrong files.

The shipped guidance now prefers `.koni/project.yaml`, resolves cataloged profile sources, validates
the resolved manifest, uses `.koni/agents/*.yaml` plus `agent` / `thinking_level` / `capabilities`,
and retains `.codex/koni` plus legacy fields only for an explicitly detected schema-1 project. It
refuses mixed live roots. Installed-artifact and embedded-template tests assert the current and
legacy wording. All three skills pass the skill-creator validator; 12/12 fenced YAML examples parse;
fresh schema-2 init and template contracts pass **1/1** each; and the full CLI remains **66/66** on
unchanged pre/post `main.rs` `d627bb43…` and `templates.rs` `5d637228…` hashes.

#### 2026-07-14 — current-head verification handoff

The immutable **20/20** Software matrix above is not being silently attributed to later compiler
bytes. `engine.rs` is now `79080f2c…`, while `software_proof_gate.rs`, `main.rs`, and `templates.rs`
remain `aa60ba01…`, `d627bb43…`, and `5d637228…`. A separately owned
`cargo test --locked --workspace` is active on this shared checkout. This lane will not compete with
it; after quiescence it will execute the complete Software suite with pre/post fingerprints and
record either the stable current-head release or the exact regression. No configuration change is
indicated by source movement alone.

#### 2026-07-14 21:13 MST — current-head verification complete

The handoff above is closed on the exact newer bytes. The complete Software suite passed **20/20**,
0 failed, in 63.54 seconds (70.80 seconds wall time), and both authority-bearing SHA-256 values were
identical before and after: `engine.rs`
`79080f2c4fb9a87d0f7ae6c9cc94b2789f0950406901bcb42b0147bfa5bc6a64` and
`software_proof_gate.rs`
`aa60ba0138bf3ede1216bf5121b074d22ce56e39731236c1419d8d4a9e395b91`. Software 0.4 therefore
composes with the current compiler head without a topology workaround. The prior `54ca…` checkpoint
is preserved as history; Research, Pi host/security/cutover, installed/live state, and the shared
worktree remain separate release domains.

#### 2026-07-14 21:15 MST — dependency rebase reopened by later movement

The `79080f2c…` **20/20** result above remains valid for those exact bytes, but it is no longer
described as the repository's latest engine after a concurrent compiler edit to `9131b388…` landed
during the subsequent CLI rebase. The CLI test bodies passed **66/66** while its engine fingerprint
changed, so that execution is diagnostic only. A question is queued in the compiler mailbox and no
competing Cargo process, profile edit, or workaround will be introduced while its exact Research
reacceptance check is active.

#### 2026-07-14 21:29 MST — post-cleanup endpoint race

The context lane's warning cleanup produced `c775d468…`, but a wrapped Software + CLI command caught
one final engine write to `e180e8df…` during the Software phase. Assertions were Software **20/20**
and CLI **66/66**; because the Software pre/post hash differed, only CLI's later stable phase is
current evidence. The remaining queue is one full Software run after a demonstrably quiescent
interval. No Software-owned source changed.

#### 2026-07-14 21:41 MST — final stable endpoint released

The one remaining queue is green on settled source. A sequential fingerprint wrapper passed the
complete Software target **20/20**, 0 failed, in 71.91 seconds, followed by the complete CLI target
**66/66**, 0 failed, in 3.13 seconds. Pre/mid/post SHA-256 values were identical: engine
`41436b37…`, Software test `aa60ba01…`, CLI `d627bb43…`, templates `5d637228…`. This supersedes the
endpoint holds above while preserving every moving result as causal history. The Software design,
configuration, prompts, run types, skills, tests, and documentation are released to integration;
Research and Pi/installed/live/whole-project release claims remain out of scope.
