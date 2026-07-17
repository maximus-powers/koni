import type { JsonValue } from "../authority/protocol.js";
import type {
  GitCompensationEvidence,
  GitLifecycleIntent,
  RunGitLifecycleRecord,
} from "../git/lifecycle.js";
import {
  assertGitLifecycleIntent,
  assertRunGitLifecycleRecord,
} from "../git/lifecycle.js";
import type { AgentAttemptLineage } from "../pi/launch-spec.js";
import { isSha256Digest, type Sha256Digest } from "../shared/canonical.js";
import type { RunLifecycleState } from "./run-lifecycle.js";
import {
  assertLegacyRunGitMigrationRecord,
  type LegacyRunGitMigrationRecord,
} from "./legacy-run-git-migration.js";
import {
  assertLegacyRunAdoptionRecord,
  type LegacyRunAdoptionRecord,
} from "./legacy-run-adoption.js";

export const RUN_RECORD_PROTOCOL = "koni.run-record.v1" as const;

export type TicketStatus =
  | "todo"
  | "ready"
  | "running"
  | "review"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type TicketStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export type TicketStepKind = "production" | "integration" | "review" | "agent" | "manual";

export interface TicketStepRecord {
  id: string;
  title: string;
  personaId: string;
  /** Optional only for durable records created before compiler review-rework projection. */
  kind?: TicketStepKind;
  status: TicketStepStatus;
  attemptIds: string[];
  summary: string | undefined;
  startedAt: string | undefined;
  completedAt: string | undefined;
}

export interface TicketReviewReworkRecord {
  ordinal: number;
  failedReviewAttemptId: string;
  reopenFromStepId: string;
  blocker: string;
  openedAt: string;
}

export interface TicketRecord {
  id: string;
  operationId: string;
  title: string;
  summary: string;
  status: TicketStatus;
  priority: number;
  dependencyIds: string[];
  targetNodeIds: string[];
  readPaths: string[];
  writePaths: string[];
  steps: TicketStepRecord[];
  /** Compiler-pinned owner step for one bounded failed-review rework cycle. */
  reviewFailureReopenFrom?: string;
  reviewReworkLimit?: number;
  reviewReworkCount?: number;
  reviewReworks?: TicketReviewReworkRecord[];
  worktreePath: string | undefined;
  branch: string | undefined;
  /** Authority-generated Git cycle backing this ticket's current execution/reissue. */
  gitCycleId?: string;
  /** When present, successful publication also resolves this conflicted predecessor ticket. */
  integrationForTicketId?: string;
  blocker: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export type AttemptStatus =
  | "queued"
  | "running"
  | "waiting_question"
  | "terminal_accepted"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted";

/**
 * One operator-authored message admitted by the authority before Pi receives it.
 * The artifact contains the exact UTF-8 bytes; this record authenticates their order and digest.
 */
export interface AgentAuthorityMessageRecord {
  sequence: number;
  mode: "steer" | "follow_up";
  sha256: Sha256Digest;
  sizeBytes: number;
  artifactPath: string;
  recordedAt: string;
}

/** One authority-accepted tool result that Pi may persist in the attempt transcript. */
export interface AgentAuthorityToolResultRecord {
  sequence: number;
  callId: string;
  toolName: string;
  outcome: "accepted" | "rejected";
  argumentsSha256: Sha256Digest;
  argumentsSizeBytes: number;
  receiptSha256: Sha256Digest;
  receiptSizeBytes: number;
  artifactPath: string;
  recordedAt: string;
}

/** One exact compiler-authored compaction Pi may append to the attempt transcript. */
export interface AgentAuthorityCompactionRecord {
  sequence: number;
  authorizationId: string;
  summaryHash: Sha256Digest;
  summaryBytes: number;
  firstKeptEntryId: string;
  tokensBefore: number;
  recordedAt: string;
}

/** Crash-forward intent for one authority-owned workspace write/edit effect. */
export interface WorkspaceEffectIntentRecord {
  id: string;
  attemptId: string;
  specHash: Sha256Digest;
  grantHash: Sha256Digest;
  callId: string;
  toolName: "koni_write_file" | "koni_edit_file";
  method: string;
  idempotencyKey: string;
  requestHash: Sha256Digest;
  argumentsSha256: Sha256Digest;
  argumentsSizeBytes: number;
  path: string;
  expectedSha256: Sha256Digest | null;
  desiredSha256: Sha256Digest;
  contentSizeBytes: number;
  contentArtifactPath: string;
  preparedAt: string;
}

/** Crash-forward boundary for a compiler-configured external validation request. */
export interface PendingCheckIntentRecord {
  id: string;
  attemptId: string;
  specHash: Sha256Digest;
  grantHash: Sha256Digest;
  callId: string;
  method: string;
  idempotencyKey: string;
  requestHash: Sha256Digest;
  argumentsSha256: Sha256Digest;
  argumentsSizeBytes: number;
  requestedCheckId: string;
  resolvedCheckSha256: Sha256Digest;
  resolvedCheck: JsonValue;
  preparedAt: string;
}

/** Immutable audit projection for one command leaf inside a compiler-configured check. */
export interface RunCheckCommandRecord {
  checkId: string;
  definitionHash: Sha256Digest;
  startedAt: string;
  completedAt: string;
  resolvedExecutable: string;
  argv: string[];
  environmentSha256: Sha256Digest;
  exitCode: number | null;
  signal: string | null;
  stdoutSha256: Sha256Digest;
  stdoutSizeBytes: number;
  stdoutArtifactPath: string;
  stderrSha256: Sha256Digest;
  stderrSizeBytes: number;
  stderrArtifactPath: string;
  preManifestSha256: Sha256Digest;
  postManifestSha256: Sha256Digest;
  sandboxKind: string;
  sandboxProfileSha256: Sha256Digest;
  /** Exact authority-startup authenticated sandbox launcher (new records only). */
  sandboxExecutableSha256?: Sha256Digest;
  resultSource: {
    kind: "stdout" | "file";
    path?: string;
    bytesSha256: Sha256Digest;
    sizeBytes: number;
  };
  outputFiles: Array<{ path: string; sha256: Sha256Digest; sizeBytes: number }>;
}

/** One complete compiler-accepted graph, command, or composite validation result. */
export interface RunCheckRecord {
  id: string;
  attemptId: string;
  callId: string;
  requestedCheckId: string;
  definitionHash: Sha256Digest;
  kind: "command" | "graph" | "composite";
  accepted: boolean;
  /** Required on new records; absent legacy records cannot satisfy current-step closure. */
  passed?: boolean;
  summary: string;
  commands: RunCheckCommandRecord[];
  evidenceSha256: Sha256Digest;
  evidenceSizeBytes: number;
  evidenceArtifactPath: string;
  recordedAt: string;
}

export interface AgentAttemptRecord {
  id: string;
  sessionId: string;
  ticketId: string;
  stepId: string;
  personaId: string;
  modelProvider: string;
  modelId: string;
  thinkingLevel: string;
  status: AttemptStatus;
  launchSpecHash: Sha256Digest;
  sessionFile: string | undefined;
  startedAt: string | undefined;
  endedAt: string | undefined;
  terminalSummary: string | undefined;
  /** Exact terminal argument bytes accepted and compiled atomically by the authority. */
  terminalOutputSha256?: Sha256Digest;
  terminalOutputSizeBytes?: number;
  terminalAcceptedAt?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Required on newly issued attempts; optional only for imported pre-lineage state. */
  lineage?: AgentAttemptLineage;
  /** Ordered, authority-authenticated operator messages delivered after the initial prompt. */
  authorityMessages?: AgentAuthorityMessageRecord[];
  /** Ordered authority receipts for every Pi-persisted tool result. */
  authorityToolResults?: AgentAuthorityToolResultRecord[];
  /** Ordered authority-issued compaction digests. */
  authorityCompactions?: AgentAuthorityCompactionRecord[];
  kind?: "planning" | "ticket" | "verification" | "integration";
  error?: string;
}

export interface RunAgentSelection {
  provider: string;
  model: string;
  thinkingLevel: string;
}

export interface RunExecutionConfig {
  maxParallel: number;
  questionPolicy: "none" | "some" | "many";
  instructions: string;
  agents: Record<string, RunAgentSelection>;
}

export interface RunQuestionOption {
  id: string;
  label: string;
  description: string;
}

export interface RunQuestionRecord {
  id: string;
  attemptId: string;
  prompt: string;
  options: RunQuestionOption[];
  allowsNotes: boolean;
  askedAt: string;
  answeredAt: string | undefined;
  selectedOptionId: string | undefined;
  notes: string | undefined;
}

export interface RunActivityRecord {
  id: string;
  at: string;
  kind: "compiler" | "graph_added" | "graph_modified" | "graph_deleted" | "agent" | "git";
  message: string;
  ticketId: string | undefined;
  nodeId: string | undefined;
}

/** The complete compiler-owned Git namespace; there is no parallel legacy source of truth. */
export type RunGitRecord = RunGitLifecycleRecord;

/** Immutable audit projection for one settled crash-forward Git intent. */
export interface RunGitReceiptRecord {
  intentId: string;
  kind: GitLifecycleIntent["kind"];
  status: "completed" | "blocked";
  lifecycleSha256: Sha256Digest;
  /** Runtime closure and exact Git bytes that executed the settled intent (new records only). */
  runtimeClosureSha256?: Sha256Digest;
  gitExecutableSha256?: Sha256Digest;
  settledAt: string;
  reason?: string;
  compensation?: GitCompensationEvidence;
}

/** Immutable compiler publication for one deterministic report bundle. */
export interface RunReportRecord {
  protocol: "koni.report-bundle.v1";
  reportId: string;
  bundleKind: string;
  bundleHash: Sha256Digest;
  graphHash: Sha256Digest;
  ticketBoardHash: Sha256Digest;
  runStateHash: Sha256Digest;
  manifestArtifactPath: string;
  outputs: Array<{
    ledgerId: string;
    format: "json" | "markdown" | "yaml" | "csv";
    artifactPath: string;
    sha256: Sha256Digest;
    sizeBytes: number;
  }>;
  compiledAt: string;
}

export interface RunPlanRecord {
  revision: number;
  status: "planning" | "awaiting_approval" | "approving" | "approved" | "revising";
  full: Record<string, string>;
  concise: Record<string, { title: string; description: string }[]>;
  graphSeed: JsonValue | undefined;
  steeringHistory: { at: string; instructions: string }[];
}

export interface RunRecord {
  protocol: typeof RUN_RECORD_PROTOCOL;
  id: string;
  revision: number;
  generation: number;
  projectRoot: string;
  profile: { packageName: string; packageVersion: string; lineage: string; bundleHash: Sha256Digest };
  compiledConfigHash: Sha256Digest;
  runTypeId: string;
  /** Pinned once at creation; absent only on legacy runs created before working specifications. */
  workingSpecOwnerId?: string;
  /** Absent only on imported pre-Pi-native records, which retain the historical agent default. */
  planningMode?: "agent" | "direct";
  objective: string;
  intake: Record<string, string>;
  executionConfig?: RunExecutionConfig;
  createdAt: string;
  updatedAt: string;
  lifecycle: RunLifecycleState;
  pipelineStageIds: string[];
  currentPipelineStageId: string | undefined;
  plan: RunPlanRecord | undefined;
  graphRevision: number;
  graphHash: Sha256Digest | undefined;
  tickets: Record<string, TicketRecord>;
  attempts: Record<string, AgentAttemptRecord>;
  /** Complete audit log for compiler-configured validation execution. */
  checks?: RunCheckRecord[];
  /** Exact compiler-owned dynamic predicate evidence envelope for the next graph pass. */
  ruleAuthorityEvidence?: JsonValue;
  /** Incomplete external effects only; completed effects are represented by receipts. */
  pendingEffects?: Record<string, WorkspaceEffectIntentRecord>;
  /** Incomplete external check executions; never treated as evidence until compiler finalization. */
  pendingChecks?: Record<string, PendingCheckIntentRecord>;
  questions: Record<string, RunQuestionRecord>;
  activity: RunActivityRecord[];
  git: RunGitRecord;
  /** Proof-bound compatibility record retained after a flat legacy Git-state migration. */
  legacyGitMigration?: LegacyRunGitMigrationRecord;
  /** Immutable Rust-era source binding for a distinct current authority-owned successor. */
  legacyRunAdoption?: LegacyRunAdoptionRecord;
  /** External Git effects in flight. Startup recovers these before any agent admission. */
  pendingGitIntents?: Record<string, GitLifecycleIntent>;
  /** Append-only authenticated settlement history for Git effects. */
  gitReceipts?: RunGitReceiptRecord[];
  /** Deterministic compiler report publications, newest last. */
  reports?: RunReportRecord[];
}

export function assertRunRecord(value: unknown): asserts value is RunRecord {
  if (!isRecord(value) || value.protocol !== RUN_RECORD_PROTOCOL) {
    throw new Error("run record protocol is missing or unsupported");
  }
  if (!isId(value.id) || !isRevision(value.revision) || !isRevision(value.generation)) {
    throw new Error("run record identity or revision is invalid");
  }
  if (
    typeof value.projectRoot !== "string" ||
    typeof value.objective !== "string" ||
    typeof value.runTypeId !== "string" ||
    !isRecord(value.lifecycle) ||
    !isRecord(value.tickets) ||
    !isRecord(value.attempts) ||
    !isRecord(value.questions) ||
    !Array.isArray(value.activity) ||
    !isRecord(value.git)
  ) {
    throw new Error("run record has an invalid required field");
  }
  if (value.planningMode !== undefined && value.planningMode !== "agent" && value.planningMode !== "direct") {
    throw new Error("run record planning mode is invalid");
  }
  if (value.workingSpecOwnerId !== undefined) {
    const execution = value.executionConfig;
    if (
      !isId(value.workingSpecOwnerId) ||
      (execution !== undefined && (
        !isRecord(execution) ||
        !isRecord(execution.agents) ||
        execution.agents[value.workingSpecOwnerId] === undefined
      ))
    ) throw new Error("run working-spec owner is invalid or is not a managed persona");
  }
  assertRunGitLifecycleRecord(value.git);
  if (value.legacyGitMigration !== undefined) {
    assertLegacyRunGitMigrationRecord(
      value.legacyGitMigration,
      value.id,
      value.projectRoot,
      value.git,
    );
  }
  if (value.legacyRunAdoption !== undefined) {
    assertLegacyRunAdoptionRecord(value.legacyRunAdoption);
    if (value.legacyRunAdoption.sourceRunId === value.id) {
      throw new Error("legacy run adoption must use a distinct current successor ID");
    }
  }
  if (value.legacyGitMigration !== undefined && value.legacyRunAdoption !== undefined) {
    throw new Error("run cannot be both a flat-Git migration and a Rust-era successor");
  }
  if (value.pendingGitIntents !== undefined) {
    if (!isRecord(value.pendingGitIntents)) throw new Error("run pending Git intents are invalid");
    for (const [id, intent] of Object.entries(value.pendingGitIntents)) {
      assertGitLifecycleIntent(intent);
      if (intent.id !== id || intent.runId !== value.id) {
        throw new Error(`invalid pending Git intent identity: ${id}`);
      }
    }
  }
  if (value.gitReceipts !== undefined && (
    !Array.isArray(value.gitReceipts) ||
    value.gitReceipts.some((receipt) =>
      !isRecord(receipt) ||
      typeof receipt.intentId !== "string" ||
      typeof receipt.kind !== "string" ||
      (receipt.status !== "completed" && receipt.status !== "blocked") ||
      !isSha256Digest(receipt.lifecycleSha256) ||
      (receipt.runtimeClosureSha256 !== undefined && !isSha256Digest(receipt.runtimeClosureSha256)) ||
      (receipt.gitExecutableSha256 !== undefined && !isSha256Digest(receipt.gitExecutableSha256)) ||
      typeof receipt.settledAt !== "string" ||
      !isOptionalCompensationEvidence(receipt.compensation)
    )
  )) throw new Error("run Git receipts are invalid");
  if (value.reports !== undefined) {
    if (!Array.isArray(value.reports) || value.reports.length > 10_000) {
      throw new Error("run report records are invalid");
    }
    for (const report of value.reports) assertRunReport(report);
  }
  for (const [id, ticket] of Object.entries(value.tickets)) {
    assertTicketRecord(id, ticket);
  }
  for (const [id, attempt] of Object.entries(value.attempts)) {
    assertAttemptRecord(id, attempt);
  }
  if (value.checks !== undefined) {
    if (!Array.isArray(value.checks) || value.checks.length > 100_000) {
      throw new Error("run check records are invalid");
    }
    for (const check of value.checks) assertRunCheck(check);
  }
  if (value.pendingEffects !== undefined) {
    if (!isRecord(value.pendingEffects)) throw new Error("run pending effects are invalid");
    for (const [id, effect] of Object.entries(value.pendingEffects)) assertWorkspaceEffect(id, effect);
  }
  if (value.pendingChecks !== undefined) {
    if (!isRecord(value.pendingChecks)) throw new Error("run pending checks are invalid");
    for (const [id, check] of Object.entries(value.pendingChecks)) assertPendingCheck(id, check);
  }
}

function isOptionalCompensationEvidence(value: unknown): boolean {
  if (value === undefined) return true;
  return isRecord(value) &&
    typeof value.originalIntentId === "string" && value.originalIntentId.length > 0 &&
    typeof value.priorOid === "string" && /^[0-9a-f]{40,64}$/u.test(value.priorOid) &&
    typeof value.candidateOid === "string" && /^[0-9a-f]{40,64}$/u.test(value.candidateOid) &&
    (value.compensationOid === undefined ||
      (typeof value.compensationOid === "string" && /^[0-9a-f]{40,64}$/u.test(value.compensationOid)));
}

function assertRunReport(value: unknown): asserts value is RunReportRecord {
  if (
    !isRecord(value) ||
    value.protocol !== "koni.report-bundle.v1" ||
    !isId(value.reportId) ||
    typeof value.bundleKind !== "string" || value.bundleKind.length === 0 ||
    !isSha256Digest(value.bundleHash) ||
    !isSha256Digest(value.graphHash) ||
    !isSha256Digest(value.ticketBoardHash) ||
    !isSha256Digest(value.runStateHash) ||
    typeof value.manifestArtifactPath !== "string" || value.manifestArtifactPath.length === 0 ||
    typeof value.compiledAt !== "string" || value.compiledAt.length === 0 ||
    !Array.isArray(value.outputs) ||
    value.outputs.some((output) =>
      !isRecord(output) ||
      typeof output.ledgerId !== "string" || output.ledgerId.length === 0 ||
      !["json", "markdown", "yaml", "csv"].includes(String(output.format)) ||
      typeof output.artifactPath !== "string" || output.artifactPath.length === 0 ||
      !isSha256Digest(output.sha256) ||
      !isNonnegativeSafeInteger(output.sizeBytes)
    )
  ) throw new Error("invalid run report record");
}

function assertPendingCheck(id: string, value: unknown): asserts value is PendingCheckIntentRecord {
  if (
    !isId(id) || !isRecord(value) || value.id !== id || !isId(value.attemptId) ||
    !isSha256Digest(value.specHash) || !isSha256Digest(value.grantHash) ||
    typeof value.callId !== "string" || value.callId.length === 0 ||
    typeof value.method !== "string" || value.method.length === 0 ||
    typeof value.idempotencyKey !== "string" || value.idempotencyKey.length === 0 ||
    !isSha256Digest(value.requestHash) || !isSha256Digest(value.argumentsSha256) ||
    !isNonnegativeSafeInteger(value.argumentsSizeBytes) || value.argumentsSizeBytes === 0 ||
    typeof value.requestedCheckId !== "string" || value.requestedCheckId.length === 0 ||
    !isSha256Digest(value.resolvedCheckSha256) || value.resolvedCheck === undefined ||
    typeof value.preparedAt !== "string"
  ) throw new Error(`invalid pending check: ${id}`);
}

function assertRunCheck(value: unknown): asserts value is RunCheckRecord {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.attemptId) ||
    typeof value.callId !== "string" || value.callId.length === 0 ||
    typeof value.requestedCheckId !== "string" || value.requestedCheckId.length === 0 ||
    !isSha256Digest(value.definitionHash) ||
    !["command", "graph", "composite"].includes(String(value.kind)) ||
    typeof value.accepted !== "boolean" ||
    (value.passed !== undefined && typeof value.passed !== "boolean") ||
    typeof value.summary !== "string" ||
    !Array.isArray(value.commands) ||
    !isSha256Digest(value.evidenceSha256) ||
    !isNonnegativeSafeInteger(value.evidenceSizeBytes) ||
    typeof value.evidenceArtifactPath !== "string" || value.evidenceArtifactPath.length === 0 ||
    typeof value.recordedAt !== "string"
  ) throw new Error("invalid run check record");
  for (const command of value.commands) {
    if (
      !isRecord(command) ||
      typeof command.checkId !== "string" || command.checkId.length === 0 ||
      !isSha256Digest(command.definitionHash) ||
      typeof command.startedAt !== "string" ||
      typeof command.completedAt !== "string" ||
      typeof command.resolvedExecutable !== "string" || command.resolvedExecutable.length === 0 ||
      !isStringArray(command.argv) || command.argv.length === 0 ||
      !isSha256Digest(command.environmentSha256) ||
      !(command.exitCode === null || Number.isSafeInteger(command.exitCode)) ||
      !(command.signal === null || typeof command.signal === "string") ||
      !isSha256Digest(command.stdoutSha256) ||
      !isNonnegativeSafeInteger(command.stdoutSizeBytes) ||
      typeof command.stdoutArtifactPath !== "string" || command.stdoutArtifactPath.length === 0 ||
      !isSha256Digest(command.stderrSha256) ||
      !isNonnegativeSafeInteger(command.stderrSizeBytes) ||
      typeof command.stderrArtifactPath !== "string" || command.stderrArtifactPath.length === 0 ||
      !isSha256Digest(command.preManifestSha256) ||
      !isSha256Digest(command.postManifestSha256) ||
      typeof command.sandboxKind !== "string" || command.sandboxKind.length === 0 ||
      !isSha256Digest(command.sandboxProfileSha256) ||
      (command.sandboxExecutableSha256 !== undefined &&
        !isSha256Digest(command.sandboxExecutableSha256)) ||
      !isRecord(command.resultSource) ||
      (command.resultSource.kind !== "stdout" && command.resultSource.kind !== "file") ||
      (command.resultSource.kind === "file" &&
        (typeof command.resultSource.path !== "string" || command.resultSource.path.length === 0)) ||
      !isSha256Digest(command.resultSource.bytesSha256) ||
      !isNonnegativeSafeInteger(command.resultSource.sizeBytes) ||
      !Array.isArray(command.outputFiles) ||
      command.outputFiles.some((file) =>
        !isRecord(file) || typeof file.path !== "string" || file.path.length === 0 ||
        !isSha256Digest(file.sha256) || !isNonnegativeSafeInteger(file.sizeBytes)
      )
    ) throw new Error("invalid run check command record");
  }
}

function assertWorkspaceEffect(id: string, value: unknown): asserts value is WorkspaceEffectIntentRecord {
  if (
    !isId(id) ||
    !isRecord(value) ||
    value.id !== id ||
    !isId(value.attemptId) ||
    !isSha256Digest(value.specHash) ||
    !isSha256Digest(value.grantHash) ||
    typeof value.callId !== "string" || value.callId.length === 0 ||
    (value.toolName !== "koni_write_file" && value.toolName !== "koni_edit_file") ||
    typeof value.method !== "string" ||
    typeof value.idempotencyKey !== "string" ||
    !isSha256Digest(value.requestHash) ||
    !isSha256Digest(value.argumentsSha256) ||
    !isNonnegativeSafeInteger(value.argumentsSizeBytes) || value.argumentsSizeBytes === 0 ||
    typeof value.path !== "string" || value.path.length === 0 ||
    (value.expectedSha256 !== null && !isSha256Digest(value.expectedSha256)) ||
    !isSha256Digest(value.desiredSha256) ||
    !isNonnegativeSafeInteger(value.contentSizeBytes) ||
    typeof value.contentArtifactPath !== "string" || value.contentArtifactPath.length === 0 ||
    typeof value.preparedAt !== "string"
  ) throw new Error(`invalid pending workspace effect: ${id}`);
}

export function assertTicketGraph(tickets: Readonly<Record<string, TicketRecord>>): void {
  const ids = new Set(Object.keys(tickets));
  for (const ticket of Object.values(tickets)) {
    if (new Set(ticket.dependencyIds).size !== ticket.dependencyIds.length) {
      throw new Error(`ticket has duplicate dependencies: ${ticket.id}`);
    }
    for (const dependency of ticket.dependencyIds) {
      if (!ids.has(dependency)) {
        throw new Error(`ticket ${ticket.id} has unknown dependency ${dependency}`);
      }
      if (dependency === ticket.id) {
        throw new Error(`ticket ${ticket.id} depends on itself`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new Error(`ticket dependency cycle includes ${id}`);
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    for (const dependency of tickets[id]!.dependencyIds) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...ids].sort()) {
    visit(id);
  }
}

function assertTicketRecord(id: string, value: unknown): asserts value is TicketRecord {
  if (
    !isId(id) ||
    !isRecord(value) ||
    value.id !== id ||
    typeof value.operationId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.status !== "string" ||
    !Number.isSafeInteger(value.priority) ||
    !isStringArray(value.dependencyIds) ||
    !Array.isArray(value.steps)
  ) {
    throw new Error(`invalid ticket record: ${id}`);
  }
  for (const step of value.steps) {
    if (
      !isRecord(step) ||
      !isId(step.id) ||
      typeof step.title !== "string" ||
      !isId(step.personaId) ||
      (step.kind !== undefined &&
        !["production", "integration", "review", "agent", "manual"].includes(String(step.kind))) ||
      !["pending", "running", "completed", "failed", "skipped"].includes(String(step.status)) ||
      !isStringArray(step.attemptIds)
    ) throw new Error(`invalid ticket step: ${id}`);
  }
  if (
    value.reviewFailureReopenFrom !== undefined ||
    value.reviewReworkLimit !== undefined ||
    value.reviewReworkCount !== undefined ||
    value.reviewReworks !== undefined
  ) {
    if (
      !isId(value.reviewFailureReopenFrom) ||
      !Number.isSafeInteger(value.reviewReworkLimit) ||
      Number(value.reviewReworkLimit) < 1 ||
      !isNonnegativeSafeInteger(value.reviewReworkCount) ||
      Number(value.reviewReworkCount) > Number(value.reviewReworkLimit) ||
      !Array.isArray(value.reviewReworks) ||
      value.reviewReworks.length !== Number(value.reviewReworkCount) ||
      value.reviewReworks.some((rework, index) =>
        !isRecord(rework) ||
        rework.ordinal !== index + 1 ||
        !isId(rework.failedReviewAttemptId) ||
        rework.reopenFromStepId !== value.reviewFailureReopenFrom ||
        typeof rework.blocker !== "string" || rework.blocker.length === 0 ||
        typeof rework.openedAt !== "string" || rework.openedAt.length === 0) ||
      !value.steps.some((step) => step.id === value.reviewFailureReopenFrom) ||
      !value.steps.some((step) => step.kind === "review")
    ) throw new Error(`invalid ticket review-rework state: ${id}`);
  }
}

function assertAttemptRecord(id: string, value: unknown): asserts value is AgentAttemptRecord {
  if (
    !isId(id) ||
    !isRecord(value) ||
    value.id !== id ||
    !isId(value.sessionId) ||
    !isId(value.ticketId) ||
    !isId(value.stepId) ||
    !isId(value.personaId) ||
    typeof value.status !== "string" ||
    !isSha256Digest(value.launchSpecHash) ||
    !isNonnegativeSafeInteger(value.inputTokens) ||
    !isNonnegativeSafeInteger(value.outputTokens) ||
    !isNonnegativeSafeInteger(value.cacheReadTokens) ||
    !isNonnegativeSafeInteger(value.cacheWriteTokens)
  ) throw new Error(`invalid attempt record: ${id}`);

  if (value.lineage !== undefined) {
    if (
      !isRecord(value.lineage) ||
      !isNonnegativeSafeInteger(value.lineage.branchEpoch) ||
      !["initial", "retry", "rework", "review", "recovery", "integration"].includes(String(value.lineage.reason)) ||
      (value.lineage.parentAttemptId !== undefined && !isId(value.lineage.parentAttemptId)) ||
      (value.lineage.parentSessionId !== undefined && !isId(value.lineage.parentSessionId)) ||
      ((value.lineage.parentAttemptId === undefined) !== (value.lineage.parentSessionId === undefined))
    ) throw new Error(`invalid attempt lineage: ${id}`);
  }
  assertOrderedAuthorityRecords(value.authorityMessages, (entry) =>
    isRecord(entry) &&
    (entry.mode === "steer" || entry.mode === "follow_up") &&
    isSha256Digest(entry.sha256) &&
    isNonnegativeSafeInteger(entry.sizeBytes) && entry.sizeBytes > 0 &&
    typeof entry.artifactPath === "string" &&
    typeof entry.recordedAt === "string",
  `attempt authority messages: ${id}`);
  assertOrderedAuthorityRecords(value.authorityToolResults, (entry) =>
    isRecord(entry) &&
    typeof entry.callId === "string" && entry.callId.length > 0 &&
    typeof entry.toolName === "string" && entry.toolName.length > 0 &&
    (entry.outcome === "accepted" || entry.outcome === "rejected") &&
    isSha256Digest(entry.argumentsSha256) &&
    isNonnegativeSafeInteger(entry.argumentsSizeBytes) && entry.argumentsSizeBytes > 0 &&
    isSha256Digest(entry.receiptSha256) &&
    isNonnegativeSafeInteger(entry.receiptSizeBytes) && entry.receiptSizeBytes > 0 &&
    typeof entry.artifactPath === "string" &&
    typeof entry.recordedAt === "string",
  `attempt authority tool results: ${id}`);
  assertOrderedAuthorityRecords(value.authorityCompactions, (entry) =>
    isRecord(entry) &&
    typeof entry.authorizationId === "string" && entry.authorizationId.length > 0 &&
    isSha256Digest(entry.summaryHash) &&
    isNonnegativeSafeInteger(entry.summaryBytes) && entry.summaryBytes > 0 &&
    typeof entry.firstKeptEntryId === "string" && entry.firstKeptEntryId.length > 0 &&
    isNonnegativeSafeInteger(entry.tokensBefore) &&
    typeof entry.recordedAt === "string",
  `attempt authority compactions: ${id}`);
  const hasTerminalDigest = value.terminalOutputSha256 !== undefined;
  const hasTerminalSize = value.terminalOutputSizeBytes !== undefined;
  const hasTerminalTime = value.terminalAcceptedAt !== undefined;
  if (
    hasTerminalDigest !== hasTerminalSize ||
    hasTerminalDigest !== hasTerminalTime ||
    (hasTerminalDigest && (
      !isSha256Digest(value.terminalOutputSha256) ||
      !isNonnegativeSafeInteger(value.terminalOutputSizeBytes) ||
      value.terminalOutputSizeBytes === 0 ||
      typeof value.terminalAcceptedAt !== "string"
    )) ||
    (value.status === "terminal_accepted" && !hasTerminalDigest)
  ) throw new Error(`invalid attempt terminal acceptance: ${id}`);
}

function assertOrderedAuthorityRecords(
  value: unknown,
  validate: (entry: unknown) => boolean,
  label: string,
): void {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.length > 100_000 ||
    value.some((entry, index) =>
      !validate(entry) || !isRecord(entry) || entry.sequence !== index + 1
    )
  ) throw new Error(`invalid ${label}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}
