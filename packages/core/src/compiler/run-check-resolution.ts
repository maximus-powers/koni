import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  selectComposedReplayChecks,
  type CheckExecutionPolicyBinding,
  type ExecutionPolicyBinding,
} from "../authority/execution-policy.js";
import type { JsonValue } from "../authority/protocol.js";
import type {
  ResolvedAgentCheck,
  ResolvedAgentCheckCommand,
  ResolvedCheckExecutionPolicyBinding,
  ResolvedGateAutoEvaluationContextBinding,
} from "../authority/run-engine.js";
import type {
  CompiledConfiguration,
  ConfigurationObject,
  ConfigurationValue,
} from "../contracts/configuration.js";
import type { DerivedTicketDefinition } from "../contracts/rules.js";
import { type TypedGraph, type GraphNode } from "../graph/model.js";
import { canonicalHash, type Sha256Digest } from "../shared/canonical.js";
import { type RunRecord } from "../state/run-record.js";
import { createProductionRuleDomainAdapter } from "./domain-adapter.js";
import {
  type CompiledExecutionSemanticCatalog,
  type CompiledWorkflowStepSemantics,
} from "./execution-semantics.js";
import { GraphExpressionEvaluator } from "./expressions.js";

import {
  assertPathInScopes,
  compareText,
  deepFreeze,
  dynamicValuePath,
  fail,
  graphNodeField,
  graphNodeRoot,
  isRecord,
  isWithinDirectory,
  normalizeCheckPath,
  optionalRecord,
  optionalSafeInteger,
  optionalString,
  requiredNonempty,
  stringArray,
} from "./run-check-execution.js";
import type {
  AssignmentChangeControlContract,
  AssignmentTerminalPolicyRetainedReceipt,
  AssignmentTerminalPolicySourceCommand,
  AssignmentTerminalPolicySourceManifestPair,
  AssignmentTerminalValidationCheckPolicy,
  AttemptDescriptor,
} from "./run-program-contracts.js";

export interface ResolveConfiguredCheckInput {
  configuration: CompiledConfiguration;
  executionCatalog: CompiledExecutionSemanticCatalog;
  executionPolicyBinding: ExecutionPolicyBinding;
  gatePolicyContexts: readonly ResolvedGateAutoEvaluationContextBinding[];
  graph: TypedGraph;
  descriptor: AttemptDescriptor;
  projectRoot: string;
  requestedCheckId: string;
}

export type SemanticResolvedAgentCheck = ResolvedAgentCheck & {
  executionPolicy: ResolvedCheckExecutionPolicyBinding;
};

export type SemanticResolvedAgentCheckCommand = ResolvedAgentCheckCommand & {
  memberNodeId?: string;
  memberSourcePaths?: readonly string[];
};

export interface CompositeMemberBinding {
  nodeId: string;
  cwd?: string;
  sourcePaths: string[];
  inputPaths: string[];
}

export async function resolveConfiguredAgentCheck(
  input: ResolveConfiguredCheckInput,
): Promise<SemanticResolvedAgentCheck> {
  const adapter = await createProductionRuleDomainAdapter({
    configuration: input.configuration,
    graph: input.graph,
    projectRoot: input.projectRoot,
  });
  const evaluator = new GraphExpressionEvaluator(input.configuration, input.graph, adapter);
  const targetIds = input.descriptor.definition?.target_node_ids ?? input.descriptor.readNodeIds;
  const resolved = await resolveCheckRecursive(
    { ...input, evaluator },
    input.requestedCheckId,
    targetIds,
    [],
    undefined,
  );
  const check = input.executionCatalog.checks[input.requestedCheckId];
  if (check === undefined)
    fail(
      "check_semantics",
      `configured check ${input.requestedCheckId} has no pinned execution semantics`,
    );
  const gatePolicyContexts = input.gatePolicyContexts
    .filter((binding) => binding.checkId === input.requestedCheckId)
    .map((binding) => structuredClone(binding));
  const gateReadPaths = gatePolicyContexts.flatMap((binding) => binding.readPaths);
  const commands = resolved.commands.map((command) => {
    const commandCheck = input.executionCatalog.checks[command.checkId];
    if (commandCheck === undefined) {
      fail(
        "check_semantics",
        `configured command ${command.checkId} has no pinned execution semantics`,
      );
    }
    return {
      ...command,
      // A policy-bound resolved check uses the semantic catalog identity. The complete
      // raw definition remains transitively pinned by configurationSha256; using its
      // older YAML-object hash here would make the runtime policy and receipt disagree.
      definitionHash: commandCheck.sha256,
      inputPaths: [...new Set([...command.inputPaths, ...gateReadPaths])].sort(compareText),
    };
  });
  return deepFreeze({
    protocol: "koni.resolved-agent-check.v1",
    requestedCheckId: input.requestedCheckId,
    definitionHash: check.sha256,
    kind: resolved.kind,
    commands,
    executionPolicy: resolvedCheckExecutionPolicy(input, input.requestedCheckId),
  });
}

export function resolvedCheckExecutionPolicy(
  input: Pick<
    ResolveConfiguredCheckInput,
    "executionCatalog" | "executionPolicyBinding" | "gatePolicyContexts"
  >,
  checkId: string,
): ResolvedCheckExecutionPolicyBinding {
  const check = input.executionCatalog.checks[checkId];
  if (check === undefined)
    fail("check_semantics", `configured check ${checkId} has no pinned execution semantics`);
  return deepFreeze({
    configurationSha256: input.executionCatalog.configurationSha256,
    catalogSha256: input.executionCatalog.sha256,
    bindingSha256: input.executionPolicyBinding.sha256,
    checkId,
    checkSha256: check.sha256,
    effect: check.effect,
    receiptType: check.receiptType,
    receiptFreshness: check.receiptFreshness,
    composedReplay: check.composedReplay,
    retryPolicy: structuredClone(check.retryPolicy),
    gatePolicyContexts: input.gatePolicyContexts
      .filter((binding) => binding.checkId === checkId)
      .map((binding) => structuredClone(binding)),
  });
}

export function terminalStepSemantics(
  catalog: CompiledExecutionSemanticCatalog,
  binding: ExecutionPolicyBinding,
): CompiledWorkflowStepSemantics {
  if (
    binding.configurationSha256 !== catalog.configurationSha256 ||
    binding.catalogSha256 !== catalog.sha256 ||
    binding.workflowId === undefined ||
    binding.workflowSha256 === undefined ||
    binding.stepId === undefined ||
    binding.stepSha256 === undefined
  ) {
    fail(
      "terminal_policy_binding",
      "terminal policy binding does not belong to one pinned workflow step",
    );
  }
  const operation = catalog.operations[binding.operationId];
  const workflow = catalog.workflows[binding.workflowId];
  const step = workflow?.steps.find((candidate) => candidate.id === binding.stepId);
  if (
    operation === undefined ||
    operation.sha256 !== binding.operationSha256 ||
    operation.workflowId !== binding.workflowId ||
    workflow === undefined ||
    workflow.sha256 !== binding.workflowSha256 ||
    workflow.version !== binding.workflowVersion ||
    step === undefined ||
    step.sha256 !== binding.stepSha256
  ) {
    fail(
      "terminal_policy_binding",
      "terminal policy binding differs from the pinned semantic catalog",
    );
  }
  return step;
}

export function assignmentChangeControlContract(
  catalog: CompiledExecutionSemanticCatalog,
  binding: ExecutionPolicyBinding,
  stepId: string,
): AssignmentChangeControlContract {
  terminalStepSemantics(catalog, binding);
  const operation = catalog.operations[binding.operationId];
  if (operation === undefined)
    fail("change_control_operation", `operation ${binding.operationId} is unavailable`);
  const policy = operation.changeControl;
  return {
    role: policy.role,
    allowUpstreamRequest: policy.role === "ordinary" && policy.allowUpstreamRequests,
    requireChangeApplication: policy.role === "proposal" && policy.proposalStep === stepId,
  };
}

export async function resolveTerminalValidationCheckPolicies(input: {
  configuration: CompiledConfiguration;
  catalog: CompiledExecutionSemanticCatalog;
  descriptor: AttemptDescriptor;
  projectRoot: string;
  checkIds: readonly string[];
}): Promise<AssignmentTerminalValidationCheckPolicy[]> {
  if (
    input.descriptor.executionPolicyBinding === undefined ||
    input.descriptor.graph === undefined
  ) {
    fail(
      "terminal_policy_descriptor",
      "terminal validation checks require a graph and step binding",
    );
  }
  const output: AssignmentTerminalValidationCheckPolicy[] = [];
  for (const checkId of input.checkIds) {
    const resolvedCheck = await resolveConfiguredAgentCheck({
      configuration: input.configuration,
      executionCatalog: input.catalog,
      executionPolicyBinding: input.descriptor.executionPolicyBinding,
      gatePolicyContexts: input.descriptor.gatePolicyContexts ?? [],
      graph: input.descriptor.graph,
      descriptor: input.descriptor,
      projectRoot: input.projectRoot,
      requestedCheckId: checkId,
    });
    const semantics = input.catalog.checks[checkId];
    if (semantics === undefined) {
      fail("terminal_policy_check", `terminal validation check ${checkId} has no pinned semantics`);
    }
    const causalResolvedCheckSha256 = canonicalHash(resolvedCheck);
    const leafIds = [...new Set(resolvedCheck.commands.map((command) => command.checkId))].sort(
      compareText,
    );
    const replaySelection = selectComposedReplayChecks(
      input.catalog,
      input.catalog.configurationSha256,
      leafIds,
    );
    const replayIds = new Set(replaySelection.replayCheckIds);
    const replayCommands = resolvedCheck.commands.filter((command) =>
      replayIds.has(command.checkId),
    );
    const retainedLeafPolicies = resolvedCheck.commands.flatMap((command, commandIndex) => {
      if (replayIds.has(command.checkId)) return [];
      if (command.executionPolicy === undefined) {
        fail(
          "terminal_policy_leaf_binding",
          `resolved leaf ${command.checkId} has no exact execution policy`,
        );
      }
      return [
        {
          commandIndex,
          checkId: command.checkId,
          executionPolicy: structuredClone(command.executionPolicy),
        },
      ];
    });
    output.push(
      deepFreeze({
        checkId,
        checkSha256: semantics.sha256,
        receiptType: semantics.receiptType,
        receiptFreshness: semantics.receiptFreshness,
        resolvedCheck: { ...resolvedCheck, commands: replayCommands },
        causalResolvedCheckSha256,
        causalCommands: Object.freeze([...resolvedCheck.commands]),
        retainedLeafPolicies,
        replaySelection,
      }),
    );
  }
  return output;
}

export function retainedTerminalReceipts(
  run: RunRecord,
  ticketId: string,
  policies: readonly AssignmentTerminalValidationCheckPolicy[],
  currentAttemptId: string,
): AssignmentTerminalPolicyRetainedReceipt[] {
  const expected = new Map<string, CheckExecutionPolicyBinding>();
  for (const policy of policies) {
    for (const leaf of policy.retainedLeafPolicies) {
      expected.set(`${leaf.checkId}\0${canonicalHash(leaf.executionPolicy)}`, leaf.executionPolicy);
    }
  }
  const candidates = retainedReceiptsMatching(run, ticketId, expected, undefined, currentAttemptId);
  const checks = new Map((run.checks ?? []).map((check) => [check.id, check]));
  const selected: AssignmentTerminalPolicyRetainedReceipt[] = [];
  for (const key of [...expected.keys()].sort(compareText)) {
    const matches = candidates.filter(
      (candidate) => `${candidate.checkId}\0${canonicalHash(candidate.executionPolicy)}` === key,
    );
    matches.sort((left, right) => {
      const leftCurrent = left.attemptId === currentAttemptId ? 1 : 0;
      const rightCurrent = right.attemptId === currentAttemptId ? 1 : 0;
      if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent;
      const recorded = compareText(
        checks.get(right.runCheckId)?.recordedAt ?? "",
        checks.get(left.runCheckId)?.recordedAt ?? "",
      );
      if (recorded !== 0) return recorded;
      const checkId = compareText(right.runCheckId, left.runCheckId);
      return checkId !== 0 ? checkId : right.commandIndex - left.commandIndex;
    });
    if (matches[0] !== undefined) selected.push(matches[0]);
  }
  return selected;
}

export function retainedReceiptsMatching(
  run: RunRecord,
  ticketId: string,
  expected: ReadonlyMap<string, CheckExecutionPolicyBinding>,
  stepId: string | undefined,
  currentAttemptId?: string,
): AssignmentTerminalPolicyRetainedReceipt[] {
  const output: AssignmentTerminalPolicyRetainedReceipt[] = [];
  for (const check of run.checks ?? []) {
    const attempt = run.attempts[check.attemptId];
    if (
      attempt === undefined ||
      attempt.ticketId !== ticketId ||
      (stepId !== undefined && attempt.stepId !== stepId) ||
      !(
        (check.accepted && check.passed === true) ||
        (check.attemptId === currentAttemptId && check.passed === false)
      )
    )
      continue;
    for (const [commandIndex, command] of check.commands.entries()) {
      if (command.executionPolicy === undefined) continue;
      const key = `${command.checkId}\0${canonicalHash(command.executionPolicy)}`;
      const policy = expected.get(key);
      if (policy === undefined) continue;
      output.push(
        deepFreeze({
          runCheckId: check.id,
          attemptId: check.attemptId,
          stepId: attempt.stepId,
          requestedCheckId: check.requestedCheckId,
          commandIndex,
          checkId: command.checkId,
          executionPolicy: structuredClone(policy),
          accepted: check.accepted,
          passed: check.passed === true,
        }),
      );
    }
  }
  return output.sort((left, right) =>
    compareText(
      `${left.stepId}\0${left.runCheckId}\0${left.commandIndex}`,
      `${right.stepId}\0${right.runCheckId}\0${right.commandIndex}`,
    ),
  );
}

export function terminalRetainedReceiptKey(
  receipt: AssignmentTerminalPolicyRetainedReceipt,
): string {
  return `${receipt.runCheckId}#${receipt.commandIndex}`;
}

export function pairSourceManifestCommands(input: {
  run: RunRecord;
  ticketId: string;
  currentStepId: string;
  sourceStepId: string;
  currentChecks: readonly AssignmentTerminalValidationCheckPolicy[];
  sourceChecks: readonly AssignmentTerminalValidationCheckPolicy[];
}): AssignmentTerminalPolicySourceManifestPair[] {
  const currentCommands = terminalCommandsWithMembers(input.currentChecks, input.currentStepId);
  const sourceCommands = terminalCommandsWithMembers(input.sourceChecks, input.sourceStepId);
  const sourceByMember = new Map<string, AssignmentTerminalPolicySourceCommand[]>();
  for (const command of sourceCommands) {
    const existing = sourceByMember.get(command.memberNodeId) ?? [];
    existing.push(command);
    sourceByMember.set(command.memberNodeId, existing);
  }
  const output: AssignmentTerminalPolicySourceManifestPair[] = [];
  for (const current of currentCommands) {
    const candidates = sourceByMember.get(current.memberNodeId) ?? [];
    if (candidates.length !== 1) {
      fail(
        "terminal_policy_source_pair",
        `source-preservation member ${current.memberNodeId} resolved ${candidates.length} baseline commands`,
      );
    }
    const source = candidates[0]!;
    if (canonicalHash(current.sourcePaths) !== canonicalHash(source.sourcePaths)) {
      fail(
        "terminal_policy_source_paths",
        `source-preservation member ${current.memberNodeId} changed its exact source-path set`,
      );
    }
    const expected = new Map<string, CheckExecutionPolicyBinding>();
    const sourcePolicy = input.sourceChecks
      .flatMap((policy) => policy.causalCommands)
      .find(
        (candidate) =>
          commandBindingSha256(
            candidate as SemanticResolvedAgentCheckCommand,
            input.sourceStepId,
          ) === source.commandBindingSha256,
      )?.executionPolicy;
    if (sourcePolicy === undefined) {
      fail(
        "terminal_policy_source_binding",
        `source command ${source.checkId} has no exact execution policy`,
      );
    }
    expected.set(`${source.checkId}\0${canonicalHash(sourcePolicy)}`, sourcePolicy);
    const retainedSourceReceipts = retainedReceiptsMatching(
      input.run,
      input.ticketId,
      expected,
      input.sourceStepId,
    );
    const material = {
      memberNodeId: current.memberNodeId,
      current,
      source,
      retainedSourceReceipts: Object.freeze(retainedSourceReceipts),
    };
    output.push(deepFreeze({ ...material, sha256: canonicalHash(material) }));
  }
  if (
    sourceCommands.some(
      (source) => !currentCommands.some((current) => current.memberNodeId === source.memberNodeId),
    )
  ) {
    fail(
      "terminal_policy_source_pair",
      "baseline source members differ from current validation members",
    );
  }
  return output.sort((left, right) => compareText(left.memberNodeId, right.memberNodeId));
}

export function terminalCommandsWithMembers(
  policies: readonly AssignmentTerminalValidationCheckPolicy[],
  stepId: string,
): AssignmentTerminalPolicySourceCommand[] {
  const output: AssignmentTerminalPolicySourceCommand[] = [];
  for (const policy of policies) {
    for (const rawCommand of policy.causalCommands) {
      const command = rawCommand as SemanticResolvedAgentCheckCommand;
      if (
        command.memberNodeId === undefined ||
        command.memberSourcePaths === undefined ||
        command.memberSourcePaths.length === 0
      ) {
        fail(
          "terminal_policy_source_member",
          `source-preservation check ${policy.checkId} did not resolve an exact member and source-path set`,
        );
      }
      output.push(
        deepFreeze({
          stepId,
          checkId: command.checkId,
          memberNodeId: command.memberNodeId,
          commandBindingSha256: commandBindingSha256(command, stepId),
          sourcePaths: Object.freeze([...command.memberSourcePaths]),
        }),
      );
    }
  }
  const identities = new Set<string>();
  for (const command of output) {
    if (identities.has(command.memberNodeId)) {
      fail(
        "terminal_policy_source_member",
        `source-preservation member ${command.memberNodeId} has multiple commands`,
      );
    }
    identities.add(command.memberNodeId);
  }
  return output.sort((left, right) => compareText(left.memberNodeId, right.memberNodeId));
}

export function commandBindingSha256(
  command: SemanticResolvedAgentCheckCommand,
  stepId: string,
): Sha256Digest {
  if (
    command.executionPolicy === undefined ||
    command.memberNodeId === undefined ||
    command.memberSourcePaths === undefined
  ) {
    fail(
      "terminal_policy_command_binding",
      `command ${command.checkId} has no exact semantic member binding`,
    );
  }
  return canonicalHash({
    stepId,
    checkId: command.checkId,
    definitionHash: command.definitionHash,
    executionPolicy: command.executionPolicy,
    memberNodeId: command.memberNodeId,
    memberSourcePaths: command.memberSourcePaths,
    argv: command.argv,
    cwd: command.cwd,
    inputPaths: command.inputPaths,
  });
}

export async function resolveCheckRecursive(
  input: ResolveConfiguredCheckInput & { evaluator: GraphExpressionEvaluator },
  checkId: string,
  subjectIds: readonly string[],
  stack: readonly string[],
  member: CompositeMemberBinding | undefined,
): Promise<{
  kind: ResolvedAgentCheck["kind"];
  definitionHash: Sha256Digest;
  commands: ResolvedAgentCheckCommand[];
}> {
  if (stack.includes(checkId))
    fail(
      "check_recursive",
      `configured check recursion is cyclic: ${[...stack, checkId].join(" -> ")}`,
    );
  const definition = input.configuration.registries.checks[checkId];
  if (definition === undefined) fail("check_missing", `configured check ${checkId} does not exist`);
  assertCheckApplies(definition, input.descriptor, checkId);
  const kind = optionalString(definition.kind);
  const definitionHash = canonicalHash(definition);
  if (kind === "graph") return { kind, definitionHash, commands: [] };
  if (kind === "command") {
    return {
      kind,
      definitionHash,
      commands: await resolveCommandCheck(input, checkId, definition, subjectIds, member),
    };
  }
  if (kind !== "composite")
    fail("check_kind", `configured check ${checkId} has unsupported kind ${kind ?? ""}`);
  const set = optionalRecord(definition.graph_set);
  if (set === undefined)
    fail("check_composite", `composite check ${checkId} has no graph_set contract`);
  const selector = set.members;
  if (selector === undefined)
    fail("check_composite", `composite check ${checkId} has no member selector`);
  const selected = input.evaluator.withBinding("target", subjectIds, () =>
    input.evaluator.select(selector),
  );
  const memberTypes = new Set(stringArray(set.member_node_types, `${checkId} member node types`));
  const excluded = new Set(stringArray(set.status_excluding, `${checkId} excluded statuses`));
  const members = selected
    .flatMap((id) => {
      const node = input.graph.node(id);
      if (
        node === undefined ||
        (memberTypes.size > 0 && !memberTypes.has(node.type)) ||
        excluded.has(node.status)
      )
        return [];
      return [node];
    })
    .sort((left, right) => compareText(left.id, right.id));
  const minimum = optionalSafeInteger(set.min_members) ?? 0;
  if (members.length < minimum) {
    fail(
      "check_composite_coverage",
      `composite check ${checkId} selected ${members.length} members, below ${minimum}`,
    );
  }
  const commands: ResolvedAgentCheckCommand[] = [];
  for (const node of members) {
    const configuredChild = optionalString(set.member_check);
    const field = optionalString(set.member_check_field);
    const childId =
      configuredChild ??
      (field === undefined ? undefined : optionalString(graphNodeField(node, field)));
    if (childId === undefined)
      fail(
        "check_composite_member",
        `composite check ${checkId} member ${node.id} has no check id`,
      );
    const sourcePaths = configuredNodePaths(node, optionalString(set.source_paths_field));
    const coveredPaths = configuredNodePaths(node, optionalString(set.covered_paths_field));
    const supportPaths = configuredNodePaths(node, optionalString(set.support_paths_field));
    const workingDirectory = optionalString(set.working_directory_field);
    const cwd =
      workingDirectory === undefined
        ? undefined
        : optionalString(graphNodeField(node, workingDirectory));
    const resolved = await resolveCheckRecursive(input, childId, [node.id], [...stack, checkId], {
      nodeId: node.id,
      ...(cwd === undefined ? {} : { cwd }),
      // Test-support configuration is causal to an honest prepared baseline. Keep its exact
      // bytes in the same preservation manifest as the writable proof source, while retaining
      // a distinct graph field so it never becomes write authority or claimed product coverage.
      sourcePaths: [...new Set([...sourcePaths, ...supportPaths])].sort(compareText),
      inputPaths: [...new Set([...sourcePaths, ...coveredPaths, ...supportPaths])].sort(
        compareText,
      ),
    });
    commands.push(...resolved.commands);
  }
  return { kind, definitionHash, commands };
}

/**
 * Policy-backed commands execute once per compiler-pinned gate context. Ticket targets can be
 * verifier assets or evaluation subjects, so treating descriptor targets as gate ids asks the
 * policy selector to rank the wrong node type. Direct/manual checks without pinned contexts retain
 * the caller's explicit subjects.
 */
export function gatePolicyCommandSubjectIds(
  checkId: string,
  subjectIds: readonly string[],
  contexts: readonly Pick<ResolvedGateAutoEvaluationContextBinding, "checkId" | "gateNodeId">[],
): string[] {
  const pinnedGateIds = contexts
    .filter((binding) => binding.checkId === checkId)
    .map((binding) => binding.gateNodeId);
  return [...new Set(pinnedGateIds.length > 0 ? pinnedGateIds : subjectIds)].sort(compareText);
}

export async function resolveCommandCheck(
  input: ResolveConfiguredCheckInput & { evaluator: GraphExpressionEvaluator },
  checkId: string,
  definition: ConfigurationObject,
  subjectIds: readonly string[],
  member: CompositeMemberBinding | undefined,
): Promise<ResolvedAgentCheckCommand[]> {
  const staticArgv = Array.isArray(definition.argv)
    ? exactArgv(definition.argv, checkId)
    : undefined;
  const source = optionalRecord(definition.command_source);
  if ((staticArgv === undefined) === (source === undefined)) {
    fail(
      "check_command_source",
      `command check ${checkId} must have exactly one static or dynamic command source`,
    );
  }
  const bindings: Array<{
    argv: string[];
    root?: ConfigurationValue;
    variables: Record<string, string>;
  }> = [];
  if (staticArgv !== undefined) {
    bindings.push({ argv: staticArgv, variables: {} });
  } else {
    const sourceKind = optionalString(source!.kind);
    const field = requiredNonempty(source!.field, `${checkId} command source field`);
    if (sourceKind === "node") {
      const allowedTypes = new Set(
        stringArray(source!.node_types, `${checkId} command source node types`),
      );
      const gatePolicy = optionalString(source!.gate_policy);
      if (gatePolicy !== undefined) {
        for (const gateId of gatePolicyCommandSubjectIds(
          checkId,
          subjectIds,
          input.gatePolicyContexts,
        )) {
          const winners = input.evaluator.select({
            policy_selection: { policy: gatePolicy, gate: { ids: [gateId] }, result: "winner" },
          });
          if (winners.length !== 1)
            fail(
              "check_command_source",
              `check ${checkId} gate ${gateId} has no unique policy winner`,
            );
          const winner = input.graph.node(winners[0]!)!;
          if (allowedTypes.size > 0 && !allowedTypes.has(winner.type)) {
            fail(
              "check_command_source",
              `check ${checkId} selected unauthorized ${winner.type} command node ${winner.id}`,
            );
          }
          const variables = {
            "gate.id": gateId,
            "target.id": gateId,
            [`${optionalString(source!.role) ?? winner.type}.id`]: winner.id,
            [`${winner.type}.id`]: winner.id,
          };
          bindings.push({
            argv: exactArgv(
              dynamicValuePath(graphNodeRoot(winner), field, variables),
              checkId,
              `${winner.id}.${field} (gate.id=${gateId})`,
            ),
            root: winner.spec,
            variables,
          });
        }
      } else {
        const candidates = [...new Set(subjectIds)]
          .flatMap((id) => {
            const node = input.graph.node(id);
            return node !== undefined && (allowedTypes.size === 0 || allowedTypes.has(node.type))
              ? [node]
              : [];
          })
          .sort((left, right) => compareText(left.id, right.id));
        if (candidates.length !== 1) {
          fail(
            "check_command_source",
            `check ${checkId} resolved ${candidates.length} target command nodes, expected exactly one`,
          );
        }
        const candidate = candidates[0]!;
        const variables = {
          "target.id": candidate.id,
          [`${optionalString(source!.role) ?? candidate.type}.id`]: candidate.id,
          [`${candidate.type}.id`]: candidate.id,
        };
        bindings.push({
          argv: exactArgv(
            dynamicValuePath(graphNodeRoot(candidate), field, variables),
            checkId,
            `${candidate.id}.${field}`,
          ),
          root: candidate.spec,
          variables,
        });
      }
    } else if (sourceKind === "ticket") {
      const candidates = [...new Set(subjectIds)]
        .flatMap((id) => {
          const node = input.graph.node(id);
          return node === undefined ? [] : [node];
        })
        .sort((left, right) => compareText(left.id, right.id));
      if (candidates.length !== 1) {
        fail(
          "check_command_source",
          `check ${checkId} resolved ${candidates.length} ticket command nodes, expected exactly one`,
        );
      }
      const target = candidates[0]!;
      const variables = { "target.id": target.id, "ticket.id": input.descriptor.ticketId };
      bindings.push({
        argv: exactArgv(dynamicValuePath(target.spec, field, variables), checkId),
        root: target.spec,
        variables,
      });
    } else {
      fail(
        "check_command_source",
        `check ${checkId} has unsupported dynamic source kind ${sourceKind ?? ""}`,
      );
    }
  }
  const effect = optionalString(definition.effect) ?? "read_only";
  if (effect !== "read_only" && effect !== "workspace_write")
    fail("check_effect", `check ${checkId} has unsupported effect ${effect}`);
  const timeoutSeconds = optionalSafeInteger(definition.timeout_seconds);
  if (timeoutSeconds === undefined || timeoutSeconds < 1 || timeoutSeconds > 86_400) {
    fail("check_timeout", `check ${checkId} timeout must be between 1 and 86400 seconds`);
  }
  const environment = optionalRecord(definition.environment) ?? {};
  const inherit = stringArray(environment.inherit, `${checkId} inherited environment`);
  const set = optionalRecord(environment.set) ?? {};
  const environmentSet: Record<string, string> = {};
  for (const [name, value] of Object.entries(set).sort(([left], [right]) =>
    compareText(left, right),
  )) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      typeof value !== "string" ||
      value.includes("\u0000")
    ) {
      fail("check_environment", `check ${checkId} has an invalid fixed environment entry`);
    }
    environmentSet[name] = value;
  }
  const expectedExitCodes = stringOrNumberArray(definition.expected_exit_codes, [0], checkId);
  const cwd = normalizeCheckPath(
    member?.cwd ?? optionalString(definition.cwd) ?? ".",
    `${checkId} cwd`,
  );
  return Promise.all(
    bindings.map(async (binding) => {
      const boundInputPaths = await resolveCheckInputBindings(
        definition,
        binding.root,
        binding.argv,
        checkId,
        input.projectRoot,
        standaloneSupportRunAllowsEmptyScientificInputs(
          input.descriptor.definition,
          optionalString(optionalRecord(definition.argv_input_bindings)?.from) ?? "",
          binding.root === undefined
            ? undefined
            : dynamicValuePath(
                binding.root,
                optionalString(optionalRecord(definition.argv_input_bindings)?.from) ?? "",
                {},
              ),
        ),
      );
      const inputPaths = [...new Set([...(member?.inputPaths ?? []), ...boundInputPaths])]
        .map((value) => normalizeCheckPath(value, `${checkId} input path`))
        .sort(compareText);
      // A proof check reads not only the ticket-owned production seams (the attempt's covered read
      // grant) but also its declared support files — the test files it runs, the vitest/tsconfig
      // config, and the package manifest `pnpm exec vitest` needs to resolve. The compiler already
      // lists those support files in the check's source manifest and the ticket's runtime read grant,
      // so they are readable at run time; validating check inputs against the narrow per-step covered
      // scope alone rejected every support file as "outside path scope" and deadlocked every
      // implementation proof (observed live across both Sonnet and Opus planners). Validate against the
      // union of the granted read scope and the check's own declared source/support paths; other
      // inputs still stay bounded to the attempt's read grant.
      const checkReadScope = [...input.descriptor.readPaths, ...(member?.sourcePaths ?? [])];
      for (const value of inputPaths)
        assertPathInScopes(value, checkReadScope, `${checkId} input path`);
      const dynamicResult = optionalRecord(definition.dynamic_result);
      const resultPath = resolveDynamicResultPath(
        dynamicResult,
        binding.root,
        binding.variables,
        checkId,
      );
      if (resultPath !== undefined)
        assertPathInScopes(resultPath, input.descriptor.writePaths, `${checkId} result path`);
      const outputPaths =
        effect === "workspace_write"
          ? [...new Set(input.descriptor.writePaths)].sort(compareText)
          : [];
      const artifactDefinition = optionalRecord(dynamicResult?.artifacts);
      const outputArtifactSelector =
        artifactDefinition === undefined
          ? undefined
          : {
              field: requiredNonempty(artifactDefinition.field, `${checkId} artifact field`),
              allowPathStrings: artifactDefinition.allow_path_strings === true,
              pathField: optionalString(artifactDefinition.path_field) ?? "path",
            };
      return {
        checkId,
        definitionHash: canonicalHash(definition),
        executionPolicy: resolvedCheckExecutionPolicy(input, checkId),
        ...(member === undefined
          ? {}
          : {
              memberNodeId: member.nodeId,
              memberSourcePaths: Object.freeze([...member.sourcePaths]),
            }),
        argv: binding.argv,
        cwd,
        timeoutMs: timeoutSeconds * 1_000,
        effect,
        networkAccess: definition.network_access === true,
        environment: { inherit, set: environmentSet },
        expectedExitCodes,
        allowNonpassingReceipt: definition.allow_nonpassing_receipt === true,
        receiptType: requiredNonempty(definition.receipt_type, `${checkId} receipt type`),
        ...(optionalString(definition.result_protocol) === undefined
          ? {}
          : { resultProtocol: optionalString(definition.result_protocol)! }),
        requiredResultFields: stringArray(
          definition.required_result_fields,
          `${checkId} required result fields`,
        ),
        ...(definition.result_schema === undefined
          ? {}
          : { resultSchema: structuredClone(definition.result_schema) as JsonValue }),
        resultSource:
          resultPath === undefined
            ? { kind: "stdout" as const }
            : { kind: "file" as const, path: resultPath },
        ...(outputArtifactSelector === undefined ? {} : { outputArtifactSelector }),
        inputPaths,
        outputPaths,
      };
    }),
  );
}

export function assertCheckApplies(
  definition: ConfigurationObject,
  descriptor: AttemptDescriptor,
  checkId: string,
): void {
  const applies = stringArray(definition.applies_to, `${checkId} applies_to`);
  const operation = descriptor.definition?.operation;
  if (operation !== undefined && applies.length > 0 && !applies.includes(operation)) {
    fail("check_operation", `check ${checkId} does not apply to operation ${operation}`);
  }
}

export function configuredNodePaths(node: GraphNode, field: string | undefined): string[] {
  if (field === undefined) return [];
  const value = graphNodeField(node, field);
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  if (values.some((item) => typeof item !== "string"))
    fail("check_composite_path", `${node.id}.${field} contains a non-string path`);
  return (values as string[]).map((item) => normalizeCheckPath(item, `${node.id}.${field}`));
}

export function exactArgv(value: unknown, checkId: string, source?: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.trim().length === 0 ||
        item.includes("\u0000") ||
        item.includes("\n") ||
        item.includes("\r"),
    )
  ) {
    // A node-sourced command resolves through a per-gate contract map, so the usual failure is an
    // absent entry for one gate rather than a malformed array. Naming the node, the resolved path,
    // and what was actually found is the difference between a fixable report and a hunt.
    const found = value === undefined ? "no value" : String(JSON.stringify(value)).slice(0, 120);
    // When the value *is* a nonempty array, "must be one exact nonempty argv array" describes it
    // accurately and explains nothing: the violation is inside one element. Observed live on a
    // `python3 -c` inline script whose source carried newlines, where the message sent the author
    // looking for a missing or malformed array that was neither.
    const offending = Array.isArray(value)
      ? value.findIndex(
          (item) =>
            typeof item !== "string" ||
            item.trim().length === 0 ||
            item.includes("\u0000") ||
            item.includes("\n") ||
            item.includes("\r"),
        )
      : -1;
    fail(
      "check_argv",
      offending >= 0
        ? `check ${checkId} argv element ${offending} is not a usable argument: it must be a nonempty single-line string with no NUL, newline, or carriage return. An inline script passed with -c cannot be an argv element; put it in a repository file and pass that path instead${
            source === undefined ? "" : ` (resolved ${source})`
          }`
        : `check ${checkId} command must be one exact nonempty argv array${
            source === undefined ? "" : `; resolved ${source} to ${found}`
          }`,
    );
  }
  const argv = value as string[];
  if (/\s/u.test(argv[0]!))
    fail("check_argv", `check ${checkId} executable argv element may not contain whitespace`);
  if (argv.length > 4_096 || argv.some((item) => Buffer.byteLength(item, "utf8") > 1024 * 1024)) {
    fail("check_argv", `check ${checkId} argv exceeds its compiler bound`);
  }
  return [...argv];
}

export function stringOrNumberArray(value: unknown, fallback: number[], checkId: string): number[] {
  if (value === undefined) return fallback;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (item) => !Number.isSafeInteger(item) || (item as number) < 0 || (item as number) > 255,
    )
  ) {
    fail("check_exit_codes", `check ${checkId} expected exit codes are invalid`);
  }
  return [...new Set(value as number[])].sort((left, right) => left - right);
}

export async function resolveCheckInputBindings(
  definition: ConfigurationObject,
  root: ConfigurationValue | undefined,
  argv: readonly string[],
  checkId: string,
  projectRoot: string,
  allowExplicitEmpty = false,
): Promise<string[]> {
  const configured = optionalRecord(definition.argv_input_bindings);
  if (configured === undefined) return [];
  if (root === undefined)
    fail("check_input_binding", `check ${checkId} has no dynamic root for argv input bindings`);
  const from = requiredNonempty(configured.from, `${checkId} argv input source`);
  const rows = dynamicValuePath(root, from, {});
  if (
    !Array.isArray(rows) ||
    (configured.require_nonempty === true && rows.length === 0 && !allowExplicitEmpty)
  ) {
    fail(
      "check_input_binding",
      `check ${checkId} argv input source is not a permitted nonempty list`,
    );
  }
  const pathField = optionalString(configured.path_field) ?? "path";
  const requiredFields = stringArray(
    configured.required_fields,
    `${checkId} required input fields`,
  );
  const paths: string[] = [];
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row))
      fail("check_input_binding", `check ${checkId} input binding ${index} is not an object`);
    for (const field of requiredFields)
      if (row[field] === undefined) {
        fail("check_input_binding", `check ${checkId} input binding ${index} is missing ${field}`);
      }
    const value = requiredNonempty(row[pathField], `${checkId} input binding path`);
    const normalized = normalizeCheckPath(value, `${checkId} input binding path`);
    if (
      configured.require_exact_argument === true &&
      !argv.includes(normalized) &&
      !argv.includes(value)
    ) {
      // Distinguish "the argv does not contain this path" from "there is no argv". Both reach here,
      // but only the first is a quoting or `--flag=value` problem; the second is an incomplete
      // runtime contract, and reporting it as an argv-element mismatch sends the author looking for
      // a formatting error in an array that does not exist. Observed live on a `run` node whose
      // contract declared scientific_inputs with `argv: null`.
      fail(
        "check_input_binding",
        argv.length === 0
          ? `check ${checkId} declares input path ${normalized} but its runtime contract has no argv; author the exact argv that consumes this input`
          : `check ${checkId} input path ${normalized} is not an exact argv element (argv: ${argv
              .map((element) => JSON.stringify(element))
              .join(" ")}); pass the path as its own element rather than inside --flag=value`,
      );
    }
    if (configured.require_project_file === true) {
      await assertExistingProjectFile(projectRoot, normalized, checkId);
    }
    paths.push(normalized);
  }
  return paths;
}

/**
 * Historical research profiles require at least one scientific input for ordinary experiment
 * runs. A compiler-authored standalone support run may instead be a deterministic zero-input
 * generator whose sole purpose is to materialize a prerequisite artifact. Preserve the profile's
 * fail-closed rule everywhere else and relax it only for an explicit empty scientific-input list
 * on that exact compatibility ticket.
 */
export function standaloneSupportRunAllowsEmptyScientificInputs(
  definition: Pick<DerivedTicketDefinition, "rule_id"> | undefined,
  source: string,
  value: unknown,
): boolean {
  return (
    definition?.rule_id === "compiler.compatibility.research-standalone-support-run" &&
    source === "runtime_contract.scientific_inputs" &&
    Array.isArray(value) &&
    value.length === 0
  );
}

export async function assertExistingProjectFile(
  projectRoot: string,
  relativePath: string,
  checkId: string,
): Promise<void> {
  let canonicalRoot: string;
  let canonicalFile: string;
  try {
    canonicalRoot = await realpath(projectRoot);
    canonicalFile = await realpath(path.join(canonicalRoot, relativePath));
  } catch {
    fail(
      "check_input_binding",
      `check ${checkId} input path ${relativePath} does not exist as a project file`,
    );
  }
  if (!isWithinDirectory(canonicalRoot!, canonicalFile!)) {
    fail(
      "check_input_binding",
      `check ${checkId} input path ${relativePath} escapes the project root`,
    );
  }
  let metadata;
  try {
    metadata = await lstat(canonicalFile!);
  } catch {
    fail(
      "check_input_binding",
      `check ${checkId} input path ${relativePath} does not exist as a project file`,
    );
  }
  if (!metadata.isFile()) {
    fail(
      "check_input_binding",
      `check ${checkId} input path ${relativePath} is not a project file`,
    );
  }
}

export function resolveDynamicResultPath(
  dynamicResult: ConfigurationObject | undefined,
  root: ConfigurationValue | undefined,
  variables: Readonly<Record<string, string>>,
  checkId: string,
): string | undefined {
  const source = optionalRecord(dynamicResult?.result_path);
  if (source === undefined) return undefined;
  if (root === undefined)
    fail("check_result_path", `check ${checkId} has no dynamic root for its result path`);
  const field = requiredNonempty(source.field, `${checkId} result path field`);
  const value = dynamicValuePath(root, field, variables);
  if (value === undefined || value === null) return undefined;
  return normalizeCheckPath(
    requiredNonempty(value, `${checkId} result path`),
    `${checkId} result path`,
  );
}
