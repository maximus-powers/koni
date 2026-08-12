import type {
  CompiledCheckSemantics,
  CompiledExecutionSemanticCatalog,
  CompiledOperationSemantics,
  CompiledPortfolioGuidance,
  CompiledWorkflowSemantics,
  CompiledWorkflowStepSemantics,
  ReceiptFreshness,
} from "../compiler/execution-semantics.js";
import type { GraphNode } from "../graph/model.js";
import {
  canonicalHash,
  compareUtf8,
  isSha256Digest,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import {
  createProjectPathAuthority,
  normalizeProjectRelativePath,
  type ProjectPathAuthority,
} from "../shared/project-path-authority.js";

export const EXECUTION_POLICY_BINDING_PROTOCOL = "koni.execution-policy-binding.v1" as const;
export const SOURCE_BYTE_MANIFEST_PROTOCOL = "koni.source-byte-manifest.v1" as const;
export const SOURCE_PRESERVATION_RECEIPT_PROTOCOL = "koni.source-preservation-receipt.v1" as const;
export const EXECUTION_RECEIPT_EVALUATION_PROTOCOL =
  "koni.execution-receipt-evaluation.v1" as const;
export const COMPOSED_REPLAY_SELECTION_PROTOCOL = "koni.composed-replay-selection.v1" as const;
export const CHECK_RETRY_DECISION_PROTOCOL = "koni.check-retry-decision.v1" as const;

const MAX_CHECK_AGGREGATE_SECONDS = 24 * 60 * 60;

export class ExecutionPolicyAuthorityError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ExecutionPolicyAuthorityError";
    this.code = code;
  }
}

export interface HashedTextContext {
  readonly text: string;
  readonly sha256: Sha256Digest;
}

export interface HashedStringListContext {
  readonly values: readonly string[];
  readonly sha256: Sha256Digest;
}

export interface HashedPortfolioContext {
  readonly value: CompiledPortfolioGuidance;
  readonly sha256: Sha256Digest;
}

/**
 * Immutable model/reviewer context. The prose is never treated as a compiler predicate; its
 * hashes make any later review or terminal decision refer to the exact pinned instructions.
 */
export interface ExecutionPolicyContext {
  readonly outputContract: HashedTextContext;
  readonly reviewContract: HashedTextContext;
  readonly portfolioGuidance?: HashedPortfolioContext;
  readonly escalationTriggers: HashedStringListContext;
  readonly stopConditions: HashedStringListContext;
  readonly sha256: Sha256Digest;
}

export interface ExecutionPolicyBinding {
  readonly protocol: typeof EXECUTION_POLICY_BINDING_PROTOCOL;
  readonly configurationSha256: Sha256Digest;
  readonly catalogSha256: Sha256Digest;
  readonly operationId: string;
  readonly operationSha256: Sha256Digest;
  readonly publicOperation: string;
  readonly workflowId?: string;
  readonly workflowVersion?: string;
  readonly workflowSha256?: Sha256Digest;
  readonly stepId?: string;
  readonly stepSha256?: Sha256Digest;
  readonly context: ExecutionPolicyContext;
  readonly sha256: Sha256Digest;
}

/** Exact gate-policy context that may extend one configured check's read-only grant. */
export interface GateAutoEvaluationContextBinding {
  readonly policyId: string;
  readonly policyContractSha256: Sha256Digest;
  readonly checkId: string;
  readonly boundary: "full" | "scoped";
  readonly gateNodeId: string;
  readonly contextSha256: Sha256Digest;
  readonly readPaths: readonly string[];
  readonly sha256: Sha256Digest;
}

/** Immutable execution policy attached to a compiler-resolved check plan and its receipt. */
export interface CheckExecutionPolicyBinding {
  readonly configurationSha256: Sha256Digest;
  readonly catalogSha256: Sha256Digest;
  readonly bindingSha256: Sha256Digest;
  readonly checkId: string;
  readonly checkSha256: Sha256Digest;
  readonly effect: "read_only" | "workspace_write" | "external";
  readonly receiptType: string;
  readonly receiptFreshness: "current" | "historical";
  readonly composedReplay: "required" | "never";
  readonly retryPolicy: Readonly<{
    maxAttempts: number;
    transientExitCodes: readonly number[];
    backoffSeconds: readonly number[];
  }>;
  readonly gatePolicyContexts: readonly GateAutoEvaluationContextBinding[];
}

export function assertCheckExecutionPolicyBinding(
  policy: unknown,
): asserts policy is CheckExecutionPolicyBinding {
  if (!isRecord(policy) || !isRecord(policy.retryPolicy)) {
    fail("execution_policy.check_binding", "configured check execution policy is malformed");
  }
  const retry = policy.retryPolicy;
  if (
    !isSha256Digest(policy.configurationSha256) ||
    !isSha256Digest(policy.catalogSha256) ||
    !isSha256Digest(policy.bindingSha256) ||
    typeof policy.checkId !== "string" ||
    policy.checkId.trim().length === 0 ||
    !isSha256Digest(policy.checkSha256) ||
    typeof policy.effect !== "string" ||
    !["read_only", "workspace_write", "external"].includes(policy.effect) ||
    typeof policy.receiptFreshness !== "string" ||
    !["current", "historical"].includes(policy.receiptFreshness) ||
    typeof policy.composedReplay !== "string" ||
    !["required", "never"].includes(policy.composedReplay) ||
    typeof policy.receiptType !== "string" ||
    policy.receiptType.length === 0 ||
    typeof retry.maxAttempts !== "number" ||
    !Number.isSafeInteger(retry.maxAttempts) ||
    retry.maxAttempts < 1 ||
    !Array.isArray(retry.transientExitCodes) ||
    retry.transientExitCodes.some(
      (value) => typeof value !== "number" || !Number.isSafeInteger(value),
    ) ||
    !Array.isArray(retry.backoffSeconds) ||
    retry.backoffSeconds.some(
      (value) => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0,
    ) ||
    !Array.isArray(policy.gatePolicyContexts)
  )
    fail("execution_policy.check_binding", "configured check execution policy is malformed");
  const rawGatePolicyContexts = policy.gatePolicyContexts;
  if (!Array.isArray(rawGatePolicyContexts)) {
    fail("execution_policy.check_binding", "configured check execution policy is malformed");
  }
  for (const rawGate of rawGatePolicyContexts) {
    const gate = rawGate;
    if (!isRecord(gate)) {
      fail(
        "execution_policy.gate_check_binding",
        "configured gate auto-evaluation binding is malformed",
      );
    }
    const { sha256: _sha256, ...material } = gate;
    if (
      !isSha256Digest(gate.policyContractSha256) ||
      !isSha256Digest(gate.contextSha256) ||
      !isSha256Digest(gate.sha256) ||
      canonicalHash(material) !== gate.sha256 ||
      typeof gate.checkId !== "string" ||
      gate.checkId.trim().length === 0 ||
      typeof gate.policyId !== "string" ||
      gate.policyId.trim().length === 0 ||
      typeof gate.gateNodeId !== "string" ||
      gate.gateNodeId.trim().length === 0 ||
      typeof gate.boundary !== "string" ||
      !["full", "scoped"].includes(gate.boundary) ||
      !Array.isArray(gate.readPaths) ||
      gate.readPaths.some((value) => typeof value !== "string")
    ) {
      fail(
        "execution_policy.gate_check_binding",
        "configured gate auto-evaluation binding is malformed",
      );
    }
  }
}

export interface ExecutionPolicySelector {
  readonly configurationSha256: Sha256Digest;
  readonly operationId: string;
  readonly workflowId?: string;
  readonly stepId?: string;
}

/** Resolve one operation/workflow/step solely from the catalog for the run's exact configuration. */
export function resolveExecutionPolicyBinding(
  catalog: CompiledExecutionSemanticCatalog,
  selector: ExecutionPolicySelector,
): ExecutionPolicyBinding {
  assertCatalogIntegrity(catalog);
  if (selector.configurationSha256 !== catalog.configurationSha256) {
    fail(
      "execution_policy.configuration_stale",
      `requested configuration ${selector.configurationSha256} does not match pinned ${catalog.configurationSha256}`,
    );
  }
  const operation = catalog.operations[selector.operationId];
  if (operation === undefined) {
    fail("execution_policy.operation_unknown", `unknown pinned operation ${selector.operationId}`);
  }
  const expectedWorkflowId = operation.workflowId;
  if (selector.workflowId !== undefined && selector.workflowId !== expectedWorkflowId) {
    fail(
      "execution_policy.workflow_mismatch",
      `operation ${operation.id} is not bound to workflow ${selector.workflowId}`,
    );
  }
  const workflow =
    expectedWorkflowId === undefined ? undefined : catalog.workflows[expectedWorkflowId];
  if (expectedWorkflowId !== undefined && workflow === undefined) {
    fail(
      "execution_policy.workflow_unknown",
      `operation ${operation.id} references missing workflow ${expectedWorkflowId}`,
    );
  }
  if (
    workflow !== undefined &&
    workflow.appliesTo.length > 0 &&
    !workflow.appliesTo.includes(operation.id) &&
    !workflow.appliesTo.includes(operation.publicOperation)
  ) {
    fail(
      "execution_policy.workflow_not_applicable",
      `workflow ${workflow.id} does not apply to operation ${operation.id}`,
    );
  }
  let step: CompiledWorkflowStepSemantics | undefined;
  if (selector.stepId !== undefined) {
    if (workflow === undefined) {
      fail(
        "execution_policy.step_without_workflow",
        `operation ${operation.id} has no workflow step ${selector.stepId}`,
      );
    }
    step = workflow.steps.find((candidate) => candidate.id === selector.stepId);
    if (step === undefined) {
      fail(
        "execution_policy.step_unknown",
        `workflow ${workflow.id} has no step ${selector.stepId}`,
      );
    }
  }
  const context = compilePolicyContext(operation, step);
  const material = {
    protocol: EXECUTION_POLICY_BINDING_PROTOCOL,
    configurationSha256: catalog.configurationSha256,
    catalogSha256: catalog.sha256,
    operationId: operation.id,
    operationSha256: operation.sha256,
    publicOperation: operation.publicOperation,
    ...(workflow === undefined
      ? {}
      : {
          workflowId: workflow.id,
          workflowVersion: workflow.version,
          workflowSha256: workflow.sha256,
        }),
    ...(step === undefined ? {} : { stepId: step.id, stepSha256: step.sha256 }),
    context,
  };
  return deepFreeze({ ...material, sha256: canonicalHash(material) });
}

function compilePolicyContext(
  operation: CompiledOperationSemantics,
  step: CompiledWorkflowStepSemantics | undefined,
): ExecutionPolicyContext {
  const outputContract = hashText("output_contract", operation.outputContract);
  const reviewContract = hashText("review_contract", operation.reviewContract);
  const portfolioGuidance =
    operation.portfolioGuidance === undefined
      ? undefined
      : deepFreeze({
          value: operation.portfolioGuidance,
          sha256: canonicalHash({ kind: "portfolio_guidance", value: operation.portfolioGuidance }),
        });
  const escalationTriggers = hashStringList("escalation_triggers", step?.escalationTriggers ?? []);
  const stopConditions = hashStringList("stop_conditions", step?.stopConditions ?? []);
  const material = {
    outputContract,
    reviewContract,
    ...(portfolioGuidance === undefined ? {} : { portfolioGuidance }),
    escalationTriggers,
    stopConditions,
  };
  return deepFreeze({ ...material, sha256: canonicalHash(material) });
}

function hashText(kind: string, text: string): HashedTextContext {
  return deepFreeze({ text, sha256: canonicalHash({ kind, text }) });
}

function hashStringList(kind: string, values: readonly string[]): HashedStringListContext {
  const immutable = Object.freeze([...values]);
  return deepFreeze({ values: immutable, sha256: canonicalHash({ kind, values: immutable }) });
}

export interface TypedGateIdentityCatalog {
  /** Authenticated gate node types projected by the compiled gate-policy authority. */
  readonly gateNodeTypes: readonly string[];
  /** Exact materialized gate identities in the graph snapshot against which the delta is applied. */
  readonly gateNodes: readonly Readonly<{ id: string; type: string }>[];
}

export interface MaterializedNodeChange {
  readonly before: Readonly<GraphNode> | null;
  readonly after: Readonly<GraphNode> | null;
}

/**
 * Validate operation-specific semantic mutation policy against complete before/after node states.
 * Generic graph schema, scope, node-creation, deletion, and compiler-field checks remain separate.
 */
export function assertOperationGraphMutationPolicy(
  catalog: CompiledExecutionSemanticCatalog,
  binding: ExecutionPolicyBinding,
  gateCatalog: TypedGateIdentityCatalog,
  changes: readonly MaterializedNodeChange[],
  reviewReworkOwnedNodeIds: readonly string[] = [],
): void {
  const operation = resolveBoundOperation(catalog, binding);
  const gateTypes = new Set(assertUniqueStrings(gateCatalog.gateNodeTypes, "gate node types"));
  const reviewReworkOwned = new Set(
    assertUniqueStrings(reviewReworkOwnedNodeIds, "review-rework-owned node ids"),
  );
  const gateIds = new Map<string, string>();
  for (const identity of gateCatalog.gateNodes) {
    if (!gateTypes.has(identity.type)) {
      fail(
        "execution_policy.gate_identity_type",
        `typed gate identity ${identity.id} uses unconfigured gate node type ${identity.type}`,
      );
    }
    if (gateIds.has(identity.id)) {
      fail(
        "execution_policy.gate_identity_duplicate",
        `duplicate typed gate identity ${identity.id}`,
      );
    }
    gateIds.set(identity.id, identity.type);
  }
  const changedIds = new Set<string>();
  for (const change of changes) {
    if (change.before === null && change.after === null) {
      fail(
        "execution_policy.empty_node_change",
        "node change must contain a before or after state",
      );
    }
    const nodeId = change.before?.id ?? change.after!.id;
    if (changedIds.has(nodeId)) {
      fail(
        "execution_policy.duplicate_node_change",
        `node ${nodeId} appears more than once in one mutation`,
      );
    }
    changedIds.add(nodeId);
    if (change.before !== null && change.after !== null && change.before.id !== change.after.id) {
      fail(
        "execution_policy.node_identity",
        `node mutation cannot change id ${change.before.id} to ${change.after.id}`,
      );
    }
    if (
      change.before !== null &&
      change.after !== null &&
      change.before.type !== change.after.type
    ) {
      fail(
        "execution_policy.node_type",
        `node mutation cannot change ${nodeId} type from ${change.before.type} to ${change.after.type}`,
      );
    }
    assertTypedGateIdentity(change.before, gateIds, gateTypes);
    assertTypedGateIdentity(change.after, gateIds, gateTypes);
    assertExistingNodeEdgeAdditions(operation, change);
    assertGateContractEdit(operation, change, gateIds, gateTypes, reviewReworkOwned);
  }
}

function assertTypedGateIdentity(
  node: Readonly<GraphNode> | null,
  gateIds: ReadonlyMap<string, string>,
  gateTypes: ReadonlySet<string>,
): void {
  if (node === null) return;
  const expected = gateIds.get(node.id);
  if (expected !== undefined && expected !== node.type) {
    fail(
      "execution_policy.gate_identity_mismatch",
      `gate node ${node.id} changed typed identity from ${expected} to ${node.type}`,
    );
  }
  // A node carrying a compiled gate type is gate-authoritative even if it is new and therefore
  // absent from the materialized-ID catalog.
  if (expected !== undefined && !gateTypes.has(node.type)) {
    fail(
      "execution_policy.gate_identity_type",
      `gate node ${node.id} has an unconfigured type ${node.type}`,
    );
  }
}

function assertExistingNodeEdgeAdditions(
  operation: CompiledOperationSemantics,
  change: MaterializedNodeChange,
): void {
  if (change.before === null) return;
  const allowedRelations = operation.existingNodeEdgeAdditionsOnly[change.before.type];
  if (allowedRelations === undefined) return;
  if (change.after === null) {
    fail(
      "execution_policy.edge_only_deletion",
      `operation ${operation.id} may only add configured edges on existing ${change.before.type} nodes`,
    );
  }
  if (
    canonicalHash(nodeWithoutEdges(change.before)) !== canonicalHash(nodeWithoutEdges(change.after))
  ) {
    fail(
      "execution_policy.edge_only_non_edge_change",
      `operation ${operation.id} must preserve every non-edge field on existing ${change.before.type} node ${change.before.id}`,
    );
  }
  const allowed = new Set(allowedRelations);
  const relations = new Set([
    ...Object.keys(change.before.edges),
    ...Object.keys(change.after.edges),
  ]);
  for (const relation of [...relations].sort(compareUtf8)) {
    const before = change.before.edges[relation] ?? [];
    const after = change.after.edges[relation] ?? [];
    if (arraysEqual(before, after)) continue;
    if (!allowed.has(relation) || before.some((target) => !after.includes(target))) {
      fail(
        "execution_policy.edge_only_relation",
        `operation ${operation.id} may only add ${change.before.type} relation(s): ${allowedRelations.join(", ")}`,
      );
    }
  }
}

function assertGateContractEdit(
  operation: CompiledOperationSemantics,
  change: MaterializedNodeChange,
  gateIds: ReadonlyMap<string, string>,
  gateTypes: ReadonlySet<string>,
  reviewReworkOwnedNodeIds: ReadonlySet<string>,
): void {
  if (operation.allowGateContractEdits || change.before === null) return;
  const typedGate = gateIds.has(change.before.id) || gateTypes.has(change.before.type);
  if (!typedGate) return;
  if (change.after === null) {
    fail(
      "execution_policy.gate_contract_deletion",
      `operation ${operation.id} cannot delete existing typed gate ${change.before.id}`,
    );
  }
  // A review correction retains semantic authority over a gate this same ticket created before
  // review. The caller derives these exact ids from compiler-authored graph-added receipts; this
  // does not authorize deletion or edits to any pre-existing or sibling gate.
  if (reviewReworkOwnedNodeIds.has(change.before.id)) return;
  if (
    canonicalHash(gateSemanticContract(change.before)) !==
    canonicalHash(gateSemanticContract(change.after))
  ) {
    fail(
      "execution_policy.gate_contract_edit",
      `operation ${operation.id} cannot edit the semantic contract of existing typed gate ${change.before.id}`,
    );
  }
}

function nodeWithoutEdges(node: Readonly<GraphNode>): Omit<GraphNode, "edges"> {
  const { edges: _edges, ...remaining } = node;
  return remaining;
}

function gateSemanticContract(node: Readonly<GraphNode>): Readonly<Record<string, unknown>> {
  return {
    schema_version: node.schema_version,
    id: node.id,
    type: node.type,
    title: node.title,
    spec: node.spec,
    annotations: node.annotations,
  };
}

export interface ExecutionAdmissionTicket {
  readonly ticketId: string;
  readonly binding: ExecutionPolicyBinding;
  readonly targetNodeIds: readonly string[];
  readonly readNodeIds: readonly string[];
  readonly writeNodeIds: readonly string[];
  readonly writePaths: readonly string[];
  /** Compiler-owned proposal target or approved application write scope. */
  readonly changeControlScopeNodeIds?: readonly string[];
}

export interface ExecutionAdmissionConflict {
  readonly kind: "change_control_barrier" | "single_flight" | "proof_preparation_overlap";
  readonly activeTicketId: string;
  readonly detail: string;
  readonly overlapNodeIds?: readonly string[];
  readonly overlapPaths?: readonly string[];
}

/** Derive all hard operation-policy conflicts against caller-supplied active, non-terminal tickets. */
export function deriveExecutionAdmissionConflicts(
  catalog: CompiledExecutionSemanticCatalog,
  projectRoot: string,
  candidate: ExecutionAdmissionTicket,
  activeTickets: readonly ExecutionAdmissionTicket[],
): readonly ExecutionAdmissionConflict[] {
  const operation = resolveBoundOperation(catalog, candidate.binding);
  const candidateContext = new Set([
    ...assertUniqueStrings(candidate.targetNodeIds, `ticket ${candidate.ticketId} target nodes`),
    ...assertUniqueStrings(candidate.readNodeIds, `ticket ${candidate.ticketId} read nodes`),
    ...assertUniqueStrings(candidate.writeNodeIds, `ticket ${candidate.ticketId} write nodes`),
  ]);
  const conflicts: ExecutionAdmissionConflict[] = [];
  const activeIds = new Set<string>();
  const pathAuthority = createProjectPathAuthority(projectRoot);
  for (const active of activeTickets) {
    if (active.ticketId === candidate.ticketId) continue;
    if (activeIds.has(active.ticketId)) {
      fail(
        "execution_policy.active_ticket_duplicate",
        `active ticket ${active.ticketId} appears more than once`,
      );
    }
    activeIds.add(active.ticketId);
    const activeOperation = resolveBoundOperation(catalog, active.binding);
    if (
      operation.changeControlBarrier &&
      operation.changeControl.role === "ordinary" &&
      (activeOperation.changeControl.role === "proposal" ||
        activeOperation.changeControl.role === "application")
    ) {
      if (active.changeControlScopeNodeIds === undefined) {
        fail(
          "execution_policy.change_control_scope_missing",
          `active ${activeOperation.changeControl.role} ticket ${active.ticketId} lacks compiler-owned control scope`,
        );
      }
      const overlap = [...new Set(active.changeControlScopeNodeIds)]
        .filter((nodeId) => candidateContext.has(nodeId))
        .sort(compareUtf8);
      if (overlap.length > 0) {
        conflicts.push(
          deepFreeze({
            kind: "change_control_barrier" as const,
            activeTicketId: active.ticketId,
            detail: `active ${activeOperation.changeControl.role} ${active.ticketId} controls overlapping node scope`,
            overlapNodeIds: Object.freeze(overlap),
          }),
        );
      }
    }
    if (
      operation.singleFlightGroup !== undefined &&
      operation.singleFlightGroup === activeOperation.singleFlightGroup
    ) {
      conflicts.push(
        deepFreeze({
          kind: "single_flight" as const,
          activeTicketId: active.ticketId,
          detail: `single-flight group ${operation.singleFlightGroup} is already held by ${active.ticketId}`,
        }),
      );
    }
    if (
      operation.proofSourcePreparationCheckId !== undefined ||
      activeOperation.proofSourcePreparationCheckId !== undefined
    ) {
      const overlaps = overlappingPaths(pathAuthority, candidate.writePaths, active.writePaths);
      if (overlaps.length > 0) {
        conflicts.push(
          deepFreeze({
            kind: "proof_preparation_overlap" as const,
            activeTicketId: active.ticketId,
            detail: `prepared-source operation has a hard write-scope conflict with ${active.ticketId}`,
            overlapPaths: Object.freeze(overlaps),
          }),
        );
      }
    }
  }
  return Object.freeze(
    conflicts.sort(
      (left, right) =>
        compareUtf8(left.kind, right.kind) ||
        compareUtf8(left.activeTicketId, right.activeTicketId),
    ),
  );
}

function overlappingPaths(
  pathAuthority: ProjectPathAuthority,
  leftPaths: readonly string[],
  rightPaths: readonly string[],
): string[] {
  const overlaps = new Set<string>();
  try {
    for (const left of assertUniqueStrings(leftPaths, "candidate write paths")) {
      for (const right of assertUniqueStrings(rightPaths, "active write paths")) {
        if (pathAuthority.pathsOverlap(left, right)) overlaps.add(`${left} <> ${right}`);
      }
    }
  } catch (error) {
    fail(
      "execution_policy.path_authority",
      `write-scope authority could not be compared safely: ${(error as Error).message}`,
    );
  }
  return [...overlaps].sort(compareUtf8);
}

export interface ExecutionPolicyReceiptEvidence {
  readonly receiptId: string;
  readonly receiptType: string;
  readonly checkId?: string;
  readonly checkSha256?: Sha256Digest;
  readonly freshness: ReceiptFreshness;
  readonly status: "passed" | "failed";
  readonly configurationSha256: Sha256Digest;
  readonly catalogSha256: Sha256Digest;
  readonly operationId: string;
  readonly workflowId?: string;
  readonly stepId: string;
  readonly bindingSha256: Sha256Digest;
  readonly integrityValid: boolean;
  readonly current: boolean;
  readonly historicalEvidenceValid: boolean;
  readonly linkedToCurrentOutput: boolean;
}

export interface ReceiptRequirementEvaluation {
  readonly protocol: typeof EXECUTION_RECEIPT_EVALUATION_PROTOCOL;
  readonly bindingSha256: Sha256Digest;
  readonly required: readonly string[];
  readonly satisfied: readonly string[];
  readonly missing: readonly string[];
  readonly acceptedReceiptIds: readonly string[];
  readonly sha256: Sha256Digest;
}

export function evaluateRequiredExecutionReceipts(
  catalog: CompiledExecutionSemanticCatalog,
  binding: ExecutionPolicyBinding,
  input: Readonly<{
    receipts: readonly ExecutionPolicyReceiptEvidence[];
    structuredOutputAccepted: boolean;
    commandRan: boolean;
  }>,
): ReceiptRequirementEvaluation {
  const { step } = resolveBoundStep(catalog, binding);
  const accepted = new Set<string>();
  const satisfied: string[] = [];
  const missing: string[] = [];
  for (const required of step.requiredReceipts) {
    if (required === "structured-output") {
      (input.structuredOutputAccepted ? satisfied : missing).push(required);
      continue;
    }
    if (required.endsWith("-when-command-runs") && !input.commandRan) {
      satisfied.push(required);
      continue;
    }
    const configuredChecks = step.validationChecks
      .map((checkId) => catalog.checks[checkId])
      .filter(
        (check): check is CompiledCheckSemantics =>
          check !== undefined && check.receiptType === required,
      );
    const candidates = input.receipts.filter((receipt) =>
      receiptMatchesBinding(receipt, catalog, binding),
    );
    let match: ExecutionPolicyReceiptEvidence | undefined;
    if (required.endsWith("-when-command-runs")) {
      match = candidates.find(
        (receipt) => receipt.linkedToCurrentOutput && receiptValidity(receipt, undefined),
      );
    } else if (configuredChecks.length > 0) {
      match = candidates.find((receipt) =>
        configuredChecks.some(
          (check) =>
            receipt.checkId === check.id &&
            receipt.checkSha256 === check.sha256 &&
            receipt.receiptType === check.receiptType &&
            receiptValidity(receipt, check),
        ),
      );
    } else {
      match = candidates.find(
        (receipt) =>
          receipt.receiptType === required && receiptValidity(receipt, undefined, "current"),
      );
    }
    if (match === undefined) missing.push(required);
    else {
      satisfied.push(required);
      accepted.add(match.receiptId);
    }
  }
  const material = {
    protocol: EXECUTION_RECEIPT_EVALUATION_PROTOCOL,
    bindingSha256: binding.sha256,
    required: Object.freeze([...step.requiredReceipts]),
    satisfied: Object.freeze(satisfied),
    missing: Object.freeze(missing),
    acceptedReceiptIds: Object.freeze([...accepted].sort(compareUtf8)),
  };
  return deepFreeze({ ...material, sha256: canonicalHash(material) });
}

function receiptMatchesBinding(
  receipt: ExecutionPolicyReceiptEvidence,
  catalog: CompiledExecutionSemanticCatalog,
  binding: ExecutionPolicyBinding,
): boolean {
  return (
    receipt.configurationSha256 === catalog.configurationSha256 &&
    receipt.catalogSha256 === catalog.sha256 &&
    receipt.operationId === binding.operationId &&
    receipt.workflowId === binding.workflowId &&
    receipt.stepId === binding.stepId &&
    receipt.bindingSha256 === binding.sha256
  );
}

function receiptValidity(
  receipt: ExecutionPolicyReceiptEvidence,
  check: CompiledCheckSemantics | undefined,
  requiredFreshness?: ReceiptFreshness,
): boolean {
  if (receipt.status !== "passed" || !receipt.integrityValid) return false;
  const freshness = check?.receiptFreshness ?? requiredFreshness ?? receipt.freshness;
  if (receipt.freshness !== freshness) return false;
  return freshness === "current" ? receipt.current : receipt.historicalEvidenceValid;
}

export type SourceByteInput =
  | Readonly<{ path: string; kind: "directory" }>
  | Readonly<{ path: string; kind: "file"; bytes: Uint8Array }>;

export type SourceByteManifestEntry =
  | Readonly<{ path: string; kind: "directory" }>
  | Readonly<{ path: string; kind: "file"; sizeBytes: number; contentSha256: Sha256Digest }>;

export interface SourceByteManifest {
  readonly protocol: typeof SOURCE_BYTE_MANIFEST_PROTOCOL;
  readonly configurationSha256: Sha256Digest;
  readonly catalogSha256: Sha256Digest;
  readonly operationId: string;
  readonly workflowId: string;
  readonly sourceStepId: string;
  readonly sourceStepSha256: Sha256Digest;
  readonly entries: readonly SourceByteManifestEntry[];
  readonly sha256: Sha256Digest;
}

export interface SourcePreservationReceipt {
  readonly protocol: typeof SOURCE_PRESERVATION_RECEIPT_PROTOCOL;
  readonly bindingSha256: Sha256Digest;
  readonly baselineManifestSha256: Sha256Digest;
  readonly currentManifestSha256: Sha256Digest;
  readonly preserved: true;
  readonly sha256: Sha256Digest;
}

/** Hash exact file bytes; symlinks are intentionally not representable at this authority seam. */
export function createSourceByteManifest(
  catalog: CompiledExecutionSemanticCatalog,
  binding: ExecutionPolicyBinding,
  sourceStepId: string,
  sources: readonly SourceByteInput[],
): SourceByteManifest {
  const { operation, workflow } = resolveBoundWorkflow(catalog, binding);
  const sourceStep = workflow.steps.find((step) => step.id === sourceStepId);
  if (sourceStep === undefined) {
    fail(
      "execution_policy.source_step_unknown",
      `workflow ${workflow.id} has no source step ${sourceStepId}`,
    );
  }
  const paths = new Set<string>();
  const entries = sources
    .map((source): SourceByteManifestEntry => {
      let path: string;
      try {
        path = normalizeProjectRelativePath(source.path);
      } catch (error) {
        fail("execution_policy.source_path", (error as Error).message);
      }
      if (paths.has(path))
        fail("execution_policy.source_path_duplicate", `duplicate source manifest path ${path}`);
      paths.add(path);
      return source.kind === "directory"
        ? deepFreeze({ path, kind: "directory" as const })
        : deepFreeze({
            path,
            kind: "file" as const,
            sizeBytes: source.bytes.byteLength,
            contentSha256: rawSha256(source.bytes),
          });
    })
    .sort((left, right) => compareUtf8(left.path, right.path));
  const material = {
    protocol: SOURCE_BYTE_MANIFEST_PROTOCOL,
    configurationSha256: catalog.configurationSha256,
    catalogSha256: catalog.sha256,
    operationId: operation.id,
    workflowId: workflow.id,
    sourceStepId: sourceStep.id,
    sourceStepSha256: sourceStep.sha256,
    entries: Object.freeze(entries),
  };
  return deepFreeze({ ...material, sha256: canonicalHash(material) });
}

export function assertSourceManifestPreserved(
  catalog: CompiledExecutionSemanticCatalog,
  currentStepBinding: ExecutionPolicyBinding,
  baseline: SourceByteManifest,
  currentSources: readonly SourceByteInput[],
): SourcePreservationReceipt {
  const { operation, workflow, step } = resolveBoundStep(catalog, currentStepBinding);
  if (step.preserveSourcePathsFrom === undefined) {
    fail(
      "execution_policy.source_preservation_not_configured",
      `workflow step ${step.id} has no preserve_source_paths_from contract`,
    );
  }
  assertSourceManifestIntegrity(baseline);
  if (
    baseline.configurationSha256 !== catalog.configurationSha256 ||
    baseline.catalogSha256 !== catalog.sha256 ||
    baseline.operationId !== operation.id ||
    baseline.workflowId !== workflow.id ||
    baseline.sourceStepId !== step.preserveSourcePathsFrom ||
    baseline.sourceStepSha256 !==
      workflow.steps.find((candidate) => candidate.id === step.preserveSourcePathsFrom)?.sha256
  ) {
    fail(
      "execution_policy.source_manifest_stale",
      "baseline source manifest does not match the pinned workflow boundary",
    );
  }
  const current = createSourceByteManifest(
    catalog,
    currentStepBinding,
    step.preserveSourcePathsFrom,
    currentSources,
  );
  if (canonicalHash(baseline.entries) !== canonicalHash(current.entries)) {
    fail(
      "execution_policy.source_bytes_changed",
      `workflow step ${step.id} changed source paths or bytes captured by ${baseline.sourceStepId}`,
    );
  }
  const material = {
    protocol: SOURCE_PRESERVATION_RECEIPT_PROTOCOL,
    bindingSha256: currentStepBinding.sha256,
    baselineManifestSha256: baseline.sha256,
    currentManifestSha256: current.sha256,
    preserved: true as const,
  };
  return deepFreeze({ ...material, sha256: canonicalHash(material) });
}

function assertSourceManifestIntegrity(manifest: SourceByteManifest): void {
  const { sha256: _sha256, ...material } = manifest;
  if (!isSha256Digest(manifest.sha256) || canonicalHash(material) !== manifest.sha256) {
    fail("execution_policy.source_manifest_integrity", "baseline source manifest hash is invalid");
  }
  let prior: string | undefined;
  for (const entry of manifest.entries) {
    let normalized: string;
    try {
      normalized = normalizeProjectRelativePath(entry.path);
    } catch {
      fail(
        "execution_policy.source_manifest_integrity",
        `source manifest path ${entry.path} is invalid`,
      );
    }
    if (normalized !== entry.path || (prior !== undefined && compareUtf8(prior, entry.path) >= 0)) {
      fail(
        "execution_policy.source_manifest_integrity",
        "source manifest paths must be unique and canonically sorted",
      );
    }
    prior = entry.path;
    if (
      entry.kind === "file" &&
      (!isSha256Digest(entry.contentSha256) ||
        !Number.isSafeInteger(entry.sizeBytes) ||
        entry.sizeBytes < 0)
    ) {
      fail(
        "execution_policy.source_manifest_integrity",
        `source file ${entry.path} has invalid byte metadata`,
      );
    }
  }
}

export interface ComposedReplaySelection {
  readonly protocol: typeof COMPOSED_REPLAY_SELECTION_PROTOCOL;
  readonly configurationSha256: Sha256Digest;
  readonly catalogSha256: Sha256Digest;
  readonly replayCheckIds: readonly string[];
  readonly skipped: readonly Readonly<{
    checkId: string;
    reason: "historical" | "opted_out" | "side_effecting";
  }>[];
  readonly sha256: Sha256Digest;
}

/** Select only current, explicitly replayable, read-only command leaves for composed verification. */
export function selectComposedReplayChecks(
  catalog: CompiledExecutionSemanticCatalog,
  configurationSha256: Sha256Digest,
  childCheckIds: readonly string[],
): ComposedReplaySelection {
  assertCatalogIntegrity(catalog);
  if (configurationSha256 !== catalog.configurationSha256) {
    fail(
      "execution_policy.configuration_stale",
      "composed replay requested against a non-pinned configuration",
    );
  }
  const ids = assertUniqueStrings(childCheckIds, "composed child checks").sort(compareUtf8);
  const replay: string[] = [];
  const skipped: ComposedReplaySelection["skipped"][number][] = [];
  for (const checkId of ids) {
    const check = catalog.checks[checkId];
    if (check === undefined || check.kind !== "command") {
      fail(
        "execution_policy.replay_leaf",
        `composed replay child ${checkId} is not a configured command check`,
      );
    }
    if (check.receiptFreshness === "historical") skipped.push({ checkId, reason: "historical" });
    else if (check.composedReplay === "never") skipped.push({ checkId, reason: "opted_out" });
    else if (check.effect !== "read_only") skipped.push({ checkId, reason: "side_effecting" });
    else replay.push(checkId);
  }
  const material = {
    protocol: COMPOSED_REPLAY_SELECTION_PROTOCOL,
    configurationSha256: catalog.configurationSha256,
    catalogSha256: catalog.sha256,
    replayCheckIds: Object.freeze(replay),
    skipped: Object.freeze(skipped.map((entry) => deepFreeze(entry))),
  };
  return deepFreeze({ ...material, sha256: canonicalHash(material) });
}

export interface CheckRetryDecision {
  readonly protocol: typeof CHECK_RETRY_DECISION_PROTOCOL;
  readonly configurationSha256: Sha256Digest;
  readonly catalogSha256: Sha256Digest;
  readonly checkId: string;
  readonly checkSha256: Sha256Digest;
  readonly attemptNumber: number;
  readonly exitCode: number;
  readonly disposition:
    "retry" | "terminal_failure" | "attempts_exhausted" | "time_budget_exhausted";
  readonly backoffSeconds: number;
  readonly nextAttemptNumber?: number;
  readonly sha256: Sha256Digest;
}

/** Decide after one failed command attempt. Success classification remains the command runner's job. */
export function decideConfiguredCheckRetry(
  catalog: CompiledExecutionSemanticCatalog,
  configurationSha256: Sha256Digest,
  input: Readonly<{
    checkId: string;
    attemptNumber: number;
    exitCode: number;
    aggregateElapsedSeconds: number;
  }>,
): CheckRetryDecision {
  assertCatalogIntegrity(catalog);
  if (configurationSha256 !== catalog.configurationSha256) {
    fail(
      "execution_policy.configuration_stale",
      "check retry requested against a non-pinned configuration",
    );
  }
  const check = catalog.checks[input.checkId];
  if (check === undefined || check.kind !== "command") {
    fail(
      "execution_policy.retry_check",
      `retry target ${input.checkId} is not a configured command check`,
    );
  }
  if (
    !Number.isSafeInteger(input.attemptNumber) ||
    input.attemptNumber < 1 ||
    !Number.isSafeInteger(input.exitCode) ||
    input.exitCode < 0 ||
    input.exitCode > 255 ||
    !Number.isSafeInteger(input.aggregateElapsedSeconds) ||
    input.aggregateElapsedSeconds < 0
  ) {
    fail(
      "execution_policy.retry_input",
      "retry attempt, exit code, and elapsed time must be bounded safe integers",
    );
  }
  let disposition: CheckRetryDecision["disposition"] = "terminal_failure";
  let backoffSeconds = 0;
  let nextAttemptNumber: number | undefined;
  if (check.retryPolicy.transientExitCodes.includes(input.exitCode)) {
    if (input.attemptNumber >= check.retryPolicy.maxAttempts) {
      disposition = "attempts_exhausted";
    } else {
      backoffSeconds = check.retryPolicy.backoffSeconds[input.attemptNumber - 1] ?? 0;
      if (input.aggregateElapsedSeconds + backoffSeconds > MAX_CHECK_AGGREGATE_SECONDS) {
        disposition = "time_budget_exhausted";
        backoffSeconds = 0;
      } else {
        disposition = "retry";
        nextAttemptNumber = input.attemptNumber + 1;
      }
    }
  }
  const material = {
    protocol: CHECK_RETRY_DECISION_PROTOCOL,
    configurationSha256: catalog.configurationSha256,
    catalogSha256: catalog.sha256,
    checkId: check.id,
    checkSha256: check.sha256,
    attemptNumber: input.attemptNumber,
    exitCode: input.exitCode,
    disposition,
    backoffSeconds,
    ...(nextAttemptNumber === undefined ? {} : { nextAttemptNumber }),
  };
  return deepFreeze({ ...material, sha256: canonicalHash(material) });
}

/** Decide retry from the exact compiler-resolved leaf policy without reopening the catalog. */
export function decideBoundCheckRetry(
  policy: CheckExecutionPolicyBinding,
  input: Readonly<{
    attemptNumber: number;
    exitCode: number;
    aggregateElapsedSeconds: number;
  }>,
): CheckRetryDecision {
  assertCheckExecutionPolicyBinding(policy);
  if (
    !Number.isSafeInteger(input.attemptNumber) ||
    input.attemptNumber < 1 ||
    !Number.isSafeInteger(input.exitCode) ||
    input.exitCode < 0 ||
    input.exitCode > 255 ||
    !Number.isSafeInteger(input.aggregateElapsedSeconds) ||
    input.aggregateElapsedSeconds < 0
  ) {
    fail(
      "execution_policy.retry_input",
      "retry attempt, exit code, and elapsed time must be bounded safe integers",
    );
  }
  let disposition: CheckRetryDecision["disposition"] = "terminal_failure";
  let backoffSeconds = 0;
  let nextAttemptNumber: number | undefined;
  if (policy.retryPolicy.transientExitCodes.includes(input.exitCode)) {
    if (input.attemptNumber >= policy.retryPolicy.maxAttempts) {
      disposition = "attempts_exhausted";
    } else {
      backoffSeconds = policy.retryPolicy.backoffSeconds[input.attemptNumber - 1] ?? 0;
      if (input.aggregateElapsedSeconds + backoffSeconds > MAX_CHECK_AGGREGATE_SECONDS) {
        disposition = "time_budget_exhausted";
        backoffSeconds = 0;
      } else {
        disposition = "retry";
        nextAttemptNumber = input.attemptNumber + 1;
      }
    }
  }
  const material = {
    protocol: CHECK_RETRY_DECISION_PROTOCOL,
    configurationSha256: policy.configurationSha256,
    catalogSha256: policy.catalogSha256,
    checkId: policy.checkId,
    checkSha256: policy.checkSha256,
    attemptNumber: input.attemptNumber,
    exitCode: input.exitCode,
    disposition,
    backoffSeconds,
    ...(nextAttemptNumber === undefined ? {} : { nextAttemptNumber }),
  };
  return deepFreeze({ ...material, sha256: canonicalHash(material) });
}

function resolveBoundOperation(
  catalog: CompiledExecutionSemanticCatalog,
  binding: ExecutionPolicyBinding,
): CompiledOperationSemantics {
  assertCatalogIntegrity(catalog);
  assertExecutionPolicyBindingIntegrity(binding);
  if (
    binding.configurationSha256 !== catalog.configurationSha256 ||
    binding.catalogSha256 !== catalog.sha256
  ) {
    fail(
      "execution_policy.binding_stale",
      "execution-policy binding does not belong to the pinned semantic catalog",
    );
  }
  const operation = catalog.operations[binding.operationId];
  if (
    operation === undefined ||
    operation.sha256 !== binding.operationSha256 ||
    operation.publicOperation !== binding.publicOperation
  ) {
    fail(
      "execution_policy.operation_stale",
      `operation binding ${binding.operationId} is stale or invalid`,
    );
  }
  return operation;
}

function resolveBoundWorkflow(
  catalog: CompiledExecutionSemanticCatalog,
  binding: ExecutionPolicyBinding,
): { operation: CompiledOperationSemantics; workflow: CompiledWorkflowSemantics } {
  const operation = resolveBoundOperation(catalog, binding);
  if (
    binding.workflowId === undefined ||
    binding.workflowSha256 === undefined ||
    operation.workflowId !== binding.workflowId
  ) {
    fail("execution_policy.workflow_binding", `binding ${binding.sha256} has no valid workflow`);
  }
  const workflow = catalog.workflows[binding.workflowId];
  if (
    workflow === undefined ||
    workflow.sha256 !== binding.workflowSha256 ||
    workflow.version !== binding.workflowVersion
  ) {
    fail(
      "execution_policy.workflow_stale",
      `workflow binding ${binding.workflowId} is stale or invalid`,
    );
  }
  return { operation, workflow };
}

function resolveBoundStep(
  catalog: CompiledExecutionSemanticCatalog,
  binding: ExecutionPolicyBinding,
): {
  operation: CompiledOperationSemantics;
  workflow: CompiledWorkflowSemantics;
  step: CompiledWorkflowStepSemantics;
} {
  const { operation, workflow } = resolveBoundWorkflow(catalog, binding);
  if (binding.stepId === undefined || binding.stepSha256 === undefined) {
    fail("execution_policy.step_binding", `binding ${binding.sha256} has no workflow step`);
  }
  const step = workflow.steps.find((candidate) => candidate.id === binding.stepId);
  if (step === undefined || step.sha256 !== binding.stepSha256) {
    fail("execution_policy.step_stale", `step binding ${binding.stepId} is stale or invalid`);
  }
  return { operation, workflow, step };
}

function assertCatalogIntegrity(catalog: CompiledExecutionSemanticCatalog): void {
  const material = {
    protocol: catalog.protocol,
    configurationSha256: catalog.configurationSha256,
    operations: catalog.operations,
    workflows: catalog.workflows,
    checks: catalog.checks,
    ...(catalog.terminalResolverOperationId === undefined
      ? {}
      : { terminalResolverOperationId: catalog.terminalResolverOperationId }),
  };
  if (
    !isSha256Digest(catalog.configurationSha256) ||
    !isSha256Digest(catalog.sha256) ||
    canonicalHash(material) !== catalog.sha256
  ) {
    fail(
      "execution_policy.catalog_integrity",
      "compiled execution-semantic catalog hash is invalid",
    );
  }
}

/** Recheck a durable binding without consulting ambient or current configuration. */
export function assertExecutionPolicyBindingIntegrity(binding: ExecutionPolicyBinding): void {
  const { sha256: _sha256, ...material } = binding;
  if (!isSha256Digest(binding.sha256) || canonicalHash(material) !== binding.sha256) {
    fail("execution_policy.binding_integrity", "execution-policy binding hash is invalid");
  }
}

function assertUniqueStrings(values: readonly string[], label: string): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.trim().length === 0) {
      fail("execution_policy.string", `${label} must contain only nonempty strings`);
    }
    if (seen.has(value)) fail("execution_policy.duplicate", `${label} contains duplicate ${value}`);
    seen.add(value);
    output.push(value);
  }
  return output;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function fail(code: string, message: string): never {
  throw new ExecutionPolicyAuthorityError(code, message);
}
