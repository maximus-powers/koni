# Software config consistency audit

## 2026-07-14 — final read-only audit

Scope: the authoritative bundled Software package under
`crates/koni-cli/templates/software/`, all ten native Software agent prompts,
the `configure-koni` and Software-relevant `model-koni-work` guidance, the
embedding/installer path, and all 20 focused cases in
`crates/koni-core/tests/software_proof_gate.rs`. This repository has no
`profiles/software/` source tree; that absence is the current layout, not a
finding. The repository-local `.codex/koni` installation is a separately
pinned historical profile and was not treated as the bundled-default source.

### Definite issue 1 — contract-designer prompt grants impossible decision work

- `crates/koni-cli/templates/codex/software/agents/contract-designer.toml:11-16`
  tells the contract designer to create only material “interface, data, flow,
  decision, or contract facts,” then says to preserve an unresolved approval
  blocker.
- `crates/koni-cli/templates/software/operations.yaml:26-37` authorizes new
  `interface`, `data_model`, `contract`, and `flow` nodes only, and explicitly
  says “Do not create a decision.”
- `crates/koni-cli/templates/software/operations.yaml:5-11` makes initialization
  the sole decision-creation boundary; the invariant is also exercised at
  `crates/koni-core/tests/software_proof_gate.rs:827-848`.

This is not an authority bypass because the compiler rejects the delta, but it
is a direct prompt/operation contradiction that can cause a contract ticket to
fail or waste a retry. The prompt should remove `decision` from the creation
list and retain only the existing instruction to report an approval blocker.

### Definite issue 2 — current-default guidance weakens the unconditional critical gate

- `crates/koni-cli/templates/software/graph.yaml:783-793` makes every `critical`
  change design-ready only when it has a recovery plan and requires an accepted
  `review_authority` decision.
- `crates/koni-cli/templates/software/operations.yaml:60-63` states the same
  current-default contract without a qualifier, and
  `crates/koni-core/tests/software_proof_gate.rs:768-799` proves recovery alone
  cannot unlock critical implementation.
- `crates/koni-cli/templates/codex/shared/skills/model-koni-work/references/software-projects.md:134`
  instead says the accepted `review_authority` decision is needed “when
  specialized review is required.” The same conditional framing appears in
  `crates/koni-cli/templates/codex/software/agents/run-planner.toml:35-38`.

For the current bundled default, that qualification is materially weaker than
the compiler contract: the gate applies to every critical change. The guidance
should say that unconditionally, while separately preserving the Reviewer rule
that a persona label never fabricates qualified domain expertise and unavailable
expertise remains a blocker/escalation.

### Clean consistency results

- All 17 bundled Software YAML files parse as YAML. All ten native Software
  agent files parse as TOML.
- Embedded inventory is complete: 17/17 Software files and 10/10 Software Codex
  files. `templates.rs` embeds the authoritative bytes directly with
  `include_bytes!`, and `main.rs:2040-2055` writes those byte slices without
  transformation, so packaged/install byte parity holds by construction.
- `project.yaml` catalogs exactly Small, Medium, Large, New Feature, and Bug Fix;
  Medium is default. New Feature and Bug Fix each have one `extends: medium`
  parent and express all differences through ordered overrides. They inherit
  Medium's 240k/60k planning ceiling; intentional concurrency is 3 and 1.
- Small/Medium/Large planning ceilings and reserves are 120k/30k, 240k/60k,
  and 480k/120k; concurrency ceilings are 1/3/5.
- Architecture and contracts are conditional. Each implementation proof has
  exactly one implementation subject; proof nodes remain the sole command/path
  evidence authority. `red_green` requires at least one expected-red proof,
  while characterization/current verification require a current baseline.
- Routine work needs focused proof; elevated/critical work needs a distinct
  risk-bound boundary proof. Risk treatment is structurally disjoint. Delivery
  is one revisable exact-closure node and remains only `candidate_ready` before
  target synchronization, composed verification, reporting, and promotion.
- The 20 focused regression bodies align with these invariants, including
  duplicate diagnostic fail-closed behavior, source/product path separation,
  exact current receipts, unconditional critical authority, one revisable
  delivery, and post-promotion prepared-source locking.
- Software inventory and embedding are separate from Research. Concurrent
  Research worktree changes belong to other active lanes and were neither
  modified nor included in this Software verdict.

### Residual release holds (not profile contradictions)

- This lane deliberately did not run the expensive 20-case Software suite.
  The compiler-owner mailbox records the exact Bug Fix successor lifecycle as a
  moving-checkpoint green, but the frozen full matrix remains a parent release
  gate.
- Prepared-successor replay cost is source-improved but not finally bounded:
  the compiler coordination record still requires an operation-scoped ticket/
  receipt index or equivalent inner-work counters, plus a stable-fingerprint
  broker-counter and focused-matrix run. This calls for compiler evaluation
  context work, not a Software graph/profile redesign.

Verdict: the Evidence-Guided Vertical Delivery topology is semantically
coherent and should not be redesigned. Correct the two instruction-level
contradictions above before calling the bundled Software configuration fully
consistent; retain the external compiler/fingerprint holds as release evidence
work rather than profile changes.

## 2026-07-14 — instruction contradictions resolved (`software-default-design/root`)

The two findings above remain the discovery record and are now resolved in source:

- `contract-designer.toml` removes `decision` from its creation list, states that the operation
  cannot create one, and still reports an unresolved product choice as an approval blocker;
- `run-planner.toml` and the Software modeling reference require recovery plus an already
  human-approved `review_authority` decision for every critical change, while explicitly separating
  that operator decision from mechanically proven specialist capability and blocking when required
  expertise is unavailable.

The embedded-template regression executes **1/1** with 64 filtered tests and asserts all three
contracts, including the absence of the stale decision-creation phrase. All 17 Software YAML files
and both shipped skills still validate separately. The remaining successor/fingerprint holds are
unchanged and require no Software topology redesign.

## 2026-07-14 schema-2 integration correction (`software-default-design/root`)

The audit's opening `.codex/koni` repository-local baseline was accurate at its cutoff but became
outdated when fresh init switched to schema 2. Final integration review found that all three shipped
skills still hard-coded the old root. Current guidance now discovers `.koni` first, resolves actual
catalog profile sources, uses provider-neutral agents/current fields, and treats `.codex/koni` only
as explicit schema-1 compatibility. Installed/template assertions, three skill validators, 12 YAML
example parses, and full CLI **66/66** are green. This is a path/runtime vocabulary correction, not
a Software graph-topology change.
