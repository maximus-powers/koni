# Live smoke findings

This file tracks concrete defects and performance findings observed while shadowing real Koni
runs. It is intentionally separate from the TUI polish backlog: every item here changes runtime
correctness, workflow semantics, or model cost.

> **Runtime-history transition — 2026-07-14:** Codex process, JSONL, MCP replay, and transcript
> findings below remain authoritative for schema-1 forensic readers and the pre-cutover runtime;
> do not rewrite them as if they were Pi observations. The unreleased schema-2 target emits Koni-
> owned native Pi events and usage records instead. Its TUI/runtime replacement is gated by the
> trust, credential, budget, migration, compatibility, and immutable-fingerprint contract in
> [`pi-runtime.md`](pi-runtime.md); no current source checkpoint authorizes reusing the protected
> Updog runs as a Pi smoke test.

## Updog software-profile onboarding — 2026-07-13

- [x] Repository resource discovery treated every immediate directory under `.agents/skills` as a
  Codex skill and rejected Updog's supporting rule packs that intentionally have no `SKILL.md`.
  Discovery and immutable run snapshots now include only directories with a skill manifest.
- [x] The software profile inherited the research smoke's cost-optimized `gpt-5.4-mini` Lead
  policy. Software Small, Medium, and Large now have independently pinned planner, Lead, ticket
  worker, and reviewer matrices, with a bundled-install test that keeps them distinct from the
  research profile.
- [ ] Updating the bundled Koni baseline must never overwrite repository-specific profile changes.
  Replace the current whole-directory `--replace` behavior with an explicit versioned baseline,
  project-owned overlay, and run-local override resolution model. Upgrades may replace only the
  baseline, must validate the merged profile, and must surface incompatible or retired primitives
  without mutating the project overlay. Existing immutable run snapshots remain untouched.

## Sortedness research smoke — 2026-07-12

- [x] Failed review findings were buried beneath repeated superseded output history.
  Model-facing context now omits the audit-only history and exposes a compact `review_rework`
  contract.
- [x] Recovery could supersede a correction produced after the failed review.
  Recovery now compares output and worker timestamps with the review boundary.
- [x] A failed-review worker could satisfy rework by replaying a graph-only semantic no-op.
  The compiler now requires the first correction after review to be material while permitting
  dependent steps to refresh their receipt chain.
- [x] Workflow steps need a configurable graph-mutation policy. The durable workflow contract now
  supports compiler-enforced `graph_mutation: forbidden | allowed | required`; analysis-only
  research steps are marked `forbidden`, so `compile-gate-stack` can no longer create the gate
  that belongs to `write-gate-contracts`.
- [x] Ticket context omitted durable steering recorded in the integration worktree because tracked
  runs projected steering only from the repository root. Context assembly now reads both durable
  stores, deduplicates by event ID, and the live replacement worker explicitly followed the
  high-priority analysis-only steering.
- [x] Broker schema failures exposed only a generic `revise_validation` message even though the
  private compiler journal contained actionable field diagnostics. The broker now projects only
  allowlisted schema facts such as `missing required field expected_red` and wrong JSON types,
  while stripping values, node IDs, paths, and compensation text. The live gate worker followed
  `missing required field command_result_contract`, then `command_result_contract has the wrong
  JSON type`, and its third submission plus scoped compile were accepted.
- [x] MCP claim/revalidation/reservation/receipt layers retained the five-second control-plane
  authority timeout even though the protected compiler effects had a 30-second action timeout.
  Under an active cockpit, a worker's second schema revision therefore stopped behind the Lead
  yield/supervisor refresh. All broker boundary layers now use the action timeout while
  pause/delete retain their short control budget. A live cockpit retry completed two consecutive
  guided revisions and compile without `authority_busy_stop`.
- [ ] A resumed Lead reached its MCP server but its compiler-owned review stopped with
  `authority_busy_stop` while another boundary retained run authority. An overlapping supervisor
  probe now fails on the nonblocking supervisor lease before it may acquire run authority, and the
  review's preflight/start/publication guards use the 30-second action wait instead of the
  five-second control-plane wait. Confirm the blocked review retries once without duplicating its
  durable boundary, then close this item.
- [x] Pausing could race an already-leased Lead dispatch. The operator intent is now persisted as
  `running: false` before waiting for run authority, and the scheduler rechecks that durable intent
  before issuing a new Lead lease. An already-effectful boundary drains under the visible
  `Pausing` state; repeated live tests held the pause without a replacement Lead and resumed only
  after an explicit Space action.
- [x] Lowering parallelism while an older, larger dispatch packet was already issued could strand
  the Lead retrying the first now-over-capacity `start`. A new `capacity-reached` yield is accepted
  only when the compiler itself proves that the issued batch is incomplete and the current leased
  lane is full. The broker marks the rejected start non-retryable and names that exact yield; pause
  rejections similarly direct the Lead to the existing compiler-verified `paused` yield. The live
  interrupted slice recovered through the TUI and resumed as a fresh one-ticket boundary without
  duplicating any of its three durable active tickets.
- [x] A TUI pause request that collides with the run authority barrier surfaced a transient error.
  Operator pause/play now waits up to 30 seconds for the current durable boundary while the TUI
  retains its optimistic transition and presents neutral waiting feedback.
- [ ] Mechanical Lead slices remain disproportionately expensive. Earlier research defaults used a
  small dispatcher model, but the intentionally stronger software matrix now exposes the underlying
  architecture again: one live Small-run dispatch slice consumed 210,664 input tokens merely to
  call `spawn_worker` and `yield_lead`, and the run reached 4.4M total tokens before its first
  architecture ticket closed. Preserve the configured Lead for actual judgment, but combine
  deterministic action-plus-yield boundaries or keep one compiler-leased Lead session alive across
  adjacent boundaries so the requested Lead model is not spent as a two-tool relay.
- [ ] Worker context is too large for narrow graph operations. One `write-gate-contracts` turn used
  187,450 input tokens (126,464 cached) to author one gate. Model-facing graph projection now strips
  compiler-owned operational state and records raw/projected byte counts in the context manifest.
  A six-node closure fell from 66,362 to 14,426 bytes, and the next simple Integrator received a
  36,848-byte complete document with only 3,991 projected graph bytes. Total model input remained
  211,834 tokens, however, because each MCP boundary replays Codex's base prompt and accumulated
  turn context. The remaining optimization is therefore architectural: preserve compiler-owned
  verification while combining worker submit + scoped compile, and Lead action + yield, into
  auditable atomic boundaries.
- [x] A retryable output-schema rejection remained a failed action after the corrected payload and
  scoped compile succeeded. The board therefore showed false attention and spent a Lead slice on
  no-op recovery. Successful actions now carry a stable logical retry binding (output content is
  excluded, ticket/step/persona are retained) and automatically recover only prior failed journals
  for that exact boundary. A live `compile-gate-stack` attempt was rejected for missing
  `expected_red`, accepted the corrected payload, completed scoped compile, and left the board with
  zero failed journals.
- [x] Independent review input was catastrophically large because the reviewer reconstructed the
  full ticket history through shell reads. Review now receives a compiler-bound, hash-addressed
  evidence packet and graph-only review disables broad shell execution. The live C2 review fell to
  23,988 input and 4,184 output tokens from prior million-token attempts while retaining independent
  acceptance checks and exact evidence pointers.
- [x] A required `koni_runtime` MCP handshake had a hard ten-second startup window and no transparent
  retry. Startup now has a 30-second ceiling while broker claim waiting remains bounded beneath it.
  The live generation-82 Lead claimed its grant after 5.29 seconds—past the old failure threshold—
  without retrying or duplicating the boundary.
- [ ] Three simultaneous worker starts can still serialize runtime-integrity work long enough for
  the last required MCP server to miss the 30-second handshake ceiling. The live third worker died
  before `thread.started` with an unclaimed, subsequently revoked grant; compiler recovery cleared
  it without a failed journal. The pending fix hashes pinned executable images before exclusive run
  authority, rechecks them through a metadata-keyed per-broker cache under the lock, removes a
  redundant nested authority acquisition, and raises the required-server ceiling to 60 seconds.
  Confirm with another three-worker dispatch before closing this item.
- [x] Concurrent tickets could change compiler-owned projection fields on a shared graph node after
  review, causing a false Git conflict during `finish`. The integration-projection snapshot now
  refreshes only declared compiler-owned fields, proves the semantic projection hash is unchanged,
  and carries that compiler-only proof across the deferred squash. The recovered live C2 ticket
  refreshed 8 fields across 3 nodes, integrated on its first finish call, and preserved its passed
  review.
- [x] Configured recovery repaired a blocked tracked ticket only in its live worktree while cockpit
  inspection correctly continued reading the older atomic ticket-branch tip. Recovery now validates
  the dirty paths against ticket scope and checkpoints repaired ticket state plus recovered journals
  on the ticket branch. It also resumes an older partially-applied recovery by checkpointing existing
  scoped edits even when no new logical edit is required.
- [x] Integration conflicts were surfaced to agents as retryable validation failures, encouraging
  repeated impossible `finish` calls. Recovery-required and integration-conflict failures now return
  a non-retryable `recovery_stop` envelope that tells the agent to stop at the preserved lifecycle
  boundary.
- [x] Valid compiler effects and the final identity-bound Lead yield could lose a race with another
  compiler boundary after the short control-plane authority wait. Effectful actions and
  `yield_lead` now use a bounded 30-second authority wait while pause/delete controls retain their
  five-second responsiveness. Live C4 finish and the following recovery yield both completed with
  compiler acceptance after installing the change.
- [x] Replacing the installed Koni executable during a live Lead boundary correctly invalidated
  its compiler-pinned broker grant, but the safe model-facing envelope mislabeled the stop as an
  opaque `internal_stop`. Compiler-pinned executable drift now maps to the non-retryable
  `stale_stop` instruction. Runtime upgrades must be installed only after the cockpit reports zero
  live agents; the preserved failed slice can then be retried explicitly from its stage boundary.
- [x] The cockpit consumed roughly 100–200% CPU even when no visible work was active. Sampling
  proved the render/event loop and graph were cold; duplicate command-authority projection was hot.
  Board inspection now validates the run-global ledger once, separately fail-closes each distinct
  checkout's local invalid-contract rows, caches receipt reads by checkout, and hashes rows once
  before sorting instead of once per comparison. The live run's standalone `inspect` fell from
  8.54s to 1.41s. The installed cockpit then sustained about 51% CPU on the populated live run,
  below one core while refreshing and supervising.
- [x] Review packets accumulated superseded context/output/probe receipts after repeated retries.
  Full audit history remains on disk, while the model-facing projection now keeps only current
  binding evidence. The live 22-node gate review contained seven compact receipt proofs, zero
  `_command_current` audit markers, and a bounded 72,762-byte prompt.
- [x] Rework integration could copy stale output and receipt IDs from review prose, making every
  subsequent review reject otherwise-current work. Durable step outputs now retain their original
  authenticated hash, while a compiler-derived reviewer projection supplies current causal
  pointers and a separate `causal_binding_hash`. The recovered live gate ticket reached a fresh
  independent review without replaying stale provenance.
- [x] A zero-argument `review()` rejection was classified as retryable `revise_validation`, so a
  Lead could spend repeated turns invoking an impossible call. Review-boundary validation failures
  now produce non-retryable `review_boundary_stop`; only a newly compiled generation may retry.
- [x] Token totals reparsed every historical Codex JSONL file on each two-second refresh. Usage is
  now cached per canonical log path, size, and modification time, so only appended logs are read
  again. Ordinary waiting supervision ticks share the visual refresh cadence and automatic
  supervision has a five-second compiler-friendly floor.
- [x] Per-ticket `worker.log` appends multiple worker attempts and steps. Agent chat now binds the
  preview to the selected record's exact Codex session ID, begins at that session's
  `thread.started`, and stops before the next thread. A regression fixture places an older completed
  turn in the same file and proves that neither its messages nor token usage appear in the selected
  chat.
  **Direct-Pi transition — 2026-07-14:** Retain the preceding result as the Codex-era smoke-history
  contract. Production Pi workers now record one bounded same-directory log per durable
  agent/attempt, so a later session cannot inherit an earlier session's 8 MiB exhaustion. The
  compatibility seam continues to exercise the historical cumulative-file reader.
- [x] The configured reviewer treated missing future assets and passing runtime receipts as blockers
  at the gate-definition boundary even though the operation was gate-blocking-exempt and explicitly
  stopped before asset creation. Review packets now include authoritative `operation_acceptance`
  with the operation, stage, contracts, allowed node types, workflow stop conditions, and exemption.
  The live six-node rework and the following single-gate ticket both passed independent review; each
  reviewer explicitly recognized the expected-red state as sufficient and downstream execution as
  nonblocking.
- [x] Rework context could lead an Integrator to preserve an obsolete review demand as a new change
  request even after the semantic correction was complete. Workers now receive the same authoritative
  `operation_acceptance` contract and are told not to request, perform, or hold downstream work made
  nonblocking by `gate_blocking_exempt` or assigned elsewhere by stop conditions. The next live
  Integrator produced an empty graph delta, retained only the legitimate expected-red risk, and did
  not create a change request.
- [x] Gate-exempt review prompts repeated compiler-owned `operational_state` for every scoped graph
  node. The reviewer projection now omits that derived state while preserving semantic hashes and
  evidence pointers. The next live prompt was 36,727 bytes with zero `operational_state` records,
  down from 164,312 bytes on the preceding larger review.
- [ ] Worker output submission and scoped compile are two separate model-visible MCP turns even
  though both effects are deterministic compiler boundaries. A new `submit_and_compile` tool keeps
  context retrieval separate, then validates/materializes the complete structured payload and runs
  scoped compile under one replay-safe broker receipt. Legacy `submit_output` and `compile` aliases
  remain available for immutable older run snapshots. Confirm the next worker uses exactly
  `context` + `submit_and_compile`, retains both ticket receipts, and lowers total input usage.
- [x] Software workflow expectations containing commas were unquoted inside YAML flow mappings.
  YAML silently reduced `Interfaces, data models, contracts, and flows` to `Interfaces`, and the
  live review-rework context proved that truncated contract reached the worker. All affected bundled
  software expectations are now quoted, and the installer regression asserts their complete text.
- [x] Git-common failed-review rework validated a correction against the integration graph instead
  of the ticket's private reviewed candidate. The live Integrator therefore received the candidate
  node IDs in scope but an edge-only correction failed with `edge source node does not exist`.
  Output validation now reconstructs the superseded candidate baseline before classifying and
  validating rework. A regression reproduces the exact system-to-interface correction, fails before
  the fix, and passes with the corrected projection.
- [ ] Successful worker completion is currently reconciled through a compiler `recover` boundary and
  presented in the cockpit as `recovery needed`. Even when no work was lost, this briefly renders a
  warning and spends another full Lead slice. Separate ordinary worker-result reconciliation from
  exceptional recovery in both scheduling and UI language.
- [ ] Architecture discovery still permits broad repository searches after planning has already
  supplied concrete paths. The live mapper captured generated/vendored minified matches while
  searching for viewport references, inflating logs and model context. Make planning-context paths
  the default search frontier, require explicit evidence before widening it, and exclude generated,
  vendored, lockfile, and build-output trees from ordinary software discovery.

## Updog Small SPICED implementation smoke — 2026-07-13

- [x] The broker routed the Lead's compiler-owned `finish` action through the ticket worktree even
  though the action contract requires the integration checkout. `finish` now executes directly
  against the integration engine; the recovered architecture ticket completed, integrated, and
  expanded the live graph from one objective to sixteen nodes.
- [x] Literal framework paths containing dynamic-segment names such as `[companyId]` were rejected
  as globs. Ticket paths are exact prefix scopes rather than glob expressions, so validation now
  rejects only unambiguous wildcard operators (`*` and `?`) and has regressions for both cases.
- [x] The model-facing graph-delta example grouped legal fields beneath illegal `canonical` and
  `compatible_additions` wrapper keys. The live Integrator copied that shape exactly and received
  an opaque validation stop. Generated context now shows only the accepted top-level `upsert`,
  `delete`, `add_nodes`, and `add_edges` fields. The preserved retry used the corrected top-level
  dialect; later failures were independent semantic validation errors.
- [x] Safe broker feedback discarded an actionable unsupported-field diagnostic. Allowlisted schema
  feedback now names the unsupported field without exposing node IDs, paths, payload values, or
  internal sentinels, and remains retryable for a correction in the same worker boundary.
- [x] A change-planning Integrator reused the objective ID for a new `change` node and represented
  two complete shell commands as `test_command`. Context and default-profile contracts now require
  fresh IDs for new semantic nodes, preservation of existing node identity/type, and exactly one
  argv array with one element per argument. Confirm the live retry creates a fresh change node,
  preserves the objective, links both configured directions, and records one focused expected-red
  test command before allowing implementation to start.
  - **Resolved and edge contract evolved — 2026-07-14:** The later replacement emitted a fresh
    `change`, preserved the objective, and supplied one exact argv array before review readiness.
    Retain “both configured directions” above as the frozen-run request; the current canonical
    model stores only `change.realizes`, while `objective.realized_by` is its compiler-derived
    bidirectional view rather than a second authored fact.
- [x] An invalid `change.requires -> contract` relationship produced an opaque stop even though the
  compiler knew both semantic types. Safe graph feedback now names the relation and target type,
  points to `edge_types`, remains retryable, and strips every node ID and internal path.
- [x] Exact argv was described only in the bundled `change.test_command` prose. The compiler now
  derives every semantic argv field from configured dynamic `command_source` references and rejects
  empty, shell-string, whitespace-executable, NUL, and newline-bearing arrays generically. This
  keeps the primitive configuration-driven instead of hard-coding `test_command` in Rust.
- [x] The ticket target was ambiguous between an object to rewrite and a trigger/context anchor.
  Compiled worker context now derives a `mutation_intent` object from the configured operation,
  rule, node/edge catalog, and current graph. It marks existing targets as identity-preserving
  anchors, names permitted fresh node types, projects trigger edges, and lists every required
  outgoing edge for new nodes.
- [x] A structurally valid objective-only upsert was recorded as completed integration even though
  `objective.plan-change` remained true. Workflow dependencies then scheduled a Review Lead slice,
  while review preflight correctly rejected the impossible boundary. Final review predecessors now
  prove the configured transition (including prospective passing-review effects) before output is
  recorded; the scheduler routes legacy invalid outputs to deterministic recovery, recovery
  supersedes and reopens the owning step, and broker feedback points to `mutation_intent`. The
  preserved Small run recovered to Integrator and the replacement emitted a fresh `change` with
  `change.realizes`, `change.affects`, and the reciprocal `objective.realized_by` link, plus exact
  argv and red/readback contracts, before the compiler allowed review readiness.
- [x] The layered-canvas experiment was based on an incorrect comparison with autoresearch-v2.
  Direct source inspection shows autoresearch-v2's `_layered_graph_lines` delegates to its nested
  relationship-outline renderer. Default coding and research profiles now select Koni's faithful
  nested port: primary branches plus independent secondary rails, with muted two-to-four-word
  titles painted over line cells. The 31 focused graph/TUI tests pass, and the replacement Small
  run's 22-node architecture graph confirmed the nested relationship outline remains readable
  with semantic activity colors and ticket-checkout scope.
- [x] Ticket selection silently fell back to the integration graph for `git_common_dir` projects,
  because cockpit projections were emitted only for tracked-state ticket branches. Cockpit now
  materializes each leased nonterminal ticket through the compiler's private candidate projection,
  skips already-published terminal sidecar tickets, and labels the scope as `ticket checkout`. The
  preserved Small run now switches live from the 16-node integration graph to its 26-node candidate
  graph while retaining the autoresearch-v2 outline and semantic diff colors.
- [x] The red-test step inherited the implementation ticket's full write scope, so the compiler
  could not prove tests were authored before production code changed. Workflow steps now resolve
  their own configured read/write path projections; the bundled software profile gives red only
  `test_paths`, implement only `owned_paths`, and verification/review no write scope. Legacy
  workflows still inherit ticket scope when step scopes are omitted.
- [x] Fresh ticket worktrees lacked repository dependencies, turning the first expected-red command
  into an infrastructure failure. Profiles can now name one validated static workspace-write setup
  check. The software default runs `pnpm install --frozen-lockfile --prefer-offline` once per lease,
  records its receipt and marker, and rejects any tracked product changes from setup.
  - **Superseded for future default profiles — 2026-07-14:** This remains exact evidence for the
    frozen Updog run and proved the need for a typed setup hook. The generic bundled Software
    profile no longer hard-codes Updog's package manager or dependency-install command;
    repository customization must bind any setup command the project actually owns.
- [x] A worker could be identity-verified and live while its ticket projection still briefly read
  pending after startup. Cockpit inspection now corroborates the board with raw live agent records
  and projects that exact ticket step as running without mutating durable state.
- [ ] The preserved 2026-07-13 Small run predates step scopes and `test_paths`, so its immutable
  snapshot cannot prove the new contract. Keep it paused as regression evidence and complete the
  exact same objective in the replacement Small run pinned from the updated profile; follow with
  Medium and Large proofs.
- [x] The full core suite currently reaches three research conclusion integration failures where a
  configured command read path is excluded by its inventory policy. Focused software-profile and
  Updog tests are green; diagnose this research-only regression without undoing coherent concurrent
  profile work.
  - **Resolved / failure set evolved — 2026-07-14:** The compatibility and inventory repairs now
    pass all three `research_conclusion_contract` cases. A later full-core run reached
    434 passed / 3 failed / 3 ignored; those three remaining failures are the separately named
    stale runtime fixtures for the split causal `scientific-runtime` and read-only
    `scientific-result-integrity` contract, not conclusion failures. The full core gate remains
    open until those fixture bodies are reconciled.
  - **Fixture gate closed — 2026-07-14:** The three fixture bodies now declare the distinct
    integrity command and the configured-step fixture binds both check receipts. Their exact tests
    pass 3/3, Research result contracts pass 3/3, safe replay selection passes 1/1, and the current
    full core library passes 438 tests with zero failures and three intentional ignores. The prior
    smoke observation and 434/3/3 checkpoint remain above as causal history.
- [x] A plan-change reviewer treated `system.contracts` on a read-only neighboring system as a
  blocking obligation of the objective ticket, even though the compiler had already emitted a
  separate contract ticket. Review evidence now exposes operational state only for target/write
  nodes and filters unmet obligations to `ticket.obligation_keys`; semantic state for read-only
  neighbors remains available without leaking their lifecycle. The recovered live review addressed
  only the canonical thread names and proof boundary and returned an authoritative passing verdict.
- [x] The rework Integrator resolved the two legitimate findings, but review still rejected its
  canonical thread names and exact `@uplinq/books` argv because older Designer/Risk outputs retained
  their contradictory recommendations. Review packets now expose only the review step's direct
  predecessor output as `current_step_outputs`; earlier outputs remain cryptographically bound
  causal support, while the explicit Integrator synthesis is authoritative when it resolves their
  conflict. The next live reviewer judged that replacement synthesis and did not reopen the settled
  upstream drafts.
- [x] Fresh Integrators produced two correctable `add_edges.source` failures: one source ID was not
  present, and another source was an existing read-only node. The output journals retained both
  precise diagnoses, but broker redaction collapsed them to non-retryable `validation_stop`s.
  Both are now allowlisted retryable corrections: reuse an exact graph/add-node ID, and originate
  new edges only from fresh or explicitly writable nodes, without exposing actual IDs. Context also
  says not to duplicate edges already declared in `add_nodes[].edges`. The first installed retry
  successfully corrected six successive schema errors in one worker, then exposed a third missing
  allowlist case for configured relationship cardinality; that diagnosis now names only the safe
  relation and its configured min/max sources. The next installed retry reached formal Review and
  received an authoritative passing verdict.
- [x] A successfully committed Lead `review` boundary could be reaped as
  `exited_without_receipt` before its later `yield_lead` reached the compiler. That stale yield then
  blocked the stage even though the formal review was already authoritative and passing. Raw-agent
  state now records the exact broker grant, supervision distinguishes a still-live broker from a
  uniquely committed single-boundary receipt, and compiler-only recovery deterministically marks
  that slice yielded without replaying Review or fabricating an OS exit. The preserved Small run
  recovered generation 74 from its original review receipt with no duplicate review and remained
  paused with zero agents.
- [ ] The Small run consumed 8.6M tokens before change design completed. Most excess remains
  mechanical Lead relay cost and repeated recovery-shaped reconciliation, not feature judgment.
  Preserve the user's strong model matrix while collapsing deterministic dispatch/yield and
  submit/compile boundaries and measuring the next comparable ticket.
- [x] A final forced-synthesis turn could emit an exact schema-valid plan and then be marked failed
  solely because Koni's own budget interrupt won the terminal-status race. Final synthesis now
  accepts a nonempty artifact at that narrow budget boundary, still passes it through the strict
  output parser, and can recover a previously failed artifact only when its run, stage, session,
  input hash, budget accounting, transcript message, and durable output all agree. The replacement
  Small run adopted its authored revision without launching another model turn.
- [x] The replacement Small run's first Lead launch failed because the smoke pane was respawned
  directly from cmux's GUI environment, whose minimal `PATH` omitted Codex. Koni failed closed and
  preserved initialization, the compiled ticket, and a recovery journal. Restarting the pane with
  the explicit normal toolchain path, running configured recovery, and retrying only `orchestrate`
  produced a fresh Lead slice without replaying approval or initialization.
- [x] The replacement architecture Integrator repeatedly paraphrased the configured `system.kind`
  enum (`application surface`, then `application`; `persistence boundary`, then `database`) after
  receiving only “not one of the configured values.” One worker stopped safely, but its automatic
  replacement made eight rejected submissions before the paused run's isolated process group was
  terminated. Enum validation now returns the bounded exact choices and points to
  `contracts.node_types[].fields.<field>.enum`; the MCP session stops executing compiler calls after
  its third validation rejection. Focused red/green tests cover both behaviors. After the guarded
  refresh, the replacement Integrator used exact `app`, `package`, and `domain` values and its first
  submission materialized the complete 22-node candidate graph with zero validation retries.
- [x] Formal architecture review received only the pre-transition objective in `current_nodes` and
  reduced every newly authored node to its ID, title, `spec_fields`, and `edge_relations`. The
  reviewer therefore reported missing node bodies and relationship targets that the accepted
  Integrator payload actually contained, reopening an expensive false-rework loop. Review packets
  now retain the full semantic bodies of their bounded direct predecessor, while ordinary worker
  dependency contexts remain compact. The software Integrator also performs an explicit final pass
  over every output-contract clause before its one submission.
- [x] The architecture target-state predicate considered one objective-to-system edge sufficient,
  despite the operation contract also requiring objective-linked contracts and end-to-end flows.
  The default software rule now remains open until all three configured relations exist, and the
  existing pre-review transition guard rejects an incomplete producer output before spending a
  reviewer turn. A focused regression proves system-only and system-plus-contract candidates stay
  in the source state.
- [ ] A terminated worker record can remain durably marked `running` after its isolated process has
  exited. Cockpit process corroboration prevents it from counting as active, but recovery leaves a
  stale warning row instead of recording the terminal interruption. Reconcile dead identity-bound
  records into a precise interrupted/recoverable state without inventing successful completion.
  - 2026-07-16 adjacent correction in current source: explicit recovery now targets only exact
    ticket-bound `running`/`reaping` records whose run/ticket/step identity and owned PID are fully
    bound and whose PID is absent. It persists provisional `exited_without_receipt`, preserves the
    prior result, invents no exit code, excludes planning/aggregate orchestration, and permits a
    late identity-bound waiter to publish the exact OS outcome. Keep this item open until focused
    and composed gates pass and a guarded cockpit refresh confirms the row becomes muted/inactive.
  - 2026-07-16 exit-publication hardening: a late direct-Pi or generic waiter now takes the same
    action-length run-authority boundary before correcting that provisional row. It revalidates the
    live registry/control/deletion and exact process binding, preserves the recovery marker plus
    unrelated result fields, remains valid during pause/question draining, and refuses every write
    after deletion, unregistration, conclusion, or missing control state. Focused source tests pass;
    the guarded cockpit confirmation above remains intentionally open.
- [ ] Play can reveal a blocked orchestration stage caused by an interrupted Lead, while the Runs
  overview still reports zero blockers/recovery and exposes no stage-retry action. Retrying that
  stage through the CLI while the cockpit supervisor is active produced a fresh Lead whose broker
  failed closed with `agent_record_status_changed` before dispatch, indicating a competing
  supervision/reaping race. The control center must surface the blocked stage and own one serialized
  retry path; concurrent cockpit/CLI supervision must observe the same running agent without
  invalidating its durable record.
- [ ] The replacement run reached 4.1M tokens before its first graph mutation. Its two read-only
  architecture mapper turns used 418.2K/5.8K and 294.3K/4.8K input/output tokens; one deterministic
  dispatch Lead used roughly 519K input, and an ordinary reconciliation Lead used another 63K.
  These measurements reinforce the existing Lead-relay and context-compaction work: preserve the
  semantic contract while eliminating model turns for compiler-deterministic dispatch, yield, and
  successful-worker reconciliation.
- [ ] During the one-time ticket worktree setup check, the active Lead row still uses the generic
  `Execute compiled work` title while `pnpm install --frozen-lockfile --prefer-offline` may run for
  minutes. Project the compiler-owned substate as a short activity such as `Preparing ticket` so
  the user can distinguish dependency setup from model reasoning without exposing command noise.
  - **Frozen-run evidence — 2026-07-14:** The hard-coded `pnpm` command identifies the preserved
    Updog snapshot, not a universal current default. The operator-facing `Preparing ticket`
    requirement remains applicable to any project-configured setup check.
- [x] The live `plan-change` ticket needed four failed formal reviews and many Integrator validation
  retries before it could express the requested risk/proof graph. The exact field types existed in
  a 143 KB context, but the compact checklist omitted configured field descriptions and legal edge
  targets; upstream analysis also put the conceptual label `Questionnaire persistence backing the
  agents questionnaire query and mutation` in `owned_paths`, and risk/proof candidates used names
  such as `argv`, `authorized_paths`, and free-form test-layer text instead of the graph schema's
  `command`, `owned_paths`, and enum-backed `layer`. The generic context now puts config-derived
  descriptions, list-item types, required-any groups, and allowed outgoing relations together in
  one authoring contract. Default software Change Designer, Risk Analyst, Integrator, operation,
  and workflow instructions now require exact project-relative path values, exact candidate field
  vocabulary, and graph-bound material risk/proof obligations rather than prose-only summaries.
- [ ] Prove that first-shot repair on the next fresh software `plan-change` ticket after a guarded
  binary refresh. The current Small run is intentionally frozen to its original config snapshot,
  so its continuing retries are evidence for the fix rather than a valid test of the new contract.

## Verification targets

- A paused active run reaches durable `Paused`, starts no new workers, and resumes from the same
  compiler boundary.
- Analysis-only steps reject any nonempty semantic graph delta.
- The next single-node gate step uses materially fewer input tokens without losing its operation,
  target, dependency outputs, graph contract, or review policy.
- Lead dispatch remains compiler-authorized and auditable even if its deterministic packet no
  longer requires an expensive reasoning turn.
- Concurrent compiler-owned projection drift preserves the reviewed semantic hash and integrates
  without conflict; genuine semantic overlap still fails closed.
- Recovery clears failed journals, commits the repaired ticket projection, removes the blocker from
  atomic board inspection, and permits exactly one successful replay of the preserved finish.
- The cockpit idles below one CPU core and compiler work has an explicit visual/activity signal that
  does not depend on process CPU usage.
- Repeated review/rework cycles do not increase the semantic review packet with stale receipts.

## 2026-07-15 — isolated Medium planning acceptance

### Evidence retained

- `019f643e-451e-76f2-a939-1b0dd431129e`: the first authenticated isolated Medium planner used
  230,445 new tokens (4,730,368 cached) and 129 repository calls over ten minutes, then timed out
  without an artifact. This disproves prompt-only planning economy.
- `019f6672-867e-72a3-b593-d4a8ccba6e4e`: the next planner stopped repository access at 32 calls,
  used 75,355 new tokens, but the in-turn steering design never reached structured synthesis and
  crossed the 4,096-event Rust public-transcript bound. The host and planner were reaped, while the
  run incorrectly remained durably `running: true`.
- `019f6683-8ed7-76d0-9ae8-a5f6190e8c12`: the same-host two-turn design reached synthesis twice.
  Attempt one explored for 56,984 new tokens, emitted an 85,539-byte assistant message, then
  returned canonical transient unavailability. Operator resume explored again and reached 135,447
  cumulative new tokens, but synthesis streamed for nine minutes and exceeded the same public-
  event bound. Both hosts were reaped and the run paused correctly.

### Evolving contract

- Planning repository access is a validated run-type primitive, not prompt convention:
  `planning.max_repository_tool_calls`. Omission remains 32 for legacy snapshots; newly installed
  Software Small/Medium/Large use 16/24/48.
- The cap ends an exploration turn with the final repository result preserved in its compiler-
  terminal outcome. A second turn in the same live Pi host/session performs schema-constrained
  synthesis with reads closed. This preserves context without relying on asynchronous steering or
  a new process pretending that a logical session ID carries model memory.
- Production inference no longer exports raw provider `message_delta` fragments because durable
  logs, schema validation, and the TUI consume only `message_completed`. Full plan prose is capped
  at 24,000 characters, direct-Pi planning output at 16,384 local tokens, and synthesis explicitly
  forbids repeating the goal, source questionnaire, repository excerpts, or schema.
- Any planner process error now produces an operator-resumable durable pause. Provider failures
  retain their fixed classified projection; host/compiler failures receive a fixed safe summary
  plus their existing private diagnostics. A dead planner may not leave the run displayed active.

### Next proof

- Package the current source into a new isolated prefix and run the same exact Medium objective
  from the clean `harness-testing` acceptance base.
- Require a structured plan within the bounded reads and materially below the 240K new-token
  ceiling, then audit graph compilation, approval, ticket worktrees, composed verification,
  independent review, report, and manual promotion before accepting the flow.

## 2026-07-15 — isolated Medium planning acceptance

### Evidence retained

- `019f643e-451e-76f2-a939-1b0dd431129e`: the first authenticated isolated Medium planner used
  230,445 new tokens (4,730,368 cached) and 129 repository calls over ten minutes, then timed out
  without an artifact. This disproves prompt-only planning economy.
- `019f6672-867e-72a3-b593-d4a8ccba6e4e`: the next planner stopped repository access at 32 calls,
  used 75,355 new tokens, but the in-turn steering design never reached structured synthesis and
  crossed the 4,096-event Rust public-transcript bound. The host and planner were reaped, while the
  run incorrectly remained durably `running: true`.

### Evolving contract

- Planning repository access is a validated run-type primitive, not prompt convention:
  `planning.max_repository_tool_calls` with generic Software defaults 16/32/48 for
  Small/Medium/Large.
- The cap ends an exploration turn with the final repository result preserved in its compiler-
  terminal outcome. A second turn in the same live Pi host/session performs schema-constrained
  synthesis with reads closed. This preserves context without relying on asynchronous steering or
  a new process pretending that a logical session ID carries model memory.
- Any planner process error now produces an operator-resumable durable pause. Provider failures
  retain their fixed classified projection; host/compiler failures receive a fixed safe summary
  plus their existing private diagnostics. A dead planner may not leave the run displayed active.

### Next proof

- Package the current source into a new isolated prefix and run the same exact Medium objective
  from the clean `harness-testing` acceptance base.
- Require a structured plan within 32 reads and materially below the 240K new-token ceiling, then
  audit graph compilation, approval, ticket worktrees, composed verification, independent review,
  report, and manual promotion before accepting the flow.

## 2026-07-15 09:44 MST — fourth failure and fifth Medium pass

- Run `019f6698-1d10-7af2-8ab6-06dcfc9c4897` completed exactly 32 repository calls in one
  exploration turn (66,923 input, 217,088 cached input, 1,538 output; 68,461 new tokens). Its
  same-session synthesis streamed for about six minutes, then surfaced `runtime_internal` with
  zero usage and no message artifact. The durable generic-process guard correctly paused the run
  and reaped the host.
- Source diagnosis found a local-boundary defect, not an unexplained provider crash: the 16,384
  output allowance included hidden reasoning; the host checked the completed assistant usage before
  publishing the message/usage and projected its own output-limit exception as generic internal.
- Current source reserves 32,768 runtime output tokens, independently bounds the visible JSON to
  96 KiB and plan prose to 24,000 characters, preserves an over-limit completed message plus exact
  billed usage, and reports `runtime_output_limit`. Complete Pi message/tool payloads are now kept
  in the local agent transcript, while the TUI suppresses transport envelopes and renders the real
  conversation. Host 53/53, focused Rust, and all 14 agent-chat tests pass.
- Fresh run `019f66a9-df5a-7302-a3e1-00482d37a7ab` uses isolated package
  `.koni-acceptance-runtime.72PE6C`. Its first turn again stopped at exactly 32 legacy-snapshot
  reads after 67,281 input, 272,384 cached input, and 1,466 output tokens, then entered the same-live-
  session tool-free synthesis. Acceptance remains open pending the structured artifact and the full
  approval/execution/verification/promotion flow.

## 2026-07-15 10:00 MST — fifth planning pass succeeded and rich chat is live

- Run `019f66a9-df5a-7302-a3e1-00482d37a7ab` completed the same-host synthesis successfully on its
  first attempt. It published a schema-valid graph seed, full execution plan, and individually
  authored architecture/risk/verification review cards, then stopped at explicit plan approval
  with no Pi host left alive.
- Its compiler-owned `stdout.jsonl` is 798,612 bytes and contains two turns, 43 complete messages,
  32 started/completed repository tools, 10 usage events, and one terminal turn closure. Raw text
  deltas remain absent. The compact planning journal is 97,791 bytes and does not duplicate those
  payloads.
- Isolated cockpit package `.koni-acceptance-runtime.b3LDDO` renders the initial compiler prompt,
  reasoning/message cells, tool requests, full tool outcomes, usage, and final assistant artifact;
  no repeated `Pi event` rows remain. A trailing batched call that the compiler intentionally did
  not execute is marked `Skipped`, not `Calling`.
- The visual pass found and fixed a history-navigation regression: `Home` previously stored
  `usize::MAX` distance from the tail, so `PageDown` remained clamped at the beginning. Chat now
  has explicit top-relative history state; focused transcript tests are 18/18 and warning-denied
  TUI Clippy, release build, format, and diff checks pass. The acceptance cockpit is PID 93534 on
  this isolated package; the original Updog cockpit and protected runs remain untouched.

## 2026-07-15 10:22 MST — direct-agent transcript mismatch isolated and closed

- After approval, the same acceptance run started Lead generation 3, spawned proof-preparation
  ticket `TK-63a91afabf98af03`, and then continued with generation 4 while its Implementer worked.
  The compiler-owned Implementer log grew past 470 KiB and demonstrably contained complete user,
  assistant-thinking, tool-call, tool-result, and outcome payloads with streaming deltas absent.
- The cockpit nevertheless showed “The agent has not emitted a visible message yet.” The parser
  correctly handled planning's `type: pi.event` records but did not recognize the older direct-Pi
  `{runtime,event}` envelope. This was a projection defect, not transcript loss and not an agent
  cognition failure.
- Source now gives planning, Lead, and ticket workers one canonical transcript-record constructor,
  while the reader preserves compatibility with older direct logs. Exact legacy-envelope coverage
  plus the full agent-chat suite passes 19/19; the direct writer regression passes; warning-denied
  core/TUI Clippy, formatting, and diff checks are clean.
- The active Implementer was deliberately not interrupted for the UI update. The isolated cockpit
  remains on its prior binary until the current compiler-owned agent boundary is quiescent; then a
  guarded refresh will expose the already-durable full transcript without replaying work. Original
  Updog and its protected runs remain untouched.

## 2026-07-15 11:07 MST — proof-preparation recovery boundaries tightened

- The first Implementer attempt preserved a valid in-scope test file, but proof baseline preflight
  rejected the planned production module because that covered path correctly did not exist before
  implementation. Ticket-specific read manifests now represent an absent future covered path with
  a deterministic `missing` binding while continuing to require every proof source and ordinary
  read path. Generic read manifests remain strict.
- On replacement, the worker was stopped before receiving context because the checkout still held
  its preserved in-scope test. Context reissuance may now observe—but never checkpoint or absorb—
  dirty product paths only for Git-common sidecar profiles, before the selected step has an output,
  and only inside that step's write authority. Tracked profiles, post-output edits, and out-of-scope
  edits still fail closed.
- Two bounded no-output sessions correctly opened the worker circuit, revealing that its prior
  instruction had no implemented disposition path. Explicit `recover` now removes only that exact
  blocker, returns the already-leased ticket to active work, and records a disposition timestamp;
  pre-recovery sessions cannot instantly reopen the circuit, while two fresh failures can.
- Focused missing-path, context-reissuance, circuit-recovery, and truthful-product-declaration tests
  pass, as do warning-denied core Clippy and formatting. The acceptance run remains paused with no
  live agents until a guarded isolated-binary refresh.
