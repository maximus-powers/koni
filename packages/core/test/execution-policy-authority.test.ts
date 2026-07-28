import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertOperationGraphMutationPolicy,
  assertSourceManifestPreserved,
  createSourceByteManifest,
  decideConfiguredCheckRetry,
  deriveExecutionAdmissionConflicts,
  evaluateRequiredExecutionReceipts,
  ExecutionPolicyAuthorityError,
  resolveExecutionPolicyBinding,
  selectComposedReplayChecks,
  type ExecutionPolicyBinding,
  type ExecutionPolicyReceiptEvidence,
} from "../src/authority/execution-policy.js";
import type { AuthorityGrant } from "../src/authority/grants.js";
import {
  assertTerminalPolicyProjectionSafety,
  type RuntimeAssignmentTerminalPolicyProjection,
} from "../src/authority/run-engine.js";
import {
  compileExecutionSemanticCatalog,
  ExecutionSemanticCompilationError,
  type CompiledExecutionSemanticCatalog,
} from "../src/compiler/execution-semantics.js";
import type { CompiledConfiguration } from "../src/contracts/configuration.js";
import type { GraphNode } from "../src/graph/model.js";
import { canonicalHash, type Sha256Digest } from "../src/shared/canonical.js";

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("execution policy authority", () => {
  it("resolves immutable operation/workflow/step context only from the exact pinned digest", () => {
    const catalog = buildCatalog();
    const binding = bind(catalog, "ordinary", "promotion");

    expect(binding.configurationSha256).toBe(catalog.configurationSha256);
    expect(binding.workflowId).toBe("ordinary-flow");
    expect(binding.workflowVersion).toBe("1.2.3");
    expect(binding.context.outputContract.text).toBe("produce the typed result");
    expect(binding.context.reviewContract.text).toBe("independently review it");
    expect(binding.context.portfolioGuidance?.value.preferredCount).toBe(2);
    expect(binding.context.escalationTriggers.values).toEqual(["ambiguous upstream contract"]);
    expect(binding.context.stopConditions.values).toEqual(["source bytes changed"]);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.context.stopConditions.values)).toBe(true);

    expectPolicyError(
      () =>
        resolveExecutionPolicyBinding(catalog, {
          configurationSha256: digest("stale"),
          operationId: "ordinary",
          workflowId: "ordinary-flow",
          stepId: "promotion",
        }),
      "execution_policy.configuration_stale",
    );

    const edited = buildCatalog((registries) => {
      registries.operations.ordinary!.review_contract = "changed reviewer contract";
    });
    const editedBinding = bind(edited, "ordinary", "promotion");
    expect(editedBinding.context.reviewContract.sha256).not.toBe(
      binding.context.reviewContract.sha256,
    );
    expect(editedBinding.sha256).not.toBe(binding.sha256);
  });

  it("enforces edge-addition-only and typed gate contract policy on materialized nodes", () => {
    const catalog = buildCatalog();
    const ordinary = bind(catalog, "ordinary", "promotion");
    const claim = node("claim-1", "claim", { assertion: "before" }, { supports: ["claim-0"] });
    const gate = node("gate-1", "gate", { assertion: "must remain exact" }, {});
    const gates = { gateNodeTypes: ["gate"], gateNodes: [{ id: "gate-1", type: "gate" }] };

    expect(() =>
      assertOperationGraphMutationPolicy(catalog, ordinary, gates, [
        {
          before: claim,
          after: { ...claim, edges: { supports: ["claim-0", "claim-2"] } },
        },
      ]),
    ).not.toThrow();
    expectPolicyError(
      () =>
        assertOperationGraphMutationPolicy(catalog, ordinary, gates, [
          {
            before: claim,
            after: { ...claim, title: "changed" },
          },
        ]),
      "execution_policy.edge_only_non_edge_change",
    );
    expectPolicyError(
      () =>
        assertOperationGraphMutationPolicy(catalog, ordinary, gates, [
          {
            before: claim,
            after: { ...claim, edges: { supports: [] } },
          },
        ]),
      "execution_policy.edge_only_relation",
    );

    // Compiler-owned status/ordinary relationship projection is not a semantic gate-contract edit.
    expect(() =>
      assertOperationGraphMutationPolicy(catalog, ordinary, gates, [
        {
          before: gate,
          after: { ...gate, status: "ready", edges: { validates: ["claim-1"] } },
        },
      ]),
    ).not.toThrow();
    expectPolicyError(
      () =>
        assertOperationGraphMutationPolicy(catalog, ordinary, gates, [
          {
            before: gate,
            after: { ...gate, spec: { assertion: "silently weakened" } },
          },
        ]),
      "execution_policy.gate_contract_edit",
    );
    expectPolicyError(
      () =>
        assertOperationGraphMutationPolicy(catalog, ordinary, gates, [
          {
            before: gate,
            after: null,
          },
        ]),
      "execution_policy.gate_contract_deletion",
    );

    // Initial gate definition is not an edit to an already-materialized gate contract.
    expect(() =>
      assertOperationGraphMutationPolicy(catalog, ordinary, gates, [
        {
          before: null,
          after: node("gate-new", "gate", { assertion: "new" }, {}),
        },
      ]),
    ).not.toThrow();
    const application = bind(catalog, "application");
    expect(() =>
      assertOperationGraphMutationPolicy(catalog, application, gates, [
        {
          before: gate,
          after: { ...gate, spec: { assertion: "approved change" } },
        },
      ]),
    ).not.toThrow();
  });

  it("derives deterministic change-control, single-flight, and proof-preparation conflicts", () => {
    const root = mkdtempSync(join(tmpdir(), "koni-execution-policy-"));
    tempRoots.push(root);
    const catalog = buildCatalog();
    const ordinary = bind(catalog, "ordinary", "promotion");
    const application = bind(catalog, "application");
    const candidate = ticket("candidate", ordinary, ["claim-1"], ["src"]);
    const activeSameGroup = ticket("active-build", ordinary, ["other"], ["src/generated"]);
    const activeControl = {
      ...ticket("active-control", application, [], ["elsewhere"]),
      changeControlScopeNodeIds: ["claim-1"],
    };

    const conflicts = deriveExecutionAdmissionConflicts(catalog, root, candidate, [
      activeSameGroup,
      activeControl,
    ]);
    expect(conflicts.map((conflict) => conflict.kind)).toEqual([
      "change_control_barrier",
      "proof_preparation_overlap",
      "single_flight",
    ]);
    expect(conflicts[0]?.overlapNodeIds).toEqual(["claim-1"]);
    expect(conflicts[1]?.overlapPaths).toEqual(["src <> src/generated"]);

    const { changeControlScopeNodeIds: _scope, ...controlWithoutScope } = activeControl;
    expectPolicyError(
      () => deriveExecutionAdmissionConflicts(catalog, root, candidate, [controlWithoutScope]),
      "execution_policy.change_control_scope_missing",
    );
  });

  it("keeps historical and current receipts separate and rejects stale binding evidence", () => {
    const catalog = buildCatalog();
    const baseline = bind(catalog, "ordinary", "baseline");
    const promotion = bind(catalog, "ordinary", "promotion");
    const historicalCheck = catalog.checks.historical!;
    const currentCheck = catalog.checks.current!;
    const proofCheck = catalog.checks.proof!;
    const historical = receipt(catalog, baseline, {
      receiptId: "historical-1",
      receiptType: historicalCheck.receiptType,
      checkId: historicalCheck.id,
      checkSha256: historicalCheck.sha256,
      freshness: "historical",
      current: false,
      historicalEvidenceValid: true,
    });
    const baselineResult = evaluateRequiredExecutionReceipts(catalog, baseline, {
      receipts: [historical],
      structuredOutputAccepted: true,
      commandRan: false,
    });
    expect(baselineResult.missing).toEqual([]);
    expect(baselineResult.acceptedReceiptIds).toEqual(["historical-1"]);

    const current = receipt(catalog, promotion, {
      receiptId: "current-1",
      receiptType: currentCheck.receiptType,
      checkId: currentCheck.id,
      checkSha256: currentCheck.sha256,
      freshness: "current",
      current: true,
      historicalEvidenceValid: false,
    });
    const proof = receipt(catalog, promotion, {
      receiptId: "proof-1",
      receiptType: proofCheck.receiptType,
      checkId: proofCheck.id,
      checkSha256: proofCheck.sha256,
      freshness: "current",
      current: true,
      historicalEvidenceValid: false,
    });
    const passing = evaluateRequiredExecutionReceipts(catalog, promotion, {
      receipts: [current, proof],
      structuredOutputAccepted: true,
      commandRan: false,
    });
    expect(passing.missing).toEqual([]);

    const staleCurrent = { ...current, current: false };
    const staleBinding = { ...proof, bindingSha256: digest("another-binding") };
    const rejected = evaluateRequiredExecutionReceipts(catalog, promotion, {
      receipts: [staleCurrent, staleBinding],
      structuredOutputAccepted: true,
      commandRan: false,
    });
    expect(rejected.missing).toEqual(["current-receipt", "proof-receipt"]);
  });

  it("binds a baseline manifest to exact file bytes and rejects promotion drift", () => {
    const catalog = buildCatalog();
    const baselineBinding = bind(catalog, "ordinary", "baseline");
    const promotionBinding = bind(catalog, "ordinary", "promotion");
    const source = [
      { path: "src", kind: "directory" as const },
      {
        path: "src/model.ts",
        kind: "file" as const,
        bytes: Buffer.from("export const value = 1;\n"),
      },
    ];
    const baseline = createSourceByteManifest(catalog, baselineBinding, "baseline", source);
    const preserved = assertSourceManifestPreserved(catalog, promotionBinding, baseline, source);
    expect(preserved.preserved).toBe(true);
    expect(preserved.baselineManifestSha256).toBe(baseline.sha256);
    expectPolicyError(
      () =>
        assertSourceManifestPreserved(catalog, promotionBinding, baseline, [
          source[0]!,
          { path: "src/model.ts", kind: "file", bytes: Buffer.from("export const value = 2;\n") },
        ]),
      "execution_policy.source_bytes_changed",
    );
  });

  it("selects only current read-only composed replay leaves", () => {
    const catalog = buildCatalog();
    const selection = selectComposedReplayChecks(catalog, catalog.configurationSha256, [
      "side-effect",
      "historical",
      "opted-out",
      "current",
    ]);
    expect(selection.replayCheckIds).toEqual(["current"]);
    expect(selection.skipped).toEqual([
      { checkId: "historical", reason: "historical" },
      { checkId: "opted-out", reason: "opted_out" },
      { checkId: "side-effect", reason: "side_effecting" },
    ]);
  });

  it("allows receipt obligations with an exact zero-check projection and no configured-check grant", () => {
    const catalog = buildCatalog();
    const binding = bind(catalog, "proposal", "propose");
    const projection = terminalProjection(catalog, binding, {
      validationCheckIds: [],
      requiredReceiptTypes: ["context-pack", "structured-output", "scoped-compile"],
      validationChecks: [],
      composedReplayCheckIds: [],
    });

    expect(() =>
      assertTerminalPolicyProjectionSafety(projection, binding, unconfiguredCheckGrant()),
    ).not.toThrow();
  });

  it("rejects every non-empty terminal check projection without configured-check authority", () => {
    const catalog = buildCatalog();
    const binding = bind(catalog, "proposal", "propose");
    const grant = unconfiguredCheckGrant();
    const projectedWork: Array<{
      label: string;
      override: Partial<Omit<RuntimeAssignmentTerminalPolicyProjection, "sha256">>;
    }> = [
      { label: "validation check identity", override: { validationCheckIds: ["current"] } },
      {
        label: "resolved validation check",
        override: {
          validationChecks: [
            {} as RuntimeAssignmentTerminalPolicyProjection["validationChecks"][number],
          ],
        },
      },
      { label: "composed replay identity", override: { composedReplayCheckIds: ["current"] } },
    ];

    for (const candidate of projectedWork) {
      expect(
        () =>
          assertTerminalPolicyProjectionSafety(
            terminalProjection(catalog, binding, candidate.override),
            binding,
            grant,
          ),
        candidate.label,
      ).toThrow(/exceed the immutable configured-check grant/u);
    }
  });

  it("retries transient failures only within exact attempt, backoff, and aggregate bounds", () => {
    const catalog = buildCatalog();
    const retry = decideConfiguredCheckRetry(catalog, catalog.configurationSha256, {
      checkId: "current",
      attemptNumber: 1,
      exitCode: 75,
      aggregateElapsedSeconds: 10,
    });
    expect(retry).toMatchObject({ disposition: "retry", backoffSeconds: 2, nextAttemptNumber: 2 });
    expect(
      decideConfiguredCheckRetry(catalog, catalog.configurationSha256, {
        checkId: "current",
        attemptNumber: 3,
        exitCode: 75,
        aggregateElapsedSeconds: 20,
      }).disposition,
    ).toBe("attempts_exhausted");
    expect(
      decideConfiguredCheckRetry(catalog, catalog.configurationSha256, {
        checkId: "current",
        attemptNumber: 1,
        exitCode: 1,
        aggregateElapsedSeconds: 20,
      }).disposition,
    ).toBe("terminal_failure");
    expect(
      decideConfiguredCheckRetry(catalog, catalog.configurationSha256, {
        checkId: "current",
        attemptNumber: 1,
        exitCode: 75,
        aggregateElapsedSeconds: 86_399,
      }).disposition,
    ).toBe("time_budget_exhausted");
  });

  it("rejects unsupported check effects before they can influence replay", () => {
    expect(() =>
      buildCatalog((registries) => {
        registries.checks.current!.effect = "ambient_magic";
      }),
    ).toThrowError(ExecutionSemanticCompilationError);
  });
});

type MutableRegistries = {
  operations: Record<string, Record<string, unknown>>;
  workflows: Record<string, Record<string, unknown>>;
  checks: Record<string, Record<string, unknown>>;
};

function buildCatalog(
  edit?: (registries: MutableRegistries) => void,
): CompiledExecutionSemanticCatalog {
  const registries: MutableRegistries = {
    operations: {
      ordinary: {
        id: "ordinary",
        operation: "ordinary-work",
        stage: "execution",
        workflow: "ordinary-flow",
        allowed_existing_node_types: ["claim", "gate"],
        existing_node_edge_additions_only: { claim: ["supports"] },
        allow_gate_contract_edits: false,
        change_control_barrier: true,
        change_control: {
          role: "ordinary",
          allow_upstream_requests: true,
          proposal_operation: "propose-change",
        },
        proof_source_preparation_check: "proof",
        single_flight_group: "build",
        output_contract: "produce the typed result",
        review_contract: "independently review it",
        portfolio_guidance: {
          preferred_count: 2,
          unit: "coherent change",
          group_when: "one invariant",
          split_when: "independent invariants",
          avoid: "atomization",
        },
      },
      proposal: {
        id: "proposal",
        operation: "propose-change",
        stage: "change-control",
        workflow: "proposal-flow",
        change_control: {
          role: "proposal",
          proposal_step: "propose",
          application_operations: ["apply-change"],
        },
      },
      application: {
        id: "application",
        operation: "apply-change",
        stage: "change-control",
        allow_gate_contract_edits: true,
        change_control: { role: "application" },
      },
    },
    workflows: {
      "ordinary-flow": {
        id: "ordinary-flow",
        version: "1.2.3",
        applies_to: ["ordinary"],
        steps: [
          {
            id: "baseline",
            required: true,
            checks: ["historical"],
            required_receipts: ["historical-receipt"],
          },
          {
            id: "promotion",
            required: true,
            preserve_source_paths_from: "baseline",
            checks: ["current", "proof"],
            required_receipts: [
              "structured-output",
              "current-receipt",
              "proof-receipt",
              "runtime-receipt-when-command-runs",
            ],
            escalation_triggers: ["ambiguous upstream contract"],
            stop_conditions: ["source bytes changed"],
          },
        ],
      },
      "proposal-flow": {
        id: "proposal-flow",
        version: "1.0.0",
        applies_to: ["proposal"],
        steps: [{ id: "propose", required: true }],
      },
    },
    checks: {
      historical: {
        id: "historical",
        kind: "command",
        effect: "read_only",
        receipt_type: "historical-receipt",
        receipt_freshness: "historical",
        composed_replay: "never",
      },
      current: {
        id: "current",
        kind: "command",
        effect: "read_only",
        receipt_type: "current-receipt",
        receipt_freshness: "current",
        composed_replay: "required",
        retry_policy: { max_attempts: 3, transient_exit_codes: [75], backoff_seconds: [2, 4] },
      },
      proof: {
        id: "proof",
        kind: "composite",
        receipt_type: "proof-receipt",
      },
      "side-effect": {
        id: "side-effect",
        kind: "command",
        effect: "workspace_write",
        receipt_type: "side-effect-receipt",
      },
      "opted-out": {
        id: "opted-out",
        kind: "command",
        effect: "read_only",
        receipt_type: "opted-receipt",
        composed_replay: "never",
      },
    },
  };
  edit?.(registries);
  const material = {
    registries,
    edge_types: [{ source: "claim", relation: "supports", targets: ["claim"] }],
  };
  const configuration = {
    configuration_sha256: canonicalHash(material),
    registries: {
      ...Object.fromEntries(
        [
          "node_types",
          "queries",
          "graph_constraints",
          "gate_policies",
          "rules",
          "actions",
          "personas",
          "reports",
          "views",
          "state_machines",
          "agents",
        ].map((key) => [key, Object.create(null)]),
      ),
      ...registries,
    },
    edge_types: material.edge_types,
  } as unknown as CompiledConfiguration;
  return compileExecutionSemanticCatalog(configuration);
}

function bind(
  catalog: CompiledExecutionSemanticCatalog,
  operationId: string,
  stepId?: string,
): ExecutionPolicyBinding {
  const operation = catalog.operations[operationId]!;
  return resolveExecutionPolicyBinding(catalog, {
    configurationSha256: catalog.configurationSha256,
    operationId,
    ...(operation.workflowId === undefined ? {} : { workflowId: operation.workflowId }),
    ...(stepId === undefined ? {} : { stepId }),
  });
}

function node(
  id: string,
  type: string,
  spec: Record<string, string>,
  edges: Record<string, string[]>,
): GraphNode {
  return {
    schema_version: "1.0",
    id,
    type,
    title: id,
    status: "draft",
    spec,
    edges,
    annotations: {},
  };
}

function ticket(
  ticketId: string,
  binding: ExecutionPolicyBinding,
  targetNodeIds: string[],
  writePaths: string[],
) {
  return {
    ticketId,
    binding,
    targetNodeIds,
    readNodeIds: [],
    writeNodeIds: targetNodeIds,
    writePaths,
  };
}

function receipt(
  catalog: CompiledExecutionSemanticCatalog,
  binding: ExecutionPolicyBinding,
  overrides: Partial<ExecutionPolicyReceiptEvidence>,
): ExecutionPolicyReceiptEvidence {
  return {
    receiptId: "receipt",
    receiptType: "receipt",
    freshness: "current",
    status: "passed",
    configurationSha256: catalog.configurationSha256,
    catalogSha256: catalog.sha256,
    operationId: binding.operationId,
    ...(binding.workflowId === undefined ? {} : { workflowId: binding.workflowId }),
    stepId: binding.stepId!,
    bindingSha256: binding.sha256,
    integrityValid: true,
    current: true,
    historicalEvidenceValid: false,
    linkedToCurrentOutput: true,
    ...overrides,
  };
}

function terminalProjection(
  catalog: CompiledExecutionSemanticCatalog,
  binding: ExecutionPolicyBinding,
  override: Partial<Omit<RuntimeAssignmentTerminalPolicyProjection, "sha256">> = {},
): RuntimeAssignmentTerminalPolicyProjection {
  const material = {
    protocol: "koni.assignment-terminal-policy.v1" as const,
    configurationSha256: binding.configurationSha256,
    catalogSha256: binding.catalogSha256,
    catalog,
    executionPolicyBinding: binding,
    validationCheckIds: [],
    requiredReceiptTypes: [],
    validationChecks: [],
    composedReplayCheckIds: [],
    retainedReceipts: [],
    sourceManifestPairs: [],
    ...override,
  };
  return { ...material, sha256: canonicalHash(material) };
}

function unconfiguredCheckGrant(): AuthorityGrant {
  return {
    protocol: "koni.authority-grant.v1",
    grantId: "grant-one",
    runId: "run-one",
    ticketId: "proposal-ticket",
    stepId: "propose",
    attemptId: "attempt-one",
    sessionId: "session-one",
    epoch: 0,
    generation: 0,
    allowedTools: [],
    readPaths: ["graph"],
    writePaths: ["graph"],
    expectedRevision: 0,
    expectedStateHash: digest("state"),
  };
}

function digest(label: string): Sha256Digest {
  return canonicalHash(label);
}

function expectPolicyError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected execution policy authority to reject input");
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionPolicyAuthorityError);
    expect((error as ExecutionPolicyAuthorityError).code).toBe(code);
  }
}
