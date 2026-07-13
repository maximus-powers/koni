# Research profile

This profile keeps research semantics in versioned project configuration rather
than engine code. Its tracked `program/` layout makes canonical state,
receipts, and reports directly inspectable and supports deterministic
compatibility fixtures.

The canonical `project.yaml` exposes three standalone run types. Small uses no
agent planning pass and one worker at a time; Medium (the default) uses one
combined plan and three workers; Large uses separate architecture, risk, and
verification plans, five workers, and independent review. Model and reasoning
choices live in those run-type documents, while all three share this one
research profile and its personas retain prompts and sandbox boundaries. Every
run still requires explicit approval; afterward the run type's automatic
stages are supervised until the run concludes or reaches an explicit
question/failure boundary.

## Modules

- `graph/` defines the 13 research node types, required spec groups, statuses,
  the complete typed edge matrix, and the capability gate policy that selects
  verifier providers and inherited applicability context.
- `rules/` defines stage precedence, graph-gap ticket emission, terminal state,
  and ticket/gate/research state machines.
- `operations/` is the authority boundary for node creation, existing-node
  edits, deletion, gate changes, barriers, and single-flight families.
- `workflows/` defines versionable step DAGs and persona delegation.
- `actions/` composes lifecycle behavior from engine primitives. Irreversible
  or durable effects are ordered after validation and have configured recovery.
- `checks/` defines argv-only native execution and stable graph-check IDs used
  by rules.
- `personas/`, `reports/`, and `cockpit/` configure worker prompts,
  deterministic ledgers, and the human projection.

## Experiment ontology

`experiment` is reserved for a planned empirical intervention or observation
that can later produce a runtime receipt. The node contract in
`graph/nodes.yaml` requires an `empirical_mode`, prospective
`execution_protocol`, and runtime `observable_outcome`; its configurable
ontology annotation also names excluded work and the nodes or ticket structure
that should own it. Static proof, source inspection, traceability mapping,
documentation audits, no-write review, and other unexecuted verification belong
in methods, gates, prerequisites, or review work instead. Workflow output and
review contracts repeat this boundary so creative agents enforce its meaning,
while the generic field/enum validator enforces its structural markers without
research-specific Rust branches.

## Evidence ontology

This default profile is empirical and receipt-driven. A claim records its
scope, falsification path, evidence standard, and threats before experiments
are designed. An evidence atom must cite exact current runtime receipts and
carry a nonempty observed scope and limitations. It also declares the profile's
epistemic boundary as `evidence_basis: empirical_runtime` and
`inference_scope: bounded_empirical`; `supported` therefore means supported
within that bounded scope. Static reasoning, proof, source inspection,
traceability, and review output may be represented as methods, gates,
prerequisites, or review controls, but they are not promotable scientific
evidence and cannot turn finite observations into a universal conclusion.

Workers author evidence and conclusion candidates. They never author
promotion or acceptance fields. A configured, hash-bound passed review causes
the compiler to apply those fields atomically, and configured receipt coverage
requires every source run's latest receipt and explicit disposition before that
effect is allowed. A theoretical-research profile may configure different
evidence-basis and inference-scope values; the engine contains no
research-specific proof semantics.

## Stable profile interfaces

Public operations use their familiar names, while unique registry IDs preserve
stage/target variants such as `experiment-design.hypothesis.design-experiment`
and `preparation.experiment.design-experiment`. Tickets bind both values.

Graph-check IDs beginning with `gap.`, `target.`, and `terminal.` are also
public profile interfaces. They name bounded domain predicates such as complete
experiment constitution, compatible concrete gate assets, current scientific
receipts, and reviewed hypothesis conclusions. Implementations may optimize
these checks, but may not silently change their configured meaning.

## Scoped dynamic runtime contracts

Command checks never search the checkout for something executable. The gate
verifier uses `research-capability-gates` to select one deterministic winner
from the configured active asset pool by exact capability name, full SemVer
compatibility, ordered ranks, and an ID tie break. The active ticket must
authorize that winner plus its evaluation/applicability context and read paths;
an unscoped winner is a contract error and never causes fallback. The scientific
runtime resolves from the virtual ticket value, which combines the ticket
record with its single run target's typed contract. These sources are profile
IR, participate in the profile hash, and cannot broaden ticket authority.

A run's `spec.runtime_contract` declares exact argv, protocol, required
measurement keys, concrete asset entrypoints, scientific input bindings, and
optionally a narrow project-relative `output_root` with a `result_path` beneath
it. Omitting `output_root` is the stdout-only contract: `result_path`
must be absent and the typed result's `artifacts` array must be empty. With an
output root, a configured result file replaces stdout as the result source and
every result-declared artifact—either a path string or an object carrying
`path`—must resolve beneath that same root to a regular file created or
content-changed by the exact command attempt. Unchanged preexisting files,
symlinks, transient caches, and scientific input paths are not produced
artifacts. The compiler projects `required_measurements` from the same bound
ticket contract and requires the result's `measurements` object to be a
superset. Run tickets bind linked input assets and payload roots as stable read
evidence separately from the narrow write authority used for fresh outputs.

Configured action IDs are:

```text
validate, compile-full, start, spawn-lead, spawn-worker, context,
compile-ticket, output, review, finish, steer, migrate, recover,
report, rollback, cockpit
```

The CLI may expose compatibility aliases, but project workflows should store
the canonical action ID in events and journals.

The research `rollback` action is one compiler-owned
`rollback.forward_reversal` transaction. It is available only for paused,
clean tracked runs and should always be previewed first with
`koni rollback <commit-or-ticket> --reason <reason> --dry-run`. It
archives causal graph/ticket/worktree state and publishes a new forward commit;
it never rewinds the integration ref or erases receipts and reports.

## Validation and parity

Validate the immutable profile IR with:

```sh
cargo run -p koni-cli -- validate-profile profiles/research
```

The differential corpus in `reference/parity/` defines normalization and seven
behavior strata. A change to this profile is compatible only when those
normalized lifecycle, state, receipt, and report outcomes remain equivalent or
the profile version and migration policy are intentionally advanced.
