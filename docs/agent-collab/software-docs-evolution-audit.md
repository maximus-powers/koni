# Software documentation evolution audit

Owner: `software-docs-evolution-audit/root`

Status: `complete` — read-only Software/history audit; product docs and source remain untouched

Last checked: 2026-07-14 Phoenix

## Exact lease and method

- This mailbox only.
- Read every current Markdown-document inventory entry under `docs/`, including the central registry
  and persona mailboxes, then isolated tracked product-document deletions with `git diff --unified=0`.
- Audited Software default/profile/customization/init/run-type wording, adjacent history retention,
  current release claims, and questions addressed to `software-default-design/root` or `root`.
- Pi, Research, and TUI material was read for collision/status awareness but remains owned by those
  domains and is not expanded into this Software audit.

## Findings

### P1 — Runtime/Git still violates adjacent history retention

`docs/runtime-and-git.md:24-30` directly replaces the tracked bullet “an immutable base commit” with
“an immutable target branch and its observed base commit.” Lines 159-166 directly replace “one
integration branch pinned from its approved base” with the selected-target wording. The former
phrases are quoted only at lines 386-394 under **Target synchronization and promotion**, hundreds of
lines after both changed lists. That is preserved somewhere, but it is not the adjacent note the user
requires.

This is the same unresolved defect already recorded in:

- `docs/agent-collab/docs-evolution-watch.md:103-114`, which asks for the exact old phrases beside
  the bullets; and
- `docs/agent-collab/verification-head-fix.md:60-70`, which repeats the adjacency requirement.

`verification-head-fix.md:50-52` says Runtime/Git retains the former wording in a dated transition;
that is technically true only at the distant promotion section and therefore overstates compliance
with the adjacent-history rule.

Recommended documentation-only correction: leave each current bullet intact, append a dated
**Run-intake history — transitioned 2026-07-14** note immediately after the first list quoting “an
immutable base commit,” and append or repeat the matching “pinned from its approved base” history
immediately after the integration-branch list. Do not remove the later consolidated transition.

### P1 — Central Software task row is materially stale

`docs/AGENT_COLLAB.md:160` still labels the current work as a pending 16-case/final matrix and its
latest prose still lists generic retirement units, the Software Pi broker path, and the final design
audit as open. Later authoritative records say:

- the current focused Software target contains 18 cases (`software-final-design-audit.md:150-160`);
- generic deterministic reopen is 2/2 plus 4/4, with the exact Software consumer 1/1 and only a
  post-successor consumer rerun queued (`AGENT_COLLAB.md:161,1173-1185`);
- the final design audit is complete with design 5/5 and release evidence held
  (`AGENT_COLLAB.md:163`; `software-final-design-audit.md:274-367`); and
- the direct Software broker path is provisionally functional, while the current generic blocker is
  bounded successor enumeration/frozen evidence (`AGENT_COLLAB.md:1162-1171,1196-1225`). The
  read-only performance audit confirms that the current one-vector emission-loop change closes only
  one multiplier; derivation/nested resolvers and repeated receipt-directory parsing still require an
  operation-scoped indexed snapshot plus deterministic bounded-work counters
  (`successor-replay-perf-audit.md:17-53,72-144,166-173`).

Preserve row 160 as chronology, but append a current transition in that row (or an immediately
adjacent successor row) naming 18 cases and the remaining successor/runtime, immutable matrix,
broker-fingerprint, and Pi cutover gates. It must not keep presenting already closed generic
lifecycle and final-design work as current.

### P1 — “Prove every Software proof strategy” remains falsely queued

`docs/AGENT_COLLAB.md:190` still queues end-to-end proof for red/green, characterization, and current
verification. `software-profile-regressions.md:323-338` already records all three paths through exact
rule/workflow/baseline persona and check, proof/product authority, source preservation, compiler
baseline/promotion receipts, independent review effects, finish, and physical product mutation.
Append a transition that closes the original strategy-coverage request while keeping the broader
18-case immutable Software matrix and successor-performance release hold distinct.

### P2 — Prepared-source consumption status is non-local and easy to misread

`docs/software-profile-engineering.md:294-303` and lines 315-322 say the frozen/bundled Software
profile has not consumed the prepared-source interfaces. Lines 333-349 later describe the current
Bug Fix lifecycle consuming that contract through authenticated promotion and name only the generic
compile-epoch/fingerprint release gate. This is append-preserved chronology, not a silent deletion,
but the older present-tense “has not consumed” statements are not explicitly marked superseded for
consumption.

`docs/configuration.md:1130-1138` has the same older “Software has not consumed it” checkpoint. Its
later transition at lines 1163-1184 explicitly calls the pending language history and describes
current source, so it is less contradictory, but one direct sentence distinguishing **consumed in
current source** from **not released on a frozen full matrix** would eliminate ambiguity.

### P2 — Software regression mailbox still calls the matrix sixteen cases

`docs/agent-collab/software-profile-regressions.md:359-371` introduces the sixteenth case, and lines
431-466 continue to call the whole matrix sixteen cases. The later final audit identifies 18 current
cases. Preserve the 16-case checkpoints, then append an 18-case transition with the two added
coverage dimensions and current execution/release status.

## Replacements checked and found compliant

- `docs/codex-resources.md` retains the original Software-only skill contract and direct-editing
  guidance immediately beside their evolved approval-first forms.
- `docs/configuration.md` preserves the earlier edge vocabulary, exit-zero contract, illustrative
  architecture-first manifest, and five-step authoring workflow next to their replacements.
- `docs/getting-started.md` preserves the original default-Software selection, architecture-grounded
  Software description, base-only planning wording, goal terminology, and no-planning/no-question
  Small contract beside current initialization and Software 0.4 behavior.
- `docs/architecture.md` retains the base-only planning identity beside its target-bound evolution.
- Other tracked deletions in `control-center.md` are TUI/product-surface changes and were left to the
  TUI documentation owners; Software-specific history was not silently removed there.

## Question reconciliation

No unanswered question addressed to `software-default-design/root` or generic `root` was found.

- `compiler-graph-tdd.md:63-65` asks for final Software proof fields/relations; the Software answer
  is at lines 217-257, terminology is resolved at 259-264, and the stable interface is acknowledged
  at 473-483.
- The red-to-green preservation question at `compiler-graph-tdd.md:485-491` is answered beginning at
  493.
- `software-profile-regressions.md:134` asks whether drift diagnostics should include
  `parent_check_id`; it is routed and answered at `compiler-graph-tdd.md:619-640`.
- `context-spec.md:388-399` asks about approved-seed provenance and is answered beginning at line
  401.

## Foreign-domain boundary

Pi, Research, and TUI mailboxes contain their own moving release/history records. They were checked
only to avoid treating foreign movement as Software evidence. In particular, no Pi component green,
Research fixture result, or TUI presentation release is promoted here into a Software or whole-
project release claim.

## Verification

- `git diff --unified=0 -- docs` used to enumerate every tracked Markdown deletion/replacement.
- `rg --files docs -g '*.md' | sort` used for the complete current inventory; the final sweep found
  73 Markdown files, including the newly arrived successor-performance and Pi-red-team mailboxes plus
  this audit mailbox.
- No product documentation, source, profile, test, installed resource, binary, or live state was
  changed by this audit.
