# Standalone Support-Run Asset Repair Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically route a rejected standalone prerequisite runtime check back to the exact
already-approved generated-asset implementation workflow without another operator decision.

**Architecture:** Extend the compiler's existing recurring-asset evidence comparison with an exact
standalone-run-to-asset binding derived from `runtime_contract.asset_entrypoints`. Project a new
hash-bound repair-scope ticket identity that adds failed-run context read-only while retaining the
original asset write grant, then let normal recurring-ticket reconciliation reissue and settle the
repair by authenticated workflow epoch.

**Tech Stack:** TypeScript, Vitest, Koni compiled graph/ticket records, research-profile
compatibility projections.

## Global Constraints

- Modify only Koni project files; never manually edit MUAT graph artifacts, run records, tickets,
  checks, or source files.
- Do not lower scientific thresholds, change hypotheses, or rescope behavior sets automatically.
- Apply only to `compiler.compatibility.research-standalone-support-run`; ordinary experiment
  outcomes are not asset defects.
- Bind repair authority only through typed `spec.runtime_contract.asset_entrypoints[].asset_id`
  records.
- Preserve the existing asset workflow's target, write-node scope, write paths, operation, and
  workflow.
- A historical failure is actionable only when it is newer than the latest fully completed asset
  repair epoch and remains the latest runtime check.
- Keep all changes uncommitted.

---

### Task 1: Detect an unaddressed standalone runtime failure

**Files:**

- Modify: `packages/core/test/native-run-program.test.ts`
- Modify: `packages/core/src/compiler/run-program.ts`

**Interfaces:**

- Consumes: `RunRecord["tickets"]`, `RunRecord["attempts"]`, `RunRecord["checks"]`, one generated
  asset node id, and the standalone run node ids bound to it.
- Produces: `recurringAssetHasUnaddressedStandaloneRunFailure(input): boolean`.

- [ ] **Step 1: Write the failing evidence-ordering regression**

Add the function import and a test beside `recurringAssetHasUnaddressedGateFailure`:

```ts
it("reopens a generated asset only for its latest unaddressed standalone runtime failure", () => {
  const assetTicket = {
    id: "ticket-asset",
    operationId: "asset-resolution.asset.implement-asset",
    targetNodeIds: ["asset-generator"],
    status: "cancelled",
    steps: [
      { id: "implement", attemptIds: ["asset-implement"] },
      { id: "review", attemptIds: ["asset-review"] },
    ],
  } as unknown as TicketRecord;
  const runTicket = {
    id: "ticket-support-run",
    operationId: "execution.run.run-experiment",
    targetNodeIds: ["run-support"],
  } as unknown as TicketRecord;
  const attempts = {
    "asset-implement": {
      id: "asset-implement",
      ticketId: assetTicket.id,
      stepId: "implement",
      status: "completed",
      ticketExecutionEpoch: 2,
      endedAt: "2026-08-09T01:00:00.000Z",
      terminalSummary: "implemented",
    },
    "asset-review": {
      id: "asset-review",
      ticketId: assetTicket.id,
      stepId: "review",
      status: "completed",
      ticketExecutionEpoch: 2,
      endedAt: "2026-08-09T01:05:00.000Z",
      terminalSummary: "approved",
    },
    "run-attempt": {
      id: "run-attempt",
      ticketId: runTicket.id,
      stepId: "run",
      status: "failed",
    },
  } as unknown as RunRecord["attempts"];
  const rejected = {
    attemptId: "run-attempt",
    requestedCheckId: "scientific-runtime",
    accepted: false,
    passed: false,
    recordedAt: "2026-08-09T02:00:00.000Z",
  } as unknown as NonNullable<RunRecord["checks"]>[number];

  const input = {
    tickets: { [assetTicket.id]: assetTicket, [runTicket.id]: runTicket },
    attempts,
    checks: [rejected],
    assetNodeId: "asset-generator",
    runNodeIds: new Set(["run-support"]),
  };
  expect(recurringAssetHasUnaddressedStandaloneRunFailure(input)).toBe(true);
  expect(
    recurringAssetHasUnaddressedStandaloneRunFailure({
      ...input,
      checks: [
        rejected,
        { ...rejected, accepted: true, passed: true, recordedAt: "2026-08-09T02:10:00.000Z" },
      ],
    }),
  ).toBe(false);
  expect(
    recurringAssetHasUnaddressedStandaloneRunFailure({
      ...input,
      checks: [{ ...rejected, recordedAt: "2026-08-09T00:30:00.000Z" }],
    }),
  ).toBe(false);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run packages/core/test/native-run-program.test.ts -t "reopens a generated asset only for its latest unaddressed standalone runtime failure"
```

Expected: TypeScript/Vitest failure because `recurringAssetHasUnaddressedStandaloneRunFailure` is
not exported.

- [ ] **Step 3: Implement the evidence comparator**

Add beside `recurringAssetHasUnaddressedGateFailure`:

```ts
export function recurringAssetHasUnaddressedStandaloneRunFailure(input: {
  readonly tickets: Readonly<Record<string, TicketRecord>>;
  readonly attempts: Readonly<Record<string, AgentAttemptRecord>>;
  readonly checks: readonly RunCheckRecord[] | undefined;
  readonly assetNodeId: string;
  readonly runNodeIds: ReadonlySet<string>;
}): boolean {
  const runTicketIds = new Set(
    Object.values(input.tickets)
      .filter(
        (ticket) =>
          ticket.operationId === "execution.run.run-experiment" &&
          ticket.targetNodeIds.some((nodeId) => input.runNodeIds.has(nodeId)),
      )
      .map((ticket) => ticket.id),
  );
  const latestRuntimeCheck = input.checks
    ?.filter((check) => {
      const attempt = input.attempts[check.attemptId];
      return (
        check.requestedCheckId === "scientific-runtime" &&
        attempt !== undefined &&
        runTicketIds.has(attempt.ticketId)
      );
    })
    .sort((left, right) => compareText(left.recordedAt, right.recordedAt))
    .at(-1);
  if (latestRuntimeCheck?.accepted !== false) return false;

  const latestRepairAt = Object.values(input.tickets)
    .filter(
      (ticket) =>
        ticket.operationId === "asset-resolution.asset.implement-asset" &&
        ticket.targetNodeIds.includes(input.assetNodeId),
    )
    .flatMap((ticket) => completedRecurringAssetEpochTimes(ticket, input.attempts))
    .sort(compareText)
    .at(-1);
  return (
    latestRepairAt === undefined || compareText(latestRuntimeCheck.recordedAt, latestRepairAt) > 0
  );
}
```

Import `RunCheckRecord` from `../state/run-record.js` in `run-program.ts` if it is not already
imported.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run the Step 2 command.

Expected: PASS for actionable failure, later pass suppression, and newer repair suppression.

---

### Task 2: Bind standalone runs to exact executable assets and repair scope

**Files:**

- Modify: `packages/core/test/native-run-program.test.ts`
- Modify: `packages/core/src/compiler/run-program.ts`

**Interfaces:**

- Consumes: `ResearchRunContractScopeGraph` and `CompiledRuleEvaluation`.
- Produces:
  `standaloneSupportRunAssetNodeIds(graph, evaluation): ReadonlyMap<string, ReadonlySet<string>>`
  and `standaloneSupportRunAssetRepairScopeFallback(graph, evaluation): CompiledRuleEvaluation`.

- [ ] **Step 1: Write the failing exact-binding and scope regression**

Construct a graph containing:

```ts
const nodes = new Map([
  [
    "asset-generator",
    {
      id: "asset-generator",
      type: "asset",
      spec: {
        source_strategy: "generated",
        implementation_plan: { root: "program/assets/generator" },
      },
    },
  ],
  [
    "asset-read-only",
    {
      id: "asset-read-only",
      type: "asset",
      spec: {
        source_strategy: "generated",
        implementation_plan: { root: "program/assets/read_only" },
      },
    },
  ],
  [
    "run-support",
    {
      id: "run-support",
      type: "run",
      spec: {
        runtime_contract: {
          asset_entrypoints: [
            { asset_id: "asset-generator", path: "program/assets/generator/run.py" },
          ],
          output_root: "runs/support",
        },
      },
    },
  ],
  ["gate-support", { id: "gate-support", type: "gate", spec: {} }],
]);
const graph = {
  node: (id: string) => nodes.get(id),
  edges: () => [
    { source: "run-support", relation: "uses", target: "asset-generator" },
    { source: "run-support", relation: "uses", target: "asset-read-only" },
    { source: "run-support", relation: "evaluates", target: "gate-support" },
  ],
};
```

Create one ordinary `implement-asset` definition targeting `asset-generator`, another targeting
`asset-read-only`, and a standalone support-run definition targeting `run-support`. Assert:

```ts
const bindings = standaloneSupportRunAssetNodeIds(graph, evaluation);
expect([...bindings.get("asset-generator")!]).toEqual(["run-support"]);
expect(bindings.has("asset-read-only")).toBe(false);

const scoped = standaloneSupportRunAssetRepairScopeFallback(graph, evaluation);
const generator = scoped.tickets.find((ticket) =>
  ticket.target_node_ids.includes("asset-generator"),
)!;
expect(generator.id).not.toBe(originalGenerator.id);
expect(generator.scope.read_node_ids).toEqual(["asset-generator", "gate-support", "run-support"]);
expect(generator.scope.read_paths).toEqual(["program/assets/generator", "runs/support"]);
expect(generator.scope.write_node_ids).toEqual(["asset-generator"]);
expect(generator.scope.write_paths).toEqual(["program/assets/generator"]);
expect(
  scoped.tickets.find((ticket) => ticket.target_node_ids.includes("asset-read-only"))!.id,
).toBe(originalReadOnly.id);
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run packages/core/test/native-run-program.test.ts -t "scopes standalone support-run repair to exact executable assets"
```

Expected: failure because both functions are not exported.

- [ ] **Step 3: Implement exact asset bindings**

Add a helper near `standaloneSupportRunGateNodeIds` that:

1. Filters definitions to `rule_id === "compiler.compatibility.research-standalone-support-run"`.
2. Reads each target run's `runtime_contract.asset_entrypoints` array.
3. Accepts only object entries whose `asset_id` names a graph asset with
   `spec.source_strategy === "generated"`.
4. Returns sorted run-node sets by asset id.

Use `optionalRecord` for the runtime contract and entrypoint records. Do not infer bindings from
`uses` edges.

- [ ] **Step 4: Implement repair-scope projection**

For every `asset-resolution.asset.implement-asset` definition with bound standalone runs:

1. Add the bound run ids and each outgoing `evaluates` target to `scope.read_node_ids`.
2. Add each bound run's nonempty `runtime_contract.output_root` to `scope.read_paths`.
3. Preserve `scope.write_node_ids`, `scope.write_paths`, the workflow, and all non-scope fields.
4. Replace the original definition with a new id:

```ts
const id = `TK-compat-standalone-run-asset-repair-scope-${digestBody(
  canonicalHash({
    configuration_sha256: evaluation.configuration_sha256,
    source_definition_id: definition.id,
    target_node_ids: definition.target_node_ids,
    support_run_node_ids: runNodeIds,
    read_node_ids: readNodeIds,
    read_paths: sortedReadPaths,
  }),
).slice(0, 24)}`;
```

Set `rule_id` to `compiler.compatibility.standalone-support-run-asset-repair-scope`, recompute
`definition_sha256`, and rehash the evaluation.

- [ ] **Step 5: Run the focused test and confirm GREEN**

Run the Step 2 command.

Expected: PASS with the non-entrypoint `uses` asset unchanged and exact write authority preserved.

---

### Task 3: Activate recurring repair in compiler reconciliation

**Files:**

- Modify: `packages/core/test/native-run-program.test.ts`
- Modify: `packages/core/src/compiler/run-program.ts`

**Interfaces:**

- Consumes: Task 1's evidence comparator and Task 2's binding map.
- Produces: `recurringAssetReissueNodeIds` marks only bound assets with unaddressed standalone
  runtime failures, and `researchRunContractScopeFallback` returns the repair-scoped definitions.

- [ ] **Step 1: Extend the recurring-reissue truth-table regression**

Update the `recurringAssetRequiresReissue` test to assert:

```ts
expect(
  recurringAssetRequiresReissue({
    implementationCurrent: true,
    selectedGateContractsCurrent: true,
    selectedGateBlocked: false,
    standaloneSupportRunFailed: true,
  }),
).toBe(true);
```

Keep the existing all-current case false.

- [ ] **Step 2: Run the truth-table test and confirm RED**

Run:

```bash
npx vitest run packages/core/test/native-run-program.test.ts -t "reissues recurring assets only for incomplete implementation, selected contract drift, gate failure, or standalone runtime failure"
```

Expected: TypeScript failure because `standaloneSupportRunFailed` is not part of the input.

- [ ] **Step 3: Integrate the failure signal**

Extend `recurringAssetRequiresReissue` with optional `readonly standaloneSupportRunFailed?: boolean`
and include it in the disjunction.

In `recurringAssetReissueNodeIds`:

1. Derive `standaloneRunNodeIdsByAsset` once with Task 2's helper.
2. For each generated asset implementation definition, call Task 1's comparator with the bound run
   ids.
3. Pass the result as `standaloneSupportRunFailed`.

Do not change the existing delegated-gate exclusions or gate repair timestamp logic.

- [ ] **Step 4: Integrate repair-scope projection**

In `researchRunContractScopeFallback`, pass the gate-scoped evaluation through
`standaloneSupportRunAssetRepairScopeFallback` before returning it. This makes the new definition
identity available both to board reconciliation and the recurring-applicability filter.

- [ ] **Step 5: Run focused and native compiler tests**

Run:

```bash
npx vitest run packages/core/test/native-run-program.test.ts -t "standalone support-run|recurring asset|recurring provider"
npx vitest run packages/core/test/native-run-program.test.ts
```

Expected: all focused and full native compiler tests pass.

---

### Task 4: Verify, install, and exercise the live MUAT recovery

**Files:**

- Verify: `packages/core/src/compiler/run-program.ts`
- Verify: `packages/core/test/native-run-program.test.ts`
- Verify: `docs/superpowers/specs/2026-08-09-standalone-support-run-asset-repair-routing-design.md`
- Verify: `docs/superpowers/plans/2026-08-09-standalone-support-run-asset-repair-routing.md`

**Interfaces:**

- Consumes: the completed compiler implementation and existing development installer.
- Produces: a verified Koni bundle and live evidence that MUAT reissues the exact generated asset
  repair without operator intervention.

- [ ] **Step 1: Run repository verification proportional to the compiler change**

Run:

```bash
npm run typecheck --workspace @koni/core
npx vitest run packages/core/test/native-run-program.test.ts
npm run build --workspace @koni/core
npx prettier --check packages/core/src/compiler/run-program.ts packages/core/test/native-run-program.test.ts docs/superpowers/specs/2026-08-09-standalone-support-run-asset-repair-routing-design.md docs/superpowers/plans/2026-08-09-standalone-support-run-asset-repair-routing.md
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Inspect the scoped diff**

Run:

```bash
git diff -- packages/core/src/compiler/run-program.ts packages/core/test/native-run-program.test.ts docs/superpowers/specs/2026-08-09-standalone-support-run-asset-repair-routing-design.md docs/superpowers/plans/2026-08-09-standalone-support-run-asset-repair-routing.md
git status --short
```

Confirm unrelated user changes remain untouched and no commit exists.

- [ ] **Step 3: Install the verified development bundle**

Run from `/Users/max/Desktop/koni`:

```bash
KONI_DEV_FAST_INSTALL=1 ./scripts/install-dev.sh
```

Record the installed bundle path and build identity from the successful output.

- [ ] **Step 4: Resume the same MUAT run without editing MUAT state**

Use Koni's normal resume action for `run-e0fa036e-137b-4228-9019-dbab8f2dd25e`. Restart only the
authority/TUI process if the installed bundle identity requires it. Keep the TUI visible on
left-panel surface `surface:17`.

- [ ] **Step 5: Prove live autonomous repair routing**

Inspect the run record and require all of the following before declaring the fix live:

- lifecycle leaves `blocked` without a new operator question;
- a repair-scoped `asset-resolution.asset.implement-asset` ticket targets
  `asset-c86db1298308097e2db2`;
- its write path remains exactly `program/assets/muat_dev_pool`;
- its read scope includes `run-4b2b91238f0a6c9051e2` and read path includes `runs/muat_dev_pool`;
- the ticket enters `running` and its launch spec uses the newly installed Koni bundle;
- no MUAT file was manually edited by this smoke-test agent.

- [ ] **Step 6: Continue the persistent smoke test**

Monitor asset repair, prerequisite rerun, downstream experiments, gates, report synthesis, and
review. For each new Koni defect, repeat systematic debugging and TDD in Koni only. Completion
requires the medium research run itself to reach its done/review-ready state.
