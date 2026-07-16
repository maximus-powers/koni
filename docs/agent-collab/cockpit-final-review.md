# Cockpit, delivery, and living-docs final review

- Owner: `final-runtime-audit/root` acting as `cockpit-final-review`.
- Started: 2026-07-15 America/Phoenix.
- Status: `in_progress` — read-only final-review of all current uncommitted cockpit-facing and
  delivery/documentation changes.
- Skill contract: `/Users/max/.codex/skills/final-review/SKILL.md` plus all three required
  references and both templates were read completely before review.
- Production authority: none. This lane will not edit CLI/TUI/runtime/profile/package/workflow/
  product-doc source, install a binary, mutate projects, signal processes, or touch live/forensic
  runs. Its only repository write is append-only evidence in this mailbox.

## Scope and semantic domains

1. Control-center and run interaction: `crates/koni-tui`, relevant CLI control surfaces, run
   creation/approval/questions/pause/delete/merge/chat/graph presentation, and profile-facing
   configuration UX.
2. Installation and upgrade: CLI init/install/replace/migration behavior, bundled template
   preservation, developer installer, and Homebrew packaging.
3. CI and release delivery: build/test/release workflows, runtime artifacts, provenance/SBOM,
   and package/runtime compatibility.
4. User and living documentation: README, product docs, skills/templates, backlog, central
   coordination, and current runtime/UI truth.
5. Cross-domain state/action audit: UI affordance to durable action mapping, refresh/upgrade
   safety, public commands/config schemas, testing evidence, and unnecessary complexity.

Database-load analysis is required by the final-review rubric; no database-backed runtime is
currently apparent in this scope, so it will be reported as N/A unless inspection finds one.

## Coordination checkpoint

- Repository path has moved from the historical `real-nigga-harness` name to
  `/Users/max/Desktop/koni`; the parent was notified before inspection.
- Read the current central coordination protocol and live-run safety boundary. The two historical
  Updog run IDs remain protected; no live or installed state belongs to this review.
- The shared tree contains more than 94k changed lines and many coherent parallel edits. Findings
  will be anchored to current files/lines and will not infer authorship from Git status.
- Parent-owned compiler and runtime final-review lanes are active separately. This lane will treat
  their core-runtime findings as integration inputs and concentrate on cockpit, delivery, and
  documentation behavior.

