import {
  createActionExecutionJournal,
  prepareActionInvocation,
  validateActionExecutionJournal,
} from "../compiler/action-recipes.js";
import type { ActionExecutionJournal, ActionPrimitiveHost } from "../contracts/behavior.js";
import type { ConfigurationObject, ConfigurationValue } from "../contracts/configuration.js";
import { canonicalHash, type Sha256Digest } from "../shared/canonical.js";
import type {
  RunActionBoundaryKind,
  RunActionEffectReceipt,
  RunActionExecutionRecord,
  RunRecord,
} from "../state/run-record.js";
import { configuredTicketState } from "./configured-lifecycle.js";

export interface PrepareRunActionInput {
  readonly kind: RunActionBoundaryKind;
  readonly stageId: string;
  readonly selector: string;
  readonly actor?: "compiler" | "lead";
  readonly checkout: "none" | "main" | "ticket";
  readonly parameters?: ConfigurationObject;
  readonly ticketId?: string;
  readonly ticketState?: string;
  readonly stepId?: string;
  readonly attemptId?: string;
  readonly cycleId?: string;
  readonly productSha256?: Sha256Digest;
  readonly parentInvocationId?: string;
  readonly values?: ConfigurationObject;
  readonly at: string;
}

/**
 * Prepare one immutable configured action from an already-pinned run behavior.
 *
 * Callers do not supply an invocation identity. It is derived from the exact run/config epoch and
 * named compiler boundary, making retries discover the same durable record without giving a UI or
 * model permission to choose a catalog entry.
 */
export function prepareRunActionExecution(
  run: Readonly<RunRecord>,
  input: Readonly<PrepareRunActionInput>,
): RunActionExecutionRecord {
  const behavior = run.behavior;
  if (behavior === undefined)
    throw new RunActionAuthorityError(
      "behavior_missing",
      "legacy run has no pinned action catalog",
    );
  assertBoundarySelection(run, input);
  const identityMaterial = {
    protocol: "koni.run-action-invocation-identity.v1",
    runId: run.id,
    compiledConfigHash: run.compiledConfigHash,
    behaviorSha256: behavior.sha256,
    generation: run.generation,
    admittedRunRevision: run.revision,
    kind: input.kind,
    stageId: input.stageId,
    selector: input.selector,
    ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
    ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
    ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    ...(input.cycleId === undefined ? {} : { cycleId: input.cycleId }),
    ...(input.productSha256 === undefined ? {} : { productSha256: input.productSha256 }),
    ...(input.parentInvocationId === undefined
      ? {}
      : { parentInvocationId: input.parentInvocationId }),
  };
  const identitySha256 = canonicalHash(identityMaterial);
  const invocationId = `action-${identitySha256.slice("sha256:".length)}`;
  const boundaryMaterial = {
    protocol: "koni.run-action-boundary.v1" as const,
    kind: input.kind,
    boundaryId: `boundary-${identitySha256.slice("sha256:".length, "sha256:".length + 24)}`,
    runId: run.id,
    compiledConfigHash: run.compiledConfigHash,
    behaviorSha256: behavior.sha256,
    generation: run.generation,
    admittedRunRevision: run.revision,
    stageId: input.stageId,
    ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
    ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
    ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    ...(input.cycleId === undefined ? {} : { cycleId: input.cycleId }),
    ...(input.productSha256 === undefined ? {} : { productSha256: input.productSha256 }),
    ...(input.parentInvocationId === undefined
      ? {}
      : { parentInvocationId: input.parentInvocationId }),
  };
  const boundary = { ...boundaryMaterial, sha256: canonicalHash(boundaryMaterial) };
  if (input.values?.authority !== undefined) {
    throw new RunActionAuthorityError(
      "authority_context_override",
      "configured action values cannot replace the compiler-issued authority binding",
    );
  }
  const contextValues: ConfigurationObject = {
    ...(input.values ?? {}),
    authority: {
      boundaryProtocol: boundary.protocol,
      boundaryId: boundary.boundaryId,
      boundarySha256: boundary.sha256,
      kind: boundary.kind,
      runRevision: boundary.admittedRunRevision,
      generation: boundary.generation,
      compiledConfigHash: boundary.compiledConfigHash,
      behaviorSha256: boundary.behaviorSha256,
      stageId: boundary.stageId,
      ...(boundary.ticketId === undefined ? {} : { ticketId: boundary.ticketId }),
      ...(boundary.stepId === undefined ? {} : { stepId: boundary.stepId }),
      ...(boundary.attemptId === undefined ? {} : { attemptId: boundary.attemptId }),
      ...(boundary.cycleId === undefined ? {} : { cycleId: boundary.cycleId }),
      ...(boundary.productSha256 === undefined ? {} : { productSha256: boundary.productSha256 }),
      ...(boundary.parentInvocationId === undefined
        ? {}
        : { parentInvocationId: boundary.parentInvocationId }),
    },
  };
  const plan = prepareActionInvocation({
    catalog: behavior.actions,
    selector: input.selector,
    invocationId,
    actor: input.actor ?? "compiler",
    ...(input.parameters === undefined ? {} : { parameters: input.parameters }),
    context: {
      runId: run.id,
      ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
      ...(input.ticketState === undefined ? {} : { ticketState: input.ticketState }),
      checkout: input.checkout,
      values: contextValues,
    },
  });
  const journal = createActionExecutionJournal(plan);
  return {
    protocol: "koni.run-action-execution.v1",
    invocationId,
    boundary,
    plan,
    journal,
    effects: {},
    // The caller persists this record by advancing the run exactly once.
    expectedRunRevision: run.revision + 1,
    createdAt: input.at,
    updatedAt: input.at,
  };
}

/** Preserve an exact journal transition and advance the action's internal run-revision CAS. */
export function withRunActionJournal(
  record: Readonly<RunActionExecutionRecord>,
  journal: Readonly<ActionExecutionJournal>,
  nextRunRevision: number,
  at: string,
): RunActionExecutionRecord {
  const validated = validateActionExecutionJournal(record.plan, journal);
  if (
    !Number.isSafeInteger(nextRunRevision) ||
    nextRunRevision !== record.expectedRunRevision + 1
  ) {
    throw new RunActionAuthorityError(
      "revision_transition",
      "action journal did not advance the exact expected run revision",
    );
  }
  return {
    ...structuredClone(record),
    journal: structuredClone(validated),
    expectedRunRevision: nextRunRevision,
    updatedAt: at,
  };
}

export type RunActionPrimitiveInput = Parameters<ActionPrimitiveHost["execute"]>[0];

/** Create a receipt whose complete replay identity includes plan, context, primitive, and args. */
export function createRunActionEffectReceipt(
  input: Readonly<RunActionPrimitiveInput>,
  output: ConfigurationValue,
  at: string,
): RunActionEffectReceipt {
  const material = {
    protocol: "koni.run-action-effect-receipt.v1" as const,
    effectKey: input.effectKey,
    planSha256: input.planSha256,
    actionId: input.actionId,
    phase: input.phase,
    stepId: input.step.id,
    primitive: input.step.primitive,
    argumentsSha256: canonicalHash(input.step.arguments),
    contextSha256: canonicalHash(input.context),
    output: structuredClone(output),
    outputSha256: canonicalHash(output),
    recordedAt: at,
  };
  return { ...material, sha256: canonicalHash(material) };
}

/** Exact replay succeeds; effect-key reuse with any changed material is a hard error. */
export function replayRunActionEffect(
  receipt: Readonly<RunActionEffectReceipt>,
  input: Readonly<RunActionPrimitiveInput>,
): ConfigurationValue {
  const expected = {
    effectKey: input.effectKey,
    planSha256: input.planSha256,
    actionId: input.actionId,
    phase: input.phase,
    stepId: input.step.id,
    primitive: input.step.primitive,
    argumentsSha256: canonicalHash(input.step.arguments),
    contextSha256: canonicalHash(input.context),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (receipt[key as keyof RunActionEffectReceipt] !== value) {
      throw new RunActionAuthorityError(
        "effect_replay_mismatch",
        `action effect key was reused with different ${key}`,
      );
    }
  }
  if (canonicalHash(receipt.output) !== receipt.outputSha256) {
    throw new RunActionAuthorityError(
      "effect_receipt_hash",
      "action effect receipt output hash is invalid",
    );
  }
  return structuredClone(receipt.output);
}

export function assertRunActionCurrent(
  run: Readonly<RunRecord>,
  record: Readonly<RunActionExecutionRecord>,
): void {
  if (run.revision !== record.expectedRunRevision) {
    throw new RunActionAuthorityError(
      "stale_revision",
      `action expected run revision ${record.expectedRunRevision}, current revision is ${run.revision}`,
    );
  }
  if (run.generation !== record.boundary.generation) {
    throw new RunActionAuthorityError(
      "stale_generation",
      "action belongs to an earlier run generation",
    );
  }
  if (
    run.compiledConfigHash !== record.boundary.compiledConfigHash ||
    run.behavior?.sha256 !== record.boundary.behaviorSha256 ||
    run.behavior?.actions.sha256 !== record.plan.catalogSha256
  ) {
    throw new RunActionAuthorityError(
      "configuration_drift",
      "action differs from the pinned run behavior or catalog",
    );
  }
  if (run.lifecycle.phase === "pausing" || run.lifecycle.phase === "paused") {
    throw new RunActionAuthorityError(
      "run_paused",
      "paused run refuses a new configured-action primitive",
    );
  }
  if (run.lifecycle.phase === "deleting" || run.lifecycle.phase === "deleted") {
    throw new RunActionAuthorityError(
      "run_deleted",
      "deleted run refuses a configured-action primitive",
    );
  }
  const boundary = record.boundary;
  if (boundary.ticketId !== undefined && boundary.kind !== "lead_launch") {
    const ticket = run.tickets[boundary.ticketId];
    if (ticket === undefined)
      throw new RunActionAuthorityError("ticket_missing", "action ticket no longer exists");
    const lifecycleMachine = run.lifecycleCatalog?.machines.ticket;
    const currentTicketState =
      lifecycleMachine === undefined
        ? ticket.status
        : configuredTicketState(lifecycleMachine, ticket.status);
    if (
      record.plan.context.ticketState !== undefined &&
      currentTicketState !== record.plan.context.ticketState
    ) {
      throw new RunActionAuthorityError(
        "ticket_state",
        "action ticket state changed after admission",
      );
    }
    if (
      boundary.stepId !== undefined &&
      !ticket.steps.some((step) => step.id === boundary.stepId)
    ) {
      throw new RunActionAuthorityError(
        "step_missing",
        "action step no longer exists in its ticket",
      );
    }
    if (boundary.cycleId !== undefined && ticket.gitCycleId !== boundary.cycleId) {
      throw new RunActionAuthorityError(
        "cycle_drift",
        "action ticket Git cycle changed after admission",
      );
    }
  }
  const selected = run.behavior.actions.actions[record.plan.actionId];
  if (selected === undefined || selected.sha256 !== record.plan.actionSha256) {
    throw new RunActionAuthorityError("action_drift", "action definition changed after admission");
  }
}

export class RunActionAuthorityError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunActionAuthorityError";
  }
}

function assertBoundarySelection(
  run: Readonly<RunRecord>,
  input: Readonly<PrepareRunActionInput>,
): void {
  const behavior = run.behavior!;
  let expected: string | undefined;
  if (input.kind === "approved_plan_compile") expected = behavior.runType.actionSelectors.compile;
  else if (input.kind === "post_orchestration_report")
    expected = behavior.runType.actionSelectors.report;
  else if (input.kind === "lead_launch") expected = behavior.runType.actionSelectors.lead;
  else if (input.kind === "assignment_validation") {
    expected =
      input.ticketId === undefined || input.stepId === undefined
        ? undefined
        : run.tickets[input.ticketId]?.steps.find((step) => step.id === input.stepId)
            ?.validationAction;
  } else if (input.kind === "configured_stage") {
    const stage = behavior.runType.pipeline.find((candidate) => candidate.id === input.stageId);
    expected =
      stage?.config.kind === "action" && !stage.config.compilerOwned && !stage.config.automatic
        ? stage.config.action
        : undefined;
  } else if (input.kind === "recovery") {
    const parent =
      input.parentInvocationId === undefined
        ? undefined
        : run.actionExecutions?.[input.parentInvocationId];
    expected =
      parent?.journal.status === "recovery_required" ? parent.journal.recoveryActionId : undefined;
  }
  const expectedId =
    expected === undefined ? undefined : (behavior.actions.aliases[expected] ?? expected);
  const suppliedId = behavior.actions.aliases[input.selector] ?? input.selector;
  if (expectedId === undefined || suppliedId !== expectedId) {
    throw new RunActionAuthorityError(
      "selector_authority",
      "action selector is not the exact compiler-selected boundary action",
    );
  }
  if (input.kind === "recovery" && input.parentInvocationId === undefined) {
    throw new RunActionAuthorityError(
      "recovery_parent",
      "recovery action requires one terminal parent invocation",
    );
  }
}
