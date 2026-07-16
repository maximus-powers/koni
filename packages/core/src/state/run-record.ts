import type { JsonValue } from "../authority/protocol.js";
import type { Sha256Digest } from "../shared/canonical.js";
import type { RunLifecycleState } from "./run-lifecycle.js";

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

export interface TicketStepRecord {
  id: string;
  title: string;
  personaId: string;
  status: TicketStepStatus;
  attemptIds: string[];
  summary: string | undefined;
  startedAt: string | undefined;
  completedAt: string | undefined;
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
  worktreePath: string | undefined;
  branch: string | undefined;
  blocker: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export type AttemptStatus =
  | "queued"
  | "running"
  | "waiting_question"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted";

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
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
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

export interface RunGitRecord {
  targetRef: string;
  targetBaseOid: string;
  runBranch: string;
  runWorktree: string;
  candidateOid: string | undefined;
  promotionTargetOid: string | undefined;
  mergeReadyAt: string | undefined;
  mergedOid: string | undefined;
}

export interface RunPlanRecord {
  revision: number;
  status: "planning" | "awaiting_approval" | "approved" | "revising";
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
  objective: string;
  intake: Record<string, string>;
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
  questions: Record<string, RunQuestionRecord>;
  activity: RunActivityRecord[];
  git: RunGitRecord;
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
  for (const [id, ticket] of Object.entries(value.tickets)) {
    assertTicketRecord(id, ticket);
  }
  for (const [id, attempt] of Object.entries(value.attempts)) {
    if (!isRecord(attempt) || attempt.id !== id || !isId(id)) {
      throw new Error(`invalid attempt record: ${id}`);
    }
  }
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

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}
