# Standalone Support-Run Asset Repair Routing

## Context

The research profile can materialize a prerequisite artifact through a standalone scientific run.
That run declares the generated assets it executes in `spec.runtime_contract.asset_entrypoints`. If
its required `scientific-runtime` check rejects the result, Koni records the failed attempt and
terminal resolver correctly, but its recurring asset repair logic currently considers only selected
verifier-gate failures. A current generated asset therefore remains settled even when its own
entrypoint caused the prerequisite run to fail. The board eventually has no live operation that can
repair the source and Lead requests an additional operator decision after the run was already
approved.

This breaks the research-harness contract that planning and approval are the only required user
interaction before review-ready completion.

## Goals

- Route a rejected standalone support-run runtime check back to the existing, approved
  `implement-asset` workflow for the exact generated asset entrypoints used by that run.
- Preserve the asset workflow's existing write boundary while giving it enough read-only context to
  diagnose the failed run.
- Retry only when the runtime failure is newer than the latest completed repair of that asset.
- Keep the behavior deterministic, auditable, and applicable to future research projects rather than
  special-casing MUAT identifiers.

## Non-goals

- Do not lower scientific thresholds, change hypotheses, or rescope behavior sets automatically.
- Do not let a terminal resolver write an asset it did not already own.
- Do not add a post-approval operator change request for work already covered by the approved
  generated-asset plan.
- Do not treat ordinary experiment outcomes as asset defects. This routing applies only to the
  compiler's bounded standalone support-run compatibility operation.
- Do not edit MUAT outside Koni-managed ticket execution.

## Selected Design

### 1. Derive exact support-run-to-asset bindings

For every ticket definition emitted by `compiler.compatibility.research-standalone-support-run`,
inspect each target run's `spec.runtime_contract.asset_entrypoints`. Accept only entrypoint records
with an `asset_id` that names a generated asset already owned by an
`asset-resolution.asset.implement-asset` definition.

The explicit `asset_entrypoints` contract is the authority boundary. A generic `uses` edge is not
enough because a run can read verifier or data assets that did not execute the failing command.

### 2. Detect one unaddressed runtime failure

For each bound asset, inspect durable checks from tickets that execute the bound standalone run. Use
the latest `scientific-runtime` check only. It is actionable when:

- the check was rejected (`accepted: false`);
- its attempt belongs to an `execution.run.run-experiment` ticket targeting the bound run; and
- its `recordedAt` is later than the latest fully completed execution epoch of any `implement-asset`
  ticket targeting the bound asset.

If a later runtime check passed, or a completed asset repair postdates the failure, the failure is
settled and must not reopen the asset. This comparison reuses the existing authenticated
per-workflow-step epoch evidence used by recurring verifier repairs.

### 3. Project a repair-scoped asset definition

When a standalone run is bound to an asset, replace the ordinary current `implement-asset`
definition with a deterministic compatibility definition whose read scope adds:

- the standalone run node;
- the gate nodes that the run evaluates; and
- the run's declared output root as a read-only path, when present.

The definition retains the original target asset, write-node scope, write paths, workflow, and
operation. Its deterministic identity includes the source definition, bound runs, resulting read
nodes, and read paths so a previously executed narrower ticket is never mutated under the same
identity.

The expanded context lets the asset builder inspect the runtime contract and the resolver-authored
failure diagnosis while writing only beneath the asset's preapproved implementation root.

### 4. Reconcile and continue

The unaddressed failure marks the bound asset as a required recurring reissue. Normal ticket-board
reconciliation creates or reopens the repair-scoped `implement-asset` ticket. After its complete
workflow is reviewed and integrated, the repair completion timestamp settles the old runtime
failure. Existing dependency and terminal-resolver reconciliation then reissues the prerequisite run
against the new asset bytes.

A fresh rejected runtime check after that repair is new evidence and may reopen the same scoped
asset workflow once more. An unchanged historical failure cannot.

## Alternatives Rejected

### Expose a change-request tool to terminal resolvers

This is more flexible, but it turns already-approved asset work into a new operator decision and
does not satisfy the autonomous-run requirement.

### Expand terminal-resolver write authority

Letting a resolver edit assets reached through a run would combine diagnosis and repair across
ownership boundaries. It is broader than needed and weakens Koni's grant model.

### Reissue every asset connected by `uses`

This would be easy to derive but overbroad. It could reopen read-only data, verifier, or auxiliary
assets unrelated to the failing executable. The typed `asset_entrypoints` list is the narrower
causal binding.

## Failure Handling and Safety

- Missing or malformed `asset_entrypoints` produce no automatic asset repair; existing terminal
  diagnosis remains authoritative.
- Assets without an existing generated-asset implementation definition are not granted new write
  authority.
- A passing latest runtime check suppresses stale rejected checks from the same or earlier attempts.
- A completed repair must be authenticated across every workflow step in one common execution epoch
  before it settles a failure.
- Repair definition identities change when their scope changes, preventing issued-grant drift.
- No check receipt, run record, graph artifact, or MUAT file is edited manually.

## Verification

Regression tests will prove:

1. A rejected `scientific-runtime` check newer than the latest completed asset repair is actionable.
2. A later successful runtime check suppresses an earlier rejection.
3. A completed asset repair newer than the rejection suppresses reissue.
4. Only assets named by standalone-run `asset_entrypoints` are selected.
5. The repair-scoped definition adds the run, evaluated gate, and output root read-only while
   preserving exact asset write authority.
6. The compatibility definition has a new stable hash-bound identity and does not mutate an
   already-issued narrower ticket.
7. Existing delegated-gate and recurring-provider behavior remains unchanged.

After focused and full local verification, install the Koni development bundle, resume the same
medium MUAT run, and confirm live that the generated dev-pool asset becomes actionable without an
operator decision. Keep the TUI in the left cmux panel and continue monitoring until the run is
review-ready.
