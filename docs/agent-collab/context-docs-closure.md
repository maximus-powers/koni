# Living-Spec Documentation Closure Audit

Owner: `context-docs-closure/root`

Status: `complete` (**ACCEPTED**; read-only audit, one documentation P1 resolved by owner)

Last checked: 2026-07-14 (Phoenix)

## Mission and boundary

Independently verify that the released graph-backed living-spec/context behavior is documented
accurately and append-preservingly across the repository. The required chain is approved planning
seed -> bounded ticket bundle (`spec_slice`, `intent_updates`, `working_memory`) -> bounded
`graph_context` / advisory `record_note` -> supplement-receipt binding -> context-first,
late-supplement-closed `submit_and_compile` with retained compatibility aliases.

This lane owns only this mailbox and its narrow row in `docs/AGENT_COLLAB.md`. It will not edit
product documentation, Rust, profiles, templates, tests, installed profiles, binaries, cockpit,
cmux, Updog, Git refs, or live/forensic run state. Any P0/P1 documentation defect will be reported
to the owning persona with an exact file/location and an adjacent-note proposal before any owner
acts.

## Coordination sweep

- Read the complete central registry and inspected the intentionally dirty shared worktree before
  registering this audit.
- Read the context-spec, graph-note, profile-contract, seed-runtime, context-hardening,
  compiler-graph, Software-profile, documentation-closure, documentation-evolution,
  primary-integration, and integration-matrix mailboxes relevant to this boundary.
- Confirmed `context-spec/root` released its product-doc ranges. Generic graph-set compilation and
  Software 0.4 remain separately active; this audit will not treat their future-facing docs as
  shipped context behavior or enter their leases.

## Review checklist

- Trace each documented claim to current implementation/test anchors.
- Confirm earlier language remains readable beside dated completion/enforcement/resolution notes.
- Distinguish current source-complete behavior from fresh-live proof and pinned-run compatibility.
- Check at minimum `README.md`, `philosophy.md`, `architecture.md`, `configuration.md`,
  `codex-resources.md`, `runtime-and-git.md`, `getting-started.md`, and `maturity.md`.
- Recheck relevant mailbox deltas before signing the verdict.

## Findings

### P1 — Runtime/Git describes context as issued before the worker grant

[`../runtime-and-git.md`](../runtime-and-git.md), **Ticket lifecycle**, lines 174–179 currently
orders ticket start as: create/verify the worktree, issue a context pack, then grant the workflow
persona. That remains useful historical shorthand, but it is not the released generic worker
boundary. Software `start` acquires the lease and transitions the ticket without compiling a
context document; worker launch grants the pinned runtime broker, and the worker's first successful
model action must be `koni_runtime.context`. Only that call executes the configured `context`
action and returns the complete document. `validate_agent_broker_one_way_cas_with_product` rejects
every new graph/note/output action until a successful context receipt exists. Research also has a
profile-specific `worker_prompt_only` context compile during `start`, so the generic runtime guide
should not imply one universal pre-grant document-delivery sequence.

Proposed owner correction, without deleting the four-step list: append immediately after it a dated
**Context delivery transition — 2026-07-14** note stating that the list preserves the earlier
start-time shorthand; current broker-backed workers receive a pinned grant first, then must call
`koni_runtime.context` as their first successful action, and no graph, note, or output effect may
occur before that receipt. Mention exact replay recovery, and note that profile-specific precompile
steps do not replace the broker-issued step context.

This is the only P0/P1 defect found in the released living-spec/context documentation so far.
`configuration.md` and `codex-resources.md` already state the current ordering correctly; the
problem is the contradictory generic lifecycle sequence.

#### Resolution

Accepted. `context-spec/root` preserved the original four-step lifecycle list and appended the
proposed dated **Context delivery transition — 2026-07-14** immediately after it. The note now
states the generic pinned-grant -> first successful `koni_runtime.context` -> later graph/note/
output sequence, exact recorded-request replay, and the fact that Research's profile-specific
prompt-only precompile does not replace the broker-issued step document. It does not alter or
normalize the separate target-sync/exact-head history elsewhere in the file.

### Concurrent-domain status observations (not attributed to context-spec)

- `configuration.md` says Software 0.4 “ships” five run types and `getting-started.md` describes
  those presets as current, while the Software YAML/regression mailboxes still say `in_progress`
  and only three of five end-to-end behaviors are green. Their prior three-run baseline remains
  visible, but the active owner should append a clear **Transition in progress** status beside the
  present-tense notes until the profile and five-test gate release.
- `maturity.md` still groups all composite checks with declarations that require an external
  handler/receipt, while `configuration.md` now says opt-in composite `graph_set` execution is
  implemented. The generic compiler lane is active and its latest mailbox retains a moving 2/3
  diagnostic-string checkpoint after an earlier 3/3. At handoff, that owner should preserve the
  older limitation and append the exact built-in `graph_set` exception/current release status.

These two observations are real cross-doc status inconsistencies, but they belong to active
Software/compiler lanes and do not weaken the released living-spec authority, context, note, or
receipt behavior audited here.

## Final context-documentation verdict

**ACCEPTED. No remaining P0/P1 blocker in the released graph-backed living-spec/context
documentation.** The product docs and current implementation agree on the complete chain:

1. a configured final pre-approval planning stage may emit one nonempty, root-connected,
   profile-validated seed through a compiler-only initialization operation; deterministic IDs,
   compiler-owned fields/status, approval validation, initialization publication, recovery, and
   the initialization event remain compiler authority;
2. ticket context retains the legacy contract and adds bounded authoritative `spec_slice`, scoped
   `intent_updates`, advisory `working_memory`, independent hashes, mandatory anchor validation,
   anchor-first budgeting, and a bounded raw-seed hash/count projection;
3. `graph_context` is read-only and ticket-anchor/profile-budget scoped; `record_note` is bounded,
   append-only, advisory, supersession-preserving, and bound to run/ticket/step/agent/attempt/
   persona/profile/graph/node/context provenance;
4. only successful graph/note supplement receipts are ordered and injected through the
   compiler-owned output field before the durable step output; failed calls are excluded;
5. exact receipt replay is resolved first, every new non-context worker action requires a
   successful context receipt, accepted legacy output closes new supplements, and the preferred
   `submit_and_compile` boundary remains replay-safe while `submit_output` / `compile` aliases stay
   documented for pinned compatibility.

`README.md` and `architecture.md` remain accurate high-level views. `philosophy.md`,
`configuration.md`, and `codex-resources.md` preserve the displaced root-only/context/two-call
contracts beside dated living-spec, enforcement, Research-parity, late-supplement, and composite
transitions. `runtime-and-git.md` now preserves and corrects its only conflicting shorthand.
`getting-started.md` and `maturity.md` contain no remaining context-specific contradiction.

Current integration evidence, retained beside earlier causal checkpoints: core library 450 passed,
0 failed, 3 intentionally ignored; CLI 62/62; TUI 292/292; Research conclusion/profile/result
contracts 3/3, 20/20, and 4/4. The graph-note, profile-contract, and seed/runtime independent audits
all independently accepted the same authority and ordering boundary. No product source, profile,
installed resource, binary, cockpit, cmux, Updog, Git ref, or live/forensic run state was changed
by this audit lane.

Final documentation hygiene checks: `git diff --check` for the tracked runtime guide passed;
no-index whitespace checks for this mailbox and the central registry passed; and
`./scripts/check-brand.sh` reported `Brand audit passed`.
