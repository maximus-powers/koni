# Updog north-star audit

Last checked: 2026-07-14 (America/Phoenix)

## Scope

Read-only comparison of Updog's planning, verification, review-context, and maintained-spec
framework with Köni Software 0.4. This mailbox records design evidence only; it does not authorize
edits to Updog, Research, installed profiles, or live runs.

## Primary Updog evidence read

- `/Users/max/Desktop/updog/packages/agents/sops/desktop/task-planning.md`
- `/Users/max/Desktop/updog/.agents/skills/verification-standard/SKILL.md`
- `/Users/max/Desktop/updog/.agents/skills/review-context/SKILL.md`
- `/Users/max/Desktop/updog/.agents/skills/planning-docs/SKILL.md`
- `/Users/max/Desktop/updog/specs/meta/evidence-artifacts.md`
- `/Users/max/Desktop/updog/specs/meta/evidence-citations.md`
- `/Users/max/Desktop/updog/specs/meta/spec-references.md`
- `/Users/max/Desktop/updog/specs/meta/verification-fingerprints.md`
- `/Users/max/Desktop/updog/spec-framework/src/test-metadata.ts`
- `/Users/max/Desktop/updog/spec-framework/spec-framework.test.ts`

## Parity and intentional translation

1. **Plan by shared decisions and reviewable claims.** Updog minimizes decision surface area but
   splits a Step when one reviewer would otherwise approve multiple risk tiers, evidence packets,
   or correction paths. Software 0.4 expresses the same invariant as the fewest dependency-ordered
   vertical `change` nodes, each with one `approval_claim`, risk tier, bounded write scope, and exact
   proof packet. It does not split by file, layer, persona, or phase.
2. **Make proof part of the plan.** Updog requires the cheapest trustworthy layer, tests first when
   feasible, characterization around disturbed behavior, a practical highest-level smoke when
   wiring matters, and explicit proof gaps. Software translates this to adaptive `red_green`,
   `characterization`, and `current_verification`; focused proof is mandatory, while another proof
   or risk-bound boundary proof exists only for a distinct uncovered gap.
3. **Evidence has one owner and must remain current.** Updog's spec framework resolves readable,
   globally unique evidence titles to actual tests/artifacts, delegates ownership through spec
   references, and designs content-addressed fingerprints that stale when inputs change. Software
   makes a proof node the sole argv/path/evidence authority, restricts each focused proof to one
   implementation subject, binds receipts and source manifests to compiler-selected members, and
   reopens work when evidence is stale.
4. **Smoke validates wiring, not ceremony.** Updog explicitly rejects broad end-to-end tests for
   everything and asks for a few boring smokes at real adapter/UI/runtime boundaries. Software's
   focused proof is the default; integration/end-to-end layers and extra proofs are justified only
   by an actual wiring, compatibility, runtime, UI, data, or operational gap. Target sync and
   composed verification remain pipeline boundaries rather than per-ticket duplicate Verifier work.
5. **Review must understand the repository.** Updog's review-context skill suppresses domain false
   positives and prioritizes correctness, error paths, data consistency, propagation, and intent
   coverage. Software keeps one independent Reviewer trust boundary and expects customization to
   bind repository skills/personas. Critical work always needs a human-approved review-authority
   decision, but the profile correctly refuses to infer specialist competence from a persona label.
6. **Planning prose is not a second source of truth.** Updog keeps generated planning documents in
   ignored history while maintained specs, tests, evidence, and fingerprints carry durable truth.
   Köni preserves the complete approved plan for human review but compiles the durable working
   contract into a typed graph seed; tickets arise from semantic gaps rather than a hand-maintained
   phase checklist.

## Differences retained deliberately

- Updog's default smoke matrix is product-specific and includes local-first/browser/vendor paths.
  A generic Software profile cannot mandate those surfaces without inventing work. The
  customization skill instead discovers project-native CI, adapters, interfaces, UI journeys, and
  commands, then adds proof only where the repository and risk require it.
- Updog ticket/check state is application-domain specific. Köni's graph separates semantic claim,
  compiler-derived obligation, operation authority, workflow, receipt, and review effect so agents
  cannot mark work complete by prose or task status alone.
- Updog's future verification fingerprints accept paperwork because agents maintain it. Köni
  obtains the same freshness property from compiler-owned source manifests, exact receipts, and
  semantic hashes, keeping human review focused on claims and exceptions.

## Verdict

No P0 or P1 Software-profile gap remains after the contract-designer and unconditional critical-
authority prompt corrections. Evidence-Guided Vertical Delivery is a faithful generalization of
the strongest Updog ideas: decision-centered planning, executable acceptance, adaptive proof,
content-current evidence, domain-aware independent review, and minimal ceremony. A P2 project
customization may add typed browser/recorded-flow/audit artifacts for UI-heavy repositories, but
the generic default should not impose them.
