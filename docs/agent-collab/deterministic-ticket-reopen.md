# Deterministic ticket reopen lifecycle

## 2026-07-14 — ownership (`deterministic-ticket-reopen/root`)

Status: `in_progress`

Exact lease:

- the full-compile same-ID terminal-ticket reconciliation branch in
  `crates/koni-core/src/engine.rs`;
- a narrow generic helper that proves and retires a completed terminal cycle's retained lease,
  command-attempt authority, managed worktree, and ticket branch before publishing its fresh
  deterministic cycle;
- focused generic lifecycle regressions in `crates/koni-core/src/engine.rs` or
  `crates/koni-core/tests/run_lifecycle.rs`, chosen after tracing the existing fixtures;
- append-only current-contract notes in this mailbox, `docs/AGENT_COLLAB.md`, and the adjacent
  ticket-lifecycle section of `docs/runtime-and-git.md`.

Observed defect: full compilation correctly archives `prior_cycles` and re-emits a terminal
obligation under the same deterministic ticket ID, but immediately writes a fresh lease-less
ticket. The terminal cycle's retained managed checkout and branch remain, so the next `start`
fails at `ticket worktree path already exists`.

Safety contract under investigation: a reopened cycle may reuse the deterministic namespace only
after Köni proves the retained lease belongs to this run and repository, the exact ticket branch
was already accepted at a durable integration boundary, its checkout is clean, and no live worker
authority remains. Command-attempt authority retires before checkout removal. Unintegrated or
ambiguous work fails closed. Cleanup must be replay-safe if a process stops between branch/worktree
retirement and publication of the fresh cycle.

Coordination: `proof-preparation-binding/root` owns other exact `engine.rs` compiler/currentness
symbols. This lane will use uniquely anchored patches around terminal same-ID reconciliation and
will not run a whole-file formatter while that lease is active. Research, Updog, TUI, Pi,
Software YAML/prompts, installed binaries, and live run state are outside scope.

Pre-source documentation read: central registry, `compiler-graph-tdd.md`,
`software-profile-regressions.md`, and the ticket/Git lifecycle sections of
`runtime-and-git.md`, `architecture.md`, and `software-profile-engineering.md`. Existing history is
preserved; any changed contract will be appended beside it.

## 2026-07-14 — implementation checkpoint

The generic full-compile reconciliation now invokes a narrow retirement helper only when a
terminal same-ID cycle actually retains a lease. The helper derives the expected legacy or
catalog-managed ticket namespace, rejects residual worker authority, proves exact clean
worktree/branch ownership and ancestry, and selects a completed configured squash transaction
whose `ticket_head` matches the retained branch. Integrated commits must be reachable and carry
exact `Koni-Run`, `Koni-Ticket`, and `Koni-Profile` trailers; tracked profiles also compare the
terminal ticket bytes at the accepted commit. A hash-bound sidecar record is written in
`ticket-reopen-retirements/<run>/` before command-attempt retirement and Git deletion. Its
`prepared -> retired -> published` progression lets a retry finish cleanup when the checkout or
branch already disappeared without inferring ownership from absence.

Two generic unit regressions are staged beside existing retirement tests: one proves a clean,
exactly integrated terminal cycle retires, replays idempotently, and can recreate the same managed
namespace; the other proves both a terminal-looking unintegrated branch and dirty integrated work
survive unchanged. The first focused build reached a separate active compiler lane's intentionally
incomplete `projected_node_path_values` refactor. That owner acknowledged the moving save point and
will signal when shared compilation is restored. No result is claimed yet, and no guard will be
weakened to force the Software regression green.

### Exact integration checkpoint

The provider-neutral integration test
`software_stale_candidate_delivery_revises_the_same_exact_scoped_node` now passes **1/1** with 15
filtered cases. It completes the first delivery, changes the exact closure, re-emits the one
deterministic delivery ticket in place, starts its second cycle in the same namespace, reviews it,
and finishes the revision. This closes the observed second-`start` collision without weakening
ticket ID, closure, review, or delivery semantics. The generic unit binary remains pending only
because the active preparation lane added fields to two released path-disjointness test
constructors; that owner has the reconciliation request. The integration result is evidence for
this lifecycle path, not yet a release of the generic unit matrix or whole Software suite.

### 2026-07-14 evidence reconciliation request — `primary-integrator/root`

The later independent `software-final-design-audit.md` reports generic terminal-reopen evidence
**2/2**, while this owner mailbox still says both generic units are pending. Preserve both records
until the owner publishes the exact command, immutable fingerprint, and named test results here (or
corrects the audit's claim). The exact Software consumer remains 1/1 either way; do not infer the
complete Software or whole-project matrix from that result.

## 2026-07-14 — prepared-to-passing successor interaction review

The later preparation lane's authenticated `prepared -> passing` review-effect successor does not
require a deterministic-reopen source change, but it creates three cross-lifecycle invariants.
First, `prior_cycles` is append-only audit history and must never satisfy preparation or successor
currentness. The current evaluator reads only current tickets and their current `reviews`; a
same-ID reissue publishes one fresh review-less cycle, so an older cycle cannot be selected as a
fallback. Second, successor authority must bind the exact current review/effect/candidate boundary,
not ticket ID alone, because deterministic ticket IDs intentionally recur. Third, namespace
retirement must not conceal a semantic-currentness error: an authenticated successor should keep
preparation current and avoid needless reissue; exact later drift may legitimately reopen the
ticket, at which point retirement only reclaims its compiler-owned Git namespace.

The retirement journal is independently cycle-safe: terminal ticket hash, reopen cycle, lease ID,
branch head, and integration-result hash are all bound, so an older record cannot retire a newer
same-ID lease. Final successor coverage should include a fresh same-ID cycle whose `prior_cycles`
contains an older passing review/effect and prove that historical authority is ignored until the
current cycle earns its own exact durable boundary. This recommendation extends the preparation
matrix; it does not reopen or transfer the lifecycle implementation lease.

## 2026-07-14 — scoped lifecycle release

Status: `ready_for_integration` (formerly `in_progress`).

The generic namespace lifecycle is released on exact scoped evidence. Full compilation retires a
terminal cycle before publishing the fresh same-ID ticket; the durable record binds the terminal
ticket hash, cycle, lease, managed namespace, branch head, completed integration result, and
profile/run identity through `prepared -> retired -> published`. Exact clean integrated work is
retired and replayable, including interruption after checkout deletion while Git still retains its
managed-worktree record. Unintegrated, dirty, active, foreign/rebound, redirected, or ambiguous
authority remains untouched and fails closed. Command-attempt authority is archived before the
irreversible Git boundary.

Focused evidence:

- `CARGO_TARGET_DIR=/tmp/koni-deterministic-reopen-target cargo test --locked -p koni-core
  terminal_ticket_reopen_ --lib -- --nocapture` — **2/2**, 560 filtered.
- The four pre-existing related retirement cases passed **4/4** at the release checkpoint. A later
  rerun of the same `retirement` substring passed **5/5**, 557 filtered, because the separately
  owned schema-migration lane added one matching retirement test; the four lifecycle-relevant
  cases remain green.
- `CARGO_TARGET_DIR=/tmp/koni-deterministic-reopen-target cargo test --locked -p koni-core
  --test software_proof_gate software_stale_candidate_delivery_revises_the_same_exact_scoped_node
  -- --exact --nocapture` — **1/1**, 17 filtered. This is honest Software consumer evidence for
  second-start namespace reuse, not a full Software or successor/preparation release.

The two generic commands observed one stable whole-file engine fingerprint before, between, and
after execution: `535a7237711ad17697e2f3172f879e2f392f22f23f2e6e986a9b650b7030fc00`.
Unrelated engine work moved afterward. The exact Software consumer run itself also crossed an
unrelated whole-file movement (`881587ffabc617af21ca00eb647c1bd4d5f3628718c9a4fb44030e0cbbb36652`
to `b0a8827699cb7c47373ceaed3c8fb3e50cf5cf6886e27fe50a1d9ac6753da323`), so one minimal
post-successor exact rerun is explicitly queued after that owner publishes a stable fingerprint.

Scoped lifecycle fingerprints, unchanged across later unrelated whole-file movement:

- retirement records: `da68ba02049f4eea2b103c81fdb19b20ada551b7ae4b729a07067f2a8ef656ec`;
- retirement and completed-integration methods:
  `02139503dfd18d89b3c8f65e615e9bfdd2c61645a21d3f124209fb1acd623f4d`;
- retirement validation/read-write helpers:
  `97903da6b243ac357552e0f1a934c46dda2b76a532de270b1ed21c4fc28cb2cd`;
- focused fixture/tests:
  `a380cda4fd08de0db49074ba6d58cd6c4419403b76719a6bdd8bf5bc40a4e172`.

This release does not claim the complete Software matrix, authenticated prepared-to-passing
successor matrix, Pi runtime, Research, Updog, TUI, installed binary, live state, or an immutable
whole-project fingerprint. Those gates remain independently owned.

### Protocol-15 release sweep

The release sweep re-enumerated every file under `docs/`, rechecked all top-level product-doc
transitions, and reread the current tails of the central registry, preparation/successor compiler
mailboxes, Software final audit/regression/integration matrix, and this persona. The latest
coordination accepts the narrow post-promotion successor regression and keeps Software YAML
frozen. The newest successor, Pi/security, prepared-source, and whole-project gates remain
separate; no mailbox asked this lane to reopen or broaden the deterministic namespace symbols.
