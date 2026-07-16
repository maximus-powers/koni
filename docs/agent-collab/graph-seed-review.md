# Graph Seed Presentation Review

Owner: `graph-seed-review/root`

Status: `complete` (initial verdict blocked; all five blockers later resolved and integration-green)

Last checked: 2026-07-14 (Phoenix)

## Mission

Review the newly implemented operator-facing Graph Seed projection in
`crates/koni-tui/src/model.rs` and its narrow `ui.rs` coverage. Verify hard bounds,
deterministic ordering, redaction of compiler/provenance material, seedless behavior, and reuse in
the approved Plan view. This lane does not own or edit Rust.

## Safety and coordination boundary

- Read the complete `docs/AGENT_COLLAB.md` and every current persona mailbox before source
  inspection, then rechecked the mailbox inventory before this handoff.
- Reviewed the shared dirty tree without resetting, formatting, installing, sending cmux input, or
  touching Updog/cockpit/live-run state.
- Edited only this mailbox. `tui-polish/root` retains its current presentation lease, while the
  released Graph Seed symbols remain attributed to that lane in the central registry.
- Existing documentation remains append-only decision history. The green intended-path evidence
  below stays visible beside the later blocker findings; neither supersedes the other.

## What is sound

### 2026-07-14 — intended projection and source precedence

- `approval_draft` conditionally appends Graph Seed after Architecture, Risk, and Verification.
  A seedless run keeps exactly those original three sections; the existing semantic-plan test
  asserts that exact title list.
- The constants enforce six root rows, twelve node rows, sixteen relationship rows, and 160
  characters per projected scalar/title component.
- Root facts are stable under the current `serde_json::Map` representation; nodes and edges retain
  their validated array order. Local-key replacement order is stable by descending key length.
- The intended fallback order is deterministic: newest succeeded stage output, then reverse-linked
  agent result, then the matching planning transcript. The focused test exercises each fallback.
- `approved_plan_text` deliberately calls the same `approval_draft` builder used by Review Plan.
  The focused approved-stage test proves the normal case switches from planning activity to the
  human Plan and includes the same Graph Seed section.
- The compact UI keeps the fourth section selectable and scrollable through its summary, nodes,
  relationships, and omitted-count tail. The roomy UI exposes all four section choices.

These are useful green foundations, but they do not close the stricter guarantees below.

## Integration blockers

### 1. The twelve-node bound can be bypassed through relationship labels

`graph_seed_approval_body` builds `titles_by_key` from **every** projected node before rendering
only `projected_nodes.iter().take(GRAPH_SEED_NODE_LIMIT)`. Relationships then resolve endpoints
against that full map and are truncated independently. Therefore one of the first sixteen edges
can print the title of node 13–64 even while the omission line counts that node as hidden. With
edges between hidden endpoints, the view can disclose up to 32 extra node titles in addition to
the twelve node rows.

The existing 14-node regression misses this because every one of its eighteen edges points to
node 1. This is both a hard-bound violation and a misleading omitted-count contract.

**Required regression:**

`graph_seed_relationships_never_reveal_nodes_outside_projection_limit`

- Build at least fourteen valid nodes.
- Put an edge to node 13 among the first sixteen edges.
- Assert node 13's title appears nowhere in the body, the relationship is counted as omitted, and
  no more than twelve distinct node titles are visible.
- A safe implementation can build the endpoint-title map from the selected twelve nodes and omit
  every relationship whose non-root endpoint is outside that selected set.

### 2. Scalar raw `spec` / `schema` root fields render directly

`graph_seed_metadata_key` filters ID/hash/path/storage-style names but does not reject `spec`,
`raw_spec`, `schema`, or key-bearing names such as `node_key`. `graph_seed_scalar_summary` then
renders their string/number/bool values (and up to three scalar array values) as Root enrichment.
That contradicts the released contract that structured/raw spec/schema and local keys never enter
the ordinary Plan view. The fact that object values are skipped does not make scalar raw payloads
safe.

**Required regression:**

`graph_seed_projection_rejects_scalar_raw_spec_and_schema_fields`

- Put distinct sentinel values under root fields `spec`, `raw_spec`, `schema`, and `node_key`.
- Make `node_key` contain a real seed-local key.
- Assert neither the labels nor sentinel values appear, while an ordinary semantic root fact still
  renders and the omitted count remains exact.

### 3. Markdown-wrapped and prefixed hashes/UUIDs evade lexical redaction

`graph_seed_sensitive_token` recognizes a bare all-hex token of at least 24 characters and an
exact bare 36-character UUID. Its punctuation trimming does not remove backticks, quotes, or
Markdown emphasis, and the exact-shape checks do not recognize prefixes. Common strings such as
`` `0123456789abcdef01234567` ``, `sha256:012345...`, `` `550e8400-e29b-41d4-a716-446655440000` ``,
and `id:550e8400-e29b-41d4-a716-446655440000` therefore survive. The final approval redactor does
not know arbitrary graph hashes or node identifiers embedded in authored purpose text.

**Required regression:**

`graph_seed_projection_rejects_markdown_wrapped_and_prefixed_identifiers`

- Place unique bare, backtick-wrapped, emphasized, and `sha256:`-prefixed long hashes plus bare,
  backtick-wrapped, and `id:`-prefixed UUIDs across root semantic scalars, node titles, and purpose
  fields.
- Assert none of the identifier substrings appear; safe surrounding semantic facts should remain.
- Redaction should scan normalized token content, not rely only on the token's exact outer shape.

### 4. A local key embedded in a larger ASCII token is not removed

`graph_seed_safe_text` calls `replace_ascii_token`, which replaces a local key only when both
sides are non-alphanumeric and not underscore. A title such as
`Keep seed-key-secretSuffix hidden`, a root fact containing `seed-key-secret_suffix`, or a purpose
containing `prefixseed-key-secret` retains the complete secret key as a substring. This breaks the
unconditional no-local-key promise even though boundary-separated keys are handled correctly.

**Required regression:**

`graph_seed_projection_never_exposes_embedded_local_key_substrings`

- Reuse one valid local key in prefix-, suffix-, and underscore-adjacent forms in root facts,
  titles, purposes, types, and relations.
- Assert the key is absent as a substring everywhere.
- Suppressing an unsafe authored scalar/title and using the existing semantic fallback is safer
  than globally replacing a one-character valid key inside ordinary words.

### 5. Post-approval reuse is not restricted to the approved planning stage

`planning_graph_seed` scans every succeeded pipeline stage in reverse order; it never checks that
the selected stage is a planning stage (or the pinned configured graph-seed stage). A later
successful report/checkpoint/other stage whose nested output happens to contain a
`graph_seed`-shaped object wins over the reviewed planning artifact. The current approved-Plan
test includes only a later approval stage with no such payload, so it proves reuse on the happy
path but not immutability of what the operator approved.

**Required regression:**

`approved_plan_ignores_graph_seed_shaped_outputs_from_post_approval_stages`

- Create a succeeded planning seed stage, succeeded explicit approval, and a later succeeded
  non-planning stage containing a different shape-valid `graph_seed` object.
- Assert Review/approved Plan continues to show only the approved planning seed.
- Prefer the pinned configured graph-seed stage when available; at minimum restrict fallback
  extraction to succeeded planning stages before applying stage → agent → transcript precedence.

## Determinism coverage recommendation

No nondeterministic ordering defect was found in the current valid path. A small
`graph_seed_projection_order_is_repeatable` regression is still worthwhile: project the same seed
repeatedly, assert byte-identical output, assert node/edge array order is retained, and document
that root-object facts use the canonical map order rather than implied author insertion order.
This is a coverage improvement, not a separate release blocker.

## Verification log

- `CARGO_TARGET_DIR=/tmp/koni-graph-seed-review-target cargo test -p koni-tui
  approval_graph_seed --lib -- --nocapture` — 2 passed.
- `CARGO_TARGET_DIR=/tmp/koni-graph-seed-review-target cargo test -p koni-tui approval_review
  --lib -- --nocapture` — 12 passed, including seedless three-section and compact/roomy Graph Seed
  reachability coverage.
- `CARGO_TARGET_DIR=/tmp/koni-graph-seed-review-target cargo test -p koni-tui
  ui::tests::plan_panel_switches_from_live_activity_to_the_approved_human_plan --lib -- --exact
  --nocapture` — 1 passed.
- `CARGO_TARGET_DIR=/tmp/koni-graph-seed-review-target cargo test -p koni-tui approval --lib --
  --nocapture` — 24 passed on the current shared tree.
- A fresh full `koni-tui --lib` run reached 277 passed / 2 failed. Both failures are in
  `tui-polish/root`'s currently active Evidence/runtime truthfulness slice:
  `overview_composes_objective_run_and_evidence_before_preserving_ticket_focus` still expects
  `HEALTHY`, and `recent_activity_shows_row_timestamps_and_only_active_runtime_in_its_header`
  still expects the former runtime header. Neither exercises Graph Seed, but the overall TUI suite
  is not presently a green integration gate.
- No Rust, profile, installed binary, cockpit, cmux surface, Updog checkout, or run state changed.

## Release verdict

**Blocked.** The intended Graph Seed UI is readable, source-order deterministic, seedless-safe,
and normally reused after approval, but it does not yet satisfy its stated hard node bound or
absolute no-key/no-hash/no-raw-spec/schema trust boundary, and a later non-planning payload can
replace the approved seed in the durable Plan view. Land the five focused regressions above and
make them green before treating the Graph Seed presentation row as integration-ready. Then rerun:

```text
CARGO_TARGET_DIR=/tmp/koni-graph-seed-review-target cargo test -p koni-tui approval --lib -- --nocapture
CARGO_TARGET_DIR=/tmp/koni-graph-seed-review-target cargo test -p koni-tui ui::tests::plan_panel_switches_from_live_activity_to_the_approved_human_plan --lib -- --exact --nocapture
CARGO_TARGET_DIR=/tmp/koni-graph-seed-review-target cargo test -p koni-tui --lib -- --nocapture
```

### 2026-07-14 — blocker repair from `primary-integrator/root`

All five exact blockers above are now repaired in the released `model.rs` range without entering
the active `tui-polish/root` `ui.rs` lease. Relationship endpoint labels resolve only through the
twelve selected nodes; scalar spec/schema/key metadata is suppressed; full-string scans reject
wrapped or prefixed long hex/UUID material; any embedded local-key substring suppresses the unsafe
scalar and uses the semantic fallback; and seed discovery considers only succeeded planning
stages, so later report/checkpoint-shaped payloads cannot replace what was approved.

Five named adversarial regressions plus the strengthened prior bounded projection test pass in the
seven-test `graph_seed` set. The full `approval` set passes 25/25, and the exact approved Plan
reuse test passes 1/1. `model.rs` is rustfmt-clean and path-scoped `git diff --check` passes. The
full TUI rerun remains intentionally sequenced after `tui-polish/root` releases its unrelated
Evidence/runtime `ui.rs` slice; this note closes the model-level blockers but does not claim that
active range or a guarded refresh.

### 2026-07-14 — integrated closure from `primary-integrator/root`

The separate Evidence/runtime slice is now explicitly released after independent truth review.
The frozen integrated TUI passes 288/288, including Graph Seed 7/7, approval 25/25, and exact
approved Plan reuse 1/1. This closes the original five-item release verdict while retaining its
causal findings above. The optional repeat-order coverage recommendation and compact Activity-title
follow-up remain non-blocking. No binary install, cockpit action, profile write, cmux input, Updog
access, or live-run mutation occurred.
