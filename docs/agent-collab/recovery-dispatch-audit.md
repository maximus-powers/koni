# Recovery Dispatch Audit Coordination

## Lease — 2026-07-15 (`recovery-dispatch-audit/root`)

- Own only the post-recovery retry advisory in `crates/koni-core/src/engine.rs`, one narrow
  end-to-end lifecycle regression in `crates/koni-core/tests/run_lifecycle.rs`, and append-only
  recovery history in `docs/runtime-and-git.md` plus the central registry.
- Preserve the explicit `recover` then `retry-supervised-stage` safety boundary. Recovery may
  describe the next operator action after its own journal commits; it must not mutate or reopen the
  pipeline itself.
- Do not touch the live Updog acceptance project, cmux, installed or isolated binaries, shared
  build output, profiles, CLI/TUI behavior outside the returned advisory, or unrelated dirty files.
- Verification uses a private `CARGO_TARGET_DIR`. This mailbox will record exact tests and release
  state before handoff.

## Questions

- None. The primary integrator confirmed this bounded implementation after the read-only live-state
  diagnosis.

## Release — 2026-07-15 (`recovery-dispatch-audit/root`)

- Status: `ready_for_integration`; the source lease is released after this handoff.
- A successful `recover` result now carries a result-only `recovery_advisory`. It reports
  `retry_required: true`, the blocked orchestration `stage_id`, the explicit
  `retry-supervised-stage` action, and its exact CLI command only when the post-recovery compiler
  board has a safe continuation. Recovery does not retry or mutate the terminal pipeline stage.
- The lifecycle regression builds an exhausted two-review rework circuit, supplies newer exact
  ticket-scoped steering, recovers the ticket to a dispatchable step, proves the pipeline remains
  blocked, then proves explicit supervised-stage retry restarts attempt 2 without losing that
  ready step.
- Owned files: `crates/koni-core/src/engine.rs`,
  `crates/koni-core/tests/run_lifecycle.rs`,
  `crates/koni-cli/templates/codex/shared/skills/operate-koni/references/recovery.md`, and the
  append-only clarification in `docs/runtime-and-git.md`.
- Isolated verification under `CARGO_TARGET_DIR=/tmp/koni-recovery-dispatch-audit-target`:
  lifecycle target **51 passed / 0 failed**; focused core reopen group **6 passed / 0 failed**;
  warning-denied `koni-core --all-targets` Clippy passed; workspace formatting and diff checks
  passed.
- No live Updog state, cmux surface, installed or isolated binary, profile, or shared build output
  was changed.

## Lease — recovered worker read-scope diagnosis, 2026-07-15 (`recovery-dispatch-audit/root`)

- Read-only ownership: trace how a recovered review-rework correction step becomes a worker context
  and direct-Pi broker read capability, explain why an omitted historical `read_paths` entry cannot
  be widened by the correction, and recommend the narrowest generic old-run-compatible repair and
  focused proof matrix.
- No source implementation, live acceptance state, process, cmux surface, binary, profile, or build
  output mutation is authorized in this lane.

## Findings — recovered worker read-scope diagnosis, 2026-07-15

- The denial is deterministic compiler/broker behavior, not stale broker state.
  `Engine::evaluate_rule_with_preparations` resolves and freezes the rule/ticket and workflow-step
  filesystem paths into durable `Step.read_paths`. `effective_step_read_paths` is only the step
  override or the ticket scope; it does not derive filesystem capability from graph metadata at
  dispatch time.
- The bundled Software `proof.prepare` rule can expose a `proof --uses--> system` neighborhood to
  graph context, while `author-historical-baseline` grants only proof `source_paths` and
  `covered_paths`. Consequently `system.spec.owned_paths` can correctly describe the production
  seam without authorizing the worker to read it. Graph visibility is semantic evidence, not file
  authority.
- Review-rework recovery changes findings, output/worker history, blocker state, and ticket status.
  It intentionally does not change read paths. Free-form `review-rework` steering also has no typed
  path grant. Treating reviewer or model prose as authority would be a capability escalation.
- A replacement author compiles its context and scope prompt from the same durable effective step
  scope. Every broker `read_file` call reopens the exact ticket/step and eventually enforces
  `ensure_paths_within_step_scope`; the safe public error maps that exact rejection to
  `forbidden_scope`.
- Any repair must also close a latent binding hazard: broker grants and active-worker currentness
  bind ticket, step, persona, and input, but not an explicit effective-scope digest. Because broker
  authorization reloads mutable current ticket state, mutating a live step could otherwise widen
  an already-issued grant silently.

### Recommended generic repair

1. For newly compiled runs, add a serde-defaulted, config-driven, read-only rework envelope (for
   example `rework_read_paths`) resolved and frozen during ticket compilation. It may become
   effective only at a compiler-proven failed-review/rework boundary and must remain inside a
   ticket-level predeclared read envelope. The Software proof-preparation profile should project
   relevant explicitly `uses`-connected system `owned_paths` into this envelope while leaving
   proof-author writes unchanged.
2. For legacy in-flight tickets, provide an explicit operator-only exact read-scope supplement,
   rather than deriving authority from reviewer findings or free-form steering. Require an exact
   ticket/step, a failed-review boundary, quiescence (no live worker/reviewer/in-flight grant), a
   normalized non-protected project-relative path, and proof that the exact path is covered by a
   configured typed `Path` or list-of-`Path` field on a node already in the ticket's pinned graph
   neighborhood. Store an append-only receipt with original/effective scope hashes, source
   node/field hash, review boundary, reason, and timestamp; never overwrite the historical
   compiled scope.
3. Bind `effective_scope_hash` into the context/prompt manifest, broker grant, active-worker record,
   and currentness validation. A supplement must revoke the old grant and produce a fresh context,
   input, grant, and worker. Reject amendment while any affected authority is live.
4. Widen reads only, and only by exact files. Never widen writes, parse paths out of model prose, or
   automatically union all visible graph ownership. If the omitted path is itself part of the
   claimed proof boundary, require graph correction/recompilation; use the supplement only when it
   is a production dependency needed to exercise an otherwise valid proof.

### Focused proof matrix

- New profile compilation: rework envelope is frozen; an initial attempt cannot use it; a failed
  review replacement can read the exact dependency; writes remain denied; ordinary recovery does
  not activate it.
- Legacy snapshots: missing optional fields deserialize; valid ticket-neighborhood typed paths are
  accepted; unrelated nodes/siblings, absolute paths, symlinks, control-plane paths, and untyped
  prose paths are rejected.
- Grant binding: amendments are rejected while workers/reviewers/calls are live; the old grant is
  stale after a scope-hash change; only the freshly bound context/grant succeeds; exact replay is
  idempotent.
- Broker surfaces: read/list/search and configured-check sandboxes honor the effective read union,
  while file writes remain governed solely by original write scope.
- Evidence/lifecycle: manifests and affected receipts are invalidated and reissued; failed review
  → supplement → recover → explicit stage retry dispatches a fresh worker without introducing
  an implicit retry.

## Release — recovered worker read-scope diagnosis, 2026-07-15

- Status: `findings_delivered`; the read-only lease is released.
- No source, profile, test, live Updog state, worker, run, cmux surface, installed/isolated binary,
  broker grant, or build output changed. No tests were run because this task was source diagnosis
  only.
