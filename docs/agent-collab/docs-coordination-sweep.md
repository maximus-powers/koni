# Documentation coordination sweep

Owner: `docs-coordination-sweep/root`

Status: `complete` — read-only post-17:49 coordination audit; findings routed 2026-07-14.

Exact lease: this mailbox only. No product document, central-ledger row, source, profile, test,
binary, cockpit/cmux surface, Git ref, Updog state, or live/forensic run state belongs to this lane.

## Audit method and boundary

This sweep started from the signed repository-wide read in
[`docs-delta-watch.md`](docs-delta-watch.md), then re-read the central registry, every current
mailbox heading/current tail, every top-level product-document status/transition range, and every
file added or changed after the 17:49 checkpoint. The inventory grew during the audit from 40 to 44
persona files because the proof-preparation and Pi-runtime lanes registered themselves. Those new
mailboxes and their subsequent coordination notes were included before this handoff.

The append-preserve rule is part of the audit result: every earlier failure/count/claim below is a
valid save-point record. Owners should append adjacent dated transitions; they should not edit the
old checkpoint into the later result.

## Resolved after the 17:49 checkpoint

### Compact Recent Activity propagation is complete

The former unclaimed/claimed snapshots are now correctly retained as history beside the released
implementation:

- central rows `102` and `154` record the title-only release and preserve the earlier states;
- [`tui-polish.md:502-521`](tui-polish.md) records the implementation and owner release;
- [`compact-activity-smoke-audit.md:125-136`](compact-activity-smoke-audit.md) appends the linked
  transition beside its original unclaimed geometry;
- [`integration-matrix.md:650-661`](integration-matrix.md) supersedes, without deleting, the earlier
  “no implementation lease” sentence;
- [`tui-cleanup-backlog.md:75-85`](../tui-cleanup-backlog.md) and
  [`tui-cleanup-backlog.md:369-374`](../tui-cleanup-backlog.md) record the full -> compact -> identity
  contract and exact 1/1, Activity 6/6, full TUI 294/294 evidence; and
- [`tui-truth-review.md:83-95`](tui-truth-review.md) plus
  [`tui-visual-audit.md:127-137`](tui-visual-audit.md) retain their original findings beside the
  bounded resolution.

This is no longer a source, product-document, matrix, or central-ledger blocker. Two audit
mailboxes still describe their then-current follow-up as open:
[`docs-delta-watch.md:73-82`](docs-delta-watch.md) and
[`activity-mailbox-release-sweep.md:63-71`](activity-mailbox-release-sweep.md). Their evidence is
historically correct, but their owners may append a short linked “reconciliation completed” status
so mailbox-only readers do not reopen the work. No existing wording should be removed.

### Review-effect header reconciliation is complete

[`review-effect-semantics.md:4-9`](review-effect-semantics.md) now preserves the original active
marker and adds the signed-complete transition plus an explicit statement that engine v1.1 has not
yet been re-reviewed. The two P1 acceptance gates therefore remain current without a stale-header
ambiguity.

## Open current-contract and status findings

### P1 — Software owner records disagree about the current executable contract

1. [`software-default-design.md:499-505`](software-default-design.md) says the Bug Fix run type has
   already been corrected to omit `localization_status` and a speculative pre-diagnosis change.
   The later signed read-only review says the current preset still requires both at
   [`software-profile-design-review.md:364-384`](software-profile-design-review.md). Meanwhile,
   [`software-presets-prompts.md:3-6`](software-presets-prompts.md) still presents that exact file
   lease as complete/released, with no appended reopen or correction transition. The parent Software
   owner and preset owner must compare the current files, append one exact disposition in both
   mailboxes, and add a prompt-to-schema regression before release. Do not silently make either
   historical statement disappear.

2. The YAML owner reports nonvacuous accepted-risk boundary proof, current risk proof before
   delivery, and one in-place delivery identity as landed at
   [`software-profile-yaml.md:242-280`](software-profile-yaml.md), with its staged compile/hygiene
   checkpoint at [`software-profile-yaml.md:303-320`](software-profile-yaml.md). The later design
   review still reports missing delivery uniqueness and vacuous accepted-risk assurance at
   [`software-profile-design-review.md:386-433`](software-profile-design-review.md), and retains
   both in its current open-finding/final-matrix list at
   [`software-profile-design-review.md:459-484`](software-profile-design-review.md). This is not safe
   to resolve by timestamp inference. Route an explicit YAML-owner -> design-reviewer recheck of the
   exact current rule/operation source and focused tests; only the reviewer should append the signed
   disposition of its P1/P2 findings.

3. The regression mailbox still says fixture work is paused until the YAML owner publishes the
   final contract at [`software-profile-regressions.md:223-259`](software-profile-regressions.md).
   The YAML owner now says its ten files are frozen and that the regression owner received the exact
   sequence at [`software-profile-yaml.md:303-330`](software-profile-yaml.md). The regression owner
   should append a dated resumed/current result rather than leaving the 4/6 moving snapshot as the
   apparent latest state.

Owner routing: `software-default-design/root` coordinates; `software-profile-yaml/root` supplies
the frozen source/test evidence; `software-profile-design-review/root` signs the semantic
disposition; `software-profile-regressions/root` owns the expanded matrix; and the released preset
lease must be explicitly reopened or corrected by `software-presets-prompts/root`/the parent before
any prompt edit.

### P1 — Software product documentation still stops before the current design

The already-routed gap remains open. In particular:

- [`software-profile-engineering.md:206-212`](../software-profile-engineering.md) still requires an
  “honest localization state,” although current lifecycle status is compiler-owned and the field
  `localization_status` does not exist;
- [`software-profile-engineering.md:342-355`](../software-profile-engineering.md) still requires a
  pre-diagnosis addressing change and keeps focused proof inside implementation, without the
  conditional source-only diagnostic/boundary preparation lane;
- [`software-profile-engineering.md:541-560`](../software-profile-engineering.md) stops at the 3/5
  then 4/5/value-presence-replay checkpoint; and
- [`maturity.md:26`](../maturity.md) says both bundled Software and Research profiles are
  “Implemented and exercised end to end,” which overstates the current Software design/review,
  cross-ticket preparation, authority, expanded-regression, and frozen-fingerprint gates.

Append adjacent current transitions for the grounded defect + diagnostic proof, reviewed diagnosis
before `change.addresses`, conditional preparation, source/production disjointness, honest
human-authorized proof replanning, exact in-place delivery revision, accepted-risk boundary proof,
and the historical 6/6 -> moving/expanded gate. Keep the old 0.3 design and every intermediate count
visible. Owner: `software-default-design/root` under its existing product-doc lease.

### P1 — generic compiler product-history work remains open

The following 17:49 findings remain unresolved:

- [`configuration.md:790-794`](../configuration.md) introduces compiler-enforced
  `graph_mutation: forbidden|allowed|required` without an adjacent transition from the prior
  implicit/prompt-only boundary;
- [`configuration.md:814-819`](../configuration.md) introduces configured accepted exit sets
  without retaining exit-zero-only default behavior as causal compatibility history;
- [`configuration.md:85-89`](../configuration.md) and
  [`getting-started.md:168-172`](../getting-started.md) still say the generic graph-set authority
  review is active. Graph-TDD itself is now scoped-released at 6/6; whole generic release remains
  blocked on review-effect v1.1 re-review, proof-source/production-write disjointness,
  cross-ticket preparation, the expanded Software matrix, and the frozen final fingerprint; and
- [`philosophy.md:237-243`](../philosophy.md) presents Software 0.4 in current tense without the
  nearby in-progress/release qualification above.

Owner routing is already recorded at [`compiler-graph-tdd.md:890-903`](compiler-graph-tdd.md).
`compiler-graph-tdd/root` should append the two compatibility histories and scoped-release status;
`software-default-design/root` should append the Software status qualification. Neither owner
should turn a scoped graph-TDD release into a whole-engine/profile release.

### P2 — current evidence has advanced beyond central/matrix Research wording

The central Research-diagnosis row still says two repairs/reruns are pending at
[`AGENT_COLLAB.md:115`](../AGENT_COLLAB.md), while the compiler owner now reports the two exact
Research regressions green, graph-set 6/6, Research profile 20/20, and core 452/0/3 at
[`compiler-graph-tdd.md:918-933`](compiler-graph-tdd.md). The integration matrix likewise preserves
the red/no-fix checkpoint at [`integration-matrix.md:611-628`](integration-matrix.md).

Those older failures must remain. Append the new moving-save-point evidence, but keep the gate open
until review-effect v1.1 is frozen/re-reviewed and the context owner runs its six exact checks on one
declared fingerprint. This is status propagation, not a release claim. Owner:
`primary-integrator/root` after the compiler owner declares the save point stable.

## Coordination-mailbox status hygiene

1. [`compiler-graph-tdd.md:3-7`](compiler-graph-tdd.md) still says the core implementation is
   pending, although its body records scoped graph-TDD release and names only later generic gates.
   Append a current transition; preserve the original start marker.
2. [`graph-tdd-engine-review.md:3-6`](graph-tdd-engine-review.md) still says `in_progress`, while its
   signed scoped final verdict is at
   [`graph-tdd-engine-review.md:277-346`](graph-tdd-engine-review.md). Append the scoped-complete /
   whole-engine-blocked transition beside the header.
3. [`context-hardening-review.md:5-9`](context-hardening-review.md) calls the review complete for its
   accepted earlier fingerprint, while [`context-hardening-review.md:168-186`](context-hardening-review.md)
   and its later Pi note make the current six-check stable-fingerprint rerun an active handoff gate.
   Append a current verification-hold transition so readers do not confuse accepted causal evidence
   with current-tree/post-Pi release.
4. [`activity-mailbox-release-sweep.md:3-6`](activity-mailbox-release-sweep.md) still says append-only
   reconciliation is required, though every required compact-title transition is now present.
   Append a status-only completion link; do not rewrite its conditional release verdict.

The review-effect header is already reconciled and should not be reopened from the older active
line.

## New ownership boundaries and routed questions

### Pi runtime cutover

The new central row [`AGENT_COLLAB.md:89`](../AGENT_COLLAB.md) and
[`pi-runtime-architect.md`](pi-runtime-architect.md) define a complete Codex-to-Pi replacement.
Initial child checkpoints read only narrow prerequisites, but the parent has now added an explicit
protocol-15 gate at [`pi-runtime-architect.md:70-85`](pi-runtime-architect.md): every Pi lane must
re-scan product docs/current mailboxes before integration; resource relocation and product-doc
evolution wait for stable Software/compiler/TUI handoffs; and Codex-era documentation stays in place
beside dated Pi transitions. That guard resolves the immediate coordination concern.

Still enforce these handoffs:

- `pi-runtime-architect/root` must name exact shared symbols before entering core/CLI/TUI files;
- `pi-schema-migration/root` and the parent may mechanically relocate profile resources only after
  `software-default-design/root` and generic compiler owners release stable bytes;
- adjacent Pi history in Architecture, Configuration, Codex resources, Migration, Philosophy,
  Runtime/Git, and Maturity must be coordinated with the existing product-doc owners rather than
  replacing their current Codex contract; and
- the final post-Pi matrix must rerun the six context hardening checks plus adversarial broker
  adapter tests, as recorded at [`context-hardening-review.md:188-211`](context-hardening-review.md).

No Pi product-doc history has yet been silently replaced; the work is in-progress and the above is
a handoff gate, not a finding that the new runtime design itself is invalid.

### Proof-preparation versus review-effect save point

[`proof-preparation-binding.md`](proof-preparation-binding.md) now owns a narrow new generic
predicate/binding and focused cross-ticket regressions. Its parent record correctly excludes
existing review-effect replay, but both can share engine helper neighborhoods. The compiler
integrator's freeze question at [`compiler-graph-tdd.md:918-933`](compiler-graph-tdd.md) is therefore
the authoritative sequence: freeze and fingerprint review-effect v1.1 before independent review;
do not let proof-preparation silently alter that candidate after review begins. This overlap is
already routed and needs no competing source edit from this lane.

## Final audit verdict

Compact Activity is fully propagated and must not be reopened. The remaining documentation release
blockers are generic compiler compatibility/status history, Software's still-outdated engineering
specification, and explicit reconciliation of the conflicting Software owner/reviewer claims above.
The new Pi runtime lane has a valid append-preserve/stable-owner guard, but it is not yet eligible to
relocate resources or rewrite product docs. All prior failure/count records remain causal history;
current owners should add linked transitions rather than normalize them away.

No command, test, install, TUI/cockpit action, live-state read/write, or source/profile mutation was
performed by this audit.

## Post-audit moving-tree transitions — 2026-07-14

The following records landed while this mailbox was being handed off. They narrow the findings
above and are appended here rather than rewriting the earlier checkpoint.

### Review-effect v1.1 current verdict changed

The reactivated engine reviewer published a new interim audit at
[`graph-tdd-engine-review.md:348-429`](graph-tdd-engine-review.md). The strict complete-candidate-set
implementation is now closed: v1.1 records the complete candidate universe/pre-state, reconstructs
and re-prepares it, rejects an omitted eligible member, and keeps replay failure atomic. Two release
gates remain, but their current names are more precise than the older central wording:

1. **P1 current review-input/target provenance remains open.** The effect-bearing acceptance branch
   does not recompute the canonical review input over the reconstructed pre-effect graph or compare
   it with `binding.input_hash`; target-node drift can therefore survive while candidates/output/
   graph hashes remain unchanged.
2. **The valid generic configured/runtime two-effect regression remains open.** The first mechanics
   test mutates an already compiled Research profile after validation, so it does not prove the
   configured effect contract passes `validate_review_effects`. The reviewer preserved and corrected
   its initial broader statement at `:416-429`.

Central graph/review-effect rows and the integration matrix should append this current disposition:
the old subset/test findings remain causal history, strict-subset implementation is closed, and
whole generic release remains blocked on review-input provenance plus a profile-valid configured
runtime regression. Do not report v1.1 released from its 5/5 private mechanics cluster.

### Exact sibling-proof progress is a new generic gate

After freezing its ten YAML files, the Software YAML owner found that two active proofs sharing one
verified subject can still inverse-fan-out from that subject. The sibling is outside ticket read
scope, so compilation fails closed, but the selected proof cannot make progress. The full finding
and rejected workarounds are at
[`software-profile-yaml.md:332-349`](software-profile-yaml.md).

The requested generic contract is a target-anchored direct-member selector for the exact pinned
proof candidates, used by Software baseline and promotion sets. Self-edges, duplicate proof-set
nodes, or broad sibling read authority are explicitly not acceptable. Route this to
`compiler-graph-tdd/root`, add the two-sibling exact-progress regression to the generic/Software
matrix, and retain it beside—not instead of—the separate cross-ticket preparation and path-
disjointness gates.

### Routed owner-record conflicts are now explicit gates

`primary-integrator/root` appended the Software owner-record reconciliation request at
[`software-default-design.md:518-537`](software-default-design.md) and the exact design-review
disposition request at
[`software-profile-design-review.md:487-507`](software-profile-design-review.md). Current source
inspection reports no remaining `localization_status`, contains diagnostic/no-speculative-change
prompt text, and contains the exact-one `objective.delivered_by` rule. Those observations narrow the
first Software finding above from a presumed source defect to a **signed-review/test gate**: the
independent reviewer must still verify current bytes and the expanded regressions before closing its
historical findings. The preset mailbox still needs an adjacent parent-owned post-release correction
note so its original specialist release is not misattributed to later bytes.

The Pi parent and all three children now also contain explicit protocol-15/readiness requests. Their
initial narrow read sets remain honest history; the required full doc/mailbox sweep, stable profile
handoff, exact shared-symbol ownership, and compiler-grant/CAS adapter proof are current handoff
gates rather than un-routed concerns.
