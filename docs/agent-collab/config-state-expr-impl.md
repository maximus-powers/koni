# Config / State / Expression Implementation

Owner: `config-state-expr-impl/root`

Status: `released` (implementation and focused verification complete 2026-07-14)

Last checked: 2026-07-14 America/Phoenix

## Exact lease

- `crates/koni-core/src/config.rs`: `CheckDef.graph_set`, `GraphCheckSetDef`,
  `WorkflowStepDef.preserve_source_paths_from`, graph-set/profile validation helpers, and focused
  configuration tests.
- `crates/koni-core/src/state.rs`: `CompiledCheckSet`, `CompiledCheckMember`, optional persisted
  `Step.compiled_check_sets`, optional `Step.preserve_source_paths_from`, and focused state tests.
- `crates/koni-core/src/expr.rs`: `PredicateOp::CheckHasCurrentTerminal`, validation and check
  reference tracking, and focused expression tests.
- This mailbox records the completed slice. Generic engine execution/currentness and composed
  verification remain owned by `compiler-graph-tdd/root`; bundled Software wiring remains owned by
  `software-default-design/root`.

All Rust symbols above are released for integration. This persona will not make further edits
without a new exact-symbol claim and handoff.

## Implemented interface

`CheckDef.graph_set` is an optional, serialization-skipped contract available only on
`kind: composite`. A composite check must configure it; every other check kind must omit it. Its
typed fields are:

- target-anchored `members: Selector`;
- nonempty `member_node_types`;
- exactly one of literal `member_check` or typed `member_check_field`;
- distinct `source_paths_field` and `covered_paths_field`, each declared as `list<path>` on every
  member type;
- optional `working_directory_field`, declared as `path`;
- optional inclusive/exclusive status filters; and
- positive `min_members` plus an optional `max_members` no smaller than the minimum.

Executable selectors accept only finite positive traversals rooted canonically at `$target`, plus
anchored set composition. Every traversed relation must be explicit, unique, and present in the
configured canonical/inverse relation vocabulary. Global node/query/ID/policy roots fail profile
compilation.

Literal child IDs must resolve to registered read-only command checks. A
`member_check_field` must be a string field with a nonempty enum; every enum value must resolve to
a registered read-only command check. Child operation applicability must cover every parent
composite operation.

`WorkflowStepDef.preserve_source_paths_from` and its persisted `Step` counterpart name a transitive
dependency. Static validation requires exactly one graph-set check on each side and compatible
selector/source contracts. Expected-red and green child check IDs are intentionally excluded from
the preservation identity: runtime matches the source node and resolved argv/cwd/source-path basis,
so differently classified child checks can prove an unchanged test source.

The persisted DTOs are:

- `CompiledCheckSet`: schema version, parent check ID/hash, selector hash, ordered anchor nodes,
  anchor semantic hashes, selection hash, ordered members, and set contract hash.
- `CompiledCheckMember`: source node ID/type/semantic hash, child check ID/hash, exact argv,
  repository-relative working directory, normalized `source_paths` / `covered_paths`, and member
  contract hash.

Both DTOs deny unknown fields and derive exact equality. Empty `Step.compiled_check_sets` and absent
source preservation serialize away.

`check_has_current_terminal` requires a subject, parent check ID, and a nonempty unique status list
drawn from `failed`, `timed_out`, and `invalid_result`. It participates in the same recursive check
reference tracking as `check_passed`, so unknown rule references fail profile compilation.

## Compatibility decisions

- Omitted `graph_set`, absent `preserve_source_paths_from`, and empty persisted compiled sets retain
  legacy serialization and profile-hash behavior.
- Existing Command/Graph checks and pinned Research/Updog workflows remain opt-in and unchanged.
- Dynamic check fields require a closed enum rather than deferring an unbounded registry reference
  to runtime.
- Source paths and covered product paths remain separate typed facts. Covered paths do not grant
  write authority and are not used to discover tests.
- The config layer validates target anchoring and completeness independently of model-facing context
  budgets.

## Verification evidence

- `CARGO_TARGET_DIR=/tmp/koni-compiler-graph-tdd-target cargo test -p koni-core config::tests --lib
  -- --nocapture` — 59 passed, 0 failed.
- `CARGO_TARGET_DIR=/tmp/koni-compiler-graph-tdd-target cargo test -p koni-core state::tests --lib
  -- --nocapture` — 15 passed, 0 failed.
- `CARGO_TARGET_DIR=/tmp/koni-compiler-graph-tdd-target cargo test -p koni-core expr::tests --lib
  -- --nocapture` — 5 passed, 0 failed.
- `rustfmt --edition 2024 --check crates/koni-core/src/config.rs
  crates/koni-core/src/state.rs crates/koni-core/src/expr.rs` — clean.
- `git diff --check -- crates/koni-core/src/config.rs crates/koni-core/src/state.rs
  crates/koni-core/src/expr.rs` — clean.

## Inbox / handoff

Other agents may append dated integration questions below. Reopen this lease only for a concrete
config/state/expression defect and name the exact overlapping symbols before editing.
