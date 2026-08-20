import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { LeadJudgmentTrigger } from "../contracts/behavior.js";
import { type AgentLaunchSpec } from "../pi/launch-spec.js";
import type { AuthorityBackedTool } from "../pi/managed-session.js";
import {
  createKoniAuthorityTools,
  CUMULATIVE_TOOL_RETRY_INSTRUCTION,
  type KoniRejectedToolReceipt,
  type KoniRuntimeToolRejection,
  type KoniToolInvocation,
  type KoniToolName,
  type KoniToolReceipt,
} from "../pi/tool-catalog.js";
import {
  canonicalEncode,
  canonicalHash,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import { ConfigDocumentAuthorityError } from "./config-documents.js";
import type { TransactionWrite } from "./file-journal.js";
import type { AuthorityGrant } from "./grants.js";
import { PathAuthorityError } from "./path-policy.js";
import type { JsonValue } from "./protocol.js";
import {
  checkedProviderSum,
  encodeJsonArtifact,
  errorCode,
  errorMessage,
  isRecord,
  planningTokenUsageFromBaseline,
} from "./run-engine-shared.js";
import { AuthorityRpcError } from "./server.js";

import type {
  AgentAttemptRecord,
  AgentProviderTokenTotals,
  PlanningRevisionRecord,
  PlanningSynthesisRecord,
  RunRecord,
} from "../state/run-record.js";
import { type ReadyAssignment } from "../state/scheduler.js";

import {
  RECOVERABLE_CONFIGURED_CHECK_PREFLIGHT_CODES,
  REPOSITORY_DISCOVERY_TOOLS,
  REPOSITORY_KNOWLEDGE_INVALIDATION_TOOLS,
  type PreparedManagedAttempt,
  type ResolvedRunDefinition,
  type RunPipelineStageDefinition,
} from "./run-engine-contracts.js";

export function assertPreparedIdentity(
  prepared: PreparedManagedAttempt,
  runId: string,
  attemptId: string,
  sessionId: string,
  assignment: ReadyAssignment | undefined,
  kind: AgentAttemptRecord["kind"],
  leadTrigger: LeadJudgmentTrigger | undefined,
): void {
  const identity = prepared.spec.identity;
  const expectedLeadStep = leadTrigger === undefined ? undefined : leadJudgmentStepId(leadTrigger);
  if (
    identity.runId !== runId ||
    identity.attemptId !== attemptId ||
    identity.sessionId !== sessionId ||
    (kind === "lead" &&
      (leadTrigger === undefined ||
        identity.ticketId !== "run-orchestration" ||
        identity.stepId !== expectedLeadStep)) ||
    (assignment !== undefined &&
      (identity.ticketId !== assignment.ticketId || identity.stepId !== assignment.stepId))
  )
    throw new AuthorityRpcError(
      "launch_identity",
      "compiler returned a launch spec for another assignment",
    );
}

export function leadJudgmentStepId(trigger: LeadJudgmentTrigger): string {
  return trigger === "orchestration_entry" ? "lead-orchestration-entry" : "lead-compiler-deadlock";
}

export function leadJudgmentTriggerForAttempt(
  attempt: Pick<AgentAttemptRecord, "kind" | "stepId">,
): LeadJudgmentTrigger {
  if (attempt.kind !== "lead") {
    throw new AuthorityRpcError("lead_identity", "attempt is not a Lead judgment");
  }
  if (attempt.stepId === "lead-orchestration-entry") return "orchestration_entry";
  if (attempt.stepId === "lead-compiler-deadlock") return "compiler_deadlock";
  throw new AuthorityRpcError(
    "lead_identity",
    `Lead attempt step ${attempt.stepId} has no compiler trigger`,
  );
}

export function assertResolvedPipeline(definition: ResolvedRunDefinition): void {
  assertPipelineProjection(definition.pipelineStageIds, definition.pipelineStages);
}

export function assertPipelineProjection(
  stageIds: readonly string[],
  stages: readonly RunPipelineStageDefinition[],
): void {
  if (
    stageIds.length === 0 ||
    stages.length !== stageIds.length ||
    stages.some(
      (stage, index) =>
        stage.id !== stageIds[index] ||
        stage.title.length === 0 ||
        stage.kind.length === 0 ||
        typeof stage.automatic !== "boolean",
    )
  ) {
    throw new AuthorityRpcError(
      "pipeline_semantics_invalid",
      "compiler semantic pipeline projection does not exactly match its ordered stage identities",
    );
  }
}

export function requireProgramMethod<Method>(method: Method | undefined, message: string): Method {
  if (method === undefined) throw new AuthorityRpcError("compiler_method", message);
  return method;
}

export function isRecoverableConfiguredCheckPreflightError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "NativeRunProgramError") return false;
  return RECOVERABLE_CONFIGURED_CHECK_PREFLIGHT_CODES.has(errorCode(error) ?? "");
}

export function errorDetails(error: unknown): JsonValue | undefined {
  if (typeof error !== "object" || error === null || !("diagnostics" in error)) return undefined;
  const diagnostics = (error as { diagnostics?: unknown }).diagnostics;
  return Array.isArray(diagnostics) && diagnostics.every((item) => typeof item === "string")
    ? { diagnostics }
    : undefined;
}

export function profileConflictRpcError(error: unknown, fallbackCode: string): AuthorityRpcError {
  if (error instanceof AuthorityRpcError) return error;
  const details = errorDetails(error);
  return new AuthorityRpcError(
    errorCode(error) ?? fallbackCode,
    errorMessage(error),
    details === undefined ? {} : { details },
  );
}

export function projectStoreRpcError(error: unknown, fallbackCode: string): AuthorityRpcError {
  if (error instanceof AuthorityRpcError) return error;
  const code = errorCode(error) ?? fallbackCode;
  return new AuthorityRpcError(code, errorMessage(error), {
    retryable: code === "run_page_stale" || code === "revision_conflict",
  });
}

export function configDocumentRpcError(error: unknown, fallbackCode: string): AuthorityRpcError {
  if (error instanceof AuthorityRpcError) return error;
  const code =
    error instanceof ConfigDocumentAuthorityError ? error.code : (errorCode(error) ?? fallbackCode);
  const details = errorDetails(error);
  return new AuthorityRpcError(code, errorMessage(error), {
    retryable: new Set([
      "config_changed",
      "config_document_changed",
      "config_source_changed",
      "config_template_changed",
      "lifecycle_changed",
      "migration_preview_changed",
    ]).has(code),
    ...(details === undefined ? {} : { details }),
  });
}

export function configMutationEventPayload(value: JsonValue): JsonValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const changedDocuments = value.changedDocuments;
  const protocol = value.protocol;
  return {
    ...(typeof protocol === "string" ? { protocol } : {}),
    ...(typeof changedDocuments === "number" ? { changedDocuments } : {}),
  };
}

export function defaultId(kind: "run" | "attempt" | "session" | "question" | "activity"): string {
  return `${kind}-${randomUUID()}`;
}

export function runStateHash(run: RunRecord): Sha256Digest {
  return canonicalHash(run);
}

export function authorityRevisionStateHash(projectRoot: string, revision: number): Sha256Digest {
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new Error("authority revision is invalid");
  return canonicalHash({ protocol: "koni.authority-state-anchor.v1", projectRoot, revision });
}

export function resolvePreparedTools(
  prepared: PreparedManagedAttempt,
  invoke: (call: KoniToolInvocation) => Promise<KoniToolReceipt>,
  reject: (
    call: KoniToolInvocation,
    rejection: KoniRuntimeToolRejection,
  ) => Promise<KoniRejectedToolReceipt>,
): readonly AuthorityBackedTool[] {
  if (prepared.tools !== undefined) return prepared.tools;
  if (
    prepared.authorityGrant === undefined ||
    prepared.toolNames === undefined ||
    prepared.terminalOutputSchema === undefined
  ) {
    throw new AuthorityRpcError(
      "tool_authority",
      "production attempt has no compiler-issued tool authority plan",
    );
  }
  return createKoniAuthorityTools({
    names: prepared.toolNames,
    terminalOutputSchema: prepared.terminalOutputSchema,
    schemaHashes: Object.fromEntries(
      prepared.spec.tools.map((tool) => [tool.name, tool.schemaHash]),
    ),
    invoke,
    reject,
  });
}

export function assertPreparedAuthorityPlan(
  prepared: PreparedManagedAttempt,
  nextRevision: number,
  projectRoot: string,
  stateRoot: string,
): void {
  if (prepared.tools !== undefined) return;
  const grant = prepared.authorityGrant;
  if (
    grant === undefined ||
    prepared.toolNames === undefined ||
    prepared.terminalOutputSchema === undefined ||
    prepared.contextContent === undefined ||
    prepared.compactionSnapshot === undefined
  ) {
    throw new AuthorityRpcError(
      "launch_authority",
      "compiler returned an incomplete production authority plan",
    );
  }
  const spec = prepared.spec;
  if (
    grant.protocol !== "koni.authority-grant.v1" ||
    canonicalHash(grant) !== spec.authority.grantHash ||
    grant.grantId !== spec.authority.grantId ||
    grant.runId !== spec.identity.runId ||
    grant.ticketId !== spec.identity.ticketId ||
    grant.stepId !== spec.identity.stepId ||
    grant.attemptId !== spec.identity.attemptId ||
    grant.sessionId !== spec.identity.sessionId ||
    grant.generation !== spec.authority.generation ||
    grant.epoch !== spec.authority.epoch ||
    grant.expectedRevision !== nextRevision ||
    spec.authority.expectedRevision !== nextRevision ||
    grant.expectedStateHash !== authorityRevisionStateHash(projectRoot, nextRevision) ||
    spec.authority.expectedStateHash !== grant.expectedStateHash
  ) {
    throw new AuthorityRpcError(
      "launch_authority",
      "grant does not match immutable launch authority bytes",
    );
  }
  if (prepared.factory === undefined) assertProductionSessionDirectory(spec, stateRoot);
  const grantedTools = [...grant.allowedTools];
  const namedTools = [...prepared.toolNames];
  const specTools = spec.tools.map((tool) => tool.name);
  if (
    new Set(grantedTools).size !== grantedTools.length ||
    JSON.stringify(grantedTools) !== JSON.stringify(namedTools) ||
    JSON.stringify(namedTools) !== JSON.stringify(specTools)
  ) {
    throw new AuthorityRpcError("launch_tools", "grant, tool plan, and launch inventory differ");
  }
  if (
    rawSha256(prepared.contextContent) !== spec.authority.authoritativeContextHash ||
    canonicalHash(prepared.terminalOutputSchema) !== spec.terminal.outputSchemaHash
  ) {
    throw new AuthorityRpcError("launch_hash", "launch context or terminal schema hash differs");
  }
}

export function assertRecoveredAuthorityPlan(
  prepared: PreparedManagedAttempt,
  storedSpec: Readonly<AgentLaunchSpec>,
  projectRoot: string,
  stateRoot: string,
): void {
  if (prepared.spec.specHash !== storedSpec.specHash) {
    throw new AuthorityRpcError("recovery_spec", "recovery changed immutable launch spec bytes");
  }
  if (prepared.tools !== undefined) return;
  const grant = prepared.authorityGrant;
  if (
    grant === undefined ||
    prepared.toolNames === undefined ||
    prepared.terminalOutputSchema === undefined ||
    prepared.contextContent === undefined ||
    prepared.compactionSnapshot === undefined ||
    canonicalHash(grant) !== storedSpec.authority.grantHash ||
    grant.expectedRevision !== storedSpec.authority.expectedRevision ||
    grant.expectedStateHash !== storedSpec.authority.expectedStateHash ||
    grant.expectedStateHash !== authorityRevisionStateHash(projectRoot, grant.expectedRevision) ||
    rawSha256(prepared.contextContent) !== storedSpec.authority.authoritativeContextHash ||
    canonicalHash(prepared.terminalOutputSchema) !== storedSpec.terminal.outputSchemaHash ||
    JSON.stringify(prepared.toolNames) !== JSON.stringify(storedSpec.tools.map((tool) => tool.name))
  ) {
    throw new AuthorityRpcError(
      "recovery_authority",
      "recovered authority plan differs from stored launch spec",
    );
  }
  if (prepared.factory === undefined) assertProductionSessionDirectory(storedSpec, stateRoot);
}

export function assertProductionSessionDirectory(
  spec: Readonly<AgentLaunchSpec>,
  stateRoot: string,
): void {
  const expected = path.join(
    stateRoot,
    "runs",
    spec.identity.runId,
    "sessions",
    spec.identity.attemptId,
  );
  if (path.resolve(spec.workspace.sessionDirectory) !== path.resolve(expected)) {
    throw new AuthorityRpcError(
      "launch_session_path",
      "production Pi session directory is outside its authority-owned attempt path",
    );
  }
}

export function validateAgentToolGrant(
  run: RunRecord,
  spec: AgentLaunchSpec,
  grant: AuthorityGrant,
  call: KoniToolInvocation,
  authorityRevision: number,
  projectRoot: string,
): AgentAttemptRecord {
  const attempt = run.attempts[spec.identity.attemptId];
  if (
    canonicalHash(grant) !== spec.authority.grantHash ||
    attempt === undefined ||
    authoritativeLaunchSpecHash(run, attempt) !== spec.specHash ||
    grant.runId !== run.id ||
    grant.attemptId !== attempt.id ||
    grant.sessionId !== attempt.sessionId ||
    grant.ticketId !== attempt.ticketId ||
    grant.stepId !== attempt.stepId ||
    grant.generation !== run.generation ||
    grant.generation !== spec.authority.generation ||
    grant.epoch !== spec.authority.epoch
  ) {
    throw new AuthorityRpcError(
      "tool_identity",
      "tool call does not match its active immutable grant",
    );
  }
  if (
    attempt.status !== "running" ||
    !new Set(["planning", "executing", "verifying"]).has(run.lifecycle.phase)
  ) {
    throw new AuthorityRpcError(
      "attempt_inactive",
      "tool attempt is not active in a provider-capable run phase",
    );
  }
  if (!grant.allowedTools.includes(call.name)) {
    throw new AuthorityRpcError("tool_scope", `${call.name} is outside the compiler-issued grant`);
  }
  if (
    grant.expectedRevision > authorityRevision ||
    grant.expectedStateHash !== authorityRevisionStateHash(projectRoot, grant.expectedRevision)
  ) {
    throw new AuthorityRpcError(
      "tool_state",
      "tool grant is stale or has an invalid authority anchor",
    );
  }
  if (
    grant.revokedAtMs !== undefined ||
    (grant.expiresAtMs !== undefined && Date.now() >= grant.expiresAtMs)
  ) {
    throw new AuthorityRpcError("tool_revoked", "tool grant is revoked or expired");
  }
  return attempt;
}

/**
 * Path-request denials (except an unsafe authority root) and explicitly classified RPC errors are
 * model-correctable tool outcomes. Persisting them as canonical rejected receipts keeps the
 * transcript and authority ledger exact across process recovery; integrity and implementation
 * failures still escape immediately.
 */
export const CORRECTABLE_AUTHORITY_TOOL_ERROR_CODES = new Set([
  "check_scope",
  "duplicate_repository_discovery",
  "edit_encoding",
  "edit_input",
  "edit_match",
  "limit",
  "list_type",
  "path_escape",
  "path_type",
  "planning_synthesis_required",
  "question_answer",
  "question_batch",
  "question_impact",
  "question_notes",
  "question_option",
  "question_options",
  "question_recommendation",
  "read_offset",
  "read_page_size",
  "read_scope",
  "read_search_required",
  "read_type",
  "repository_call_budget",
  "resource_scope",
  "search_bytes",
  "search_files",
  "search_query",
  "symlink",
  "terminal_size",
  "text_offset",
  "tool_arguments",
  "write_cas",
  "write_scope",
  "write_size",
]);

export const COMPILER_DIAGNOSTIC_TRUNCATION = "[compiler diagnostic truncated]";
export const CORRECTABLE_ASSIGNMENT_COMPILER_ERROR_CODES = new Set([
  "assignment_checks_incomplete",
  "assignment_output_ticket_drift",
]);

export function boundedCompilerDiagnosticText(value: string, maximumBytes: number): string {
  const sanitized = value.replaceAll("\u0000", "\uFFFD");
  if (Buffer.byteLength(sanitized, "utf8") <= maximumBytes) return sanitized;
  const suffix = `\n${COMPILER_DIAGNOSTIC_TRUNCATION}`;
  const prefixBytes = maximumBytes - Buffer.byteLength(suffix, "utf8");
  let prefix = Buffer.from(sanitized, "utf8").subarray(0, prefixBytes).toString("utf8");
  while (Buffer.byteLength(prefix, "utf8") > prefixBytes) prefix = prefix.slice(0, -1);
  return `${prefix}${suffix}`;
}

export function cumulativePlanningCompilerSummary(value: string): string {
  const suffix = `\n\n${CUMULATIVE_TOOL_RETRY_INSTRUCTION}`;
  const maximumBodyBytes = 60 * 1024 - Buffer.byteLength(suffix, "utf8");
  return `${boundedCompilerDiagnosticText(value, maximumBodyBytes)}${suffix}`;
}

export function correctableAgentToolError(
  error: unknown,
  context: Readonly<{ planning: boolean; terminal: boolean }>,
): Readonly<{ code: string; summary: string; value?: JsonValue }> | undefined {
  if (error instanceof PathAuthorityError && error.code !== "unsafe_root") {
    return { code: error.code, summary: error.message };
  }
  if (
    error instanceof AuthorityRpcError &&
    CORRECTABLE_AUTHORITY_TOOL_ERROR_CODES.has(error.code)
  ) {
    return {
      code: error.code,
      summary: error.message,
      ...(error.details !== undefined ? { value: structuredClone(error.details) } : {}),
    };
  }
  if (
    context.terminal &&
    error instanceof Error &&
    isRecord(error) &&
    error.name === "NativeRunProgramError" &&
    typeof error.code === "string" &&
    (context.planning || CORRECTABLE_ASSIGNMENT_COMPILER_ERROR_CODES.has(error.code)) &&
    Array.isArray(error.details) &&
    error.details.every((detail) => typeof detail === "string")
  ) {
    const sourceDetails = [...error.details] as string[];
    const details = sourceDetails
      .slice(0, 20)
      .map((detail) => boundedCompilerDiagnosticText(detail, 2 * 1024));
    if (sourceDetails.length > details.length) {
      details.push(
        `${COMPILER_DIAGNOSTIC_TRUNCATION}: ${sourceDetails.length - details.length} additional diagnostics omitted`,
      );
    }
    return {
      code: error.code,
      summary: context.planning
        ? cumulativePlanningCompilerSummary(error.message)
        : boundedCompilerDiagnosticText(error.message, 60 * 1024),
      ...(details.length === 0 ? {} : { value: { diagnostics: details } }),
    };
  }
  return undefined;
}

/**
 * Return the active revision's token spend without mutating cumulative provider accounting.
 * A negative component means durable state moved behind its immutable baseline and is corruption.
 */
export function planningRevisionTokenUsage(
  attempt: Readonly<AgentAttemptRecord>,
  revision: Readonly<PlanningRevisionRecord>,
): AgentProviderTokenTotals {
  return planningTokenUsageFromBaseline(attempt, revision.budgetBaseline);
}

export function recoverablePlanningTerminalAuthority(
  attempt: Readonly<AgentAttemptRecord>,
  terminalToolName: string,
  output: unknown,
): NonNullable<AgentAttemptRecord["authorityToolResults"]>[number] | undefined {
  const canonical = canonicalEncode(output);
  const argumentsSha256 = rawSha256(canonical);
  const argumentsSizeBytes = Buffer.byteLength(canonical, "utf8");
  return [...(attempt.authorityToolResults ?? [])]
    .reverse()
    .find(
      (record) =>
        record.toolName === terminalToolName &&
        record.outcome === "accepted" &&
        record.argumentsSha256 === argumentsSha256 &&
        record.argumentsSizeBytes === argumentsSizeBytes,
    );
}

/**
 * Count accepted discovery calls across the conversation this attempt actually inherits.
 *
 * The budget was counted per attempt, so every recovery handed the agent a fresh allowance while a
 * forked continuation still retained all of the parent's results in its transcript. Under a
 * recovery loop that made the ceiling meaningless: one planning stage spent 203 accepted discovery
 * calls against a configured budget of 32. A continuation can reuse what it inherited, so it must
 * also inherit what that cost; a genuinely fresh root legitimately starts from zero.
 */
export function inheritedRepositoryDiscoveryCalls(
  run: RunRecord,
  attempt: AgentAttemptRecord,
): number {
  let total = 0;
  const seen = new Set<string>();
  let cursor: AgentAttemptRecord | undefined = attempt;
  while (cursor !== undefined && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    total += (cursor.authorityToolResults ?? []).filter(
      (result) =>
        result.outcome === "accepted" &&
        REPOSITORY_DISCOVERY_TOOLS.has(result.toolName as KoniToolName),
    ).length;
    // Only a hash-bound conversation fork carries the parent's results forward. Without one the
    // child starts from an empty session and has nothing to reuse.
    const lineage: AgentAttemptRecord["lineage"] = cursor.lineage;
    if (lineage?.conversationFork === undefined || lineage.parentAttemptId === undefined) break;
    cursor = run.attempts[lineage.parentAttemptId];
  }
  return total;
}

/**
 * Find an exact discovery result whose bytes are still available to the active model context.
 *
 * Durable receipts prove that a call happened, but a Koni compaction checkpoint retains only the
 * file identity and receipt digest, not arbitrary repository bytes. A later write/edit/check can
 * also make an earlier read stale. Duplicate rejection is therefore scoped to the current visible
 * knowledge epoch; cumulative call accounting remains conversation-fork aware and independently
 * bounds reacquisition.
 */
export function modelVisibleRepositoryDiscoveryDuplicate(
  attempt: AgentAttemptRecord,
  toolName: KoniToolName,
  argumentsSha256: Sha256Digest,
): NonNullable<AgentAttemptRecord["authorityToolResults"]>[number] | undefined {
  const results = attempt.authorityToolResults ?? [];
  const latestMutationSequence = results.reduce(
    (latest, result) =>
      result.outcome === "accepted" &&
      REPOSITORY_KNOWLEDGE_INVALIDATION_TOOLS.has(result.toolName as KoniToolName)
        ? Math.max(latest, result.sequence)
        : latest,
    0,
  );
  const latestCompaction = attempt.authorityCompactions?.at(-1);
  // Compactions created before the causal watermark was introduced cannot prove which repository
  // bytes survived. Conservatively permit reacquisition; the cumulative discovery-call budget
  // remains unchanged and bounds it.
  const latestCompactionSequence =
    latestCompaction === undefined
      ? 0
      : (latestCompaction.toolResultSequence ?? Number.MAX_SAFE_INTEGER);
  const visibilityBoundary = Math.max(latestMutationSequence, latestCompactionSequence);
  return [...results]
    .reverse()
    .find(
      (result) =>
        result.outcome === "accepted" &&
        result.toolName === toolName &&
        result.argumentsSha256 === argumentsSha256 &&
        result.sequence > visibilityBoundary,
    );
}

export function enforceRepositoryCallBudget(
  run: RunRecord,
  spec: AgentLaunchSpec,
  attempt: AgentAttemptRecord,
  call: KoniToolInvocation,
): void {
  const synthesis = activePlanningSynthesis(run, attempt);
  if (synthesis !== undefined && REPOSITORY_DISCOVERY_TOOLS.has(call.name)) {
    throw new AuthorityRpcError(
      "planning_synthesis_required",
      "planning exploration is closed; synthesize the reviewable plan and submit it",
      {
        details: {
          thresholdNewTokens: synthesis.thresholdNewTokens,
          limitNewTokens: synthesis.limitNewTokens,
        },
      },
    );
  }
  if (REPOSITORY_DISCOVERY_TOOLS.has(call.name)) {
    const argumentsSha256 = rawSha256(canonicalEncode(call.arguments));
    const duplicate = modelVisibleRepositoryDiscoveryDuplicate(attempt, call.name, argumentsSha256);
    if (duplicate !== undefined) {
      // Naming the exact visible receipt turns a redundant call into a lookup instead of a re-plan.
      throw new AuthorityRpcError(
        "duplicate_repository_discovery",
        `this exact ${call.name} request already succeeded as authority call ${duplicate.sequence} in the current visible conversation epoch (receipt ${duplicate.receiptSha256}); reuse that result instead of repeating the call.`,
        {
          details: {
            priorSequence: duplicate.sequence,
            priorReceiptSha256: duplicate.receiptSha256,
          },
        },
      );
    }
  }
  const limit = spec.budgets.repositoryCalls?.max;
  if (limit === undefined || !REPOSITORY_DISCOVERY_TOOLS.has(call.name)) return;
  const used = inheritedRepositoryDiscoveryCalls(run, attempt);
  if (used >= limit) {
    throw new AuthorityRpcError(
      "repository_call_budget",
      `planning repository-call budget exhausted (${used}/${limit})`,
      { details: { limit, used } },
    );
  }
}

export function planningSynthesisPolicy(
  run: RunRecord,
  attempt: AgentAttemptRecord,
): Readonly<{ synthesisThreshold: number; synthesisReserve: number; limit: number }> | undefined {
  if (attempt.kind !== "planning") return undefined;
  if (run.planningSession?.attemptId === attempt.id) {
    return run.planningSession.revisions[run.planningSession.currentRevision]?.budgetPolicy;
  }
  return run.behavior?.runType.planning?.tokenPolicy;
}

export function activePlanningSynthesis(
  run: Readonly<RunRecord>,
  attempt: Readonly<AgentAttemptRecord>,
): Readonly<PlanningSynthesisRecord> | undefined {
  if (run.planningSession?.attemptId === attempt.id) {
    return run.planningSession.revisions[run.planningSession.currentRevision]?.planningSynthesis;
  }
  return attempt.planningSynthesis;
}

export function setPlanningSynthesis(
  run: RunRecord,
  attemptId: string,
  synthesis: PlanningSynthesisRecord,
): void {
  if (run.planningSession?.attemptId === attemptId) {
    const revision = run.planningSession.revisions[run.planningSession.currentRevision];
    if (revision === undefined) {
      throw new AuthorityRpcError(
        "planning_revision_state",
        "continuous planning synthesis has no active revision",
      );
    }
    revision.planningSynthesis = structuredClone(synthesis);
    delete run.attempts[attemptId]!.planningSynthesis;
    return;
  }
  run.attempts[attemptId]!.planningSynthesis = structuredClone(synthesis);
}

export function planningSynthesisInstruction(
  synthesisThreshold: number,
  limit: number,
  synthesisReserve: number,
  triggerReason: "token_threshold" | "provider_input_pressure",
  triggeredNewTokens: number,
): string {
  return [
    "Compiler policy: planning exploration is complete.",
    "Stop reading, listing, or searching repository files. Do not begin another discovery pass.",
    "Use the evidence already in this session to synthesize the concise and full reviewable plan now, then call koni_submit_output.",
    triggerReason === "token_threshold"
      ? `The configured transition began at ${synthesisThreshold} new tokens; ${synthesisReserve} tokens are reserved for synthesis before the hard ${limit}-token limit.`
      : `The conservative next provider input could not fit safely, so synthesis began early at ${triggeredNewTokens} new tokens instead of waiting for the configured ${synthesisThreshold}-token threshold; the hard limit remains ${limit}.`,
  ].join(" ");
}

export function createPlanningSynthesisTransition(
  run: RunRecord,
  attempt: AgentAttemptRecord,
  at: string,
  options: {
    forceReason?: "provider_input_pressure";
  } = {},
):
  | Readonly<{
      record: PlanningSynthesisRecord;
      write: TransactionWrite;
    }>
  | undefined {
  const tokenPolicy = planningSynthesisPolicy(run, attempt);
  const currentRevision =
    run.planningSession?.attemptId === attempt.id
      ? run.planningSession.revisions[run.planningSession.currentRevision]
      : undefined;
  const usage =
    currentRevision === undefined
      ? planningTokenUsageFromBaseline(attempt, undefined)
      : planningRevisionTokenUsage(attempt, currentRevision);
  const triggeredNewTokens = checkedProviderSum(usage.inputTokens, usage.outputTokens);
  if (
    tokenPolicy === undefined ||
    activePlanningSynthesis(run, attempt) !== undefined ||
    (options.forceReason === undefined && triggeredNewTokens < tokenPolicy.synthesisThreshold)
  )
    return undefined;
  const triggerReason = options.forceReason ?? "token_threshold";
  const content = planningSynthesisInstruction(
    tokenPolicy.synthesisThreshold,
    tokenPolicy.limit,
    tokenPolicy.synthesisReserve,
    triggerReason,
    triggeredNewTokens,
  );
  const bytes = Buffer.from(content, "utf8");
  const sha256 = rawSha256(bytes);
  const artifactPath = planningSynthesisInstructionPath(
    run.id,
    attempt.id,
    sha256,
    currentRevision?.revision,
  );
  return {
    record: {
      protocol: "koni.planning-synthesis.v1",
      thresholdNewTokens: tokenPolicy.synthesisThreshold,
      limitNewTokens: tokenPolicy.limit,
      reserveNewTokens: tokenPolicy.synthesisReserve,
      triggerReason,
      triggeredNewTokens,
      instructionSha256: sha256,
      instructionSizeBytes: bytes.byteLength,
      instructionArtifactPath: artifactPath,
      triggeredAt: at,
    },
    write: { path: artifactPath, bytes, expectedSha256: null },
  };
}

export function assertSameLaunchSpec(
  expected: AgentLaunchSpec,
  actual: Readonly<AgentLaunchSpec>,
): void {
  if (
    expected.specHash !== actual.specHash ||
    expected.identity.attemptId !== actual.identity.attemptId
  ) {
    throw new AuthorityRpcError(
      "launch_identity",
      "context request uses a different launch specification",
    );
  }
}

/**
 * The stable planning attempt retains its original launch hash. A resumed revision is authorized
 * by the immutable launch binding on the current revision record instead of rewriting that
 * historical attempt identity.
 */
export function authoritativeLaunchSpecHash(
  run: Readonly<RunRecord>,
  attempt: Readonly<AgentAttemptRecord>,
): Sha256Digest {
  const session = run.planningSession;
  if (session?.attemptId !== attempt.id) return attempt.launchSpecHash;
  return session.revisions[session.currentRevision]?.launchSpecSha256 ?? attempt.launchSpecHash;
}

export function assertLiveAttempt(run: RunRecord, spec: AgentLaunchSpec): AgentAttemptRecord {
  const attempt = run.attempts[spec.identity.attemptId];
  if (
    attempt === undefined ||
    authoritativeLaunchSpecHash(run, attempt) !== spec.specHash ||
    !new Set(["queued", "running", "waiting_question"]).has(attempt.status) ||
    new Set(["pausing", "paused", "deleting", "deleted", "failed", "completed"]).has(
      run.lifecycle.phase,
    )
  ) {
    throw new AuthorityRpcError("attempt_inactive", "attempt no longer owns authoritative context");
  }
  return attempt;
}

/** Settlement consumes already-spent provider exposure and remains legal after terminal acceptance. */
export function assertProviderSettlementAttempt(
  run: RunRecord,
  spec: AgentLaunchSpec,
): AgentAttemptRecord {
  const attempt = run.attempts[spec.identity.attemptId];
  if (attempt === undefined || authoritativeLaunchSpecHash(run, attempt) !== spec.specHash) {
    throw new AuthorityRpcError(
      "provider_settlement_inactive",
      "attempt no longer matches a settleable durable provider reservation",
    );
  }
  return attempt;
}

export function toolReceiptPath(runId: string, attemptId: string, callId: string): string {
  return `runs/${runId}/attempts/${attemptId}/tool-receipts/${rawSha256(callId).slice(7)}.json`;
}

export function authorityMessagePath(
  runId: string,
  attemptId: string,
  sequence: number,
  digest: Sha256Digest,
): string {
  return `runs/${runId}/attempts/${attemptId}/authority-messages/${String(sequence).padStart(6, "0")}-${digest.slice(7)}.txt`;
}

export function planningSynthesisInstructionPath(
  runId: string,
  attemptId: string,
  digest: Sha256Digest,
  planningRevision?: number,
): string {
  if (planningRevision !== undefined) {
    return `runs/${runId}/attempts/${attemptId}/planning/revisions/${planningRevision}/synthesis-${digest.slice(7)}.txt`;
  }
  return `runs/${runId}/attempts/${attemptId}/planning-synthesis-${digest.slice(7)}.txt`;
}

export function terminalOutputPath(
  runId: string,
  attemptId: string,
  planningRevision?: number,
): string {
  if (planningRevision !== undefined) {
    return `runs/${runId}/attempts/${attemptId}/planning/revisions/${planningRevision}/terminal-output.json`;
  }
  return `runs/${runId}/attempts/${attemptId}/terminal-output.json`;
}

/** Leave immutable revision artifacts intact while reopening the stable planner for review/revision. */
export function clearPlanningRevisionTerminalState(attempt: AgentAttemptRecord): void {
  attempt.endedAt = undefined;
  attempt.terminalSummary = undefined;
  delete attempt.terminalOutputSha256;
  delete attempt.terminalOutputSizeBytes;
  delete attempt.terminalAcceptedAt;
  delete attempt.terminalPolicy;
}

export function planningCheckpointKey(runId: string, attemptId: string, revision: number): string {
  return `${runId}\0${attemptId}\0${revision}`;
}

export async function planningRevisionMapRecorded(
  sessionFile: string,
  revision: number,
): Promise<boolean> {
  let metadata;
  try {
    metadata = await lstat(sessionFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 128 * 1024 * 1024) {
    return false;
  }
  const lines = (await readFile(sessionFile, "utf8")).split("\n");
  for (const line of lines) {
    if (line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // This is routing only. The selected continuation/recovery path performs the authoritative
      // durable transcript parse and either truncates a legal tail or rejects malformed bytes.
      continue;
    }
    if (
      isRecord(entry) &&
      entry.type === "custom" &&
      entry.customType === "koni.planning-revision-map" &&
      isRecord(entry.data) &&
      entry.data.revision === revision
    ) {
      return true;
    }
  }
  return false;
}

export function canonicalTerminalOutputSha256(output: unknown): Sha256Digest {
  return rawSha256(encodeJsonArtifact(output));
}
