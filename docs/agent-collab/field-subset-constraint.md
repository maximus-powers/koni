# Generic field subset constraint

## 2026-07-15 — active bounded lease (`field-subset-constraint/root`)

- Status: `in_progress`.
- Exact source lease: `FieldDef` and recursive node-field-definition validation in
  `crates/koni-core/src/config.rs`; the `field_type_matches` / `validate_field_value` validator
  range and focused in-module tests in `crates/koni-core/src/engine.rs`.
- Documentation lease: this append-only mailbox plus one append-only coordination row in
  `docs/AGENT_COLLAB.md`.
- Explicit exclusions: no Software/Research profile or fixture YAML, TUI, broker grant,
  read-scope repair/recovery, live project/run state, worktree, process, binary, or cockpit.
- Contract: a list-valued field at any recursive object/list-item depth may declare
  `subset_of: <root-node-field>`. Profile compilation requires a valid declared root-node list
  with the same configured scalar item type (`string` or `path`). Node validation checks every
  concrete nested list instance before rule/ticket dispatch, using exact string identity or
  lexical project-relative path normalization, and names the node, concrete field instance, and
  configured superset field in failures.
- Compatibility: omission preserves the existing serialized profile and graph behavior. The
  primitive is generic and contains no Software/proof/oracle type or field names.

## Coordination

- `scope-replan-recovery/root` was asked to avoid only the exact engine field-validator range;
  this lane will not touch its supplement, grant, hash, recovery, or event symbols.
- `proof-oracle-contract/root` was given the typed YAML shape and retains exclusive ownership of
  all profile wiring and Software regressions.

## Questions / inbox

- None at claim time. Append coordination questions without rewriting prior entries.

## 2026-07-15 — implementation complete; lease released

- Status: `ready_for_integration`. The exact config validator, graph field-validator, safe-schema
  projection, and focused-test symbols named above are released to `primary-integrator/root`.
- `FieldDef.subset_of` is serde-defaulted and omitted when absent, so existing profile
  serialization remains unchanged. A declaration compiles only when the constrained field and
  same-root reference are lists whose item types match exactly and are either `string` or `path`.
  Invalid syntax, undeclared references, non-list fields, missing scalar item declarations, and
  incompatible item types fail profile compilation with the recursive configured field shape.
- Graph validation applies the constraint to every concrete nested instance before ticket
  evaluation. Strings use exact identity without echoing arbitrary missing values. Paths use
  canonical project-relative lexical identity, report the concrete indexed field and referenced
  root field, and include at most eight sorted normalized missing paths.
- The broker-safe projection exposes only an allowlisted node type, normalized schema shape such
  as `oracle_cases[].seam_paths`, the allowlisted root-field shape, and at most eight canonical
  project-relative paths. Node IDs, arbitrary string values, absolute/parent/control/backslash or
  oversized paths, excess arrays, and malformed diagnostic tails never cross that boundary.
- The primitive contains no Software, proof, or oracle type/field special case. Profile wiring
  remains exclusively owned by `proof-oracle-contract/root`; old-run recovery/grants remain
  exclusively owned by `scope-replan-recovery/root`.

### Verification

- `CARGO_TARGET_DIR=/tmp/koni-field-subset-target cargo test -p koni-core subset --lib -- --nocapture`
  — **5 passed / 0 failed**.
- `CARGO_TARGET_DIR=/tmp/koni-field-subset-target cargo test -p koni-core config::tests --lib -- --nocapture`
  — **69 passed / 0 failed**.
- `CARGO_TARGET_DIR=/tmp/koni-field-subset-target cargo test -p koni-core broker_safe_ --lib -- --nocapture`
  — **3 passed / 0 failed**.
- `CARGO_TARGET_DIR=/tmp/koni-field-subset-target cargo clippy -p koni-core --lib -- -D warnings`
  — passed.
- `rustfmt --edition 2024 --check crates/koni-core/src/config.rs` and scoped `git diff --check`
  — passed. A read-only whole-engine formatter check reports only the still-owned
  `scope-replan-recovery` ranges and no hunk in this released lane; this lane did not format or
  modify those concurrent ranges.
- Final handoff sweep re-read the central registry plus the current primary-integrator,
  proof-oracle, recovery-dispatch, scope-replan, token-display, and Software-profile evolution
  notes. No unanswered cross-lane question or contract conflict remains.
