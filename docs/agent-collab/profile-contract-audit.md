# Living-Spec Profile Contract Audit

Owner: `profile-contract-audit/root`

Status: `complete` (final disposition accepted; read-only audit, no source/profile lease)

**Transition — 2026-07-14:** The original `blocked_pending_disposition`
finding and verdict below remain as decision history. The broker now enforces
the required context-first boundary, the Research section correction is green,
and the final re-audit accepts the default profile interaction contract.

Last checked: 2026-07-14 (Phoenix)

## Mission and safety boundary

Audit the default Software and Research worker interactions for the living-spec
context feature. This lane owns only this mailbox. It does not edit Rust,
profiles, templates, product documentation, installed binaries, or live runs.
The active Software/default-profile and generic compiler leases remain with
their recorded owners.

Before inspection, I read the complete `docs/AGENT_COLLAB.md`, the complete
`docs/agent-collab/context-spec.md`, and the existing persona mailbox inventory.
I re-read the central ledger and relevant owner mailbox after the Research
compatibility correction landed during this audit.

## 2026-07-14 findings

### Pass: the shared worker assignment states the correct interaction

`Engine::spawn_agent_process` gives every broker-backed ticket worker the same
compiler-owned protocol. It requires `koni_runtime.context` as the first model
action, describes that response as the complete operation/schema/graph/steering/
dependency/persona/skill contract plus typed living-spec slice and advisory
working memory, and limits follow-up use as follows:

- `graph_context` is a narrow, read-only supplement for a concrete dependency
  outside the issued slice.
- `record_note` is for durable observations, implementation details, rationale,
  nits, and open questions.
- Notes are advisory working memory, never semantic authority. Contract,
  decision, scope, and acceptance changes must use the reviewed typed graph
  delta.

That compiler-owned assignment is appended to the selected Software or
Research persona prompt, so the interaction does not depend on every persona
template repeating the resource protocol. The inspected native persona prompts
do not otherwise contradict it. Research source prompts and native Codex agents
remain covered by exact-content/parity tests.

One Software wording nit reinforces the runtime question below: the Implementer
persona says to "Read local repository instructions first," while the later
compiler protocol says the first model action is `koni_runtime.context`. This is
easy to make unambiguous after the active Software lease releases by saying,
"After reading the compiler-issued context, read applicable local repository
instructions before product work." It is not a separate blocker if the broker
enforces context-first ordering.

### Pass: the runtime MCP surface exposes and bounds the requested resources

Worker grants expose `context`, `graph_context`, `record_note`,
`submit_and_compile`, and the two compatibility aliases. The reserved server is
enabled and required, receives only the pinned grant/agent/attempt identity,
and does not accept model-supplied run, ticket, step, or persona selectors.

`graph_context` validates anchors, relation names, node types, direction, depth,
node count, response bytes, and per-step call count against the pinned profile.
It returns typed graph facts with separately labelled advisory working memory.
`record_note` accepts only the five advisory note kinds, bounds body size and
call count, restricts the target to the ticket-visible graph neighborhood, and
records run/ticket/step/persona/agent/attempt/profile/graph/node/context
provenance. Its public result explicitly reports
`authority: advisory_non_authoritative`. Successful supplement receipts are
bound to the submitted output; failed calls are excluded.

### Resolved during audit: Research had suppressed all three new sections

At the initial read, the authored and installed Research `context` actions
explicitly included only their legacy sections:
`graph_closure`, `ticket`, `contracts`, `outputs`, `review`, and `steering`.
Because `compile_context` treats an explicit include list as exact, Research
workers did not receive `spec_slice`, `intent_updates`, or `working_memory`, in
conflict with both the living-spec specification and the shared worker prompt.

The owning context lane repaired this without dropping legacy `steering`.
`profiles/research/actions/research.yaml` and its CLI template mirror now
explicitly include all six legacy sections plus `spec_slice`,
`intent_updates`, and `working_memory`. The central ledger records the focused
section assertion, all four Research result-contract tests, recursive Research
source/template parity, and formatting/whitespace checks green. Software's
context action has no explicit include override, so it receives its legacy
default sections plus all three living-spec defaults.

### Open integration question: context-first is not a broker invariant

The shared prompt says to call `context` first, but the worker broker currently
accepts `graph_context`, `record_note`, `submit_output`, or
`submit_and_compile` before any successful `context` receipt. Software `start`
does not precompile a context, its workflows do not require a `context-pack`
receipt, and its `output.validate` action does not set `require_context`.
Consequently a nonconforming Software worker can begin product work and submit
without ever receiving the compiled bundle. A pre-context `record_note` is also
durable with `source.context_hash: None`, weakening the intended explanation of
which issued spec informed the note.

If “agents beginning tickets receive compiled context” is a hard harness
invariant, this is a release blocker. The narrow correction is to require a
successful `context` receipt before every other worker tool (while preserving
exact context replay/recovery), or to compile and attach the selected-step
context atomically at spawn. A focused broker regression should reject
`graph_context`, `record_note`, and submission as the first distinct call and
prove a context-first note always carries its issued context hash. If the
project intentionally treats compiler-owned prompt ordering as sufficient,
the owner should record that weaker guarantee explicitly before closing this
audit.

## Verification

- `CARGO_TARGET_DIR=/tmp/koni-profile-contract-audit cargo test -p koni-cli
  agent_mcp::tests --bin koni -- --nocapture` passed 17/17 on the audited MCP
  surface.
- The freshly built CLI test binary passed the four Research source/template,
  native-agent, and no-shell-lifecycle prompt checks before the narrow include
  correction. The owner subsequently recorded its post-correction parity and
  result-contract runs in the central ledger.
- A later Cargo rerun was intentionally not treated as a feature result: it
  encountered the generic compiler lane's active mid-edit
  `Step::compiled_check_sets` integration state. This audit did not enter or
  modify that lease.

## 2026-07-14 verdict

The living-spec payload, resource tools, provenance, and authority/advisory
language are correctly exposed across default worker prompts after the Research
include correction. Final acceptance remains blocked only on an explicit owner
decision about the context-first runtime invariant above; no source or product
documentation was changed by this audit.

## 2026-07-14 final disposition — accepted

The owner rejected prompt-only ordering and implemented the required runtime
invariant in `validate_agent_broker_one_way_cas_with_product`:

- exact already-recorded receipt replay is resolved first, preserving crash and
  compatibility recovery without repeating effects;
- every new non-`context` worker request then requires at least one successful
  `context` receipt;
- the check occurs in broker reservation before operation execution, so a
  rejected graph, note, or output call cannot create its effect or receipt;
- a failed context receipt does not unlock the worker, and Lead grants are
  unchanged;
- the existing post-output supplement closure remains in force after the new
  context-first check.

The focused CAS regression covers pre-context rejection for `graph_context`,
`record_note`, `submit_output`, and `submit_and_compile`, exact historical
receipt replay, successful-context progression, and the existing submission/
compile replay boundaries. Independent re-run:

`CARGO_TARGET_DIR=/tmp/koni-profile-contract-audit cargo test -p koni-core
engine::tests::worker_broker_cas_allows_revision_then_closes_on_exact_compile
--lib -- --exact --nocapture` — 1 passed, 0 failed.

The Research source and installed template still preserve all legacy sections
and include all three living-spec layers. Independent re-run:

`CARGO_TARGET_DIR=/tmp/koni-profile-contract-audit cargo test -p koni-core
--test research_result_contracts
research_context_action_includes_every_living_spec_layer -- --exact
--nocapture` — 1 passed, 0 failed; the owning lane reports the full file 4/4.

The Software Implementer prompt now says to read compiler-issued context first,
then applicable local repository instructions before product work, eliminating
the earlier wording ambiguity. No remaining defect was found in default
Software/Research context delivery, graph-resource exposure, note provenance,
or authority/advisory separation. **Final verdict: accepted.** This audit made
no source, profile, product-documentation, installed-binary, or live-run change.
