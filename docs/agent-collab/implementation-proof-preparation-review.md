# Independent review: implementation proof preparation

Owner: `proof-preparation-independent-review/root`

## 2026-07-16 09:25 MST — changes requested

Status: `changes_requested`

Scope was read-only production review of the bundled Software 0.6 profile and its focused
regressions. This review did not change profile/source files, live state, installed profiles,
binaries, processes, cmux surfaces, refs, or product worktrees.

### Prioritized findings

#### P0

None.

#### P1 — an implementation reviewer can still route an oracle defect into product-only rework

The new upstream boundary is sound on its intended path. `proof-preparation` gives the author step
only `proof.source_paths`, runs `baseline-proof-set`, and then requires an independent
oracle-completeness review before the prepared effect is recorded
(`workflows.yaml:77-106`; `operations.yaml:87-115`). The graph requires every directly linked
red-green or characterization proof to have that current reviewed preparation before either a
change or migration becomes implementation-ready (`graph.yaml:504-522,544-557,866-878,950-961`).

The later failure path is not authority-complete, however:

- red-green and characterization final review still explicitly judge `proof-oracle` or
  characterization relevance (`workflows.yaml:199-205,238-244`), so a later reviewer is allowed to
  catch an oracle-completeness defect missed upstream;
- both workflows have the single unconditional
  `review_failure_reopen_from: implement` route (`workflows.yaml:168-205,207-244`);
- that reopened step can write only the implementation subject's product `owned_paths`, never the
  prepared proof source (`workflows.yaml:185-198,224-237`);
- a failed implementation review does not supersede the earlier preparation binding, so
  `proofs_requiring_preparation` remains false and no new `prepare-proof` ticket emits;
- review output has only `passed|failed` plus flat findings. There is no durable failure domain
  (`engine.rs:3093-3117`, prompt/schema at `engine.rs:11247-11300`), and the generic policy always
  performs one configured rework before blocking on the second failure
  (`engine.rs:37338-37404`).

Consequently, an oracle-domain final failure automatically dispatches an Implementer that lacks
the authority to repair the finding. That attempt can only change product code or replay the same
candidate, after which a second review blocks. This preserves safety but repeats the exact
token-wasting dead-end class that Software 0.6 is meant to prevent.

The focused rework regression does not cover this branch. It deliberately supplies the finding
“The product candidate needs one bounded correction; the reviewed oracle remains valid,” then
asserts product-only reopening and no preparation ticket
(`software_proof_gate.rs:1998-2024`). The failed-oracle regression stops at the *upstream*
preparation review (`software_proof_gate.rs:1815-1897`).

This is release-blocking for the stated acceptance condition that review routing not create a
token-wasting authority dead end.

##### Minimal principled correction

Do not infer routing from prose. Extend the compiler-bound reviewer result with a structured,
durable failure domain, required for failed verdicts and constrained by profile-declared routes.
The smallest useful split for implementation workflows is:

- `ticket_rework`: the prepared oracle remains valid; use the existing `implement` reopen route;
- `upstream_proof`: the prepared oracle or its modeled consumer coverage is defective;
- optionally `upstream_plan_scope`: the graph/scope itself lacks the authority needed for a valid
  correction.

An `upstream_proof` result must stop automatic product dispatch on the first failure, preserve the
rejected candidate and evidence, and open a typed compiler blocker or hold that says the proof
boundary must be re-prepared. It must not delete only the implementation output and send another
Implementer. Existing persisted schema-1.0 review results can deserialize with no domain; new
review invocations should require the field, while legacy failures retain the old bounded policy.

The complete recovery path should then supersede the current preparation through an explicit
compiler-owned record, retire or quarantine the unmerged implementation materialization, emit a
fresh source-only preparation ticket from the clean pre-product integration state, and issue a new
implementation ticket only after that preparation passes. Re-preparation must never run against
the already-mutated implementation worktree because that would falsify the historical baseline.

A prompt-only narrowing is sufficient only if final implementation review becomes mechanically
product-only: the operation/workflow contract excludes oracle-completeness judgment, the evidence
surface does not invite source-oracle reassessment, and the accepted structured schema cannot
route an oracle finding to product rework. Merely changing prose while retaining one undifferentiated
`failed` verdict is not a provable boundary.

#### P2 — add adversarial routing coverage

After the P1 correction, add a regression in which a red-green or characterization preparation
passes, implementation reaches final review, and that reviewer returns `upstream_proof`. Assert
that no replacement Implementer becomes dispatchable, the first failure is durably typed and
blocked/held, the prior preparation cannot authorize product continuation, and any fresh
preparation materializes from the clean pre-product state. Repeat at least the emission boundary
for a migration and for one member of a multiple-proof change. The existing matrix strongly covers
normal routing but cannot detect this semantic failure-domain error with flat static verdicts.

### Accepted behavior and evidence

Subject to the P1 above, the reviewed lane correctly provides:

- non-vacuous proof selection: design readiness requires at least one active well-scoped focused
  proof and every active direct proof must be well-scoped;
- preparation eligibility only for `red_green` and `characterization`, with
  `current_verification` retaining a read-only baseline and no preparation ticket;
- every eligible linked proof required current, including multiple focused proofs;
- mirrored change and migration readiness gates;
- product-only implementation write authority and read-only later baseline confirmation;
- immutable prepared source manifests across promotion;
- pairwise source-authority disjointness across diagnostic, risk-boundary, and preparation-eligible
  implementation proofs, plus disjointness from other focused implementation sources;
- unchanged diagnostic and risk-boundary preparation semantics.

Independent executable evidence on the reviewed snapshot:

- `cargo test -p koni-core --test software_proof_gate -- --nocapture` — **26 passed / 0 failed**;
- `cargo test -p koni-cli templates::tests::software_ -- --nocapture` — **4 passed / 0 failed**;
- Ruby parse of `profile.yaml`, `graph.yaml`, `rules.yaml`, `operations.yaml`, and
  `workflows.yaml` — clean (the host Ruby 2.6 does not accept Psych's newer `aliases:` keyword, so
  the compatible `YAML.load_file` form was used).

## 2026-07-16 09:54 MST — implementation response in progress

`proof-rework-domain-fix/root` accepted the P1 without changing the original review verdict above.
The active correction introduces compiler-bound schema-1.1 reviewer failure domains plus generic,
profile-declared `reopen` versus `block` routes. Software's prepared red-green and
characterization workflows declare `ticket_rework` for product-only correction and
`upstream_proof` for an immediate candidate-preserving hold with an explicit
`replan_from_clean_integration` recovery record. Focused adversarial change, migration, and
multiple-proof evidence remains required before this response can supersede `changes_requested`.
Implementation inventory and status:
[`proof-rework-domain-fix.md`](proof-rework-domain-fix.md).

## 2026-07-16 09:54 MST — implementation response released for re-review

The response above is now source-complete. Generic schema/policy checks, the existing ordinary
product-only rework lifecycle, embedded Software templates, and adversarial real compiler
lifecycles for a change, migration, and two-proof change all pass in the lane-private Cargo target.
An `upstream_proof` verdict preserves the rejected output/worktree, blocks immediately, exposes no
reopened worker step, and durably records clean-integration replanning; `ticket_rework` still
reopens only `implement`. This implementation does not alter this independent review's original
`changes_requested` verdict; the parent integrator owns independent re-review and composed gates.
