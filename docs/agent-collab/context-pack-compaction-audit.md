# Context-Pack Compaction Audit

Owner: `context-pack-compaction-audit/root`

Status: `complete` (read-only source/live-state audit; implementation lease unclaimed)

Last checked: 2026-07-15 (America/Phoenix)

## Mission and boundary

Trace the exact compiler and direct-Pi path that builds a ticket worker context, explain why the
preserved Updog proof worker receives roughly 111 KiB before it reads one product file, and define
the smallest versioned implementation that makes the initial pack step-relevant without weakening
scope, authority, currentness, receipt, replay, or pinned-run safety.

This lane changed no Rust, profile, template, test, live run, ticket/worktree, binary, process,
grant, broker response, or cmux surface. It inspected the preserved run read-only and writes only
this mailbox plus one append-only central coordination note.

## Exact live evidence

Run `019f66a9-df5a-7302-a3e1-00482d37a7ab`, proof ticket
`TK-63a91afabf98af03`, selected step `author-historical-baseline`, emitted several semantically
related packs as review and steering state evolved. The largest observed manifest was
`.../context/e95d3bc11c09a60e/manifest.yaml` at 113,047 bytes. The most useful complete rework sample
for section attribution is `.../context/ecd9ccee2835d663/manifest.yaml`:

| Section | Bytes | Why it is large or redundant here |
| --- | ---: | --- |
| `spec_slice` | 38,547 | Twelve-node ticket-wide depth-two BFS. It repeats all five step graph nodes and includes the approved 7,028-byte planning-stage output. |
| `contracts` | 31,239 | Full graph-authoring schemas, required fields, mutation intent, and payload examples even though the selected step declares `graph_mutation: forbidden`. |
| `reviews` | 9,865 | Complete durable review records and agent bindings even though `review_rework` already projects the actionable latest findings/evidence. |
| `ticket` | 8,409 | Operational ticket fields plus a copy of the selected workflow step. |
| `graph_closure` | 7,691 | The exact five step-scope nodes, all five duplicated inside `spec_slice.nodes`. |
| `selected_step` | 3,439 | The necessary exact step/check-set contract, also copied under `ticket.workflow[0]`. |
| `review_rework` + `operation_acceptance` | 4,783 | Necessary bounded rework and acceptance boundary; retain. |
| `intent_updates` | 1,234 | Necessary scoped steering; retain. |
| all other sections | 6,497 | Profile/run identity, provenance, working memory, and small empty outputs. |
| **document** | **111,684** | 2,324 lines; direct Pi must page it in 32 KiB pieces. |

The living-spec overlap is exact: `graph_closure` contains five nodes and all five IDs also occur in
the twelve-node `spec_slice`. The remaining seven spec-slice nodes are breadth-first contextual
neighbors. Its run-root objective alone is 13,749 compact JSON bytes: the exact 4,591-byte user
outcome plus 7,328 bytes of the approved combined-plan transcript. The latter already carries an
`output_hash`, and its semantic graph seed is materialized in the typed graph.

Pretty serialization contributes materially too. The exact sample is 111,520 JSON bytes when
pretty-printed and 86,126 bytes when serialized compactly. This is a transport/page cost rather
than the main semantic cost.

Independent runtime corroboration is recorded by
[`smoke-run-efficiency-audit.md`](smoke-run-efficiency-audit.md): thirteen Implementer launches
consumed 1,201,164 context-document bytes before their product reads. That audit owns aggregate
run-token attribution; this one owns only the context compiler diagnosis/design.

## Exact construction and consumption path

1. The compiler-appended worker assignment at `crates/koni-core/src/engine.rs:23694` requires the
   first worker action to be `koni_runtime.context`.
2. `DurableAgentToolBroker` exposes the worker `context` tool in
   `crates/koni-core/src/agent_tool_broker.rs:724-727`. The request reaches
   `execute_agent_broker_operation` at `engine.rs:39045`; its worker/context branch validates empty
   arguments and calls `execute_broker_ticket_action("context", ...)` at `engine.rs:39070-39087`.
3. `execute_broker_ticket_action` (`engine.rs:37806-37825`) resolves the pinned profile action and
   filters the injected ticket/step/persona parameters to its configured parameter schema. New
   Software installs define that action in `crates/koni-cli/templates/software/actions.yaml:53-62`:
   validate the ticket, invoke `context.compile` with the exact ticket and step, then append the
   issuance event. Research has the analogous explicit include contract in
   `profiles/research/actions/research.yaml:74-89` and its template mirror.
4. The primitive dispatcher maps `context.compile` to `Engine::compile_context` at
   `engine.rs:16579`. `compile_context` begins at `engine.rs:20843`.
5. `compile_context` expands owned scope, restores completed step bindings for an unscoped observer
   read, and selects either the tracked graph or the git-common private candidate projection
   (`engine.rs:20843-20888`). It then sanitizes a ticket clone, selects the exact step, and narrows
   the clone to `effective_step_{read,write}_{nodes,paths}` (`engine.rs:20889-20947`). Those helpers
   and `ticket_with_step_scope` are at `engine.rs:46561-46587`.
6. Direct dependency outputs are selected only from `step.depends_on`, and the graph contract
   selection is derived by `context_contract_selection` (`engine.rs:20666-20840`). This selection
   already fails closed if pruning would remove a relation needed by a writable existing node.
7. The default include set at `engine.rs:21079-21103` still requests graph closure, living-spec
   slice, intent, memory, ticket, contracts, outputs, and review for every selected step. The
   compiler then creates the full graph-authoring payload contract (`engine.rs:21104-21392`). It
   does not currently condition those schemas on `Step.graph_mutation`.
8. `build_ticket_spec_slice` is called with the original ticket at `engine.rs:21407-21413`, not the
   step-scoped `context_ticket`. The helper at `engine.rs:52817-52905` correctly validates every
   ticket target/read/write anchor, then expands a stable depth/node-bounded bidirectional BFS.
   Because this is ticket-wide while `graph_closure` is step-scoped, the two have different
   selection purposes but serialize duplicate node bodies.
9. `model_facing_context_node` (`engine.rs:52769-52815`) removes compiler-owned projections and raw
   planning `graph_seed`, but deliberately retains the full approved planning-stage output.
   `bounded_graph_working_memory` and `relevant_steering_events` add advisory notes and scoped
   steering. All durable reviews are inserted at `engine.rs:21514-21526`, beside the already
   bounded `review_rework_context` (`engine.rs:31957-32005`).
10. The complete JSON value is hashed with `normalized_hash`, pretty-printed, and written beneath
    the first sixteen hex characters of that semantic hash at `engine.rs:21531-21599`. The same
    hash is written to the selected step, `issued_context_hashes`, the context-pack receipt, and
    the action result at `engine.rs:21600-21649`.
11. The broker resolves exactly one compiler-issued path, reads only that contained work namespace,
    and calls `broker_context_tool_response` (`engine.rs:37827-37875`). Direct Pi gets a 32 KiB
    preview when the document is larger; `read_file` may page only the exact path reconstructed
    from `step.context_hash` (`engine.rs:38257-38368`). Tool response/replay hashes remain durable.
12. Output recording copies the current `step.context_hash` into `StepOutput` at
    `engine.rs:18301-18326`. Current-output lookup requires exact step/hash equality
    (`engine.rs:28228-28236`), while `step_receipt_requirement_satisfied` binds the issued context
    map, context-pack receipt, output, and scoped-compile receipt at `engine.rs:30366-30415`.

The important conclusion is that model-facing size is not the authority mechanism. Authority is
enforced by the selected step/scope, profile and grant bindings, compiler actions, exact context
hash, durable receipt, output hash equality, and scoped compile. A smaller deterministic
projection can retain those invariants if every omitted authoritative source is committed by a
hash and mandatory validation still runs before projection.

## Minimal implementation design

### 1. Derive one projection mode from existing configured primitives

Add a private `WorkerContextNeeds`/`ContextProjectionMode` beside
`ContextContractSelection`; do not add Software- or Research-specific branches.

For an explicitly selected step:

- use `graph_authoring` whenever `step.graph_mutation != Forbidden`;
- use `graph_analysis` when mutation is forbidden but the selected contract closure contains a
  gate policy or named gate-policy query (and conservatively for any case not clearly product
  execution);
- use `product_execution` only when mutation is forbidden, no gate policy/query contract is
  selected, and the step has a nonempty effective product-path scope or compiled check set;
- retain the current full observer projection when no step is selected.

This uses `Step.graph_mutation`, effective step paths/checks, dependencies, and compiler-selected
gate contracts—the configured primitives that already describe the work. It deliberately avoids
persona-name, profile-ID, operation-name, or project hard-coding. The conservative fallback matters:
Research's `compile-gate-stack` is graph-forbidden but its current regression requires the selected
canonical edge, gate policy, and named query contracts
(`crates/koni-core/tests/research_profile.rs:775-900`).

### 2. Keep full validation, then project only the model presentation

Continue building the current complete `spec_slice` first. This preserves mandatory target/read/
write-anchor rejection, the profile depth/node budget, deterministic ordering, and the existing
`spec_slice_hash`. Only after that succeeds should a new helper such as
`model_facing_step_spec_slice(...)` create the `product_execution` view:

- `graph_closure` remains the exact step-scoped node array already selected from
  `context_ticket.scope`;
- `spec_slice` keeps authority/instruction, root IDs, mandatory anchor IDs, limits, truncation, and
  the run-root objective projection, but does not repeat any node already serialized in
  `graph_closure`;
- add `step_graph_ref: "#/graph_closure"`, the referenced node IDs, and exact omitted-node/edge
  counts so absence cannot be mistaken for completeness;
- omit optional breadth-first neighbor bodies from the initial product-execution pack. The existing
  bounded, ticket-anchored `graph_context` tool remains the explicit escape hatch for a concrete
  missing fact and cannot widen write authority.

For a run-root whose approved planning context says its seed was materialized, retain the exact
root title/outcome/scope/success fields but replace each `planning_context.stages[].output` with its
existing stage ID, title, output hash, byte count, truncation flag, and a
`materialized_in_typed_graph` marker. Do not apply this projection to a seedless legacy root: if
there is no materialization proof, retain the stage output rather than silently dropping intent.

`graph_authoring` and conservative `graph_analysis` keep the current complete spec slice until a
separate measured design proves a smaller read/schema projection. This makes the first change
high-impact for Software product workers and low-risk for Research semantics.

### 3. Compile a non-authoring contract for product execution

Build `contracts` from the same `ContextContractSelection`, but for `product_execution` retain only:

- operation/output/review acceptance text and `gate_blocking_exempt` meaning;
- exact step-scoped scope, output submission, and change-control contract;
- the ordinary scalar/list output envelope (`summary`, findings, risks, receipts, file declarations,
  patch/recommendation, structured output);
- an explicit `graph_delta_policy` saying the selected step is forbidden to mutate the graph.

Do not serialize node authoring schemas, allowed outgoing edge authoring tables, mutation intent,
new-node field examples, or semantic graph-delta instructions into a step that the compiler will
reject for emitting a material graph delta. Keep the existing selected gate policy/query/edge
contracts in `graph_analysis`; keep the complete authoring contract in `graph_authoring`.

This should be a projection helper called by `compile_context`, not a relaxation of
`context_contract_selection` or output validation. The full selection still runs and its hash is
retained, so compiler safety and diagnostics do not depend on what the model sees.

### 4. Replace ticket/review duplication with bounded projections

Add `model_facing_context_ticket` that retains ticket ID/title/operation/status, profile/rule/state
keys, targets, exact step-scoped scope, blockers/obligations, change-control summary, and a compact
workflow identity for the selected step. Keep the full selected step once at top level, including
its compiled check sets, expected output, dependencies, required receipts, stop/escalation rules,
and effective path/node authority. Omit lease/process fields, compiler extensions, and the second
full step copy under `ticket.workflow`.

Replace raw `reviews: ticket.reviews` with a model-facing array containing at most the latest
review relevant to the selected rework boundary (status/time, findings, evidence pointers). Keep
the existing `review_rework` and `operation_acceptance` unchanged. Add count/omitted-count/history
hash metadata; never label an empty projection as “no reviews.” Durable review records remain in
compiler state and independent review packets remain unchanged.

### 5. Make omitted authority explicit in provenance

The compact document must include, in addition to the existing profile/graph/spec/intent/memory
hashes:

- `contract_selection_hash` (already computed for manifest size stats);
- `ticket_context_source_hash`, computed from the current sanitized `context_ticket` before its
  model-facing projection;
- `review_history_hash`, computed from the exact durable review vector;
- hashes of direct dependency/prior output projections (or one ordered aggregate hash).

The final `context_hash` remains `normalized_hash(&context_document)`. It therefore transitively
commits to every omitted source while binding the exact compact instructions the worker actually
received. Do not split receipt validation between a presentation hash and an authority hash; one
document hash containing the authority commitments preserves the current simple equality chain.

### 6. Version the transport representation and keep artifacts immutable

Emit context schema/presentation version `1.1` for the new selected-step projection and serialize
its JSON with `serde_json::to_string` rather than `to_string_pretty`. The version is part of the
document value, so the semantic context hash and artifact directory change before formatting
changes. This avoids overwriting a v1.0 pretty artifact at the same content-addressed path with
different raw bytes. Keep the JSON fence so current readers continue to parse it.

Add projection mode, format, source bytes, emitted bytes, and per-section savings to manifest
`size_stats`. Never silently truncate a required section merely to hit a byte target; fall back to
paging with an explicit largest-section diagnostic. The 64 MiB broker safety ceiling and 32 KiB
direct-Pi preview remain transport bounds, not permission to ship an unbounded semantic pack.

The legacy unscoped observer path should remain unchanged in the first patch. Existing context
artifacts are immutable and coexist by hash. A worker already holding a successful context receipt
continues through exact broker replay; refresh only at a no-live-agent boundary, as required by the
general guarded-refresh contract.

## Measured target

A read-only `jq` projection of the exact 111,684-byte live sample applied the design mechanically:

- retained the exact user outcome, graph closure, selected step/check set, rework, operation
  acceptance, steering, memory, direct outputs, profile, and provenance;
- projected the materialized planning stage to metadata/hash;
- removed duplicate spec-slice step nodes and optional BFS neighbor bodies;
- projected product-execution contracts, ticket, and review history;
- compact-serialized the result.

It measured **33,938 pretty bytes / 28,249 compact bytes**, a **74.7% compact reduction** from the
live document and below the current 32 KiB direct-Pi preview threshold. This is a design estimate,
not implementation evidence. The implementation regression should use the real compiler-produced
Software proof context and hold the same one-response property without hard-coding this one run's
hash or node IDs.

## Exact test plan

### Engine/unit tests (`crates/koni-core/src/engine.rs`)

1. Extend `ticket_spec_slice_rejects_missing_anchors_and_never_expands_root_siblings` to prove the
   full authority slice is validated before a product-execution presentation is compacted; a
   missing ticket-wide anchor must still fail even when that node would be omitted from the model
   projection.
2. Extend `model_context_replaces_raw_planning_seed_with_bounded_projection` with an approved
   stage output. Assert the exact outcome remains, raw stage output disappears only when graph-seed
   materialization is true, and stage output hash/count metadata remains. Add the seedless legacy
   inverse assertion.
3. Add `product_execution_context_uses_step_relevant_projection`: graph mutation forbidden,
   nonempty path/check scope, no gate contracts. Assert exact selected step/scope/checks, goal,
   direct outputs, steering, rework/acceptance, graph nodes, and payload declarations remain; assert
   no duplicated graph node bodies, authoring node schemas, mutation intent, raw review bindings,
   lease/process identity, or full planning transcript.
4. Add `graph_authoring_context_retains_complete_authoring_contract`: mutation required/allowed
   still exposes required field shapes, enum values, outgoing edges, mutation intent, graph-delta
   examples, and integration dependency instructions.
5. Add `graph_analysis_context_retains_selected_gate_contracts`: mutation forbidden plus selected
   gate policy/query remains conservative and preserves the canonical edge/policy/query contract.
6. Add `compact_context_hash_commits_to_omitted_authority`: independently change the omitted
   planning-stage body, an older durable review, the sanitized ticket workflow, and a selected
   contract. Each must change the appropriate provenance hash and final context hash even when the
   omitted bytes never appear in the document. An unrelated product-file edit must not change the
   semantic context hash.
7. Add `review_rework_projection_is_latest_bounded_and_history_bound`: append multiple large failed
   review records. The model sees only the exact latest actionable findings/evidence, the history
   count/hash changes, internal agent/review IDs remain absent, and document growth is constant
   rather than linear.
8. Preserve `failed_review_context_prioritizes_actionable_rework_without_internal_identity`,
   `workflow_step_scope_is_narrow_and_legacy_compatible`, and
   `replacement_context_observes_only_pre_output_in_scope_sidecar_edits` unchanged.

### Cross-profile/integration tests

9. Extend `crates/koni-core/tests/research_profile.rs`:
   - `catalog_formulation_ticket_squash_integrates_from_ticket_worktree` still proves exact repeated
     issuance is idempotent and selected-step `context_hash` never self-references;
   - `context_contract_selection_is_stable_under_unrelated_profile_additions` still proves profile
     additions perturb the full profile-bound context but not the selected contract hash;
   - `representative_gate_context_is_compact_and_keeps_one_canonical_gate_relation` continues to
     assert graph-forbidden Research gate analysis receives the policy/query/canonical edge.
10. Add a Software-profile integration fixture using the bundled `proof-preparation` workflow and
    a realistically long approved goal/plan. Compile `author-historical-baseline`; assert schema
    1.1/product-execution mode, direct-Pi document bytes at or below
    `MAX_AGENT_BROKER_CONTEXT_PREVIEW_BYTES`, no hidden authority loss, and a second unchanged
    issuance returns the same hash/path/bytes.
11. Extend the direct-Pi broker regression
    `direct_pi_worker_grant_pages_large_context_and_recovers_write_postimage_after_reopen` only for
    transport compatibility: v1.0 large contexts still page/replay, while a real compact Software
    context returns in one successful context response; context-first, supplement closure, CAS,
    and replay counts remain unchanged.
12. Keep `crates/koni-core/tests/research_result_contracts.rs::research_context_action_includes_every_living_spec_layer`
    green. Explicit Research include lists must continue to request every named layer; projection
    happens inside the layer, not by silently ignoring profile configuration.

### Release matrix

- focused context/projection/hash/rework tests;
- Software profile/integration tests;
- Research context/profile/result-contract tests;
- direct-Pi broker/CAS/replay tests;
- full `koni-core --lib`, lifecycle, CLI, and warning-denied Clippy;
- formatting/diff checks;
- one fresh Medium Updog run comparing context bytes, context tool turns, new/cached worker tokens,
  retries, and proof outcome against this preserved run. Do not use the preserved run as the
  mutable test fixture.

## Compatibility and failure risks

1. **Research gate analysis is the main semantic trap.** Graph-forbidden does not always mean
   schema-free. The selected gate-policy/query fallback above is mandatory.
2. **Raw planning output may contain unmaterialized intent in legacy profiles.** Strip it only when
   the approved root carries compiler-owned materialization evidence; otherwise retain it.
3. **A compact slice must not hide corrupt authority.** Always build/validate and hash the full
   mandatory-anchor slice first. Projection is presentation, not selection authority.
4. **Changing only whitespace under the same context hash breaks replay identity.** Version the
   document value before switching serialization so raw bytes and path remain immutable.
5. **Existing custom personas may mention legacy paths such as `spec_slice.nodes`,
   `contracts.node_types`, or `ticket.workflow`.** Keep their container types stable in 1.1,
   include explicit projection/reference metadata, and update the compiler-appended protocol to
   condition graph-authoring guidance on `selected_step.graph_mutation`. Treat any profile prompt
   with hard assumptions as a compatibility test, not a reason to duplicate all data forever.
6. **Explicit selected-step reissuance intentionally replaces that step's context binding.** A
   guarded refresh must not reissue under a live worker. Completed outputs remain protected by the
   existing unscoped restoration logic; test that invariant.
7. **Do not compact dependency outputs into prose.** Direct dependencies remain exact structured
   evidence, with the existing materialized graph-delta projection and causal receipt binding.
8. **Byte bounds must not become semantic truncation.** If a required exact goal, steering event,
   dependency output, or review finding alone is large, retain it and page. Report the dominant
   section so the profile/plan can be repaired deliberately.

## Handoff

No implementation owner is claimed. The safest first source lease is confined to the context
projection helpers and `compile_context` assembly/serialization in `engine.rs`, plus focused tests;
`context_contract_selection`, output validation, broker currentness, receipts, review packets,
profile actions, and live runtime state should remain behaviorally unchanged. Coordinate with the
primary integrator before touching `engine.rs`, which is a high-overlap file.

## 2026-07-15 implementation addendum

The earlier read-only handoff above is preserved as the design record. After an explicit source
lease from `primary-integrator/root`, the smallest safe projection was implemented only in
`crates/koni-core/src/engine.rs`:

- `ContextProjectionMode::ProductExecution` is selected only for an explicit step whose graph
  mutation policy is `forbidden`, whose selected gate-policy and gate-query sets are empty, and
  whose exact effective path scope or compiled check set is nonempty. Every other context remains
  `Full`, including unscoped Lead reads, graph authors, reviewers, seedless analysis, and Research
  `compile-gate-stack`. A pending compiler-transition rework also forces `Full` because its
  actionable instruction explicitly references `contracts.mutation_intent`.
- The compiler still calls `build_ticket_spec_slice` with the original ticket before projection,
  so every ticket-wide target/read/write anchor is validated and the full source slice is hashed.
  Schema `1.1` then removes only graph bodies already present in `graph_closure`, all-closure edge
  duplicates, and materialized planning-stage prose. Seedless legacy output remains verbatim.
- Product-execution contracts retain the exact operation, scope, output submission, change
  control, payload scalar/list/structured-output shapes, and explicit forbidden graph policy, but
  omit graph-authoring schemas and mutation examples. The selected `Step` remains complete at the
  document root, including compiled check sets; the ticket keeps semantic state/scope/blockers and
  references that selected step without duplicating its body.
- Exact dependency/prior outputs, steering, memory, rework, operation acceptance, and typed graph
  state are unchanged. Review presentation is bounded to the latest semantic status/findings/
  evidence without internal agent/review identity. Provenance commits to the complete pre-projection
  ticket, review history, selected contract set, dependency outputs, prior outputs, full spec slice,
  graph, steering, and memory.
- Only schema `1.1` uses compact JSON. Its version is inside the hashed document before the byte
  format changes, so it cannot overwrite a schema `1.0` pretty document at the same content path.
  Schema `1.0` document composition and serialization remain unchanged. Oversized required exact
  material still follows the broker's paged response; there is no semantic byte truncation.

The end-to-end regression compiles the same product context twice with more than 100 KiB each of
materialized planner prose, raw review binding, and operational ticket state. It proves a stable
context hash, schema/manifest transport markers, full source hashes, internal-identity removal,
and an emitted document below `MAX_AGENT_BROKER_CONTEXT_PREVIEW_BYTES` (32 KiB). Separate tests
prove deduplication/legacy planning behavior and the conservative selection matrix.

Verification from the isolated `CARGO_TARGET_DIR=/tmp/koni-context-pack-target`:

- `cargo test -p koni-core product_execution_ --lib`: **3 passed**;
- `cargo test -p koni-core ticket_spec_slice_rejects_missing_anchors_and_never_expands_root_siblings --lib`: **1 passed**;
- `cargo test -p koni-core --test research_profile context_ -- --nocapture`: **2 passed**, including
  the gate-policy/query regression;
- `cargo test -p koni-core --test research_profile catalog_formulation_ticket_squash_integrates_from_ticket_worktree -- --nocapture`: **1 passed**, including full graph-authoring context and repeated-hash issuance;
- `cargo test -p koni-core --test research_result_contracts research_context_action_includes_every_living_spec_layer -- --nocapture`: **1 passed**;
- `cargo test -p koni-core --lib`: **608 passed, 0 failed, 3 intentional ignores**;
- `cargo clippy -p koni-core --all-targets -- -D warnings`: passed;
- `cargo fmt --all -- --check` and scoped `git diff --check`: passed.

Compatibility caveat: the compact mode deliberately does not promise a universal 32 KiB ceiling.
An unusually large exact goal, steering event, dependency output, check contract, or actionable
review finding remains authoritative and may page. This is preferable to hidden truncation. No
profile, installed binary, live Updog state, run, worktree, process, grant, cmux pane, or broker
response was mutated by this implementation lane.
