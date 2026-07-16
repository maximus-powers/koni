# Relocation preparation-boundary fixture correction

Owner: `relocation_fixture_regression_fix/root`

## 2026-07-16 10:16 MST — verified and ready for integration

Status: `complete`

This lane owned only
`crates/koni-core/tests/planned_proof_source_relocation.rs` and append-only coordination
documentation. It did not change the relocation implementation, the Software profile, any live
project or run, a binary/runtime asset, process, worktree, ref, fixture outside test-owned temp
directories, or cmux.

### Semantic disposition

The Software proof-preparation change intentionally moved the first conflicting filesystem writer
for a planned focused red-green proof upstream. A new proof whose `source_paths` overlap an already
reviewed preparation now fails while compiling `proof.prepare`; product-only
`change.implement-red-green` is not eligible until that preparation is current. The relocation
action already reproduces the exact failed rule and Journal error, reconstructs its exact
guard-suppressed candidate, moves only path-dependent authority, and recompiles the complete rule
set. Therefore changing the fixture's expected rule from `change.implement-red-green` to
`proof.prepare` is required and preserves the production prepared-source guard.

The provisional one-line rule update was necessary but not sufficient. The first isolated run
passed eight tests and failed only the primary exact-node assertion: full compilation now adds the
compiler-owned unmet `proof.preparation` obligation to the relocated planned proof. The fixture now
requires that exact projection (key, reason, rule, and blocking severity) in addition to the two
authorized semantic changes: `source_paths` and its single resolving command argument. It does not
relax graph equality or ignore extensions.

The fixture now centrally checks every relocated ticket as an exact preparation boundary:

- rule `proof.prepare`, operation `prepare-proof`, and only the planned proof as target;
- only the planned proof as graph-write authority;
- exact ticket read paths `tests/focused-proof.txt` and `src/lib.rs`, with only the focused proof
  source writable;
- one `author-historical-baseline` step with those exact read paths and only that proof source as
  write authority;
- exactly one `baseline-proof-set` member bound to the planned proof, exact focused source,
  `src/lib.rs` covered seam, `tests` working directory, and
  `grep -q corrected focused-proof.txt` command.

That helper runs in the common scenario constructor used by all nine tests. The tracked recovery
assertion also re-runs it against the reconstructed ticket before checking byte-equivalence with
the captured authority. Thus the six durable publication phases—committed request, prepared after
graph publication, graph-published after compilation, compiled after Journal recovery, complete
without event, and complete without checkpoint—retain exact preparation bindings. The separate
pre-H1 partial-action reconstruction and H2 finalization paths retain their existing exact delta,
Journal, event, replay, and checkout assertions.

### Private-target gates

- Initial test after only the provisional rule update: **8 passed / 1 failed**. Exact failure was
  the newly materialized compiler-owned unmet `proof.preparation` projection described above.
- `CARGO_TARGET_DIR=/tmp/koni-relocation-preparation-boundary-target cargo test --locked -p koni-core --test planned_proof_source_relocation -- --nocapture`
  — **9 passed / 0 failed**.
- `CARGO_TARGET_DIR=/tmp/koni-relocation-preparation-boundary-target cargo clippy --locked -p koni-core --test planned_proof_source_relocation -- -D warnings`
  — clean.
- Exact-file Rustfmt and scoped trailing-whitespace scan — clean.
