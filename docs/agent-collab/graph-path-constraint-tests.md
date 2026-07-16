# Graph Path Constraint Tests

Owner: `graph-path-constraint-tests/root`

Status: `ready_for_integration` — all six focused integration tests pass; implementation sources
remain owned by `primary-integrator/root`.

Last checked: 2026-07-16 America/Phoenix

## Exact lease

- Add one dedicated integration-test file:
  `crates/koni-core/tests/graph_path_constraints.rs`.
- Exercise the proposed generic `graph_constraints` declaration with
  `kind: path_sets_disjoint`, `left`/`right` selectors, configured node types and path fields, and
  `distinct_nodes`.
- Cover exact path overlap, ancestor/descendant overlap, disjoint success, same-node exclusion,
  fail-closed selector/type mismatch, and filesystem aliases where the public fixture can express
  them safely.
- Append-only coordination notes in this mailbox and `docs/AGENT_COLLAB.md`.
- Do **not** edit `config.rs`, `engine.rs`, profile templates, live state, installed projects,
  binaries, or running processes.

## Expected contract

- A configured path set is selected semantically from graph nodes, then read from the named list
  field as normalized, project-relative path authority.
- Two selected values overlap when they are equal or one path contains the other; live filesystem
  identity must also reject symlink/hardlink aliases consistently with the engine's shared path
  comparator.
- `distinct_nodes: true` excludes only a node's comparison with itself. It must not allow two
  different nodes to share authority.
- A selector whose declared `node_types` do not cover what it can actually return fails closed at
  profile/config validation rather than silently ignoring the undeclared node type.

## Coordination log

- 2026-07-16 — Read the central registry and the existing graph-check-set and Software integration
  fixture shapes. This lane is intentionally test-only and will tolerate an expectation-first
  compile failure until the parent lands the public config types.
- 2026-07-16 — Reconciled the fixture against the landed public IR. The selector/type mismatch is
  exercised at the durable graph boundary so both statically provable and runtime-discovered
  undeclared types may fail closed. The filesystem case separately proves hardlink identity and
  symlink ambiguity/identity; a symlink may be diagnosed as a concrete conflict or an unsafe
  comparison, but it may never compile.
- 2026-07-16 — `proof-source-profile/root` confirmed the bundled Software constraints use IDs
  `preparation-proof-source-paths-pairwise-disjoint` and
  `preparation-and-implementation-proof-source-paths-disjoint`. That lane owns Software assertions;
  this lane remains the generic engine fixture and does not duplicate profile tests.

## Verification

- `rustfmt --edition 2024 --check crates/koni-core/tests/graph_path_constraints.rs` — clean.
- `git diff --check -- crates/koni-core/tests/graph_path_constraints.rs
  docs/agent-collab/graph-path-constraint-tests.md docs/AGENT_COLLAB.md` — clean at the test handoff
  checkpoint.
- `CARGO_TARGET_DIR=/tmp/koni-graph-path-constraint-tests-target cargo test --locked -p koni-core
  --test graph_path_constraints -- --nocapture` — **6 passed**, 0 failed. Coverage is exact overlap,
  ancestor/descendant overlap, disjoint success, same-node exclusion under `distinct_nodes`,
  fail-closed selector/type mismatch, and real hardlink/symlink aliases under a temporary project
  root.
- `CARGO_TARGET_DIR=/tmp/koni-graph-path-constraint-tests-target cargo clippy --locked -p
  koni-core --test graph_path_constraints -- -D warnings` — clean.

No config/compiler/profile/live-state/binary/installed-project/process file was edited by this lane.
