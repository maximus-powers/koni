# Koni v1 Autonomous Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Qualify one exact Koni v1 candidate for autonomous, operator-started Coding and Research
work through the real Pi/TUI workflow.

**Architecture:** Stabilize all mandatory gates before sealing archives. Fix only durable,
generalizable Koni defects test-first; then install the exact archives in fresh smoke roots and run
both profiles through the left cmux Pi/TUI to non-destructive promotion readiness.

**Tech Stack:** TypeScript, Vitest, Node.js 22.19 and 24, npm 11.13, Pi 0.80.10, TypeBox 1.1.38, Git
worktrees, cmux terminal control.

**Spec:** Approved in-thread plan from 2026-08-20; no separate design document.

## Global Constraints

- Core fixes must express domain-neutral invariants; profile fixes must express reusable Coding or
  Research invariants.
- Never encode smoke filenames, project tooling, languages, methodologies, model quirks, or expected
  project results.
- Preserve fail-closed authority, immutable run history, exact provider accounting, Git ownership,
  and receipt binding.
- Never manually perform product work assigned to Koni agents or edit durable smoke-run state.
- Use exact packed archives for qualification; a Core change invalidates both profiles, while a
  profile-only change invalidates that profile. Any archive change reruns package smoke.
- Use `openai-codex/gpt-5.6-luna` at medium thinking for every qualifying persona with no fallback.
- Operate final smoke runs through the left cmux terminal and stop at non-destructive promotion
  readiness. Do not merge, push, deploy, publish, or tag without explicit approval.

---

### Task 1: Complete provider liveness across operator questions

- [ ] Preserve the existing RED regression and prove it fails for the stale pre-answer timer.
- [ ] Restart a full provider-liveness interval at live question resolution without admitting a
      second provider request.
- [ ] Cover near-deadline answers, long waits, cold continuation, settlement, and historical
      watchdog-abort retry behavior.
- [ ] Run focused provider, authority, question, and process-supervisor suites.
- [ ] Commit the isolated fix and tests.

### Task 2: Reconcile static release contracts

- [ ] Make Configure tests match the product contract that Pi-native skills/prompts are excluded
      from `.koni` documents and rejected by `.koni` mutation APIs.
- [ ] Remove the seven unnecessary test-only TypeScript assertions reported by ESLint.
- [ ] Format and track the smoke ledger without changing its historical claims.
- [ ] Run focused Configure tests, lint, format-check, typecheck, docs, profiles, and host-boundary
      gates.
- [ ] Commit the isolated contract and hygiene changes.

### Task 3: Diagnose and fix installed `/koni-run` creation

- [ ] Reproduce the exact-tarball failure and capture phase timing for runtime assertion, authority
      connection, catalog/branch discovery, run compilation, Git admission, durable commit, and
      modal completion.
- [ ] Add the smallest failing boundary test proving the responsible production behavior.
- [ ] Make guided Start settle after durable run admission while run initialization remains
      background work; retain editable intake and actionable errors on rejection.
- [ ] Verify real component tests and the exact installed-package smoke twice.
- [ ] Commit the general integration fix and tests.

### Task 4: Restore architecture budgets without widening them

- [ ] Characterize the behavior of each responsibility moved from the eight oversized facades.
- [ ] Extract provider lifecycle, execution/check dispatch, durable projections, session/transcript
      handling, control-center orchestration, Git lifecycle, process supervision, and configuration
      compilation into one-way leaf modules.
- [ ] Preserve facade exports and forbid leaf-to-facade imports.
- [ ] Run affected suites after each extraction and make `npm run test:architecture` pass without
      increasing thresholds.
- [ ] Commit each independently reviewable extraction.

### Task 5: Establish deterministic repository and runtime gates

- [ ] Diagnose any full-suite non-termination, leaked handles, shared fixture state, or namespace
      collision until the complete suite exits deterministically.
- [ ] Add Node 24 beside Node 22.19 in CI while retaining macOS and Ubuntu coverage and the pinned
      Pi, TypeBox, and npm versions.
- [ ] Run `npm run check` and `npm test` twice consecutively on the clean candidate.
- [ ] Run exact package smoke twice on Node 22.19 and Node 24.
- [ ] Update maturity and operator documentation to state the qualified autonomy, model, platform,
      containment, and recovery boundary.
- [ ] Commit the release-gate and documentation changes.

### Task 6: Seal and qualify the exact candidate through cmux

- [ ] Pack Core, Coding, and Research exactly once; record versions, manifests, and SHA-256 hashes.
- [ ] Create fresh disposable Coding and Research smoke roots from recorded clean baselines and
      install only the sealed archives.
- [ ] Use the left cmux terminal for Pi startup, `/koni-run`, questions, planning review, approval,
      pause/resume, authority restart, `/koni-runs`, `/koni`, reports, and promotion inspection.
- [ ] Run the unchanged prior Medium Coding and Research objectives sequentially with Luna medium
      and no fallback.
- [ ] Stop both at promotion readiness and audit diffs, OIDs, worktrees, receipts, provider usage,
      reports, unresolved effects, cleanup previews, and TUI usability.
- [ ] Preserve RED runs and return to the appropriate task for every valid Koni defect; reseal and
      rerun every invalidated qualification.

### Task 7: Publish the final evidence boundary

- [ ] Commit a ledger with the exact candidate commit, archives, hashes, run IDs, objectives, model
      assignments, timestamps, OIDs, commands, test results, incidents, TUI observations, and
      invariant audit.
- [ ] Verify a clean worktree, fully checked ledger, clean package inventory, and absence of
      unresolved authority or Git effects.
- [ ] Prepare the release workflow through build, audit, SBOM, checksums, and provenance generation.
- [ ] Stop before push, tag, npm publication, GitHub release, merge, or destructive promotion and
      request explicit authorization for those external actions.
