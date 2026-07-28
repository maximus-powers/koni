# Software Profile Engineering

Status: accepted design for the bundled Software profile. This document applies only to Software.
The manually designed Research profile is intentionally out of scope.

## Historical baseline and evolution record

The shipped Software `0.3.0` baseline is intentionally **Architecture-Grounded Software Delivery**.
It requires every objective to include system, contract, and flow mappings. It sends each system
without an `owns` edge through contract design. It separates Mapper and Designer output from graph
mutation through Integrator steps. It supports the Small, Medium, and Large run types. It marks a
reviewed delivery `pr_ready` before target synchronization and composed verification. Those choices
established typed architecture, adaptive proof, independent review, canonical receipts, and exact
promotion as the original trustworthy foundation.

**Evolving to: 2026-07-14:** Software `0.4.0` changes the default philosophy to **Evidence-Guided
Vertical Delivery**. Preserved live-run evidence showed that the original routine path spent at
least eleven model boundaries after planning, and fallback mapping/design could raise that to
roughly nineteen or more even for one bounded change. The new baseline keeps the original proof and
promotion guarantees while making architecture conditional, allowing one bounded specialist to
author a reviewed graph delta directly, compiling explicit risk treatment, and adding New Feature
and Bug Fix intent presets. Existing pinned run snapshots retain the exact profile they approved.
This evolution governs only newly planned runs after the new profile is installed.

## Decision

The default Software profile follows **Evidence-Guided Vertical Delivery**.

A ticket represents one cohesive, reviewable claim about the software, not one file, persona,
document, graph node, or generic phase. The graph records the durable meaning of the work: the
outcome, affected boundaries, material contracts and decisions, vertical change slices, risks,
proof, and exact delivery. The compiler creates work only for meaningful unsatisfied obligations.

The default loop is:

1. Align on observable outcome, non-goals, and the few decisions that materially change the work.
2. Localize the relevant repository behavior, boundaries, test seams, and native commands.
3. Compile the smallest implementation-ready living specification.
4. Execute dependency-ordered vertical slices through an honest baseline and focused proof.
5. Review the actual candidate independently for correctness, regression, scope, and design.
6. Synchronize the target, re-run selected proof against the exact composed product tree, and only
   then promote that tree.

This is deliberately neither maximum ceremony nor unconstrained autonomy. It makes correctness cheap
for routine work and makes additional rigor conditional on uncertainty, blast radius, and failure
cost.

## Why agents need a different engineering system

Coding agents have useful advantages: they can inspect large repositories quickly, execute tools
repeatedly, create tests and implementation in one session, and parallelize genuinely independent
exploration. They also have predictable weaknesses:

- Context is lossy. Repeated handoffs reconstruct intent imperfectly and long transcripts crowd out
  the actual acceptance contract.
- Agents readily turn a requested process into ceremony. If every possible artifact is named, they
  tend to produce every artifact whether it changes a decision or not.
- A test can become a false oracle. An agent can encode the wrong requirement, weaken an assertion,
  or satisfy a narrow test while missing the observable outcome.
- Open-ended retries compound mistakes. Repeating the same localization, edit, or review strategy
  rarely becomes sound merely because it received more turns.
- Agents imitate local code, including weak local patterns. Repository grounding is necessary but
  does not replace explicit invariants and review.
- Parallel writes create more coordination cost than value unless scopes and interfaces are truly
  disjoint.
- Agents are unusually good at following deterministic, local, actionable feedback. Compiler-owned
  schemas, exact commands, receipts, path scopes, and remediation messages should carry mechanical
  correctness so model judgment can focus on semantics.

These properties favor a shallow semantic graph, progressive context disclosure, short feedback
loops, and a compiler that distinguishes routine work from material risk.

## Paradigms considered

| Paradigm                                | What it gets right                                                                      | Failure mode as a universal default                                                                          | Role in this profile                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Phase-gated architecture-first delivery | Makes dependencies, interfaces, contracts, and irreversible decisions visible           | Serial handoffs, speculative architecture, stale artifacts, and extreme overhead for local changes           | Escalation path for unresolved or cross-boundary architecture, not the default ticket topology   |
| Strict red-green-refactor TDD           | Fast executable feedback, regression protection, and pressure toward testable design    | Not every change has an honest red state. Agents can test the wrong behavior or perform test theater         | Preferred proof for new deterministic behavior and reproducible defects. One of three strategies |
| Architecture/DDD-led modeling           | Clarifies ownership, dependency direction, ubiquitous boundaries, and parallel seams    | Many repositories do not follow DDD. Unfamiliar agents can invent domains and unnecessary abstractions       | Model only affected repository-native systems and material interfaces                            |
| Contract-first/specification by example | Converts fuzzy intent into observable examples and compatibility obligations            | Over-specific examples can exclude valid implementations. Prose contracts can drift from executable behavior | Use observable contracts and bind them to proof, without prescribing internals                   |
| Small-batch vertical slices             | Keeps behavior, implementation, and proof coherent. Reduces integration and review cost | Poor slices can conceal shared-boundary changes or create unsafe parallelism                                 | Default unit of product work                                                                     |
| Risk-adaptive assurance                 | Spends expensive proof and review where failure matters most                            | Agents can under-classify risk. Low-risk is not the same as no-risk                                          | Universal baseline plus compiler/reviewer escalation triggers                                    |
| Standing multi-agent role pipeline      | Fresh critique, specialization, and parallel discovery                                  | Context loss, coordination failures, superficial verification, and token cost                                | Specialists appear only for bounded unresolved facts or qualified review domains                 |
| Localization → repair → validation      | Simple, interpretable, and cost-effective for a well-scoped defect                      | Too narrow for ambiguous features, migrations, or architectural change                                       | Backbone of the Bug Fix preset and routine corrective work                                       |

The synthesis takes the strongest part of each: vertical slices for cohesion, executable contracts
for feedback, architecture facts for boundaries, risk tiers for proportional assurance, and
independent review at a real trust boundary.

## Governing principles

### 1. Outcome before mechanism

Planning starts with the observable result, non-goals, compatibility expectations, and definition of
done. It does not begin by selecting files, abstractions, or personas. Missing product decisions are
questions. Repository-discoverable implementation facts are investigation work.

### 2. One ticket, one approval sentence

A normal change ticket should be explainable as one sentence a reviewer can approve and one evidence
packet can prove. Split work only when at least one of these differs:

- independently valuable or reviewable outcome.
- hard dependency that makes downstream work impossible or unsafe.
- evidence packet or proof environment.
- material risk tier or qualified reviewer.
- rollback/correction path.
- disjoint ownership needed for safe parallel work.

Ordering preference alone is not a blocking dependency. Tests, production code, and nearby
documentation normally stay in the same ticket.

### 3. Just-enough architecture

Every run identifies at least one affected system boundary. Interfaces, data models, flows, and
contracts materialize only when they affect compatibility, ownership, behavior, proof, or another
slice. A graph node is not automatically a ticket.

### 4. Proof before confidence

Every realized change has graph-bound proof and an exact repository-owned command or observable
method. The agent must state what the proof establishes and what it does not. Narrative confidence,
successful compilation, and a green unrelated suite are not completion evidence.

### 5. The cheapest trustworthy seam

Use the lowest layer that proves the requested behavior, then add a higher-level proof only for a
remaining wiring, compatibility, UI, runtime, deployment, or operational gap. Lowest does not mean
most mocked. It means fastest while still exercising the relevant failure boundary.

### 6. Rigor follows risk

All changes receive focused proof, independent semantic review, composed verification, and exact
promotion. Extra architecture facts, risks, proof layers, specialists, migrations, and rollback work
appear only when triggered by the change.

### 7. Compiler authority, local autonomy

The compiler owns schema, legal relations, path/write scope, receipt identity and freshness,
lifecycle effects, review binding, retry ceilings, composed verification, and promotion. Agents own
implementation choices within those constraints. The profile should enforce invariants, not
micromanage internal code structure.

### 8. Bounded correction changes strategy

One actionable correction is normal. A repeated same-class failure opens a blocker and preserves the
evidence. Recovery must add information or change localization, plan, proof seam, or authority. It
must not merely spend more turns on the same approach.

> **Worker-check refinement: 2026-07-15:** The principle above now begins before terminal
> submission. A worker with configured validation checks runs each exact compiler-owned check after
> its final edit and treats setup, environment, collection, and unrelated failures as invalid
> evidence rather than an honest red or green signal. An unexpected failure from the compiler's
> terminal rerun returns the newly written bounded/redacted receipt to that same model session for
> one informed correction path. The existing three-rejection circuit still ends repeated same-class
> correction. No model receives argv, cwd, environment, shell, or raw compiler-error authority.

### 9. Exact composed state is the release candidate

Ticket receipts prove ticket candidates. Promotion requires fresh selected checks against the exact
post-sync composed product tree. Reports and seals may advance compiler-owned state only when the
product projection remains identical.

## Semantic graph

The existing Software ontology remains intentionally rich, but its nodes become conditional. The
happy path is seeded from the approved plan so agents do not repeat planning as architecture,
contract, and change-design tickets.

| Node         | Materialize when                                                                                                                              | Never use it for                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `objective`  | Always. It stores the outcome, scope boundaries, success signals, work kind, and approved steering                                            | A task list or implementation recipe                              |
| `system`     | Always include at least one. Use the smallest affected repository-native ownership boundary                                                   | Speculative future services or generic layers with no owned paths |
| `interface`  | A producer/consumer, public API, event, CLI, UI, filesystem, or external integration boundary matters                                         | Every function call                                               |
| `data_model` | Persistence, schema, serialization, or durable state semantics change                                                                         | Incidental local structs                                          |
| `contract`   | Acceptance, compatibility, safety, or behavioral invariants constrain the change                                                              | Restating implementation steps                                    |
| `flow`       | An ordered user/system journey is needed to understand behavior or prove wiring                                                               | A generic workflow phase                                          |
| `defect`     | A Bug Fix needs durable expected/actual behavior, reproduction, causal chain, and root-cause evidence                                         | A generic issue tracker row or untested suspicion                 |
| `decision`   | Multiple credible options have a consequential, reversible or irreversible tradeoff                                                           | Obvious implementation choices                                    |
| `change`     | For all product work. Use one cohesive vertical behavior slice with a one-sentence `approval_claim`                                           | One node per file, layer, or persona                              |
| `migration`  | Old and new states must coexist or transition safely                                                                                          | Every refactor or rename                                          |
| `risk`       | A concrete failure scenario has material impact and needs control or explicit acceptance                                                      | Generic reminders to test carefully                               |
| `proof`      | Add at least one active `focused` proof per change. Add a distinct active `boundary` proof for elevated or critical work and controlled risks | A prose claim without a reproducible signal                       |
| `delivery`   | Once the objective's exact reviewed set is ready to compose and promote                                                                       | Declaring the run promoted before post-sync verification          |

The graph's durable spine is:

```text
objective
  ├── affected system / interface / data / flow / contract
  ├── defect or decision, when material
  └── change (vertical slice)
        ├── dependency and migration
        ├── introduced risk and disposition
        └── proof
              └── exact current receipt

delivery ── exact coverage ──> objective + changes + direct decisions/migrations + proofs
```

Reciprocal architecture facts have one stored authority: `interface.produced_by` exposes virtual
`system.exposes`, `data_model.owned_by` exposes virtual `system.owns`, `contract.applies_to` exposes
virtual `constrained_by`, and `flow.participants` exposes virtual `system.participates_in`. Likewise
`change.introduces` exposes `risk.introduced_by` and `change.addresses` exposes
`defect.addressed_by`. Agents never persist both directions. A system dependency is not declared
acyclic by default because real legacy dependency graphs can contain cycles. A project may
strengthen that invariant when its architecture genuinely guarantees it.

`defect` adds bug-specific meaning without forcing feature work into a diagnostic vocabulary. It
records expected behavior, observed behavior, reproduction or observation signal, localized cause,
causal chain, and ruled-out alternatives. A change `addresses` a defect. A proof may verify the
defect, the change, or both.

> **Refined before implementation: 2026-07-14:** A general Bug Fix profile cannot require a
> confirmed root cause before approval: some defects need instrumentation or a write-based
> reproducer. The seed must always carry expected behavior, observed behavior, and the available
> reproduction signal, plus an honest localization state. Root cause, causal chain, and ruled-out
> alternatives become mandatory for implementation readiness. One conditional diagnosis ticket
> closes that gap when read-only planning could not. This preserves causal work without forcing the
> planner to invent certainty.

> **Causal diagnosis sequencing finalized: 2026-07-14:** The localization-state wording above is
> retained as the earlier design checkpoint. The frozen schema instead uses compiler-owned defect
> status `unresolved -> diagnosed` and has no authored localization field. A normal unresolved Bug
> Fix seed contains expected/observed/reproduction evidence plus exactly one focused proof that
> verifies only the defect. It contains no speculative addressing change. A conditional graph-only
> grounding ticket exists only for a legacy or malformed seed. The proof's source-only preparation
> and historical baseline precede reviewed diagnosis. Only then may change planning exact-cover
> every active defect with same-objective addressing work. The same diagnosed/addressed/currently
> proved closure applies when an active defect appears under another work kind.

> **Duplicate-oracle repair clarified: 2026-07-14:** “Exactly one” above is an anti-fanout and
> causal-authority invariant, not permission for the grounding agent to choose between competing
> evidence. A missing diagnostic proof can be added by the bounded grounding operation. If two or
> more active diagnostic proofs already target the same defect, that operation must make no graph
> mutation, name the conflicting proof IDs, and request explicit human-authorized oracle selection
> or semantic replanning. The historical proof authority remains visible. A model may not silently
> delete, supersede, or select it.

## Proof strategies

The profile keeps three implementation strategies and narrows their meaning:

| Strategy               | Use when                                                                                                         | Required baseline                                                                                          | Invalid use                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `red_green`            | New deterministic behavior is absent, or a defect is reproducible                                                | The exact focused command fails for the intended missing/incorrect-behavior signal before production edits | Environment/setup failure, unrelated regression, vacuous assertion, or rewriting the test during green work |
| `characterization`     | Existing behavior must be preserved through refactor, migration, or work in weakly covered legacy code           | A focused relevant observation passes before production edits and stays materially unchanged               | Characterizing an accidental bug as desired behavior without an approved contract                           |
| `current_verification` | The change is mechanical or already-correct behavior is being preserved and an existing check directly covers it | The existing command passes and is shown to exercise the bounded outcome before and after                  | Claiming an existing green check proves genuinely new behavior it did not previously exercise               |

When no trustworthy oracle exists, planning does not manufacture one. It records the gap and asks
for the missing product decision, performs bounded localization, or blocks for an unavailable
environment. Exploratory work is justified by an unresolved fact, not offered as a loophole around
proof.

Ticket-local baseline and focused checks are causal implementation evidence and explicitly declare
`composed_replay: never`. Replaying them as well as the graph proof would spend twice for the same
signal. The linked proof node remains the promotion-grade obligation whose registered read-only
check is selected for fresh composed replay. Its path contract distinguishes evidence/test-source
files from the product paths it claims to cover, so the compiler never infers coverage from naming
conventions. The generic field names and receipt-selection mechanics are coordinated with the
parallel compiler-graph-TDD lane before the Software schema consumes them.

> **Implemented proof split: 2026-07-14:** The paragraph above records the pre-wiring contract.
> Software 0.4 now compiles one complete graph-selected baseline set from each proof's
> `baseline_check_id`: `proof-expected-red` and `proof-current-baseline` are historical and never
> replayed during composed verification. The green verifier executes the current
> `promotion-proof-set` through `proof-command` and preserves the exact baseline proof-source bytes.
> Baseline and promotion may classify different exit sets, but they must agree on proof node, argv,
> contained working directory, source paths, and covered paths.

> **Focused, prepared, and boundary topology finalized: 2026-07-14:** Direct implementation proof is
> now a focused proof scoped to exactly one change or migration. Elevated/critical work attaches a
> distinct boundary proof through an introduced risk. That proof does not directly certify the
> change and may run green only after every introducing change and mitigation control is terminal.
> Newly authored diagnostic and risk-boundary proof source receives one conditional `proof.prepare`
> ticket, historical baseline, and independent oracle review, which compiler-stamps `prepared`
> rather than `passing`. Routine focused proof stays inside the implementation workflow, whose
> implementation step runs the compiler-owned promotion set before independent review, so it pays no
> duplicate Verifier boundary. A generic source-only preparation binding is still required to prove
> cross-ticket command/subject/oracle/source identity while allowing covered product bytes to
> change. `prepared` alone is not advertised as that guarantee.

> **Implementation-proof plurality clarified: 2026-07-14:** The focused topology above constrains
> every proof to exactly one implementation subject. It does not constrain a subject to exactly one
> proof. Prefer one primary cheapest trustworthy seam, but allow additional focused proofs for
> distinct wiring, compatibility, runtime, UI, data, or operational gaps. A `red_green` subject
> still needs at least one genuinely expected-red proof. An honest current or characterization proof
> may supplement but cannot replace that causal evidence. “Nonredundant” is an independent
> semantic-review judgment over claims, commands, layers, and `not_proven`. The compiler guarantees
> scope, execution, and currentness rather than pretending to measure information gain.

> **Diagnostic preparation projection corrected: 2026-07-14:** The earlier generic
> proof-plus-subject description was too broad for Bug Fix diagnosis. Preparing an unresolved
> diagnostic and then adding reviewed `root_cause`, `causal_chain`, and `ruled_out_alternatives`
> would change the defect's semantic hash and revoke preparation exactly when diagnosed readiness
> required it. Diagnostic preparation now binds the semantic proof node, including its exact
> `verifies` edge, while the defect remains in read/review scope. This preserves the oracle across
> the intended causal-field refinement but still stales proof retargeting or any proof, command,
> source, workflow, receipt, or review drift. Risk-boundary preparation continues to bind both proof
> and risk because the risk scenario and treatment must already be stable.

> **Prepared-proof currentness implemented: 2026-07-14:** The generic compiler now exposes a
> structured `proof_preparation_current` predicate. It binds one proof to the exact reviewed
> preparation operation, target universe, composite set/member, semantic oracle, command, working
> directory, profile, reviewed output, and compiler-recorded proof-source manifest. It deliberately
> recomputes only `source_paths`: covered product bytes may change during the later repair or
> control, while proof-source, subject, command, or oracle churn reopens preparation. Direct
> composite membership may use bare `$target` with ordinary proof type/status/read-scope filters, so
> two proofs sharing a subject still prepare and execute independently rather than inverse-fan out
> through that subject. The frozen Software YAML has not yet consumed this API at this dated
> checkpoint. Release requires that consumer wiring and its source-drift regression.

> **Proof-source authority separation implemented in part: 2026-07-14:** When a single emitted
> workflow can write both compiler-selected proof source and production paths, only the exact
> compiled member's configured `source_paths_field` projection counts as proof-source authority.
> Ticket emission rejects equality and directory containment in either direction, ambiguous
> projections, and invalid paths. Read-only and no-graph-set workflows remain compatible. A proof
> prepared in an earlier ticket is a separate authority lifetime. Its current public binding is
> boolean and cannot yet drive an early later-ticket production-path comparison, so that
> cross-ticket case remains an explicit release gate rather than being inferred from Software edges
> or mutable status.

> **Typed global-authority transition: 2026-07-14:** Preserve the boolean-only paragraph above as
> the boundary that motivated the new work. The generic compiler now has a moving typed current-
> preparation binding plus emission-time and lease-time overlap admission, but that interface is not
> released and the bundled Software profile has not consumed it. Current gates are stable historical
> review-boundary provenance, predicate/declaration agreement, proof that a preparation operation
> carries only its exact selected source grants, real tracked/Git-common predicate evidence, and the
> equality/containment/late-binding/retry matrix. `prepared` status, profile edges, or prompt policy
> still cannot substitute for compiler-owned provenance and authority checks.

> **Software consumer-status transition: 2026-07-14:** Both “has not yet consumed” checkpoints above
> remain the source-history boundary. The bundled Software profile now consumes typed preparation
> currentness and global prepared-source admission through the complete Bug Fix preparation →
> diagnosis → implementation → passing-successor lifecycle. This is a consumer implementation
> result, not a generic compiler release: final acceptance still requires the operation-scoped
> successor/receipt cost bound and one immutable current matrix.

> **Bug Fix sequencing review: 2026-07-14:** The first Software consumer must also avoid a semantic
> cycle. A defect is grounded before its diagnostic proof is prepared, then diagnosis intentionally
> adds causal fields. Binding the preparation to the full defect node can invalidate it exactly when
> the diagnosis rule starts requiring it. Before release, prove the exact bootstrap flow using a
> proof-only preparation target with the defect retained as read/topology, or an explicitly declared
> stable subject projection. Generic relevant-subject drift rejection remains intact. This profile
> boundary must identify which pre-diagnosis facts the reviewer actually approved.

> **Bug Fix sequencing source correction: 2026-07-14:** The bundled diagnostic preparation now
> targets the proof only, with the defect retained as read/topology, and its focused regression
> asserts that adding causal diagnosis fields does not re-prepare before product mutation and
> promotion. This is source-addressed pending a stable exact result. Risk-boundary preparation still
> deliberately binds its risk subject, and relevant proof/risk drift must continue to reopen.

> **Bug Fix preparation-successor transition: 2026-07-14 (`compiler-graph-tdd`):** The source
> correction above now continues through the complete lifecycle without a Software-specific status
> exception. The reviewed expected-red preparation remains the authority when generic
> `assurance.proof.establish` supplies the exact authenticated `prepared` → `passing` successor.
> Unrelated diagnosis effects are disjoint and leave that lineage unchanged. The shared newest
> operation/source attempt governs both `proof_preparation_current` and the global prepared-source
> lock, so promotion emits no repeated preparation, diagnosis, or establishment work, and an
> implementation-ready later change whose owned path overlaps the diagnostic source is rejected. The
> focused lifecycle and drift cases are green in current source. Whole-lane release remains tied to
> the adjacent generic compile-epoch count and immutable-fingerprint gate rather than to this
> profile result alone.

> **Bug Fix successor-cost evidence transition: 2026-07-14 (`compiler-graph-tdd`):** The generic
> cost gate above is now structural rather than elapsed-time based. Preparation graph results are
> keyed by the complete graph, while one reentrant ticket/ receipt source index serves every
> derivation graph identity and a second source epoch begins only after reconciliation for
> emission/write admission. Tests prove three graph-result scans and two source-index loads for a
> fresh Software compile, zero unnecessary receipt parsing when there is no reviewed preparation,
> one receipt parse across multiple nested lookups when evidence exists, and invalidation for both
> excluded projection changes and ordinary spec changes. The complete Bug Fix lifecycle remains
> green through promotion/no-repeat/global-source-lock behavior in about thirty seconds in a debug
> test build. That measurement is diagnostic only, while the counters are the release invariant.

> **Currentness hardening: 2026-07-14:** `proof.status: passing` is historical lifecycle state, not
> sufficient current evidence. Proof execution is unsatisfied unless the proof is both reviewed
> passing and its exact compiler-bound check receipt is current for the selected command and inputs.
> Delivery repeats both predicates. A stale receipt therefore reopens the deterministic proof work.
> The present generic compiler does not yet project terminal adverse command outcomes into
> compiler-owned `failed`/`blocked` proof states. Until the proof-compiler lane publishes that hook,
> the Software profile must fail closed and preserve the diagnostic receipt instead of adding a
> multi-ticket `proof_attempt` bureaucracy or claiming automatic remediation that does not exist.

> **Adverse-evidence transition: 2026-07-14:** The generic lane subsequently added a typed
> `check_has_current_terminal` predicate and durable failed/timed-out/invalid member receipts, while
> intentionally declining to infer Software's semantic proof status. Software keeps that separation:
> a nonpassing current member fails the proof ticket with its receipt intact and does not rewrite
> `proof.status`. The new hook is available to customized remediation policies. The bundled default
> does not manufacture an automatic repair state or an extra attempt node merely because a command
> failed.

## Risk classification and assurance

Every change records one tier and the concrete factors supporting it:

| Tier       | Typical shape                                                                                                                                                                                               | Minimum assurance                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `routine`  | Local, reversible, one boundary, no compatibility/data/security consequence                                                                                                                                 | One focused graph-bound proof, semantic review, composed verification                                      |
| `elevated` | Multiple boundaries, stateful behavior, external contract, new dependency, UI-to-service wiring, or nontrivial operational effect                                                                           | Focused proof plus a second boundary-level proof and at least one explicit risk disposition                |
| `critical` | Auth/permissions, secrets, privacy, money, destructive data, irreversible migration, concurrency/consistency, public compatibility, deployment infrastructure, safety/regulatory behavior, or weak rollback | Multiple proof layers, explicit risks and rollback/roll-forward controls, and qualified independent review |

> **Critical-work boundary: 2026-07-14:** The bundled cross-project default can mechanically require
> focused and boundary proof, explicit risks, and recovery/roll-forward controls, but it cannot
> honestly manufacture domain qualification. “Qualified independent review” remains the intended
> project-customized policy. The default Reviewer must surface the missing expertise as a blocker or
> escalation for security, privacy, financial, safety, or regulatory work rather than claiming
> qualification from a persona label alone.

A material risk has one of two structurally proven dispositions. A controlled risk links through
`mitigated_by` to an implemented change or completed migration and has a passing proof that verifies
the risk. That proof has `purpose: boundary`. An accepted risk links through `accepted_by` to an
accepted decision that the compiler reviewed. Its rationale records why the residual exposure is
tolerable. Delivery exact-acknowledges every introduced risk and includes its proof or acceptance
decision. It does not trust an agent-written risk status or a prose claim that mitigation exists.

> **Approval-bound acceptance: 2026-07-14:** The phrase “compiler-reviewed accepted decision” above
> describes structural validation, not authority to accept new residual exposure. A risk may use
> `treatment: accept` only when the acceptance decision and choice were already present in the
> human-approved graph seed, or when a later explicit human/change-control approval is compiler
> bound. A Risk Analyst plus model Reviewer may validate that evidence. They may not invent a new
> material-risk acceptance after approval.

> **Current profile enforcement: 2026-07-14:** The released engine has run-level seed provenance but
> no rule-queryable per-node origin. Software 0.4 therefore uses a closed authority path instead of
> guessing from IDs or timestamps: initialization is the only profile operation allowed to create a
> `decision`. Every post-approval operation is forbidden from creating one. Decision resolution may
> only validate and compiler-stamp the already populated choice, rationale, and reversibility
> fields. A custom operation or imported graph path that weakens this closure must also fail closed
> on `treatment: accept` until core exposes compiler-owned node origin bound to the approved
> planning hash. This note narrows the earlier design without replacing its approval-bound
> principle.

The risk node makes that choice explicit with required `treatment: mitigate|accept`,
`treatment_rationale`, and `residual_risk` fields. The relationships must agree with the choice:
mitigation has one or more `mitigated_by` change/migration edges and no acceptance edge. Acceptance
has exactly one `accepted_by` decision and no mitigation edge. The ordinary `plan-change` fallback
must create the structure correctly on its first pass. If an approved seed still contains an
incomplete treatment, a narrow two-boundary `plan-risk-treatment` fallback lets the Risk Analyst
repair that risk directly and an independent Reviewer validate it. It does not reopen the whole
objective or create a standing risk lane for already valid risks.

> **Risk-routing refinement: 2026-07-14:** Missing product/control scope is not a narrow repair.
> `mitigate` with no eligible `mitigated_by` change or migration, and `accept` with no
> approval-bound decision, reopen objective planning. The narrow lane is disjoint: it may remove
> contradictory treatment edges and add the missing boundary proof around an already existing
> control, but it cannot manufacture product scope or acceptance authority. Implementation excludes
> both gap sets.

Risk tier does not come only from the selected run type. Small work can discover critical risk and
must escalate. Large work does not manufacture critical risks merely to justify its name.

The current expression DSL needs two deliberate safeguards. `for_all` over an empty selection is
true, so every mandatory universal is paired with an explicit edge count or tier-specific existence
condition. Raw `edge_count` also sees linked superseded proofs, so design readiness must either
prove that the linked proof set equals its non-superseded subset or remove the obsolete edge before
cardinality can satisfy the tier. Elevated/critical design also requires a non-superseded contract,
integration, or end-to-end proof candidate. Review still evaluates whether the proof layers are
meaningfully independent rather than two aliases for the same signal.

> **Refined before implementation: 2026-07-14:** Keep the paragraph above as the initial cardinality
> design. The accepted implementation uses required scalar `proof.purpose: focused|boundary` plus
> active-proof queries instead. Routine work requires an active focused proof. Elevated/critical
> work requires separate focused and boundary nodes, so one node cannot satisfy both obligations.
> Exact delivery includes only active proofs. Superseded proofs remain historical context and cannot
> satisfy readiness. Reviewer instructions still reject two purpose labels over the same
> command/claim as fake independence.

> **Risk-assurance refinement: 2026-07-14:** Boundary assurance is required for both mitigation and
> acceptance. Risk acceptance changes who authorizes residual exposure. It never substitutes for
> current proof of the tier-triggered boundary. Both delivery branches require an explicit
> risk-boundary proof that is reviewed `passing` with a current promotion receipt. Critical work
> also requires concrete recovery controls and an already accepted `review_authority` decision. That
> typed decision records configured human authority but does not pretend a string proves
> professional qualification.

> **Co-located oracle customization boundary: 2026-07-14:** Some repositories keep tests and product
> code in the same physical file. The default's path-level source preservation cannot honestly grant
> a baseline write to one region and a later product write to another region of that path. The
> customization skill now detects this before selecting an authoring strategy, prefers an existing
> repository-native external harness when it proves the same behavior, and otherwise asks the user
> to choose a separate harness or an explicitly redesigned compiler/workflow authority contract. It
> must disclose the lost byte-preservation guarantee. It may not silently relabel new behavior
> `current_verification` or grant product authority to a baseline step.

## Ticket compiler policy

The approved graph seed is the normal design path. Fallback discovery/design tickets exist only when
the semantic graph is genuinely incomplete.

1. Create an architecture mapping ticket only when the objective has no grounded affected system.
2. Create a contract ticket only for a boundary explicitly marked as requiring a contract and
   lacking one. Do not require every system to own a data model or contract.
3. Create a change-design ticket only when no vertical change exists or a change lacks the proof and
   tier declaration required to plan it. For `work_kind: bug_fix`, also require a causal `defect`
   connected to the objective and addressed by at least one planned change.
4. Create a risk-treatment repair only for a material risk whose declared treatment and structural
   edges disagree. Emit no risk ticket for a valid disposition.
5. Create decision work only for an open consequential choice.
6. Create one implementation ticket per dependency-ordered `change`, not per file or layer.
7. Keep baseline, production edit, focused check, and semantic review in the same implementation
   ticket. The expected-red or characterization boundary remains causal and compiler-recorded.
8. Create separate proof execution only for graph proof obligations that require a fresh
   compiler-bound command. Do not create proof tickets for generic prose.
9. Do not create a generic integration-assessment lane. Material cross-slice behavior is an explicit
   graph proof. Ordinary composition is handled by target sync and composed verification.
10. Create one delivery ticket that exact-covers the objective's realized changes, proofs, and
    direct prerequisites, and dispositions every introduced risk.
11. Never create a review ticket. Review is a trust-boundary step over the actual candidate.

> **Graph-local proof transition: 2026-07-14:** The generic compiler owner has now released an
> opt-in composite `graph_set` contract. Software 0.4 adopts typed proof `source_paths`,
> `covered_paths`, and `working_directory` fields and lets the implementation verifier execute the
> exact promotion-grade proof members selected through `change.verified_by`. That can eliminate a
> duplicate execution-agent boundary, but not semantic acceptance: a reviewed profile effect still
> decides whether the proof claim is sufficiently supported. Rules name the composite parent in
> `check_passed` and may route its current failed/timed-out/invalid terminal without inventing a
> `proof_attempt` node. Profiles omitting the composite contract retain the earlier mapped-command
> behavior. Research and pinned runs are unchanged.

> **Lean implementation transition: 2026-07-14:** The “implementation verifier” wording above is
> retained as the earlier wiring checkpoint. The frozen routine workflow is now exactly
> `establish-baseline -> implement -> review`: after the implementer's semantic readback, the
> compiler executes the complete focused promotion set and binds its receipt before the independent
> Reviewer may pass. Standalone `proof.establish` remains for prepared boundary, legacy, stale, and
> recovery proof. A future current-step configured-check broker can remove duplicate manual command
> execution inside one agent turn, but it is an efficiency hardening item rather than another model
> stage.

> **Exact-closure refinement: 2026-07-14:** Delivery uses only active, non-superseded facts and
> requires at least one objective change before evaluating universal predicates. Its exact include
> set closes over active objective changes, their current proofs, direct required decisions and
> migrations plus migration proofs, introduced-risk proofs or approval-bound acceptance decisions,
> and eligible mitigation controls plus their proofs. A mitigation change must belong to the same
> objective. A mitigation migration must be a direct requirement of one of those changes. This
> prevents an arbitrary cross-objective node from being imported as a plausible “control.” Bug Fix
> delivery also carries the addressed defect and its active proof when the graph schema permits it.

> **Universal closure and single-delivery revision: 2026-07-14:** Exact delivery now includes every
> active objective defect and its current proof regardless of the selected work kind. It also
> includes current risk-boundary evidence for both accepted and mitigated risks. If objective
> closure changes after `candidate_ready`, review-effect currentness reopens the same delivery. Its
> ticket receives exact read/write authority over `objective.delivered_by`, and target-state
> cardinality requires exactly one delivery. Adding a second candidate cannot satisfy the ticket.

Routine planning should therefore yield one product change ticket plus the profile's proof and
delivery trust-boundary work, not twelve role/phase tickets before code can begin.

An incomplete approved seed cannot race into implementation: implementation rules select only
design-ready changes. A treatment predicate excludes the introducing change from every
implementation strategy until the narrow risk repair and any acceptance decision succeed.

> **Rule-polarity hardening: 2026-07-14:** Eligibility belongs in a rule's `for_each`. Its `when`
> must describe only the unsatisfied target state. Koni re-evaluates `when`, not query membership,
> when deciding whether a ticket reached its target. A prerequisite disappearing mid-ticket must
> therefore keep the transition unsatisfied and fail review, never make the ticket look complete.
> Mandatory universals are paired with explicit existence checks so an empty set cannot pass
> vacuously.

## Workflow shape

### Plan and approve

The planning agent performs a cheap decision scan before broad inspection, maintains one compact
repository ledger, and investigates only facts that can change scope, architecture, risk, proof, or
approval. The final planning stage emits both a complete prose plan and the smallest valid graph
seed. Human approval binds the outcome, explicit choices, non-goals, and graph seed.

### Implement and prove

For each slice:

1. Establish the configured red, characterization, or current-verification baseline.
2. Make the smallest cohesive production change. Keep unrelated refactors out.
3. Run the exact focused repository command and record a candidate-bound receipt.
4. Independently review acceptance alignment, correctness, regression, scope, security, and design.

Single-producer graph fallbacks also avoid transcription handoffs: the Mapper, Contract Designer,
Change Designer, Risk Analyst, or Decision Designer writes the bounded graph delta directly, and a
fresh Reviewer evaluates it. The no-op Integrator step in a single-slice implementation workflow is
unnecessary because one ticket worktree already contains the coherent patch and the Verifier writes
nothing. Integrator remains meaningful for exact delivery assembly and target conflicts.

> **Worker-wait cognition rule: 2026-07-15:** A live worker is compiler-observable state, not a
> reason to spend a Lead turn. Automatic orchestration waits passively until a durable result makes
> review, recovery, dispatch, or completion actionable. Explicit compatibility polling remains
> bounded and treats temporary run-authority ownership by a publishing worker as “still waiting,”
> not as a failed orchestration decision.

### Compose and promote

Delivery graph review is not promotion. After orchestration, Koni synchronizes the current target,
selects and replays safe repository-owned checks against the exact composed product tree, performs
any configured run-level review, compiles the report, and waits for explicit promotion.

## Review standard

Deterministic compiler validation runs first. The independent model reviewer receives the accepted
outcome and non-goals, exact diff, relevant graph neighborhood, current receipts, material risks,
and repository-specific instructions. It prioritizes:

1. Behavioral correctness and acceptance alignment.
2. Regressions, error paths, security, data, and compatibility.
3. Whether the proof would fail when the behavior breaks.
4. Scope discipline and accidental rewrites.
5. Architectural fit and maintainability.
6. Documentation and polish when material.

Blocking findings must be actionable and evidence-backed. Minor taste or perfectionism does not
reopen a change that definitely improves the codebase. One corrective pass is allowed. A second
failed review opens a blocker instead of starting an unbounded evaluator loop.

> **Review path-capability refinement: 2026-07-15:** Ticket scope may legitimately name a file that
> a later implementation slice will create. Independent review packets keep that planned path
> visible as unavailable in the current ticket checkout, but only current regular files become
> contained read capabilities or valid product-file evidence pointers. This is especially important
> for historical-red preparation tickets: future production paths are scope, not fabricated
> evidence, and their absence must not prevent review of the source-only baseline.

## Run types

`small`, `medium`, and `large` are complexity envelopes. `new-feature` and `bug-fix` are intent
presets derived from Medium behavior. When a catalog can select only one dimension, the intent
preset defaults to Medium and instructs planning to warn when discovered scope belongs in Small or
Large.

> **Work-kind compatibility refinement: 2026-07-14:** `objective.work_kind` remains schema-optional
> so legacy/direct initialization can still create the root, but it is mechanically required before
> any change becomes implementation-ready. Omission emits classification/planning work rather than
> silently taking the general path. The two intent presets must seed `new_feature` or `bug_fix`, and
> focused tests cover that contract. A future compiler-derived run-type binding can make the field
> intrinsically non-optional without breaking legacy initialization.

| Run type      | Intended use                                                                                 | Planning and execution policy                                                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `small`       | One known domain, one bounded claim, normally one change slice                               | At most one acceptance-blocking question. Narrow repository inspection. One worker. No mandatory architecture/contract/risk artifacts. Escalate on material boundary, data, security, or ambiguity |
| `medium`      | Several interacting components or one material interface/data contract                       | One early batch of up to three model-changing questions. One combined plan. Independent slices may run in parallel                                                                                 |
| `large`       | Cross-domain, migration, security/privacy, concurrency, rollout, or major compatibility work | Shared staged planning session, durable decisions, explicit risk/rollback structure, dependency-ordered slices, qualified run-level review                                                         |
| `new-feature` | A Medium-default product capability                                                          | Outcome and acceptance first. Map existing journey. Walking skeleton when cross-boundary. Thin vertical slices. Compatibility/rollout/observability only when material                             |
| `bug-fix`     | A Medium-default defect correction                                                           | Expected vs actual. Reproduce or honestly characterize. Localize root cause. Smallest causal patch. Regression proof at the failure boundary. Serialize implementation to preserve causal state    |

> **Planning-efficiency calibration: 2026-07-14:** Software planning now uses shared-session hard
> ceilings of 120k/240k/480k new tokens for Small/Medium/Large, each reserving the final 25% for
> synthesis. New Feature and Bug Fix inherit Medium's 240k ceiling. These are safety ceilings, not
> spending targets: agents must stop discovery when additional evidence can no longer change a
> decision. The earlier 250k/450k/1m defaults allowed repetitive exploration to continue too long
> before forced synthesis. Keep 1/3/5 execution parallelism as proportional ceilings, admit only
> dependency- and authority-independent slices, and tune future defaults from p95 successful-run
> telemetry rather than anecdote. Projects may override both limits when their verified workflow
> warrants it.

> **Module provenance policy: 2026-07-14:** The materially redesigned Software graph, rules,
> operations, checks, and workflows modules now identify as 0.4.0 with the 0.4.0 profile. Support
> modules retain their independently meaningful versions. Module versions advance when that module's
> executable semantics materially change. They do not move in mandatory lockstep merely because the
> profile aggregate changes.

### New Feature instructions

- Inspect the existing user journey, neighboring behavior, naming, tests, and boundary conventions
  before proposing a new abstraction.
- Translate the request into observable acceptance examples, important edge cases, compatibility,
  and explicit non-goals.
- Ask only for missing product or domain decisions whose answers change behavior.
- Prefer a walking skeleton for a cross-boundary feature, followed by thin end-to-end slices that
  leave the repository working.
- Reuse existing architecture. Do not create generalized platforms, extension points, or parallel
  abstractions for hypothetical future work.
- Use one executable acceptance seam for the capability and lower-level proof where it improves
  diagnosis or covers meaningful edge cases.
- Add interface, data, migration, rollout, observability, documentation, or rollback work only when
  the feature actually changes those concerns.
- Review the composed result against the user-visible acceptance contract, not merely green tests.

### Bug Fix instructions

- Record expected behavior, observed behavior, impact, environment, and available evidence.
- Reproduce before editing when feasible. A valid red fails for the reported behavior, not setup or
  an unrelated error.
- Localize the first invalid state and causal boundary. Do not stop at the first suspicious line.
- Keep a small set of competing hypotheses and rule them out with evidence when the cause is not
  immediately clear.
- Add the lowest trustworthy regression proof. If reproduction is impossible or unsafe, say why and
  choose honest characterization/current verification rather than fabricating a red test.
- Implement the smallest complete root-cause fix. Substantial refactoring is separate unless it is
  required to make the fix safe or testable.
- Search narrowly for the same causal pattern without silently expanding into a cleanup campaign.
- Verify using the original failure signal plus the smallest adjacent regression/contract suite that
  covers the blast radius.
- Review specifically for overfitting, overly specific conditions, changed behavior outside the
  report, and recurrence risk.
- After repeated failed localization or correction, preserve diagnostics and replan or escalate.

## Current profile alignment and required changes

The current Software profile already has strong foundations:

- canonical graph relations and exact repository-relative paths.
- adaptive red-green, characterization, and current-verification strategies.
- compiler-owned review effects and bounded review/worker retries.
- graph-bound proof cardinality and exact delivery coverage.
- target synchronization, fresh composed verification, and exact promotion.
- approved-plan graph seeding and bounded graph context.

The remaining misalignments are structural:

- Architecture currently requires a system, contract, and flow map for every objective, and every
  system is forced through contract work. These are conditional facts, not universal tickets.
- A routine seeded change currently pays five implementation steps, two proof steps, and four
  delivery steps. The no-write implementation Integrator and separate delivery audit handoffs add no
  authority that the compiler or final reviewer lacks. Fallback graph workflows also transcribe one
  producer through an Integrator before review.
- `expected-red` accepts exit code `1` only even though some repository-native test runners use
  another nonzero test-failure code. Wrong-reason failures remain semantically invalid, but the
  mechanical contract must support common intentional test exits.
- Introduced risk is visible in delivery prose but not yet a compiler-owned delivery predicate.
- `current_verification` wording can imply that a pre-existing green check proves new behavior. Its
  valid scope must be narrowed.
- There is no defect-specific semantic object or intent preset for causal bug work.

The implementation should therefore:

1. Make architecture and contract fallback rules conditional.
2. Add objective work kind, change risk tier/factors, risk acceptance relationships, and a `defect`
   node.
3. Require structurally proven risk disposition and tier-appropriate proof before delivery.
4. Let bounded specialists write graph deltas directly, remove the dead integration-assessment path,
   and collapse no-value workflow handoffs while preserving independent review.
5. Accept common expected-red exit codes while retaining wrong-reason semantic review.
6. Add inherited `new-feature` and `bug-fix` run types and package them with fresh initialization.
7. Strengthen planner, implementer, verifier, integrator, and reviewer instructions around this
   philosophy.
8. Leave the Research profile byte-for-byte untouched.

> **Implementation checkpoint: 2026-07-14:** The “current” and “should” lists above are retained as
> the pre-0.4 gap analysis. The source templates now implement all eight Software-scoped changes:
> conditional structure, direct producers, causal defects, structural risk, adaptive graph-selected
> proof, five run types, lean prompts, and `candidate_ready` delivery. Static template tests pass
> 7/7 and the exact bundled install/profile compilation passes 1/1. End-to-end profile coverage is
> not yet declared complete: three of five focused behaviors pass, while the proof-establishment
> path exercised by the delivery and adverse-evidence cases awaits the generic compiler's explicit
> disposition of a multi-anchor traversal that reaches one target from another. The Software lane
> has not edited Research. Independent Research changes elsewhere in the shared worktree remain
> separately owned.

> **Current integration transition: 2026-07-14:** The earlier three-of-five and multi-anchor
> paragraph remains the causal checkpoint. Per-anchor graph-set selection is now deterministic, the
> real output-then-compile path reaches both passing and adverse proof execution, and four of five
> focused behaviors pass. The remaining success-path failure exposed a generic review-effect replay
> bug that mistakes destination-field presence for the exact applied value. Software will not add a
> duplicate proof ticket to hide that defect. Before final release, the profile is also removing
> unused change/migration test-command duplicates and `proof.owned_paths` so linked proof nodes are
> the single executable and semantic evidence authority. Generic source-preservation,
> local-executable, rule-anchor, and step-scope findings remain independent compiler gates.

> **Current verification transition: 2026-07-14:** The three-of-five and four-of-five paragraphs
> remain the causal record, followed later by an expanded fifteen-case **14/15** checkpoint. The one
> failing deterministic same-ID stale-delivery revision now passes its exact consumer regression
> **1/1** through a second managed cycle without changing ticket identity. This is not yet a full
> Software release: the generic retirement/recovery units, complete sixteen-case target, real
> Software-configured Pi broker path, global prepared-source provenance/admission matrix, final
> design review, and one immutable whole-project rerun remain open.

> **Matrix-count evolution: 2026-07-14:** “Complete sixteen-case target” above is retained as its
> dated expansion checkpoint. The focused Software file now contains 20 cases after diagnostic-
> oracle, preparation-successor/currentness, and exact Git-common materialization coverage landed.
> Final evidence must therefore execute the current 20-case target. An older count cannot support a
> complete claim.

> **Same-ID lifecycle evidence transition: 2026-07-14:** Keep the historical expanded **14/15**
> discovery and the exact **1/1** consumer correction above. The generic namespace cause is now
> released with terminal-reopen **2/2** and lifecycle-relevant retirement/recovery **4/4** evidence.
> This closes only the retained worktree/branch collision. The complete current Software matrix,
> authenticated prepared-to-passing successor coverage, the Software-through-Pi composition, and one
> immutable integrated fingerprint remain open. One minimal post-successor rerun of the exact
> stale-delivery case is queued rather than inferred from ticket-ID reuse or `prior_cycles`.

## Acceptance checks

- The Software project catalog resolves five run types: `small`, `medium`, `large`, `new-feature`,
  and `bug-fix`.
- Both intent presets inherit the Medium pipeline and override only their intake, planning,
  concurrency, and instructions.
- A complete approved one-system/one-change/one-proof graph seed does not create architecture,
  contract, or change-design tickets.
- A routine one-slice run compiles exactly one product implementation ticket, its necessary proof
  work, and delivery. It does not compile one ticket per ontology node or role.
- A system with no material contract does not create contract ceremony. A boundary explicitly marked
  `contract_required` does.
- Every realized change has tier-appropriate graph-bound proof.
- Superseded proof edges cannot satisfy design readiness, and elevated/critical design includes a
  distinct active boundary-purpose proof rather than cardinality alone.
- Elevated and critical changes have explicit introduced risk. Controlled risk has an implemented
  mitigation and passing risk proof. Accepted risk has a compiler-reviewed acceptance decision.
  Otherwise, delivery is blocked.
- Red-green accepts the repository runner's configured expected failure code and still rejects
  wrong-reason failures semantically.
- Implementation workflows have no no-op Integrator boundary.
- Architecture, contract, change, risk-treatment, and decision fallbacks are direct graph-producer
  plus independent-review workflows rather than producer-to-transcriber chains.
- Delivery still exact-covers objective, changes, proofs, and direct decisions/migrations.
- A reviewed delivery is `candidate_ready`. Target sync, composed verification, and promotion remain
  later compiler-owned boundaries, so the graph never calls the pre-sync package `pr_ready`.
- Target sync precedes fresh composed verification, which precedes promotion.
- All existing Software profile/proof/lifecycle tests and new run-type/risk regressions pass.
- No Research profile or template file changes.

## Research basis and limitations

- OpenAI's Codex guidance emphasizes outcome/context/constraints/done conditions, concise durable
  repository instructions, tests, and independent review. Its subagent guidance warns about context
  pollution and coordination cost. See
  [Codex best practices](https://learn.chatgpt.com/guides/best-practices.md),
  [prompting](https://learn.chatgpt.com/docs/prompting.md), and
  [code review](https://learn.chatgpt.com/docs/code-review.md).
- OpenAI's agent-first repository report recommends a concise map with progressive disclosure, plan
  depth scaled to the change, repository-local knowledge, and mechanical architecture checks. Its
  monitoring work also treats optimizing for green tests while evading the real task as a distinct
  failure mode. See [Harness engineering](https://openai.com/index/harness-engineering/) and
  [coding-agent misalignment monitoring](https://openai.com/index/how-we-monitor-internal-coding-agents-misalignment/).
- Anthropic recommends simple composable agent patterns, environment ground truth, explicit stop
  conditions, and evaluator loops only when measurable improvement is possible. See
  [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents).
- Anthropic's later long-running-agent work identifies two recurring harness failures. One attempts
  too much work in one pass. The other declares completion from partial visible progress. The work
  finds that incremental clean states and durable handoff artifacts perform better than context
  compaction alone. Köni encodes that lesson as bounded vertical claims, compiler-owned current
  state, receipts, and explicit terminal predicates rather than an extra universal handoff phase.
  See
  [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).
- Agent evaluation must grade the resulting environment, not only the final explanation, and should
  combine mechanical, model, and human judgment according to the claim. This supports the profile's
  separation of exact proof receipts, independent semantic review, and explicit human risk/product
  decisions. See
  [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).
- Agentless showed that localization, repair, and validation can outperform more elaborate open
  agent scaffolds on its evaluation while costing less. Absolute benchmark numbers are now stale.
  The durable lesson is that orchestration complexity needs evidence. See
  [Agentless](https://arxiv.org/abs/2407.01489).
- A recent preprint studying agent-generated tests on SWE-bench finds test-writing frequency alone
  does not reliably improve resolution and that many generated tests act mainly as observational
  feedback. This is emerging benchmark evidence rather than a universal result, but it reinforces
  Köni's choice to require one trustworthy behavior-bound proof instead of rewarding test count or
  imposing red-green theater on every task. See
  [Rethinking the Value of Agent-Generated Tests](https://arxiv.org/abs/2602.07900).
- SWE-agent showed that tool/interface and feedback design materially affect repository-level
  agents. Its older model scores do not predict current capability. See the
  [NeurIPS 2024 paper](https://papers.nips.cc/paper_files/paper/2024/hash/5a7c947568c1b1328ccc5230172e1e7c-Abstract-Conference.html).
- DORA associates small batches, fast reliable automated tests, continuous feedback, and loosely
  coupled architecture with better delivery outcomes. These are organizational correlations, not a
  proof of one Köni topology. See
  [small batches](https://dora.dev/capabilities/working-in-small-batches/),
  [test automation](https://dora.dev/capabilities/test-automation/), and the
  [2025 AI-assisted delivery report](https://dora.dev/research/2025/dora-report/). DORA's current
  metrics guidance likewise recommends making changes as small as possible for both throughput and
  recovery, reinforcing conceptual vertical slices rather than layer- or file-sized tickets. See
  [software delivery performance metrics](https://dora.dev/guides/dora-metrics/).
- Google's engineering practices favor self-contained conceptual changes with related tests and
  review that improves code health without demanding perfection. Google's environment is unusually
  mature. The principles transfer better than every procedure. See
  [Small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html) and
  [the review standard](https://google.github.io/eng-practices/review/reviewer/standard.html).
- NIST's SSDF is explicitly outcome- and risk-based rather than a universal checklist. See
  [NIST SSDF](https://csrc.nist.gov/projects/ssdf).
- Microsoft's TiCoder work supports clarifying intent through tests, but its controlled code-
  generation tasks are narrower than repository delivery. See
  [LLM-based test-driven interactive code generation](https://www.microsoft.com/en-us/research/publication/llm-based-test-driven-interactive-code-generation-user-study-and-empirical-evaluation/).
  No single study settles an ideal agent workflow. SWE-bench results are repository- and model-
  dependent. DORA is organizational. Vendor guidance reflects vendor systems. TDD evidence is
  heterogeneous and largely predates coding agents. The design therefore treats empirical results as
  constraints and uses Koni's own run telemetry, retry histories, receipt failures, and review
  findings as the ongoing feedback loop for future profile revisions.

## Verification transition: 2026-07-14

After the fail-closed preparation/successor compiler work was released, the first complete current
Software run exposed four stale test fixtures and reached 16/20. Those fixtures were corrected
without weakening the profile: unrelated facts remain graph-valid, independent proofs own distinct
source-only authority paths, and a risk-bound proof must be re-reviewed after either mitigation
topology or accepted-treatment semantics change. The corrected suite then passed **20/20**, 0
failed, in 62.23 seconds on identical pre/post engine and test fingerprints. This closes the
acceptance checks in this document for Software 0.4. It does not broaden the result to Research, Pi
security/cutover, installed/live projects, or the entire shared worktree.

The current schema-2 initializer integration was also rechecked after that matrix. One historical
test fixture still constructed an existing schema-1 install and was correctly routed to migration.
It now constructs the schema-2 state that its replacement assertion describes. Six exact CLI and
embedded-template checks then passed: profile controls, noninteractive refusal before writes,
interactive selection, fresh/replacement versus existing/legacy behavior, the five run types, and
the one-reviewed-vertical-candidate prompt contract. This was a fixture correction, not a migration
or initializer-policy change.

A subsequent complete CLI run found the same legacy-helper mismatch in the idempotent-existing-
install fixture. After making that fixture schema-2-accurate as well, its exact case passed and the
entire CLI binary passed **66/66** on stable `main.rs` and embedded-template fingerprints. The
earlier scoped six remain the direct acceptance set. The broad run adds integration confidence
across installation, replacement, migration-facing, and owned-resource behavior.

Final integration review then caught a cross-lane schema-path drift in the installed skills: fresh
initialization publishes `.koni`, while the customization and operation guidance still treated
`.codex/koni` as the only live root. The skills now prefer schema-2 `.koni`, resolve catalog profile
sources, use provider-neutral YAML agents and current field names, retain explicit schema-1-only
compatibility, and refuse mixed roots. Installed-artifact and embedded-template regressions cover
the correction. All three skills validate, 12/12 YAML reference examples parse, and the complete CLI
binary remains **66/66** on stable current hashes.

## Current-head verification transition: 2026-07-14

The `54ca…` Software result above remains an immutable historical checkpoint rather than being
projected across later compiler work. After the shared workspace test surface became quiescent, the
complete Software binary was rerun against current `engine.rs`
`79080f2c4fb9a87d0f7ae6c9cc94b2789f0950406901bcb42b0147bfa5bc6a64` and unchanged
`software_proof_gate.rs` `aa60ba0138bf3ede1216bf5121b074d22ce56e39731236c1419d8d4a9e395b91`. Both
fingerprints were identical before and after. All **20/20** cases passed with 0 failures in 63.54
seconds (70.80 seconds wall time). This supersedes the queued current-head hold for Software 0.4
while preserving the older checkpoint as history. It remains scoped to the Software profile/compiler
boundary and does not claim Research, Pi host/security/cutover, installed or live projects, or
whole-worktree release.

### Later shared-source note

The `79080f2c…` checkpoint above remains valid, but another compiler edit to `9131b388…` landed
during the following CLI integration rebase. The CLI assertions passed 66/66 while that dependency
fingerprint changed, so they are diagnostic only and neither result is projected onto the later
engine. Current-head closure waits for the compiler owner's active exact reacceptance/workspace
matrix and a quiescent rerun. No Software 0.4 topology change is implied.

### Final current-endpoint closure: 2026-07-14 21:41 MST

The moving-source notes above remain the causal record. After the context/compiler cleanup and its
locked whole-workspace matrix completed, one focused sequential wrapper established the final
Software/CLI endpoint with identical SHA-256 values before, between, and after both binaries:
`engine.rs` `41436b37d63b63fc8dc37c7806a568809ef29d2188507d04e28cc3d984766533`,
`software_proof_gate.rs` `aa60ba0138bf3ede1216bf5121b074d22ce56e39731236c1419d8d4a9e395b91`,
`main.rs` `d627bb43d15802872a5d7ef3f1249aeacd3688c0a1e872e68a6e1a109e7b39f3`, and `templates.rs`
`5d6372285fa94714be3fe3779498d88976b276eb7d8917abbf706dcd2978d76b`. Software passed **20/20**, 0
failed, in 71.91 seconds. CLI passed **66/66**, 0 failed, in 3.13 seconds. This is the current
Software 0.4 release evidence and supersedes the queued endpoint holds, not their historical
diagnostics. Research design and Pi/installed/live/whole-project release stay separately owned.

### Bounded review-file evidence addendum: 2026-07-15 (`primary-integrator`)

The checkout-aware review-packet rule above now also shares the read-only broker's 96 KiB file
ceiling. A scoped Software source file larger than that bound is still disclosed as relevant scope,
with a typed `exceeds_read_limit` explanation, but is not offered as an inspectable path or valid
evidence pointer. Review workflows should therefore rely on smaller compiler-provided artifacts or
explicitly scoped product slices for such files. This note narrows the earlier phrase “current
regular file”. It does not change ticket scope, configured review contracts, or the cryptographic
binding of the complete current output set.

### Production-seam proof and explicit review rework: 2026-07-15 (`primary-integrator`)

The bounded review rule above now has an explicit operator disposition path. After two failed
independent reviews, Koni continues to preserve and block the rejected candidate. A nonempty
ticket-scoped `review-rework` steering event recorded after the blocker opened, followed by
`recover`, supersedes that candidate into durable history and opens one new configured correction
attempt with the latest findings and steering in context. Generic recovery cannot clear the blocker.

Software Implementers also receive a stricter proof rule: test-local code that reproduces the
desired production algorithm is not evidence that production behaves that way. A proof must call the
production seam or its real consumer. If that seam cannot be exercised inside compiler-issued scope,
the worker reports the exact scope mismatch instead of manufacturing an independently passing
substitute. This is a clarification of the earlier non-vacuous-oracle contract, not authority to
broaden proof or product paths.

### Software 0.5 oracle-case transition: 2026-07-15 (`proof-oracle-contract/root`)

The production-seam clarification above exposed a contract gap in Software 0.4: a proof could name
general conditions and covered product paths without mechanically binding each invoked production
seam to the exact path the worker needed to read. A later correction could therefore be semantically
right yet impossible inside the historical compiled scope. Software 0.5 replaces that ambiguity with
required structured `proof.oracle_cases`. Each case binds a stable ID, condition, bounded claim,
callable production seam or real consumer, exact project-relative `seam_paths`, action, positive and
material negative assertions, and any material environment or ordered recipe.

Every `oracle_cases[].seam_paths` entry must also be an exact member of the proof's read-only
`covered_paths` before any ticket dispatches. `source_paths` remains the sole proof/test write
authority. Change or migration `owned_paths` remains the sole production write authority. A
`uses`-linked system supplies semantic context only: its other `owned_paths` are never inferred or
unioned into proof capability. Missing coverage is corrected in the graph before work begins, while
legacy in-flight recovery remains a separate explicit, quiescent, hash-bound operator mechanism.
This required contract advances the bundled Software profile and its materially changed graph,
operations, and workflows modules to `0.5.0`. Existing installed projects remain pinned to their
prior profile version.

### Software 0.5 pre-release collection hardening: 2026-07-15 (`oracle-subset-review/root`)

The “exact member” sentence immediately above described semantic identity too strongly: the compiler
has always normalized project-relative path spellings such as redundant `.` components before
comparing path contracts. For Software 0.5, it is superseded by the precise rule that every oracle
seam path resolves to the same normalized project-relative path identity present in `covered_paths`.
This clarification does not widen filesystem authority or permit `..`, absolute, or otherwise
escaping paths.

Two additional generic collection guards now make the intended proof boundary mechanical before
ticket dispatch. `proof.source_paths` declares one-directional `disjoint_from: spec.covered_paths`.
Path disjointness rejects equality and either ancestor/descendant authority overlap, so read-only
production seams cannot also become proof-source write authority. `proof.oracle_cases` declares
`unique_by: id`. Profile compilation requires that identity to be a declared, required scalar item
property, and graph validation reports only field shape and duplicate count. Omission of either
generic keyword preserves legacy profile behavior. The bundled Software version remains the
not-yet-released `0.5.0`. No installed project is rewritten by this source-template hardening.

### Software 0.6 upstream implementation-oracle preparation: 2026-07-16 (`implementation-proof-preparation/root`)

The Software-0.5 oracle contract above made consumer seams explicit, but its focused red-green and
characterization sources were still authored inside the implementation ticket. That ordering let
product bytes change before an independent reviewer judged whether the new oracle actually exercised
every declared render, query, mutation, persistence, or other material consumer route. The preserved
Medium acceptance run exposed the cost: final review correctly rejected a narrow focused proof only
after production work, while ordinary review rework intentionally reopened at `implement` where a
trusted oracle source should no longer be writable.

Software 0.6 reuses the existing compiler-bound `assurance.proof.prepare` primitive rather than
adding a new stage. Every well-scoped focused proof whose implementation subject selects `red_green`
or `characterization` must first produce its honest historical baseline in a source-only ticket and
pass independent oracle-completeness review. Only a current reviewed preparation makes the linked
change or migration implementation-ready. The later implementation baseline re-confirms the same
bytes read-only, product work may write only subject `owned_paths`, and
`review_failure_reopen_from: implement` remains deliberate: ordinary code rework cannot revise the
pre-reviewed oracle.

`current_verification` is intentionally not projected into source authoring. Its exact existing
proof remains read-only in the established baseline step. Creating a preparation ticket merely to
rewrite a current proof would be false ceremony. Diagnostic proof-only targeting, risk-boundary
proof-plus-risk targeting, covered-product drift behavior, and green boundary execution are
unchanged. Preparation-eligible diagnostic, risk, red-green, and characterization sources are
pairwise authority-disjoint before dispatch.

This source change advances the bundled Software profile plus its changed graph, rules, operations,
and workflows modules to `0.6.0`. Checks remain independently versioned at `0.4.0`. Existing
installed profiles and already compiled runs are intentionally not rewritten. They need a future
explicit versioned profile migration/recompile mechanism. This implementation does not mutate or
reinterpret current tickets.

#### Software 0.6 review-domain correction: 2026-07-16 (`proof-rework-domain-fix/root`)

The preceding statement that every final implementation failure deliberately reopens `implement` is
superseded for prepared red-green and characterization workflows. Ordinary defects that the
product-only step can actually correct still use the bounded `ticket_rework → implement` route. A
final Reviewer is also explicitly responsible for proof-oracle and characterization relevance,
however, and may discover that the earlier preparation missed a consumer route. That finding now
uses the compiler-bound `upstream_proof` domain: the first failure preserves and blocks the rejected
candidate, dispatches no replacement Implementer, and records the safe recovery as
`replan_from_clean_integration`. The proof boundary must be corrected and independently prepared
from clean integration state before fresh product work. The rejected candidate worktree is never an
admissible historical baseline.

This is a generic workflow primitive, not a Software-only prose convention. A profile declares its
allowed failure domains and their `reopen` or `block` dispositions. The compiler advertises that
exact map in the reviewer packet and output schema, persists the selected domain in review
provenance, and rejects invented domains. Persisted schema-1.0 review history remains readable,
while every new compiler-launched reviewer must return schema 1.1 with `failure_domain: none` on a
pass or one advertised domain on a failure.
