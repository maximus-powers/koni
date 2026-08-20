import type {
  ActionExecutionJournal,
  CompiledActionDefinition,
  LeadJudgmentTrigger,
} from "../contracts/behavior.js";
import type { ConfigurationObject, ConfigurationValue } from "../contracts/configuration.js";
import { type GitLifecycleIntent, type GitPathScope } from "../git/index.js";
import {
  canonicalEncode,
  canonicalHash,
  compareUtf8,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import {
  assertRunActionCurrent,
  prepareRunActionExecution,
  RunActionAuthorityError,
} from "./action-execution.js";
import type { TransactionWrite } from "./file-journal.js";
import type { JsonValue } from "./protocol.js";
import {
  currentTicketExecutionEpoch,
  humanizeIdentifier,
  isProviderExposureHoldBlocker,
  isRecord,
  selectedRunAction,
} from "./run-engine-shared.js";
import { AuthorityRpcError } from "./server.js";

import { type SourceReleaseDecision } from "../state/change-control.js";
import type {
  AgentAttemptRecord,
  AgentTerminalPolicyRecord,
  HeldSourceGrantRefreshAuthority,
  RecurringAssetGrantRefreshAuthority,
  RunActionExecutionRecord,
  RunPostOrchestrationBinding,
  RunRecord,
  RunReportRecord,
  SourceCorrectionSeedAuthority,
  TicketRecord,
} from "../state/run-record.js";
import {
  currentSourceCorrectionSeed,
  deriveProposalReviewExhaustionAuthority,
  deriveRunActionExecutionArchive,
  deriveRunActionExecutionArchiveSegment,
  leadJudgmentProductSha256,
  sourceCorrectionSeedRoute,
  terminalFailureBindingsForTicket,
  ticketImmutableProjection,
} from "../state/run-record.js";
import {
  COMPILER_INAPPLICABLE_TICKET,
  ticketDependencySettled,
  type ReadyAssignment,
} from "../state/scheduler.js";
import {
  defineBuiltInStageAction,
  type StageActionCapability,
  type StageActionFieldSchema,
  type StageActionValue,
} from "../state/stage-capability.js";
import { configuredTicketState } from "./configured-lifecycle.js";

import {
  type CompiledAgentCheckResult,
  type VerificationCompilation,
} from "./run-engine-contracts.js";

export const CONFIGURED_STAGE_PRIMITIVES = new Set([
  "lock.acquire",
  "profile.validate",
  "project.validate",
  "graph.validate",
  "ticket.validate",
  "scope.validate",
  "event.append",
  "receipt.write",
  "snapshot.write",
  "board.render",
  "graph.inspect",
  "ticket.inspect",
  "integration.validate",
  "recovery.dispatch",
]);

export function configuredStageActionCapability(
  run: Readonly<RunRecord>,
  stage: Readonly<{ id: string; title: string; kind: string }>,
  current: boolean,
): StageActionCapability {
  const config = run.behavior?.runType.pipeline.find(
    (candidate) => candidate.id === stage.id,
  )?.config;
  const selector =
    config?.kind === "action" && !config.compilerOwned && !config.automatic
      ? config.action
      : undefined;
  const action =
    selector === undefined || run.behavior === undefined
      ? undefined
      : selectedRunAction(run, selector);
  const ticketParameters =
    action?.parameters.filter((parameter) => parameter.type === "ticket_id") ?? [];
  const eligibleTickets =
    action === undefined
      ? []
      : Object.values(run.tickets).filter(
          (ticket) =>
            action.allowedTicketStates.length === 0 ||
            action.allowedTicketStates.includes(ticket.status),
        );
  const recovery =
    action?.recovery === undefined || run.behavior === undefined
      ? undefined
      : selectedRunAction(run, action.recovery);
  const recoverySafe =
    recovery === undefined ||
    (recovery.actor === "compiler" &&
      recovery.recipe.every((step) => CONFIGURED_STAGE_PRIMITIVES.has(step.primitive)) &&
      recovery.compensation.every((step) => CONFIGURED_STAGE_PRIMITIVES.has(step.primitive)));
  let reason = "The current compiler stage exposes this exact configured action.";
  let available =
    current &&
    action !== undefined &&
    action.actor === "compiler" &&
    action.recipe.every((step) => CONFIGURED_STAGE_PRIMITIVES.has(step.primitive)) &&
    action.compensation.every((step) => CONFIGURED_STAGE_PRIMITIVES.has(step.primitive)) &&
    recoverySafe;
  if (!current) reason = "Configured action is available only at its current pipeline stage.";
  else if (action === undefined)
    reason = "Pinned stage action no longer resolves in the action catalog.";
  else if (action.actor !== "compiler")
    reason = "Operator controls cannot impersonate a Lead-owned action.";
  else if (ticketParameters.length > 1) {
    available = false;
    reason = "Configured stage actions may bind at most one ticket parameter.";
  } else if (action.checkout === "ticket" && ticketParameters.length !== 1) {
    available = false;
    reason = "Ticket-checkout action has no exact ticket parameter to bind its authority.";
  } else if (ticketParameters.length === 1 && eligibleTickets.length === 0) {
    available = false;
    reason = "No ticket is currently in an allowed state for this action.";
  } else if (
    !action.recipe.every((step) => CONFIGURED_STAGE_PRIMITIVES.has(step.primitive)) ||
    !action.compensation.every((step) => CONFIGURED_STAGE_PRIMITIVES.has(step.primitive)) ||
    !recoverySafe
  ) {
    available = false;
    reason =
      "This action reaches a scheduler, session, Git, graph-mutation, or ticket-transition boundary that is not operator-delegable.";
  }
  const fields: StageActionFieldSchema[] =
    action?.parameters.map((parameter) => {
      const common = {
        key: parameter.id,
        label: humanizeIdentifier(parameter.id),
        description:
          parameter.description.length === 0
            ? `Configured ${parameter.type} parameter.`
            : parameter.description,
        required: parameter.required,
        locked: false,
        visibility: "shown" as const,
        maxBytes: 1024 * 1024,
      };
      if (parameter.type === "ticket_id") {
        return {
          ...common,
          kind: "select" as const,
          options: eligibleTickets.map((ticket) => ({
            value: ticket.id,
            label: ticket.title,
            description: `${ticket.status} · ${ticket.id}`,
          })),
          ...(typeof parameter.default === "string" ? { defaultValue: parameter.default } : {}),
        };
      }
      if (parameter.type === "boolean") {
        return {
          ...common,
          kind: "boolean" as const,
          ...(typeof parameter.default === "boolean" ? { defaultValue: parameter.default } : {}),
        };
      }
      if (parameter.type === "integer" || parameter.type === "number") {
        return {
          ...common,
          kind: parameter.type,
          ...(typeof parameter.default === "number" ? { defaultValue: parameter.default } : {}),
        };
      }
      if (parameter.type === "json") {
        return {
          ...common,
          kind: "multiline" as const,
          ...(parameter.default === undefined
            ? {}
            : { defaultValue: canonicalEncode(parameter.default) }),
        };
      }
      return {
        ...common,
        kind: "text" as const,
        ...(typeof parameter.default === "string" ? { defaultValue: parameter.default } : {}),
      };
    }) ?? [];
  return defineBuiltInStageAction({
    id: `stage:${stage.id}:execute`,
    intent: "execute_action",
    available,
    reason,
    title: stage.title,
    description:
      action === undefined
        ? "Execute the pinned stage action."
        : `Execute configured action ${action.id}.`,
    form: {
      title: stage.title,
      description:
        action === undefined
          ? "The pinned compiler action is unavailable."
          : `Parameters are validated against ${action.id} before its durable action plan is admitted.`,
      submitLabel: "Run action",
      fields,
    },
  });
}

export function configuredStageParameters(
  action: Readonly<CompiledActionDefinition>,
  values: Readonly<Record<string, StageActionValue>>,
): ConfigurationObject {
  const parameters: Record<string, ConfigurationValue> = Object.create(null) as Record<
    string,
    ConfigurationValue
  >;
  for (const parameter of action.parameters) {
    const raw = values[parameter.id];
    if (raw === undefined) continue;
    if (parameter.type === "json") {
      if (typeof raw !== "string") {
        throw new AuthorityRpcError(
          "stage_action_parameter",
          `${parameter.id} must contain JSON text`,
        );
      }
      try {
        const value: unknown = JSON.parse(raw);
        assertConfigurationValue(value, parameter.id);
        parameters[parameter.id] = value;
      } catch (error) {
        if (error instanceof AuthorityRpcError) throw error;
        throw new AuthorityRpcError("stage_action_parameter", `${parameter.id} is not valid JSON`);
      }
    } else {
      if (Array.isArray(raw)) {
        throw new AuthorityRpcError(
          "stage_action_parameter",
          `${parameter.id} has an unsupported list value`,
        );
      }
      parameters[parameter.id] = raw;
    }
  }
  return parameters;
}

export function requiredCurrentStageId(run: Readonly<RunRecord>, boundary: string): string {
  if (run.currentPipelineStageId === undefined) {
    throw new AuthorityRpcError(
      "action_stage_missing",
      `${boundary} has no current compiler stage`,
    );
  }
  return run.currentPipelineStageId;
}

export function admitRunActionExecution(
  draft: RunRecord,
  execution: RunActionExecutionRecord,
): TransactionWrite[] {
  if (
    execution.boundary.runId !== draft.id ||
    execution.boundary.compiledConfigHash !== draft.compiledConfigHash ||
    execution.boundary.behaviorSha256 !== draft.behavior?.sha256 ||
    execution.boundary.generation !== draft.generation ||
    execution.expectedRunRevision !== draft.revision
  ) {
    throw new AuthorityRpcError(
      "action_admission_binding",
      "configured action admission differs from the exact durable run transition",
    );
  }
  draft.actionExecutions ??= {};
  const writes: TransactionWrite[] = [];
  const active = Object.values(draft.actionExecutions);
  if (active.length >= 256) {
    const removable = active
      .filter(
        (record) =>
          record.settledAt !== undefined &&
          (isTerminalActionJournal(record.journal) ||
            record.settlement?.disposition === "abandoned"),
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.invocationId.localeCompare(right.invocationId),
      );
    const required = active.length - 191;
    if (removable.length < required) {
      throw new AuthorityRpcError(
        "action_retention_pressure",
        "too many unsettled configured actions remain; recovery must settle them before new admission",
      );
    }
    draft.actionExecutionArchive ??= [];
    for (const record of removable.slice(0, required)) {
      const archived = deriveRunActionExecutionArchive(draft, record);
      writes.push({ path: archived.row.artifactPath, bytes: archived.bytes, expectedSha256: null });
      draft.actionExecutionArchive.push(archived.row);
      delete draft.actionExecutions[record.invocationId];
    }
    if (draft.actionExecutionArchive.length > 1_024) {
      const compacted = draft.actionExecutionArchive.splice(
        0,
        draft.actionExecutionArchive.length - 256,
      );
      const archived = deriveRunActionExecutionArchiveSegment(draft.id, compacted);
      writes.push({
        path: archived.segment.artifactPath,
        bytes: archived.bytes,
        expectedSha256: null,
      });
      draft.actionExecutionArchiveSegments ??= [];
      if (draft.actionExecutionArchiveSegments.length >= 10_000) {
        throw new AuthorityRpcError(
          "action_archive_segments",
          "configured-action archive index reached its audited segment bound",
        );
      }
      draft.actionExecutionArchiveSegments.push(archived.segment);
    }
  }
  const prior = draft.actionExecutions[execution.invocationId];
  if (prior !== undefined && canonicalHash(prior) !== canonicalHash(execution)) {
    throw new AuthorityRpcError(
      "action_identity_collision",
      "configured action identity already has different bytes",
    );
  }
  draft.actionExecutions[execution.invocationId] = structuredClone(execution);
  return writes;
}

export function findRunActionAtBoundary(
  run: Readonly<RunRecord>,
  kind: RunActionExecutionRecord["boundary"]["kind"],
  binding: Readonly<{
    stageId?: string;
    ticketId?: string;
    stepId?: string;
    attemptId?: string;
    productSha256?: Sha256Digest;
    parentInvocationId?: string;
  }> = {},
): RunActionExecutionRecord | undefined {
  return Object.values(run.actionExecutions ?? {})
    .filter(
      (record) =>
        record.boundary.kind === kind &&
        (binding.stageId === undefined || record.boundary.stageId === binding.stageId) &&
        (binding.ticketId === undefined || record.boundary.ticketId === binding.ticketId) &&
        (binding.stepId === undefined || record.boundary.stepId === binding.stepId) &&
        (binding.attemptId === undefined || record.boundary.attemptId === binding.attemptId) &&
        (binding.productSha256 === undefined ||
          record.boundary.productSha256 === binding.productSha256) &&
        (binding.parentInvocationId === undefined ||
          record.boundary.parentInvocationId === binding.parentInvocationId),
    )
    .sort(
      (left, right) =>
        right.boundary.admittedRunRevision - left.boundary.admittedRunRevision ||
        right.invocationId.localeCompare(left.invocationId),
    )
    .at(0);
}

export function isTerminalActionJournal(journal: Readonly<ActionExecutionJournal>): boolean {
  return new Set<ActionExecutionJournal["status"]>([
    "completed",
    "failed",
    "compensated",
    "compensation_failed",
    "recovery_required",
  ]).has(journal.status);
}

export function retryableCompilerValidationAction(
  run: Readonly<RunRecord>,
  action: Readonly<RunActionExecutionRecord>,
): boolean {
  if (
    action.boundary.kind !== "assignment_validation" ||
    action.boundary.generation !== run.generation ||
    action.settledAt !== undefined ||
    action.settlement !== undefined ||
    action.journal.status !== "failed" ||
    action.semanticResult !== undefined ||
    Object.keys(action.effects).length !== 0 ||
    action.journal.steps.length !== 1
  )
    return false;
  const attemptId = action.boundary.attemptId;
  const attempt = attemptId === undefined ? undefined : run.attempts[attemptId];
  if (
    attempt === undefined ||
    attempt.status !== "terminal_accepted" ||
    attempt.terminalAcceptedAt === undefined ||
    attempt.terminalOutputSha256 === undefined ||
    attempt.terminalOutputSizeBytes === undefined
  )
    return false;
  const failed = action.journal.steps[0]!;
  const first = action.plan.recipe[0];
  if (failed.status !== "failed" || first === undefined || failed.stepId !== first.id) return false;
  try {
    return isActionSemanticCompilerStep(action, first.id, first.primitive);
  } catch {
    return false;
  }
}

export function assertActionBoundaryCurrent(
  run: Readonly<RunRecord>,
  record: Readonly<RunActionExecutionRecord>,
): void {
  const boundary = record.boundary;
  if (boundary.kind !== "recovery" && run.currentPipelineStageId !== boundary.stageId) {
    throw new RunActionAuthorityError(
      "stage_drift",
      "configured action is no longer at its compiler-bound stage",
    );
  }
  if (
    boundary.kind === "approved_plan_compile" &&
    (run.lifecycle.phase !== "approving" || run.plan?.status !== "approving")
  ) {
    throw new RunActionAuthorityError(
      "approval_drift",
      "approved-plan compile action left the approving boundary",
    );
  }
  if (
    (boundary.kind === "assignment_validation" || boundary.kind === "lead_launch") &&
    !executionActionBoundaryLifecycleIsCurrent(run.lifecycle)
  ) {
    throw new RunActionAuthorityError(
      "execution_drift",
      "ticket or Lead action left deterministic orchestration",
    );
  }
  if (boundary.kind === "post_orchestration_report" && run.lifecycle.phase !== "verifying") {
    throw new RunActionAuthorityError(
      "report_drift",
      "report action left post-orchestration verification",
    );
  }
  if (boundary.kind === "lead_launch") {
    const trigger = leadJudgmentTriggerFromStepId(boundary.stepId);
    if (trigger === undefined || boundary.productSha256 !== leadActionProductSha256(run, trigger)) {
      throw new RunActionAuthorityError(
        "lead_product_drift",
        "Lead action graph or run product changed after admission",
      );
    }
  }
  if (boundary.attemptId !== undefined) {
    const attempt = run.attempts[boundary.attemptId];
    if (boundary.kind === "lead_launch" && attempt === undefined && record.settledAt === undefined)
      return;
    if (
      attempt === undefined ||
      attempt.ticketId !== boundary.ticketId ||
      attempt.stepId !== boundary.stepId
    ) {
      throw new RunActionAuthorityError(
        "attempt_drift",
        "configured action attempt binding changed",
      );
    }
  }
}

/**
 * Keep a previously admitted execution action durable through the exact temporary blocker that
 * provider auto-recovery removes. New scheduling remains closed while blocked, and assignment
 * settlement separately refuses to publish effects outside `executing`; this exception only lets
 * an already-executed primitive persist its journal so recovery can resume it deterministically.
 */
export function executionActionBoundaryLifecycleIsCurrent(
  lifecycle: Readonly<Pick<RunRecord["lifecycle"], "phase" | "blocker">>,
): boolean {
  return (
    lifecycle.phase === "executing" ||
    (lifecycle.phase === "blocked" && isProviderExposureHoldBlocker(lifecycle.blocker))
  );
}

/**
 * Authenticate one action against the current run while allowing only a behind global CAS cursor.
 * Parallel disjoint actions may advance the run revision between this action's effect and journal
 * writes. The next write rebases that cursor atomically; no separate adoption mutation is needed.
 */
export function currentRunActionCursor(
  run: Readonly<RunRecord>,
  record: Readonly<RunActionExecutionRecord>,
): RunActionExecutionRecord {
  if (record.expectedRunRevision > run.revision) {
    throw new RunActionAuthorityError(
      "stale_revision",
      `action expects future run revision ${record.expectedRunRevision}, current revision is ${run.revision}`,
    );
  }
  assertActionBoundaryCurrent(run, record);
  if (record.expectedRunRevision === run.revision) {
    assertRunActionCurrent(run, record);
    return record;
  }
  const rebased = { ...structuredClone(record), expectedRunRevision: run.revision };
  assertRunActionCurrent(run, rebased);
  return rebased;
}

/** Only an ordinary concurrent run-revision advance may re-admit a Lead action. */
export function isReadmittableLeadActionDrift(error: unknown): boolean {
  return error instanceof RunActionAuthorityError && error.code === "stale_revision";
}

/**
 * Recognize the harmless loser of a concurrent Lead-launch race.
 *
 * The configured action and its exact attempt are committed atomically. A second orchestration
 * tick may already hold the same admission when that commit lands. Only the byte-bound action
 * identity may make that replay a no-op; a changed attempt, step, product, or disposition must
 * continue through the strict action checks and fail closed.
 */
export function isExactSettledLeadLaunchReplay(
  run: Pick<RunRecord, "attempts">,
  action: Pick<
    RunActionExecutionRecord,
    "invocationId" | "boundary" | "journal" | "settlement" | "settledAt"
  >,
  expected: Readonly<{
    attemptId: string;
    stepId: string;
    productSha256: Sha256Digest;
  }>,
): boolean {
  const attempt = run.attempts[expected.attemptId];
  return (
    action.boundary.kind === "lead_launch" &&
    action.boundary.attemptId === expected.attemptId &&
    action.boundary.stepId === expected.stepId &&
    action.boundary.productSha256 === expected.productSha256 &&
    action.journal.status === "completed" &&
    action.settledAt !== undefined &&
    action.settlement?.disposition === "completed" &&
    attempt?.kind === "lead" &&
    attempt.ticketId === action.boundary.ticketId &&
    attempt.stepId === expected.stepId &&
    attempt.launchActionInvocationId === action.invocationId
  );
}

export function isActionSemanticCompilerStep(
  record: Readonly<RunActionExecutionRecord>,
  stepId: string,
  primitive: string,
): boolean {
  let preferred: readonly string[];
  if (record.boundary.kind === "approved_plan_compile") {
    preferred = ["rules.evaluate", "project.validate"];
  } else if (record.boundary.kind === "assignment_validation") {
    preferred = ["check.run", "review.validate", "rules.evaluate", "project.validate"];
  } else if (record.boundary.kind === "post_orchestration_report") {
    preferred = ["report.render"];
  } else {
    return false;
  }
  for (const candidate of preferred) {
    const step = record.plan.recipe.find((item) => item.primitive === candidate);
    if (step !== undefined) return step.id === stepId && primitive === candidate;
  }
  throw new AuthorityRpcError(
    "action_semantic_primitive",
    `configured ${record.boundary.kind} action contains no native semantic compiler primitive`,
  );
}

export function assertActionTicketArguments(
  ticketId: string,
  args: Readonly<ConfigurationObject>,
): void {
  for (const key of ["ticket", "ticket_id"] as const) {
    const value = args[key];
    if (value !== undefined && value !== ticketId) {
      throw new AuthorityRpcError(
        "action_ticket_argument",
        `${key} differs from the compiler-bound ticket`,
      );
    }
  }
}

export function actionStringArgument(args: Readonly<ConfigurationObject>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new AuthorityRpcError(
      "action_argument",
      `configured primitive requires string argument ${key}`,
    );
  }
  return value;
}

export function actionOptionalStringArgument(
  args: Readonly<ConfigurationObject>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new AuthorityRpcError(
      "action_argument",
      `configured primitive argument ${key} must be text`,
    );
  }
  return value;
}

export function behaviorReportProductSha256(
  run: Readonly<RunRecord>,
  binding: Readonly<RunPostOrchestrationBinding>,
): Sha256Digest {
  return canonicalHash({
    runOid: binding.runOid,
    targetOid: binding.targetOid,
    graphHash: binding.graphHash,
    verificationSha256: run.postOrchestration?.checkpoint?.verificationSha256 ?? null,
    reviewAttemptId: run.postOrchestration?.review?.attemptId ?? null,
  });
}

export function leadActionProductSha256(
  run: Readonly<RunRecord>,
  trigger: LeadJudgmentTrigger,
): Sha256Digest {
  if (
    run.behavior === undefined ||
    run.graphHash === undefined ||
    run.git.run.headOid === undefined
  ) {
    throw new AuthorityRpcError(
      "lead_action_binding",
      "Lead action requires pinned behavior, graph, and run Git identity",
    );
  }
  return leadJudgmentProductSha256(run, trigger);
}

export function leadJudgmentTriggerFromStepId(
  stepId: string | undefined,
): LeadJudgmentTrigger | undefined {
  if (stepId === "lead-orchestration-entry") return "orchestration_entry";
  if (stepId === "lead-compiler-deadlock") return "compiler_deadlock";
  return undefined;
}

export function prepareAssignmentValidationExecution(
  run: Readonly<RunRecord>,
  attempt: Readonly<AgentAttemptRecord>,
  assignment: Readonly<ReadyAssignment>,
  terminalOutput: unknown,
  terminalOutputSha256: Sha256Digest,
  at: string,
): RunActionExecutionRecord {
  const ticket = run.tickets[assignment.ticketId];
  const step = ticket?.steps.find((candidate) => candidate.id === assignment.stepId);
  if (ticket === undefined || step === undefined || attempt.id.length === 0) {
    throw new AuthorityRpcError(
      "action_assignment",
      "terminal output lost its exact ticket-step assignment",
    );
  }
  if (step.validationAction === undefined) {
    throw new AuthorityRpcError(
      "action_validation_missing",
      `behavior-backed ticket step ${ticket.id}/${step.id} has no compiler-pinned validation action`,
    );
  }
  const action = selectedRunAction(run, step.validationAction);
  if (action.actor !== "compiler") {
    throw new AuthorityRpcError(
      "action_validation_actor",
      "ticket validation action must be compiler-owned",
    );
  }
  const terminal = isRecord(terminalOutput) ? terminalOutput : {};
  const terminalStatus =
    terminal.status === "completed"
      ? "passed"
      : terminal.status === "failed"
        ? "failed"
        : undefined;
  const terminalNotes =
    typeof terminal.summary === "string"
      ? terminal.summary
      : typeof terminal.blocker === "string"
        ? terminal.blocker
        : "";
  const parameters: Record<string, ConfigurationValue> = Object.create(null) as Record<
    string,
    ConfigurationValue
  >;
  for (const parameter of action.parameters) {
    let value: ConfigurationValue | undefined;
    if (parameter.type === "ticket_id") value = ticket.id;
    else if (parameter.id === "status" && parameter.type === "string") value = terminalStatus;
    else if (
      (parameter.id === "notes" || parameter.id === "summary") &&
      parameter.type === "string"
    ) {
      value = terminalNotes;
    } else if (parameter.id === "step" && parameter.type === "string") value = step.id;
    else if (parameter.id === "persona" && parameter.type === "string") value = step.personaId;
    else if (parameter.id === "payload" && parameter.type === "json") {
      assertConfigurationValue(terminalOutput, "terminal action payload");
      value = terminalOutput;
    } else if (parameter.default !== undefined) value = structuredClone(parameter.default);
    if (value === undefined && parameter.required) {
      throw new AuthorityRpcError(
        "action_validation_parameter",
        `compiler cannot derive required validation parameter ${parameter.id} from the bound terminal schema`,
      );
    }
    if (value !== undefined) parameters[parameter.id] = value;
  }
  return prepareRunActionExecution(run, {
    kind: "assignment_validation",
    stageId: requiredCurrentStageId(run, "ticket validation"),
    selector: step.validationAction,
    checkout: action.checkout,
    parameters,
    ticketId: ticket.id,
    ticketState: configuredActionTicketState(run, ticket),
    stepId: step.id,
    attemptId: attempt.id,
    ...(ticket.gitCycleId === undefined ? {} : { cycleId: ticket.gitCycleId }),
    productSha256: canonicalHash({
      terminalOutputSha256,
      launchSpecHash: attempt.launchSpecHash,
      ticketId: ticket.id,
      stepId: step.id,
      cycleId: ticket.gitCycleId ?? null,
    }),
    at,
  });
}

export function configuredActionTicketState(
  run: Readonly<RunRecord>,
  ticket: Readonly<TicketRecord>,
): string {
  const machine = run.lifecycleCatalog?.machines.ticket;
  return machine === undefined ? ticket.status : configuredTicketState(machine, ticket.status);
}

export function terminalActionSummary(output: unknown): string {
  if (isRecord(output)) {
    if (typeof output.summary === "string" && output.summary.trim().length > 0)
      return output.summary;
    if (typeof output.blocker === "string" && output.blocker.trim().length > 0)
      return output.blocker;
  }
  return "Structured output accepted for configured validation";
}

export function terminalOutputReportsFailure(output: unknown): boolean {
  return isRecord(output) && output.status === "failed";
}

export function failedSubmissionTerminalPolicy(acceptedAt: string): AgentTerminalPolicyRecord {
  const material = {
    protocol: "koni.agent-terminal-policy.v1" as const,
    mode: "failed_submission" as const,
    acceptedAt,
  };
  return { ...material, sha256: canonicalHash(material) };
}

export function assertConfigurationValue(
  value: unknown,
  label: string,
): asserts value is ConfigurationValue {
  try {
    canonicalEncode(value);
  } catch {
    throw new AuthorityRpcError(
      "action_validation_parameter",
      `${label} is not a canonical configuration value`,
    );
  }
}

export function gitActivityMessage(kind: GitLifecycleIntent["kind"]): string {
  const labels: Record<GitLifecycleIntent["kind"], string> = {
    planning_create: "Prepared planning checkout",
    run_materialize: "Prepared isolated run workspace",
    ticket_materialize: "Prepared ticket worktree",
    ticket_checkpoint: "Checkpointed ticket candidate",
    ticket_publish: "Integrated ticket candidate",
    target_sync: "Synchronized target into run workspace",
    target_publish: "Published run to target branch",
    forward_compensation: "Recorded forward Git compensation",
    ticket_retire: "Retired ticket worktree",
    ticket_supersede: "Archived superseded ticket worktree",
    run_retire: "Retired run workspace",
    abandoned_run_retire: "Retired abandoned Koni workspaces",
    legacy_run_relocate: "Relocated legacy run workspace",
    legacy_run_retire: "Retired legacy run workspace",
  };
  return labels[kind];
}

export function canonicalJsonHash(value: unknown): Sha256Digest {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Git authority value is not JSON serializable");
  return canonicalHash(JSON.parse(encoded) as JsonValue);
}

export function samePostProduct(
  left: Readonly<RunPostOrchestrationBinding> | undefined,
  right: Readonly<RunPostOrchestrationBinding> | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.runOid === right.runOid &&
    left.targetOid === right.targetOid &&
    left.graphHash === right.graphHash
  );
}

export function requiredBehaviorProductBinding(
  run: Readonly<RunRecord>,
  stageId: string,
  recordedAt: string,
): RunPostOrchestrationBinding {
  const synchronization = run.git.targetSynchronization;
  if (
    run.behavior === undefined ||
    run.graphHash === undefined ||
    run.git.run.headOid === undefined ||
    synchronization?.status !== "synchronized" ||
    synchronization.runOid === undefined ||
    synchronization.runOid !== run.git.run.headOid
  ) {
    throw new AuthorityRpcError(
      "post_orchestration_binding",
      "post-orchestration stage is not bound to an exact synchronized run and graph",
    );
  }
  return {
    stageId,
    runOid: synchronization.runOid,
    targetOid: synchronization.targetOid,
    graphHash: run.graphHash,
    recordedAt,
  };
}

export function verificationCompilationSha256(
  value: Readonly<VerificationCompilation>,
): Sha256Digest {
  return canonicalJsonHash({
    ok: value.ok,
    reason: value.reason ?? null,
    applicableTicketIds: value.applicableTicketIds ?? [],
    report: value.report === undefined ? null : reportPublicationMaterial(value.report),
    activity: value.activity ?? [],
    artifactWrites: (value.artifactWrites ?? []).map((write) => ({
      path: write.path,
      sha256: rawSha256(write.bytes),
      sizeBytes: write.bytes.byteLength,
      expectedSha256: write.expectedSha256 ?? null,
    })),
  });
}

export function ticketGitScope(ticket: TicketRecord): GitPathScope {
  const allowed: GitPathScope["allowed"] = [...new Set(ticket.writePaths)]
    .sort()
    .map((configured) =>
      configured === "."
        ? { kind: "glob" as const, pattern: "**" }
        : { kind: "prefix" as const, path: configured.replace(/^\.\//u, "").replace(/\/$/u, "") },
    );
  return { allowed };
}

/** Return the fresh execution epoch required when checkout allocation replaces a retired cycle. */
export function replacementTicketExecutionEpoch(
  run: Readonly<RunRecord>,
  ticket: Readonly<TicketRecord>,
): number | undefined {
  if (ticket.gitCycleId === undefined) return undefined;
  const cycle = run.git.ticketCycles[ticket.gitCycleId];
  if (cycle === undefined || new Set(["active", "candidate"]).has(cycle.status)) return undefined;
  if (currentSourceCorrectionSeed(run, ticket) !== undefined) return undefined;
  return currentTicketExecutionEpoch(run, ticket) + 1;
}

/** Refresh a clean checkout when completed dependencies advanced the run ref. */
export function shouldRefreshUnusedTicketCycle(
  run: Readonly<RunRecord>,
  ticket: Readonly<TicketRecord>,
  cycle: Readonly<RunRecord["git"]["ticketCycles"][string]>,
): boolean {
  if (
    !new Set(["queued", "running"]).has(ticket.status) ||
    cycle.status !== "active" ||
    cycle.ticketId !== ticket.id ||
    run.git.run.headOid === undefined ||
    cycle.baseRunOid === run.git.run.headOid
  ) {
    return false;
  }
  return (
    cycle.ticketHeadOid === cycle.baseRunOid ||
    (ticket.status === "queued" && ticket.steps.every((step) => step.status === "pending"))
  );
}

/** Refresh a historical synthetic integration checkout that never materialized its candidate. */
export function shouldRefreshIntegrationCandidateCycle(
  ticket: Readonly<TicketRecord>,
  cycle: Readonly<RunRecord["git"]["ticketCycles"][string]>,
  integrationCandidateOid: string | undefined,
): boolean {
  return (
    integrationCandidateOid !== undefined &&
    cycle.status === "active" &&
    cycle.ticketId === ticket.id &&
    cycle.ticketHeadOid === cycle.baseRunOid
  );
}

/**
 * A scientific contract rejection can invalidate the reviewed producer that authored it. A
 * missing runtime/toolchain dependency cannot: no scientific subject ran, so reopening completed
 * graph or asset work would misattribute an operator-environment failure to already-reviewed work.
 */
export function configuredCheckResultRequiresDependencyReopen(
  compiled: Readonly<Pick<CompiledAgentCheckResult, "accepted" | "infrastructureFailure">>,
): boolean {
  return !compiled.accepted && compiled.infrastructureFailure === undefined;
}

/**
 * Reset only completed direct dependencies that authored the configured-check consumer's graph
 * seam. Both launch preflight failures and authenticated result rejections use this projection so
 * the same reviewed producer receives the exact contract diagnosis.
 */
export function reopenCompletedConfiguredCheckDependencies(
  run: Pick<RunRecord, "tickets" | "git">,
  consumerTicketId: string,
  blocker: string,
  at: string,
  retainedProducerIds?: readonly string[],
  diagnosis?: Readonly<{
    kind: "configured_check_preflight" | "configured_check_result";
    sourceSha256: Sha256Digest;
  }>,
): string[] {
  const consumer = run.tickets[consumerTicketId];
  if (consumer === undefined) return [];
  const producerIds =
    retainedProducerIds ?? completedConfiguredCheckDependencyIds(run, consumerTicketId);
  const producers = producerIds
    .map((ticketId) => run.tickets[ticketId])
    .filter((ticket): ticket is TicketRecord => ticket !== undefined)
    .filter((ticket) => ticket.status === "completed");
  for (const producer of producers) {
    resetTicketForFreshCycle(producer, at, currentTicketExecutionEpoch(run, producer));
    producer.blocker = blocker;
    if (diagnosis !== undefined) {
      const material = {
        protocol: "koni.ticket-compiler-reissue-diagnosis.v1" as const,
        kind: diagnosis.kind,
        sourceTicketId: consumerTicketId,
        executionEpoch: producer.executionEpoch!,
        blocker,
        sourceSha256: diagnosis.sourceSha256,
        openedAt: at,
      };
      producer.compilerReissueDiagnoses ??= [];
      producer.compilerReissueDiagnoses.push({ ...material, sha256: canonicalHash(material) });
    }
  }
  return producers.map(({ id }) => id);
}

export function completedConfiguredCheckDependencyIds(
  run: Pick<RunRecord, "tickets">,
  consumerTicketId: string,
): string[] {
  const consumer = run.tickets[consumerTicketId];
  if (consumer === undefined) return [];
  const consumerNodeIds = new Set([
    ...consumer.targetNodeIds,
    ...(consumer.readNodeIds ?? []),
    ...(consumer.writeNodeIds ?? []),
  ]);
  // Reconciliation intentionally removes satisfied dependency edges. A scientific runner can
  // therefore reject its result after the direct compile-run-plan edge has disappeared from the
  // regenerated board. Preserve the same ownership proof by falling back only to completed
  // compile-run-plan tickets that authored the consumer's exact node seam.
  const directOrPlanProducerIds =
    consumer.dependencyIds.length > 0
      ? consumer.dependencyIds
      : Object.values(run.tickets)
          .filter(
            (ticket) =>
              ticket.id !== consumer.id && ticket.operationId === "execution.node.compile-run-plan",
          )
          .map(({ id }) => id);
  const satisfiedAssetProducerIds = Object.values(run.tickets)
    .filter(
      (ticket) =>
        ticket.status === "completed" &&
        ticket.operationId === "asset-resolution.asset.implement-asset",
    )
    .filter((ticket) => {
      const authoredNodeIds = [
        ...(ticket.writeNodeIds ?? []),
        ...(ticket.writeNodeIds === undefined || ticket.writeNodeIds.length === 0
          ? ticket.targetNodeIds
          : []),
      ];
      return authoredNodeIds.some((nodeId) => consumerNodeIds.has(nodeId));
    })
    .map(({ id }) => id);
  const candidateIds = [...new Set([...directOrPlanProducerIds, ...satisfiedAssetProducerIds])];
  return candidateIds
    .map((ticketId) => run.tickets[ticketId])
    .filter((ticket): ticket is TicketRecord => ticket !== undefined)
    .filter((ticket) => ticket.status === "completed")
    .filter((ticket) => {
      const authoredNodeIds = [
        ...(ticket.writeNodeIds ?? []),
        ...(ticket.writeNodeIds === undefined || ticket.writeNodeIds.length === 0
          ? ticket.targetNodeIds
          : []),
      ];
      return authoredNodeIds.some((nodeId) => consumerNodeIds.has(nodeId));
    })
    .map(({ id }) => id);
}

export function resetTicketForFreshCycle(
  ticket: TicketRecord,
  at: string,
  currentEpoch: number,
): void {
  ticket.executionEpoch = currentEpoch + 1;
  delete ticket.gitCycleId;
  ticket.worktreePath = undefined;
  ticket.branch = undefined;
  ticket.status = "queued";
  ticket.blocker = undefined;
  ticket.updatedAt = at;
  for (const step of ticket.steps) {
    step.status = "pending";
    step.summary = undefined;
    step.startedAt = undefined;
    step.completedAt = undefined;
  }
}

/**
 * A rule-board refresh may retire a never-started terminal resolver while a newly projected
 * repair dependency or another recovery lane temporarily owns the same failure. Once the source
 * has no unsettled dependencies, that exact immutable resolver is the compiler-authorized path
 * that can release the still-terminal source. Re-arm only the pristine cancellation; any started
 * or differently bound resolver remains audit.
 */
export function shouldRearmCancelledTerminalResolver(
  run: Pick<RunRecord, "tickets">,
  source: Readonly<TicketRecord>,
  resolver: Readonly<TicketRecord>,
  failureBindingSha256: Sha256Digest,
): boolean {
  const recovery = resolver.executionControl?.terminalRecovery;
  return (
    source.status === "blocked" &&
    source.dependencyIds.every((dependencyId) =>
      ticketDependencySettled(run.tickets[dependencyId]),
    ) &&
    resolver.status === "cancelled" &&
    resolver.blocker === "Superseded before execution by newer compiler state" &&
    resolver.gitCycleId === undefined &&
    resolver.worktreePath === undefined &&
    resolver.branch === undefined &&
    recovery?.sourceTicketId === source.id &&
    recovery.failureBindingSha256s.length === 1 &&
    recovery.failureBindingSha256s[0] === failureBindingSha256 &&
    resolver.steps.length > 0 &&
    resolver.steps.every((step) => step.status === "skipped" && step.attemptIds.length === 0)
  );
}

/** Whether settled or freshly reissued ordinary work can be retired by current rule authority. */
export function shouldRetireInapplicableTicket(
  ticket: Readonly<TicketRecord>,
  applicableIds: ReadonlySet<string>,
  unsettledIntegrationSourceIds: ReadonlySet<string> = new Set(),
  currentCorrectionSourceIds: ReadonlySet<string> = new Set(),
): boolean {
  if (ticket.status === "queued" && currentCorrectionSourceIds.has(ticket.id)) return false;
  if (
    applicableIds.has(ticket.id) ||
    unsettledIntegrationSourceIds.has(ticket.id) ||
    ticket.integrationForTicketId !== undefined ||
    ticket.executionControl?.controlTicketAuthority !== undefined ||
    ticket.executionControl?.proposalRequest !== undefined ||
    ticket.executionControl?.sourceHold !== undefined
  )
    return false;
  if (ticket.status === "blocked") return true;
  return (
    ticket.status === "queued" &&
    ticket.steps.every((step) => step.status === "pending") &&
    (ticket.steps.some((step) => step.attemptIds.length > 0) ||
      (ticket.gitCycleId !== undefined &&
        ticket.worktreePath !== undefined &&
        ticket.branch !== undefined &&
        ticket.steps.every((step) => step.attemptIds.length === 0)))
  );
}

export function currentSourceCorrectionTicketIds(run: Readonly<RunRecord>): ReadonlySet<string> {
  return new Set(
    Object.values(run.tickets)
      .filter((ticket) => currentSourceCorrectionSeed(run, ticket) !== undefined)
      .map((ticket) => ticket.id),
  );
}

export function unsettledIntegrationSourceTicketIds(run: Readonly<RunRecord>): ReadonlySet<string> {
  return new Set(
    Object.values(run.tickets)
      .filter(
        (ticket) =>
          ticket.integrationForTicketId !== undefined &&
          ticket.status !== "completed" &&
          ticket.status !== "cancelled",
      )
      .map((ticket) => ticket.integrationForTicketId!),
  );
}

export function terminalFailureBinding(
  run: Readonly<RunRecord>,
  ticket: Readonly<TicketRecord>,
):
  | Readonly<{
      stepId: string;
      attemptId: string;
      launchSpecHash: Sha256Digest;
      terminalPolicySha256: Sha256Digest;
      terminalOutputSha256: Sha256Digest;
      failureSettlementSha256: Sha256Digest;
      failureProof: import("../state/run-record.js").TerminalFailureSettlementProof;
      sha256: Sha256Digest;
    }>
  | undefined {
  const step = [...ticket.steps].reverse().find((candidate) => candidate.status === "failed");
  const attemptId = step?.attemptIds.at(-1);
  return attemptId === undefined
    ? undefined
    : terminalFailureBindingsForTicket(run, ticket).get(attemptId);
}

export function rejectedSourceReissueCount(
  run: Readonly<RunRecord>,
  source: Readonly<TicketRecord>,
): number {
  return Object.values(run.tickets).filter(
    (ticket) =>
      ticket.executionControl?.proposalRequest?.sourceTicketId === source.id &&
      ticket.executionControl.proposalDisposition?.kind === "rejected",
  ).length;
}

/**
 * Convert one exhausted proposal review into a terminal compiler-owned return-to-source marker.
 * Ordinary tickets deliberately return false and retain the supervised review boundary.
 */
export function routeExhaustedProposalReviewToSource(
  run: RunRecord,
  proposalTicketId: string,
  recordedAt: string,
): boolean {
  const proposal = run.tickets[proposalTicketId];
  if (proposal === undefined) return false;
  const proof = deriveProposalReviewExhaustionAuthority(run, proposal);
  if (proof === undefined) return false;
  proposal.executionControl!.proposalReviewExhaustion = proof;
  proposal.status = "cancelled";
  proposal.updatedAt = recordedAt;
  return true;
}

export function sourceCorrectionSeedForRelease(
  run: Readonly<RunRecord>,
  source: Readonly<TicketRecord>,
  proposal: Readonly<TicketRecord>,
  release: Readonly<SourceReleaseDecision>,
  recordedAt: string,
): SourceCorrectionSeedAuthority | undefined {
  const route = sourceCorrectionSeedRoute(run, source, proposal);
  const request = proposal.executionControl?.proposalRequest;
  const authority = proposal.executionControl?.controlTicketAuthority;
  const causal = authority?.causal;
  const cycle =
    source.gitCycleId === undefined ? undefined : run.git.ticketCycles[source.gitCycleId];
  if (
    route === undefined ||
    release.disposition !== "release" ||
    request === undefined ||
    authority?.role !== "proposal" ||
    causal?.role !== "proposal" ||
    cycle?.ticketId !== source.id ||
    cycle.status !== "retired" ||
    cycle.archiveRef === undefined ||
    cycle.supersessionSha256 !== request.requestSha256 ||
    cycle.ticketHeadOid === cycle.baseRunOid
  ) {
    return undefined;
  }
  const priorExecutionEpoch = currentTicketExecutionEpoch(run, source);
  const material = {
    protocol: "koni.source-correction-seed.v1" as const,
    runId: run.id,
    ticketId: source.id,
    proposalTicketId: proposal.id,
    requestSha256: request.requestSha256,
    route,
    releaseDecisionSha256: release.sha256,
    archivedCycleId: cycle.cycleId,
    archiveRef: cycle.archiveRef,
    candidateBaseOid: cycle.baseRunOid,
    candidateOid: cycle.ticketHeadOid,
    candidateProjection: structuredClone(causal.sourceTicketProjection),
    releaseProjection: ticketImmutableProjection(source),
    priorExecutionEpoch,
    nextExecutionEpoch: priorExecutionEpoch + 1,
    recordedAt,
  };
  return { ...material, sha256: canonicalHash(material) };
}

export function proposalReviewAuthoritySha256(
  attempt: Readonly<AgentAttemptRecord>,
  approvalSha256: Sha256Digest,
): Sha256Digest {
  if (
    attempt.terminalPolicy === undefined ||
    attempt.terminalOutputSha256 === undefined ||
    attempt.terminalAcceptedAt === undefined
  ) {
    throw new AuthorityRpcError(
      "change_control_review_authority",
      `review attempt ${attempt.id} lacks accepted terminal-policy authority`,
    );
  }
  return canonicalHash({
    protocol: "koni.proposal-review-authority.v1",
    attemptId: attempt.id,
    launchSpecHash: attempt.launchSpecHash,
    approvalSha256,
    terminalPolicySha256: attempt.terminalPolicy.sha256,
    terminalOutputSha256: attempt.terminalOutputSha256,
    terminalAcceptedAt: attempt.terminalAcceptedAt,
  });
}

export function ticketReviewAttemptId(run: RunRecord, ticketId: string): string | undefined {
  const ticket = run.tickets[ticketId];
  if (ticket === undefined) return undefined;
  const reviewStepIds = new Set(
    ticket.steps.filter((step) => step.kind === "review").map((step) => step.id),
  );
  return Object.values(run.attempts)
    .filter(
      (attempt) =>
        attempt.ticketId === ticketId &&
        reviewStepIds.has(attempt.stepId) &&
        attempt.status === "completed",
    )
    .sort(
      (left, right) =>
        (right.endedAt ?? right.startedAt ?? "").localeCompare(
          left.endedAt ?? left.startedAt ?? "",
        ) || right.id.localeCompare(left.id),
    )[0]?.id;
}

export function retainTicketAuthorityFields(
  previous: Readonly<Pick<RunRecord, "tickets" | "git">>,
  compiled: Record<string, TicketRecord>,
): Record<string, TicketRecord> {
  for (const [ticketId, ticket] of Object.entries(compiled)) {
    const prior = previous.tickets[ticketId];
    if (prior === undefined) continue;
    if (prior.reviewReworkCount !== undefined) ticket.reviewReworkCount = prior.reviewReworkCount;
    if (prior.reviewReworks !== undefined)
      ticket.reviewReworks = structuredClone(prior.reviewReworks);
    if (prior.compilerReissueDiagnoses !== undefined)
      ticket.compilerReissueDiagnoses = structuredClone(prior.compilerReissueDiagnoses);
    const recurringAsset =
      ticket.status === "queued" &&
      ticket.operationId === "asset-resolution.asset.implement-asset" &&
      ticket.steps.every((step) => step.status === "pending");
    const priorCycle =
      prior.gitCycleId === undefined ? undefined : previous.git.ticketCycles[prior.gitCycleId];
    const recurringAssetReissue =
      recurringAsset &&
      (prior.status === "completed" ||
        (prior.status === "cancelled" &&
          prior.blocker === COMPILER_INAPPLICABLE_TICKET &&
          prior.gitCycleId === undefined &&
          prior.worktreePath === undefined &&
          prior.branch === undefined &&
          prior.steps.length > 0 &&
          prior.steps.every((step) => step.status === "skipped")) ||
        (prior.status === "queued" && priorCycle?.status === "retired"));
    if (recurringAssetReissue) {
      resetTicketForFreshCycle(
        ticket,
        ticket.updatedAt,
        currentTicketExecutionEpoch(previous, prior),
      );
      continue;
    }
    if (prior.gitCycleId === undefined) delete ticket.gitCycleId;
    else ticket.gitCycleId = prior.gitCycleId;
    if (prior.executionEpoch === undefined) delete ticket.executionEpoch;
    else ticket.executionEpoch = prior.executionEpoch;
    ticket.worktreePath = prior.worktreePath;
    ticket.branch = prior.branch;
    if (prior.integrationForTicketId === undefined) delete ticket.integrationForTicketId;
    else ticket.integrationForTicketId = prior.integrationForTicketId;
    if (prior.integrationCandidateOid === undefined) delete ticket.integrationCandidateOid;
    else ticket.integrationCandidateOid = prior.integrationCandidateOid;
  }
  return compiled;
}

export function appendRecurringAssetGrantRefreshAuthorities(
  previous: Readonly<RunRecord>,
  compiled: Record<string, TicketRecord>,
  action: Readonly<RunActionExecutionRecord>,
  nextGraphHash: Sha256Digest,
  nextGraphRevision: number,
  recordedAt: string,
): Sha256Digest[] {
  if (
    previous.graphHash === undefined ||
    nextGraphRevision !== previous.graphRevision + 1 ||
    action.boundary.kind !== "assignment_validation" ||
    previous.actionExecutions?.[action.invocationId]?.boundary.sha256 !== action.boundary.sha256
  ) {
    throw new AuthorityRpcError(
      "recurring_asset_grant_refresh",
      "recurring-asset grant refresh lacks an exact graph-changing compiler action",
    );
  }
  const refreshSha256s: Sha256Digest[] = [];
  for (const [ticketId, ticket] of Object.entries(compiled)) {
    const prior = previous.tickets[ticketId];
    if (
      prior === undefined ||
      prior.operationId !== "asset-resolution.asset.implement-asset" ||
      ticket.operationId !== prior.operationId ||
      ticket.status !== "queued" ||
      ticket.executionEpoch !== (prior.executionEpoch ?? 0) + 1
    ) {
      continue;
    }
    const priorProjection = ticketImmutableProjection(prior);
    const refreshedProjection = ticketImmutableProjection(ticket);
    if (priorProjection.sha256 === refreshedProjection.sha256) continue;
    const material = {
      protocol: "koni.recurring-asset-grant-refresh.v1" as const,
      runId: previous.id,
      ticketId,
      configurationSha256: previous.compiledConfigHash,
      actionInvocationId: action.invocationId,
      actionBoundarySha256: action.boundary.sha256,
      priorGraphHash: previous.graphHash,
      priorGraphRevision: previous.graphRevision,
      nextGraphHash,
      nextGraphRevision,
      priorProjection,
      priorProjectionSha256: priorProjection.sha256,
      refreshedProjection,
      nextProjectionSha256: refreshedProjection.sha256,
      priorExecutionEpoch: prior.executionEpoch ?? 0,
      nextExecutionEpoch: ticket.executionEpoch,
      recordedAt,
    };
    const refresh: RecurringAssetGrantRefreshAuthority = {
      ...material,
      sha256: canonicalHash(material),
    };
    ticket.executionControl ??= {};
    ticket.executionControl.recurringAssetGrantRefreshes ??= [];
    ticket.executionControl.recurringAssetGrantRefreshes.push(refresh);
    refreshSha256s.push(refresh.sha256);
  }
  return refreshSha256s.sort(compareUtf8);
}

export function appendHeldSourceGrantRefreshAuthorities(
  previous: Readonly<RunRecord>,
  compiled: Record<string, TicketRecord>,
  action: Readonly<RunActionExecutionRecord>,
  nextGraphHash: Sha256Digest,
  nextGraphRevision: number,
  recordedAt: string,
): Sha256Digest[] {
  if (
    previous.graphHash === undefined ||
    nextGraphRevision !== previous.graphRevision + 1 ||
    action.boundary.kind !== "assignment_validation" ||
    previous.actionExecutions?.[action.invocationId]?.boundary.sha256 !== action.boundary.sha256
  ) {
    throw new AuthorityRpcError(
      "held_source_grant_refresh",
      "held-source grant refresh lacks an exact graph-changing compiler action",
    );
  }
  const application =
    action.boundary.ticketId === undefined ? undefined : previous.tickets[action.boundary.ticketId];
  const applicationAuthority = application?.executionControl?.controlTicketAuthority;
  const applicationCausal =
    applicationAuthority?.causal.role === "approved_application"
      ? applicationAuthority.causal
      : undefined;
  if (application === undefined || applicationCausal === undefined) return [];
  const refreshSha256s: Sha256Digest[] = [];
  for (const [ticketId, ticket] of Object.entries(compiled)) {
    const prior = previous.tickets[ticketId];
    const hold = prior?.executionControl?.sourceHold;
    if (
      prior === undefined ||
      hold === undefined ||
      hold.proposalTicketId !== application.executionControl?.sourceProposalTicketId ||
      applicationCausal.materialization.proposalTicketId !== hold.proposalTicketId ||
      prior.status !== "blocked" ||
      ticket.status !== "blocked" ||
      ticket.gitCycleId === undefined ||
      ticket.gitCycleId !== prior.gitCycleId ||
      canonicalHash(ticket.executionControl?.sourceHold) !== canonicalHash(hold)
    ) {
      continue;
    }
    const priorProjection = ticketImmutableProjection(prior);
    const refreshedProjection = ticketImmutableProjection(ticket);
    if (priorProjection.sha256 === refreshedProjection.sha256) continue;
    const material = {
      protocol: "koni.held-source-grant-refresh.v1" as const,
      runId: previous.id,
      ticketId,
      proposalTicketId: hold.proposalTicketId,
      applicationTicketId: application.id,
      configurationSha256: previous.compiledConfigHash,
      actionInvocationId: action.invocationId,
      actionBoundarySha256: action.boundary.sha256,
      priorGraphHash: previous.graphHash,
      priorGraphRevision: previous.graphRevision,
      nextGraphHash,
      nextGraphRevision,
      priorProjection,
      priorProjectionSha256: priorProjection.sha256,
      refreshedProjection,
      nextProjectionSha256: refreshedProjection.sha256,
      executionEpoch: prior.executionEpoch ?? 0,
      sourceCycleId: prior.gitCycleId,
      recordedAt,
    };
    const refresh: HeldSourceGrantRefreshAuthority = {
      ...material,
      sha256: canonicalHash(material),
    };
    ticket.executionControl ??= {};
    ticket.executionControl.heldSourceGrantRefreshes ??= [];
    ticket.executionControl.heldSourceGrantRefreshes.push(refresh);
    refreshSha256s.push(refresh.sha256);
  }
  return refreshSha256s.sort(compareUtf8);
}

export function integrationCandidateOidFromPredecessor(
  run: Readonly<RunRecord>,
  ticket: Readonly<TicketRecord>,
): string | undefined {
  if (ticket.integrationForTicketId === undefined) return undefined;
  const predecessor = run.tickets[ticket.integrationForTicketId];
  const cycleId = predecessor?.gitCycleId;
  return cycleId === undefined ? undefined : run.git.ticketCycles[cycleId]?.ticketHeadOid;
}

export function applyAssignmentRuleAuthorityEvidence(
  run: RunRecord,
  evidence: JsonValue | null | undefined,
): void {
  if (evidence === undefined) return;
  if (evidence === null) delete run.ruleAuthorityEvidence;
  else run.ruleAuthorityEvidence = structuredClone(evidence);
}

export function appendReportPublication(run: RunRecord, report: RunReportRecord | undefined): void {
  if (report === undefined) return;
  run.reports ??= [];
  const existing = run.reports.find((candidate) => candidate.reportId === report.reportId);
  if (existing !== undefined) {
    if (
      canonicalJsonHash(reportPublicationMaterial(existing)) !==
      canonicalJsonHash(reportPublicationMaterial(report))
    ) {
      throw new AuthorityRpcError(
        "report_identity",
        "report publication identity collided with different content",
      );
    }
    return;
  }
  run.reports.push(structuredClone(report));
}

export function reportPublicationMaterial(
  report: RunReportRecord,
): Omit<RunReportRecord, "compiledAt"> {
  const { compiledAt: _compiledAt, ...material } = report;
  return material;
}
