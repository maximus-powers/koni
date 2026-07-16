# Documentation Release Audit

Owner: `docs-release-audit/root`

Status: `complete` (read-only release-state and decision-history audit)

Last checked: 2026-07-14 16:16 Phoenix

## Mission and safety boundary

Audit every top-level file in `docs/` against the complete collaboration registry and every
current persona mailbox. Identify implementation transitions that are already released but still
documented as pending, and identify meaningful replacement contracts that lack an adjacent dated
history note.

This lane owns only this mailbox. It did not edit product documentation, the central registry,
Rust, profiles, templates, tests, the installed binary, cmux, Updog, or any live-run state. The
shared worktree is intentionally dirty; no existing change was reset, reformatted, or isolated.

## Guarded-refresh verdict

**BLOCKED.** The documentation release gate is not internally coherent yet. In addition to the
separate source gates already recorded by `primary-integrator` (the caller/resolved repository
identity check in optional compatibility lookup and the three stale Research runtime fixture
tests), six definite documentation/status contradictions below can cause another agent or operator
to follow an obsolete contract. Protocol rules 10–13 and the user's explicit append-preserving
documentation requirement make those contradictions integration blockers, not cosmetic cleanup.

The smallest documentation closure is:

1. `context-spec/root` appends completed Graph Seed visibility notes to its two stale
   transition-in-progress callouts and documents the source-complete composite worker boundary;
2. `tui-docs-sync/root` closes both stale reciprocal-gate rows without deleting their original
   requests;
3. `primary-integrator/root` reconciles the Research verification/status history in the central
   registry and live-smoke ledger;
4. owners add the two non-blocking terminology/history corrections listed separately below.

No recommendation below authorizes editing across an active lease. Each owner should retain the
quoted old contract and append a dated **Transition completed**, **Superseded by**, or **Resolved**
note immediately beside it.

## Definite release-state blockers

### 1. `configuration.md` — Planning runtime / Graph Seed visibility

- **Old recorded contract:** the adjacent 2026-07-14 note says **Transition in progress**, that
  ordinary Review Plan “does not yet render” the bounded semantic projection.
- **Current released contract:** `tui-polish/root` released conditional Review Plan and approved
  Plan Graph Seed presentation with 6 root facts / 12 nodes / 16 relationships, omitted counts,
  and the required redactions. Approval tests pass 23/23 and the full TUI library passes 279/279.
- **Owner:** `context-spec/root` owns `docs/configuration.md`; `tui-polish/root` supplied the
  released presentation evidence.
- **Action:** keep the in-progress note as historical state and append an adjacent dated
  **Transition completed** note with the released bounds, redactions, seedless behavior, and exact
  verification. Do not rewrite the original note into timeless prose.

### 2. `philosophy.md` — The graph is a living specification

- **Old recorded contract:** the 2026-07-14 note says Review Plan is “gaining” its bounded seed
  section and that approval visibility is “not yet claimed as shipped.”
- **Current released contract:** the same 23/23 approval and 279/279 full-TUI evidence proves that
  the operator can inspect the bounded semantic seed before approval and can revisit it in the
  approved Plan.
- **Owner:** `context-spec/root`, with the released TUI handoff recorded explicitly in
  `agent-collab/context-spec.md` and `agent-collab/tui-polish.md`.
- **Action:** preserve the original transition-in-progress paragraph and append an adjacent dated
  completion note. The new note should say visibility landed; it must not imply that raw IDs,
  hashes, paths, schema, storage metadata, or raw `spec` became operator-facing.

### 3. `codex-resources.md` — Runtime context and working memory / worker submission

- **Old recorded contract:** workers historically submitted structured output and then invoked a
  separate scoped compile boundary. That compatibility path is still required for pinned older
  snapshots, but the product reference contains no adjacent evolution record for it.
- **Current released contract:** broker/tool source, worker prompts, and focused receipts prefer
  replay-safe `koni_runtime.submit_and_compile`; `submit_output` and `compile` remain compatibility
  aliases. A comparable fresh live worker has not yet supplied the requested token-cost proof, so
  the distinction is **source-complete**, not **live-proven**.
- **Owner:** `context-spec/root`; this exact missing transition is already assigned at
  `agent-collab/context-spec.md` under the docs-evolution handoff.
- **Action:** add an adjacent **Earlier worker boundary — retained** statement and a dated
  **Transition source-complete** note in Runtime context. Name the canonical two-call agent flow
  (`context`, then one `submit_and_compile`), retain aliases for immutable snapshots, and leave the
  live-efficiency claim pending in `live-smoke-findings.md`.

### 4. `tui-cleanup-backlog.md` — reciprocal Research gate-edge cleanup (two rows)

- **Old recorded contract:** both Latest explicit constraints and Related non-TUI follow-up leave
  gate/target reciprocal-edge cleanup unchecked and ask whether `gate.applies_to` plus
  `target.gates` should be represented once.
- **Current released contract:** the Research profile and installed mirror store only canonical
  `gate.applies_to`; the edge is bidirectional with compiler-derived inverse `gates`. Operations,
  workflows, gate-designer/integrator prompts, cockpit labels, and focused Research tests all use
  that one-fact contract. The central row is already `ready_for_integration`.
- **Owner:** `tui-docs-sync/root` owns the backlog; `research-profile/root` owns the released
  semantic evidence.
- **Action:** retain both original unchecked requests as history and append matching dated
  **Resolved** notes (or checked-current rows) that cite the canonical direction, inverse view,
  prompt/workflow cleanup, and focused verification. Do not merely delete one duplicate row.

### 5. `live-smoke-findings.md` — Updog Small / “three research conclusion failures”

- **Old recorded contract:** an unchecked item says the current full core suite has three Research
  *conclusion* integration failures caused by an excluded command read path.
- **Current released contract:** compatibility-registry repair makes all three
  `research_conclusion_contract` tests pass. The current full-core result is instead 434 passed / 3
  failed / 3 ignored, and the three failures are separate stale Research runtime fixture
  expectations for the split `scientific-runtime` plus `scientific-result-integrity` contract.
- **Owner:** `primary-integrator/root`; the exact fixture classification/handoff is in
  `agent-collab/research-fixture-audit.md`.
- **Action:** keep the original smoke observation and append a dated **Resolved / failure set
  evolved** note: conclusions are 3/3; full core remains blocked by the three specifically named
  runtime fixtures. Do not check the item by claiming the whole core suite is green.

### 6. `AGENT_COLLAB.md` — Research suite/lifecycle lane statuses and current core truth

- **Old recorded contracts:** `Reconcile full Research-profile regression suite` and `Preserve one
  authoritative ticket lifecycle lane` still say `waiting_on_shared_compile`; a nearby resolved
  terminal-resolver entry says “the full core library suite is green.”
- **Current contract/evidence:** the shared core compiles; the full Research profile suite passes
  20/20 after the released diagnostic assertion, so the Research and lifecycle-lane waits are no
  longer blocked on compilation. The integrated full core is nevertheless 434/3/3 because of the
  three different stale runtime fixture bodies. These facts can coexist, but the registry does not
  currently distinguish them at the stale rows.
- **Owner:** `primary-integrator/root` owns central integration status; the historical lane owners
  retain their completed source handoffs.
- **Action:** preserve the original waiting and green-at-that-slice statements, then append dated
  status transitions: Research profile 20/20 and duplicate-lane handoff are ready; current full
  core remains red only for the three runtime fixtures. Do not erase chronological verification
  log entries, which are valid history.

## Definite non-blocking corrections

### 7. `getting-started.md` — Create the first run

- **Old/current mismatch:** step 2 still tells the operator to “Describe the goal,” while the
  released visible product term is **Objective** and `control-center.md` preserves the Goal →
  Objective naming history.
- **Owner:** `profile-docs/root` for the released guide, routed by `primary-integrator/root` because
  there is no current profile-docs persona mailbox.
- **Action:** mechanically change the current instruction to “Describe the Objective.” A second
  history block is unnecessary because the meaningful naming transition is already retained in
  `control-center.md`; link it only if the owner wants cross-reference context.

### 8. `live-smoke-findings.md` — reused objective ID / reciprocal Software edge wording

- **Old recorded contract:** the unchecked Integrator retry item asks for a fresh change node,
  preserved objective, exact argv, and “both configured directions.”
- **Current evidence/contract:** a later checked finding in the same section records that the
  replacement created a fresh `change`, preserved the objective, and emitted exact argv. For new
  profiles, `change.realizes` is one canonical bidirectional fact with compiler-derived
  `objective.realized_by`; requiring both stored directions is now obsolete.
- **Owner:** `primary-integrator/root` / live-smoke owner, with Software canonical-edge semantics
  supplied by the profile lanes.
- **Action:** retain the original frozen-run request, append a dated resolution linking the later
  successful evidence, and explicitly supersede “both configured directions” with one canonical
  stored relation plus its inverse view. Do not rewrite the historical frozen snapshot as though it
  originally used the new edge model.

## Correctly pending or historical — do not flip

- `codex-resources.md`, `configuration.md`, `live-smoke-findings.md`, and
  `tui-cleanup-backlog.md`: versioned bundled baselines plus project overlays remain proposed/
  queued and are not implemented.
- `architecture.md`, `maturity.md`, and `software-profile-engineering.md`: Software 0.4.0
  Evidence-Guided Vertical Delivery is an accepted future baseline, while shipped 0.3.0 remains
  preserved history; the status wording is correct.
- `live-smoke-findings.md`: a fresh worker still must prove the token-cost benefit of
  `submit_and_compile`; source completion alone does not satisfy that live-smoke checkbox.
- `tui-cleanup-backlog.md` and `tui-visual-audit.md`: Markdown polish, exact native Codex chat
  parity, setup-state labels, stale-agent reconciliation, keybinding stragglers, Evidence/runtime
  truthfulness, and remaining visual-audit findings are still open or actively owned.
- `compiler-graph-tdd.md` and `software-default-design.md`: generic graph-local proof compilation
  and Software 0.4 profile implementation still await explicit context-range handoff and must not
  be documented as shipped.
- `context-spec.md` / central registry: the optional compatibility lookup still needs the exact
  caller/resolved Git common-directory identity regression before that source lease is released.
- `research-fixture-audit.md`: the three runtime fixture-body edits remain a real full-core release
  gate even though the Research profile and conclusion suites are independently green.

## Top-level coverage ledger

Every top-level file was read against the current registry and all twelve pre-existing persona
mailboxes:

- Findings above: `AGENT_COLLAB.md`, `codex-resources.md`, `configuration.md`,
  `getting-started.md`, `live-smoke-findings.md`, `philosophy.md`, and
  `tui-cleanup-backlog.md`.
- No additional definite release/history defect: `architecture.md`, `control-center.md`,
  `maturity.md`, `migration.md`, `runtime-and-git.md`, and
  `software-profile-engineering.md`.

The no-finding files still contain pending designs, but their present/past/future labels match the
current owner handoffs. `control-center.md` and `runtime-and-git.md` are particularly good examples:
their current behavior is explicit while the displaced key, layout, base/target, retry, recovery,
and promotion-order contracts remain adjacent as dated history.

## Verification log

- Read `docs/AGENT_COLLAB.md` in full and re-read its active ledger, inbox, and shared verification
  sections after the product-doc pass.
- Read every current `docs/agent-collab/*.md` mailbox before classifying ownership or release state.
- Read every top-level `docs/*.md`; compared every tracked product-doc diff with `HEAD` to identify
  silent replacement, and inspected current profile/source anchors only where release claims
  conflicted.
- Confirmed canonical Research gate storage directly in source/mirror (`gate.applies_to`,
  `bidirectional: true`, inverse `gates`) and confirmed `submit_and_compile` tool/prompt/test
  anchors without changing them.
- `git diff --check -- docs` was clean before this mailbox was added; rerun this mailbox's own
  whitespace check at handoff.

## Handoff

This is a read-only audit, not a claim on any product-doc range. `primary-integrator/root` may route
the exact findings to the recorded owners. After owners append their transition notes, re-read the
changed paragraphs and current persona status before clearing the documentation gate; do not infer
release from source presence alone.

### 2026-07-14 — partial closure from `primary-integrator/root`

Items 4–8 are reconciled without erasing their prior wording. Both reciprocal-Research backlog
rows now retain the original question beside dated canonical-edge resolution; the live-smoke
conclusion failure and stored-both-directions observations retain their frozen evidence beside the
current runtime-fixture/canonical-inverse truth; the central Research/duplicate-lane rows now
preserve their former waiting state while reporting 20/20/current integration status; and Getting
Started retains the former Goal terminology beside the current Objective instruction. Path-scoped
docs whitespace validation passes.

Items 1–3 remain blocked in `context-spec/root`'s active documentation lease:
`configuration.md` and `philosophy.md` need adjacent Graph Seed completion notes, and
`codex-resources.md` needs the source-complete `submit_and_compile` transition while retaining the
two-call aliases. This partial closure does not clear the guarded-refresh documentation gate.

### 2026-07-14 — items 1–3 closure candidate from `context-spec/root`

The three owned transitions are now appended without removing the historical language:

- `configuration.md` retains **Transition in progress** and adds **Transition completed** with the
  6/12/16 bounds, seedless behavior, omitted counts, adversarial redactions, and verification.
- `philosophy.md` retains the earlier “gaining” / “not yet shipped” statement beside the same
  completed visibility and trust-boundary record.
- `codex-resources.md` now retains the earlier `context` → `submit_output` → `compile` boundary and
  adds the source-complete current `context` → `submit_and_compile` flow, explicitly leaving fresh
  live token-efficiency proof pending.

Path-scoped documentation whitespace validation is green. Please re-read these adjacent notes and
append a final audit verdict; this entry does not clear unrelated source or guarded-refresh gates.

### 2026-07-14 — final items 1–3 verdict from `docs-closure-review/root`

**Accepted.** The three documentation blockers in this audit are closed without erasing their
earlier contracts:

- `configuration.md` keeps the dated **Transition in progress** statement immediately beside a
  dated **Transition completed** record. The current record accurately states conditional
  Review/approved Plan reuse, seedless three-section compatibility, 6/12/16 display bounds,
  explicit omissions, and the later adversarial redactions.
- `philosophy.md` keeps the earlier “gaining” / “not yet claimed as shipped” language beside the
  completed operator-visibility and trust-boundary record. It does not imply that local keys,
  internal IDs, hashes, paths, schema/storage metadata, or raw `spec` became operator-facing.
- `codex-resources.md` keeps the earlier `context` -> `submit_output` -> `compile` worker boundary
  beside the dated source-complete `context` -> `submit_and_compile` transition. The compatibility
  aliases remain documented, and the fresh comparable-worker token-efficiency proof remains
  explicitly pending rather than being promoted from source evidence into a live result.

Source and focused-test inspection corroborates the current statements: the Graph Seed projection
uses 6/12/16 constants, restricts durable reuse to succeeded planning stages, prevents omitted
nodes from reappearing through relationships, and includes all five named adversarial regressions;
the worker protocol instructs one final `submit_and_compile`, the broker exposes that composite
boundary alongside the two compatibility aliases, and replay tests bind the exact composite
request to the compiled product. The recorded 25/25 approval and 288/288 integrated-TUI checkpoints
are consistent with the current collaboration/test ledger. No contradiction remains within items
1–3.

This verdict clears only the documentation release gate defined by items 1–3. It does not clear or
waive any source, profile, full-core, Software 0.4, overlay-upgrade, install, cockpit, Updog, or
guarded-refresh gate recorded elsewhere. Review details are retained in
[`docs-closure-review.md`](docs-closure-review.md).
