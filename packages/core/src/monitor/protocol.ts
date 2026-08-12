import type { JsonValue } from "../authority/protocol.js";
import type { RunBlockerRemedy, RunPhase } from "../state/run-lifecycle.js";
import {
  parseControlProposalInspection,
  type ControlProposalInspection,
} from "../control-center/protocol.js";
import { terminalSafeText } from "./terminal.js";

export const MONITOR_SNAPSHOT_PROTOCOL = "koni.monitor-snapshot.v1" as const;
export const MONITOR_EVENTS_PROTOCOL = "koni.monitor-events.v1" as const;
export const MONITOR_ATTENTION_PROTOCOL = "koni.monitor-attention.v1" as const;
export const MAX_MONITOR_RUNS = 200;
export const MAX_MONITOR_EVENTS = 500;
export const MAX_MONITOR_QUESTIONS = 50;
export const MAX_MONITOR_PROPOSALS = 50;
export const MAX_QUESTION_OPTIONS = 20;
export const MAX_QUESTION_NOTES_CODE_POINTS = 8_000;
export const MAX_PLAN_REVISION_CODE_POINTS = 16_000;
export const MAX_PROPOSAL_MESSAGE_CODE_POINTS = 8_000;

export interface MonitorCounts {
  completed: number;
  total: number;
}

export interface MonitorAgentCounts {
  active: number;
  total: number;
}

export interface MonitorTokenCounts {
  /** Input + output only. This is the operator-facing non-cached total. */
  new: number;
  cache: number;
  total: number;
}

export interface MonitorRunSummary {
  id: string;
  runRevision: number;
  objectivePreview: string;
  /** Planner-authored short run name; absent until an agent plan compiles. */
  title?: string;
  runType: string;
  phase: RunPhase;
  stage: string | undefined;
  updatedAt: string;
  tickets: MonitorCounts;
  agents: MonitorAgentCounts;
  tokens: MonitorTokenCounts;
  questionCount: number;
  /** Exact pending operator decisions; absent only in a rolling-build compatibility snapshot. */
  proposalCount: number;
  planApproval: boolean;
  blocker: string | undefined;
  /** What actually clears the blocker; absent on pre-typed-remedy records. */
  blockerRemedy?: RunBlockerRemedy;
  failure: string | undefined;
  mergeReady: boolean;
}

export interface MonitorSnapshot {
  protocol: typeof MONITOR_SNAPSHOT_PROTOCOL;
  revision: number;
  eventCursor: number;
  totalRuns: number;
  truncated: boolean;
  runs: readonly MonitorRunSummary[];
}

export type MonitorEventKind =
  | "run_created"
  | "stage_changed"
  | "ticket_completed"
  | "question_opened"
  | "question_resolved"
  | "proposal_opened"
  | "proposal_resolved"
  | "plan_ready"
  | "plan_resolved"
  | "blocked"
  | "failed"
  | "merge_ready"
  | "run_updated";

export interface MonitorEvent {
  sequence: number;
  at: string;
  kind: MonitorEventKind;
  runId: string;
  runRevision: number;
  title: string;
  detail: string | undefined;
  ticketId: string | undefined;
}

export interface MonitorEvents {
  protocol: typeof MONITOR_EVENTS_PROTOCOL;
  fromCursor: number;
  nextCursor: number;
  truncated: boolean;
  events: readonly MonitorEvent[];
}

export interface MonitorQuestionOption {
  id: string;
  label: string;
  description: string;
}

export interface MonitorQuestion {
  id: string;
  prompt: string;
  options: readonly MonitorQuestionOption[];
  allowsNotes: boolean;
  askedAt: string;
  batchId?: string;
  batchVersion?: number;
  batchPosition?: number;
  batchSize?: number;
  recommendedOptionId?: string;
  answerSaved?: boolean;
  resolvesBatchOnSubmit?: boolean;
}

export type MonitorPlanSectionId = "architecture" | "decisions" | "risk" | "verification";

export interface MonitorPlanItem {
  title: string;
  description: string;
}

export interface MonitorPlanAttention {
  revision: number;
  /** Stable Pi session identity for new continuous-planning runs; absent for legacy runs. */
  planningSessionId?: string;
  /** Stable planner attempt identity for new continuous-planning runs; absent for legacy runs. */
  planningAttemptId?: string;
  revisionUsage?: {
    cumulative: MonitorTokenCounts;
    currentRevision: MonitorTokenCounts;
  };
  sections: Readonly<Record<MonitorPlanSectionId, readonly MonitorPlanItem[]>>;
  graphSeedCounts: Readonly<Record<string, number>>;
}

export interface MonitorAttention {
  protocol: typeof MONITOR_ATTENTION_PROTOCOL;
  runId: string;
  runRevision: number;
  questions: readonly MonitorQuestion[];
  proposals: readonly ControlProposalInspection[];
  plan: MonitorPlanAttention | undefined;
}

const RUN_PHASES = new Set<RunPhase>([
  "draft",
  "planning",
  "awaiting_questions",
  "awaiting_approval",
  "approving",
  "executing",
  "pausing",
  "paused",
  "verifying",
  "merge_ready",
  "merging",
  "blocked",
  "completed",
  "failed",
  "deleting",
  "deleted",
]);
const EVENT_KINDS = new Set<MonitorEventKind>([
  "run_created",
  "stage_changed",
  "ticket_completed",
  "question_opened",
  "question_resolved",
  "proposal_opened",
  "proposal_resolved",
  "plan_ready",
  "plan_resolved",
  "blocked",
  "failed",
  "merge_ready",
  "run_updated",
]);
const PLAN_SECTIONS: readonly MonitorPlanSectionId[] = [
  "architecture",
  "decisions",
  "risk",
  "verification",
];

const BLOCKER_REMEDIES = new Set<string>([
  "auto",
  "resume",
  "stop",
  "fresh_epoch",
  "new_run",
  "change_request",
]);

/** An unknown remedy is a protocol mismatch, not a value to render; fail closed like every peer. */
function optionalBlockerRemedy(value: unknown): RunBlockerRemedy | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !BLOCKER_REMEDIES.has(value)) {
    throw new Error("run blocker remedy is invalid");
  }
  return value as RunBlockerRemedy;
}

export function parseMonitorSnapshot(value: JsonValue | undefined | unknown): MonitorSnapshot {
  const root = record(value, "monitor snapshot");
  if (root.protocol !== MONITOR_SNAPSHOT_PROTOCOL)
    throw new Error("unsupported monitor snapshot protocol");
  const runs = array(root.runs, "monitor runs", MAX_MONITOR_RUNS).map((entry, index) => {
    const row = record(entry, `monitor run ${index + 1}`);
    const phase = text(row.phase, "run phase", 32);
    if (!RUN_PHASES.has(phase as RunPhase) || phase === "deleted") {
      throw new Error(`monitor run ${index + 1} has invalid phase`);
    }
    const tokens = tokenCounts(row.tokens, `run ${index + 1} tokens`);
    if (tokens.total !== tokens.new + tokens.cache) {
      throw new Error(`monitor run ${index + 1} token totals are inconsistent`);
    }
    const questionCount = integer(row.questionCount, "question count");
    const proposalCount =
      row.proposalCount === undefined ? 0 : integer(row.proposalCount, "proposal count");
    if (
      proposalCount > completedCounts(row.tickets, `run ${index + 1} proposal ticket bounds`).total
    ) {
      throw new Error(`monitor run ${index + 1} proposal count exceeds its ticket count`);
    }
    const planApproval = boolean(row.planApproval, "plan approval");
    if (planApproval && phase !== "awaiting_approval") {
      throw new Error(`monitor run ${index + 1} approval flag is inconsistent with its phase`);
    }
    const mergeReady = boolean(row.mergeReady, "merge ready");
    if (mergeReady && phase !== "merge_ready") {
      throw new Error(`monitor run ${index + 1} merge-ready flag is inconsistent with its phase`);
    }
    return {
      id: text(row.id, "run id", 256),
      runRevision: integer(row.runRevision, "run revision"),
      objectivePreview: safeText(row.objectivePreview, "objective preview", 1_024),
      ...(row.title === undefined ? {} : { title: safeText(row.title, "run title", 80) }),
      runType: safeText(row.runType, "run type", 128),
      phase: phase as RunPhase,
      stage: optionalSafeText(row.stage, "run stage", 256),
      updatedAt: timestamp(row.updatedAt, "run updated time"),
      tickets: completedCounts(row.tickets, `run ${index + 1} tickets`),
      agents: agentCounts(row.agents, `run ${index + 1} agents`),
      tokens,
      questionCount,
      proposalCount,
      planApproval,
      blocker: optionalSafeText(row.blocker, "run blocker", 1_024),
      ...(optionalBlockerRemedy(row.blockerRemedy) === undefined
        ? {}
        : { blockerRemedy: optionalBlockerRemedy(row.blockerRemedy)! }),
      failure: optionalSafeText(row.failure, "run failure", 1_024),
      mergeReady,
    } satisfies MonitorRunSummary;
  });
  const ids = new Set(runs.map((run) => run.id));
  if (ids.size !== runs.length) throw new Error("monitor snapshot contains duplicate runs");
  const totalRuns = integer(root.totalRuns, "total runs");
  const truncated = boolean(root.truncated, "snapshot truncated flag");
  if (totalRuns < runs.length || truncated !== totalRuns > runs.length) {
    throw new Error("monitor snapshot truncation metadata is inconsistent");
  }
  return {
    protocol: MONITOR_SNAPSHOT_PROTOCOL,
    revision: integer(root.revision, "snapshot revision"),
    eventCursor: integer(root.eventCursor, "snapshot event cursor"),
    totalRuns,
    truncated,
    runs,
  };
}

export function parseMonitorEvents(value: JsonValue | undefined | unknown): MonitorEvents {
  const root = record(value, "monitor events");
  if (root.protocol !== MONITOR_EVENTS_PROTOCOL)
    throw new Error("unsupported monitor events protocol");
  const fromCursor = integer(root.fromCursor, "events starting cursor");
  const nextCursor = integer(root.nextCursor, "events next cursor");
  if (nextCursor < fromCursor) throw new Error("monitor event cursor moved backwards");
  let previous = fromCursor;
  const events = array(root.events, "monitor events", MAX_MONITOR_EVENTS).map((entry, index) => {
    const row = record(entry, `monitor event ${index + 1}`);
    const sequence = integer(row.sequence, "event sequence");
    if (sequence <= previous || sequence > nextCursor)
      throw new Error("monitor events are not strictly ordered");
    previous = sequence;
    const kind = text(row.kind, "event kind", 64);
    if (!EVENT_KINDS.has(kind as MonitorEventKind))
      throw new Error(`unsupported monitor event kind ${kind}`);
    return {
      sequence,
      at: timestamp(row.at, "event time"),
      kind: kind as MonitorEventKind,
      runId: text(row.runId, "event run id", 256),
      runRevision: integer(row.runRevision, "event run revision"),
      title: safeText(row.title, "event title", 256),
      detail: optionalSafeText(row.detail, "event detail", 1_024),
      ticketId: optionalText(row.ticketId, "event ticket id", 256),
    } satisfies MonitorEvent;
  });
  const truncated = boolean(root.truncated, "events truncated flag");
  if (!truncated && previous !== nextCursor) {
    throw new Error("monitor event page does not reach its advertised cursor");
  }
  return { protocol: MONITOR_EVENTS_PROTOCOL, fromCursor, nextCursor, truncated, events };
}

export function parseMonitorAttention(value: JsonValue | undefined | unknown): MonitorAttention {
  const root = record(value, "monitor attention");
  if (root.protocol !== MONITOR_ATTENTION_PROTOCOL)
    throw new Error("unsupported monitor attention protocol");
  const questions = array(root.questions, "monitor questions", MAX_MONITOR_QUESTIONS).map(
    (entry, index) => {
      const row = record(entry, `monitor question ${index + 1}`);
      const options = array(row.options, "question options", MAX_QUESTION_OPTIONS).map(
        (option, optionIndex) => {
          const item = record(option, `question option ${optionIndex + 1}`);
          return {
            id: text(item.id, "option id", 256),
            label: safeText(item.label, "option label", 256),
            description: safeText(item.description, "option description", 1_024),
          } satisfies MonitorQuestionOption;
        },
      );
      if (new Set(options.map((option) => option.id)).size !== options.length) {
        throw new Error(`monitor question ${index + 1} contains duplicate options`);
      }
      const allowsNotes = boolean(row.allowsNotes, "question allows-notes flag");
      if (options.length === 0 && !allowsNotes) {
        throw new Error(`monitor question ${index + 1} has no answer path`);
      }
      const batchId = optionalText(row.batchId, "question batch id", 256);
      const batchVersion =
        row.batchVersion === undefined
          ? undefined
          : integer(row.batchVersion, "question batch version");
      const batchPosition =
        row.batchPosition === undefined
          ? undefined
          : positiveInteger(row.batchPosition, "question batch position");
      const batchSize =
        row.batchSize === undefined
          ? undefined
          : positiveInteger(row.batchSize, "question batch size");
      if (
        (batchId === undefined) !== (batchVersion === undefined) ||
        (batchPosition === undefined) !== (batchSize === undefined)
      ) {
        throw new Error(`monitor question ${index + 1} has incomplete batch metadata`);
      }
      if (batchPosition !== undefined && batchSize !== undefined && batchPosition > batchSize) {
        throw new Error(`monitor question ${index + 1} has invalid batch position`);
      }
      const recommendedOptionId = optionalText(
        row.recommendedOptionId,
        "recommended option id",
        256,
      );
      if (
        recommendedOptionId !== undefined &&
        !options.some((option) => option.id === recommendedOptionId)
      ) {
        throw new Error(`monitor question ${index + 1} recommendation is not an option`);
      }
      const answerSaved =
        row.answerSaved === undefined
          ? undefined
          : boolean(row.answerSaved, "question answer-saved flag");
      const resolvesBatchOnSubmit =
        row.resolvesBatchOnSubmit === undefined
          ? undefined
          : boolean(row.resolvesBatchOnSubmit, "question resolve-on-submit flag");
      return {
        id: text(row.id, "question id", 256),
        prompt: safeText(row.prompt, "question prompt", 4_096),
        options,
        allowsNotes,
        askedAt: timestamp(row.askedAt, "question asked time"),
        ...(batchId === undefined ? {} : { batchId }),
        ...(batchVersion === undefined ? {} : { batchVersion }),
        ...(batchPosition === undefined ? {} : { batchPosition }),
        ...(batchSize === undefined ? {} : { batchSize }),
        ...(recommendedOptionId === undefined ? {} : { recommendedOptionId }),
        ...(answerSaved === undefined ? {} : { answerSaved }),
        ...(resolvesBatchOnSubmit === undefined ? {} : { resolvesBatchOnSubmit }),
      } satisfies MonitorQuestion;
    },
  );
  if (new Set(questions.map((question) => question.id)).size !== questions.length) {
    throw new Error("monitor attention contains duplicate questions");
  }
  const proposals =
    root.proposals === undefined
      ? []
      : array(root.proposals, "monitor proposals", MAX_MONITOR_PROPOSALS).map((proposal) =>
          parseControlProposalInspection(proposal),
        );
  if (new Set(proposals.map((proposal) => proposal.ticketId)).size !== proposals.length) {
    throw new Error("monitor attention contains duplicate proposals");
  }
  if (
    proposals.some(
      (proposal) =>
        proposal.runId !== root.runId ||
        proposal.status !== "proposed" ||
        proposal.disposition.kind !== "pending",
    )
  ) {
    throw new Error("monitor attention contains a non-actionable or cross-run proposal");
  }
  return {
    protocol: MONITOR_ATTENTION_PROTOCOL,
    runId: text(root.runId, "attention run id", 256),
    runRevision: integer(root.runRevision, "attention run revision"),
    questions,
    proposals,
    plan: root.plan === undefined || root.plan === null ? undefined : parsePlanAttention(root.plan),
  };
}

function parsePlanAttention(value: unknown): MonitorPlanAttention {
  const row = record(value, "monitor plan attention");
  const sections = record(row.sections, "monitor plan sections");
  const parsed = Object.fromEntries(
    PLAN_SECTIONS.map((section) => [
      section,
      array(sections[section], `${section} plan items`, 50).map((entry, index) => {
        const item = record(entry, `${section} plan item ${index + 1}`);
        return {
          title: safeText(item.title, "plan item title", 256),
          description: safeText(item.description, "plan item description", 2_048),
        } satisfies MonitorPlanItem;
      }),
    ]),
  ) as unknown as Record<MonitorPlanSectionId, readonly MonitorPlanItem[]>;
  const rawCounts = record(row.graphSeedCounts, "graph seed counts");
  if (Object.keys(rawCounts).length > 100)
    throw new Error("monitor graph seed counts exceed their bound");
  const graphSeedCounts: Record<string, number> = {};
  for (const [rawKey, rawValue] of Object.entries(rawCounts)) {
    const key = terminalSafeText(rawKey, { maxCodePoints: 128 });
    if (key.length === 0 || key in graphSeedCounts)
      throw new Error("monitor graph seed count key is invalid");
    graphSeedCounts[key] = integer(rawValue, `graph seed count ${key}`);
  }
  const planningSessionId = optionalText(row.planningSessionId, "planning session id", 256);
  const planningAttemptId = optionalText(row.planningAttemptId, "planning attempt id", 256);
  const revisionUsage =
    row.revisionUsage === undefined ? undefined : planningRevisionUsage(row.revisionUsage);
  if (
    (planningSessionId === undefined) !== (planningAttemptId === undefined) ||
    (planningSessionId === undefined) !== (revisionUsage === undefined)
  ) {
    throw new Error("monitor plan attention has incomplete planning-session metadata");
  }
  return {
    revision: integer(row.revision, "plan revision"),
    ...(planningSessionId === undefined
      ? {}
      : {
          planningSessionId,
          planningAttemptId: planningAttemptId!,
          revisionUsage: revisionUsage!,
        }),
    sections: parsed,
    graphSeedCounts,
  };
}

function planningRevisionUsage(value: unknown): NonNullable<MonitorPlanAttention["revisionUsage"]> {
  const row = record(value, "planning revision usage");
  const cumulative = tokenCounts(row.cumulative, "cumulative planning usage");
  const currentRevision = tokenCounts(row.currentRevision, "current planning revision usage");
  if (
    cumulative.total !== cumulative.new + cumulative.cache ||
    currentRevision.total !== currentRevision.new + currentRevision.cache ||
    currentRevision.new > cumulative.new ||
    currentRevision.cache > cumulative.cache
  ) {
    throw new Error("monitor planning revision token totals are inconsistent");
  }
  return { cumulative, currentRevision };
}

function completedCounts(value: unknown, name: string): MonitorCounts {
  const row = record(value, name);
  const completed = integer(row.completed, `${name} completed`);
  const total = integer(row.total, `${name} total`);
  if (completed > total) throw new Error(`${name} completed count exceeds total`);
  return { completed, total };
}

function agentCounts(value: unknown, name: string): MonitorAgentCounts {
  const row = record(value, name);
  const active = integer(row.active, `${name} active`);
  const total = integer(row.total, `${name} total`);
  if (active > total) throw new Error(`${name} active count exceeds total`);
  return { active, total };
}

function tokenCounts(value: unknown, name: string): MonitorTokenCounts {
  const row = record(value, name);
  return {
    new: integer(row.new, `${name} new`),
    cache: integer(row.cache, `${name} cache`),
    total: integer(row.total, `${name} total`),
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${name} is invalid`);
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error(`${name} is invalid or exceeds ${maximum}`);
  return value;
}

function text(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || [...value].length > maximum)
    throw new Error(`${name} is invalid`);
  return value;
}

function safeText(value: unknown, name: string, maximum: number): string {
  const raw = text(value, name, maximum * 4);
  const safe = terminalSafeText(raw, { maxCodePoints: maximum });
  if (safe.length === 0) throw new Error(`${name} is empty after terminal normalization`);
  return safe;
}

function optionalText(value: unknown, name: string, maximum: number): string | undefined {
  return value === undefined || value === null ? undefined : text(value, name, maximum);
}

function optionalSafeText(value: unknown, name: string, maximum: number): string | undefined {
  return value === undefined || value === null ? undefined : safeText(value, name, maximum);
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} is invalid`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = integer(value, name);
  if (parsed < 1) throw new Error(`${name} must be positive`);
  return parsed;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} is invalid`);
  return value;
}

function timestamp(value: unknown, name: string): string {
  const parsed = text(value, name, 64);
  if (!Number.isFinite(Date.parse(parsed))) throw new Error(`${name} is invalid`);
  return parsed;
}
