# Product Documentation Scan Mailbox

- Owner: `/root/docs_history_audit/product_docs_scan`
- Status: `complete` (read-only audit; findings handed off 2026-07-14)
- Lease: read-only audit of the twelve named top-level product documents under `docs/`; sole editable file is this mailbox; started 2026-07-14

## Mission and boundary

Read every assigned product document, compare current contracts with retained history, and report
silent replacements or handoff-invalidating contradictions with exact file-and-line evidence.
This lane will not edit product documentation, source, profiles, templates, tests, the central
registry, binaries, Git state, or live-run state.

## Evidence and verdict

Signed verdict — `/root/docs_history_audit/product_docs_scan`, 2026-07-14:

Read all twelve assigned product documents in full and re-read the current moving ranges before
handoff. `runtime-and-git.md:181-188` now contains the required adjacent context-delivery
transition, so the earlier context-first documentation concern is closed and is not reported
below. The current TUI authority changes (Evidence, Plan/Graph Seed, adaptive approval, Details,
Objective, Configure save/publish, keys) likewise retain adjacent dated history.

### Handoff blockers / stale current claims

1. **Software 0.4 is simultaneously “shipping” and not release-complete.**
   `configuration.md:78-83` says Software 0.4 “ships” the two intent presets, and
   `configuration.md:374-381` describes its conditional delivery behavior as current. In contrast,
   `maturity.md:138-143` says to exercise it only *after* it lands, while
   `software-profile-engineering.md:3-23` calls it an accepted evolution and
   `software-profile-engineering.md:541-550` says end-to-end coverage is only 3/5. Treat the
   Configuration wording as premature shipping language until the Software lane releases; retain
   it beside an adjacent dated in-progress/completion status rather than normalizing all docs to
   present tense.

2. **The generic graph-set compiler is documented as completed before its active adversarial gate
   is released.** `configuration.md:852-865` moves directly from “is adding” to “implementation
   completed,” and `configuration.md:890-935` plus `philosophy.md:196-216` state exact selection,
   source preservation, and composed-replay guarantees as current. The current active engine
   review still has unreleased execution-binding/path-authority findings; in particular the source
   comparison remains outside the command's exact pre-execution binding even though
   `philosophy.md:212-214` says it happens “immediately before green execution.” The multi-anchor
   source changed after that review, but no independent re-release exists yet. This must be labeled
   transition-in-progress (or receive a dated completion only after re-review), not shipped as a
   fully closed compiler contract.

3. **The Configuration manifest example contradicts both old and new Software roots.**
   `configuration.md:393-410` labels the sample `profile.id: software` but gives version `1.0.0`,
   “Architecture-first,” `root_node_type: project`, `goal_field: goal`, and a project seed
   operation. The same file's Software contract starts at `objective`
   (`configuration.md:358-381`), and the retained Software history is 0.3 -> accepted 0.4
   (`software-profile-engineering.md:8-23`). Mark the block explicitly illustrative/legacy or align
   it with an authoritative baseline; as written, it is unsafe copy/paste guidance.

4. **The TUI guide creates the permanent run namespace too early.**
   `control-center.md:177-181` says planning pins the target and “creates an isolated run branch and
   worktree.” `runtime-and-git.md:24-34`, `architecture.md:112-127`, and
   `getting-started.md:139-142` say planning uses a detached worktree and approval creates the
   permanent run branch/worktree. The adjacent Run-base history note at
   `control-center.md:183-188` explains target selection but does not correct this timing conflict.

5. **Architecture still carries the displaced base-only planning model without an adjacent
   transition.** `architecture.md:103-109` says Plan merely “resolve[s] base commit,” while the
   authoritative target-bound transition is in `runtime-and-git.md:258-265`. Add the selected
   target ref plus observed base to the architecture lifecycle and preserve the base-only phrase in
   an adjacent dated transition note.

### Remaining append-history gaps

6. `configuration.md:745-774` introduces compiler-enforced
   `graph_mutation: forbidden|allowed|required` (with `allowed` as compatibility behavior) without
   an adjacent dated transition from the earlier implicit/prompt-only workflow boundary.
   `configuration.md:794-799` similarly changes the command contract to configured accepted exit
   sets, including intentional nonzero expected-red outcomes, without adjacent history. These are
   meaningful compiler/Software proof-authority changes, not merely prose polish; retain the
   compatible earlier behavior beside dated evolution notes.

7. `tui-cleanup-backlog.md:311-314` still calls 288/288 the “latest” shared TUI run and says the
   final rerun is pending, while the current integration registry records a later 292/292 shared
   checkpoint. Preserve 288/288 as history and append the later verification state so handoff does
   not reopen a completed TUI gate.

No edits were made outside this mailbox. No test, binary, Git, cockpit, cmux, Updog, or live-run
state was changed.
