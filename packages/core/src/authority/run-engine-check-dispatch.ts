import path from "node:path";
import { type AgentLaunchSpec } from "../pi/launch-spec.js";
import {
  KONI_TOOL_RECEIPT_PROTOCOL,
  validateKoniToolReceipt,
  type KoniToolInvocation,
  type KoniToolReceipt,
} from "../pi/tool-catalog.js";
import {
  canonicalEncode,
  canonicalHash,
  isSha256Digest,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import {
  assertCheckExecutionPolicyBinding,
  assertExecutionPolicyBindingIntegrity,
  type CheckExecutionPolicyBinding,
  type ExecutionPolicyBinding,
  type ExecutionPolicyReceiptEvidence,
} from "./execution-policy.js";
import type { AuthorityGrant } from "./grants.js";
import { WorktreePathAuthority } from "./path-policy.js";
import { snapshotContainedPaths, type ContainedPathManifest } from "./process-runner.js";
import type { JsonValue } from "./protocol.js";
import { errorMessage, isRecord, toolString } from "./run-engine-shared.js";
import { AuthorityRpcError } from "./server.js";

import type {
  AgentAttemptRecord,
  PendingCheckIntentRecord,
  RunActionExecutionRecord,
  RunCheckAttemptRecord,
  RunCheckSourceManifestRecord,
  RunRecord,
  TicketRecord,
  WorkspaceEffectIntentRecord,
} from "../state/run-record.js";
import { type ReadyAssignment } from "../state/scheduler.js";

import {
  DEFAULT_PROVIDER_REQUEST_LIVENESS_TIMEOUT_MS,
  type AgentCheckExecution,
  type AssignmentCompilation,
  type CompilerTerminalReceiptAuthority,
  type PreparedManagedAttempt,
  type ResolvedAgentCheck,
  type ResolvedAgentCheckCommand,
  type RuntimeAssignmentTerminalPolicyProjection,
  type RuntimeAssignmentTerminalReplayCompilation,
} from "./run-engine-contracts.js";

export function configuredCheckIntentId(grant: AuthorityGrant, callId: string): string {
  return `check-${rawSha256(`${grant.grantId}\0${grant.epoch}\0${grant.generation}\0${callId}`).slice(7, 39)}`;
}

export function samePendingCheckIdentity(
  left: PendingCheckIntentRecord,
  right: PendingCheckIntentRecord,
): boolean {
  const { attempts: _leftAttempts, ...leftIdentity } = left;
  const { attempts: _rightAttempts, ...rightIdentity } = right;
  return canonicalHash(leftIdentity) === canonicalHash(rightIdentity);
}

export function configuredCheckStreamPath(
  runId: string,
  attemptId: string,
  callId: string,
  index: number,
  attemptNumber: number,
  stream: "stdout" | "stderr",
): string {
  return `runs/${runId}/attempts/${attemptId}/checks/${rawSha256(callId).slice(7)}/${String(index).padStart(4, "0")}-${String(attemptNumber).padStart(2, "0")}-${stream}.bin`;
}

export function configuredCheckEvidencePath(
  runId: string,
  attemptId: string,
  callId: string,
): string {
  return `runs/${runId}/attempts/${attemptId}/checks/${rawSha256(callId).slice(7)}/evidence.json`;
}

export function configuredTerminalReplayStreamPath(
  runId: string,
  attemptId: string,
  projectionSha256: Sha256Digest,
  checkIndex: number,
  commandIndex: number,
  attemptNumber: number,
  stream: "stdout" | "stderr",
): string {
  return `runs/${runId}/attempts/${attemptId}/terminal-policy/${projectionSha256.slice(7, 23)}/${String(checkIndex).padStart(3, "0")}-${String(commandIndex).padStart(3, "0")}-${String(attemptNumber).padStart(2, "0")}-${stream}.bin`;
}

export function terminalPolicyEvidencePath(
  runId: string,
  attemptId: string,
  terminalPolicySha256: Sha256Digest,
): string {
  return `runs/${runId}/attempts/${attemptId}/terminal-policy/${terminalPolicySha256.slice(7)}.json`;
}

export function assertTerminalPolicyProjectionSafety(
  projection: RuntimeAssignmentTerminalPolicyProjection,
  binding: ExecutionPolicyBinding,
  grant: AuthorityGrant,
): void {
  const { sha256, ...material } = projection;
  if (
    projection.protocol !== "koni.assignment-terminal-policy.v1" ||
    !isSha256Digest(sha256) ||
    canonicalHash(material) !== sha256 ||
    projection.configurationSha256 !== binding.configurationSha256 ||
    projection.catalogSha256 !== binding.catalogSha256 ||
    canonicalHash(projection.executionPolicyBinding) !== canonicalHash(binding)
  ) {
    throw new AuthorityRpcError(
      "terminal_policy_projection",
      "compiler returned a stale terminal-policy projection",
    );
  }
  const configured = grant.configuredChecks;
  const hasProjectedConfiguredCheckWork =
    projection.validationCheckIds.length > 0 ||
    projection.validationChecks.length > 0 ||
    projection.composedReplayCheckIds.length > 0;
  if (
    (configured === undefined && hasProjectedConfiguredCheckWork) ||
    (configured !== undefined &&
      (new Set(projection.validationCheckIds).size !== projection.validationCheckIds.length ||
        projection.validationCheckIds.some((checkId) => !configured.ids.includes(checkId))))
  ) {
    throw new AuthorityRpcError(
      "terminal_policy_scope",
      "terminal validation checks exceed the immutable configured-check grant",
    );
  }
  const replayIds = new Set<string>();
  for (const validation of projection.validationChecks) {
    const selected = new Set(validation.replaySelection.replayCheckIds);
    for (const command of validation.resolvedCheck.commands) {
      if (!selected.has(command.checkId) || command.executionPolicy === undefined) {
        throw new AuthorityRpcError(
          "terminal_replay_selection",
          `terminal replay includes compiler-unselected leaf ${command.checkId}`,
        );
      }
      assertCheckPolicyMatchesBinding(command.executionPolicy, command.checkId, binding);
      if (
        command.executionPolicy.effect !== "read_only" ||
        command.executionPolicy.receiptFreshness !== "current" ||
        command.executionPolicy.composedReplay !== "required" ||
        command.effect !== "read_only" ||
        command.networkAccess ||
        configured === undefined ||
        command.timeoutMs > configured.maxTimeoutMs
      ) {
        throw new AuthorityRpcError(
          "terminal_replay_unsafe",
          `terminal replay leaf ${command.checkId} is not current, opted-in, contained, and read-only`,
        );
      }
      replayIds.add(command.checkId);
    }
  }
  if (
    canonicalHash([...replayIds].sort()) !== canonicalHash([...projection.composedReplayCheckIds])
  ) {
    throw new AuthorityRpcError(
      "terminal_replay_selection",
      "terminal replay closure differs from helper selection",
    );
  }
}

export function terminalReceiptEvidence(
  run: Readonly<RunRecord>,
  attempt: Readonly<AgentAttemptRecord>,
  projection: RuntimeAssignmentTerminalPolicyProjection,
  replay: RuntimeAssignmentTerminalReplayCompilation,
  compilerReceipts: readonly CompilerTerminalReceiptAuthority[] = [],
): ExecutionPolicyReceiptEvidence[] {
  const binding = projection.executionPolicyBinding;
  const evidence: ExecutionPolicyReceiptEvidence[] = [];
  for (const authority of compilerReceipts) {
    assertCompilerTerminalReceiptAuthority(authority, projection);
    evidence.push(structuredClone(authority.receipt));
  }
  for (const policy of projection.validationChecks) {
    const result = replay.checks.find((candidate) => candidate.checkId === policy.checkId);
    if (result === undefined) continue;
    const retainedForPolicy = projection.retainedReceipts.filter((receipt) =>
      policy.retainedLeafPolicies.some(
        (leaf) =>
          leaf.checkId === receipt.checkId &&
          canonicalHash(leaf.executionPolicy) === canonicalHash(receipt.executionPolicy),
      ),
    );
    const current =
      result.replayedLeafCheckIds.length > 0 ||
      (retainedForPolicy.length > 0 &&
        retainedForPolicy.every((receipt) => receipt.attemptId === attempt.id));
    evidence.push({
      receiptId: `terminal-replay:${projection.sha256}:${policy.checkId}`,
      receiptType: policy.receiptType,
      checkId: policy.checkId,
      checkSha256: policy.checkSha256,
      freshness: policy.receiptFreshness,
      // Same flag-aware rule as `terminalSatisfied`: for a command check `accepted` already honours
      // `allow_nonpassing_receipt`, and for a graph check only `passed` is meaningful. A receipt
      // attests that the gate was evaluated and produced a contract-valid verdict; the verdict
      // itself lives in the payload, so an `expected_red` gate yields a valid receipt carrying
      // `verdict: failed`. Marking that receipt "failed" left the closure short of its required
      // `gate.receipt`, which is the third and last place this flag was inert.
      status: (result.kind === "graph" ? result.passed : result.accepted) ? "passed" : "failed",
      configurationSha256: projection.configurationSha256,
      catalogSha256: projection.catalogSha256,
      operationId: binding.operationId,
      ...(binding.workflowId === undefined ? {} : { workflowId: binding.workflowId }),
      stepId: binding.stepId!,
      bindingSha256: binding.sha256,
      integrityValid: replay.projectionSha256 === projection.sha256,
      current,
      historicalEvidenceValid: policy.receiptFreshness === "historical" && result.passed,
      linkedToCurrentOutput: current,
    });
  }
  for (const check of run.checks ?? []) {
    const policy = check.executionPolicy;
    if (
      policy === undefined ||
      policy.bindingSha256 !== binding.sha256 ||
      policy.configurationSha256 !== projection.configurationSha256 ||
      policy.catalogSha256 !== projection.catalogSha256
    )
      continue;
    const retained = projection.retainedReceipts.some((receipt) => receipt.runCheckId === check.id);
    evidence.push({
      receiptId: check.id,
      receiptType: policy.receiptType,
      checkId: policy.checkId,
      checkSha256: policy.checkSha256,
      freshness: policy.receiptFreshness,
      status: check.accepted && check.passed === true ? "passed" : "failed",
      configurationSha256: policy.configurationSha256,
      catalogSha256: policy.catalogSha256,
      operationId: binding.operationId,
      ...(binding.workflowId === undefined ? {} : { workflowId: binding.workflowId }),
      stepId: binding.stepId!,
      bindingSha256: binding.sha256,
      integrityValid: true,
      current: check.attemptId === attempt.id,
      historicalEvidenceValid: retained,
      linkedToCurrentOutput: check.attemptId === attempt.id,
    });
  }
  return evidence;
}

export function createLaunchContextTerminalReceipt(
  run: Readonly<RunRecord>,
  attempt: Readonly<AgentAttemptRecord>,
  assignment: Readonly<ReadyAssignment>,
  prepared: Readonly<PreparedManagedAttempt>,
  grant: Readonly<AuthorityGrant>,
  projection: RuntimeAssignmentTerminalPolicyProjection,
): CompilerTerminalReceiptAuthority | undefined {
  const spec = prepared.spec;
  if (
    spec.specHash !== attempt.launchSpecHash ||
    spec.identity.runId !== run.id ||
    spec.identity.ticketId !== assignment.ticketId ||
    spec.identity.stepId !== assignment.stepId ||
    spec.identity.attemptId !== attempt.id ||
    spec.identity.sessionId !== attempt.sessionId ||
    canonicalHash(grant) !== spec.authority.grantHash ||
    grant.grantId !== spec.authority.grantId ||
    grant.runId !== run.id ||
    grant.ticketId !== assignment.ticketId ||
    grant.stepId !== assignment.stepId ||
    grant.attemptId !== attempt.id ||
    grant.sessionId !== attempt.sessionId ||
    grant.generation !== run.generation ||
    grant.generation !== spec.authority.generation ||
    grant.epoch !== spec.authority.epoch
  ) {
    throw new AuthorityRpcError(
      "terminal_context_binding",
      "terminal context receipt differs from the immutable launch specification or authority grant",
    );
  }
  // Imported compatibility attempts may not retain the original context bytes. They cannot
  // manufacture a current context-pack receipt; the ordinary required-receipt evaluator will
  // fail closed if their pinned workflow requires one.
  if (prepared.contextContent === undefined) return undefined;
  const contextSha256 = rawSha256(prepared.contextContent);
  if (contextSha256 !== spec.authority.authoritativeContextHash) {
    throw new AuthorityRpcError(
      "terminal_context_hash",
      "terminal context bytes differ from the immutable authoritative context hash",
    );
  }
  return createCompilerTerminalReceipt("launch_context", "context-pack", projection, {
    protocol: "koni.terminal-context-pack-provenance.v1",
    runId: run.id,
    ticketId: assignment.ticketId,
    stepId: assignment.stepId,
    attemptId: attempt.id,
    sessionId: attempt.sessionId,
    launchSpecSha256: spec.specHash,
    grantId: grant.grantId,
    grantSha256: spec.authority.grantHash,
    authoritativeContextSha256: spec.authority.authoritativeContextHash,
    contextBytesSha256: contextSha256,
    generation: run.generation,
    authorityEpoch: grant.epoch,
    authorityExpectedRevision: grant.expectedRevision,
    authorityExpectedStateSha256: grant.expectedStateHash,
    projectionSha256: projection.sha256,
    bindingSha256: projection.executionPolicyBinding.sha256,
  });
}

export function createConfiguredActionTerminalReceipts(
  run: Readonly<RunRecord>,
  attempt: Readonly<AgentAttemptRecord>,
  assignment: Readonly<ReadyAssignment>,
  action: Readonly<RunActionExecutionRecord>,
  projection: RuntimeAssignmentTerminalPolicyProjection,
): CompilerTerminalReceiptAuthority[] {
  if (
    action.boundary.kind !== "assignment_validation" ||
    action.boundary.runId !== run.id ||
    action.boundary.ticketId !== assignment.ticketId ||
    action.boundary.stepId !== assignment.stepId ||
    action.boundary.attemptId !== attempt.id ||
    action.journal.status !== "completed" ||
    action.semanticResult?.kind !== "assignment" ||
    attempt.terminalOutputSha256 === undefined
  ) {
    throw new AuthorityRpcError(
      "terminal_compiler_action",
      "terminal compiler receipt requires the completed exact assignment-validation action",
    );
  }
  const ticket = run.tickets[assignment.ticketId];
  const expectedProductSha256 = canonicalHash({
    terminalOutputSha256: attempt.terminalOutputSha256,
    launchSpecHash: attempt.launchSpecHash,
    ticketId: assignment.ticketId,
    stepId: assignment.stepId,
    cycleId: ticket?.gitCycleId ?? null,
  });
  if (action.boundary.productSha256 !== expectedProductSha256) {
    throw new AuthorityRpcError(
      "terminal_compiler_product",
      "assignment-validation action is not bound to the accepted terminal output",
    );
  }
  const recipe = action.plan.recipe;
  const emitsScopedCompile =
    recipe.some(
      (step) => step.primitive === "rules.evaluate" && step.arguments.mode === "scoped",
    ) ||
    recipe.some(
      (step) =>
        step.primitive === "event.append" && step.arguments.type === "compiler.compile.scoped",
    );
  const emitsReviewReceipt =
    recipe.some((step) => step.primitive === "review.validate") &&
    recipe.some((step) => step.primitive === "review.record");
  const common: JsonValue = {
    protocol: "koni.terminal-configured-action-provenance.v1",
    runId: run.id,
    ticketId: assignment.ticketId,
    stepId: assignment.stepId,
    attemptId: attempt.id,
    terminalOutputSha256: attempt.terminalOutputSha256,
    launchSpecSha256: attempt.launchSpecHash,
    actionInvocationId: action.invocationId,
    actionBoundarySha256: action.boundary.sha256,
    actionProductSha256: action.boundary.productSha256,
    actionPlanSha256: action.plan.sha256,
    actionJournalSha256: action.journal.sha256,
    actionSemanticResultSha256: canonicalHash(action.semanticResult),
    actionEffectsSha256: canonicalHash(action.effects),
    graphHash: run.graphHash ?? null,
    graphRevision: run.graphRevision ?? null,
    ticketProjectionSha256: ticket === undefined ? null : canonicalHash(ticket),
    projectionSha256: projection.sha256,
    bindingSha256: projection.executionPolicyBinding.sha256,
  };
  const receipts: CompilerTerminalReceiptAuthority[] = [];
  if (projection.requiredReceiptTypes.includes("scoped-compile") && emitsScopedCompile) {
    receipts.push(
      createCompilerTerminalReceipt("configured_action", "scoped-compile", projection, common),
    );
  }
  if (projection.requiredReceiptTypes.includes("review-receipt") && emitsReviewReceipt) {
    receipts.push(
      createCompilerTerminalReceipt("configured_action", "review-receipt", projection, common),
    );
  }
  return receipts;
}

export function createDirectCompilationTerminalReceipts(
  run: Readonly<RunRecord>,
  attempt: Readonly<AgentAttemptRecord>,
  assignment: Readonly<ReadyAssignment>,
  terminalOutputSha256: Sha256Digest,
  compiled: Readonly<AssignmentCompilation>,
  projection: RuntimeAssignmentTerminalPolicyProjection,
): CompilerTerminalReceiptAuthority[] {
  const ticket = run.tickets[assignment.ticketId];
  const step = ticket?.steps.find((candidate) => candidate.id === assignment.stepId);
  if (ticket === undefined || step === undefined) {
    throw new AuthorityRpcError(
      "terminal_direct_assignment",
      "direct compiler result lost its exact scheduler assignment",
    );
  }
  const compilationProjection: JsonValue = {
    outcome: structuredClone(compiled.outcome),
    graphHash: compiled.graphHash ?? null,
    graphRevision: compiled.graphRevision ?? null,
    ticketsSha256:
      compiled.tickets === undefined ? null : canonicalTicketBoardHash(compiled.tickets),
    activitySha256: canonicalHash(compiled.activity ?? []),
    artifactWrites: (compiled.artifactWrites ?? []).map((write) => ({
      path: write.path,
      expectedSha256: write.expectedSha256 ?? null,
      bytesSha256: rawSha256(write.bytes),
      sizeBytes: write.bytes.byteLength,
    })),
    changeControlSha256: compiled.changeControl?.sha256 ?? null,
  };
  const common: JsonValue = {
    protocol: "koni.terminal-direct-compilation-provenance.v1",
    runId: run.id,
    ticketId: assignment.ticketId,
    stepId: assignment.stepId,
    attemptId: attempt.id,
    terminalOutputSha256,
    launchSpecSha256: attempt.launchSpecHash,
    compilerResultSha256: canonicalHash(compilationProjection),
    compilerResult: compilationProjection,
    projectionSha256: projection.sha256,
    bindingSha256: projection.executionPolicyBinding.sha256,
  };
  const receipts: CompilerTerminalReceiptAuthority[] = [];
  if (projection.requiredReceiptTypes.includes("scoped-compile")) {
    receipts.push(
      createCompilerTerminalReceipt("direct_compilation", "scoped-compile", projection, common),
    );
  }
  if (projection.requiredReceiptTypes.includes("review-receipt") && step.kind === "review") {
    receipts.push(
      createCompilerTerminalReceipt("direct_compilation", "review-receipt", projection, common),
    );
  }
  return receipts;
}

export function createCompilerTerminalReceipt(
  source: CompilerTerminalReceiptAuthority["source"],
  receiptType: string,
  projection: RuntimeAssignmentTerminalPolicyProjection,
  provenance: JsonValue,
): CompilerTerminalReceiptAuthority {
  const binding = projection.executionPolicyBinding;
  if (binding.stepId === undefined) {
    throw new AuthorityRpcError(
      "terminal_receipt_step",
      "assignment terminal receipt has no bound workflow step",
    );
  }
  const receiptIdentity = {
    protocol: "koni.compiler-terminal-receipt-identity.v1",
    source,
    receiptType,
    provenance,
  };
  const receipt: ExecutionPolicyReceiptEvidence = {
    receiptId: canonicalHash(receiptIdentity),
    receiptType,
    freshness: "current",
    status: "passed",
    configurationSha256: projection.configurationSha256,
    catalogSha256: projection.catalogSha256,
    operationId: binding.operationId,
    ...(binding.workflowId === undefined ? {} : { workflowId: binding.workflowId }),
    stepId: binding.stepId,
    bindingSha256: binding.sha256,
    integrityValid: true,
    current: true,
    historicalEvidenceValid: false,
    linkedToCurrentOutput: true,
  };
  const material = {
    protocol: "koni.compiler-terminal-receipt.v1" as const,
    source,
    receipt,
    provenance,
  };
  return { ...material, sha256: canonicalHash(material) };
}

export function assertCompilerTerminalReceiptAuthority(
  authority: Readonly<CompilerTerminalReceiptAuthority>,
  projection: RuntimeAssignmentTerminalPolicyProjection,
): void {
  const { sha256, ...material } = authority;
  const receiptIdentity = {
    protocol: "koni.compiler-terminal-receipt-identity.v1",
    source: authority.source,
    receiptType: authority.receipt.receiptType,
    provenance: authority.provenance,
  };
  const binding = projection.executionPolicyBinding;
  if (
    authority.protocol !== "koni.compiler-terminal-receipt.v1" ||
    canonicalHash(material) !== sha256 ||
    authority.receipt.receiptId !== canonicalHash(receiptIdentity) ||
    authority.receipt.status !== "passed" ||
    authority.receipt.freshness !== "current" ||
    !authority.receipt.integrityValid ||
    !authority.receipt.current ||
    !authority.receipt.linkedToCurrentOutput ||
    authority.receipt.configurationSha256 !== projection.configurationSha256 ||
    authority.receipt.catalogSha256 !== projection.catalogSha256 ||
    authority.receipt.operationId !== binding.operationId ||
    authority.receipt.workflowId !== binding.workflowId ||
    authority.receipt.stepId !== binding.stepId ||
    authority.receipt.bindingSha256 !== binding.sha256
  ) {
    throw new AuthorityRpcError(
      "terminal_compiler_receipt_integrity",
      "compiler terminal receipt is stale, unbound, or not current",
    );
  }
}

export async function verifyTerminalSourcePreservation(
  run: Readonly<RunRecord>,
  attempt: Readonly<AgentAttemptRecord>,
  projection: RuntimeAssignmentTerminalPolicyProjection,
  workspace: string,
): Promise<Sha256Digest[]> {
  const receipts: Sha256Digest[] = [];
  for (const pair of projection.sourceManifestPairs) {
    if (
      pair.retainedSourceReceipts.length === 0 ||
      canonicalHash([...pair.current.sourcePaths]) !== canonicalHash([...pair.source.sourcePaths])
    ) {
      throw new AuthorityRpcError(
        "terminal_source_baseline",
        `source-preservation member ${pair.memberNodeId} has no exact retained baseline`,
      );
    }
    const baselines: RunCheckSourceManifestRecord[] = [];
    for (const retained of pair.retainedSourceReceipts) {
      const check = (run.checks ?? []).find((candidate) => candidate.id === retained.runCheckId);
      const retainedAttempt = run.attempts[retained.attemptId];
      const command = check?.commands[retained.commandIndex];
      if (
        check === undefined ||
        retainedAttempt === undefined ||
        retainedAttempt.ticketId !== attempt.ticketId ||
        retainedAttempt.stepId !== retained.stepId ||
        !check.accepted ||
        check.passed !== true ||
        check.attemptId !== retained.attemptId ||
        check.requestedCheckId !== retained.requestedCheckId ||
        command === undefined ||
        command.checkId !== retained.checkId ||
        command.executionPolicy === undefined ||
        canonicalHash(command.executionPolicy) !== canonicalHash(retained.executionPolicy) ||
        command.sourceManifest === undefined ||
        command.sourceManifest.commandBindingSha256 !== pair.source.commandBindingSha256 ||
        command.sourceManifest.stepId !== pair.source.stepId
      ) {
        throw new AuthorityRpcError(
          "terminal_source_receipt",
          `source-preservation receipt ${retained.runCheckId}/${retained.commandIndex} is stale or unauthenticated`,
        );
      }
      baselines.push(command.sourceManifest);
    }
    const baseline = baselines[0]!;
    if (
      baselines.some(
        (candidate) =>
          canonicalHash(candidate.roots) !== canonicalHash(baseline.roots) ||
          canonicalHash(candidate.entries) !== canonicalHash(baseline.entries),
      )
    ) {
      throw new AuthorityRpcError(
        "terminal_source_ambiguous",
        `source-preservation member ${pair.memberNodeId} has conflicting retained baselines`,
      );
    }
    const current = await snapshotContainedPaths(workspace, pair.current.sourcePaths);
    if (
      baseline.entries.some((entry) => entry.kind === "missing") ||
      current.entries.some((entry) => entry.kind === "missing") ||
      canonicalHash(baseline.roots) !== canonicalHash(current.roots) ||
      canonicalHash(baseline.entries) !== canonicalHash(current.entries)
    ) {
      throw new AuthorityRpcError(
        "terminal_source_changed",
        `workflow step ${attempt.stepId} changed exact source bytes from ${pair.source.stepId}`,
      );
    }
    receipts.push(
      canonicalHash({
        protocol: "koni.source-preservation-receipt.v1",
        bindingSha256: projection.executionPolicyBinding.sha256,
        pairSha256: pair.sha256,
        baselineManifestSha256: baseline.sha256,
        currentManifestSha256: current.manifestSha256,
        preserved: true,
      }),
    );
  }
  return [...new Set(receipts)].sort();
}

export function createRunCheckAttemptRecord(
  material: Omit<RunCheckAttemptRecord, "sha256">,
): RunCheckAttemptRecord {
  return { ...material, sha256: canonicalHash(material) };
}

export function createRunCheckSourceManifest(
  binding: ExecutionPolicyBinding,
  policy: CheckExecutionPolicyBinding,
  command: ResolvedAgentCheckCommand,
  manifest: ContainedPathManifest,
  capturedAt: string,
): RunCheckSourceManifestRecord {
  if (command.memberNodeId === undefined || command.memberSourcePaths === undefined) {
    throw new AuthorityRpcError(
      "check_source_binding",
      `configured check ${command.checkId} has no exact semantic source member`,
    );
  }
  const commandBindingSha256 = canonicalHash({
    stepId: binding.stepId,
    checkId: command.checkId,
    definitionHash: command.definitionHash,
    executionPolicy: policy,
    memberNodeId: command.memberNodeId,
    memberSourcePaths: command.memberSourcePaths,
    argv: command.argv,
    cwd: command.cwd,
    inputPaths: command.inputPaths,
  });
  const material = {
    protocol: "koni.run-check-source-manifest.v1" as const,
    configurationSha256: policy.configurationSha256,
    catalogSha256: policy.catalogSha256,
    bindingSha256: policy.bindingSha256,
    checkSha256: policy.checkSha256,
    commandBindingSha256,
    stepId: binding.stepId!,
    roots: [...manifest.roots],
    entries: manifest.entries.map((entry) => ({ ...entry })),
    manifestSha256: manifest.manifestSha256,
    capturedAt,
  };
  return { ...material, sha256: canonicalHash(material) };
}

export async function waitForConfiguredRetry(
  backoffSeconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted === true) {
    throw new AuthorityRpcError("check_aborted", "configured check retry was aborted");
  }
  if (backoffSeconds === 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, backoffSeconds * 1_000);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AuthorityRpcError("check_aborted", "configured check retry was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function assertResolvedAgentCheck(
  check: ResolvedAgentCheck,
  requestedCheckId: string,
  configured: NonNullable<AuthorityGrant["configuredChecks"]>,
  expectedBinding: ExecutionPolicyBinding | undefined,
): void {
  if (
    check.protocol !== "koni.resolved-agent-check.v1" ||
    check.requestedCheckId !== requestedCheckId ||
    !/^sha256:[0-9a-f]{64}$/u.test(check.definitionHash) ||
    !["command", "graph", "composite"].includes(check.kind) ||
    !Array.isArray(check.commands) ||
    check.commands.length > 256 ||
    (check.kind === "graph" && check.commands.length !== 0) ||
    (check.kind === "command" && check.commands.length !== 1) ||
    (check.kind === "composite" && check.commands.length === 0)
  )
    throw new AuthorityRpcError(
      "check_contract",
      "compiler returned an invalid configured check plan",
    );
  if (expectedBinding !== undefined) {
    assertExecutionPolicyBindingIntegrity(expectedBinding);
    if (check.executionPolicy === undefined) {
      throw new AuthorityRpcError(
        "check_policy_missing",
        `behavior-backed check ${requestedCheckId} has no top-level execution policy`,
      );
    }
  }
  if (check.executionPolicy !== undefined) {
    assertCheckPolicyMatchesBinding(check.executionPolicy, requestedCheckId, expectedBinding);
    if (check.executionPolicy.checkSha256 !== check.definitionHash) {
      throw new AuthorityRpcError(
        "check_policy_mismatch",
        `configured check ${requestedCheckId} differs from its top-level execution policy`,
      );
    }
  }
  for (const command of check.commands) {
    if (
      typeof command.checkId !== "string" ||
      command.checkId.length === 0 ||
      !/^sha256:[0-9a-f]{64}$/u.test(command.definitionHash) ||
      !Array.isArray(command.argv) ||
      command.argv.length === 0 ||
      !Number.isSafeInteger(command.timeoutMs) ||
      command.timeoutMs < 1 ||
      command.timeoutMs > configured.maxTimeoutMs ||
      !["read_only", "workspace_write"].includes(command.effect) ||
      (command.networkAccess && !configured.networkAccess) ||
      !isRecord(command.resultSource) ||
      (command.resultSource.kind !== "stdout" && command.resultSource.kind !== "file") ||
      (command.resultSource.kind === "file" && command.resultSource.path.length === 0) ||
      !Array.isArray(command.inputPaths) ||
      !Array.isArray(command.outputPaths)
    )
      throw new AuthorityRpcError(
        "check_contract",
        `compiler returned an invalid command for ${requestedCheckId}`,
      );
    if (expectedBinding !== undefined && command.executionPolicy === undefined) {
      throw new AuthorityRpcError(
        "check_policy_missing",
        `behavior-backed check leaf ${command.checkId} has no execution policy`,
      );
    }
    if (command.executionPolicy !== undefined) {
      assertCheckPolicyMatchesBinding(command.executionPolicy, command.checkId, expectedBinding);
      if (
        command.executionPolicy.checkSha256 !== command.definitionHash ||
        command.executionPolicy.effect !== command.effect ||
        command.executionPolicy.receiptType !== command.receiptType
      ) {
        throw new AuthorityRpcError(
          "check_policy_mismatch",
          `configured command ${command.checkId} differs from its compiler-bound execution policy`,
        );
      }
    }
  }
}

export function executionPolicyBindingForAttempt(
  run: Readonly<RunRecord>,
  attempt: Readonly<AgentAttemptRecord>,
): ExecutionPolicyBinding | undefined {
  const ticket = run.tickets[attempt.ticketId];
  const step = ticket?.steps.find((candidate) => candidate.id === attempt.stepId);
  if (ticket === undefined || step === undefined) return undefined;
  const binding = step.executionPolicyBinding;
  if (binding === undefined) return undefined;
  assertExecutionPolicyBindingIntegrity(binding);
  if (
    binding.operationId !== ticket.operationId ||
    binding.stepId !== step.id ||
    (ticket.executionPolicyBinding !== undefined &&
      (ticket.executionPolicyBinding.operationId !== binding.operationId ||
        ticket.executionPolicyBinding.configurationSha256 !== binding.configurationSha256 ||
        ticket.executionPolicyBinding.catalogSha256 !== binding.catalogSha256))
  ) {
    throw new AuthorityRpcError(
      "execution_policy_binding",
      `attempt ${attempt.id} has a stale ticket/step execution-policy binding`,
    );
  }
  return binding;
}

export function assertCheckPolicyMatchesBinding(
  policy: CheckExecutionPolicyBinding,
  checkId: string,
  binding: ExecutionPolicyBinding | undefined,
): void {
  assertCheckExecutionPolicyBinding(policy);
  if (policy.checkId !== checkId) {
    throw new AuthorityRpcError(
      "check_policy_mismatch",
      `configured check policy ${policy.checkId} was supplied for ${checkId}`,
    );
  }
  if (
    binding !== undefined &&
    (policy.configurationSha256 !== binding.configurationSha256 ||
      policy.catalogSha256 !== binding.catalogSha256 ||
      policy.bindingSha256 !== binding.sha256)
  ) {
    throw new AuthorityRpcError(
      "check_policy_mismatch",
      `configured check ${checkId} belongs to a different execution-policy binding`,
    );
  }
}

export async function readConfiguredCheckResult(
  worktree: string,
  grant: AuthorityGrant,
  command: ResolvedAgentCheckCommand,
  stdout: Buffer,
  tolerateInvalidStructuredResult = false,
): Promise<AgentCheckExecution["resultSource"]> {
  let bytes: Buffer;
  let sourcePath: string | undefined;
  if (command.resultSource.kind === "stdout") {
    bytes = stdout;
  } else {
    sourcePath = command.resultSource.path;
    const paths = await WorktreePathAuthority.create(worktree, {
      readPaths: grant.readPaths,
      writePaths: grant.writePaths,
    });
    if (pathWithinGrant(sourcePath, grant.writePaths)) {
      const file = await paths.inspectWritable(sourcePath);
      if (file === undefined) {
        if (!tolerateInvalidStructuredResult) {
          throw new AuthorityRpcError(
            "check_result_missing",
            `configured result file is missing: ${sourcePath}`,
          );
        }
        bytes = Buffer.alloc(0);
      } else {
        bytes = file.bytes;
      }
    } else {
      try {
        bytes = (await paths.read(sourcePath)).bytes;
      } catch (error) {
        if (!tolerateInvalidStructuredResult) throw error;
        bytes = Buffer.alloc(0);
      }
    }
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || text.includes("\0")) {
    throw new AuthorityRpcError(
      "check_result_encoding",
      "configured check result is not exact non-NUL UTF-8",
    );
  }
  const structured =
    command.resultProtocol !== undefined ||
    command.requiredResultFields.length > 0 ||
    command.resultSchema !== undefined ||
    command.outputArtifactSelector !== undefined;
  let value: JsonValue = null;
  if (text.trim().length > 0) {
    try {
      value = JSON.parse(text) as JsonValue;
    } catch (error) {
      if (structured && !tolerateInvalidStructuredResult) {
        throw new AuthorityRpcError(
          "check_result_json",
          `configured check result is not JSON: ${errorMessage(error)}`,
        );
      }
    }
  } else if (structured && !tolerateInvalidStructuredResult) {
    throw new AuthorityRpcError("check_result_json", "configured check result is empty");
  }
  return {
    kind: command.resultSource.kind,
    ...(sourcePath === undefined ? {} : { path: sourcePath }),
    bytesSha256: rawSha256(bytes),
    sizeBytes: bytes.byteLength,
    value,
  };
}

/**
 * A configured command can be labelled `workspace_write` while receiving no writable paths. The
 * sandbox then makes it effect-free in practice; with network disabled, an interrupted intent is
 * safe to retire instead of preserving a reconciliation blocker forever.
 */
export function configuredCheckHasNoExternalEffects(check: unknown): boolean {
  if (!isRecord(check) || !Array.isArray(check.commands)) return false;
  return check.commands.every(
    (value) =>
      isRecord(value) &&
      (value.effect === "read_only" ||
        (value.effect === "workspace_write" &&
          value.networkAccess === false &&
          Array.isArray(value.outputPaths) &&
          value.outputPaths.length === 0)),
  );
}

export function exactUtf8CheckStream(bytes: Buffer, label: string): string {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || text.includes("\0")) {
    throw new AuthorityRpcError(
      "check_stream_encoding",
      `configured check ${label} is not exact non-NUL UTF-8`,
    );
  }
  return text;
}

/**
 * Give the assigned agent a bounded, actionable explanation when an authority-run check fails.
 * Complete streams remain immutable artifacts in the check record; this projection is deliberately
 * small enough for the model transcript and excludes successful leaves from a failed composite.
 */
export function configuredCheckFailureDiagnostics(
  check: Pick<ResolvedAgentCheck, "commands">,
  executions: readonly AgentCheckExecution[],
): Array<Record<string, JsonValue>> {
  const failed = executions.filter((execution, index) => {
    const command = check.commands[index];
    return (
      execution.signal !== null ||
      execution.exitCode === null ||
      command === undefined ||
      !command.expectedExitCodes.includes(execution.exitCode)
    );
  });
  const selected = (failed.length === 0 ? executions : failed).slice(0, 8);
  return selected.map((execution) => {
    const commandIndex = executions.indexOf(execution);
    const command = check.commands[commandIndex];
    const stderrTail = boundedCheckDiagnosticTail(execution.stderr, 2_048);
    const stdoutTail = boundedCheckDiagnosticTail(execution.stdout, 2_048);
    return {
      commandIndex,
      checkId: execution.checkId,
      exitCode: execution.exitCode,
      signal: execution.signal,
      expectedExitCodes: command?.expectedExitCodes ?? [],
      ...(stderrTail.length === 0 ? {} : { stderrTail }),
      ...(stdoutTail.length === 0 ? {} : { stdoutTail }),
    };
  });
}

/**
 * An accepted non-zero result proves only the configured exit-code contract. The assigned
 * author still needs bounded streams to authenticate that an expected-red check failed for
 * the intended product reason rather than an unrelated fixture, import, or harness error.
 */
export function shouldProjectConfiguredCheckDiagnostics(
  check: Pick<ResolvedAgentCheck, "commands">,
  accepted: boolean,
): boolean {
  return (
    !accepted ||
    check.commands.some((command) => command.expectedExitCodes.some((exitCode) => exitCode !== 0))
  );
}

export function boundedCheckDiagnosticTail(value: string, maximumBytes: number): string {
  const sanitized = value
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/gu, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .trim();
  const bytes = Buffer.from(sanitized, "utf8");
  if (bytes.byteLength <= maximumBytes) return sanitized;
  let start = bytes.byteLength - maximumBytes;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

export function configuredResultArtifactPaths(
  command: Pick<ResolvedAgentCheckCommand, "checkId" | "outputArtifactSelector">,
  result: JsonValue,
): string[] {
  const selector = command.outputArtifactSelector;
  if (selector === undefined || !isRecord(result)) return [];
  const raw = result[selector.field];
  // Result-shape validation belongs to the compiler. Treating a missing/malformed artifact list as
  // an authority exception strands an otherwise fully observed process intent and prevents the
  // compiler from returning the ordinary rejected-check receipt that can drive bounded rework.
  if (!Array.isArray(raw) || raw.length > 4_096) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (selector.allowPathStrings && typeof entry === "string") {
      names.push(entry);
      continue;
    }
    if (isRecord(entry) && typeof entry[selector.pathField] === "string") {
      names.push(entry[selector.pathField] as string);
      continue;
    }
    return [];
  }
  return [...new Set(names)].sort();
}

export async function readConfiguredOutputFiles(
  worktree: string,
  grant: AuthorityGrant,
  command: ResolvedAgentCheckCommand,
  result: JsonValue,
): Promise<Array<{ path: string; sha256: Sha256Digest; sizeBytes: number }>> {
  const unique = configuredResultArtifactPaths(command, result);
  const output = [];
  for (const file of unique) {
    if (!pathWithinGrant(file, grant.writePaths)) {
      throw new AuthorityRpcError(
        "check_artifacts",
        `produced artifact is outside the write grant: ${file}`,
      );
    }
    const manifest = await snapshotContainedPaths(worktree, [file]);
    const entry = manifest.entries.find(
      (candidate) => candidate.path === file && candidate.kind === "file",
    );
    if (entry?.sha256 === undefined || entry.sizeBytes === undefined) {
      throw new AuthorityRpcError(
        "check_artifacts",
        `produced artifact is not a regular file: ${file}`,
      );
    }
    output.push({ path: file, sha256: entry.sha256, sizeBytes: entry.sizeBytes });
  }
  return output;
}

export function pathWithinGrant(value: string, roots: readonly string[]): boolean {
  if (
    value.length === 0 ||
    value === "." ||
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    return false;
  return roots.some((root) => root === "." || value === root || value.startsWith(`${root}/`));
}

export function authorizeToolResult(
  attempt: AgentAttemptRecord,
  call: KoniToolInvocation,
  receipt: KoniToolReceipt,
  artifactPath: string,
  recordedAt: string,
): void {
  const canonicalArguments = canonicalEncode(call.arguments);
  authorizeToolResultFromDigests(
    attempt,
    call.callId,
    call.name,
    rawSha256(canonicalArguments),
    Buffer.byteLength(canonicalArguments, "utf8"),
    receipt,
    artifactPath,
    recordedAt,
  );
}

export function authorizeToolResultFromDigests(
  attempt: AgentAttemptRecord,
  callId: string,
  toolName: string,
  argumentsSha256: Sha256Digest,
  argumentsSizeBytes: number,
  receipt: KoniToolReceipt,
  artifactPath: string,
  recordedAt: string,
): void {
  const canonical = canonicalEncode(receipt);
  attempt.authorityToolResults ??= [];
  attempt.authorityToolResults.push({
    sequence: attempt.authorityToolResults.length + 1,
    callId,
    toolName,
    outcome: receipt.outcome,
    argumentsSha256,
    argumentsSizeBytes,
    receiptSha256: rawSha256(canonical),
    receiptSizeBytes: Buffer.byteLength(canonical, "utf8"),
    artifactPath,
    recordedAt,
  });
}

export async function planWorkspaceEffect(
  paths: WorktreePathAuthority,
  call: KoniToolInvocation & { name: "koni_write_file" | "koni_edit_file" },
): Promise<{ path: string; expectedSha256: Sha256Digest | null; bytes: Buffer }> {
  const target = toolString(call.arguments, "path");
  if (call.name === "koni_write_file") {
    return {
      path: target,
      expectedSha256: call.arguments.expectedSha256 as Sha256Digest | null,
      bytes: Buffer.from(toolStringAllowEmpty(call.arguments, "content"), "utf8"),
    };
  }
  const expectedSha256 = toolString(call.arguments, "expectedSha256") as Sha256Digest;
  const oldText = toolString(call.arguments, "oldText");
  const bytes = await paths.planEdit(
    target,
    oldText,
    toolStringAllowEmpty(call.arguments, "newText"),
    expectedSha256,
  );
  return { path: target, expectedSha256, bytes };
}

export async function applyWorkspaceEffect(
  paths: WorktreePathAuthority,
  intent: WorkspaceEffectIntentRecord,
  bytes: Buffer,
): Promise<void> {
  if (bytes.byteLength !== intent.contentSizeBytes || rawSha256(bytes) !== intent.desiredSha256) {
    throw new AuthorityRpcError(
      "effect_content",
      "workspace effect content differs from its intent",
    );
  }
  try {
    const applied = await paths.write(intent.path, bytes, intent.expectedSha256);
    if (applied !== intent.desiredSha256) {
      throw new AuthorityRpcError(
        "effect_hash",
        "workspace effect produced an unexpected file hash",
      );
    }
  } catch (error) {
    const current = await paths.inspectWritable(intent.path);
    if (current?.sha256 === intent.desiredSha256) return;
    throw error;
  }
}

export function workspaceEffectId(grant: AuthorityGrant, callId: string): string {
  return `effect-${canonicalHash({
    grantId: grant.grantId,
    epoch: grant.epoch,
    generation: grant.generation,
    callId,
  }).slice(7, 39)}`;
}

export function workspaceEffectContentPath(
  runId: string,
  attemptId: string,
  effectId: string,
): string {
  return `runs/${runId}/attempts/${attemptId}/workspace-effects/${effectId}.bin`;
}

export function conversationParentSessionFile(spec: Readonly<AgentLaunchSpec>): string {
  const lineage = spec.lineage;
  if (
    lineage.conversationFork === undefined ||
    lineage.parentAttemptId === undefined ||
    lineage.parentSessionId === undefined
  ) {
    throw new AuthorityRpcError(
      "transcript_lineage",
      "attempt has no authenticated conversation parent",
    );
  }
  return path.join(
    path.dirname(spec.workspace.sessionDirectory),
    lineage.parentAttemptId,
    `${lineage.parentSessionId}.jsonl`,
  );
}

export function workspaceEffectReceipt(intent: WorkspaceEffectIntentRecord): KoniToolReceipt {
  return {
    protocol: KONI_TOOL_RECEIPT_PROTOCOL,
    receiptId: canonicalHash({
      method: intent.method,
      idempotencyKey: intent.idempotencyKey,
      requestHash: intent.requestHash,
    }),
    outcome: "accepted",
    summary: `${intent.toolName === "koni_write_file" ? "Wrote" : "Edited"} ${intent.path}`,
    value: { path: intent.path, sha256: intent.desiredSha256 },
  };
}

export function canonicalTicketBoardHash(
  tickets: Readonly<Record<string, TicketRecord>>,
): Sha256Digest {
  // Ticket records intentionally use required `undefined` placeholders while they are mutable in
  // memory. JSON persistence omits those object fields, so hash the same durable projection instead
  // of asking the stricter canonical encoder to hash a representation that can never be written.
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(tickets);
  } catch (error) {
    throw new AuthorityRpcError(
      "ticket_board_json",
      `ticket board cannot be projected to durable JSON: ${errorMessage(error)}`,
    );
  }
  if (encoded === undefined) {
    throw new AuthorityRpcError(
      "ticket_board_json",
      "ticket board cannot be projected to durable JSON",
    );
  }
  return canonicalHash(JSON.parse(encoded) as JsonValue);
}

export function isKoniToolReceipt(value: unknown): value is KoniToolReceipt {
  try {
    validateKoniToolReceipt(value);
    return true;
  } catch {
    return false;
  }
}

export function toolStringAllowEmpty(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string")
    throw new AuthorityRpcError("tool_arguments", `${key} must be a string`);
  return value;
}

export function toolInteger(
  object: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = object[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AuthorityRpcError("tool_arguments", `${key} must be a non-negative integer`);
  }
  return value;
}

export function validatedProviderRequestLivenessTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PROVIDER_REQUEST_LIVENESS_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 10 || value > 24 * 60 * 60 * 1_000) {
    throw new Error(
      "provider request liveness timeout must be an integer between 10ms and 24 hours",
    );
  }
  return value;
}

export function textPage(
  content: string,
  offsetChars: number,
  maxChars: number,
  metadata: Record<string, JsonValue>,
): JsonValue {
  const characters = Array.from(content);
  if (offsetChars > characters.length) {
    throw new AuthorityRpcError("text_offset", "text page offset exceeds content length");
  }
  const end = Math.min(characters.length, offsetChars + maxChars);
  return {
    ...metadata,
    offsetChars,
    nextOffsetChars: end,
    totalChars: characters.length,
    eof: end === characters.length,
    content: characters.slice(offsetChars, end).join(""),
  };
}

export function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
