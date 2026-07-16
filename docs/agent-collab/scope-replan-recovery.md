# Scope Replan Recovery Coordination

## Lease — 2026-07-15 (`scope-replan-recovery/root`)

- Exact source lease: `crates/koni-core/src/engine.rs` only, limited to a dedicated structured
  operator `read-scope-repair` event boundary, append-only ticket supplement validation and
  publication, effective worker read-scope/hash derivation, broker-grant/currentness binding, and
  focused in-module core regressions.
- Documentation lease: this mailbox plus append-only coordination entries in
  `docs/AGENT_COLLAB.md`. No product or philosophy document will be rewritten in this lane.
- No Software/Research YAML or TOML, CLI/TUI/token source, live project/run state, worktree,
  process, binary, cmux, or installed artifact is in scope.
- Security contract: ordinary `review-rework` or other prose never grants authority. The only
  accepted transport is event kind `read-scope-repair` with a strictly parsed versioned JSON
  object in `message`, exact event/ticket/step/correction binding, quiescence, one exact normalized
  non-protected non-symlink regular file, and provenance from a configured typed `Path` or
  `list<Path>` field on a node already pinned in the ticket semantic scope. Writes and graph
  authority never expand.
- An accepted supplement remains separate from the compiler-frozen base scope, records base and
  effective hashes plus node/field/event/correction provenance, clears any prior issued context,
  and requires a fresh worker grant whose effective-scope hash is revalidated on every tool call.
  If these invariants cannot be composed safely, the fallback is a durable exact scope-replan
  blocker rather than widening.
- The shared tree is dirty. Preserve all unrelated edits, use a private `CARGO_TARGET_DIR`, and do
  not run a whole-file formatter while another lane owns overlapping ranges.

## Coordination sweep

- Read the central protocol/current live-run transitions and scanned every current persona
  mailbox before claiming this high-overlap file. The prior `recovery-dispatch-audit` lease is
  released and supplies the accepted design constraints. `primary-integrator/root` delegated this
  exact core-only slice and retains all guarded-refresh/live-run authority.
- No active mailbox claims the named supplement/hash symbols. Existing broader `engine.rs`
  histories are released or read-only; this lease avoids their integration/review/publication
  ranges.

## Questions / inbox

- None at claim time. Record cross-lane questions below without rewriting prior entries.

## 2026-07-15 completion — semantic rebind replaces capability supplementation

The initial append-only supplement design above was rejected during implementation because a
ticket-local read addition would leave the semantic graph, compiled proof member, check hashes,
step context, and receipt authority inconsistent. The implemented contract is therefore an
explicit two-action semantic recovery:

1. `read-scope-repair` validates one exact normalized regular file against the source node's typed
   path field, the amendment proof's `covered_paths`, the latest passed-review correction, paused
   quiescence, disjoint write authority, full graph identity, and the retained clean branch/HEAD.
   It changes no scope. It publishes one durable `read-scope-replan-required` blocker using a
   rename-then-atomic-replace lane move, so an initial crash midpoint retains exactly one ticket
   file and recovery converges without duplicate authority.
2. `read-scope-rebind` consumes that exact blocker and recompiles the pinned rule from the exact
   one-field graph amendment. The compiler proves the same deterministic ticket identity, exact
   compiler metadata, unchanged writes, only the named path as new reads, only the named proof
   member's coverage/semantic hash change, and context changes iff compiled inputs changed. It
   preserves lease, review, output, and change-control history; writes a scoped compile receipt;
   and publishes graph, receipt, and ticket through a durable prepared/complete transaction.

Prepared transactions globally quarantine compile/context/grant/review/resume/action authority;
canonical `recover` retains every pre-existing read-only quarantine check but may finish this one
transaction before generic ticket enumeration. Completion becomes immutable history: exact
`steer` retries validate the sealed transaction, owner, full derived-event envelope/payload, and
receipt under the run barrier, then no-op even after legitimate ticket removal, graph/HEAD
progress, or conclusion. Conflicting derived-event slots fail before graph/ticket publication.

Operator shapes (substitute exact IDs/hashes from the blocker):

```text
koni steer --root . --kind read-scope-repair --ticket TK-... \
  --target-node ND-source --target-node ND-proof \
  --message '{"schema_version":"1.0","ticket_id":"TK-...","step_id":"author-historical-baseline","path":"src/exact-seam.ts","source_node_id":"ND-source","source_field":"owned_paths","amend_node_id":"ND-proof","amend_field":"covered_paths","review_id":"...","correction_event_id":"...","correction_event_hash":"sha256:...","reason":"..."}'

koni steer --root . --kind read-scope-rebind --ticket TK-... \
  --target-node ND-proof \
  --message '{"schema_version":"1.0","ticket_id":"TK-...","blocker_request_hash":"sha256:...","blocker_binding_hash":"sha256:..."}'
```

Focused verification in the private target passed `read_scope_` **9/9**, including stale
correction/no mutation, both lane-move crash midpoints, prepared-authority quarantine and recovery,
HEAD drift, completion collision, candidate extra read/write/member rejection, least-privilege
non-inheritance of an unrelated owned path, and exact replay after current ticket removal plus run
conclusion. `cargo clippy --locked -p koni-core --all-targets -- -D warnings` and targeted rustfmt
check are clean.

Residual compatibility edge: the amended graph node is currently saved through canonical
`Graph::save_node`. A legacy graph that stores that node under a noncanonical historical filename
can fail closed on reload with duplicate node identity. The live canonical fixture is unaffected;
future compatibility hardening should atomically replace the single discovered existing node file
instead of deriving a second pathname. Separately, the root-aware filesystem-alias hardening lane
will thread the amendment/write overlap check with the repository root after this source lease is
released.

Lease status: **released / ready for integration**. No live run, profile, TUI, CLI, process,
installed binary, worktree, or cmux state was mutated by this lane.
