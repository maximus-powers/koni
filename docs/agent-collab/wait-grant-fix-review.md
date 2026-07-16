# Stale `wait_worker` reconciliation security review

- Owner: `wait-grant-fix-review/root`
- Status: `complete — read-only lease released`
- Completed: 2026-07-16 MST
- Reviewed source fingerprint: `crates/koni-core/src/engine.rs`
  `sha256:406dc99acd72a3a99911daf82e59b72f992df3aa27f58507aa06dab009613289`

## Exact lease

Read-only adversarial review of the narrow stale Lead `wait_worker` reconciliation added in
`crates/koni-core/src/engine.rs`, including its exact state predicate, lock ordering,
agent/process/slice history binding, response/receipt ambiguity handling, and its invocation from
planned-proof source-relocation quiescence.

This lane did not edit Rust, tests, profiles, binaries, installed tools, live run state, product
worktrees, Git refs, processes, or cockpit/cmux surfaces. This mailbox is its only write.

## Disposition

**P0: none. P1: none.**

The reviewed cleanup is safe for its intended release boundary:

- Relocation already owns the exact run-authority barrier and compiler lock before invoking
  quiescence. The reconciler then **try-acquires** the grant's operation lock before taking its
  grant lock (`engine.rs:46658-46664`). This avoids deadlock with normal broker execution, whose
  order begins with the operation lock and later enters the run barrier. A busy operation remains
  untouched and the subsequent all-grant scan keeps relocation blocked.
- The lock-time grant is re-read and must retain the bootstrap hash and the full exact predicate
  (`engine.rs:46664-46673`). The predicate binds the same run, Lead generation/boundary, raw agent
  ID, attempt, input hash, working directory, runtime-host identity, broker identity, and archived
  slice; it additionally requires a terminal failed agent, a later yielded current slice, and both
  exact birth identities to be dead (`engine.rs:46704-46743`).
- Broker state is restricted to Claimed plus `revoke_pending`, sequence zero, no receipts, and one
  sequence-one `wait_worker` reservation with the canonical operation key and no write intent
  (`engine.rs:46714-46721`). No other Lead or worker tool can enter this recovery path.
- The operation lock closes the response-check/write race. Any durable response at the reserved
  sequence—including a malformed/truncated response, which fails parsing—keeps the grant
  quarantined. Only an absent response permits the existing exact reservation transition to clear
  `in_flight`, clear `revoke_pending`, and set Revoked (`engine.rs:46675-46691`,
  `engine.rs:45775-45792`).
- The mutation is confined to the obsolete broker grant. It does not invoke generic recovery,
  acknowledge either the failed steer Journal or the exact failed compile Journal, append a
  steering/relocation event, alter graph or ticket state, or touch Git. The failed compile evidence
  required by relocation therefore remains intact. Partial cleanup followed by another grant's
  fail-closed rejection is also safe because every cleared grant independently satisfies the same
  terminal/superseded proof.
- The positive focused regression also proves response-present quarantine and the exact terminal
  state change (`engine.rs:93763-93840`). The integration owner separately reported the focused and
  full release gates green; this review did not rerun them.

## P2 follow-ups (nonblocking)

1. **Regression breadth.** The focused unit covers the exact success case and a response-present
   ambiguity, but not an operation-lock-busy case, idempotent second invocation, or a table of
   individual identity/history mismatches (live runtime, live broker, wrong attempt/input/grant,
   current or non-yielded generation, nonempty receipt, wrong tool). The predicate is fail-closed
   in source, so this is a defense-in-depth test gap rather than a release blocker.
2. **Recovery provenance.** Clearing the reservation intentionally removes its request hash and
   start timestamp from the mutable grant without appending a distinct reconciliation receipt.
   The terminal agent record, grant identity/tool diagnostic, final Revoked state, integrity hash,
   and updated timestamp remain, so authority and compile evidence are not ambiguous. A future
   auditability pass could preserve an explicit compiler-authored recovery reason/history record
   without coupling that enhancement to the live relocation repair.

## Release

The read-only review lease is released. There is no security finding that blocks the isolated
binary refresh or the guarded, still-paused relocation retry described by `primary-integrator/root`.
