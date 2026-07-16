# Stale broker-grant recovery audit

Owner: `grant-recovery-audit/root`

Status: `complete — read-only lease released; no existing safe CLI recovery path`

Completed: 2026-07-16 05:18 MST

## Exact lease and safety boundary

- Read-only audit of the safest way to reconcile the two stale, dead,
  revoke-pending Lead broker grants that block the planned-proof source relocation for run
  `019f66a9-df5a-7302-a3e1-00482d37a7ab`.
- Inspected the current Rust recovery/revocation paths, the run-pinned Software action recipe,
  current broker grants and agent records, the current Lead slice, the failed relocation steer
  Journal, the failed full-compile Journal, and CLI help.
- Did not edit Rust, profile/config, product documentation, central registry, binaries, Git refs,
  the acceptance project, the integration checkout, either grant, any Journal/event/transaction,
  process, cockpit, or cmux state. This mailbox is the audit's only write.

## Live evidence observed without mutation

- Run `019f66a9-df5a-7302-a3e1-00482d37a7ab` remains durably paused in
  `/Users/max/Desktop/updog-koni-acceptance-1/.git/koni/runs/019f66a9-df5a-7302-a3e1-00482d37a7ab/orchestration.yaml`:
  `running: false`.
- Grant `grant-019f670d-90b9-7fb1-b4d7-86f7fd9dd529` is a generation-12 Lead
  `wait_workers` grant. Its durable state is `claimed`, `revoke_pending: true`, sequence zero,
  one `wait_worker` reservation at sequence one, and no tool receipt. Its exact agent record is
  terminal `failed` with `authority_busy_stop` / unfinished broker tool diagnostics.
- Grant `grant-019f67bd-2301-7e03-a42f-5c60e14fd5c7` is the same shape for Lead generation 44.
  Its exact agent record is terminal `failed` after stopping without a committed terminal broker
  boundary.
- The four bound runtime/broker PIDs `47823`, `38407`, `41040`, and `40256` produced no row from
  `ps`. The current durable Lead slice is instead yielded generation 64 and bound to a different
  exact agent/process identity. Generations 12 and 44 are therefore historical and superseded,
  not current Lead authority.
- Failed steer Journal `019f6ad3-d40b-7992-a8ff-f4470fe21b15` is `failed` with only completed
  step `0`. In the run-pinned action recipe, steer step zero is `project.validate` and step one is
  `event.append` for `compiler.steering.recorded`. No
  `planned-proof-source-relocation` steering event or relocation transaction exists, so that
  attempt committed no relocation authority.
- Failed compile Journal `019f69e5-e846-74f1-bc47-c4977fa25ec8` is still exactly `failed` with
  the intended prepared-proof source collision diagnostic. That exact failed state is required
  input to the relocation transaction.

## Code-path findings

### Generic recovery does not reconcile these grants

- The live run's pinned recover recipe is only `profile.validate` followed by
  `recovery.dispatch` in
  `config-snapshot/.koni/actions.yaml:6-9`.
- Core dispatches `recovery.dispatch` to `recover_agent_runtime_state` only when the enclosing
  action is `recover`; all other generic compensation dispatch remains unimplemented
  (`crates/koni-core/src/engine.rs:18289-18303`).
- `recover_agent_runtime_state` (`engine.rs:28647-29065`) repairs ticket/agent runtime,
  projections, and recoverable action Journals, but it does not enumerate or reconcile broker
  grants.
- The only restart-time pending-grant reconciler is
  `reconcile_pending_agent_broker_write`. It immediately returns `false` for an in-flight tool
  other than `write_file` (`engine.rs:46502-46525`). `revoke_agent_broker_grant` calls only that
  write-specific reconciler (`engine.rs:46572-46595`). A dead `wait_worker` reservation is thus
  left claimed, revoke-pending, and in flight by every existing public command path.
- Planned-proof relocation correctly rejects every run-owned grant that is not Revoked/Consumed,
  or that still has `revoke_pending` or `in_flight` set
  (`engine.rs:61878-61913`). Process death alone is intentionally insufficient.

### Running `koni recover` now would destroy relocation eligibility

- `acknowledge_recoverable_journals` changes every Failed Journal whose action declares the named
  recovery action to Recovered, without distinguishing the special relocation source Journal
  (`engine.rs:29982-30000`).
- The run-pinned `compile` action declares `recovery: recover`
  (`config-snapshot/.koni/actions.yaml:10-19`). Generic recovery would therefore change
  `019f69e5-e846-74f1-bc47-c4977fa25ec8` from Failed to Recovered while leaving both stale grants
  untouched.
- Planned-proof relocation preview requires its named full-compile Journal to remain exactly a
  Failed `compile` Journal with the current profile/input/error
  (`engine.rs:25172-25190`). Generic recovery before relocation would make the structured request
  stale and invalid.

### The failed steer itself does not need generic recovery first

- Failed and Recovered prior attempts do not block a new exact action attempt; only Running or
  Compensating correlated Journals do (`engine.rs:12720-12772`).
- On an exact successful retry, normal action completion changes every earlier same-action,
  same-profile, same-input Failed attempt to Recovered and records the canonical superseded set
  (`engine.rs:14250-14273`, `engine.rs:51734-51806`). The step-zero failed steer will therefore be
  recovered by the successful relocation steer itself.
- Relocation completion owns recovery of the exact failed compile Journal and accepts only its
  pinned Failed state or the exact derived Recovered state during crash replay
  (`engine.rs:25780-25803`, `engine.rs:26000-26024`).

## Decision

There is **no safe existing CLI command** for the current state. In particular, do not run
`koni recover`, do not manually edit/re-hash grant YAML, do not delete the run, and do not try to
reclaim either dead grant through `agent-mcp`.

The narrow safe implementation is to reconcile only a provably superseded Lead `wait_worker`
reservation from planned-proof relocation quiescence. Under the existing run authority ordering,
try-acquire its operation lock, then acquire its grant lock, re-read and validate the grant, and
clear it only when all of these remain true:

1. the grant belongs to this exact run/profile and is Claimed with `revoke_pending: true`;
2. the one exact in-flight reservation is `wait_worker`, with no response or receipt;
3. the exact durable agent record is terminal and names this grant/input/process identity;
4. both runtime-host and claimed-broker birth identities are dead, with no PID-reuse ambiguity;
5. the current Lead slice is not this grant and has a later generation, proving the old
   `wait_worker` slice can no longer publish current Lead authority; and
6. every lock-time re-read still matches the inspected identities.

Use the existing `clear_agent_broker_tool_reservation_state` transition
(`engine.rs:45775-45792`) so the exact reservation becomes `in_flight: null`,
`revoke_pending: false`, and `state: revoked` atomically under the grant lock. Fail closed for a
busy lock, live/mismatched identity, current generation, response/receipt ambiguity, or any other
tool. Do not generalize this cleanup to `start`, `spawn_worker`, `recover`, `review`, or `finish`:
those tools may have committed a durable effect before receipt persistence.

## Recommended live command sequence after the narrow source fix is verified and installed

Keep the run paused throughout steps 1-4. Let `BIN` be the refreshed isolated acceptance binary
and `INTEGRATION` the existing clean integration checkout.

1. Retry the exact structured relocation steer directly. Do **not** invoke recovery first:

   ```sh
   "$BIN" --run 019f66a9-df5a-7302-a3e1-00482d37a7ab steer \
     --root "$INTEGRATION" \
     --kind planned-proof-source-relocation \
     --message '{"schema_version":"1.0","failed_compile_journal_id":"019f69e5-e846-74f1-bc47-c4977fa25ec8","proof_node_id":"ND-9448d4d9829098f0646c6819","old_source_path":"apps/books/src/pages/companies/[companyId]/home/questionnaire/spiced-framework.test.tsx","new_source_path":"apps/books/src/pages/companies/[companyId]/home/questionnaire/spiced-framework.focused.test.tsx","expected_rule_id":"change.implement-red-green","expected_ticket_id":"TK-5ec6ad45ffe5072b","reason":"Give the still-planned focused six-thread proof an independent whole-file authority boundary while preserving the prepared Sales Notes compatibility proof."}' \
     --ticket TK-63a91afabf98af03 \
     --target-node ND-9448d4d9829098f0646c6819
   ```

2. Verify before any scheduler action:
   both grants are Revoked with no pending/in-flight state; steer Journal `019f6ad3...` is
   Recovered; the relocation transaction is Complete; compile Journal `019f69e5...` is Recovered;
   the planned proof points to only the focused path/argv; the prepared proof/ticket/old source
   remain unchanged; and deterministic ticket `TK-5ec6ad45ffe5072b` exists with only the new source
   authority.
3. Only after the relocation is fully sealed, run unrelated generic runtime recovery:

   ```sh
   "$BIN" --run 019f66a9-df5a-7302-a3e1-00482d37a7ab recover --root "$INTEGRATION"
   ```

4. Follow the returned `recovery_advisory`. If it names the blocked orchestration stage, use the
   exact reported stage ID:

   ```sh
   "$BIN" retry-supervised-stage 019f66a9-df5a-7302-a3e1-00482d37a7ab \
     '<stage_id>' --root "$INTEGRATION"
   ```

5. Resume with `play-run` only after the repaired board, clean integration checkout, and zero
   active-agent boundary are re-verified. Reopen the isolated cockpit after that state is safe.

CLI help from the isolated binary confirms `recover --root ... --run ...`, `steer` with repeated
`--target-node`, and `retry-supervised-stage <ID> <STAGE> --root ...`; global `--run` is accepted
before or after its subcommand.

## Release and handoff

- Read-only audit lease is fully released.
- No open question remains for another read-only reviewer.
- `primary-integrator/root` owns any Rust implementation, focused tests, isolated rebuild, live
  grant reconciliation, relocation retry, post-seal recovery, stage retry, resume, and cockpit
  refresh. This audit does not authorize any of those mutations by itself.
