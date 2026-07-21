# Mailbox: TUI smoke-test UX findings (Claude-provider Small runs)

Owner: `harness-fix-validation/root`. Append-only. Findings from driving six Small SPICED runs
end-to-end through the Pi control center (`/koni`, `/koni-run`) against updog on 2026-07-20/21,
operator-requested ("the TUI is currently pretty shitty and starting a new run is a pain in the
ass — find all the little ways to improve it"). All interaction was through the Pi TUI in a cmux
pane; engine forensics via read-only run-record reads.

## 2026-07-21 — engine bugs found and fixed (committed on `pi-native-port`)

1. **`4d2f649` fix(core): provider token accounting** — two calibration bugs that made every
   Claude run fail:
   - Input reservation `bytes/4` < Claude's real ~3.1 (prose) / ~2.7 (code) bytes-per-token →
     every settlement exceeded its own reservation → runs blocked at the first busy request.
     Now `bytes/2` with legacy formulas accepted for stored ledgers.
   - Cache-inclusive attempt ceiling `maxNew x16` — anthropic re-reads the whole cached prefix
     every turn (observed 905K cacheRead vs 6.6K new tokens ≈ $0.70 real spend) → healthy
     14-turn implementer aborted. Now x64.
2. **`96f4662` fix(core): abort retirement recognizer** — pause during an in-flight
   request permanently bricked the run: the retirement recognizer demanded codex abort semantics
   (zero usage + exact "Request was aborted"); anthropic reports partial usage + "This operation
   was aborted". Now usage-independent + case-insensitive abort match. Validated live end-to-end:
   accidental operator Space → blocked → Acknowledge provider error (new action surfaced) →
   Retry → planning resumed.

## Environment/product gaps (updog-specific, need product answers)

3. **Worktree dependency bootstrap (top product gap).** Ticket worktrees get only a partial root
   `node_modules`; `pnpm exec vitest` cannot resolve in a fresh worktree, so every proof check
   fails as an environment error the implementer cannot fix, exhausting ticket cycles into a
   terminal deadlock. Tonight's workaround: manual `pnpm install --prefer-offline` (~35s) into
   each cycle worktree between prep and first check. Product fix: a profile-configurable worktree
   bootstrap hook (e.g. `worktree_bootstrap: pnpm install --prefer-offline`) run during
   preparation.
4. **Corepack vs check sandbox.** The read-only check sandbox denies `~/.cache/node/corepack`
   writes; if the repo-pinned pnpm isn't already cached, every check dies with EPERM before
   running. Workaround: `corepack prepare pnpm@<pinned>` once outside. Product fix: pre-warm
   during install/init, or allow the corepack cache path in the sandbox profile.
5. **Budget economics vs forced-xhigh thinking.** This Pi catalog exposes only xhigh/max for
   claude-sonnet-5/opus-4-8. xhigh reasoning was ~72% of worker output; the Small 60K new-token
   worker envelope died on turn 16 (updog `.koni` now uses 240K planning → 120K workers). But a
   bigger planning envelope produced a *heavier plan* (2 tickets + architecture-mapper) whose
   mapper burned the doubled budget too (38 turns/120K; its resumed retry finished in 9/18.7K —
   resume-with-notes is dramatically cheaper). Product thinking needed: thinking-share-aware
   budgets, or lower thinking tiers for Claude workers in the catalog, or verbosity guidance in
   worker personas.

## Open harness bugs (not yet fixed)

6. **Budget abort mid-check poisons the check intent.** When an attempt hits a token ceiling
   while its configured check subprocess is live, the check dies "without an authenticated
   result" and the durable intent wedges the run (observed twice on run 8f98b370). The abort
   should either let the check settle or cleanly void the intent.
7. **Step-reissue semantics after failed attempts (run da307a0d, unresolved).** A failed
   `map-affect` step stayed failed even after a retried attempt completed — the attempt's
   terminal output was `{"status":"failed","blocker":"probe"}` — and the sibling ticket's
   dependency kept the scheduler starved → "Deterministic ticket orchestration remains
   deadlocked" with retry looping. Needs a real investigation of step retry/reissue semantics
   and of why a completed attempt submits a probe-failure.
8. **Run-level "Retry blocked work" does not reset ticket cycle budgets**, so environment-caused
   check failures burn the 2-cycle budget and the run is unrecoverable even after the
   environment is fixed. No ticket-scoped reissue action exists in any surface.

## TUI/UX findings (the requested list)

Interaction model:
- **Invisible focus** (the #1 systemic issue): panel focus has no monochrome-visible indicator;
  j/k/v/a/d land on whichever panel silently has focus. Cost tonight: a retry fired on the wrong
  run; `j` opened an agent chat instead of moving run selection; and a **Delete run dialog opened
  under unrelated keystrokes on an awaiting-approval run** (single-key, no-confirm bindings +
  invisible focus = near-catastrophic).
- **Silent no-ops everywhere**: keys that don't apply (d, a on wrong focus, v while chat focused)
  give zero feedback. Every ignored keystroke should flash *why*.
- **Unrecognized escape sequences dismiss modals**: a kitty-encoded Tab/Ctrl-Enter closed the
  intake/confirm dialogs outright — and took a fully-typed goal with them (**no draft
  preservation, no confirm-on-dismiss**).
- **Palettes persist after actions fire** and swallow subsequent keystrokes (goal text typed into
  a lingering palette scrolled its selection; Enter fired a stray retry).
- **Space = instant pause with no confirmation**, and (pre-fix) pausing mid-request bricked the
  run. Even post-fix, pause deserves a confirm or at least an undo toast.

Run identity & lists:
- **Identical run rows**: five runs, same title, no run id, no created-at, subtitle only
  (`Small · Orchestrate · 0/1`). Impossible to tell runs apart; directly caused the wrong-run
  actions above. Add short id + age + state color.
- **Post-delete scroll jump + cryptic pagination** (`Runs · 4–4/4`): after deleting, the list
  showed one row and looked emptied; the operator reasonably concluded everything was deleted.
- **Async cascade deletes surprised the operator**: multiple deletes queued earlier drained
  minutes later; no progress/toast per completed deletion.
- **Delete-dialog default focus is Cancel but Enter-confirm distance is one key** with identical
  labels for preserve/delete-branches variants.

Intake (the "pain in the ass" flow):
- **No re-run/duplicate action.** Six full manual intake fills tonight for the same objective.
  A failed/blocked run should offer "duplicate with same goal/config" as a one-key action.
- **Stage list mixes every run type's stages** with `skipped` markers, planning stages render
  AFTER the merge stage, and the selected run type is only findable by color.
- **Selected-value brackets are inverted vs convention** (selected option loses its brackets);
  in monochrome the selection is invisible.
- **Branch selection is arrow-cycling only** — no type-ahead; dozens of branches = dozens of
  keypresses.
- **"Enter edit/start" ambiguity**: same key edits a field or starts the run depending on
  invisible focus.
- Good bones to keep: adaptive Approve/Revise plan modal, per-role model+reasoning table
  (embedded variant shows friendly model names — standalone shows raw ids; unify), Questions
  policy quick-select, live stage preview, `Stages 1–14 of 14` pager in the embedded variant.

Blocked-run recovery:
- **Blocker messages are engine-speak** ("Provider request remains reserved without a canonical
  assistant settlement; worst-case exposure is held") with no next-step hint. Every blocker
  should carry an operator action suggestion.
- **Acknowledge-provider-error flow is buried**: palette action → confirm form with a checkbox
  AND a button (double confirmation for an accounting no-op) — but only after our recognizer fix
  made it appear at all. Meanwhile Retry is one Enter with no confirm.
- **Ticket palette is 8 dead cockpit slots** ("This cockpit slot is not mapped to a capability…")
  ahead of the real run actions. Hide unmapped slots.
- **Errors don't include numbers**: "usage exceeds its durable request reservation" should say
  `67,579 > 64,926 (payload 182,488 bytes)` — tonight's diagnosis required reading run.json.

Monitor/status:
- Statusline widget ("Koni · N runs · X active agents · ! !") and "Koni · stopped" honesty are
  genuinely good. The `! !` markers deserve a tooltip/expansion.
- "Started Small run." toast should include the run id + "open /koni to monitor".

## Proof state

- Pipeline proven through: intake → plan (Claude planner, 12-22 settled requests/run) → approve →
  publish/initialize → orchestrate (implementer authored red tests; checks executed vitest after
  env bootstrap) across runs 8f98b370/da307a0d. Merge stage not reached tonight — blocked by
  findings 6/7 above.
- All original engine-accounting walls are gone: runs no longer fail on reservation, cache
  ceiling, or pause-abort.
- Runs 0ab09757/5ffd091d/15bf289a/8318dfa5 deleted by operator (async cascade); 8f98b370 (check
  intent wedge) and da307a0d (step deadlock) retained as forensics.
