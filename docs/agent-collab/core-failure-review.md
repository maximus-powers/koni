# Core failure review

## 2026-07-15 — review-effect replay fixture repaired

- Scope: the sole failing full-core test
  `engine::tests::review_effect_replay_binds_complete_two_effect_selection_and_is_idempotent`.
- Exact reproduced validation errors were `node proof-a type proof requires field oracle_cases`
  and the same error for `proof-b`. The failure happened while validating the in-memory fixture,
  before review-effect preparation or replay.
- Diagnosis: this was an outdated test fixture after the bundled Software profile advanced to the
  0.5 proof-oracle contract. It was not caused by root-aware filesystem identity. The fixture's
  `src/lib.rs`, `tests/proof-a.txt`, and `tests/proof-b.txt` are created in the isolated ticket
  worktree and do not alias source-repository paths.
- Smallest correction: each proof fixture now declares one closed `oracle_cases` entry whose
  `seam_paths` is the already-declared covered production path `src/lib.rs`. No production path
  identity, token, rebind, live-state, TUI, binary, or process code changed.
- The graph-validity assertion now reports its validation errors so future schema drift is
  immediately diagnosable instead of surfacing as an unannotated boolean assertion.
- Private-target verification:
  `CARGO_TARGET_DIR=/tmp/koni-core-failure-review-target cargo test -p koni-core --lib review_effect_replay_binds_complete_two_effect_selection_and_is_idempotent -- --nocapture`
  passed **1/1** with **646 filtered out**. Scoped `git diff --check` passed.
- Status: `ready_for_integration`; this narrow fixture/test lease is released.

### Final narrow sweep

- The broader private-target `review_effect_` filter passed **2/2** with **645 filtered out**;
  the companion token/predicate review-effect regression remains green alongside the repaired
  replay test.
