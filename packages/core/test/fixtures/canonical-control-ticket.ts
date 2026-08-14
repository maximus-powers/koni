import {
  resolveExecutionPolicyBinding,
  type ExecutionPolicyBinding,
} from "../../src/authority/execution-policy.js";
import {
  createRunActionEffectReceipt,
  prepareRunActionExecution,
} from "../../src/authority/action-execution.js";
import { executeActionPlan } from "../../src/compiler/action-recipes.js";
import {
  compileExecutionSemanticCatalog,
  type CompiledExecutionSemanticCatalog,
} from "../../src/compiler/execution-semantics.js";
import type { CompiledConfiguration } from "../../src/contracts/configuration.js";
import type { DerivedTicketDefinition, DerivedWorkflowStep } from "../../src/contracts/rules.js";
import { canonicalHash, type Sha256Digest } from "../../src/shared/canonical.js";
import { deriveChangeControlPublication } from "../../src/state/change-control.js";
import {
  createCompilerControlTicketAuthority,
  createRunActionSettlement,
  createTerminalSuccessSettlementProof,
  ticketImmutableProjection,
  type RunActionExecutionRecord,
  type RunRecord,
  type TerminalSuccessSettlementProof,
  type TicketExecutionControlRecord,
  type TicketRecord,
  type TicketStatus,
} from "../../src/state/run-record.js";
import { runBehaviorSnapshotFixture } from "./compiled-behavior.js";

const AT = "2026-07-16T00:00:04.000Z";

/**
 * Attach one exact compiler-authored proposal to an otherwise UI-oriented run fixture.
 *
 * Control-center tests intentionally pass their fake RPC bytes through the production
 * `assertRunRecord` reader. Keeping this recipe canonical means presentation coverage cannot
 * silently reintroduce the synthetic, self-hashed proposal records rejected by the authority.
 */
export async function attachCanonicalProposalFixture(
  run: RunRecord,
  input: Readonly<{
    targetNodeId?: string;
    summary?: string;
    reason?: string;
    decisionPolicy?: "operator" | "automatic";
  }> = {},
): Promise<TicketRecord> {
  const catalog = proposalCatalog(input.decisionPolicy);
  run.compiledConfigHash = catalog.configurationSha256;
  run.behavior = runBehaviorSnapshotFixture(run.runTypeId, "canonical-control-ticket");
  const targetNodeId = input.targetNodeId ?? "claim-one";
  const source = ordinarySourceTicket(catalog, targetNodeId);
  run.tickets[source.id] = source;
  const sourceBinding = source.steps[0]!.executionPolicyBinding!;
  const publication = deriveChangeControlPublication(catalog, {
    runId: run.id,
    sourceTicketId: source.id,
    sourceStepId: source.steps[0]!.id,
    sourceOutputSha256: digest("ui-proposal-source-output"),
    sourceBinding,
    targetNodeIds: [targetNodeId],
    summary: input.summary ?? "Revise the storage contract",
    reason: input.reason ?? "Permit encrypted drafts while keeping the public notes API stable.",
  });
  const sourceCompilation = {
    protocol: "koni.assignment-change-control.v1" as const,
    kind: "upstream_request" as const,
    sourceTicketId: source.id,
    sourceStepId: source.steps[0]!.id,
    sourceBindingSha256: sourceBinding.sha256,
    sourceOutputSha256: publication.sourceOutputSha256,
    targetNodeIds: publication.targetNodeIds,
    summary: publication.summary,
    reason: publication.reason,
    publication,
  };
  const sourceProof = await addSuccessAttempt(run, source, canonicalHash(sourceCompilation));
  const sourceHold = {
    proposalTicketId: publication.proposalTicketId,
    requestSha256: publication.requestSha256,
  };
  source.executionControl = { sourceHold };

  const definition = controlDefinition(catalog, {
    id: publication.proposalTicketId,
    title: controlTitle("Change request", publication.summary),
    targetNodeId,
  });
  const control: TicketExecutionControlRecord = {
    changeControlScopeNodeIds: [targetNodeId],
    proposalRequest: {
      requestSha256: publication.requestSha256,
      sourceTicketId: source.id,
      sourceStepId: source.steps[0]!.id,
      sourceOutputSha256: publication.sourceOutputSha256,
    },
  };
  const proposal = ticketFromDefinition(
    catalog,
    definition,
    "proposed",
    `${publication.summary}\n\nReason: ${publication.reason}`,
    control,
  );
  const operation = catalog.operations.proposal!;
  const workflow = catalog.workflows[operation.workflowId!]!;
  control.controlTicketAuthority = createCompilerControlTicketAuthority({
    runId: run.id,
    role: "proposal",
    ticket: proposal,
    operation,
    workflow,
    definition,
    causal: {
      role: "proposal",
      publication,
      sourceTicketProjection: ticketImmutableProjection(source),
      sourceTerminalProof: sourceProof,
      sourceHold,
    },
  });
  run.tickets[proposal.id] = proposal;
  return proposal;
}

function proposalCatalog(
  decisionPolicy: "operator" | "automatic" | undefined,
): CompiledExecutionSemanticCatalog {
  const registries = {
    operations: {
      ordinary: {
        id: "ordinary",
        operation: "ordinary-work",
        stage: "execution",
        workflow: "ordinary-flow",
        change_control: {
          role: "ordinary",
          allow_upstream_requests: true,
          proposal_operation: "propose-change",
        },
      },
      proposal: {
        id: "proposal",
        operation: "propose-change",
        stage: "change-control",
        workflow: "proposal-flow",
        change_control: {
          role: "proposal",
          proposal_step: "prepare",
          application_operations: ["apply-change"],
          ...(decisionPolicy === undefined ? {} : { decision_policy: decisionPolicy }),
        },
      },
      application: {
        id: "application",
        operation: "apply-change",
        stage: "change-control",
        workflow: "application-flow",
        change_control: { role: "application" },
      },
    },
    workflows: {
      "ordinary-flow": workflow("ordinary-flow", "ordinary-work", ["work"]),
      "proposal-flow": workflow("proposal-flow", "propose-change", ["prepare", "review"]),
      "application-flow": workflow("application-flow", "apply-change", ["prepare", "review"]),
    },
    checks: {},
  };
  const material = { registries, edge_types: [] };
  return compileExecutionSemanticCatalog({
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
    edge_types: [],
  } as unknown as CompiledConfiguration);
}

function workflow(id: string, operation: string, steps: readonly string[]) {
  return {
    id,
    version: "1.0.0",
    applies_to: [operation],
    steps: steps.map((step) => ({ id: step, required: true })),
  };
}

function ordinarySourceTicket(
  catalog: CompiledExecutionSemanticCatalog,
  targetNodeId: string,
): TicketRecord {
  return {
    id: "proposal-source",
    operationId: "ordinary",
    title: "Proposal source",
    summary: "Compiler-authenticated source work for the displayed change proposal.",
    status: "blocked",
    executionPolicyBinding: bind(catalog, "ordinary"),
    executionControl: {},
    priority: 0,
    dependencyIds: [],
    targetNodeIds: [targetNodeId],
    readNodeIds: [targetNodeId],
    writeNodeIds: [targetNodeId],
    readPaths: [],
    writePaths: [],
    steps: [
      {
        id: "work",
        title: "Prepare source change",
        personaId: "worker",
        kind: "production",
        dependsOn: [],
        readNodeIds: [targetNodeId],
        writeNodeIds: [targetNodeId],
        readPaths: [],
        writePaths: [],
        validationAction: "compile",
        executionPolicyBinding: bind(catalog, "ordinary", "work"),
        status: "pending",
        attemptIds: [],
        summary: undefined,
        startedAt: undefined,
        completedAt: undefined,
      },
    ],
    worktreePath: undefined,
    branch: undefined,
    blocker: "Awaiting the exact change proposal decision.",
    createdAt: AT,
    updatedAt: AT,
  };
}

async function addSuccessAttempt(
  run: RunRecord,
  ticket: TicketRecord,
  changeControlSha256: Sha256Digest,
): Promise<TerminalSuccessSettlementProof> {
  const attemptId = "attempt-proposal-source";
  const step = ticket.steps[0]!;
  const policyMaterial = {
    protocol: "koni.agent-terminal-policy.v1" as const,
    mode: "legacy_pre_execution_policy" as const,
    acceptedAt: AT,
  };
  const terminalPolicy = { ...policyMaterial, sha256: canonicalHash(policyMaterial) };
  const terminalOutputSha256 = digest("ui-proposal-terminal-output");
  run.attempts[attemptId] = {
    id: attemptId,
    sessionId: `session-${attemptId}`,
    sessionFile: `${run.projectRoot}/.koni/fixtures/${attemptId}.jsonl`,
    ticketId: ticket.id,
    stepId: step.id,
    personaId: step.personaId,
    modelProvider: "fixture",
    modelId: "fixture-model",
    thinkingLevel: "off",
    status: "completed",
    launchSpecHash: digest("ui-proposal-launch"),
    startedAt: AT,
    endedAt: AT,
    terminalSummary: "Prepared exact change request",
    terminalOutputSha256,
    terminalOutputSizeBytes: 32,
    terminalAcceptedAt: AT,
    terminalPolicy,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    kind: "ticket",
  };
  step.status = "completed";
  step.attemptIds = [attemptId];
  step.summary = "Prepared exact change request";
  step.startedAt = AT;
  step.completedAt = AT;
  const semanticResult = {
    kind: "assignment" as const,
    status: "completed" as const,
    summary: "Prepared exact change request",
    changeControlSha256,
  };
  const prepared = prepareRunActionExecution(run, {
    kind: "assignment_validation",
    stageId: run.currentPipelineStageId ?? "orchestrate",
    selector: "compile",
    checkout: "none",
    ticketId: ticket.id,
    ticketState: ticket.status,
    stepId: step.id,
    attemptId,
    at: AT,
  });
  const effects: RunActionExecutionRecord["effects"] = {};
  const journal = await executeActionPlan(prepared.plan, {
    execute: async (input) => {
      const output = { valid: true };
      effects[input.effectKey] = createRunActionEffectReceipt(input, output, AT);
      return output;
    },
  });
  const action: RunActionExecutionRecord = {
    ...structuredClone(prepared),
    journal,
    effects,
    semanticResult,
    updatedAt: AT,
  };
  action.settlement = createRunActionSettlement(
    action,
    "completed",
    "canonical proposal source assignment compiled",
    AT,
  );
  action.settledAt = action.settlement.settledAt;
  run.actionExecutions ??= {};
  run.actionExecutions[action.invocationId] = action;
  const proof = createTerminalSuccessSettlementProof(run, action);
  if (proof === undefined)
    throw new Error("canonical proposal source lacks terminal success proof");
  run.terminalSuccessProofs ??= {};
  run.terminalSuccessProofs[proof.sha256] = proof;
  return proof;
}

function controlDefinition(
  catalog: CompiledExecutionSemanticCatalog,
  input: Readonly<{ id: string; title: string; targetNodeId: string }>,
): DerivedTicketDefinition {
  const operation = catalog.operations.proposal!;
  const workflowDefinition = catalog.workflows[operation.workflowId!]!;
  const steps: DerivedWorkflowStep[] = workflowDefinition.steps.map((semantic, index) => ({
    id: semantic.id,
    kind: index === workflowDefinition.steps.length - 1 ? "review" : "production",
    persona_id: index === workflowDefinition.steps.length - 1 ? "reviewer" : "worker",
    depends_on: index === 0 ? [] : [workflowDefinition.steps[index - 1]!.id],
    required: true,
    read_node_ids: [input.targetNodeId],
    write_node_ids: [],
    read_paths: [],
    write_paths: [],
    expected_outputs: [
      index === workflowDefinition.steps.length - 1 ? "Reviewed request" : "Prepared request",
    ],
    graph_mutation: "forbidden",
    validation_action:
      index === workflowDefinition.steps.length - 1 ? "review-result" : "validate-work",
    required_receipts: [...semantic.requiredReceipts],
    escalation_triggers: [...semantic.escalationTriggers],
    stop_conditions: [...semantic.stopConditions],
    validation_checks: [...semantic.validationChecks],
    context_sha256: digest(`${input.id}-${semantic.id}-context`),
  }));
  const material = {
    protocol: "koni.derived-ticket.v1" as const,
    id: input.id,
    rule_id: "compiler.change-control.proposal",
    rule_phase: operation.stage,
    rule_priority: 0,
    anchor_node_id: input.targetNodeId,
    operation: operation.publicOperation,
    operation_registry_id: operation.id,
    operation_dispatch_priority: 0,
    ranking_hints: [] as string[],
    title: input.title,
    target_node_ids: [input.targetNodeId],
    scope: {
      read_node_ids: [input.targetNodeId],
      write_node_ids: [] as string[],
      read_paths: [] as string[],
      write_paths: [] as string[],
    },
    source_state_key: "ui-proposal-source",
    target_state_key: "ui-proposal-target",
    obligation_keys: [digest("ui-proposal-obligation")],
    workflow_id: workflowDefinition.id,
    review_failure_reopen_from: steps[0]!.id,
    workflow: steps,
    configuration_sha256: catalog.configurationSha256,
  };
  return { ...material, definition_sha256: canonicalHash(material) };
}

function ticketFromDefinition(
  catalog: CompiledExecutionSemanticCatalog,
  definition: DerivedTicketDefinition,
  status: TicketStatus,
  summary: string,
  executionControl: TicketExecutionControlRecord,
): TicketRecord {
  return {
    id: definition.id,
    operationId: definition.operation_registry_id,
    title: definition.title,
    summary,
    status,
    executionPolicyBinding: bind(catalog, definition.operation_registry_id),
    executionControl,
    priority: -(definition.rule_priority * 1_000 + definition.operation_dispatch_priority),
    dependencyIds: [],
    targetNodeIds: [...definition.target_node_ids],
    readNodeIds: [...definition.scope.read_node_ids],
    writeNodeIds: [...definition.scope.write_node_ids],
    readPaths: [...definition.scope.read_paths],
    writePaths: [...definition.scope.write_paths],
    steps: definition.workflow.map((step) => ({
      id: step.id,
      title: stepTitle(step.id),
      personaId: step.persona_id,
      kind: step.kind,
      dependsOn: [...step.depends_on],
      readNodeIds: [...(step.read_node_ids ?? [])],
      writeNodeIds: [...(step.write_node_ids ?? [])],
      readPaths: [...(step.read_paths ?? [])],
      writePaths: [...(step.write_paths ?? [])],
      ...(step.validation_action === undefined ? {} : { validationAction: step.validation_action }),
      executionPolicyBinding: bind(catalog, definition.operation_registry_id, step.id),
      status: "pending",
      attemptIds: [],
      summary: undefined,
      startedAt: undefined,
      completedAt: undefined,
    })),
    ...(definition.review_failure_reopen_from === undefined
      ? {}
      : { reviewFailureReopenFrom: definition.review_failure_reopen_from }),
    reviewReworkLimit: 1,
    reviewReworkCount: 0,
    reviewReworks: [],
    worktreePath: undefined,
    branch: undefined,
    blocker: undefined,
    createdAt: AT,
    updatedAt: AT,
  };
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
    workflowId: operation.workflowId!,
    ...(stepId === undefined ? {} : { stepId }),
  });
}

function controlTitle(prefix: string, summary: string): string {
  return `${prefix}: ${summary.trim().split(/\r?\n/u)[0] ?? summary.trim()}`.slice(0, 240);
}

function stepTitle(value: string): string {
  return value
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function digest(value: string): Sha256Digest {
  return canonicalHash({ value });
}
