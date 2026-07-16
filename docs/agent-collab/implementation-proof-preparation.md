# Implementation proof preparation

Owner: `implementation-proof-preparation/root`

## 2026-07-16 08:52 MST — bounded default-profile implementation lease

Status: `in_progress`

This lane closes the upstream proof-oracle completeness gap exposed by the preserved Medium
acceptance run. It owns only the bundled/default Software profile, deterministic Software-profile
tests, and adjacent append-only documentation:

- `crates/koni-cli/templates/software/{graph,rules,operations,workflows}.yaml`;
- exact proof-preparation/implementation assertions and fixtures in
  `crates/koni-core/tests/software_proof_gate.rs`;
- adjacent Software-profile authoring guidance only if the executable profile change requires it;
- this mailbox, `docs/AGENT_COLLAB.md`, and an adjacent dated transition in
  `docs/software-profile-engineering.md`.

The intended invariant is that a planned implementation cannot receive product-write authority
while any linked focused implementation oracle that requires source authoring lacks a current,
independently reviewed source-only preparation and honest historical baseline. The existing
`assurance.proof.prepare` compiler binding remains the authority primitive. Diagnostic and
risk-boundary behavior must remain unchanged; final implementation review still reopens from the
`implement` step because the earlier independent review makes proof-source bytes immutable rather
than sending ordinary rework back through oracle authoring.

Current-verification proofs retain their read-only baseline path and must not receive a
nonsensical source-authoring ticket. Red-green and characterization proofs are the preparation-
eligible implementation strategies under audit. Exact strategy behavior and the final selector
shape will be recorded below with deterministic evidence.

Explicit exclusions: no live Updog state, installed project profile, ticket/worktree, Git ref,
binary or runtime asset, process, cockpit/cmux surface, Research profile, generic core/compiler
authority change, or automatic migration of an already compiled run.

## 2026-07-16 09:14 MST — implementation complete; focused release evidence

Status: `ready_for_integration`

The bundled Software profile advances to `0.6.0`. Its graph now separates
`preparation_eligible_implementation_proofs` (focused proofs whose sole change/migration subject
uses `red_green` or `characterization`) from the deliberate read-only `current_verification`
path. `proofs_requiring_preparation` includes that eligible set, while
`implementation_ready_changes` and `implementation_ready_migrations` require every directly
linked eligible proof to belong to `prepared_implementation_proofs`. That latter query accepts the
normal compiler lifecycle destinations `prepared` and `passing` but always requires the same
current `assurance.proof.prepare` review binding; status alone never grants readiness.

The existing preparation rule still targets diagnostic proof alone and boundary proof plus risk;
an implementation proof has no risk target and therefore binds only itself. The shared
proof-preparation workflow now authors and independently reviews diagnostic, risk-boundary,
red-green, and characterization sources. Its review contract explicitly judges consumer-route
completeness before product authority exists. Preparation-eligible sources join the pairwise
path-disjoint selector. Diagnostic/risk selection, subject binding, and green execution behavior
are otherwise unchanged.

Red-green and characterization implementation rules/workflows no longer project proof
`source_paths` into ticket or baseline write authority. Their baseline step re-runs the exact
reviewed historical signal read-only, preserves its source manifest into promotion, and only the
`implement` step may write the subject's product `owned_paths`. Both retain
`review_failure_reopen_from: implement`. Current-verification keeps its existing read-only
baseline and emits no authoring-preparation ticket.

Deterministic regressions prove:

- red-green and characterization emit `prepare-proof` but no implementation or redundant replan;
- a failed independent preparation review leaves proof status `planned` and product work blocked;
- a successful reviewed preparation enables the exact change or migration rule;
- every linked proof in a multi-proof red-green set must be independently prepared;
- current-verification changes and migrations emit no preparation ticket;
- implementation tickets expose only product write paths, baseline confirmation is read-only,
  and a failed final review preserves the baseline, removes only the product output, accepts a
  corrected product-only output, and finishes without reopening oracle authoring;
- the complete pre-existing diagnostic, risk, proof-currentness, delivery, aliasing, and lifecycle
  matrix remains green.

Focused gates:

- `cargo test -p koni-core --test software_proof_gate -- --nocapture` — **26 passed / 0 failed**;
- `cargo test -p koni-cli templates::tests::software_ -- --nocapture` — **4 passed / 0 failed**;
- warning-denied Clippy for the exact Core integration test plus Koni CLI binary — clean;
- Ruby parsing of all five changed Software YAML modules — clean;
- targeted Rust formatting, scoped diff whitespace, and untracked-document trailing-whitespace
  checks — clean.

Compatibility boundary: this is a bundled future-profile change only. Existing installed Software
profiles and already compiled runs remain pinned to their current profile bytes; there is no safe
automatic reinterpretation of an in-progress implementation ticket as a new upstream preparation
ticket. A future explicit versioned profile migration/recompile facility is required. This lane
did not migrate the preserved failed-review fixture or touch any live project/runtime surface.
