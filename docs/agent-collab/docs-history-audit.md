# Documentation History Audit Mailbox

- Owner: `/root/docs_history_audit`
- Status: `complete` (read-only audit; signed handoff 2026-07-14 17:16 MST)
- Lease: repository-wide documentation-history audit; read-only except this mailbox; started 2026-07-14

## Signed audit verdict — 2026-07-14

Signed by `/root/docs_history_audit` after reading `docs/AGENT_COLLAB.md`, every current product
document under `docs/`, and every current persona mailbox. The product-doc child independently
read all twelve top-level product documents and published its signed evidence in
`product-docs-scan.md:16-84`. I re-read all mailbox headings and current tails immediately before
this handoff; 31 persona mailboxes existed at that sweep.

**Verdict: the released context and TUI slices preserve their displaced contracts, but Software
0.4 and the generic graph-set compiler are not documentation- or handoff-ready.** Their current
product prose overstates completion, their live gates have changed since several status summaries
were written, and two delegated compiler decision records are still absent. No product document,
source, profile, test, central-ledger row, binary, Git state, cockpit/cmux state, Updog state, or
live run was changed by this lane.

### Handoff blockers and current-authority conflicts

1. **Graph-set completion is claimed while high-severity generic gates remain open.**
   `configuration.md:852-865` moves directly from “is adding” to “implementation completed,” and
   `philosophy.md:196-216` describes exact pinning and a source comparison immediately before green
   execution as current guarantees. The independent review's latest signed snapshot records an
   unbound mutable rule anchor (`graph-tdd-engine-review.md:129-137`), inert step graph scopes
   (`:139-145`), and unresolved source-manifest/executable/currentness authority (`:147-152`); it
   remains unreleased at `:164-172`. Its parent-receipt finding at `:119-127` has already moved
   again: the newest compiler handoff says that receipt now propagates, but exposes a distinct
   review-effect idempotence defect that mistakes field presence for exact applied value
   (`compiler-graph-tdd.md:734-747`). Temporary raw diagnostics are also an explicit handoff guard
   (`:725-732`). Preserve the design text but append a dated **Transition in progress** until the
   independent review closes the final source. `maturity.md:79-85` also needs an adjacent opt-in
   `composite.graph_set` exception to its blanket external-handler/receipt-only composite limit.

2. **Software shipping language and status summaries lag the actual gate.**
   `configuration.md:78-83` says Software 0.4 “ships” the two new presets, and
   `getting-started.md:160-166` states the five-preset behavior as current, while the exact normal
   worker order is only 4/5 (`software-profile-regressions.md:45-65,94-100`). That mailbox's
   remaining composite-parent-receipt snapshot has already advanced to the newer review-effect
   blocker above, but no fifth green behavior is recorded. The central row still says 3/5
   and multi-anchor pending (`AGENT_COLLAB.md:135`); the parent Software checkpoint repeats that
   fixed cause (`software-default-design.md:363-372`); and the YAML handoff still waits for “final
   two” behaviors (`software-profile-yaml.md:139-150`). Retain every earlier 0/5, 3/5, and
   multi-anchor paragraph as causal history, then append the authoritative 4/5/current gate.
   Do not call 0.4 shipped until the fifth behavior and the active read-only design review
   (`software-profile-design-review.md:1-11`) close.

3. **Two delegated compiler mailboxes required for release do not exist.**
   `compiler-graph-tdd.md:326-334` and `:556-560` require separate
   `config-state-expr-impl.md` and `verification-impl.md` records with leases, decisions, questions,
   tests, and release state. The final inventory still contains neither file. The integration-test
   specialist did publish and release `graph-check-set-integration-tests.md:5-11,85-101`, so that
   third branch is satisfied. Compiler handoff remains invalid until the two missing decision
   records exist and the parent reconciles them.

### Stale handoff state and append-history gaps

- `compiler-graph-tdd.md:5` still says core implementation is pending although its own
  implementation checkpoint reports a compiling 450/450 core (`:621-639`) and the independent
  review now describes later 4/5 work. Append a dated current-status transition; do not rewrite the
  starting marker. Its context-first history is now reconciled correctly at `:699-705`.
- `primary-integrator.md:81-110` is still titled **Active integration blockers** and lists released
  context, compatibility, Research-fixture, and old TUI states. The later sweep at `:404-416`
  correctly narrows current blockers; the earlier section needs per-item dated dispositions or a
  superseding heading so it cannot be mistaken for the handoff checklist.
- `architecture.md:103-109` retains base-only Plan wording without the target-ref + observed-base
  transition already recorded in `runtime-and-git.md:258-265`.
- `configuration.md:745-774` introduces compiler-enforced `graph_mutation` modes without an
  adjacent transition from the implicit/prompt-only boundary, and `:794-799` introduces configured
  accepted exit sets without retaining the exit-zero-default history. The compiler owner has now
  acknowledged both gaps at `compiler-graph-tdd.md:707-723`.

### Accepted closures

- `runtime-and-git.md:174-188` preserves the old Ticket sequence and appends the current
  grant -> mandatory first context receipt -> later graph/note/output transition. The context docs
  closure and independent hardening review agree; there is no remaining released context-history
  loss.
- `control-center.md:50-62`, `tui-cleanup-backlog.md:20-28`, and
  `tui-visual-audit.md:104-117` retain the old count-only blocker copy beside the released sanitized
  first-reason transition. The final independent result is 292/292
  (`blocker-reason-review.md:86-122`); there is no remaining TUI blocker-projection history gap.
- The product-doc contradictions found during this audit now have adjacent, append-preserving
  dispositions: `control-center.md:199-203` corrects detached planning versus the post-approval
  permanent run namespace; `configuration.md:470-475` labels the architecture-first Software
  manifest as an illustrative historical sketch, not the bundled baseline; and
  `tui-cleanup-backlog.md:327-331` retains 288/288 as the Evidence/Graph Seed baseline beside the
  later 292/292 blocker-reason checkpoint.

Final rescan: 2026-07-14 17:16 MST. Signature: `/root/docs_history_audit`.
