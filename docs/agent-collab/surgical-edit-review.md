# Surgical Edit Review

## 2026-07-16 — read-only authority and durability lease

- **Owner:** `surgical-edit-review/root`
- **Scope:** read-only review of the in-progress `edit_file` surface in
  `crates/koni-core/src/agent_tool_broker.rs` and `crates/koni-core/src/engine.rs`, plus generic Pi
  transport contracts required to evaluate the public frame bound.
- **Review domains:** public schema/transport, worker path authority and whole-file CAS, exact-one
  snippet semantics, durable reservation/receipt/replay/revocation/deletion, and focused test gaps.
- **Source mutation:** none. This mailbox and the append-only central registry are the only leased
  writes.
- **Live safety:** no Updog, installed binary, cockpit, cmux, run state, process, grant, ticket
  worktree, or Git-ref command will be issued.
- **Delegation note:** the final-review protocol calls for per-domain delegation, but all four
  collaboration slots are occupied. The domain passes are therefore local-only; the primary
  integrator remains responsible for final cross-domain acceptance.
- **Status:** `in_progress`.

## 2026-07-16 — final independent review

### Disposition

- **Verdict:** release with non-blocking P2 follow-ups. I found no open P0 or P1 defect and no
  authority, durability, replay, or Pi-transport reason to block a guarded refresh after the normal
  full gates pass and live agents have drained.
- **Review method:** two delegated, read-only domain passes independently covered (1) public
  schema/path authority/exact-match/transport and (2) durable reservation/replay/recovery/revoke/
  delete behavior. The root pass reconciled both against the integrated implementation.
- **Captured edit-surface snapshot:** `agent_tool_broker.rs` SHA-256 `886321c5…`,
  `pi_protocol.rs` `d97584b8…`, Pi `runtime.ts` `e691c5ae…`. `engine.rs` was changing in a disjoint
  prior-attempt-feedback lane, so the semantic freeze is identified by the function symbols and
  captured line references below rather than by its whole-file hash.
- **Reviewer mutations:** documentation only. No source, installed binary, live Updog state,
  process, cockpit, worktree, run, ticket, grant, or Git ref was changed.

### Current findings

#### P2 — schema length and runtime byte length are not the same contract

The public `old_text`/`new_text` schemas use JSON Schema `maxLength`, which counts Unicode scalar
values, while both broker ingress layers enforce the 64 KiB limit using UTF-8 byte length. A
multibyte snippet can therefore be schema-valid and then fail safely at dispatch. The schema
descriptions also do not tell the model that this is a byte/control-character boundary. This does
not widen authority or mutate a file, but it can waste one model/tool turn.

- Public validation: `crates/koni-core/src/agent_tool_broker.rs:536-557`
- Public schema: `crates/koni-core/src/agent_tool_broker.rs:877-898`
- Core normalization: `crates/koni-core/src/engine.rs` in
  `normalize_agent_broker_tool_arguments` (captured start `:45290`)

#### P2 — readable and surgically editable file ceilings differ

Worker reads admit a bounded file up to 512 KiB, while the shared atomic postimage writer limits a
completed file to 384 KiB. An edit of a 384–512 KiB file therefore succeeds only if it shrinks the
postimage below 384 KiB. That is fail-closed and does not affect the motivating roughly 128 KiB
file, but the tool copy should state the postimage ceiling or the limits should be aligned.

- Read ceiling: `crates/koni-core/src/engine.rs` near `MAX_AGENT_BROKER_FILE_BYTES`
- Postimage ceiling: `crates/koni-core/src/agent_tool_broker.rs:74-82`
- Enforcement: `crates/koni-core/src/engine.rs` in `worker_edit_postimage` (captured `:44138`)

#### P2 — inherited same-UID parent-directory race remains outside the stated threat model

Static authorization is strong: paths are normalized project-relative, intersected with the exact
compiler-issued step scope, checked against protected paths and aliases, and rejected if any
existing component is a symlink. Final file opens also use no-follow semantics, and mutation is an
atomic staged postimage. The shared writer is nevertheless pathname-based after canonicalization,
not descriptor-relative, so a malicious same-UID process that can swap a parent directory during
the operation is outside the protection. This predates `edit_file` and is non-blocking under the
current contained-worker/stable-worktree model.

- Normalize/protected/scope/no-follow path: `crates/koni-core/src/engine.rs:43538-43668`
- Atomic shared writer: `crates/koni-core/src/engine.rs` in `broker_worker_write_file`
  (captured `:44177`)

#### P3 — response-intent validation permits unrelated extra JSON keys

All authority-bearing response fields are now exact-bound to the durable intent. The validator
does not reject unrelated additional properties. Production responses are small Rust-generated
objects and the model cannot write the compiler sidecar, so this cannot alter mutation authority;
rejecting unknown keys would only strengthen the local-corruption story.

### Defects closed during review

- **Upgrade compatibility:** an immediately pre-edit full worker grant remains valid with its old
  catalog but does not gain `edit_file` authority. See `PRE_EDIT_FULL_WORKER_TOOL_CATALOG`
  (captured `crates/koni-core/src/engine.rs:41681`) and the regression at captured `:92714`.
- **Exact whitespace anchors:** edit text no longer goes through the trimming required-string
  parser; nonempty whitespace is preserved and tested.
- **Transport mismatch:** Rust ingress and the Pi host now share a 896 KiB escaped-argument
  ceiling, 128 KiB below the 1 MiB complete-frame limit. The maximum 384 KiB whole-file write and
  both maximum 64 KiB edit snippets fit. See `crates/koni-core/src/pi_protocol.rs:12-16`,
  `runtime/pi-host/src/runtime.ts:57,101-108`, and
  `crates/koni-core/src/agent_tool_broker.rs:1481-1556`.
- **Response-before-receipt recovery:** a persisted mutation response must now match the durable
  intent's path, postimage hash, byte count, create flag, and exactly-one replacement marker before
  either ordinary receipt persistence, exact retry recovery, or supervisor revocation can accept
  it. See `validate_worker_write_response_against_intent` (captured
  `crates/koni-core/src/engine.rs:45719`) and its adversarial regression (captured `:92762`).
- **Crash and CAS behavior:** exact edit receipt replay, postimage-before-receipt recovery,
  preimage/staged-file discard, and effect-free ambient-drift reservation cleanup now have composed
  coverage in `direct_pi_worker_grant_pages_large_context_and_recovers_write_postimage_after_reopen`
  (captured `crates/koni-core/src/engine.rs:93702`).

### Overview

#### Vision

- **Purpose/objective:** give a contained Pi worker one small, exact, hash-guarded mutation
  primitive so it need not regenerate a large file through whole-file `write_file`.
- **Priorities:** compiler-owned authority first; exact-one semantics; no authority expansion;
  whole-file CAS; durable at-most-once effects across crash/retry/revoke/delete; bounded transport.
- **Vision match:** strong. `edit_file` is a narrow frontend to the existing atomic whole-postimage
  writer rather than a second mutation subsystem.
- **Vision drift:** none material. The open P2s are contract clarity and an inherited threat-model
  boundary, not authority broadening.

#### Domains

| Domain | Review source | What it implements | Confidence or concern |
| --- | --- | --- | --- |
| Public broker contract | `agent_tool_broker.rs` | Role-bound schema, validation, minimal response, 64 KiB snippet bounds | High; byte-vs-character copy is P2 |
| Worker mutation authority | `engine.rs` path/edit/write helpers | Exact step scope, protected paths, symlink rejection, whole-file CAS, atomic postimage | High under the documented stable-worktree model |
| Durable broker state | `engine.rs` intent/reserve/receipt/recovery helpers | Semantic request hash, one in-flight reservation, exact replay, crash reconciliation | High; response is now exact-bound to intent |
| Teardown | revoke/reconcile/delete helpers | Postimage receipt, preimage stage discard, third-image fail-closed, deletion refusal | High; shared generic branch is correct |
| Pi transport | `pi_protocol.rs`, `runtime.ts` | Escaped JSON preflight and complete-frame ceiling | High; Rust and host constants are aligned |

#### Integration

| Integration surface | Why sensitive | Review result |
| --- | --- | --- |
| Existing `write_file` atomic writer | A second writer would duplicate CAS/recovery semantics | Edit computes one postimage, then delegates to the shared writer |
| Historical worker grants | Catalog growth can invalidate live durable capability state | Prior full catalog is explicitly accepted without granting the new tool |
| Response/receipt ordering | Process can die after effect or response but before receipt | Intent, response, disk state, and receipt are reconciled independently |
| Revoke and run delete | Teardown must not discard an unknown file effect | Both tools use `is_worker_write_tool`; unresolved third images block deletion |
| Pi host framing | Escaped arguments can exceed raw string estimates | Shared 896 KiB preflight plus a 1 MiB complete-frame proof |

### Philosophical review

| Paradigm | Fit assessment | Risk if wrong |
| --- | --- | --- |
| Capabilities are compiler-issued and role/step scoped | Fully aligned; normalization, reservation, execution, and replay reauthorize | Cross-ticket or protected-path writes |
| Product mutation is whole-file CAS even for a surgical API | Elegant: small model surface, one durable effect model | Lost updates or duplicate effects if bypassed |
| Durable state is authoritative; model retries are not recovery | Fully aligned; supervisor can reconcile without trusting another model turn | Duplicate writes or token-heavy recovery loops |
| Ambiguity fails closed | Fully aligned for zero, multiple, overlapping, stale, and third-image cases | Silent wrong-location edits |

### Implementation review

#### Elegance scoring

- **Overall:** `4.5/5`.
- **Rationale:** the implementation reuses scope authorization, the atomic writer, receipt storage,
  and generic revoke/delete reconciliation. The main complexity is inherent in preserving
  at-most-once effects around an atomic rename. Small deductions are for string-classified
  effect-free errors, the manual historical catalog constant, and the two public/runtime limit
  mismatches recorded above.

| Area | Score | Effective choices | Concrete simplification |
| --- | --- | --- | --- |
| Public tool | 4.5/5 | Four explicit fields; exact snippet preserved; empty replacement allowed | Document byte/postimage limits |
| Mutation core | 5/5 | One exact-match scan and reuse of atomic postimage writer | None required |
| Durability | 4.5/5 | Pre/post intent, exact request CAS, response binding, replay receipt | A typed effect-free error would be less brittle than message matching |
| Compatibility | 4/5 | Old grants retain old authority | Versioned catalogs would scale better than one manual predecessor list |
| Transport | 5/5 | Shared bound and cross-language regressions | Generate both constants from one source if the protocol evolves often |

#### Code conventions

The change follows the existing explicit `KoniError`, normalized-hash, compiler-owned persistent
file, run-barrier/grant-lock, and helper-reuse conventions. There is no database or query-load
dimension in this change; the durable state is bounded file-backed broker metadata.

### Testing

| Behavior | Current coverage | Remaining confidence gap |
| --- | --- | --- |
| Large-file surgical success, stale CAS, zero match, overlapping multiple match, whitespace match, scope, symlink | `pi_worker_product_tools_enforce_step_scope_hash_cas_and_no_follow` (captured `engine.rs:84747`) | Add explicit multibyte, deletion, 64 KiB+1, and 384 KiB postimage-boundary cases |
| Exact completed replay and one effect | Composed direct-Pi recovery test | None material |
| Ambient drift after reservation | Reservation clears only after a proven effect-free failure; fresh CAS succeeds | A typed error regression would harden refactors |
| Postimage crash/revoke and preimage staged discard | Composed direct-Pi recovery test | Add an edit-specific ambiguous third-image test |
| Persisted response versus intent | Per-field adversarial unit regression | Add a full response-file-before-receipt edit recovery case |
| Delete with mutation in flight | Generic `is_worker_write_tool` production branch | Add full delete-run fixture for edit |
| Historical grants | Pre-edit catalog regression | Add a versioned-catalog strategy before the next worker-tool addition |
| Transport | Max escaped Rust frame and Pi host admission/rejection tests | No open bound mismatch |

#### Verification observed

- `cargo test -p koni-core --lib agent_tool_broker::tests` — **11/11 passed**.
- Exact `worker_mutation_response_is_exactly_bound_to_its_durable_intent` — **1/1 passed**.
- Exact `direct_pi_worker_grant_pages_large_context_and_recovers_write_postimage_after_reopen` —
  **1/1 passed**.
- Exact `pi_worker_product_tools_enforce_step_scope_hash_cas_and_no_follow` — **1/1 passed**.
- Exact `pre_edit_full_worker_grant_remains_valid_without_gaining_edit_authority` — **1/1 passed**.
- Exact `broker_safe_errors_are_actionable_and_never_echo_internal_sentinels` — **1/1 passed**.
- `npm test` in `runtime/pi-host` — **56/56 passed** across two files.
- `cargo fmt --all --check` — passed on the reviewed snapshot.

Zero-test accidental `--exact` invocations and two intentionally interrupted duplicate-target
compiles are excluded from the evidence above. The primary integrator still owns the final whole-
workspace gates because unrelated source lanes continued changing during this read-only review.

### Proposed tweaks

| Priority | Tweak | Expected impact | Before guarded refresh? |
| --- | --- | --- | --- |
| P2 | State UTF-8 byte/control limits in tool copy, and decide how schema character bounds should represent them | Fewer safe-but-wasted retries | No |
| P2 | Align the 512 KiB readable ceiling with the 384 KiB editable postimage ceiling, or state the latter explicitly | Predictable large-file behavior | No |
| P2 tests | Add multibyte/deletion/boundary, response-present recovery, third-image, and delete-run edit cases | Better regression localization | No, given shared-path evidence |
| P3 | Reject unknown response keys and use a typed effect-free mutation error | Stronger corruption/refactor story | No |
| Future architecture | Replace manual predecessor catalogs with versioned capability catalogs | Safer future tool additions | Before the next catalog expansion |
| Threat-model dependent | Move atomic mutation to descriptor-relative directory operations | Closes malicious same-UID parent swaps | Only if that actor enters scope |

### Commit boundaries

This reviewer made no source changes. If the integrator splits the implementation, the clean
boundaries are: (1) broker schema/tool semantics and core CAS/durability, (2) Pi transport-bound
alignment and host tests, and (3) adversarial compatibility/recovery tests plus adjacent docs.

- **Status:** `complete`; read-only lease released.

### Final-snapshot correction — model-facing limits made explicit

The primary integrator accepted the first-shot clarity recommendation after the report above was
written. The final catalog snapshot is `agent_tool_broker.rs` SHA-256 `18ddc92d…` (the previously
recorded `886321c5…` is superseded); `engine.rs` is `0c6517fe…`, `pi_protocol.rs` remains
`d97584b8…`, and Pi `runtime.ts` remains `e691c5ae…`.

- `edit_file` now explicitly tells the model that each snippet is limited to **65,536 encoded UTF-8
  bytes**, identifies the only accepted control characters, and states that the resulting whole
  file must fit **393,216 bytes** (`agent_tool_broker.rs:877-895`).
- `write_file` now states the same 393,216-byte whole-file boundary
  (`agent_tool_broker.rs:860-873`).
- Therefore the earlier claim that descriptions omitted byte/control/postimage constraints is
  superseded, and the readable-versus-editable ceiling is an explicit capability boundary rather
  than an unclear current defect. The remaining P2 is narrower: JSON Schema `maxLength` is still a
  character-count hint while authoritative ingress correctly measures UTF-8 bytes and fails safe.
- The corresponding broker suite was rerun on this final catalog snapshot: **11/11 passed**.
  `cargo fmt --all --check` also passed on the final snapshot.

**Final disposition remains unchanged:** no P0/P1 and no guarded-refresh blocker. The current
actionable queue is the schema-hint mismatch plus the non-blocking adversarial test additions and
future hardening items already listed above.
