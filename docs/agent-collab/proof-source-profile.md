# Proof-source lifecycle separation — profile lane

## 2026-07-16 lease — `proof-source-profile/root`

Status: `ready_for_integration`

This lane owns only the default Software profile and its bundled authoring guidance for preventing
independently lifecycle-managed proofs from sharing physical source files:

- `crates/koni-cli/templates/software/graph.yaml`
- `crates/koni-cli/templates/software/operations.yaml`
- `crates/koni-cli/templates/codex/software/agents/run-planner.toml`
- `crates/koni-cli/templates/codex/software/agents/change-designer.toml`
- `crates/koni-cli/templates/codex/software/agents/reviewer.toml`
- `crates/koni-cli/templates/codex/shared/skills/model-koni-work/references/software-projects.md`
- template-string tests outside `crates/koni-core/src/{engine,config}.rs`, if a focused assertion is
  already colocated there
- this mailbox and the bounded central-registry row

The generic configuration interface is supplied by the coordinating lane and is consumed here as
`graph_constraints` with `kind: path_sets_disjoint`. The Software profile will declare two
separations: preparation-eligible diagnostic/risk-boundary proof sources are pairwise disjoint,
and that same preparation-eligible set is disjoint from focused implementation proof sources.

The authoring contract is physical-path based. Diagnostic, boundary, and focused proofs that have
independent preparation/authoring/review lifecycles require distinct source files. Different named
tests or describe blocks in one file are not distinct compiler authority and must not be modeled as
independent proof nodes. If tests intentionally share one physical file and lifecycle, they belong
to one proof node.

Explicit exclusions: no Rust core/config/engine edits, no generic constraint implementation, no
runtime/live-state/project-install changes, no binaries, no cockpit/cmux actions, and no Research
profile changes. Existing coherent concurrent edits are preserved.

Questions for adjacent lanes: none at lease time. The coordinating lane supplied the exact generic
syntax and selector names.

## 2026-07-16 implementation decision

The bundled Software graph declares two constraints with the supplied generic primitive:

1. `preparation-proof-source-paths-pairwise-disjoint` compares
   `diagnostic_proofs union risk_boundary_proofs` with itself while excluding only same-node
   comparisons.
2. `preparation-and-implementation-proof-source-paths-disjoint` compares that preparation set
   with `well_scoped_implementation_proofs`.

Both sides declare `node_types: [proof]`, `field: spec.source_paths`, and
`distinct_nodes: true`. This preserves legitimate multiple oracle cases inside one proof while
rejecting equal, ancestor/descendant, or filesystem-aliased authority between independent proof
nodes through the generic comparator.

`proof.source_paths` now explains the physical-file boundary. The diagnostic, change-design,
preparation, and risk-treatment operation contracts teach it at every graph-producing boundary.
The Run Planner and Change Designer must select separate sources on the first pass; the Reviewer
must reject a collision before dispatch. The installed Software modeling reference retains the
2026-07-15 oracle-scope clarification and adds an adjacent dated 2026-07-16 lifecycle transition
rather than rewriting that history.

## Verification and handoff

- `cargo test -p koni-cli templates::tests::software_ -- --nocapture` — **4 passed**, 0 failed.
  The assertions cover both configured constraint selectors/fields, operation contracts, all
  three agent prompts, and the installed modeling reference.
- `cargo test -p koni-core --test software_proof_gate
  software_architecture_contract_and_work_classification_are_conditional -- --exact --nocapture`
  — **1 passed**, 0 failed. This loads the real bundled Software profile through the compiler and
  proves an ordinary nonconflicting graph still emits work.
- `rustfmt --edition 2024 --check crates/koni-cli/src/templates.rs` — clean.
- `git diff --check --` over every leased profile/prompt/test/collaboration file — clean.
- The adjacent generic test lane independently reports `graph_path_constraints` **6/6**, including
  exact, ancestor/descendant, hardlink, symlink, distinct-node, and selector/type behavior. This
  lane did not edit or claim those core tests.

The final collaboration sweep read every document/mailbox changed since this lease began:
`docs/AGENT_COLLAB.md`, `agent-collab/primary-integrator.md`, and
`agent-collab/graph-path-constraint-tests.md`. Their contracts agree with this profile slice and
contain no unanswered overlap question. Exact leased files are released to the coordinating owner.
No installed profile, run graph, ticket, worktree, binary, process, cockpit, cmux surface, or live
acceptance state was changed.
