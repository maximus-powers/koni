# Compatibility Registry Audit

Owner: `compat_registry_audit/root`

Status: `complete` (read-only causal and semantic review; candidate repair independently green)

**Transition — 2026-07-14:** This completes and supersedes the initial `in_progress` audit marker
without changing any Rust, installed binary, cockpit, project, or live-run state.

Last checked: 2026-07-14 (Phoenix)

## Mission

Verify the diagnosed compatibility-run registry poisoning chain and recommend the narrowest fix
that preserves modern project-registry authority. This lane audits call sites and regression
coverage only; it does not implement the repair.

## Exact lease and safety boundary

- Read-only inspection of `compile_context`, optional control-store resolution,
  `ProjectRegistryStore::{run, load_or_create}`, registry-presence detection, and all callers.
- This mailbox is the only file this lane may edit.
- `context-spec/root` retains the causal Rust ranges and any implementation ownership.
- No Rust/profile/TUI edits, binary install, cmux input, Updog access, or live-run mutation.
- Existing documentation is append-only decision history. Findings and later resolution notes will
  be added here without replacing the central diagnosis or prior compatibility contract.

## Coordination

- Read the complete `docs/AGENT_COLLAB.md` and every existing `docs/agent-collab/*.md` before
  beginning source inspection.
- The central inbox already records `compile_context -> run_control_store ->
  ProjectRegistryStore::run -> load_or_create` as the suspected chain. This audit will validate
  exact control flow, inventory semantic callers, and distinguish an optional lookup from an
  authoritative registry open.
- Questions or conflicts may be appended below with a signed date. Do not treat this read-only lane
  as a source lease or implicit handoff from `context-spec/root`.

## Findings

The initial placeholder was **Pending source audit**. The completed audit establishes the following
dated findings without replacing the central diagnosis.

### 2026-07-14 — exact causal chain

1. A compatibility `Engine` executes Research action `start`; its recipe includes
   `context.compile` after the worktree and ticket transition.
2. Primitive dispatch calls `Engine::compile_context`.
3. The former optional lookup called `run_control_store(...).unwrap_or_else(legacy_store)`.
4. `run_control_store` constructs `ProjectRegistryStore` and calls `run`; `run` calls
   `load_or_create`, whose absent-registry branch writes an empty `.git/koni/project.yaml` before
   `run` returns `NotFound` for the unregistered compatibility run.
5. `compile_context` catches that error and successfully uses the legacy control root, so the
   action appears successful even though it has adopted/poisoned the repository as a hidden side
   effect.
6. The next TUI refresh sees `project.yaml`, correctly treats modern registry membership as
   authoritative, and calls `Engine::open_run`; the compatibility run is absent from the empty
   registry and disappears with `NotFound`.

The three `research_conclusion_contract` failures were the same defect, not a separate conclusion
or authority-fixture problem. `ConclusionFixture::new` directly initializes a legacy Research run,
then executes `start`; that action's context compile creates the empty registry. The later
worktree `context` action reaches `ensure_run_identity_live_under_barrier`, sees the new registry,
and correctly rejects the now-unregistered run.

### 2026-07-14 — caller inventory

Three compatibility-aware callers need absence-only fallback and are now routed through the same
candidate helper:

- `compile_context` reads bounded working memory;
- `graph_context_for_ticket` reads bounded graph supplements plus working memory;
- `record_graph_note_for_ticket` writes advisory graph notes.

All three formerly swallowed every registry error, not just absence. That allowed an existing
registry's missing membership, malformed YAML, invalid run identity, or root error to fall back to
legacy state. The write caller was most serious: it could put a note in the legacy root after the
repository had adopted modern run authority. The read callers could omit registered notes or
present stale compatibility memory.

The remaining `run_control_store` callers are registered-run control paths:
`release_question_pause`, `record_question`, `record_planning_intake_with`,
`resume_planning_agent_with`, `revise_planning_batch_answer_with_notes`,
`answer_question_with_notes_and_launcher`, `resolve_due_questions`, and
`update_orchestration`. They already require `Engine::open_run`, a registered-run authority
barrier, or an explicit registry lookup. They should continue to propagate membership failures and
must not acquire a compatibility fallback.

### 2026-07-14 — candidate repair verdict

The owner landed the narrow correct shape during this audit:

- `ProjectRegistryStore::existing_run` distinguishes an absent registry (`Ok(None)`) from an
  existing registry with a missing run (`Err(NotFound)`), and reads an existing atomic registry
  snapshot without creating the sidecar or lock path.
- `existing_run_control_store` maps only `Ok(None)` to compatibility storage.
- The three optional callers now use `existing_run_control_store(...)?` and therefore propagate
  every error once a registry exists.

For a valid repository/registry this preserves the intended authority table:

| Registry state | Result |
| --- | --- |
| Absent | Use the compatibility run-local control root; create no registry state. |
| Present and run registered | Use `.git/koni/runs/<run>` control state. |
| Present but run absent, invalid, or registry unreadable | Fail closed; never use legacy state. |

Atomic registry replacement makes the unlocked read observe one complete before-or-after snapshot;
it cannot parse a torn write. A concurrent unregister may make the selected run root disappear,
but `RunControlStore::lock` rechecks the root identity and fails instead of recreating it. The
absence/adoption race is linearized at the read: one operation that observes the pre-adoption
state may finish as compatibility work. If product policy later requires a project-wide hard stop
at the exact adoption instant, that needs a separate project-adoption barrier rather than a read
lock in this helper.

Two residual semantics are worth tracking but do not invalidate this bounded repair:

1. `ProjectRegistryStore::run` itself still calls `load_or_create`. Thus direct read/probe APIs such
   as `Engine::open_run` can still adopt an absent repository; the TUI deliberately guards around
   this. A later hardening should make ordinary run lookup non-creating and reserve creation for
   `register_run` / the explicit `project_registry` operation, with compatibility tests first.
2. `existing_run_control_store` resolves `registry_project_root` before retaining the caller's Git
   common-directory identity. A tampered registry whose `repository_root` points at an unrelated
   valid repository could therefore be rerouted to that repository and return `None`, rather than
   proving the original and resolved checkouts share a common directory as `Engine::open_run`
   does. Valid generated registries cannot reach this path, but a focused cross-repository-root
   corruption regression and the same common-dir check would make the helper's fail-closed claim
   complete.

### 2026-07-14 implementation boundary — `context-spec/root`

The causal owner has implemented the narrow split and is running integration checks. Please audit
these exact semantics rather than proposing an overlapping patch:

- `ProjectRegistryStore::existing_run` is a read-only atomic snapshot. `Ok(None)` means the
  registry document itself is absent; once a registry exists, a missing run remains an
  authoritative `NotFound` error.
- `existing_run_control_store` falls back only for an absent registry or Git discovery's exact
  `NotFound`. Malformed registries, wrong repository bindings, bare repositories, and a run absent
  from an existing registry propagate as errors.
- Only the three advisory/context call sites (`graph_context`, `record_graph_note`, and
  `compile_context`) use this optional resolver. Strict registered-run control-plane callers still
  use `run_control_store` unchanged.
- The state-level no-write regression and an end-to-end compatibility context/graph-note
  regression pass. The exact TUI compatibility test is next, after respecting its owner's active
  Graph Seed presentation lease.

Please report any caller that requires different semantics or any race/authority gap; do not edit
the owned Rust ranges.

#### 2026-07-14 response — `compat_registry_audit/root`

The three-call-site split, atomic absent-registry read, and existing-registry missing-run behavior
are correct and sufficient for the observed TUI and Research failures. One phrase above is broader
than the current code proves: an ordinary mismatched `repository_root` value that is unreadable or
not canonical does propagate, but a value pointing at a *different valid Git repository* is
resolved before the helper retains the caller's common-directory identity. The helper can then
inspect that second repository, observe no registry, and return compatibility `None`. Preserve the
current patch, but either add the same caller/resolved common-dir equality check used by
`Engine::open_run`, or narrow the comment and queue the explicit corruption test described below.
No other caller/race defect was found in the bounded repair.

#### 2026-07-14 blocker closure candidate — `context-spec/root`

Implemented the stronger option from the audit. `existing_run_control_store` now discovers and
retains the caller checkout first, resolves any registry-supplied project root, and requires exact
Git common-directory equality before it can inspect membership or return an absent-registry
fallback. A resolved non-Git root also propagates instead of becoming `None`.

- `optional_run_control_store_rejects_a_cross_repository_registry_redirect` — 1 passed and proves
  the redirected repository is not adopted.
- The compatibility context/note test now creates an empty authoritative registry after exercising
  the legacy path and proves all three optional callers (`compile_context`, `graph_context`, and
  `record_graph_note`) return `NotFound` instead of reading legacy state — 1 passed.
- State-level absent-registry lookup and the previously failing TUI compatibility test remain
  green before the unrelated active TUI edit entered its next source slice.

Please append a final read-only verdict if this closes the common-directory and membership gates;
the causal owner will not broaden `ProjectRegistryStore::run` in this slice.

**Additional safety hardening — `context-spec/root`:** `existing_run` now returns before lock
acquisition only when `project.yaml` is absent. A present registry retains the existing persistent
lock's no-follow traversal before parsing, so the optional API does not regress redirected-sidecar
protection. The extended symlink-sentinel test and the absent-registry no-write test both pass.

## Recommended regressions

The initial placeholder was **Pending source audit**. Current and recommended coverage is:

- Present and green: `state::tests::existing_run_lookup_does_not_create_a_project_registry`.
- Present and green: `engine::tests::graph_context_and_notes_are_ticket_scoped_advisory_supplements`;
  it exercises context compilation, graph supplements, and note writes while asserting that the
  compatibility repository remains unadopted.
- Present and green: TUI
  `app::tests::action_engine_accepts_only_the_matching_compatibility_run`.
- Present and green: all three `research_conclusion_contract` cases, proving the secondary
  “unregistered compiler authority” manifestation is closed.
- Add one focused existing-registry test that creates an empty modern registry beside a legacy
  run and proves each of the three optional callers returns the membership error instead of using
  legacy state. This protects the crucial distinction between `None` and `Err` at the call sites.
- Add one root-integrity test in which `project.yaml` points at a different Git common directory;
  require an explicit repository-identity error rather than compatibility fallback.
- As a separate follow-up, prove `ProjectRegistryStore::run` / `Engine::open_run` do not create an
  absent registry before changing that broader query contract.

## Verification log

- Documentation/persona prerequisite read completed before source inspection.
- `git status --short` reviewed; the shared worktree is intentionally dirty and no existing change
  will be reset, reformatted, or isolated.
- `cargo test -p koni-core state::tests::existing_run_lookup_does_not_create_a_project_registry
  --lib -- --exact --nocapture` — 1 passed.
- `cargo test -p koni-core
  engine::tests::graph_context_and_notes_are_ticket_scoped_advisory_supplements --lib -- --exact
  --nocapture` — 1 passed.
- `cargo test -p koni-tui
  app::tests::action_engine_accepts_only_the_matching_compatibility_run --lib -- --exact
  --nocapture` — 1 passed.
- Independent integration run reported by `primary-integrator`: all three
  `research_conclusion_contract` tests passed after the candidate repair.
- No Rust, binary, profile, cmux, Updog, or live-run state was changed by this lane.
