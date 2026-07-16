# Worker cognition and context-efficiency audit

Owner: `cognition-context-audit/root`

Status: `complete` — read-only runtime/source diagnosis; no implementation lease claimed

Last checked: 2026-07-16 America/Phoenix

## Lease and coordination boundary

This audit explains one exact direct-Pi Implementer transition in the preserved Medium acceptance
run and proposes the smallest authority-preserving reductions in fresh model input. It changed no
Rust, TypeScript, profile, template, test, live run, ticket, broker grant, worktree, binary,
process, Git ref, cockpit, or cmux state. This mailbox is its only write.

The separate `broker-read-latency-audit/root` lane owns the roughly 27–35-second spacing between
broker calls and any runtime-latency repair. I sent that owner the exact read/search byte and scan
shape; it confirmed that Pi intentionally executes a model-authored batch sequentially and is
separately tracing run-authority contention versus repeated broker validation/open-run work. This
report owns only provider input, transcript, cache, result representation, and worker-instruction
semantics.

Token terminology follows the current product contract throughout:

```text
new tokens      = uncached input + output
provider total  = uncached input + cached input + output
reasoning       = a subset of output, never an additional amount
```

## Exact observed transition

The evidence is the active log for agent `worker-019f6b81-47a7-7640-b572-f17f6d752329`, ticket
`TK-5ec6ad45ffe5072b`, step `implement`:

`/Users/max/Desktop/updog-koni-acceptance-1/.git/koni/runs/019f66a9-df5a-7302-a3e1-00482d37a7ab/work/tickets/TK-5ec6ad45ffe5072b/worker.worker-019f6b81-47a7-7640-b572-f17f6d752329.attempt-1.log`

The two usage records being compared are per-provider-request records, not a cumulative counter:

| Provider request | Assistant action | Uncached input | Cached input | Output | New | Provider total |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| after the context preview | batch ten `read_file` calls | 8,986 | 2,560 | 322 | 9,308 | 11,868 |
| after the ten read results | batch six `search_files` calls | 30,612 | 11,264 | 272 | 30,884 | 42,148 |

The corresponding records are at log lines 8–9 and 40–41. Including the first context request,
the cumulative boundary through the search batch is **42,961 new**, **13,824 cached**, and
**56,785 provider-total** tokens. It is therefore inaccurate to say that one cumulative value
grew from 9,308 to 30,884; those are two different requests.

The byte evidence accounts for the second request almost exactly:

- The ten files returned 108,119 raw source bytes across their delivered pages.
- Their ten provider-visible Pi `toolResult` messages totalled **123,912 bytes** after JSON string
  escaping and metadata, 15,793 bytes (14.6%) over the raw chunks.
- At roughly four encoded characters per token, 123,912 bytes predicts about 31K tokens. The
  provider reported 30,612 uncached input tokens.
- The context result immediately before the first batch was itself a 39,074-byte model message
  containing a 32,768-byte preview of a 44,743-byte context. That explains most of the preceding
  8,986 uncached input tokens.

The six searches did **not** cause the 30,612-token request. They were the output of that request
(only 272 output tokens). Their six results totalled 3,616 provider-visible bytes. On the following
request the provider reported only 1,528 uncached input and 41,472 cached input, confirming that
the search-result suffix was small and the large stable prefix was reused.

At a later read-only snapshot, after nineteen provider requests and several edits/checks, this
same turn had 59,640 uncached input, 6,734 output, 813,568 cached input, and 879,942 provider total:
**66,374 new**, not 879,942 new. Reasoning was 2,319 of the 6,734 output tokens. This later moving
snapshot is included only to demonstrate effective cache reuse; it is not the turn's terminal
total.

## What Pi is doing

Koni creates one Pi `Agent` with the compiler-rendered assignment as `systemPrompt`, one stable
session ID, and sequential tool execution (`runtime/pi-host/src/runtime.ts:355-365`). The pinned Pi
agent takes a complete snapshot of its accumulated messages for every model continuation
(`runtime/pi-host/node_modules/@earendil-works/pi-agent-core/dist/agent.js:263-278`). The pinned
Codex provider then sends those messages again and uses that stable session ID as
`prompt_cache_key`
(`runtime/pi-host/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js:339-355`).

That means the complete conversation is replayed for semantic continuity, but unchanged prefixes
can be provider-cached. The live buckets show that this works:

- request 2 cached 2,560 tokens and treated the new context result as fresh;
- request 3 cached 11,264 tokens and treated the new 123,912-byte file-result suffix as fresh;
- later edit/check requests cached roughly 41K–53K tokens apiece while adding hundreds or a few
  thousand uncached tokens.

Koni's durable `tool_completed` event and Pi's transcript `message_completed` event are two audit
projections of one result, not two copies supplied to the model. The model receives one
`toolResult`. The current host renders ordinary structured success values with `JSON.stringify`
(`runtime/pi-host/src/runtime.ts:252-274`), which explains the source-content escaping overhead.

Full transcript replay is not itself a correctness defect. Switching to lossy summarization or
dropping earlier file results could remove the exact text and hashes needed for later CAS edits.
Likewise, provider-total cache traffic is useful throughput telemetry but is not fresh cognition.

## Necessary evidence versus avoidable behavior

### Necessary or reasonable in this ticket

1. **Current repository bytes were required.** This was a replacement worker after prior attempts
   left authorized partial edits in the ticket worktree. The new compiler-owned recovery context
   correctly says not to assume a pristine checkout. Re-reading current bytes before hash-CAS
   mutation is necessary; prior assistant prose cannot safely substitute for current files.
2. **The scope is genuinely multi-surface.** The compiler issued ten exact read paths spanning the
   shared schema, focused proof, questionnaire component/hooks, and proposal surface. They match
   the graph's approved six-thread parity claim; hiding an entire consumer to reduce input would
   weaken first-shot correctness.
3. **The large questionnaire file needed two distinct regions.** The first page supplied imports
   and top-level context. Three searches found relevant definitions around lines 3,657–3,949,
   outside the initial 32 KiB. The worker then read a narrow tail page starting at byte 110,000.
   Search was the correct mechanism for that unseen region.
4. **Stable context must remain available.** The exact operation, graph closure, selected step,
   dependency output, proof/check set, scope, and safe prior-attempt feedback are compiler
   authority. Their hashes and content must remain bound to output/compile receipts.

### Avoidable or improvable

1. **The worker did not finish paging its compiler context.** The result explicitly said
   `eof:false`, `next_offset:32768`, and instructed exact-path continuation, but the next assistant
   batched product reads instead. The 44,743-byte product-execution pack's final 11,975 bytes were
   never read. This is first a correctness risk, not an efficiency win. The assignment says the
   context tool returns the “complete” contract while the tool description alone explains paging
   (`crates/koni-core/src/engine.rs:28264-28267` and
   `crates/koni-core/src/agent_tool_broker.rs:800-803`); the contract should make incompleteness
   impossible to overlook.
2. **Three of six searches re-indexed text already supplied in full.** Searching the partially
   read 127,778-byte questionnaire definition was defensible. Searching `ProposalCompany.tsx` for
   `Sales Notes` after its delivered first page already contained that section, searching the
   fully returned 2,792-byte `useFormThreads.tsx` for `salesNotes`, and searching the fully
   returned 5,172-byte `useVisibleRefs.tsx` for `Situation` were redundant transcript lookups.
   Their token cost was small, but they added broker work and another continuation boundary.
3. **The default page was larger than the immediate need in a known large file.** A 32 KiB first
   page was useful for imports but larger than necessary. When the desired symbol/literal is
   known, an 8 KiB header read plus search-directed local page usually preserves evidence with
   fewer fresh bytes. The existing `max_bytes` option already supports this; neither prompt nor
   tool copy teaches the strategy (`agent_tool_broker.rs:833-844`).
4. **Search supplies line numbers but no byte paging hint.** The worker guessed byte 110,000 from
   line 3,657 and happened to land correctly. `broker_worker_search_files` scans the full file but
   returns only path/line/column/text (`engine.rs:44006-44115`). A compiler-calculated UTF-8-safe
   `read_offset` would make the narrow follow-up deterministic without widening scope.
5. **Provider-facing file content pays generic JSON escaping overhead.** The 14.6% expansion is
   not semantic evidence. Koni can retain the exact structured outcome and durable hash while
   rendering the model-facing success as a deterministic metadata header, raw text block, and
   footer. This is a secondary optimization; it must preserve exact content, path, full-file hash,
   offset, next offset, byte count, and EOF.
6. **The static assignment is broader than the selected step.** Every Worker receives a long
   protocol covering graph authoring, add/upsert/edge operations, review rework, integration, and
   several proof modes even when this selected step is a graph-forbidden product implementation
   (`engine.rs:28264-28278`). The Implementer persona similarly carries proof-preparation,
   baseline, characterization, current-verification, implementation, and defect branches in one
   prompt (`crates/koni-cli/templates/codex/software/agents/implementer.toml:3-67`). This was not
   the 30K spike—the first request was only 2,740 input tokens—but compiling only applicable
   instruction sections would reduce every later cached/provider prefix and make the operative
   rules more salient.
7. **Recovery context identifies partial state but not where it is.** The safe feedback says that
   in-scope edits may remain, without exposing raw prior prose or paths. A compiler-derived,
   scope-filtered worktree-delta manifest (status, current hash, and bounded changed ranges for
   issued paths only) would let a replacement prioritize changed files without trusting an old
   transcript or broadening authority.

## Smallest safe correction order

### 1. Correct the prompt and tool descriptions first

Add one short, compiler-generated product-read discipline block to the Worker assignment:

> Context is complete only when `eof` is true. If `context` returns `eof:false`, page its exact
> `document_path` from each returned `next_offset` before any product-file call. For a known
> literal in a file larger than one page, search first and read only the required region. Treat an
> `eof:true` file result as retained in this transcript; do not search it again merely to relocate
> text already returned.

Mirror the latter two sentences in the `read_file` and `search_files` descriptions. Preserve the
existing exact-file/directory authority wording and all no-follow bounds. Do not reject a repeated
search solely as an authority error: an agent can legitimately require compiler-receipted absence
evidence after product drift.

For the bundled Implementer, add the same adaptive-read rule beside the invariant opening, then
evolve persona resources toward compiler-selectable instruction sections keyed only by existing
configured primitives (`step.kind`, `graph_mutation`, proof strategy, validation checks, rework,
integration). Keep the shared persona configurable; do not hard-code Updog or this ticket.

### 2. Add deterministic navigation metadata

Extend each `search_files` match with the exact UTF-8 byte position and a safe `read_offset` at or
before that match. The offset is an observation, not capability: `read_file` must still revalidate
the path, current product binding, scope, symlink policy, offset boundary, and file hash. This lets
the model search a large file before reading it and avoids guessed offsets.

A multi-literal single-scan form could reduce repeated filesystem work, but that overlaps the
separate runtime-latency lane and is not required for the cognition fix.

### 3. Make partial-work location compiler-owned

When `prior_attempt_feedback.product_state` is present, add a bounded
`current_worktree_changes` projection derived by the compiler from the exact ticket base/current
worktree. Include only already issued paths, normalized status, current hash, and changed byte/line
ranges; omit raw diff text initially. Bind it into the context hash. This guides ordering without
copying model prose, claiming changes are correct, or changing write authority.

### 4. Compact presentation without deleting authority

Continue the existing schema-1.1 product-execution compaction rather than raising a blind token
cap. The current manifest is already compact JSON and saves 116,280 contract bytes, but still emits
44,743 bytes: `graph_closure` is 11,157 bytes and `spec_slice` is 14,140 bytes
(`.../context/5b646743302730ff/manifest.yaml:39-98`). Any further reduction must retain the exact
goal, step/check contract, assigned typed state, dependency output, safe retry feedback, and hashes
of omitted authoritative sources, with bounded `graph_context` as the explicit escape hatch.

After semantic compaction, consider a tool-specific provider renderer for context/read results to
remove JSON escaping while preserving the structured compiler outcome and transcript hash. Do not
truncate earlier file content after it has become a CAS/edit dependency.

### 5. Keep the Medium model configuration

Do not lower the requested Medium Worker from `gpt-5.6-terra` / `high` to treat this symptom
(`crates/koni-cli/templates/software/run-types/medium.yaml:105-110`). In the key 30,884-new-token
request, only 272 tokens were output and 31 of those were reasoning; 30,612 were source/context
input. Reducing reasoning cannot remove file bytes and may lower first-shot implementation quality.

## Deterministic test plan

1. **Assignment contract:** extend the Worker prompt test to require the `eof`-before-product rule,
   search-before-large-read guidance, and transcript-retention guidance. Assert exact-file scope,
   terminal submission, configured-check, and graph-authority rules remain present.
2. **Context paging:** create a >32 KiB context fixture. The result remains paged and hash-bound;
   the documented continuation reconstructs every byte. Add a broker state test in which a product
   read before context EOF receives one retryable `context_incomplete`, while an exact continuation
   followed by a same-batch product read succeeds. Old grants without this state retain their
   pinned behavior.

   **Superseded by the 2026-07-16 observation-boundary correction:** the exact continuation still
   succeeds, but a following sibling from that same assistant message must not. Pi quarantines it
   locally until a new provider request proves the model has observed the returned page. The
   adversarial regression now covers a full response, an intermediate continuation, and the EOF
   continuation, then permits the informed product call on the following provider request.
3. **Search offsets:** use ASCII and multibyte UTF-8 files with matches before/at/after page
   boundaries. Prove returned byte/read offsets are valid boundaries, lead to the reported line,
   become stale observations after file drift, and confer no path capability.
4. **Provider rendering:** round-trip quotes, backslashes, newlines, Unicode, delimiter-like text,
   empty content, and a 64 KiB page. Assert the model-visible representation reconstructs the exact
   bytes and metadata while the durable structured outcome/hash and replay identity are unchanged.
5. **Prior-work manifest:** prove only current issued paths appear; out-of-scope, protected,
   symlinked, deleted, and compiler-state paths remain absent or fail closed. A changed file alters
   the context hash; a newer durable output resets retry feedback according to the existing rule.
6. **Applicable instruction projection:** matrix product implementation, proof preparation,
   graph-authoring, review rework, integration, and legacy/unclassified steps. Each receives every
   applicable invariant and no unrelated mode prose. Full compiler validation remains unchanged.
7. **Acceptance metric:** run a clean Medium fixture with one large source plus several small
   consumers. Compare, separately, context bytes, raw source bytes returned, provider-visible tool
   bytes, provider requests, uncached input, cached input, output/reasoning, repeated complete-file
   searches, checks, and final semantic/Git result. The regression target is less fresh input and
   no missing evidence—not a smaller cache-inclusive provider total at the expense of correctness.

## Verdict

The 30,884-new-token request is causally explained by a 123,912-byte fresh batch of source-file
results. It is not cached-token misaccounting, repeated reasoning, or six expensive search
responses. Pi replayed the full transcript as designed and the provider cached the stable prefix
successfully. The avoidable issues are worker read strategy, a missed context continuation,
several redundant searches of already complete results, generic JSON presentation overhead, and
overbroad static instructions. Fix those surfaces first; retain all compiler scope, hashes,
receipts, current-file CAS checks, complete necessary evidence, and the requested Medium model.
