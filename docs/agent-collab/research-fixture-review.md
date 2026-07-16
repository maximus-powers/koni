# Research Runtime Fixture Reconciliation Review

Owner: `research_fixture_review/root`

Status: `complete` (independent read-only semantic/source-scope review; **accepted**)

Last checked: 2026-07-14 (Phoenix)

## Mission and boundary

Independently review only the reconciled bodies of these three `engine.rs` unit fixtures:

- `configured_run_step_executes_and_writes_its_runtime_receipt`
- `scientific_measurements_artifacts_and_receipt_integrity_are_bound`
- `changed_scientific_input_makes_current_receipt_false_and_reopens_run_work`

The review checks the exact argv contracts, check/receipt expectations, and separation between
historical causal execution evidence and automatic composed integrity replay. This lane owns only
this mailbox and a signed append-only verdict in `research-fixture-audit.md`. It does not own or
edit Rust, profiles, templates, product documentation, the central registry, the installed
binary, cmux, Updog, or live/forensic state.

## Prerequisite sweep

- Read the complete collaboration registry and every current persona mailbox, including the
  context release and the original fixture audit, before inspecting source.
- Reviewed the broader top-level documentation record so this verdict uses the current Research
  receipt and replay model rather than an obsolete one-check contract.
- Reviewed the intentionally dirty tree without reset, checkout, formatting, installation, or
  live-state action.

## Findings

No P0/P1 correctness or scope finding remains.

### Exact scientific-input argv coverage

Every reconciled contract has a distinct integrity command of the form `python3 -c <reader> ...`;
it is not the side-effecting empirical command. Every declared `scientific_inputs[*].path` is a
separate exact argv item:

| Fixture | Declared scientific inputs | Integrity argv path items |
| --- | --- | --- |
| configured step | `inputs/runner.py`, `inputs/data.txt` | `inputs/runner.py`, `inputs/data.txt` |
| measurement/artifact integrity | `inputs/runner.py`, `inputs/data.txt` | `inputs/runner.py`, `inputs/data.txt` |
| changed input | `inputs/data.txt` | `inputs/data.txt` |

The changed-input fixture intentionally does not add `inputs/runner.py` to the scientific-input
set merely because the empirical command executes that file. The test's causal variable is the
one declared scientific input, and the exact argv mirrors that contract.

### Check and receipt semantics

- The configured workflow assertion requires `scientific-runtime` followed by
  `scientific-result-integrity`.
- That fixture executes both checks, proves `runtime.receipt` and
  `runtime.integrity-receipt` are persisted and passing with unchanged input bindings, requires
  both receipt types in synthetic acceptance, lists both validation checks in workflow order, and
  binds both persisted receipt IDs to the accepted output.
- Its downgrade loop remains deliberately about the causal `scientific-runtime` receipt. A valid
  integrity receipt does not mask missing provenance or stale causal runtime evidence.
- The measurement/artifact fixture remains focused on typed result, artifact-manifest, result-file,
  and historical runtime-receipt integrity. It only adds the contract field needed to make the
  run-emission predicate eligible; it does not manufacture or substitute a composed-replay
  receipt.
- The changed-input fixture still proves a current causal runtime receipt before the file write
  and reopens the same work after that declared input changes. It does not execute the integrity
  check or make that check the re-emission authority.

This preserves the released authority map: `scientific-runtime` is historical causal execution
evidence; `scientific-result-integrity` is the distinct read-only automatic replay obligation;
`ticket.run-experiment` currentness continues to key on the causal `runtime.receipt`.

### Source-scope verdict

The reconciliation itself is test-only. Comparison of the three historical/current bodies shows
the intended fixture literals and expectations only: the two focused currentness fixtures add
only `composed_verification_command`, while the configured-step fixture adds its dual-check,
dual-receipt execution and acceptance assertions. Shared `Step` shape fields visible in the
current body belong to already-present concurrent core evolution. No production helper, verifier
selector, rule, check definition, Research profile, or template change is required by or included
in this reconciliation. Unrelated production diffs elsewhere in the shared dirty tree are outside
this verdict and are not attributed to this patch.

## Verification and verdict

**ACCEPTED / ready for integration.** The reviewed bodies implement the exact plan in
`research-fixture-audit.md` without weakening causal currentness or replay safety.

The primary integration checkpoint already records:

- three exact fixture regressions: 3 passed;
- Research result contracts: 3 passed;
- exact safe composed-replay selector: 1 passed;
- full `koni-core --lib`: 438 passed, 0 failed, 3 intentionally ignored.

An additional private-target exact rerun was started only after the source review, but it first
queued behind another agent's Cargo build lock. At the primary integrator's request it was stopped
before contending further; this verdict therefore relies on independent source semantics plus the
already-recorded green execution evidence rather than claiming a second completed run. The stopped
process wrote only isolated `/tmp` build artifacts. No repository source, installed binary,
profile, cockpit, cmux surface, Updog checkout, or run state changed.
