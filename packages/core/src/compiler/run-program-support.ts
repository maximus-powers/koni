import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  resolveExecutionPolicyBinding,
  type ExecutionPolicyBinding,
} from "../authority/execution-policy.js";
import type { JsonValue } from "../authority/protocol.js";
import type {
  CompiledConfiguration,
  ConfigurationObject,
  ConfigurationValue,
} from "../contracts/configuration.js";
import type { CompiledRuleEvaluation, DerivedTicketDefinition } from "../contracts/rules.js";
import {
  GraphSchema,
  GraphValidationError,
  type TypedGraph,
  type GraphNode,
} from "../graph/model.js";
import { canonicalHash, type Sha256Digest } from "../shared/canonical.js";
import {
  type AgentAttemptRecord,
  type RunCheckRecord,
  type RunRecord,
  type TicketRecord,
} from "../state/run-record.js";
import {
  COMPILER_INAPPLICABLE_TICKET,
  COMPILER_ROUTED_TO_PLANNED_ASSET_REPAIR,
} from "../state/scheduler.js";
import {
  createProductionRuleDomainAdapter,
  prepareFilesystemManifestAcceptance,
  type RuleAuthorityEvidence,
} from "./domain-adapter.js";
import { type CompiledExecutionSemanticCatalog } from "./execution-semantics.js";
import { GraphExpressionEvaluator } from "./expressions.js";
import { validateConfiguredGraphConstraints } from "./graph-constraints.js";
import { projectGatePolicyDefinitions, projectGraphSchemaDefinition } from "./graph-schema.js";
import { expandPythonPackageReadPaths } from "./rules.js";

import {
  compareText,
  digestBody,
  fail,
  graphField,
  isRecord,
  optionalRecord,
  optionalSafeInteger,
  optionalString,
  requireValidation,
  requiredNonempty,
  requiredRecord,
  resolveReviewEffectTokens,
  stringArray,
} from "./run-check-execution.js";
import { PI_THINKING_LEVELS } from "./run-program-contracts.js";

export const LEGACY_DELIVERY_NODE_SHA256 =
  "sha256:cbe87347eaa602ec31828745a8dd25417e1cad9cc3a86afc0ae9bf0d8003277d" as Sha256Digest;
export const LEGACY_BROAD_DELIVERY_REVIEW_WORKFLOW_SHA256 =
  "sha256:a7cee4b6e610d2c736da09dad7dc2f3261fdd1804bc2a76c6d518df750a184f8" as Sha256Digest;

export function resolveDefinitionExecutionBindings(
  catalog: CompiledExecutionSemanticCatalog,
  definition: DerivedTicketDefinition,
): { ticket: ExecutionPolicyBinding; steps: ReadonlyMap<string, ExecutionPolicyBinding> } {
  if (definition.configuration_sha256 !== catalog.configurationSha256) {
    fail(
      "execution_policy_configuration",
      `ticket ${definition.id} does not belong to the pinned execution-policy catalog`,
    );
  }
  const selector = {
    configurationSha256: catalog.configurationSha256,
    operationId: definition.operation_registry_id,
    ...(definition.workflow_id === undefined ? {} : { workflowId: definition.workflow_id }),
  };
  const ticket = resolveExecutionPolicyBinding(catalog, selector);
  const steps = new Map<string, ExecutionPolicyBinding>();
  for (const step of definition.workflow) {
    steps.set(step.id, resolveExecutionPolicyBinding(catalog, { ...selector, stepId: step.id }));
  }
  return { ticket, steps };
}

export function assertOrBackfillExecutionPolicyBinding(
  target: { executionPolicyBinding?: ExecutionPolicyBinding },
  expected: ExecutionPolicyBinding,
  label: string,
): void {
  if (target.executionPolicyBinding === undefined) {
    // Explicit compatibility path for imported/pre-semantic records: the complete immutable
    // pinned configuration, never current project YAML, supplies the missing durable projection.
    target.executionPolicyBinding = structuredClone(expected);
    return;
  }
  if (canonicalHash(target.executionPolicyBinding) !== canonicalHash(expected)) {
    fail("execution_policy_drift", `${label} differs from its pinned execution-policy binding`);
  }
}

/**
 * Repair the one historical research-profile deadlock where a generated gate verifier
 * had a complete implementation plan but its own implementation ticket was withheld
 * until the verifier was already policy-selected. This is deliberately narrower than
 * normal ticket derivation: it preserves the pinned graph and uses only the pinned
 * implement-asset operation and workflow. Newer profiles derive this ticket normally.
 */
export function hasExistingAssetImplementationTicket(
  run: Pick<RunRecord, "tickets">,
  operationId: string,
  assetId: string,
): boolean {
  return Object.values(run.tickets).some(
    (ticket) =>
      ticket.operationId === operationId &&
      ticket.targetNodeIds.includes(assetId) &&
      (ticket.status !== "cancelled" ||
        (ticket.blocker === COMPILER_INAPPLICABLE_TICKET &&
          ticket.steps.length > 0 &&
          ticket.steps.every((step) => step.status === "skipped"))),
  );
}

export async function assetImplementationFilesMaterialized(
  projectRoot: string,
  files: readonly string[],
): Promise<boolean> {
  const root = path.resolve(projectRoot);
  for (const file of files) {
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    if (
      relative.length === 0 ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return false;
    }
    try {
      const metadata = await lstat(absolute);
      if (!metadata.isFile() || metadata.size === 0) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

export async function recurringAssetReissueNodeIds(
  run: Pick<RunRecord, "tickets" | "checks" | "attempts" | "git">,
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  evaluation: CompiledRuleEvaluation,
  projectRoot: string,
): Promise<ReadonlySet<string>> {
  const plannedRepairTargets = new Set<string>();
  const routableProposalIds = routablePlannedAssetRepairProposalIds(run, evaluation.tickets);
  for (const proposalId of routableProposalIds) {
    for (const nodeId of run.tickets[proposalId]?.targetNodeIds ?? []) {
      plannedRepairTargets.add(nodeId);
    }
  }
  const blockedGateProviders = experimentBoundaryBlockedGateProviderNodeIds(graph, evaluation);
  const delegatedGateNodeIds = standaloneSupportRunGateNodeIds(graph, evaluation);
  const standaloneRunNodeIdsByAsset = standaloneSupportRunAssetNodeIds(graph, evaluation);
  const selectedGateIdsByProvider = new Map<string, Set<string>>();
  for (const context of evaluation.gate_policy_contexts) {
    if (context.winner_node_id === undefined) continue;
    const gateIds = selectedGateIdsByProvider.get(context.winner_node_id) ?? new Set<string>();
    gateIds.add(context.gate_node_id);
    selectedGateIdsByProvider.set(context.winner_node_id, gateIds);
  }
  const reissue = new Set<string>();
  for (const definition of evaluation.tickets) {
    if (definition.operation_registry_id !== "asset-resolution.asset.implement-asset") continue;
    for (const nodeId of definition.target_node_ids) {
      if (plannedRepairTargets.has(nodeId)) {
        reissue.add(nodeId);
        continue;
      }
      const node = graph.node(nodeId);
      const manifestDefinition =
        node === undefined
          ? undefined
          : optionalRecord(configuration.registries.node_types[node.type]?.filesystem_manifest);
      if (node === undefined || manifestDefinition === undefined) {
        reissue.add(nodeId);
        continue;
      }
      const implementationPlan = optionalRecord(node.spec.implementation_plan);
      const implementationRoot = optionalString(implementationPlan?.root);
      const implementationFiles = Array.isArray(implementationPlan?.files)
        ? implementationPlan.files.filter(
            (file): file is string => typeof file === "string" && file.length > 0,
          )
        : [];
      if (implementationRoot !== undefined && implementationFiles.length > 0) {
        const readPaths = generatedAssetImplementationReadPaths(node, implementationRoot);
        const repairRequest = pendingPlannedAssetRepairRequestForNode({
          run,
          configurationSha256: configuration.configuration_sha256,
          node,
          root: implementationRoot,
          files: implementationFiles,
          readPaths,
        });
        if (
          repairRequest !== undefined &&
          definition.id ===
            generatedAssetRepairTicketId({
              configurationSha256: configuration.configuration_sha256,
              node,
              root: implementationRoot,
              files: implementationFiles,
              readPaths,
              request: repairRequest,
            })
        ) {
          reissue.add(nodeId);
          continue;
        }
      }
      const outputField = optionalString(manifestDefinition.output_field);
      if (outputField === undefined) {
        reissue.add(nodeId);
        continue;
      }
      const extendedNode = node as unknown as ConfigurationObject & {
        fields?: ConfigurationObject;
      };
      const currentManifest = optionalRecord(
        extendedNode.fields?.[outputField] ?? extendedNode[outputField],
      );
      const acceptance = await prepareFilesystemManifestAcceptance(
        configuration,
        node,
        projectRoot,
      );
      const currentAcceptedContentHash = optionalString(currentManifest?.accepted_content_hash);
      const currentContentHash = optionalString(acceptance?.manifest.content_hash);
      const implementationCurrent =
        acceptance !== undefined &&
        acceptance.blockingErrors.length === 0 &&
        currentAcceptedContentHash !== undefined &&
        currentAcceptedContentHash === currentContentHash &&
        optionalString(currentManifest?.implementation_status) === "ready" &&
        optionalString(currentManifest?.vendor_status) === "vendored";
      const selectedGateIds = selectedGateIdsByProvider.get(nodeId) ?? new Set<string>();
      const standaloneRunNodeIds = standaloneRunNodeIdsByAsset.get(nodeId);
      const gateContracts = optionalRecord(node.spec.gate_contracts);
      const validates = new Set(node.edges.validates ?? []);
      const selectedGateContractsCurrent = [...selectedGateIds].every((gateId) => {
        const contract = optionalRecord(gateContracts?.[gateId]);
        return (
          optionalString(contract?.protocol) === "autoresearch.gate-result.v1" &&
          Array.isArray(contract?.argv) &&
          contract.argv.length > 0 &&
          contract.argv.every((value) => typeof value === "string" && value.length > 0) &&
          validates.has(gateId)
        );
      });
      if (
        recurringAssetRequiresReissue({
          implementationCurrent,
          selectedGateContractsCurrent,
          selectedGateBlocked:
            blockedGateProviders.has(nodeId) &&
            recurringAssetHasUnaddressedGateFailure({
              tickets: run.tickets,
              attempts: run.attempts,
              checks: run.checks,
              providerNodeId: nodeId,
              gateNodeIds: selectedGateIds,
              delegatedGateNodeIds,
            }),
          standaloneSupportRunFailed:
            standaloneRunNodeIds !== undefined &&
            recurringAssetHasUnaddressedStandaloneRunFailure({
              tickets: run.tickets,
              attempts: run.attempts,
              checks: run.checks,
              ticketCycles: run.git.ticketCycles,
              assetNodeId: nodeId,
              runNodeIds: standaloneRunNodeIds,
            }),
          reviewReworkPending: recurringAssetReviewReworkPending(run.tickets, nodeId),
        })
      ) {
        reissue.add(nodeId);
      }
    }
  }
  return reissue;
}

/**
 * Treat a completed provider repair as the causal response to every nonpassing gate receipt that
 * predates it. Reopening again for those same receipts creates an asset-review loop and starves
 * the gate ticket that must recheck or analyze the repaired provider. A newer nonpassing receipt
 * is fresh evidence and may reopen the provider once more.
 */
export function recurringAssetHasUnaddressedGateFailure(input: {
  readonly tickets: Readonly<Record<string, TicketRecord>>;
  readonly attempts?: Readonly<Record<string, AgentAttemptRecord>>;
  readonly checks: readonly RunCheckRecord[] | undefined;
  readonly providerNodeId: string;
  readonly gateNodeIds: ReadonlySet<string>;
  readonly delegatedGateNodeIds?: ReadonlySet<string>;
}): boolean {
  const providerRepairGateNodeIds = new Set(
    [...input.gateNodeIds].filter(
      (gateNodeId) => input.delegatedGateNodeIds?.has(gateNodeId) !== true,
    ),
  );
  if (providerRepairGateNodeIds.size === 0) return false;
  const latestFailureAt = input.checks
    ?.filter(
      (check) =>
        check.accepted &&
        check.passed === false &&
        check.executionPolicy?.gatePolicyContexts.some((context) =>
          providerRepairGateNodeIds.has(context.gateNodeId),
        ),
    )
    .map((check) => check.recordedAt)
    .sort(compareText)
    .at(-1);
  if (latestFailureAt === undefined) return true;
  const providerTickets = Object.values(input.tickets).filter(
    (ticket) =>
      ticket.operationId === "asset-resolution.asset.implement-asset" &&
      ticket.status !== "cancelled" &&
      ticket.targetNodeIds.includes(input.providerNodeId),
  );
  const latestCompletedRepairAt = providerTickets
    .filter(
      (ticket) =>
        ticket.steps.length > 0 && ticket.steps.every((step) => step.status === "completed"),
    )
    .flatMap((ticket) => [
      ticket.updatedAt,
      ...ticket.steps.flatMap((step) => (step.completedAt === undefined ? [] : [step.completedAt])),
    ])
    .concat(
      providerTickets.flatMap((ticket) =>
        completedRecurringAssetEpochTimes(ticket, input.attempts ?? {}),
      ),
    )
    .sort(compareText)
    .at(-1);
  return (
    latestCompletedRepairAt === undefined ||
    compareText(latestFailureAt, latestCompletedRepairAt) > 0
  );
}

/**
 * A rejected standalone support-run command is evidence that one of its exact executable assets
 * still needs repair. Compare only the newest runtime check with a fully completed asset workflow
 * epoch so an older rejection cannot reopen an asset after either a successful rerun or repair.
 */
export function recurringAssetHasUnaddressedStandaloneRunFailure(input: {
  readonly tickets: Readonly<Record<string, TicketRecord>>;
  readonly attempts: Readonly<Record<string, AgentAttemptRecord>>;
  readonly checks: readonly RunCheckRecord[] | undefined;
  readonly ticketCycles: RunRecord["git"]["ticketCycles"];
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
    .flatMap((ticket) =>
      completedMaterialRecurringAssetEpochTimes(ticket, input.attempts, input.ticketCycles),
    )
    .sort(compareText)
    .at(-1);
  return (
    latestRepairAt === undefined || compareText(latestRuntimeCheck.recordedAt, latestRepairAt) > 0
  );
}

export function reviewEffectSetAlreadyApplied(
  node: GraphNode,
  set: ConfigurationObject,
  reviewId: string,
  actor: string,
): boolean {
  let staticFieldCount = 0;
  for (const [field, configured] of Object.entries(set)) {
    const current = graphField(node, field);
    if (configured === "$review.id") {
      if (typeof current !== "string" || current.trim().length === 0) return false;
      continue;
    }
    const resolved = resolveReviewEffectTokens(configured, reviewId, actor);
    staticFieldCount += 1;
    if (canonicalHash(current ?? null) !== canonicalHash(resolved)) return false;
  }
  return staticFieldCount > 0;
}

export async function validateOperationReceiptCoverage(input: {
  configuration: CompiledConfiguration;
  graph: TypedGraph;
  operationId: string;
  operation: ConfigurationObject;
  candidates: readonly GraphNode[];
  projectRoot: string;
  evidence?: RuleAuthorityEvidence;
}): Promise<void> {
  if (input.operation.receipt_coverage === undefined) return;
  const leaves: ConfigurationObject[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (value.op === "receipt_coverage_current" && value.receipt_coverage === input.operationId) {
      leaves.push(structuredClone(value) as ConfigurationObject);
    }
    for (const item of Object.values(value)) visit(item);
  };
  for (const query of Object.values(input.configuration.registries.queries)) visit(query);
  if (leaves.length !== 1) {
    fail(
      "review_effect_receipt_coverage",
      `operation ${input.operationId} must have exactly one configured current receipt-coverage predicate`,
    );
  }
  const adapter = await createProductionRuleDomainAdapter({
    configuration: input.configuration,
    graph: input.graph,
    projectRoot: input.projectRoot,
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
  });
  const evaluator = new GraphExpressionEvaluator(input.configuration, input.graph, adapter);
  for (const candidate of input.candidates) {
    const current = evaluator.withBinding("node", [candidate.id], () =>
      evaluator.evaluate(leaves[0]!),
    );
    if (!current) {
      fail(
        "review_effect_receipt_coverage",
        `review effect cannot promote ${candidate.id} without exact current authenticated receipt coverage`,
      );
    }
  }
}

export async function validateReviewEffectCoverage(input: {
  configuration: CompiledConfiguration;
  graph: TypedGraph;
  ticket: DerivedTicketDefinition;
  effect: ConfigurationObject;
  candidates: readonly GraphNode[];
  projectRoot: string;
  evidence?: RuleAuthorityEvidence;
}): Promise<void> {
  if (!Array.isArray(input.effect.coverage) || input.effect.coverage.length === 0) return;
  const adapter = await createProductionRuleDomainAdapter({
    configuration: input.configuration,
    graph: input.graph,
    projectRoot: input.projectRoot,
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
  });
  const evaluator = new GraphExpressionEvaluator(input.configuration, input.graph, adapter);
  evaluator.bind("target", input.ticket.target_node_ids);
  for (const candidate of input.candidates) {
    evaluator.withBinding("candidate", [candidate.id], () => {
      for (const rawCoverage of input.effect.coverage as ConfigurationValue[]) {
        const coverage = requiredRecord(
          rawCoverage,
          "review effect coverage",
        ) as ConfigurationObject;
        const coverageId = requiredNonempty(coverage.id, "review effect coverage id");
        const requiredSelector = coverage.required;
        if (requiredSelector === undefined) {
          fail(
            "review_effect_coverage",
            `review effect coverage ${coverageId} has no required selector`,
          );
        }
        const requiredIds = new Set(evaluator.select(requiredSelector));
        const actual = requiredRecord(
          coverage.actual,
          `review effect coverage ${coverageId} actual`,
        ) as ConfigurationObject;
        const actualIds = reviewEffectActualIds(candidate, actual, coverageId);
        const missing = [...requiredIds].filter((id) => !actualIds.has(id)).sort(compareText);
        const extra = [...actualIds].filter((id) => !requiredIds.has(id)).sort(compareText);
        if (missing.length > 0 || extra.length > 0) {
          fail(
            "review_effect_coverage",
            `review effect coverage ${coverageId} is not exact; missing [${missing.join(", ")}], extra [${extra.join(", ")}]`,
          );
        }
      }
    });
  }
}

export function reviewEffectActualIds(
  candidate: GraphNode,
  actual: ConfigurationObject,
  coverageId: string,
): Set<string> {
  const kind = requiredNonempty(actual.kind, `review effect coverage ${coverageId} actual kind`);
  if (kind === "outgoing_relation") {
    const relation = requiredNonempty(
      actual.relation,
      `review effect coverage ${coverageId} relation`,
    );
    return strictReviewIdSet(candidate.edges[relation] ?? [], coverageId);
  }
  const field = requiredNonempty(actual.field, `review effect coverage ${coverageId} field`);
  const value = graphField(candidate, field);
  if (kind === "field_value") {
    return strictReviewIdSet(
      [requiredNonempty(value, `review effect coverage ${coverageId} field ${field}`)],
      coverageId,
    );
  }
  if (kind === "field_values") {
    if (!Array.isArray(value))
      fail(
        "review_effect_coverage",
        `review effect coverage ${coverageId} field ${field} is not a list`,
      );
    return strictReviewIdSet(
      value.map((item) =>
        requiredNonempty(item, `review effect coverage ${coverageId} field ${field}`),
      ),
      coverageId,
    );
  }
  if (kind === "object_keys") {
    if (!isRecord(value))
      fail(
        "review_effect_coverage",
        `review effect coverage ${coverageId} field ${field} is not an object`,
      );
    const allowed = Array.isArray(actual.allowed_values) ? actual.allowed_values : [];
    if (allowed.length > 0) {
      for (const [id, disposition] of Object.entries(value)) {
        if (!allowed.some((item) => canonicalHash(item) === canonicalHash(disposition))) {
          fail(
            "review_effect_coverage",
            `review effect coverage ${coverageId} has an invalid disposition for ${id}`,
          );
        }
      }
    }
    return strictReviewIdSet(Object.keys(value), coverageId);
  }
  fail(
    "review_effect_coverage",
    `review effect coverage ${coverageId} has unsupported actual kind ${kind}`,
  );
}

export function strictReviewIdSet(values: readonly string[], coverageId: string): Set<string> {
  if (values.some((value) => value.trim().length === 0)) {
    fail(
      "review_effect_coverage",
      `review effect coverage ${coverageId} contains an empty node id`,
    );
  }
  const output = new Set(values);
  if (output.size !== values.length) {
    fail(
      "review_effect_coverage",
      `review effect coverage ${coverageId} contains duplicate node ids`,
    );
  }
  return output;
}

export function validateEffectCount(actual: number, count: ConfigurationObject | undefined): void {
  if (count === undefined) return;
  const exact = optionalSafeInteger(count.exact);
  const min = optionalSafeInteger(count.min);
  const max = optionalSafeInteger(count.max);
  if (
    (exact !== undefined && actual !== exact) ||
    (min !== undefined && actual < min) ||
    (max !== undefined && actual > max)
  ) {
    fail(
      "review_effect_count",
      `review effect selected ${actual} nodes outside its configured count`,
    );
  }
}

export function setNodeField(node: GraphNode, field: string, value: JsonValue): void {
  const segments = field.split(".");
  if (segments.some((segment) => segment.length === 0)) {
    fail("compiler_field_path", `compiler-owned field path ${field} is invalid`);
  }
  let current = node as unknown as Record<string, JsonValue>;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (
      existing === undefined ||
      existing === null ||
      Array.isArray(existing) ||
      typeof existing !== "object"
    ) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, JsonValue>;
  }
  current[segments.at(-1)!] = structuredClone(value);
}

export function requireGraphSchema(configuration: CompiledConfiguration): GraphSchema {
  const definition = requireValidation(
    projectGraphSchemaDefinition(configuration),
    "graph_schema_invalid",
    "compiled profile graph schema is invalid",
  );
  return new GraphSchema(definition);
}

export function assertConfiguredGraphConstraints(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  projectRoot: string,
): void {
  try {
    validateConfiguredGraphConstraints(configuration, graph, projectRoot);
  } catch (error) {
    if (error instanceof GraphValidationError) {
      fail(
        "graph_constraint_invalid",
        "semantic graph violates its compiled whole-graph constraints",
        error.diagnostics,
      );
    }
    throw error;
  }
}

/**
 * A planning checkpoint may name repository inputs only when the compiler can bind them to the
 * exact planning checkout or to authority that the same checkpoint grants to create them. This
 * catches copied or invented paths before approval while preserving ordinary planned outputs.
 */

export function typedGateIdentityCatalog(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
): { gateNodeTypes: readonly string[]; gateNodes: readonly { id: string; type: string }[] } {
  const policies = requireValidation(
    projectGatePolicyDefinitions(configuration),
    "gate_policy_invalid",
    "pinned gate policies did not compile",
  );
  const gateNodeTypes = [...new Set(policies.flatMap((policy) => policy.gateNodeTypes))].sort(
    compareText,
  );
  const typed = new Set(gateNodeTypes);
  return {
    gateNodeTypes,
    gateNodes: graph
      .nodes()
      .filter((node) => typed.has(node.type))
      .map((node) => ({ id: node.id, type: node.type }))
      .sort((left, right) => compareText(left.id, right.id)),
  };
}

export function answeredQuestionContext(run: RunRecord): Array<{
  questionId: string;
  prompt: string;
  selectedOptionId?: string;
  selectedOption?: string;
  notes?: string;
  answeredAt: string;
}> {
  return Object.values(run.questions)
    .filter(
      (question): question is typeof question & { answeredAt: string } =>
        question.answeredAt !== undefined,
    )
    .sort(
      (left, right) =>
        left.answeredAt.localeCompare(right.answeredAt) || compareText(left.id, right.id),
    )
    .map((question) => {
      const selected =
        question.selectedOptionId === undefined
          ? undefined
          : question.options.find((option) => option.id === question.selectedOptionId);
      return {
        questionId: question.id,
        prompt: question.prompt,
        ...(selected === undefined
          ? {}
          : {
              selectedOptionId: selected.id,
              selectedOption: selected.label,
            }),
        ...(question.notes === undefined ? {} : { notes: question.notes }),
        answeredAt: question.answeredAt,
      };
    });
}

export function requireThinkingLevel(value: unknown, label: string): ThinkingLevel {
  if (value === "ultra") {
    fail(
      "legacy_thinking_level",
      `${label} still uses legacy ultra; migrate it explicitly to Pi max before execution`,
    );
  }
  if (!PI_THINKING_LEVELS.has(value as ThinkingLevel))
    fail("thinking_level", `${label} has unsupported Pi thinking level ${String(value)}`);
  return value as ThinkingLevel;
}

export function rejectCompilerOwnedSpec(
  fields: readonly string[],
  spec: Record<string, JsonValue>,
  label: string,
): void {
  for (const field of fields) {
    const normalized = field.replace(/^spec\./u, "");
    if (!field.startsWith("spec.")) continue;
    if (
      graphField(
        {
          schema_version: "1.0",
          id: "x",
          type: "x",
          title: "x",
          status: "x",
          spec,
          edges: {},
          annotations: {},
        },
        normalized,
      ) !== undefined
    ) {
      fail("compiler_owned_field", `${label} may not author compiler-owned spec.${normalized}`);
    }
  }
}

export function preserveCompilerOwnedSpec(
  fields: readonly string[],
  existing: GraphNode,
  updated: GraphNode,
): void {
  for (const field of fields) {
    if (!field.startsWith("spec.")) continue;
    if (
      canonicalHash(graphField(existing, field) ?? null) !==
      canonicalHash(graphField(updated, field) ?? null)
    ) {
      fail("compiler_owned_field", `agent may not change compiler-owned ${field}`);
    }
  }
}

export function completedRecurringAssetEpochTimes(
  ticket: TicketRecord,
  attempts: Readonly<Record<string, AgentAttemptRecord>>,
): readonly string[] {
  return completedRecurringAssetEpochs(ticket, attempts).map((epoch) => epoch.completedAt);
}

export function completedMaterialRecurringAssetEpochTimes(
  ticket: TicketRecord,
  attempts: Readonly<Record<string, AgentAttemptRecord>>,
  ticketCycles: RunRecord["git"]["ticketCycles"],
): readonly string[] {
  const materialCycleOrdinals = new Set(
    Object.values(ticketCycles)
      .filter(
        (cycle) =>
          cycle.ticketId === ticket.id &&
          (cycle.status === "integrated" || cycle.status === "retired") &&
          cycle.ticketHeadOid !== cycle.baseRunOid,
      )
      .map((cycle) => cycle.ordinal),
  );
  return completedRecurringAssetEpochs(ticket, attempts)
    .filter((epoch) => materialCycleOrdinals.has(epoch.executionEpoch + 1))
    .map((epoch) => epoch.completedAt);
}

/**
 * A standalone support-run ticket is the compiler's explicit remediation path for the gates that
 * run evaluates. While that work is applicable, a nonpassing receipt for the same gate is not
 * evidence that the selected verifier provider needs another implementation cycle.
 */
export function standaloneSupportRunGateNodeIds(
  graph: Pick<ResearchRunContractScopeGraph, "node" | "edges">,
  evaluation: Pick<CompiledRuleEvaluation, "tickets">,
): ReadonlySet<string> {
  const gateNodeIds = new Set<string>();
  const edges = graph.edges();
  for (const definition of evaluation.tickets) {
    if (definition.rule_id !== "compiler.compatibility.research-standalone-support-run") continue;
    for (const nodeId of definition.target_node_ids) {
      const node = graph.node(nodeId);
      if (node?.type !== "run") continue;
      for (const edge of edges) {
        if (edge.source === nodeId && edge.relation === "evaluates") gateNodeIds.add(edge.target);
      }
    }
  }
  return gateNodeIds;
}

/**
 * Bind standalone support runs to only the generated assets whose entrypoints the runtime contract
 * executes. A generic `uses` edge is intentionally insufficient: it can also name read-only data,
 * verifier, and auxiliary assets that did not cause the command failure.
 */
export function standaloneSupportRunAssetNodeIds(
  graph: Pick<ResearchRunContractScopeGraph, "node">,
  evaluation: Pick<CompiledRuleEvaluation, "tickets">,
): ReadonlyMap<string, ReadonlySet<string>> {
  const runNodeIdsByAsset = new Map<string, Set<string>>();
  for (const definition of evaluation.tickets) {
    if (definition.rule_id !== "compiler.compatibility.research-standalone-support-run") continue;
    for (const runNodeId of definition.target_node_ids) {
      const runNode = graph.node(runNodeId);
      if (runNode?.type !== "run") continue;
      const runtimeContract = optionalRecord(runNode.spec.runtime_contract);
      const entrypoints = Array.isArray(runtimeContract?.asset_entrypoints)
        ? runtimeContract.asset_entrypoints
        : [];
      for (const rawEntrypoint of entrypoints) {
        const assetNodeId = optionalString(optionalRecord(rawEntrypoint)?.asset_id);
        const assetNode = assetNodeId === undefined ? undefined : graph.node(assetNodeId);
        if (
          assetNodeId === undefined ||
          assetNode?.type !== "asset" ||
          assetNode.spec.source_strategy !== "generated"
        ) {
          continue;
        }
        const runNodeIds = runNodeIdsByAsset.get(assetNodeId) ?? new Set<string>();
        runNodeIds.add(runNodeId);
        runNodeIdsByAsset.set(assetNodeId, runNodeIds);
      }
    }
  }
  return new Map(
    [...runNodeIdsByAsset.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([assetNodeId, runNodeIds]) => [
        assetNodeId,
        new Set([...runNodeIds].sort(compareText)),
      ]),
  );
}

/**
 * An upstream request that targets only assets already owned by configured implement-asset
 * tickets is repair work inside the approved plan, not a new dynamic scope decision. Route only
 * pristine, unapproved proposals whose exact source is still held; any operator decision or
 * started proposal remains on the explicit change-control path.
 */
export function routablePlannedAssetRepairProposalIds(
  run: Pick<RunRecord, "tickets">,
  definitions: readonly Pick<
    DerivedTicketDefinition,
    "operation_registry_id" | "target_node_ids"
  >[],
): ReadonlySet<string> {
  const implementedAssetIds = new Set(
    definitions
      .filter(
        (definition) =>
          definition.operation_registry_id === "asset-resolution.asset.implement-asset",
      )
      .flatMap((definition) => definition.target_node_ids),
  );
  const proposalIds = new Set<string>();
  for (const proposal of Object.values(run.tickets)) {
    if (!pristineHeldProposal(run, proposal)) continue;
    if (proposal.executionControl?.proposalRequest?.fulfillment !== "planned_asset_repair")
      continue;
    const sourceOwnedAssetIds = sourceOwnedPlannedAssetRepairNodeIds(run, proposal);
    const repairAssetIds = new Set([
      ...proposal.targetNodeIds.filter((nodeId) => implementedAssetIds.has(nodeId)),
      ...sourceOwnedAssetIds,
    ]);
    if (
      repairAssetIds.size === 0 ||
      [...repairAssetIds].some((nodeId) => !implementedAssetIds.has(nodeId))
    )
      continue;
    proposalIds.add(proposal.id);
  }
  return proposalIds;
}

/**
 * A blocked gate without a current terminal receipt needs a fresh check, while a current accepted
 * nonpassing receipt is concrete repair evidence for the selected provider. Reopen the asset only
 * in the latter state so its higher priority cannot starve the first gate execution.
 */
export function recurringAssetRequiresReissue(input: {
  readonly implementationCurrent: boolean;
  readonly selectedGateContractsCurrent: boolean;
  readonly selectedGateBlocked: boolean;
  readonly standaloneSupportRunFailed?: boolean;
  readonly reviewReworkPending?: boolean;
}): boolean {
  return (
    !input.implementationCurrent ||
    !input.selectedGateContractsCurrent ||
    input.selectedGateBlocked ||
    input.standaloneSupportRunFailed === true ||
    input.reviewReworkPending === true
  );
}

export function recurringAssetReviewReworkPending(
  tickets: Readonly<Record<string, TicketRecord>>,
  nodeId: string,
): boolean {
  return Object.values(tickets).some(
    (ticket) =>
      ticket.operationId === "asset-resolution.asset.implement-asset" &&
      ticket.targetNodeIds.includes(nodeId) &&
      ticket.status !== "completed" &&
      ticket.status !== "cancelled" &&
      (ticket.reviewReworks?.length ?? 0) > 0 &&
      ticket.steps.some((step) => step.status === "pending" || step.status === "running"),
  );
}

/**
 * A current file manifest proves byte integrity, not that the implementation satisfies the gate it
 * was selected to verify. When a direct experiment/prerequisite gate has a current accepted
 * nonpassing receipt, its selected provider remains actionable even if every declared file is
 * present and hash-current. Broader hypothesis/root gates are deliberately excluded: treating a
 * terminal report-review gate as an implementation prerequisite creates a circular dependency.
 */
export function experimentBoundaryBlockedGateProviderNodeIds(
  graph: { node(id: string): { readonly type: string } | undefined },
  evaluation: Pick<CompiledRuleEvaluation, "facts" | "gate_policy_contexts">,
): ReadonlySet<string> {
  const selfBlockedGateIds = new Set<string>();
  const currentTerminalGateIds = new Set<string>();
  for (const fact of evaluation.facts) {
    if (fact.kind !== "readiness" || fact.value !== "blocked") continue;
    const blocking = fact.args.blocking_gate_ids;
    if (Array.isArray(blocking) && blocking.some((gateId) => gateId === fact.anchor_node_id)) {
      selfBlockedGateIds.add(fact.anchor_node_id);
    }
    const terminal = fact.args.current_terminal_gate_ids;
    if (Array.isArray(terminal) && terminal.some((gateId) => gateId === fact.anchor_node_id)) {
      currentTerminalGateIds.add(fact.anchor_node_id);
    }
  }
  const providers = new Set<string>();
  for (const context of evaluation.gate_policy_contexts) {
    if (
      context.winner_node_id !== undefined &&
      selfBlockedGateIds.has(context.gate_node_id) &&
      currentTerminalGateIds.has(context.gate_node_id) &&
      context.evaluation_target_node_ids.some((nodeId) => {
        const type = graph.node(nodeId)?.type;
        return type === "experiment" || type === "prerequisite";
      })
    ) {
      providers.add(context.winner_node_id);
    }
  }
  return providers;
}

export function generatedAssetRepairTicketId(
  input: Readonly<{
    configurationSha256: Sha256Digest;
    node: Pick<GraphNode, "id">;
    root: string;
    files: readonly string[];
    readPaths: readonly string[];
    request?: PlannedAssetRepairRequest;
  }>,
): string {
  return `TK-compat-${digestBody(
    canonicalHash({
      configuration_sha256: input.configurationSha256,
      asset_id: input.node.id,
      root: input.root,
      files: [...input.files].sort(compareText),
      read_paths: [...input.readPaths].sort(compareText),
      ...(input.request === undefined
        ? {}
        : { repair_request_sha256: input.request.requestSha256 }),
    }),
  ).slice(0, 24)}`;
}

export function pendingPlannedAssetRepairRequestForNode(
  input: Readonly<{
    run: Pick<RunRecord, "tickets" | "attempts">;
    configurationSha256: Sha256Digest;
    node: Pick<GraphNode, "id">;
    root: string;
    files: readonly string[];
    readPaths: readonly string[];
  }>,
): PlannedAssetRepairRequest | undefined {
  const actionable = plannedAssetRepairRequestsForNode(input.run, input.node.id).flatMap(
    (request) => {
      const ticketId = generatedAssetRepairTicketId({ ...input, request });
      const ticket = input.run.tickets[ticketId];
      if (ticket?.status === "completed") return [];
      if (
        ticket?.status === "cancelled" &&
        ticket.blocker === COMPILER_INAPPLICABLE_TICKET &&
        ticket.steps.length > 0 &&
        ticket.steps.every((step) => step.status === "skipped")
      ) {
        let completedEpochs: Set<number> | undefined;
        for (const step of ticket.steps) {
          const stepEpochs = new Set(
            step.attemptIds.flatMap((attemptId) => {
              const attempt = input.run.attempts[attemptId];
              return attempt?.ticketId === ticket.id &&
                attempt.stepId === step.id &&
                attempt.status === "completed"
                ? [attempt.ticketExecutionEpoch ?? 0]
                : [];
            }),
          );
          completedEpochs =
            completedEpochs === undefined
              ? stepEpochs
              : new Set([...completedEpochs].filter((epoch) => stepEpochs.has(epoch)));
          if (completedEpochs.size === 0) break;
        }
        if ((completedEpochs?.size ?? 0) > 0) return [];
      }
      return [{ request, ticket }];
    },
  );
  return (
    actionable.find(
      ({ ticket }) =>
        ticket !== undefined && ticket.status !== "completed" && ticket.status !== "cancelled",
    ) ?? actionable[0]
  )?.request;
}

/**
 * Generated assets may explicitly depend on repository files outside their writable root.
 * Those declared support paths are immutable inputs to implementation and repair attempts, so
 * expose them read-only while retaining the asset root as the sole write scope.
 */
export function generatedAssetImplementationReadPaths(
  node: Pick<GraphNode, "id" | "spec">,
  root: string,
): string[] {
  const supportPaths = stringArray(node.spec.support_paths, `${node.id}.spec.support_paths`).map(
    (value, index) => controlScopePath(value, `${node.id} generated asset read path ${index + 1}`),
  );
  return expandPythonPackageReadPaths([
    controlScopePath(root, `${node.id} generated asset read path 0`),
    ...supportPaths,
  ]);
}

export function controlScopePath(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\u0000") ||
    /[*?]/u.test(value)
  ) {
    fail("control_ticket_path", `${label} must be a nonempty literal project path`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    fail("control_ticket_path", `${label} must be project-relative`);
  }
  const segments = normalized.split("/");
  if (segments.includes("..")) fail("control_ticket_path", `${label} may not escape the project`);
  const compact = segments.filter((segment) => segment !== "" && segment !== ".");
  return compact.length === 0 ? "." : compact.join("/");
}

export function completedRecurringAssetEpochs(
  ticket: TicketRecord,
  attempts: Readonly<Record<string, AgentAttemptRecord>>,
): readonly CompletedRecurringAssetEpoch[] {
  if (ticket.steps.length === 0) return [];
  const completedByStep = ticket.steps.map((step) =>
    (step.attemptIds ?? [])
      .map((attemptId) => attempts[attemptId])
      .filter(
        (attempt): attempt is AgentAttemptRecord & { ticketExecutionEpoch: number } =>
          attempt !== undefined &&
          attempt.ticketId === ticket.id &&
          attempt.stepId === step.id &&
          attempt.status === "completed" &&
          typeof attempt.ticketExecutionEpoch === "number" &&
          attempt.terminalSummary !== undefined &&
          attempt.terminalSummary.trim().length > 0 &&
          (attempt.endedAt !== undefined || attempt.terminalAcceptedAt !== undefined),
      ),
  );
  if (completedByStep.some((candidates) => candidates.length === 0)) return [];
  const commonEpochs = completedByStep
    .slice(1)
    .reduce(
      (common, candidates) =>
        new Set(
          [...common].filter((epoch) =>
            candidates.some((candidate) => candidate.ticketExecutionEpoch === epoch),
          ),
        ),
      new Set(completedByStep[0]!.map((attempt) => attempt.ticketExecutionEpoch)),
    );
  return [...commonEpochs].flatMap((executionEpoch) => {
    const completedAt = completedByStep
      .flatMap((candidates) =>
        candidates
          .filter((attempt) => attempt.ticketExecutionEpoch === executionEpoch)
          .flatMap((attempt) => [attempt.endedAt ?? attempt.terminalAcceptedAt!]),
      )
      .sort(compareText)
      .at(-1);
    return completedAt === undefined ? [] : [{ executionEpoch, completedAt }];
  });
}

export interface PlannedAssetRepairRequest {
  readonly proposalTicketId: string;
  readonly requestSha256: Sha256Digest;
  readonly title: string;
}

export function plannedAssetRepairRequestsForNode(
  run: Pick<RunRecord, "tickets">,
  nodeId: string,
): PlannedAssetRepairRequest[] {
  const candidates = Object.values(run.tickets)
    .filter((proposal) => {
      const control = proposal.executionControl;
      const request = control?.proposalRequest;
      if (
        control === undefined ||
        request === undefined ||
        request.fulfillment !== "planned_asset_repair" ||
        (!proposal.targetNodeIds.includes(nodeId) &&
          !sourceOwnedPlannedAssetRepairNodeIds(run, proposal).includes(nodeId)) ||
        control.proposalApprovalSha256 !== undefined ||
        control.proposalDecision !== undefined ||
        (control.proposalDecisionHistory?.length ?? 0) > 0
      ) {
        return false;
      }
      if (pristineHeldProposal(run, proposal)) return true;
      return (
        proposal.status === "cancelled" &&
        proposal.blocker === COMPILER_ROUTED_TO_PLANNED_ASSET_REPAIR &&
        proposal.steps.every((step) => step.status === "skipped" && step.attemptIds.length === 0)
      );
    })
    .sort(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    );
  return candidates.flatMap((proposal) => {
    const request = proposal.executionControl?.proposalRequest;
    return request === undefined
      ? []
      : [
          {
            proposalTicketId: proposal.id,
            requestSha256: request.requestSha256,
            title: proposal.title,
          },
        ];
  });
}

/**
 * A repair request can name the gates that exposed the defect while its exact held source already
 * owns the selected verifier asset. Preserve that bounded source authority instead of requiring
 * the agent to redundantly repeat the asset id in its proposal. Every requested node must still be
 * inside the immutable source ticket's node grant; otherwise this remains a real scope proposal.
 */
function sourceOwnedPlannedAssetRepairNodeIds(
  run: Pick<RunRecord, "tickets">,
  proposal: Readonly<TicketRecord>,
): string[] {
  const request = proposal.executionControl?.proposalRequest;
  const source = request === undefined ? undefined : run.tickets[request.sourceTicketId];
  if (
    source?.operationId !== "asset-resolution.asset.implement-asset" ||
    source.executionControl?.sourceHold?.proposalTicketId !== proposal.id ||
    source.executionControl.sourceHold.requestSha256 !== request?.requestSha256
  )
    return [];
  const sourceAuthorityNodeIds = new Set([
    ...source.targetNodeIds,
    ...(source.readNodeIds ?? []),
    ...(source.writeNodeIds ?? []),
  ]);
  if (proposal.targetNodeIds.some((nodeId) => !sourceAuthorityNodeIds.has(nodeId))) return [];
  return [...new Set(source.targetNodeIds)].sort(compareText);
}

export function pristineHeldProposal(
  run: Pick<RunRecord, "tickets">,
  proposal: Readonly<TicketRecord>,
): boolean {
  const control = proposal.executionControl;
  const request = control?.proposalRequest;
  const source = request === undefined ? undefined : run.tickets[request.sourceTicketId];
  const hold = source?.executionControl?.sourceHold;
  return (
    proposal.status === "proposed" &&
    control !== undefined &&
    request !== undefined &&
    control.proposalApprovalSha256 === undefined &&
    control.proposalDecision === undefined &&
    (control.proposalDecisionHistory?.length ?? 0) === 0 &&
    proposal.targetNodeIds.length > 0 &&
    proposal.steps.every((step) => step.status === "pending" && step.attemptIds.length === 0) &&
    hold?.proposalTicketId === proposal.id &&
    hold.requestSha256 === request.requestSha256
  );
}

export interface ResearchRunContractScopeGraph {
  node(id: string):
    | {
        readonly id: string;
        readonly type: string;
        readonly spec: Readonly<Record<string, unknown>>;
      }
    | undefined;
  edges(): readonly {
    readonly source: string;
    readonly relation: string;
    readonly target: string;
  }[];
}

export interface CompletedRecurringAssetEpoch {
  readonly executionEpoch: number;
  readonly completedAt: string;
}
