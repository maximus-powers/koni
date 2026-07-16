# Context hardening independent review

Owner: `context_hardening_review/root`

Status: `in_progress` (read-only source and focused-test review)

**Transition — 2026-07-14:** The original in-progress marker above is retained as the review's
starting state. The independent source/docs review and stable-snapshot focused verification are
now complete and accept all three hardenings for integration, with no P0/P1 source defect.

**Current verification hold — 2026-07-14:** That acceptance remains the exact earlier-save-point
verdict. Later generic step-scope work exposed and tentatively repaired scoped context-hash
self-reference, so current-tree handoff now waits for the six exact stable-fingerprint checks
recorded below. A later Pi cutover has a separate post-transport rerun gate; neither hold rewrites
the accepted causal evidence above.

Last checked: 2026-07-14 (Phoenix)

## Mission and boundary

Independently review the three released living-spec hardenings without changing Rust, profiles,
product documentation, the central registry, installed binaries, cmux/cockpit state, Updog, or
live/forensic run state:

1. require one successful `context` receipt before every new non-context worker request while
   preserving exact durable receipt replay;
2. reject new `graph_context` / `record_note` requests after `accepted_output_hash`, while
   preserving pre-output replay and atomic `submit_and_compile`;
3. reject a ticket whose target/read/write `spec_slice` anchor is missing, while preserving
   anchor-first budgeting, no root-sibling expansion, and raw-seed projection.

This lane may edit only this mailbox and append a signed read-only verdict/question to
[`context-spec.md`](context-spec.md). Source ownership and any correction remain with
`context-spec/root` or the explicitly recorded integration owner.

## Coordination and prerequisite sweep

- Read the central registry, scanned every current persona mailbox for ownership, status,
  questions, and latest handoffs, and read the full context, profile-contract, graph-note,
  seed-runtime, compatibility, and active compiler-graph mailboxes before source inspection.
- Read the affected context sections of `configuration.md` and all of `codex-resources.md`.
  Both preserve the earlier prompt-only / separate-submit contracts immediately beside dated
  enforcement and composite-boundary notes; this review will verify those claims against source.
- The shared worktree is intentionally dirty. No checkout, reset, global formatter, install,
  profile publication, or live-state action is permitted. Any Cargo check uses a private
  `CARGO_TARGET_DIR` and runs only after confirming the concurrent compiler tree is compilable.

## Review checklist

- Prove request replay is resolved before context-first and post-output rejection, and that only a
  successful context receipt unlocks new calls.
- Prove the one-way output gate closes both supplement resource types before effects/receipts, but
  does not weaken revision, exact replay, or the composite submit-and-compile transaction.
- Prove mandatory anchors are deduplicated and existence-checked before any budget truncation,
  then confirm root visibility never turns into unrelated root-sibling traversal and raw planning
  seed bytes never enter model context.
- Inspect focused test assertions for false positives, especially requests accidentally reusing a
  recorded key, failed context receipts, and anchors omitted only because of the node budget.

## Findings

Pending source inspection and isolated focused verification.

## 2026-07-14 independent verdict — accepted

The pending statement above is retained as the initial checkpoint. Current verdict: **accepted for
integration; no P0/P1 defect in the three reviewed hardenings.**

### Broker ordering and one-way closure

`validate_agent_broker_one_way_cas_with_product` resolves an exact durable receipt before any new-
request ordering rule. A worker's new non-`context` request then requires a stored successful
`context` receipt. Persisted broker grants independently integrity-check every receipt and reject
any stored receipt whose status is not `succeeded`, so a failed receipt cannot unlock this gate.

For a new request, `graph_context` and `record_note` reject once `accepted_output_hash` exists.
Exact supplement replay remains reachable because replay is checked first. The legacy submission
path still permits a changed complete revision before compile and closes it after compile; the
composite path remains exact-request/product-bound and closes a changed submission after success.
`reserve_agent_broker_tool` performs these checks while holding the run/grant boundaries and
before it writes `in_flight` or calls the effect, so rejection cannot create a graph read, note,
output, or receipt side effect.

Supplement collection remains successful-only and sequence-ordered before the compiler injects it
into the structured output. `submit_and_compile` still gathers that complete list before output
materialization and scoped compile under its one replay-safe broker reservation. This review did
not reinterpret “atomic” as rollback of an intentionally retained rejected candidate; the released
contract is one compiler-owned, replay-safe accept-and-compile boundary with no intervening model
turn or late unbound supplement.

### Mandatory living-spec anchors and bounded projection

`build_ticket_spec_slice` forms one deduplicated set from target, write, and read node IDs; rejects
the first absent node; then applies the profile node limit. Declared anchors therefore cannot be
silently dropped by truncation. All anchors are queued before optional context. Run roots may be
added when capacity remains but are never queued, so their unrelated siblings cannot consume the
ticket neighborhood.

Every ticket context and bounded graph-resource projection sends nodes through
`model_facing_context_node`. For a run root, that projection removes the raw approved
`graph_seed` and retains only the compiler-owned materialized marker, seed hash, and node/edge
counts. The semantic graph remains authority.

### Documentation and coordination history

The affected sections of `configuration.md` and `codex-resources.md` satisfy the repository's
append-preserving rule. The former additive/prompt-only receipt contracts and the earlier
`context -> submit_output -> compile` boundary remain readable beside dated spec-slice,
context-first, late-supplement, and source-complete composite-boundary notes. The newly corrected
Ticket lifecycle in `runtime-and-git.md` likewise keeps its earlier four-step shorthand and adds an
adjacent dated grant-first/context-first clarification.

The final mailbox rescan included the newly added context-docs, docs-history, product-doc scan,
Software specialist, and TUI handoffs. One documentation-only inconsistency remains outside this
lane: `compiler-graph-tdd.md` still says context ordering is prose-only and future work in its
disjoint-claim paragraph, without an adjacent completion note, while this mailbox,
`context-spec.md`, `profile-contract-audit.md`, and the central rows record enforcement as released.
`docs_history_audit/root` independently confirmed that exact stale paragraph and will include it in
the repository-wide verdict. The compiler lane also still owes the separately requested delegated-
specialist mailboxes before its own release. Neither item weakens the reviewed runtime behavior,
but both remain documentation/handoff gates for their owner.

### Independent verification

The first private-target pass crossed an unrelated active compiler edit after two tests had
passed; its later E0063 missing-initializer errors were recorded as a moving-snapshot non-result and
not attributed to context. After the compiler owner published a compilable save point, the five
exact checks below each executed one test and passed against the unchanged core fingerprint
`engine.rs = 477a7164f43a4316784cd97bdf71e72fad6dcbdf291d0ae65c85a28237394087`:

- `worker_broker_cas_allows_revision_then_closes_on_exact_compile` — 1/1;
- `ticket_spec_slice_rejects_missing_anchors_and_never_expands_root_siblings` — 1/1;
- `model_context_replaces_raw_planning_seed_with_bounded_projection` — 1/1;
- `broker_binds_ordered_graph_supplement_receipts_to_worker_output` — 1/1;
- `broker_receipt_matrix_covers_worker_and_lead_replay_boundaries` — 1/1.

All commands used `--locked` and
`CARGO_TARGET_DIR=/tmp/koni-context-hardening-review-target`. No Rust, profile, product-document,
central-registry, installed-binary, cockpit/cmux, Updog, or live/forensic state was changed.

Two test-strengthening ideas remain nonblocking: explicitly assert that both new supplement types
are admitted after context but before output acceptance, and add the already queued real-broker
`context -> supplement(s) -> submit_and_compile` integration case. Source inspection plus the
focused checks above establish the current contract without either addition.

### 2026-07-14 post-verdict moving-snapshot hold

The accepted fingerprint above remains valid causal evidence, but it is not being silently
promoted to a later moving snapshot. Immediately after that run, three new generic/Software review
mailboxes appeared and the separately leased graph-TDD engine began multi-anchor and
source-manifest/submit-order repairs. Their findings do not alter either reviewed context helper,
but final current-tree handoff is held until that owner records a stable save point, every new
mailbox delta is read, and the same five exact context checks rerun on one unchanged fingerprint.
No failure from that active compiler interval is attributed to context.

### 2026-07-14 coordination-rescan transition

The earlier documentation/handoff observations remain above as causal history. A later full
mailbox inventory contains 36 persona files. The compiler owner has now retained its former
prompt-only context-ordering statement and appended the released broker-enforcement resolution;
the separate config/state/expression, verification, and graph-set integration records also now
exist with explicit released handoffs. Those two earlier coordination gaps are therefore closed
without rewriting their original observations.

The current generic compiler/Software tree is still moving for disjoint proof-authority work:
complete review-effect selection/target provenance, exact two-effect replay coverage,
source-manifest/executable authority, and proof-source versus production-path separation remain
under their owning reviews. They are cross-domain release gates, not evidence of a defect in the
three context hardenings reviewed here. Per the parent integrator's explicit hold, this lane will
not chase intermediate source fingerprints or rerun Cargo until the compiler and Software owners
publish one stable release/save point. No source, profile, product document, central registry,
binary, cockpit/cmux, Updog, Git ref, or live/forensic run state changed during this rescan.

### 2026-07-14 later context-idempotence regression routed from broad Research coverage

The accepted context-hardening fingerprint above remains valid for its exact save point, but a
later graph-TDD step-scope refactor exposed a new cross-domain context regression in
`catalog_formulation_ticket_squash_integrates_from_ticket_worktree`: selecting a scoped step from
the live ticket workflow reintroduced its previously issued `context_hash` into the next context
document, so otherwise identical repeated issuance produced a different hash. The dedicated
read-only diagnosis is retained in `graph-tdd-research-regression.md`; it correctly classifies this
as generic context construction, not Research profile behavior.

The current in-flight source candidate again clears workflow context hashes on `context_ticket`
and selects the scoped step from that sanitized clone while retaining the new effective step node
and path scopes. That is the minimal compatible repair, but this lane does not call it released
from source inspection. Final context handoff now additionally requires the exact Research
idempotence regression to pass on the parent's stable fingerprint, alongside the five narrow
checks already listed. The same broad run also exposed a disjoint tracked review-effect diagnostic
ordering mismatch; it remains with the generic replay owner and is not conflated with broker
context ordering or supplement closure. No Rust, profile, product documentation, central registry,
binary, cockpit/cmux, Updog, Git ref, or live/forensic run state was changed by this review note.

### 2026-07-14 Pi-runtime compatibility question

Later coordination added a source-only Pi SDK/runtime/schema-2 migration that explicitly replaces
Codex launch, session, MCP transport, and model-discovery call sites and introduces a new
`AgentToolBroker` adapter. The provider transport may change, but it must not become a parallel
authority path. Every Pi worker tool request must still enter the compiler-owned pinned grant and
the same one-way broker reservation/CAS boundary reviewed above: exact durable replay first,
successful `context` before any new non-context request, accepted-output closure for new graph/note
supplements, ordered successful supplement binding, and replay-safe `submit_and_compile`.

This requirement has been routed to `primary-integrator/root` for the Pi runtime architect. Until
the integrator clarifies whether the transport cutover is part of the same frozen fingerprint,
this lane will not assume that green pre-cutover broker tests prove the post-cutover launch path.
No Pi source, runtime source, product documentation, profile, central registry, binary,
cockpit/cmux, Updog, Git ref, or live/forensic state was changed by this coordination note.

#### Integrator disposition

`primary-integrator/root` confirms two deliberately separate gates. This bounded compiler-context
review may close after its six exact checks pass on one declared stable compiler save point. That
result is pre-Pi evidence only. The whole-project refresh fingerprint must wait for the Pi cutover,
then rerun the same six checks plus the Pi broker/transport adapter regressions proving every tool
still crosses the compiler grant/CAS boundary. The earlier context verdict must never be
reinterpreted as post-cutover release evidence.

### 2026-07-14 bounded handoff and slot release

Current bounded verdict: **the three original context hardenings remain accepted for their exact
pre-Pi save point; current-tree verification is held, not failed.** No declared stable compiler
fingerprint exists after the later scoped-context repair and concurrent review-effect,
proof-preparation, direct-member, checkout-currentness, path-disjointness, Software, and Pi work.
Accordingly, the required six-check rerun—including
`catalog_formulation_ticket_squash_integrates_from_ticket_worktree`—has deliberately not been run
or claimed on this moving tree.

Immediately before this handoff I re-listed and rescanned all 48 current persona mailboxes, the
central registry, every current top-level product document, and the new `pi-runtime.md` contract.
The docs retain the accepted pre-Pi result beside the current hold, and the Pi contract explicitly
keeps Rust/compiler grant, context-first, CAS/replay, supplement-closure, and composite-submission
authority. No new contradiction changes this bounded verdict. Open generic review-effect,
proof-preparation/path-authority, expanded Software, and Pi security/integration findings remain
owned release gates and are not silently waived here.

Per `primary-integrator/root`, this lane now releases its active slot. The parent will reactivate
`context_hardening_review/root` after compiler, Software, and Pi release for the final immutable-
fingerprint pass: rerun the six context checks plus Pi broker/transport adapter regressions and
inspect the final launch path before any post-cutover or whole-project release claim. No test,
source, profile, product documentation, central registry, binary, install, cockpit/cmux, Updog,
credential, Git ref, or live/forensic run state was changed during this final handoff.
