# Graph Note Hardening

Owner: `context-spec/graph_note_hardening`

Status: `ready_for_integration`

Last checked: 2026-07-14 (Phoenix)

## Mission

Harden durable graph-note provenance and append-only state handling without
changing graph semantics or the engine-facing workflow.

## Current ownership

- `crates/koni-core/src/control.rs`
- focused graph-note tests colocated in `control.rs`
- this coordination file

I will not edit `engine.rs`, CLI code, profile files, the main collaboration
registry, or another agent's persona file.

## Decisions

- New provenance fields on `GraphNoteSource` remain optional and are omitted
  from serialized YAML when absent, preserving compatibility with old notes.
- Existing note content, source provenance, and supersession lineage are
  immutable after first append.
- `write_graph_note` permits only explicit one-way lifecycle transitions;
  exact replay is idempotent.

## Released API shape

`GraphNoteSource` now has these backward-compatible provenance fields:

- `agent_id: Option<String>`
- `attempt: Option<u32>`
- `profile_hash: Option<String>`
- `graph_hash: Option<String>`
- `node_hash: Option<String>`
- `context_hash: Option<String>`

Every field uses `serde(default, skip_serializing_if = "Option::is_none")`.
The persistence layer intentionally treats string values as opaque provenance.

`RunControlStore::write_graph_note` now requires a record previously created
through `append_graph_note`. It accepts an identical replay or these state
transitions only:

- `working -> confirmed | superseded | invalidated`
- `confirmed -> superseded | invalidated`

The schema version, ID, node, kind, body, source, and `supersedes` lineage are
immutable. Superseded and invalidated notes are terminal.

## Questions / inbox

- For `context-spec/root`: I am treating provenance hashes and `agent_id` as
  opaque optional strings and `attempt` as an optional unsigned integer, with
  no content-format validation in the persistence layer. Leave any contrary
  requirement here before integration; I will proceed with that bounded
  assumption.

### 2026-07-14 — response from `context-spec/root`

Accepted. Keep `append_graph_note` as the sole creation path and require an
existing immutable record for `write_graph_note`; current repository callers
use it only for state transitions. Opaque optional hash/agent fields and
`Option<u32>` attempt are also the intended persistence boundary. Engine-side
recording now populates all six fields.

## Verification

- `CARGO_TARGET_DIR=/tmp/koni-context-spec-target cargo test -p koni-core graph_note --lib -- --nocapture`
  — 5 passed, 0 failed.
- Tests cover old-shape YAML omission/defaulting, full provenance round-trip,
  sole-append creation, immutable rewrite rejection, every permitted state
  transition, exact replay, downgrade rejection, and terminal-state rejection.
- Path-scoped `git diff --check` is clean.

## 2026-07-14 docs-evolution note — `primary-integrator`

If persistence/provenance invariants change a broader design doc, preserve the prior graph-note
model and append a dated **Evolving to** note with compatibility rationale. Keep this mailbox's
earlier decisions visible when marking the implementation released.

## 2026-07-14 final adversarial integration audit

Current verdict: **accepted; no remaining P0/P1 release blocker in the living-spec context,
graph-resource, note-provenance, receipt-binding, or composite-submission surfaces.** This verdict
preserves the earlier `ready_for_integration` handoff and records the integrated state rather than
replacing that history.

The audit initially found one release blocker in the retained two-call worker flow: a worker could
successfully call `submit_output`, then create a new `graph_context` or `record_note` receipt that
could no longer enter the already-durable `StepOutput`. The integrated broker CAS now resolves an
exact recorded receipt first, then rejects every new graph supplement after
`accepted_output_hash`. The same reservation boundary now requires a successful `context` receipt
before any new non-context worker action. Rejected calls therefore occur before graph, note, or
output effects, while exact historical replay remains available.

The final code read verified these contracts:

- ticket context contains the legacy contract plus authoritative `spec_slice`, scoped
  `intent_updates`, advisory `working_memory`, explicit authority order, and independent content
  hashes; missing mandatory ticket anchors fail closed and raw approved planning seeds are reduced
  to a compiler-owned hash/count projection;
- `graph_context` is read-only, ticket-anchor scoped, profile relation/type/depth/node/byte/call
  bounded, deterministic, and returns only model-facing graph fields plus advisory notes;
- `record_note` is graph-neighborhood scoped and append-only, records run/ticket/step/agent/attempt/
  persona/profile/graph/node/context provenance, supports same-run/same-node supersession, and
  cannot acquire typed-graph authority;
- working memory excludes retired lineage, prefers newest current notes under its byte budget, and
  reports current, stale-node-revision, missing-node, or legacy-unbound provenance status;
- only successful `graph_context` and `record_note` receipts are sorted by broker sequence and
  injected through the compiler-only field into the typed `StepOutput` before its durable write;
- `submit_and_compile` remains one replay-safe broker boundary, and the legacy submission/compile
  aliases can no longer admit a successful but unbound late supplement.

Independent final checks on the current shared tree passed 1/1 each:

- `worker_broker_cas_allows_revision_then_closes_on_exact_compile`;
- `graph_context_and_notes_are_ticket_scoped_advisory_supplements`;
- `ticket_spec_slice_rejects_missing_anchors_and_never_expands_root_siblings`;
- `working_memory_prefers_newest_current_notes_under_a_tight_budget`;
- `broker_binds_ordered_graph_supplement_receipts_to_worker_output`.

Two nonblocking follow-ups remain suitable for a later ergonomics/testing slice: profile-limit
rejections for graph/note resource calls currently collapse to the safe non-retryable
`validation_stop` instead of exposing a bounded “narrow or shorten this request” correction, and a
single real-broker test could compose `context -> graph_context/record_note ->
submit_and_compile` end to end in addition to the focused component regressions. Neither weakens
the current authority, provenance, replay, or receipt-completeness invariants.
