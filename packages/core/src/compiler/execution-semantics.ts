import { valid as validSemver } from "semver";
import type {
  CompiledConfiguration,
  ConfigurationObject,
  ConfigurationValue,
} from "../contracts/configuration.js";
import { RETIRED_STOCK_BROWSER_SMOKE_SHA256 } from "../contracts/historical-compatibility.js";
import { canonicalHash, compareUtf8, type Sha256Digest } from "../shared/canonical.js";

export const EXECUTION_SEMANTIC_CATALOG_PROTOCOL = "koni.execution-semantic-catalog.v1" as const;

export type ReceiptFreshness = "current" | "historical";
export type ComposedReplayPolicy = "required" | "never";

export type CompiledChangeControl =
  | Readonly<{
      role: "ordinary";
      allowUpstreamRequests: boolean;
      proposalOperation?: string;
    }>
  | Readonly<{
      role: "proposal";
      proposalStep: string;
      applicationOperations: readonly string[];
      decisionPolicy: "operator" | "automatic";
    }>
  | Readonly<{ role: "application" }>
  | Readonly<{ role: "disposition"; outcome: "no_op" }>;

export interface CompiledPortfolioGuidance {
  readonly preferredCount: number;
  readonly unit: string;
  readonly groupWhen: string;
  readonly splitWhen: string;
  readonly avoid: string;
}

export interface CompiledOperationSemantics {
  readonly id: string;
  readonly publicOperation: string;
  readonly stage: string;
  readonly workflowId?: string;
  readonly outputContract: string;
  readonly reviewContract: string;
  readonly existingNodeEdgeAdditionsOnly: Readonly<Record<string, readonly string[]>>;
  readonly allowGateContractEdits: boolean;
  readonly gateBlockingExempt: boolean;
  readonly changeControlBarrier: boolean;
  readonly changeControl: CompiledChangeControl;
  readonly portfolioGuidance?: CompiledPortfolioGuidance;
  readonly proofSourcePreparationCheckId?: string;
  readonly singleFlightGroup?: string;
  readonly terminalResolver: boolean;
  readonly sha256: Sha256Digest;
}

export interface CompiledWorkflowStepSemantics {
  readonly id: string;
  /** Optional workflow steps are deliberately unsupported until a typed skip predicate exists. */
  readonly required: true;
  readonly preserveSourcePathsFrom?: string;
  readonly requiredReceipts: readonly string[];
  readonly escalationTriggers: readonly string[];
  readonly stopConditions: readonly string[];
  readonly validationChecks: readonly string[];
  readonly sha256: Sha256Digest;
}

export interface CompiledWorkflowSemantics {
  readonly id: string;
  readonly version: string;
  readonly appliesTo: readonly string[];
  readonly steps: readonly CompiledWorkflowStepSemantics[];
  readonly sha256: Sha256Digest;
}

export interface CompiledCheckRetryPolicy {
  readonly maxAttempts: number;
  readonly transientExitCodes: readonly number[];
  /** Delay before attempts 2..N. Missing entries mean no delay. */
  readonly backoffSeconds: readonly number[];
}

export interface CompiledCheckSemantics {
  readonly id: string;
  readonly kind: "command" | "graph" | "composite";
  readonly effect: "read_only" | "workspace_write" | "external";
  readonly receiptType: string;
  readonly receiptFreshness: ReceiptFreshness;
  readonly composedReplay: ComposedReplayPolicy;
  readonly retryPolicy: CompiledCheckRetryPolicy;
  readonly sha256: Sha256Digest;
}

export interface CompiledExecutionSemanticCatalog {
  readonly protocol: typeof EXECUTION_SEMANTIC_CATALOG_PROTOCOL;
  readonly configurationSha256: Sha256Digest;
  readonly operations: Readonly<Record<string, CompiledOperationSemantics>>;
  readonly workflows: Readonly<Record<string, CompiledWorkflowSemantics>>;
  readonly checks: Readonly<Record<string, CompiledCheckSemantics>>;
  readonly terminalResolverOperationId?: string;
  readonly sha256: Sha256Digest;
}

export class ExecutionSemanticCompilationError extends Error {
  public readonly code: string;
  public readonly path: string;

  public constructor(code: string, path: string, message: string) {
    super(message);
    this.name = "ExecutionSemanticCompilationError";
    this.code = code;
    this.path = path;
  }
}

const MAX_CHECK_ATTEMPTS = 3;
const MAX_CHECK_TOTAL_EXECUTION_SECONDS = 24 * 60 * 60;
const COMPILER_RECEIPT_TYPES = new Set([
  "context-pack",
  "structured-output",
  "scoped-compile",
  "review-receipt",
  "runtime-receipt-when-command-runs",
]);
const CHANGE_CONTROL_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ordinary: ["role", "allow_upstream_requests", "proposal_operation"],
  proposal: ["role", "proposal_step", "application_operations", "decision_policy"],
  application: ["role"],
  disposition: ["role", "outcome"],
});
const PORTFOLIO_GUIDANCE_FIELDS = [
  "preferred_count",
  "unit",
  "group_when",
  "split_when",
  "avoid",
] as const;

/**
 * Compile the raw operation/workflow/check registries into the one policy object authority code
 * may consume. The result is derived exclusively from the authenticated configuration snapshot.
 */
export function compileExecutionSemanticCatalog(
  configuration: Pick<CompiledConfiguration, "configuration_sha256" | "registries" | "edge_types">,
): CompiledExecutionSemanticCatalog {
  const operations = compileOperations(configuration);
  const workflows = compileWorkflows(configuration);
  const checks = compileChecks(configuration);
  validateCrossRegistryContracts(operations, workflows, checks);
  const terminalResolvers = Object.values(operations)
    .filter((operation) => operation.terminalResolver)
    .map((operation) => operation.id)
    .sort(compareUtf8);
  if (terminalResolvers.length > 1) {
    fail(
      "execution.multiple_terminal_resolvers",
      "/registries/operations",
      `configuration declares multiple terminal resolver operations: ${terminalResolvers.join(", ")}`,
    );
  }
  const material = {
    protocol: EXECUTION_SEMANTIC_CATALOG_PROTOCOL,
    configurationSha256: configuration.configuration_sha256,
    operations,
    workflows,
    checks,
    ...(terminalResolvers[0] === undefined
      ? {}
      : { terminalResolverOperationId: terminalResolvers[0] }),
  };
  return deepFreeze({ ...material, sha256: canonicalHash(material) });
}

function compileOperations(
  configuration: Pick<CompiledConfiguration, "registries" | "edge_types">,
): Record<string, CompiledOperationSemantics> {
  const output: Record<string, CompiledOperationSemantics> = Object.create(null) as Record<
    string,
    CompiledOperationSemantics
  >;
  const edgeCatalog = new Set(
    configuration.edge_types.map((edge, index) => {
      const source = nonemptyString(edge.source, `/edge_types/${index}/source`);
      const relation = nonemptyString(edge.relation, `/edge_types/${index}/relation`);
      return `${source}\0${relation}`;
    }),
  );
  for (const [id, source] of sortedEntries(configuration.registries.operations)) {
    const base = `/registries/operations/${escapePointer(id)}`;
    if (nonemptyString(source.id, `${base}/id`) !== id) {
      fail(
        "execution.operation_id",
        `${base}/id`,
        `operation id does not match registry key ${id}`,
      );
    }
    const allowedExisting = new Set(
      stringArray(source.allowed_existing_node_types, `${base}/allowed_existing_node_types`),
    );
    const edgeOnlySource = optionalRecord(
      source.existing_node_edge_additions_only,
      `${base}/existing_node_edge_additions_only`,
    );
    const edgeOnly: Record<string, readonly string[]> = Object.create(null) as Record<
      string,
      readonly string[]
    >;
    for (const [nodeType, rawRelations] of sortedEntries(edgeOnlySource ?? {})) {
      if (!allowedExisting.has(nodeType)) {
        fail(
          "execution.edge_only_type",
          `${base}/existing_node_edge_additions_only/${escapePointer(nodeType)}`,
          `edge-addition-only node type ${nodeType} is not an allowed existing node type`,
        );
      }
      const relations = uniqueStrings(
        stringArray(
          rawRelations,
          `${base}/existing_node_edge_additions_only/${escapePointer(nodeType)}`,
        ),
        `${base}/existing_node_edge_additions_only/${escapePointer(nodeType)}`,
        false,
      );
      if (relations.length === 0) {
        fail(
          "execution.edge_only_empty",
          `${base}/existing_node_edge_additions_only/${escapePointer(nodeType)}`,
          "edge-addition-only relation catalog must be nonempty",
        );
      }
      for (const relation of relations) {
        if (!edgeCatalog.has(`${nodeType}\0${relation}`)) {
          fail(
            "execution.edge_only_relation",
            `${base}/existing_node_edge_additions_only/${escapePointer(nodeType)}`,
            `edge-addition-only relation ${nodeType}.${relation} is not declared by the graph schema`,
          );
        }
      }
      edgeOnly[nodeType] = Object.freeze(relations);
    }
    const terminalResolver =
      optionalBoolean(source.terminal_resolver, `${base}/terminal_resolver`) ?? false;
    const gateBlockingExempt =
      optionalBoolean(source.gate_blocking_exempt, `${base}/gate_blocking_exempt`) ?? false;
    const changeControlBarrier =
      optionalBoolean(source.change_control_barrier, `${base}/change_control_barrier`) ?? false;
    const allowGateContractEdits =
      optionalBoolean(source.allow_gate_contract_edits, `${base}/allow_gate_contract_edits`) ??
      false;
    const workflowId = optionalNonemptyString(source.workflow, `${base}/workflow`);
    const singleFlightGroup = optionalNonemptyString(
      source.single_flight_group,
      `${base}/single_flight_group`,
    );
    const changeControl = compileChangeControl(source.change_control, `${base}/change_control`);
    if (terminalResolver) {
      if (
        workflowId === undefined ||
        !gateBlockingExempt ||
        changeControlBarrier ||
        singleFlightGroup === undefined
      ) {
        fail(
          "execution.terminal_resolver_contract",
          base,
          "terminal resolver requires a workflow, gate-blocking exemption, no change-control barrier, and a single-flight group",
        );
      }
      if (
        source.allow_node_deletion === true ||
        changeControl.role !== "ordinary" ||
        changeControl.allowUpstreamRequests
      ) {
        fail(
          "execution.terminal_resolver_authority",
          base,
          "terminal resolver must forbid node deletion and use closed ordinary change control",
        );
      }
    }
    const portfolioGuidance =
      source.portfolio_guidance === undefined
        ? undefined
        : compilePortfolioGuidance(source.portfolio_guidance, `${base}/portfolio_guidance`);
    const operationMaterial = {
      id,
      publicOperation: optionalNonemptyString(source.operation, `${base}/operation`) ?? id,
      stage: nonemptyString(source.stage, `${base}/stage`),
      ...(workflowId === undefined ? {} : { workflowId }),
      outputContract: optionalString(source.output_contract, `${base}/output_contract`) ?? "",
      reviewContract: optionalString(source.review_contract, `${base}/review_contract`) ?? "",
      existingNodeEdgeAdditionsOnly: deepFreeze(edgeOnly),
      allowGateContractEdits,
      gateBlockingExempt,
      changeControlBarrier,
      changeControl,
      ...(portfolioGuidance === undefined ? {} : { portfolioGuidance }),
      ...(source.proof_source_preparation_check === undefined
        ? {}
        : {
            proofSourcePreparationCheckId: nonemptyString(
              source.proof_source_preparation_check,
              `${base}/proof_source_preparation_check`,
            ),
          }),
      ...(singleFlightGroup === undefined ? {} : { singleFlightGroup }),
      terminalResolver,
    };
    output[id] = deepFreeze({ ...operationMaterial, sha256: canonicalHash(operationMaterial) });
  }
  return deepFreeze(output);
}

function compileWorkflows(
  configuration: Pick<CompiledConfiguration, "registries">,
): Record<string, CompiledWorkflowSemantics> {
  const output: Record<string, CompiledWorkflowSemantics> = Object.create(null) as Record<
    string,
    CompiledWorkflowSemantics
  >;
  for (const [id, source] of sortedEntries(configuration.registries.workflows)) {
    const base = `/registries/workflows/${escapePointer(id)}`;
    if (nonemptyString(source.id, `${base}/id`) !== id) {
      fail("execution.workflow_id", `${base}/id`, `workflow id does not match registry key ${id}`);
    }
    // Research schema-2 bundles predate explicit per-workflow versions. Their complete definition
    // hash remains authoritative; 0.0.0 is the named compatibility generation until the project
    // intentionally versions that workflow.
    const version = optionalNonemptyString(source.version, `${base}/version`) ?? "0.0.0";
    if (validSemver(version) === null) {
      fail(
        "execution.workflow_version",
        `${base}/version`,
        "workflow version must be exact semantic versioning",
      );
    }
    if (!Array.isArray(source.steps) || source.steps.length === 0) {
      fail("execution.workflow_steps", `${base}/steps`, "workflow requires at least one step");
    }
    const stepIds = new Set<string>();
    const steps = (source.steps as readonly ConfigurationValue[]).map((raw, index) => {
      const stepPath = `${base}/steps/${index}`;
      const step = record(raw, stepPath);
      const stepId = nonemptyString(step.id, `${stepPath}/id`);
      if (stepIds.has(stepId))
        fail("execution.workflow_step_id", `${stepPath}/id`, `duplicate workflow step ${stepId}`);
      stepIds.add(stepId);
      if (step.required === false) {
        fail(
          "execution.optional_step_unsupported",
          `${stepPath}/required`,
          "required: false is unsupported until the workflow declares a compiler-evaluable skip predicate",
        );
      }
      if (step.required !== undefined && step.required !== true) {
        fail(
          "execution.workflow_step_required",
          `${stepPath}/required`,
          "workflow step required must be a boolean",
        );
      }
      const stepMaterial = {
        id: stepId,
        required: true as const,
        ...(step.preserve_source_paths_from === undefined
          ? {}
          : {
              preserveSourcePathsFrom: nonemptyString(
                step.preserve_source_paths_from,
                `${stepPath}/preserve_source_paths_from`,
              ),
            }),
        requiredReceipts: Object.freeze(
          uniqueStrings(
            stringArray(step.required_receipts, `${stepPath}/required_receipts`),
            `${stepPath}/required_receipts`,
          ),
        ),
        escalationTriggers: Object.freeze(
          uniqueStrings(
            stringArray(step.escalation_triggers, `${stepPath}/escalation_triggers`),
            `${stepPath}/escalation_triggers`,
          ),
        ),
        stopConditions: Object.freeze(
          uniqueStrings(
            stringArray(step.stop_conditions, `${stepPath}/stop_conditions`),
            `${stepPath}/stop_conditions`,
          ),
        ),
        validationChecks: Object.freeze(
          uniqueStrings(stringArray(step.checks, `${stepPath}/checks`), `${stepPath}/checks`),
        ),
      };
      return deepFreeze({ ...stepMaterial, sha256: canonicalHash(stepMaterial) });
    });
    for (const [index, step] of steps.entries()) {
      if (
        step.preserveSourcePathsFrom !== undefined &&
        !stepIds.has(step.preserveSourcePathsFrom)
      ) {
        fail(
          "execution.preserve_source_step",
          `${base}/steps/${index}/preserve_source_paths_from`,
          `source-preservation step ${step.preserveSourcePathsFrom} does not exist`,
        );
      }
    }
    const workflowMaterial = {
      id,
      version,
      appliesTo: Object.freeze(
        uniqueStrings(stringArray(source.applies_to, `${base}/applies_to`), `${base}/applies_to`),
      ),
      steps: Object.freeze(steps),
    };
    output[id] = deepFreeze({ ...workflowMaterial, sha256: canonicalHash(workflowMaterial) });
  }
  return deepFreeze(output);
}

function compileChecks(
  configuration: Pick<CompiledConfiguration, "registries">,
): Record<string, CompiledCheckSemantics> {
  const output: Record<string, CompiledCheckSemantics> = Object.create(null) as Record<
    string,
    CompiledCheckSemantics
  >;
  for (const [id, source] of sortedEntries(configuration.registries.checks)) {
    const base = `/registries/checks/${escapePointer(id)}`;
    if (nonemptyString(source.id, `${base}/id`) !== id) {
      fail("execution.check_id", `${base}/id`, `check id does not match registry key ${id}`);
    }
    const kind = nonemptyString(source.kind, `${base}/kind`);
    // Managed 0.7 Coding runs may carry this exact, unreferenced stock check in their immutable
    // compiled artifact. It never had a native executor and was removed from 0.8. Project
    // migration and pinned-run reopening share one whole-object identity: only that frozen object
    // is omitted. A customization still reaches the unsupported-kind failure below, while a real
    // workflow reference fails the cross-registry check after omission.
    if (
      id === "browser-smoke" &&
      kind === "agent" &&
      canonicalHash(source) === RETIRED_STOCK_BROWSER_SMOKE_SHA256
    )
      continue;
    if (kind !== "command" && kind !== "graph" && kind !== "composite") {
      fail("execution.check_kind", `${base}/kind`, `unsupported configured check kind ${kind}`);
    }
    const compiledKind = kind;
    const receiptFreshness =
      optionalNonemptyString(source.receipt_freshness, `${base}/receipt_freshness`) ?? "current";
    if (receiptFreshness !== "current" && receiptFreshness !== "historical") {
      fail(
        "execution.receipt_freshness",
        `${base}/receipt_freshness`,
        `unsupported receipt freshness ${receiptFreshness}`,
      );
    }
    const compiledReceiptFreshness = receiptFreshness;
    const composedReplay =
      optionalNonemptyString(source.composed_replay, `${base}/composed_replay`) ?? "required";
    if (composedReplay !== "required" && composedReplay !== "never") {
      fail(
        "execution.composed_replay",
        `${base}/composed_replay`,
        `unsupported composed replay policy ${composedReplay}`,
      );
    }
    const compiledComposedReplay = composedReplay;
    const effect = optionalNonemptyString(source.effect, `${base}/effect`) ?? "read_only";
    if (effect !== "read_only" && effect !== "workspace_write" && effect !== "external") {
      fail(
        "execution.check_effect",
        `${base}/effect`,
        `unsupported configured check effect ${effect}`,
      );
    }
    const compiledEffect = effect;
    if (receiptFreshness === "historical" && (kind !== "command" || effect !== "read_only")) {
      fail(
        "execution.historical_check_effect",
        `${base}/receipt_freshness`,
        "historical receipts require a read-only command check",
      );
    }
    if (
      receiptFreshness === "historical" &&
      (source.result_protocol !== undefined ||
        source.dynamic_result !== undefined ||
        (Array.isArray(source.artifact_paths) && source.artifact_paths.length > 0))
    ) {
      fail(
        "execution.historical_check_result",
        `${base}/receipt_freshness`,
        "historical receipts may record process evidence but not current result or artifact evidence",
      );
    }
    if (composedReplay === "never" && kind !== "command") {
      fail(
        "execution.composed_replay_kind",
        `${base}/composed_replay`,
        "composed replay policy applies only to command checks",
      );
    }
    const retry = optionalRecord(source.retry_policy, `${base}/retry_policy`) ?? {};
    rejectUnknown(
      retry,
      ["max_attempts", "transient_exit_codes", "backoff_seconds"],
      `${base}/retry_policy`,
    );
    const configuredAttempts =
      optionalNonnegativeInteger(retry.max_attempts, `${base}/retry_policy/max_attempts`) ?? 0;
    const transientExitCodes = uniqueNumbers(
      integerArray(retry.transient_exit_codes, `${base}/retry_policy/transient_exit_codes`, 0, 255),
      `${base}/retry_policy/transient_exit_codes`,
    );
    const backoffSeconds = integerArray(
      retry.backoff_seconds,
      `${base}/retry_policy/backoff_seconds`,
      0,
      86_400,
    );
    if (configuredAttempts === 0 && (transientExitCodes.length > 0 || backoffSeconds.length > 0)) {
      fail(
        "execution.retry_without_attempts",
        `${base}/retry_policy`,
        "retry details require max_attempts greater than zero",
      );
    }
    const maxAttempts = Math.max(1, configuredAttempts);
    if (maxAttempts > MAX_CHECK_ATTEMPTS) {
      fail(
        "execution.retry_attempt_limit",
        `${base}/retry_policy/max_attempts`,
        `configured checks permit at most ${MAX_CHECK_ATTEMPTS} attempts`,
      );
    }
    if (backoffSeconds.length > Math.max(0, maxAttempts - 1)) {
      fail(
        "execution.retry_backoff_count",
        `${base}/retry_policy/backoff_seconds`,
        "retry backoff may contain at most one delay before each retry",
      );
    }
    const expectedExitCodes = integerArray(
      source.expected_exit_codes,
      `${base}/expected_exit_codes`,
      0,
      255,
    );
    if (transientExitCodes.some((code) => expectedExitCodes.includes(code))) {
      fail(
        "execution.retry_exit_overlap",
        `${base}/retry_policy/transient_exit_codes`,
        "an exit code cannot be both accepted and transient",
      );
    }
    const timeoutSeconds =
      optionalNonnegativeInteger(source.timeout_seconds, `${base}/timeout_seconds`) ?? 0;
    if (timeoutSeconds > 0 && timeoutSeconds * maxAttempts > MAX_CHECK_TOTAL_EXECUTION_SECONDS) {
      fail(
        "execution.retry_timeout_limit",
        `${base}/retry_policy/max_attempts`,
        `aggregate retry execution may not exceed ${MAX_CHECK_TOTAL_EXECUTION_SECONDS} seconds`,
      );
    }
    const checkMaterial: Omit<CompiledCheckSemantics, "sha256"> = {
      id,
      kind: compiledKind,
      effect: compiledEffect,
      receiptType: optionalString(source.receipt_type, `${base}/receipt_type`) ?? "",
      receiptFreshness: compiledReceiptFreshness,
      composedReplay: compiledComposedReplay,
      retryPolicy: deepFreeze({
        maxAttempts,
        transientExitCodes: Object.freeze(transientExitCodes),
        backoffSeconds: Object.freeze(backoffSeconds),
      }),
    };
    output[id] = deepFreeze({ ...checkMaterial, sha256: canonicalHash(checkMaterial) });
  }
  return deepFreeze(output);
}

function validateCrossRegistryContracts(
  operations: Readonly<Record<string, CompiledOperationSemantics>>,
  workflows: Readonly<Record<string, CompiledWorkflowSemantics>>,
  checks: Readonly<Record<string, CompiledCheckSemantics>>,
): void {
  const operationsByPublicName = new Map<string, CompiledOperationSemantics[]>();
  for (const operation of Object.values(operations)) {
    const values = operationsByPublicName.get(operation.publicOperation) ?? [];
    values.push(operation);
    operationsByPublicName.set(operation.publicOperation, values);
    if (operation.workflowId !== undefined && workflows[operation.workflowId] === undefined) {
      fail(
        "execution.operation_workflow",
        `/registries/operations/${escapePointer(operation.id)}/workflow`,
        `operation references unknown workflow ${operation.workflowId}`,
      );
    }
    if (
      operation.singleFlightGroup !== undefined &&
      operation.singleFlightGroup.trim().length === 0
    ) {
      fail(
        "execution.single_flight_group",
        `/registries/operations/${escapePointer(operation.id)}/single_flight_group`,
        "single-flight group must be nonempty",
      );
    }
  }
  for (const operation of Object.values(operations)) {
    validateChangeControlLinks(operation, operationsByPublicName, workflows);
    const proofCheck = operation.proofSourcePreparationCheckId;
    if (proofCheck === undefined) continue;
    const check = checks[proofCheck];
    if (check === undefined || check.kind !== "composite") {
      fail(
        "execution.proof_preparation_check",
        `/registries/operations/${escapePointer(operation.id)}/proof_source_preparation_check`,
        `proof-source preparation requires a configured composite check ${proofCheck}`,
      );
    }
    const workflow =
      operation.workflowId === undefined ? undefined : workflows[operation.workflowId];
    if (workflow === undefined) {
      fail(
        "execution.proof_preparation_workflow",
        `/registries/operations/${escapePointer(operation.id)}/workflow`,
        "proof-source preparation requires a workflow",
      );
    }
    const scheduled = workflow.steps.filter((step) => step.validationChecks.includes(proofCheck));
    if (scheduled.length !== 1 || !scheduled[0]!.requiredReceipts.includes(check.receiptType)) {
      fail(
        "execution.proof_preparation_schedule",
        `/registries/workflows/${escapePointer(workflow.id)}/steps`,
        `proof-source preparation check ${proofCheck} must be scheduled once and its receipt type required`,
      );
    }
  }
  for (const workflow of Object.values(workflows)) {
    for (const step of workflow.steps) {
      for (const checkId of step.validationChecks) {
        if (checks[checkId] === undefined) {
          fail(
            "execution.workflow_check",
            `/registries/workflows/${escapePointer(workflow.id)}/steps/${escapePointer(step.id)}/checks`,
            `workflow step references unknown check ${checkId}`,
          );
        }
      }
      for (const receiptType of step.requiredReceipts) {
        if (
          !COMPILER_RECEIPT_TYPES.has(receiptType) &&
          !step.validationChecks.some((checkId) => checks[checkId]?.receiptType === receiptType)
        ) {
          fail(
            "execution.required_receipt_source",
            `/registries/workflows/${escapePointer(workflow.id)}/steps/${escapePointer(step.id)}/required_receipts`,
            `required receipt ${receiptType} is not produced by a configured check on this step`,
          );
        }
      }
    }
  }
}

function validateChangeControlLinks(
  operation: CompiledOperationSemantics,
  byPublicName: ReadonlyMap<string, readonly CompiledOperationSemantics[]>,
  workflows: Readonly<Record<string, CompiledWorkflowSemantics>>,
): void {
  const base = `/registries/operations/${escapePointer(operation.id)}/change_control`;
  const control = operation.changeControl;
  if (control.role === "ordinary") {
    if (!control.allowUpstreamRequests) {
      if (control.proposalOperation !== undefined) {
        fail(
          "execution.change_control_route",
          base,
          "closed ordinary change control may not name a proposal route",
        );
      }
      return;
    }
    const matches =
      control.proposalOperation === undefined
        ? []
        : (byPublicName.get(control.proposalOperation) ?? []);
    if (matches.length !== 1 || matches[0]!.changeControl.role !== "proposal") {
      fail(
        "execution.change_control_route",
        base,
        "ordinary proposal route must resolve to exactly one proposal operation",
      );
    }
    return;
  }
  if (control.role === "proposal") {
    const workflow =
      operation.workflowId === undefined ? undefined : workflows[operation.workflowId];
    if (
      workflow === undefined ||
      !workflow.steps.some((step) => step.id === control.proposalStep)
    ) {
      fail(
        "execution.change_control_proposal_step",
        base,
        "proposal change control requires its configured workflow step",
      );
    }
    for (const publicName of control.applicationOperations) {
      const matches = byPublicName.get(publicName) ?? [];
      if (
        matches.length !== 1 ||
        (matches[0]!.changeControl.role !== "application" &&
          matches[0]!.changeControl.role !== "disposition")
      ) {
        fail(
          "execution.change_control_application",
          base,
          `change-control application ${publicName} is not uniquely typed`,
        );
      }
    }
  }
}

function compileChangeControl(
  value: ConfigurationValue | undefined,
  path: string,
): CompiledChangeControl {
  if (value === undefined) return deepFreeze({ role: "ordinary", allowUpstreamRequests: false });
  const source = record(value, path);
  const role = nonemptyString(source.role, `${path}/role`);
  const allowed = CHANGE_CONTROL_FIELDS[role];
  if (allowed === undefined)
    fail(
      "execution.change_control_role",
      `${path}/role`,
      `unsupported change-control role ${role}`,
    );
  rejectUnknown(source, allowed, path);
  if (role === "ordinary") {
    const allowUpstreamRequests =
      optionalBoolean(source.allow_upstream_requests, `${path}/allow_upstream_requests`) ?? false;
    const proposalOperation = optionalNonemptyString(
      source.proposal_operation,
      `${path}/proposal_operation`,
    );
    return deepFreeze({
      role,
      allowUpstreamRequests,
      ...(proposalOperation === undefined ? {} : { proposalOperation }),
    });
  }
  if (role === "proposal") {
    const decisionPolicy =
      optionalNonemptyString(source.decision_policy, `${path}/decision_policy`) ?? "operator";
    if (decisionPolicy !== "operator" && decisionPolicy !== "automatic") {
      fail(
        "execution.change_control_decision_policy",
        `${path}/decision_policy`,
        `unsupported proposal decision policy ${decisionPolicy}`,
      );
    }
    return deepFreeze({
      role,
      proposalStep: nonemptyString(source.proposal_step, `${path}/proposal_step`),
      applicationOperations: Object.freeze(
        uniqueStrings(
          stringArray(source.application_operations, `${path}/application_operations`),
          `${path}/application_operations`,
          false,
        ),
      ),
      decisionPolicy,
    });
  }
  if (role === "application") return deepFreeze({ role });
  const outcome = nonemptyString(source.outcome, `${path}/outcome`);
  if (outcome !== "no_op")
    fail(
      "execution.change_control_outcome",
      `${path}/outcome`,
      `unsupported disposition ${outcome}`,
    );
  return deepFreeze({ role: "disposition", outcome });
}

function compilePortfolioGuidance(
  value: ConfigurationValue,
  path: string,
): CompiledPortfolioGuidance {
  const source = record(value, path);
  rejectUnknown(source, PORTFOLIO_GUIDANCE_FIELDS, path);
  const preferredCount = positiveInteger(source.preferred_count, `${path}/preferred_count`);
  return deepFreeze({
    preferredCount,
    unit: nonemptyString(source.unit, `${path}/unit`),
    groupWhen: nonemptyString(source.group_when, `${path}/group_when`),
    splitWhen: nonemptyString(source.split_when, `${path}/split_when`),
    avoid: nonemptyString(source.avoid, `${path}/avoid`),
  });
}

function record(value: ConfigurationValue, path: string): ConfigurationObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail("execution.mapping", path, "expected a mapping");
  }
  return value as ConfigurationObject;
}

function optionalRecord(
  value: ConfigurationValue | undefined,
  path: string,
): ConfigurationObject | undefined {
  return value === undefined ? undefined : record(value, path);
}

function nonemptyString(value: ConfigurationValue | undefined, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    fail("execution.string", path, "expected a nonempty string");
  return value;
}

function optionalString(value: ConfigurationValue | undefined, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail("execution.string", path, "expected a string");
  return value;
}

function optionalNonemptyString(
  value: ConfigurationValue | undefined,
  path: string,
): string | undefined {
  return value === undefined ? undefined : nonemptyString(value, path);
}

function optionalBoolean(value: ConfigurationValue | undefined, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail("execution.boolean", path, "expected a boolean");
  return value;
}

function positiveInteger(value: ConfigurationValue | undefined, path: string): number {
  const parsed = optionalNonnegativeInteger(value, path);
  if (parsed === undefined || parsed < 1)
    fail("execution.positive_integer", path, "expected a positive safe integer");
  return parsed;
}

function optionalNonnegativeInteger(
  value: ConfigurationValue | undefined,
  path: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("execution.nonnegative_integer", path, "expected a nonnegative safe integer");
  }
  return value;
}

function stringArray(value: ConfigurationValue | undefined, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("execution.array", path, "expected an array");
  return value.map((entry, index) => nonemptyString(entry, `${path}/${index}`));
}

function integerArray(
  value: ConfigurationValue | undefined,
  path: string,
  minimum: number,
  maximum: number,
): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("execution.array", path, "expected an array");
  return value.map((entry, index) => {
    if (
      typeof entry !== "number" ||
      !Number.isSafeInteger(entry) ||
      entry < minimum ||
      entry > maximum
    ) {
      fail(
        "execution.integer",
        `${path}/${index}`,
        `expected an integer from ${minimum} through ${maximum}`,
      );
    }
    return entry;
  });
}

function uniqueStrings(values: readonly string[], path: string, allowEmpty = true): string[] {
  if (!allowEmpty && values.length === 0)
    fail("execution.nonempty_array", path, "expected a nonempty array");
  const sorted = [...values].sort(compareUtf8);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1])
      fail("execution.duplicate", path, `duplicate value ${sorted[index]}`);
  }
  return sorted;
}

function uniqueNumbers(values: readonly number[], path: string): number[] {
  const sorted = [...values].sort((left, right) => left - right);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1])
      fail("execution.duplicate", path, `duplicate value ${sorted[index]}`);
  }
  return sorted;
}

function rejectUnknown(
  source: ConfigurationObject,
  allowed: readonly string[],
  path: string,
): void {
  const permitted = new Set(allowed);
  for (const key of Object.keys(source)) {
    if (!permitted.has(key))
      fail("execution.unknown_field", `${path}/${escapePointer(key)}`, `unsupported field ${key}`);
  }
}

function sortedEntries<T>(source: Readonly<Record<string, T>>): Array<[string, T]> {
  return Object.entries(source).sort(([left], [right]) => compareUtf8(left, right));
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function fail(code: string, path: string, message: string): never {
  throw new ExecutionSemanticCompilationError(code, path, message);
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
