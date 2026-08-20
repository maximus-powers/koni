import type { ConfigurationObject } from "../contracts/configuration.js";
import { type GitLifecycleIntent, type RunGitLifecycleRecord } from "../git/index.js";
import { canonicalEncode, isSha256Digest, type Sha256Digest } from "../shared/canonical.js";
import {
  CONFIG_DOCUMENT_DOMAINS,
  CONFIG_RESOURCE_KINDS,
  type ConfigDocumentDomain,
  type ConfigResourceKind,
} from "./config-documents.js";
import { authorityRequestHash } from "./project-store.js";
import type { JsonValue, RpcRequest } from "./protocol.js";
import {
  errorCode,
  errorMessage,
  isProviderExposureHoldBlocker,
  isRecord,
  toolString,
} from "./run-engine-shared.js";
import { AuthorityRpcError } from "./server.js";

import {
  saveQuestionBatchAnswer,
  type QuestionBatchQuestionInput,
  type QuestionBatchRecord,
  type QuestionBatchResolution,
} from "../state/question-batch.js";
import { type QuestionPolicy } from "../state/question-policy.js";
import {
  reduceRunLifecycle,
  type ResumableRunPhase,
  type RunLifecycleEvent,
  type RunPhase,
} from "../state/run-lifecycle.js";
import type {
  AgentAttemptRecord,
  AgentProviderRequestRecord,
  RunActionExecutionRecord,
  RunActivityRecord,
  RunQuestionRecord,
  RunRecord,
  TicketRecord,
} from "../state/run-record.js";
import { type StageActionFieldSchema, type StageCapability } from "../state/stage-capability.js";
import { authorizeConfiguredRunTransition, configuredTicketState } from "./configured-lifecycle.js";

import { MAX_PROVIDER_EXPOSURE_AUTO_RECOVERIES, RECEIPT_PARAMS } from "./run-engine-contracts.js";

export const RECONCILABLE_PHASES = new Set<RunPhase>([
  "planning",
  "approving",
  "executing",
  "verifying",
]);

/**
 * Attempt statuses that assert live work. `terminal_accepted` belongs here: the output is accepted
 * but the assignment has not settled, which is exactly the state observed wedging runs.
 */
export function reconcilableAttemptStatus(status: AgentAttemptRecord["status"]): boolean {
  return status === "queued" || status === "running" || status === "terminal_accepted";
}

/** A retired acceptance must carry no semantic proof, so an attempt holding one is never retired. */
export function hasTerminalSemanticProof(run: Readonly<RunRecord>, attemptId: string): boolean {
  return (
    Object.values(run.terminalSuccessProofs ?? {}).some((proof) => proof.attemptId === attemptId) ||
    Object.values(run.terminalFailureProofs ?? {}).some((proof) => proof.attemptId === attemptId)
  );
}

export function receiptFor(request: RpcRequest, result: JsonValue) {
  const receiptParams =
    (request as RpcRequest & { [RECEIPT_PARAMS]?: JsonValue })[RECEIPT_PARAMS] ?? request.params;
  return {
    method: request.method,
    idempotencyKey: request.idempotencyKey!,
    requestHash: authorityRequestHash(request.method, receiptParams),
    result,
  };
}

export function isStoppedPhase(phase: RunPhase): boolean {
  return phase === "pausing" || phase === "paused" || phase === "deleting" || phase === "deleted";
}

export function isPublicationIntent(
  intent: GitLifecycleIntent,
): intent is Extract<GitLifecycleIntent, { kind: "ticket_publish" | "target_publish" }> {
  return intent.kind === "ticket_publish" || intent.kind === "target_publish";
}

export function requireIdempotency(request: RpcRequest): void {
  if (request.idempotencyKey === undefined) {
    throw new AuthorityRpcError(
      "idempotency_required",
      "mutating Koni methods require an idempotency key",
    );
  }
}

export function requiredObject(value: JsonValue | undefined): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AuthorityRpcError("params", "request params must be an object");
  }
  return value;
}

export function assertExactParams(value: JsonValue | undefined, keys: readonly string[]): void {
  if (value === undefined && keys.length === 0) return;
  const object = requiredObject(value);
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new AuthorityRpcError(
      "params",
      `request params must contain exactly: ${expected.join(", ") || "no fields"}`,
    );
  }
}

export function assertAllowedParams(value: JsonValue | undefined, keys: readonly string[]): void {
  const object = requiredObject(value);
  const allowed = new Set(keys);
  const unexpected = Object.keys(object)
    .filter((key) => !allowed.has(key))
    .sort();
  if (unexpected.length > 0) {
    throw new AuthorityRpcError(
      "params",
      `request params contain unsupported fields: ${unexpected.join(", ")}`,
    );
  }
}

export function requiredString(value: JsonValue | undefined, key: string): string {
  const object = requiredObject(value);
  const field = object[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new AuthorityRpcError("params", `${key} must be a nonempty string`);
  }
  return field;
}

export function requiredStringValue(value: JsonValue | undefined, key: string): string {
  const field = requiredObject(value)[key];
  if (typeof field !== "string") {
    throw new AuthorityRpcError("params", `${key} must be a string`);
  }
  return field;
}

export function optionalString(value: JsonValue | undefined, key: string): string | undefined {
  const object = requiredObject(value);
  const field = object[key];
  if (field === undefined || field === null) return undefined;
  if (typeof field !== "string") throw new AuthorityRpcError("params", `${key} must be a string`);
  return field;
}

export function optionalBoundedString(
  value: JsonValue | undefined,
  key: string,
  maximumBytes: number,
): string | undefined {
  const field = optionalString(value, key);
  if (field === undefined) return undefined;
  if (field.trim().length === 0 || Buffer.byteLength(field, "utf8") > maximumBytes) {
    throw new AuthorityRpcError(
      "params",
      `${key} must be nonempty and no larger than ${maximumBytes} UTF-8 bytes when provided`,
    );
  }
  return field;
}

export function requiredBoolean(value: JsonValue | undefined, key: string): boolean {
  const field = requiredObject(value)[key];
  if (typeof field !== "boolean") throw new AuthorityRpcError("params", `${key} must be a boolean`);
  return field;
}

export function optionalBoolean(value: JsonValue | undefined, key: string): boolean | undefined {
  const field = requiredObject(value)[key];
  if (field === undefined || field === null) return undefined;
  if (typeof field !== "boolean") throw new AuthorityRpcError("params", `${key} must be a boolean`);
  return field;
}

export function requiredConfigDocumentDomain(
  value: JsonValue | undefined,
  key: string,
): ConfigDocumentDomain {
  const field = requiredString(value, key);
  if (!CONFIG_DOCUMENT_DOMAINS.includes(field as ConfigDocumentDomain)) {
    throw new AuthorityRpcError("params", `${key} must be a supported configuration domain`);
  }
  return field as ConfigDocumentDomain;
}

export function requiredConfigResourceKind(
  value: JsonValue | undefined,
  key: string,
): ConfigResourceKind {
  const field = requiredString(value, key);
  if (!CONFIG_RESOURCE_KINDS.includes(field as ConfigResourceKind)) {
    throw new AuthorityRpcError("params", `${key} must be a supported configuration resource kind`);
  }
  return field as ConfigResourceKind;
}

export function requiredConfigDocumentFormat(
  value: JsonValue | undefined,
  key: string,
): "yaml" | "toml" | "markdown" {
  const field = requiredString(value, key);
  if (field !== "yaml" && field !== "toml" && field !== "markdown") {
    throw new AuthorityRpcError("params", `${key} must be yaml, toml, or markdown`);
  }
  return field;
}

export function optionalPositiveInt(
  value: JsonValue | undefined,
  key: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const object = requiredObject(value);
  const field = object[key];
  if (field === undefined) return fallback;
  if (!Number.isSafeInteger(field) || typeof field !== "number" || field < 1) {
    throw new AuthorityRpcError("params", `${key} must be a positive integer`);
  }
  return field;
}

export function requiredPositiveInt(value: JsonValue | undefined, key: string): number {
  const field = requiredObject(value)[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 1) {
    throw new AuthorityRpcError("params", `${key} must be a positive integer`);
  }
  return field;
}

export function requiredNonnegativeInt(value: JsonValue | undefined, key: string): number {
  const field = requiredObject(value)[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    throw new AuthorityRpcError("params", `${key} must be a non-negative integer`);
  }
  return field;
}

export function requiredNullableSha256(
  value: JsonValue | undefined,
  key: string,
): Sha256Digest | null {
  const field = requiredObject(value)[key];
  if (field === null) return null;
  if (typeof field !== "string" || !isSha256Digest(field)) {
    throw new AuthorityRpcError("params", `${key} must be null or a SHA-256 digest`);
  }
  return field;
}

export function requiredSha256(value: JsonValue | undefined, key: string): Sha256Digest {
  const field = requiredObject(value)[key];
  if (!isSha256Digest(field)) {
    throw new AuthorityRpcError("params", `${key} must be a SHA-256 digest`);
  }
  return field;
}

export function requiredDeletionMode(
  value: JsonValue | undefined,
): "preserve_branches" | "delete_owned_branches" {
  const field = requiredObject(value).mode;
  if (field !== "preserve_branches" && field !== "delete_owned_branches") {
    throw new AuthorityRpcError(
      "params",
      "mode must be preserve_branches or delete_owned_branches",
    );
  }
  return field;
}

export function requiredProfileConflictResolution(
  value: JsonValue | undefined,
): "keep_project" | "accept_upstream" {
  const field = requiredObject(value).resolution;
  if (field !== "keep_project" && field !== "accept_upstream") {
    throw new AuthorityRpcError("params", "resolution must be keep_project or accept_upstream");
  }
  return field;
}

export function configurationRecord(value: JsonValue, label: string): ConfigurationObject {
  const object = requiredObject(value);
  for (const key of Object.keys(object)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(key)) {
      throw new AuthorityRpcError("params", `${label} must use safe field identities`);
    }
  }
  let encoded: string;
  try {
    encoded = canonicalEncode(object);
  } catch (error) {
    throw new AuthorityRpcError("params", `${label} is not canonical JSON: ${errorMessage(error)}`);
  }
  if (Buffer.byteLength(encoded, "utf8") > 4 * 1024 * 1024) {
    throw new AuthorityRpcError("params", `${label} exceeds 4 MiB`);
  }
  return structuredClone(object);
}

export function boundedText(value: string, label: string, maximum: number): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes === 0 || bytes > maximum || value.includes("\u0000")) {
    throw new AuthorityRpcError("params", `${label} is empty, oversized, or contains NUL`);
  }
  return value;
}

export function validateQuestionOptions(
  options: RunQuestionRecord["options"],
): RunQuestionRecord["options"] {
  if (!Array.isArray(options) || options.length < 2 || options.length > 8) {
    throw new AuthorityRpcError("question_options", "a question requires two to eight options");
  }
  const ids = new Set<string>();
  return options.map((option) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(option.id) || ids.has(option.id))
      throw new AuthorityRpcError(
        "question_options",
        "question option ids must be unique and safe",
      );
    ids.add(option.id);
    return {
      id: option.id,
      label: boundedText(option.label, "option label", 16 * 1024),
      description: boundedText(option.description, "option description", 64 * 1024),
    };
  });
}

export function deletionGitWarnings(run: RunRecord): string[] {
  const warnings: string[] = [];
  const add = (label: string, blocker: string | undefined): void => {
    if (blocker !== undefined && blocker.trim().length > 0) warnings.push(`${label}: ${blocker}`);
  };
  add("Planning worktree", run.git.planning.blocker);
  add("Run worktree", run.git.run.blocker);
  for (const cycle of Object.values(run.git.ticketCycles)) {
    if (cycle.status !== "retired") add(`Ticket ${cycle.ticketId}`, cycle.blocker);
  }
  if (run.git.promotion?.status === "preserved") add("Target promotion", run.git.promotion.blocker);
  if (run.legacyGitMigration?.status === "preserved")
    add("Legacy Git workspace", run.legacyGitMigration.reason);
  return uniqueStrings(warnings);
}

export const HISTORICAL_PRESERVE_BRANCHES_WORKSPACE_REASON =
  "Operator selected branch preservation during deletion";

export function needsHistoricalPreservedDeletionWorktreeRetirement(
  run: Pick<RunRecord, "lifecycle" | "deletion" | "legacyGitMigration" | "git">,
): boolean {
  if (
    run.lifecycle.phase !== "deleted" ||
    run.deletion?.mode !== "preserve_branches" ||
    run.legacyGitMigration !== undefined
  ) {
    return false;
  }
  return [run.git.planning, run.git.run, ...Object.values(run.git.ticketCycles)].some(
    (resource) =>
      resource.status === "preserved" &&
      resource.blocker === HISTORICAL_PRESERVE_BRANCHES_WORKSPACE_REASON,
  );
}

export function preservedGitLifecycle(
  value: RunGitLifecycleRecord,
  reason: string,
): RunGitLifecycleRecord {
  const lifecycle = structuredClone(value);
  if (lifecycle.planning.status !== "retired") {
    lifecycle.planning.status = "preserved";
    lifecycle.planning.blocker = reason;
  }
  if (lifecycle.run.status !== "retired") {
    lifecycle.run.status = "preserved";
    lifecycle.run.blocker = reason;
  }
  for (const cycle of Object.values(lifecycle.ticketCycles)) {
    if (cycle.status === "retired") continue;
    cycle.status = "preserved";
    cycle.blocker = reason;
  }
  if (lifecycle.promotion !== undefined && lifecycle.promotion.status !== "published") {
    lifecycle.promotion.status = "preserved";
    lifecycle.promotion.blocker = reason;
  }
  return lifecycle;
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export function attemptKindTitle(kind: AgentAttemptRecord["kind"]): string {
  if (kind === "planning") return "Run planning";
  if (kind === "lead") return "Lead judgment";
  if (kind === "verification") return "Run verification";
  if (kind === "integration") return "Conflict integration";
  return "Compiled ticket";
}

export function stageCapabilityStatus(
  run: RunRecord,
  position: number,
  currentPosition: number,
): StageCapability["status"] {
  if (run.lifecycle.phase === "completed") return "succeeded";
  if (position < currentPosition) return "succeeded";
  if (position > currentPosition || currentPosition < 0) return "pending";
  if (run.lifecycle.phase === "blocked") return "blocked";
  if (run.lifecycle.phase === "failed") return "failed";
  if (
    run.lifecycle.phase === "awaiting_questions" ||
    run.lifecycle.phase === "awaiting_approval" ||
    run.lifecycle.phase === "paused"
  ) {
    return "waiting";
  }
  return "active";
}

export function stageCapabilityCategory(kind: string): string {
  if (kind === "planning" || kind === "approval") return "Planning";
  if (kind === "orchestration" || kind === "initialize") return "Work";
  if (kind === "checkpoint" || kind === "agent_review" || kind === "target_sync")
    return "Verification";
  if (kind === "promotion") return "Promotion";
  return "Automation";
}

export function lockedStageField(
  key: string,
  label: string,
  value: string | number,
  displayValue: string,
): StageActionFieldSchema {
  return {
    key,
    label,
    description: "Compiler-bound context; it cannot be edited.",
    kind: typeof value === "number" ? "integer" : "text",
    required: true,
    locked: true,
    visibility: "hidden",
    lockedValue: value,
    displayValue,
  };
}

export function stageStringValue(values: Readonly<Record<string, unknown>>, key: string): string {
  const value = values[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AuthorityRpcError("stage_action_value", `${key} must be a non-empty string`);
  }
  return value;
}

export function stageOptionalStringValue(
  values: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = values[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AuthorityRpcError(
      "stage_action_value",
      `${key} must be a non-empty string when provided`,
    );
  }
  return value;
}

export function stageIntegerValue(values: Readonly<Record<string, unknown>>, key: string): number {
  const value = values[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AuthorityRpcError("stage_action_value", `${key} must be a nonnegative safe integer`);
  }
  return value;
}

export function applyBatchResolutionToLegacyQuestions(
  run: RunRecord,
  resolution: QuestionBatchResolution,
  answeredAt: string,
): void {
  for (const answer of resolution.answers) {
    const question = run.questions[answer.questionId];
    if (question === undefined || question.batchId !== resolution.batchId) continue;
    question.selectedOptionId = answer.selectedOptionId;
    question.notes = answer.notes;
    if (answer.source !== undefined) question.answerSource = answer.source;
    question.answerRevision = answer.answerRevision;
    question.answeredAt = answeredAt;
  }
}

export function semanticQuestionPolicyForRun(run: RunRecord): QuestionPolicy | undefined {
  return run.behavior?.runType.questions.policy ?? run.executionConfig?.semanticQuestionPolicy;
}

export function questionScopeForAttempt(
  run: RunRecord,
  attempt: AgentAttemptRecord,
): Pick<QuestionBatchRecord, "scope" | "ticketId"> {
  const configured =
    run.behavior?.runType.questions.defaultScope ?? run.executionConfig?.questionDefaultScope;
  if (configured === undefined) return {};
  if (configured === "ticket" && run.tickets[attempt.ticketId] !== undefined) {
    return { scope: "ticket", ticketId: attempt.ticketId };
  }
  return { scope: "run" };
}

export function planningQuestionRevisionBinding(
  run: Readonly<RunRecord>,
  attempt: Readonly<AgentAttemptRecord>,
): Pick<QuestionBatchRecord, "planningRevision"> {
  if (attempt.kind !== "planning" || run.planningSession?.attemptId !== attempt.id) return {};
  return { planningRevision: run.planningSession.currentRevision };
}

export function questionBatchPlanningRevisionIsCurrent(
  run: Readonly<RunRecord>,
  batch: Readonly<QuestionBatchRecord>,
): boolean {
  return (
    batch.planningRevision === undefined ||
    (run.planningSession?.attemptId === batch.attemptId &&
      run.planningSession.currentRevision === batch.planningRevision)
  );
}

export function assertActiveQuestionPlanningRevision(
  run: Readonly<RunRecord>,
  batch: Readonly<QuestionBatchRecord>,
): void {
  if (batch.planningRevision === undefined) return;
  if (!questionBatchPlanningRevisionIsCurrent(run, batch)) {
    throw new AuthorityRpcError(
      "question_planning_revision",
      `question batch belongs to stale planning revision ${batch.planningRevision}`,
    );
  }
}

export function applyAutomaticQuestionAnswers(
  current: QuestionBatchRecord,
  answers: readonly Readonly<{
    questionId: string;
    selectedOptionId: string;
    reason: "configured_recommendation";
  }>[],
  savedAt: string,
): QuestionBatchRecord {
  let next = current;
  for (const answer of answers) {
    next = saveQuestionBatchAnswer(next, {
      expectedVersion: next.version,
      questionId: answer.questionId,
      selectedOptionId: answer.selectedOptionId,
      source: answer.reason,
      savedAt,
    });
  }
  return next;
}

export function appendLegacyQuestionProjection(
  run: RunRecord,
  batch: QuestionBatchRecord,
  questions: readonly QuestionBatchQuestionInput[],
  resolution: QuestionBatchResolution,
  at: string,
): void {
  for (const [index, question] of questions.entries()) {
    if (run.questions[question.id] !== undefined) {
      throw new AuthorityRpcError("question_identity", "question identity already exists");
    }
    run.questions[question.id] = {
      id: question.id,
      attemptId: resolution.attemptId,
      ...(batch.scope === undefined ? {} : { scope: batch.scope }),
      ...(batch.ticketId === undefined ? {} : { ticketId: batch.ticketId }),
      prompt: question.prompt,
      options: structuredClone(question.options),
      allowsNotes: question.allowsNotes,
      askedAt: at,
      answeredAt: undefined,
      selectedOptionId: undefined,
      notes: undefined,
      batchId: batch.id,
      batchPosition: index + 1,
      batchSize: questions.length,
      ...(question.impact === undefined ? {} : { impact: question.impact }),
      ...(question.recommendedOptionId === undefined
        ? {}
        : { recommendationOptionId: question.recommendedOptionId }),
    };
  }
  applyBatchResolutionToLegacyQuestions(run, resolution, at);
}

export function questionBatchAnswerSummary(resolution: QuestionBatchResolution): string {
  return `${resolution.answers.length} question${resolution.answers.length === 1 ? "" : "s"} answered`;
}

export function questionBatchInputs(
  value: Record<string, unknown>,
  createQuestionId: () => string,
  policyAware: boolean,
): QuestionBatchQuestionInput[] {
  const rawQuestions: unknown[] = Array.isArray(value.questions) ? value.questions : [value];
  if (rawQuestions.length < 1 || rawQuestions.length > 8) {
    throw new AuthorityRpcError(
      "question_batch",
      "a question batch must contain between 1 and 8 questions",
    );
  }
  const sourceIds = new Set<string>();
  return rawQuestions.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new AuthorityRpcError("question_batch", `question ${index + 1} must be an object`);
    }
    if (Array.isArray(value.questions)) {
      const sourceId = boundedText(toolString(raw, "id"), "question id", 128);
      if (sourceIds.has(sourceId)) {
        throw new AuthorityRpcError("question_identity", `duplicate question id ${sourceId}`);
      }
      sourceIds.add(sourceId);
    }
    const recommendedOptionId =
      raw.recommendedOptionId === undefined
        ? policyAware
          ? (() => {
              throw new AuthorityRpcError(
                "question_recommendation",
                "policy-aware questions require exactly one recommendedOptionId",
              );
            })()
          : undefined
        : typeof raw.recommendedOptionId === "string" && raw.recommendedOptionId.length > 0
          ? raw.recommendedOptionId
          : (() => {
              throw new AuthorityRpcError(
                "question_recommendation",
                "recommendedOptionId must be a non-empty string",
              );
            })();
    const impact =
      raw.impact === "routine" || raw.impact === "high_impact"
        ? raw.impact
        : policyAware
          ? (() => {
              throw new AuthorityRpcError(
                "question_impact",
                "policy-aware questions require impact to be routine or high_impact",
              );
            })()
          : undefined;
    return {
      id: createQuestionId(),
      prompt: boundedText(toolString(raw, "prompt"), "question prompt", 1024 * 1024),
      options: validateQuestionOptions(raw.options as RunQuestionRecord["options"]),
      allowsNotes: raw.allowsNotes !== false,
      ...(impact === undefined ? {} : { impact }),
      ...(recommendedOptionId === undefined ? {} : { recommendedOptionId }),
    };
  });
}

export function questionBatchRpcError(error: unknown): AuthorityRpcError {
  if (error instanceof AuthorityRpcError) return error;
  return new AuthorityRpcError(
    errorCode(error) ?? "question_batch_transition",
    errorMessage(error),
    { retryable: errorCode(error) === "version_conflict" },
  );
}

export function nextRun(run: RunRecord, updatedAt: string): RunRecord {
  const draft = structuredClone(run);
  draft.revision = run.revision + 1;
  draft.updatedAt = updatedAt;
  return draft;
}

export function applyLifecycle(run: RunRecord, event: RunLifecycleEvent): void {
  const priorPhase = run.lifecycle.phase;
  const reduced = reduceRunLifecycle(run.lifecycle, event).state;
  if (run.lifecycleCatalog !== undefined) {
    authorizeConfiguredRunTransition(run.lifecycleCatalog, {
      from: priorPhase,
      to: reduced.phase,
      actor: configuredLifecycleActor(event),
    });
  }
  run.lifecycle = reduced;
  run.generation = run.lifecycle.generation;
}

export function configuredLifecycleActor(event: RunLifecycleEvent): "human" | "compiler" {
  switch (event.type) {
    case "question_answered":
    case "plan_revision_requested":
    case "plan_approval_requested":
    case "pause_requested":
    case "resume_requested":
    case "questions_resume_requested":
    case "retry_requested":
    case "merge_started":
    case "delete_requested":
      return "human";
    default:
      return "compiler";
  }
}

export function proposalLifecycleActor(
  run: Readonly<RunRecord>,
  from: TicketRecord["status"],
  to: TicketRecord["status"],
  decision: "approval" | "rejection",
): string | undefined {
  const catalog = run.lifecycleCatalog;
  if (catalog === undefined) return undefined;
  const machine = catalog.machines.ticket;
  if (machine === undefined) {
    throw new AuthorityRpcError(
      "proposal_lifecycle",
      "run has no configured ticket lifecycle authority",
    );
  }
  const configuredFrom = configuredTicketState(machine, from);
  const configuredTo = configuredTicketState(machine, to);
  const matches = machine.transitions.filter(
    (transition) => transition.from.includes(configuredFrom) && transition.to === configuredTo,
  );
  if (matches.length === 0 || matches.some((transition) => transition.actors.length === 0)) {
    throw new AuthorityRpcError(
      "proposal_lifecycle_actor",
      `proposal ${decision} has no explicit configured lifecycle actor`,
    );
  }
  const actors = [...new Set(matches.flatMap((transition) => transition.actors))].sort();
  if (decision === "rejection" && actors.includes("compiler")) return "compiler";
  if (actors.length !== 1) {
    throw new AuthorityRpcError(
      "proposal_lifecycle_actor",
      `proposal ${decision} lifecycle actor is ambiguous: ${actors.join(", ")}`,
    );
  }
  return actors[0]!;
}

/**
 * Provider retry allowance begins again after a canonical provider settlement.  A planner or
 * worker can make real progress over several provider turns before one response stalls; counting
 * that late transient against failures from an earlier, already-settled turn wrongly exhausts
 * the recovery budget and leaves an otherwise healthy run blocked.  Conversely, an attempt with
 * no settled provider response remains in the same epoch, so a persistent abort-every-time loop
 * is still bounded.
 */
export function providerRecoveryEpochAttempts(run: RunRecord): readonly AgentAttemptRecord[] {
  const attempts = Object.values(run.attempts);
  let boundary = -1;
  for (const [index, attempt] of attempts.entries()) {
    // An attempt that itself died holding provider exposure must not reset the budget it just
    // consumed. Nearly every multi-turn attempt settles some requests before its final one fails,
    // so treating any settlement as progress made the cap unreachable: one run auto-recovered
    // twelve consecutive times over roughly fifty minutes, re-paying for identical discovery each
    // time, because each failure cleared its own counter. Genuine progress still resets it.
    if (
      (attempt.status === "failed" || attempt.status === "aborted") &&
      isProviderExposureHoldBlocker(attempt.error)
    )
      continue;
    if (
      attempt.authorityProviderRequests?.some((request) => request.settledAt !== undefined) ||
      (attempt.kind === "lead" && attempt.status === "completed")
    ) {
      boundary = index;
    }
  }
  return attempts.slice(boundary + 1);
}

/**
 * Return the only sanctioned lead recovery downgrade, after its bounded error series is durable.
 *
 * The fallback is never a vendor Koni picked: it is another model this same run already authorized
 * for one of its own personas on the lead's provider. That keeps the downgrade inside the operator's
 * authenticated provider and configured selections, so the behavior is identical whichever provider
 * a project runs on, and a single-model run simply has no downgrade available.
 */
export function exhaustedLeadRecoveryModel(
  run: RunRecord,
  kind: "planning" | "lead" | "ticket" | "verification" | "integration",
): string | undefined {
  if (kind !== "lead") return undefined;
  const lead = run.executionConfig?.agents.lead;
  if (lead === undefined) return undefined;
  const fallback = authorizedLeadFallbackModel(run, lead);
  if (fallback === undefined) return undefined;
  // Once the bounded lead series is exhausted, later failed/aborted fallback attempts must not make
  // the compiler forget that decision. Only a canonical settlement or completed Lead judgment
  // starts a new provider-recovery epoch (see providerRecoveryEpochAttempts).
  return providerRecoveryEpochAttempts(run).filter((attempt) =>
    isRetiredLeadRecoveryAttempt(attempt, lead),
  ).length > MAX_PROVIDER_EXPOSURE_AUTO_RECOVERIES
    ? fallback
    : undefined;
}

/**
 * Pick the run's own alternate model on the lead's provider: the most widely authorized one,
 * with a deterministic identifier tie-break so one run always resolves the same downgrade.
 */
export function authorizedLeadFallbackModel(
  run: RunRecord,
  lead: Readonly<{ provider: string; model: string }>,
): string | undefined {
  const counts = new Map<string, number>();
  for (const [personaId, selection] of Object.entries(run.executionConfig?.agents ?? {})) {
    if (personaId === "lead") continue;
    if (selection.provider !== lead.provider || selection.model === lead.model) continue;
    counts.set(selection.model, (counts.get(selection.model) ?? 0) + 1);
  }
  return [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0]?.[0];
}

/** Model choice is injected into the immutable compiler input; the original run default stays pinned. */
export function withRecoveryModelSelection(
  run: RunRecord,
  personaId: string,
  model: string,
): RunRecord {
  const draft = structuredClone(run);
  const selected = draft.executionConfig?.agents[personaId];
  if (selected === undefined) throw new Error(`missing recovery persona selection: ${personaId}`);
  selected.model = model;
  return draft;
}

/** Return the fallback model when these failures exhaust the configured lead's recovery budget. */
export function exhaustedLeadProviderFailureFallback(
  run: RunRecord,
  candidates: readonly { attemptId: string }[],
): string | undefined {
  const lead = run.executionConfig?.agents.lead;
  if (lead === undefined) return undefined;
  const fallback = authorizedLeadFallbackModel(run, lead);
  if (fallback === undefined) return undefined;
  const candidateIds = new Set(candidates.map((candidate) => candidate.attemptId));
  const current = Object.values(run.attempts).filter((attempt) => candidateIds.has(attempt.id));
  if (
    current.length === 0 ||
    current.some(
      (attempt) =>
        attempt.kind !== "lead" ||
        attempt.modelProvider !== lead.provider ||
        attempt.modelId !== lead.model,
    )
  )
    return undefined;
  return providerRecoveryEpochAttempts(run).filter((attempt) =>
    isRetiredLeadRecoveryAttempt(attempt, lead),
  ).length >= MAX_PROVIDER_EXPOSURE_AUTO_RECOVERIES
    ? fallback
    : undefined;
}

export function isRetiredLeadRecoveryAttempt(
  attempt: AgentAttemptRecord,
  lead: Readonly<{ provider: string; model: string }>,
): boolean {
  return (
    attempt.kind === "lead" &&
    attempt.modelProvider === lead.provider &&
    attempt.modelId === lead.model &&
    attempt.authorityProviderRequests?.some(isAutomaticProviderRecoveryRetirement) === true
  );
}

/** Authority pause accounting remains visible but must not consume the bounded provider-error budget. */
export function isAutomaticProviderRecoveryRetirement(
  request: Readonly<AgentProviderRequestRecord>,
): boolean {
  return (
    request.retirement?.disposition === "operator_acknowledged_provider_error" ||
    request.retirement?.disposition === "operator_acknowledged_canonical_abort"
  );
}

export function restoreLegacyLifecycle(run: RunRecord, at: string): void {
  const prior = run.legacyGitMigration?.relocation?.priorPhase;
  if (prior === undefined)
    throw new Error("legacy relocation settlement lost its prior lifecycle phase");
  if (prior === "completed" || prior === "failed" || prior === "deleting" || prior === "deleted") {
    throw new Error(`legacy relocation cannot resume terminal lifecycle phase ${prior}`);
  }
  if (prior === "blocked") {
    run.lifecycle.blocker =
      "Legacy workspace relocated; the run remains in its prior blocked state";
    run.lifecycle.runningIntent = false;
    run.lifecycle.activeSinceMs = undefined;
    return;
  }
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) throw new Error("legacy relocation settlement timestamp is invalid");
  if (prior === "paused" || prior === "pausing") {
    const resumePhase = run.lifecycle.resumePhase ?? "executing";
    applyLifecycle(run, { type: "retry_requested", atMs, phase: resumePhase });
    applyLifecycle(run, { type: "pause_requested", atMs });
    applyLifecycle(run, { type: "pause_settled", atMs });
    return;
  }
  applyLifecycle(run, {
    type: "retry_requested",
    atMs,
    phase: prior as ResumableRunPhase,
  });
}

export function activity(
  id: string,
  at: string,
  kind: RunActivityRecord["kind"],
  message: string,
  ticketId?: string,
  tone?: RunActivityRecord["tone"],
): RunActivityRecord {
  return {
    id,
    at,
    kind,
    message,
    ticketId,
    nodeId: undefined,
    ...(tone === undefined ? {} : { tone }),
  };
}

export function requiredRunActionExecution(
  run: Readonly<RunRecord>,
  invocationId: string,
): RunActionExecutionRecord {
  const record = run.actionExecutions?.[invocationId];
  if (record === undefined) {
    throw new AuthorityRpcError(
      "action_execution_missing",
      `configured action execution does not exist: ${invocationId}`,
    );
  }
  return record;
}
