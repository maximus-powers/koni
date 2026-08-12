# Source-Owned Asset Repair Routing Plan

> Execute this plan inline with systematic debugging, test-driven development, and
> verification-before-completion. Do not weaken proposal approval authority.

**Goal:** Recover a held generated-asset repair when its pristine upstream proposal names the
failing gates instead of redundantly naming the asset already owned by the proposal's exact source
ticket.

**Architecture:** Keep proposal tickets immutable and operator-controlled by default. Extend the
existing planned-asset repair compatibility path only when the proposal is pristine and unapproved,
its exact held source is an `asset-resolution.asset.implement-asset` ticket, every source-owned
asset is still backed by a current compiler `implement-asset` definition, and the repair request is
recovered for that same source-owned asset. The compiler then cancels the never-started proposal as
superseded by already-approved planned asset work and reissues the bounded asset ticket with the
request hash as an obligation.

**Tech Stack:** TypeScript, Vitest, Koni compiler reconciliation and native run-program tests.

---

## Task 1: Reproduce the missed routing case

**Files:**

- Modify: `packages/core/test/native-run-program.test.ts`

Add a focused test whose pristine proposal targets gate nodes while the exact held source is an
`implement-asset` ticket targeting one existing asset. Assert that the proposal routes through the
current asset definition and that `plannedAssetRepairRequestForNode` returns the immutable request
for only that source-owned asset.

Run the focused test and confirm it fails because the current router considers only proposal target
node IDs.

## Task 2: Implement source-owned bounded routing

**Files:**

- Modify: `packages/core/src/compiler/run-program.ts`

Derive candidate repair asset IDs from both proposal targets and the exact held source ticket when
that source operation is `asset-resolution.asset.implement-asset`. Require every candidate asset to
have a current compiler implementation definition. Reuse the same derivation in
`plannedAssetRepairRequestForNode` so a routed gate-targeted proposal reissues only its source-owned
asset.

Preserve all existing exclusions for started proposals, decisions, approval history,
missing/mismatched source holds, and non-asset source operations.

## Task 3: Verify the compatibility repair

Run the focused native test, then the full native run-program suite. Run core typecheck, lint,
formatting/diff checks required by the repository. Inspect the diff for scope and preserve unrelated
working-tree changes.

## Task 4: Install and exercise on the managed MUAT run

Install the verified Koni runtime, restart only the exact left-panel TUI and authority processes,
and resume compiler reconciliation. Confirm the pristine gate-targeted proposal is retired through
the planned asset workflow, the held verifier asset ticket becomes actionable, and the TUI remains
live.

Continue systematic diagnosis for any subsequent environment or preflight-gate failure. Add a
separate failing test before each additional production correction. Do not manually edit MUAT graph,
run JSON, program files, or dependency state.
