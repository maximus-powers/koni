# Worker context preflight early design review

Reviewer: `context_preflight_design_reviewer/root`

Reviewed snapshot: 2026-07-16, while `context_spawn_preflight_fix/root` was still editing

Status: **early changes requested — no P0; five P1 integration traps communicated before source
freeze**

## Scope and non-authority

This was a read-only, pre-freeze review of the context-spawn correction. It inspected the prior
independent findings, the implementation owner's lease and chosen design, Worker selection and
spawn ordering, exact tracked/Git-common stores, context construction/publication, grant hashing
and currentness, durable broker reservation/replay, provider-neutral context cursors, and Pi's
local observation boundary. It did not edit production source, run tests, build or install a
binary/runtime bundle, touch a live run/process/worktree/ref, or operate cmux. This mailbox is the
only review write.

## Accepted design choices

- Opening the run from the exact ticket worktree is the right authority for both backends:
  tracked profiles read the ticket-branch projection, while Git-common profiles retain their
  shared semantic store and the exact product checkout.
- Binding ticket, step, semantic context hash, exact document path, raw document SHA, and byte
  length in one optional, grant-hashed object is a compatible shape. `None` must remain omitted so
  historical grant hashes do not change.
- Reloading the ticket after preflight is essential and is present in the in-flight change. It
  prevents later worker-PID/`active_worker` publication from writing a stale ticket clone over the
  newly issued context hash.
- Serving the initial context from the binding instead of recompiling after model launch closes
  the original token-waste defect.
- Retaining the 64 MiB compatibility ceiling for policy-absent Workers and unscoped/observer
  context, while applying the receipt-derived 4,000,000-byte limit only to policy-enabled Worker
  context, is the correct upgrade boundary.
- Carrying `context_completion_required` explicitly into Pi, rather than inferring it from role,
  prompt, or tool names, preserves policy-absent behavior.

## P1 findings communicated to the implementation owner

### P1 — every bound continuation must revalidate and read the bound pack

The in-flight `context` implementation uses `bound_worker_context_document`, which correctly
checks current ticket/step issuance plus the bound document length and SHA. The context-path arm in
`broker_worker_read_file` still derives a path from the current step and rereads that file without
checking the grant's document SHA/length. A pack changed in place after the preview can therefore
deliver different continuation bytes under the same model-visible context session.

For a grant with `context_pack`, an exact context `read_file` must compare the requested path to
the bound path and obtain the page from a freshly verified bound document. A derived current path
that differs from the binding must fail closed. Add an adversary that receives the preview,
changes/replaces the document, and proves the next exact page is rejected without a receipt.

### P1 — MAX+1 currently leaves semantic and filesystem side effects

`compile_context_with_document_limit` still calls `expand_ticket_owned_scope` and writes the
ticket before it constructs and size-checks the final Markdown body. An oversized preflight can
therefore fail before grant/process creation but still mutate ticket scope. Separately,
`spawn_agent` creates the agent directory and opens its log before entering direct-Pi preflight.

Move scope persistence after the final size check and fold it into the successful context-ticket
write. The MAX+1 production regression should compare the complete ticket, context-pack/receipt
namespace, grants, agent records, and launcher/provider probe before and after. If “no side
effects” is meant literally rather than semantically, move preflight before log/directory
creation as well. A failed action journal is useful audit evidence, but it must not conceal an
unadvertised context/ticket mutation.

### P1 — preflight-to-grant authority is implicit in one caller

Today the production `spawn-worker` action retains the run authority barrier and compiler lock
across its `agent.spawn` primitive, so the current call path prevents steer/pause/delete or another
compiler mutation between preflight and grant publication. `spawn_direct_pi_agent_with` itself,
however, preflights before `issue_agent_broker_grant_with_context` acquires its registered-run
barrier. A future direct caller or focused production-seam invocation can split the exact pack
from the authority snapshot it is supposed to bind.

Prefer a reentrant registered-run barrier spanning preflight through at least grant and starting
record publication, followed by exact run/ticket/step revalidation. Preserve the established lock
order: run barrier, caller-owned compiler lock, then grant lock. If the implementation deliberately
relies on the outer action instead, encode that as an asserted/tested capability instead of an
undocumented call-stack fact.

### P1 — Pi's local repeat rejection bypasses the bounded correction ceiling

The provider-neutral broker permits one compact correction for repeated `context`, then returns a
nonretryable stop. Pi intercepts a repeated context before broker dispatch but currently returns
the same retryable `context_already_issued` outcome on every repetition. That preserves receipts
but can spend unbounded provider turns.

Keep the first local correction retryable and make the next repetition nonretryable/terminal, or
route the repeat through the broker's bounded state machine. Test Paging and Complete separately,
and prove rejected siblings never reach Rust.

### P1 — the 128-receipt product reserve is not a durable admission rule

The constant arithmetic proves one straight-line maximum context traversal fits within 128
receipts. Reservation currently enforces only the total of 256. Moreover, `graph_context` and
`record_note` are admitted before context reaches EOF, so adversarial pre-context calls can spend
the slack assumed by the arithmetic. A reconstructed broker cursor also has no durable class/count
that proves how much of the context allowance was already spent.

Enforce the reserve at durable reservation. Context, exact bound-context continuation, and any
explicitly allowed pre-EOF supplement must not consume capacity needed for the remaining worst-case
context delivery plus 128 post-context calls. Persist or reconstruct enough typed receipt state to
make this true after broker recovery; request hashes alone do not identify historical continuation
paths. At minimum, deny a new bound-context delivery once its reserved half is exhausted and prove
that a recovered broker cannot reset the allowance.

## P2 compatibility and observability follow-ups

- Directly invoking the context compiler during spawn bypasses the configured `context` action's
  `compiler.context.issued` event and does not name the preflight effect in the spawn action
  journal. The context-pack receipt supplies evidence, but the event/activity contract should be
  retained or explicitly evolved.
- A historical non-Pi broker receives a full response rather than paging. Accepting 16–64 MiB at
  compilation still collides with the 16 MiB durable broker-response ceiling. This is a test-only /
  archived runtime compatibility seam today, but “64 MiB compatibility” should not imply those
  legacy sessions can actually replay a document in that range.
- The bound-file reader inherits `read_compiler_issued_context_document`'s containment and final
  symlink checks. Opening the final document with no-follow semantics and validating the opened
  inode would strengthen the remaining metadata/canonicalize/read race, especially for tracked
  packs inside a user-writable checkout.
- The optional-field compatibility test should deserialize a real pre-field grant, recompute its
  normalized hash unchanged, and separately prove that every newly issued production direct-Pi
  Worker has both policy and pack. Previous policy-enabled grants without a pack must follow an
  explicit compatibility path rather than being mislabeled policy-absent.

## Requested focused evidence before release

1. MAX accepted and MAX+1 rejected through the real spawn seam; MAX+1 has no grant, agent record,
   process/bootstrap/provider call, context receipt/pack, or ticket mutation.
2. Tracked and Git-common cases both bind the exact store/path; a dirty replacement Worker gets a
   newly compiled pack and post-preflight ticket state is not clobbered during PID publication.
3. Pack mutation, deletion, path substitution, and ticket context-hash mutation all fail before a
   continuation dispatch/receipt.
4. Repeated context is one-shot and bounded in Rust and Pi; fresh exact recovery receives the
   existing pack without recompilation or cursor regression.
5. Durable context admission cannot exceed its reserved half, including recovery and any allowed
   pre-EOF supplements; at least 128 receipts remain after the largest accepted context.
6. Policy missing/false Pi and Lead sessions retain historical same-message behavior and the
   legacy 64 MiB compile ceiling, while policy true retains every observation boundary.

