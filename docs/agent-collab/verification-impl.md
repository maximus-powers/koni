# Composite Verification Implementation

Owner: `verification_impl/root`

Status: `ready_for_integration` (released)

Last checked: 2026-07-14 (Phoenix)

## Exact released lease

- `crates/koni-core/src/verification.rs` only:
  - optional compiled-member identity on `ComposedVerificationCheck`;
  - compiled graph-check-set expansion in `composed_verification_plan`;
  - focused compatibility, replay-policy, currentness, and duplicate-source tests.
- This mailbox records the handoff. No `engine.rs`, config/state/expression source, bundled profile,
  product documentation, central-ledger, install, or live-run mutation belongs to this lease.

## Implemented contract

- Legacy command plans retain their exact contract-hash tuple, latest-step selection semantics, and
  serialized shape. The new `parent_check_id`, `source_node_id`, and `member_contract_hash` fields
  use serde defaults and serialize only for compiled graph-set members.
- Required workflow steps expand their persisted `compiled_check_sets`. A set must be scheduled by
  the step, still resolve to its configured composite parent, and match the pinned parent hash.
- Each member must still resolve to the exact registered command check and pinned child-check hash.
  Historical children and children with `composed_replay: never` remain causal ticket evidence and
  are not replayed. Replayable children must be `read_only`; unsafe current children fail closed.
- Compiled replay identity is `(ticket_id, source_node_id, child_check_id)`. Distinct proof sources
  sharing one child check remain distinct, while a later required step replaces an earlier member
  with the same identity. Legacy identity remains `(ticket_id, check_id)`.
- A compiled composed contract binds the legacy ticket/target/scope/step context, parent and child
  definitions, compiled-set contract, and exact member contract. `member_contract_hash` therefore
  transitively binds selector/source/argv/cwd/path identity; no separate serialized selection hash
  was added.

## Engine handoff

The runtime owner was given these required call-site constraints:

- A plan row with compiled identity must resolve the exact ticket, step, parent set, source node,
  child check, and member contract, then dispatch only through the internal
  `CheckInvocation::CompiledMember` path. Partial or stale identity must never fall back to public
  dynamic-command resolution.
- Verification receipt projections and receipt origin/member bindings must retain the optional
  parent/source/member identity and validate it against the direct receipt. Legacy rows continue
  through the unchanged legacy execution path.
- The existing contract hash already keeps same-check members collision-safe; optional identities
  should additionally remain visible in projections and diagnostics.

## Verification evidence

- `CARGO_TARGET_DIR=/tmp/koni-verification-impl-target cargo test -p koni-core
  verification::tests --lib -- --nocapture` — 5 passed, 0 failed, 448 filtered.
- `rustfmt --edition 2024 --check crates/koni-core/src/verification.rs` — passed.
- Whitespace/diff check for `crates/koni-core/src/verification.rs` — passed.
- The successful focused build emitted only the parent lane's temporary dead-code warnings for
  not-yet-dispatched `CompiledMember` and `compile_graph_check_sets_for_step`; no verification
  warning or failure remained.

## Questions / blockers

None. The verification slice is released to the compiler owner for engine integration and broader
suite reconciliation.

## Inbox

<!-- Append signed, dated integration questions or findings below. -->
