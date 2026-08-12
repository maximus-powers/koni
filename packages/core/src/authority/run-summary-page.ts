import {
  canonicalEncode,
  canonicalHash,
  compareUtf8,
  isSha256Digest,
  type Sha256Digest,
} from "../shared/canonical.js";
import type { RunBlockerRemedy, RunPhase, ResumableRunPhase } from "../state/run-lifecycle.js";
import type { AgentAttemptRecord, RunRecord, TicketRecord } from "../state/run-record.js";
import { runExecutionHalted, ticketWaitingForCompilerGrant } from "../state/effective-status.js";
import { terminalSafeText } from "../monitor/terminal.js";

export const RUN_SUMMARY_PAGE_PROTOCOL = "koni.run-summary-page.v2" as const;
export const RUN_SUMMARY_CURSOR_PROTOCOL = "koni.run-summary-cursor.v2" as const;
export const RUN_SUMMARY_ORDER = "created_at_desc_id_asc" as const;
export const MAX_RUN_SUMMARY_PAGE_LIMIT = 200;
/** Proven headroom for 200 maximum-width UTF-8 summaries below the 16 MiB RPC frame. */
export const MAX_RUN_SUMMARY_PAGE_BYTES = 8 * 1024 * 1024;
export const MAX_RUN_SUMMARY_CURSOR_BYTES = 4 * 1024;

export interface RunSummaryCounts {
  completed: number;
  active: number;
  blocked: number;
  total: number;
}

export interface RunSummaryAgentCounts {
  /** Sessions which still participate in the live attempt lifecycle. */
  active: number;
  /** Sessions which can presently issue another provider request. */
  spending: number;
  total: number;
}

export interface RunSummaryTokenCounts {
  /** Exact non-cached provider usage: input plus output. */
  new: number;
  cached: number;
  /** Provider usage including cached input/write accounting. */
  providerTotal: number;
}

/**
 * Compact, terminal-safe operator projection. It is never mutation authority: every effect still
 * reloads the exact run and performs its ordinary revision/CAS checks.
 */
export interface RunSummary {
  id: string;
  runRevision: number;
  objectiveTitle: string;
  /** Planner-authored short run name; absent until an agent plan compiles. */
  title?: string;
  objectivePreview: string;
  runTypeId: string;
  runType: string;
  phase: RunPhase;
  resumePhase?: ResumableRunPhase;
  runningIntent: boolean;
  stageId?: string;
  stage?: string;
  targetRef: string;
  targetBranch: string;
  createdAt: string;
  updatedAt: string;
  tickets: RunSummaryCounts;
  agents: RunSummaryAgentCounts;
  pendingQuestions: number;
  pendingProposals: number;
  planApproval: boolean;
  tokens: RunSummaryTokenCounts;
  blocker?: string;
  /** What actually clears the blocker; absent on pre-typed-remedy records. */
  blockerRemedy?: RunBlockerRemedy;
  failure?: string;
  paused: boolean;
  /** True when an operator pause is durably scheduled for the next pausable phase. */
  pausePending?: boolean;
  /** Durable summaries are never provisional; local intake rows remain a client-side overlay. */
  provisional: false;
  mergeReady: boolean;
}

export interface RunSummaryPage {
  protocol: typeof RUN_SUMMARY_PAGE_PROTOCOL;
  revision: number;
  order: typeof RUN_SUMMARY_ORDER;
  includeDeleted: boolean;
  totalRuns: number;
  /** Zero-based ordinal of the first row in the complete canonical result set. */
  startIndex: number;
  runs: readonly RunSummary[];
  previousCursor?: string;
  nextCursor?: string;
}

type RunSummaryCursorDirection = "before" | "after";

interface RunSummaryCursorMaterial {
  protocol: typeof RUN_SUMMARY_CURSOR_PROTOCOL;
  revision: number;
  order: typeof RUN_SUMMARY_ORDER;
  includeDeleted: boolean;
  direction: RunSummaryCursorDirection;
  lastCreatedAt: string;
  lastRunId: string;
  lastRunRevision: number;
}

interface RunSummaryCursor extends RunSummaryCursorMaterial {
  sha256: Sha256Digest;
}

export interface RunSummaryPageAnchor {
  id: string;
  createdAt: string;
  runRevision: number;
}

export class RunSummaryPageError extends Error {
  public readonly code:
    | "run_page_limit"
    | "run_page_cursor"
    | "run_page_stale"
    | "run_page_capacity"
    | "run_page_target";

  public constructor(code: RunSummaryPageError["code"], message: string) {
    super(message);
    this.name = "RunSummaryPageError";
    this.code = code;
  }
}

/**
 * Fixed-retention projector for a serialized anchored store scan. Callers pass one authenticated
 * full record at a time; this object retains at most `limit + 1` compact summaries.
 */
export class RunSummaryPageCollector {
  readonly #revision: number;
  readonly #includeDeleted: boolean;
  readonly #limit: number;
  readonly #cursor: RunSummaryCursor | undefined;
  readonly #around: RunSummaryPageAnchor | undefined;
  readonly #candidates: RunSummary[] = [];
  #totalRuns = 0;
  #eligibleOnCursorSide = 0;
  #recordsBeforeAround = 0;
  #cursorBoundarySeen = false;
  #aroundBoundarySeen = false;

  public constructor(options: {
    revision: number;
    includeDeleted?: boolean;
    limit: number;
    cursor?: string;
    around?: RunSummaryPageAnchor;
  }) {
    if (!Number.isSafeInteger(options.revision) || options.revision < 0) {
      throw new RunSummaryPageError("run_page_cursor", "run page revision is invalid");
    }
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > MAX_RUN_SUMMARY_PAGE_LIMIT
    ) {
      throw new RunSummaryPageError(
        "run_page_limit",
        `run page limit must be between 1 and ${MAX_RUN_SUMMARY_PAGE_LIMIT}`,
      );
    }
    this.#revision = options.revision;
    this.#includeDeleted = options.includeDeleted === true;
    this.#limit = options.limit;
    if (options.cursor !== undefined && options.around !== undefined) {
      throw new RunSummaryPageError(
        "run_page_cursor",
        "run page cursor and target anchor are mutually exclusive",
      );
    }
    this.#cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
    this.#around = options.around === undefined ? undefined : validateAnchor(options.around);
    if (this.#cursor !== undefined && this.#cursor.revision !== this.#revision) {
      throw new RunSummaryPageError(
        "run_page_stale",
        "run page cursor belongs to an older authority revision",
      );
    }
    if (
      this.#cursor !== undefined &&
      (this.#cursor.includeDeleted !== this.#includeDeleted ||
        this.#cursor.order !== RUN_SUMMARY_ORDER)
    ) {
      throw new RunSummaryPageError(
        "run_page_cursor",
        "run page cursor query does not match this request",
      );
    }
  }

  public accept(run: Readonly<RunRecord>): void {
    identity(run.id, "run id");
    canonicalTimestamp(run.createdAt, "run created time");
    canonicalTimestamp(run.updatedAt, "run updated time");
    if (!Number.isSafeInteger(run.revision) || run.revision < 0)
      throw new Error("run revision is invalid");
    if (!this.#includeDeleted && run.lifecycle.phase === "deleted") return;
    this.#totalRuns = safeAdd(this.#totalRuns, 1);

    if (
      this.#cursor !== undefined &&
      run.id === this.#cursor.lastRunId &&
      run.createdAt === this.#cursor.lastCreatedAt &&
      run.revision === this.#cursor.lastRunRevision
    ) {
      this.#cursorBoundarySeen = true;
    }
    if (this.#around !== undefined) {
      const comparison = compareRunKey(run, this.#around);
      if (comparison < 0) {
        this.#recordsBeforeAround = safeAdd(this.#recordsBeforeAround, 1);
        return;
      }
      if (
        run.id === this.#around.id &&
        run.createdAt === this.#around.createdAt &&
        run.revision === this.#around.runRevision
      )
        this.#aroundBoundarySeen = true;
    } else if (this.#cursor !== undefined) {
      const comparison = compareRunKey(run, this.#cursor);
      if (this.#cursor.direction === "after" ? comparison <= 0 : comparison >= 0) return;
    }
    this.#eligibleOnCursorSide = safeAdd(this.#eligibleOnCursorSide, 1);

    const capacity = this.#limit + 1;
    if (this.#cursor?.direction === "before") {
      const best = this.#candidates[0];
      if (
        best !== undefined &&
        this.#candidates.length >= capacity &&
        compareRunKey(run, best) <= 0
      )
        return;
    } else {
      const worst = this.#candidates.at(-1);
      if (
        worst !== undefined &&
        this.#candidates.length >= capacity &&
        compareRunKey(run, worst) >= 0
      )
        return;
    }
    const summary = projectRunSummary(run);
    const insertion = insertionIndex(this.#candidates, summary);
    this.#candidates.splice(insertion, 0, summary);
    if (this.#candidates.length > capacity) {
      if (this.#cursor?.direction === "before") this.#candidates.shift();
      else this.#candidates.pop();
    }
  }

  public finish(): RunSummaryPage {
    if (this.#cursor !== undefined && !this.#cursorBoundarySeen) {
      throw new RunSummaryPageError(
        "run_page_cursor",
        "run page cursor boundary is not present in this snapshot",
      );
    }
    if (this.#around !== undefined && !this.#aroundBoundarySeen) {
      throw new RunSummaryPageError(
        "run_page_target",
        "run page target anchor is not present in this snapshot",
      );
    }
    const selected =
      this.#cursor?.direction === "before"
        ? this.#candidates.slice(-this.#limit)
        : this.#candidates.slice(0, this.#limit);
    if (this.#cursor !== undefined && selected.length === 0) {
      throw new RunSummaryPageError("run_page_cursor", "run page cursor has no adjacent page");
    }
    const startIndex =
      this.#around !== undefined
        ? this.#recordsBeforeAround
        : this.#cursor?.direction === "before"
          ? this.#eligibleOnCursorSide - selected.length
          : this.#cursor?.direction === "after"
            ? this.#totalRuns - this.#eligibleOnCursorSide
            : 0;
    const hasPrevious = startIndex > 0;
    const hasNext = startIndex + selected.length < this.#totalRuns;
    const page: RunSummaryPage = {
      protocol: RUN_SUMMARY_PAGE_PROTOCOL,
      revision: this.#revision,
      order: RUN_SUMMARY_ORDER,
      includeDeleted: this.#includeDeleted,
      totalRuns: this.#totalRuns,
      startIndex,
      runs: selected,
      ...(hasPrevious
        ? {
            previousCursor: encodeCursor(
              this.#revision,
              this.#includeDeleted,
              "before",
              selected[0]!,
            ),
          }
        : {}),
      ...(hasNext
        ? {
            nextCursor: encodeCursor(
              this.#revision,
              this.#includeDeleted,
              "after",
              selected.at(-1)!,
            ),
          }
        : {}),
    };
    if (Buffer.byteLength(canonicalEncode(page), "utf8") > MAX_RUN_SUMMARY_PAGE_BYTES) {
      throw new RunSummaryPageError(
        "run_page_capacity",
        "run summary page exceeds its finite frame budget",
      );
    }
    return structuredClone(page);
  }

  /** Exact compact-retention observation used only by provider-free adversarial tests. */
  public retainedSummaryCount(): number {
    return this.#candidates.length;
  }
}

export function projectRunSummary(run: Readonly<RunRecord>): RunSummary {
  const tickets = Object.values(run.tickets);
  const attempts = Object.values(run.attempts);
  const halted = runExecutionHalted(run.lifecycle);
  const inFlightTicket = (ticket: TicketRecord): boolean =>
    ticket.status === "running" || ticket.status === "review";
  const input = sum(attempts, (attempt) => attempt.inputTokens);
  const output = sum(attempts, (attempt) => attempt.outputTokens);
  const cached = sum(attempts, (attempt) =>
    safeAdd(attempt.cacheReadTokens, attempt.cacheWriteTokens),
  );
  const fresh = safeAdd(input, output);
  const objectivePreview = safe(run.objective, 1_024, "Untitled Koni run");
  const firstLine =
    run.objective.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? run.objective;
  const blocker = optionalSafe(run.lifecycle.blocker, 1_024);
  const failure =
    run.lifecycle.phase === "failed"
      ? safe(
          run.lifecycle.terminalReason ?? run.lifecycle.blocker ?? "The run failed.",
          1_024,
          "The run failed.",
        )
      : undefined;
  const stageId = run.currentPipelineStageId;
  const targetRef = safe(run.git.target.ref, 1_024, "target");
  const plannerTitle = optionalSafe(run.plan?.title, 60);
  return {
    id: run.id,
    runRevision: run.revision,
    objectiveTitle: safe(firstLine, 160, "Untitled Koni run"),
    ...(plannerTitle === undefined ? {} : { title: plannerTitle }),
    objectivePreview,
    runTypeId: safe(run.runTypeId, 128, "run"),
    runType: humanize(run.runTypeId, 128, "Run"),
    phase: run.lifecycle.phase,
    ...(run.lifecycle.resumePhase === undefined ? {} : { resumePhase: run.lifecycle.resumePhase }),
    runningIntent: run.lifecycle.runningIntent,
    ...(stageId === undefined
      ? {}
      : {
          stageId: safe(stageId, 256, "work"),
          stage: humanize(stageId, 256, "Work"),
        }),
    targetRef,
    targetBranch: shortBranch(targetRef),
    createdAt: canonicalTimestamp(run.createdAt, "run created time"),
    updatedAt: canonicalTimestamp(run.updatedAt, "run updated time"),
    tickets: {
      completed: tickets.filter((ticket) => ticket.status === "completed").length,
      // A blocked run executes nothing: nominally in-flight tickets are blocked, not active.
      active: halted ? 0 : tickets.filter(inFlightTicket).length,
      blocked:
        tickets.filter(
          (ticket) => ticket.status === "blocked" && !ticketWaitingForCompilerGrant(ticket),
        ).length + (halted ? tickets.filter(inFlightTicket).length : 0),
      total: tickets.length,
    },
    agents: {
      active: halted ? 0 : attempts.filter(activeAttempt).length,
      // A halted run's sessions are aborted or draining: nothing can spend tokens, and the
      // parser fail-closes on spending exceeding active.
      spending: halted ? 0 : attempts.filter(spendingAttempt).length,
      total: attempts.length,
    },
    pendingQuestions: Object.values(run.questions).filter(
      (question) => question.answeredAt === undefined,
    ).length,
    pendingProposals: tickets.filter(actionableProposal).length,
    planApproval:
      run.lifecycle.phase === "awaiting_approval" && run.plan?.status === "awaiting_approval",
    tokens: { new: fresh, cached, providerTotal: safeAdd(fresh, cached) },
    ...(blocker === undefined ? {} : { blocker }),
    ...(failure === undefined ? {} : { failure }),
    paused: run.lifecycle.phase === "paused" || run.lifecycle.phase === "pausing",
    ...(run.pendingPause === undefined ? {} : { pausePending: true }),
    provisional: false,
    mergeReady:
      run.lifecycle.phase === "merge_ready" &&
      run.git.promotion?.status === "ready" &&
      run.git.promotion.candidateOid !== undefined,
  };
}

export function parseRunSummaryPage(value: unknown): RunSummaryPage {
  const root = record(value, "run summary page");
  exactKeys(
    root,
    [
      "protocol",
      "revision",
      "order",
      "includeDeleted",
      "totalRuns",
      "startIndex",
      "runs",
      "previousCursor",
      "nextCursor",
    ],
    "run summary page",
  );
  if (root.protocol !== RUN_SUMMARY_PAGE_PROTOCOL || root.order !== RUN_SUMMARY_ORDER) {
    throw new Error("unsupported run summary page protocol or order");
  }
  const revision = integer(root.revision, "run page revision");
  const includeDeleted = boolean(root.includeDeleted, "run page deleted filter");
  if (!Array.isArray(root.runs) || root.runs.length > MAX_RUN_SUMMARY_PAGE_LIMIT) {
    throw new Error("run summary page rows exceed their bound");
  }
  const runs = root.runs.map((candidate, index) =>
    parseRunSummary(candidate, index, includeDeleted),
  );
  for (let index = 1; index < runs.length; index += 1) {
    if (compareRunKey(runs[index - 1]!, runs[index]!) >= 0) {
      throw new Error("run summary page rows are not strictly ordered");
    }
  }
  if (new Set(runs.map((run) => run.id)).size !== runs.length)
    throw new Error("run summary page contains duplicate runs");
  const totalRuns = integer(root.totalRuns, "run page total");
  if (totalRuns < runs.length) throw new Error("run summary total is smaller than its page");
  const startIndex = integer(root.startIndex, "run page start index");
  if (startIndex > totalRuns || startIndex + runs.length > totalRuns) {
    throw new Error("run summary page ordinals exceed the result set");
  }
  if (runs.length === 0 && (startIndex !== 0 || totalRuns !== 0)) {
    throw new Error("non-empty run inventory cannot return an empty page");
  }
  const previousCursor = optionalText(
    root.previousCursor,
    "previous run page cursor",
    MAX_RUN_SUMMARY_CURSOR_BYTES,
  );
  const nextCursor = optionalText(root.nextCursor, "run page cursor", MAX_RUN_SUMMARY_CURSOR_BYTES);
  if (
    (previousCursor !== undefined) !== startIndex > 0 ||
    (nextCursor !== undefined) !== startIndex + runs.length < totalRuns
  ) {
    throw new Error("run summary page cursor and ordinal metadata disagree");
  }
  if (previousCursor !== undefined) {
    const decodedCursor = decodeCursor(previousCursor);
    const first = runs[0]!;
    if (
      decodedCursor.direction !== "before" ||
      decodedCursor.revision !== revision ||
      decodedCursor.includeDeleted !== includeDeleted ||
      decodedCursor.lastCreatedAt !== first.createdAt ||
      decodedCursor.lastRunId !== first.id ||
      decodedCursor.lastRunRevision !== first.runRevision
    ) {
      throw new Error("previous run summary cursor is not bound to its first row and query");
    }
  }
  if (nextCursor !== undefined) {
    const decodedCursor = decodeCursor(nextCursor);
    const last = runs.at(-1)!;
    if (
      decodedCursor.direction !== "after" ||
      decodedCursor.revision !== revision ||
      decodedCursor.includeDeleted !== includeDeleted ||
      decodedCursor.lastCreatedAt !== last.createdAt ||
      decodedCursor.lastRunId !== last.id ||
      decodedCursor.lastRunRevision !== last.runRevision
    ) {
      throw new Error("run summary page cursor is not bound to its final row and query");
    }
  }
  const parsed: RunSummaryPage = {
    protocol: RUN_SUMMARY_PAGE_PROTOCOL,
    revision,
    order: RUN_SUMMARY_ORDER,
    includeDeleted,
    totalRuns,
    startIndex,
    runs,
    ...(previousCursor === undefined ? {} : { previousCursor }),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
  if (Buffer.byteLength(canonicalEncode(parsed), "utf8") > MAX_RUN_SUMMARY_PAGE_BYTES) {
    throw new Error("run summary page exceeds its finite frame budget");
  }
  return parsed;
}

function parseRunSummary(value: unknown, index: number, includeDeleted: boolean): RunSummary {
  const row = record(value, `run summary ${index + 1}`);
  exactKeys(
    row,
    [
      "id",
      "runRevision",
      "objectiveTitle",
      "title",
      "objectivePreview",
      "runTypeId",
      "runType",
      "phase",
      "resumePhase",
      "runningIntent",
      "stageId",
      "stage",
      "targetRef",
      "targetBranch",
      "createdAt",
      "updatedAt",
      "tickets",
      "agents",
      "pendingQuestions",
      "pendingProposals",
      "planApproval",
      "tokens",
      "blocker",
      "failure",
      "paused",
      "pausePending",
      "provisional",
      "mergeReady",
    ],
    `run summary ${index + 1}`,
  );
  const phase = text(row.phase, "run phase", 32) as RunPhase;
  if (!RUN_PHASES.has(phase) || (phase === "deleted" && !includeDeleted))
    throw new Error("run summary phase is invalid");
  const resumePhase = optionalText(row.resumePhase, "run resume phase", 32) as
    ResumableRunPhase | undefined;
  if (resumePhase !== undefined && !RESUMABLE_PHASES.has(resumePhase))
    throw new Error("run resume phase is invalid");
  const stageId = optionalSafeText(row.stageId, "run stage id", 256);
  const stage = optionalSafeText(row.stage, "run stage", 256);
  if ((stageId === undefined) !== (stage === undefined))
    throw new Error("run summary stage projection is incomplete");
  const tickets = counts(row.tickets, "run tickets");
  const agents = agentCounts(row.agents);
  const tokens = tokenCounts(row.tokens);
  const pendingProposals = integer(row.pendingProposals, "pending proposals");
  if (pendingProposals > tickets.total) throw new Error("pending proposals exceed total tickets");
  const planApproval = boolean(row.planApproval, "plan approval");
  const paused = boolean(row.paused, "paused flag");
  const mergeReady = boolean(row.mergeReady, "merge-ready flag");
  if (
    (planApproval && phase !== "awaiting_approval") ||
    paused !== (phase === "paused" || phase === "pausing") ||
    (mergeReady && phase !== "merge_ready")
  ) {
    throw new Error("run summary lifecycle flags are inconsistent");
  }
  if (row.provisional !== false) throw new Error("durable run summary cannot be provisional");
  const plannerTitle = optionalSafeText(row.title, "run title", 60);
  const pausePending =
    row.pausePending === undefined ? undefined : boolean(row.pausePending, "pause-pending flag");
  if (pausePending === true && paused) throw new Error("run summary pause flags are inconsistent");
  return {
    id: identity(row.id, "run id"),
    runRevision: integer(row.runRevision, "run revision"),
    objectiveTitle: safeText(row.objectiveTitle, "objective title", 160),
    ...(plannerTitle === undefined ? {} : { title: plannerTitle }),
    objectivePreview: safeText(row.objectivePreview, "objective preview", 1_024),
    runTypeId: safeText(row.runTypeId, "run type id", 128),
    runType: safeText(row.runType, "run type", 128),
    phase,
    ...(resumePhase === undefined ? {} : { resumePhase }),
    runningIntent: boolean(row.runningIntent, "run intent"),
    ...(stageId === undefined ? {} : { stageId, stage: stage! }),
    targetRef: safeText(row.targetRef, "target ref", 1_024),
    targetBranch: safeText(row.targetBranch, "target branch", 1_024),
    createdAt: timestamp(row.createdAt, "run created time"),
    updatedAt: timestamp(row.updatedAt, "run updated time"),
    tickets,
    agents,
    pendingQuestions: integer(row.pendingQuestions, "pending questions"),
    pendingProposals,
    planApproval,
    tokens,
    ...(optionalSafeText(row.blocker, "run blocker", 1_024) === undefined
      ? {}
      : { blocker: optionalSafeText(row.blocker, "run blocker", 1_024)! }),
    ...(optionalSafeText(row.failure, "run failure", 1_024) === undefined
      ? {}
      : { failure: optionalSafeText(row.failure, "run failure", 1_024)! }),
    paused,
    ...(pausePending === undefined ? {} : { pausePending }),
    provisional: false,
    mergeReady,
  };
}

function encodeCursor(
  revision: number,
  includeDeleted: boolean,
  direction: RunSummaryCursorDirection,
  last: RunSummary,
): string {
  const material: RunSummaryCursorMaterial = {
    protocol: RUN_SUMMARY_CURSOR_PROTOCOL,
    revision,
    order: RUN_SUMMARY_ORDER,
    includeDeleted,
    direction,
    lastCreatedAt: last.createdAt,
    lastRunId: last.id,
    lastRunRevision: last.runRevision,
  };
  const cursor: RunSummaryCursor = { ...material, sha256: canonicalHash(material) };
  const encoded = Buffer.from(canonicalEncode(cursor), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > MAX_RUN_SUMMARY_CURSOR_BYTES) {
    throw new RunSummaryPageError(
      "run_page_capacity",
      "run page cursor exceeds its finite byte bound",
    );
  }
  return encoded;
}

function decodeCursor(value: string): RunSummaryCursor {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_RUN_SUMMARY_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new RunSummaryPageError(
      "run_page_cursor",
      "run page cursor is empty, oversized, or malformed",
    );
  }
  let decodedText: string;
  let decoded: unknown;
  try {
    decodedText = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decodedText, "utf8").toString("base64url") !== value)
      throw new Error("non-canonical base64url");
    decoded = JSON.parse(decodedText);
  } catch {
    throw new RunSummaryPageError(
      "run_page_cursor",
      "run page cursor is not canonical encoded JSON",
    );
  }
  const cursor = record(decoded, "run page cursor");
  exactKeys(
    cursor,
    [
      "protocol",
      "revision",
      "order",
      "includeDeleted",
      "direction",
      "lastCreatedAt",
      "lastRunId",
      "lastRunRevision",
      "sha256",
    ],
    "run page cursor",
  );
  if (
    cursor.protocol !== RUN_SUMMARY_CURSOR_PROTOCOL ||
    cursor.order !== RUN_SUMMARY_ORDER ||
    typeof cursor.includeDeleted !== "boolean" ||
    (cursor.direction !== "before" && cursor.direction !== "after") ||
    !isSha256Digest(cursor.sha256)
  ) {
    throw new RunSummaryPageError("run_page_cursor", "run page cursor fields are invalid");
  }
  const material: RunSummaryCursorMaterial = {
    protocol: RUN_SUMMARY_CURSOR_PROTOCOL,
    revision: cursorInteger(cursor.revision, "revision"),
    order: RUN_SUMMARY_ORDER,
    includeDeleted: cursor.includeDeleted,
    direction: cursor.direction,
    lastCreatedAt: cursorTimestamp(cursor.lastCreatedAt),
    lastRunId: cursorIdentity(cursor.lastRunId),
    lastRunRevision: cursorInteger(cursor.lastRunRevision, "run revision"),
  };
  const parsed: RunSummaryCursor = { ...material, sha256: cursor.sha256 };
  if (canonicalHash(material) !== parsed.sha256 || canonicalEncode(parsed) !== decodedText) {
    throw new RunSummaryPageError("run_page_cursor", "run page cursor integrity check failed");
  }
  return parsed;
}

function validateAnchor(value: RunSummaryPageAnchor): RunSummaryPageAnchor {
  try {
    return {
      id: identity(value.id, "run page target identity"),
      createdAt: canonicalTimestamp(value.createdAt, "run page target timestamp"),
      runRevision: integer(value.runRevision, "run page target revision"),
    };
  } catch {
    throw new RunSummaryPageError("run_page_target", "run page target anchor is invalid");
  }
}

function insertionIndex(values: readonly RunSummary[], value: RunSummary): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareRunKey(values[middle]!, value) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function compareRunKey(
  left: Pick<RunRecord, "createdAt" | "id"> | Pick<RunSummary, "createdAt" | "id">,
  right:
    | Pick<RunRecord, "createdAt" | "id">
    | Pick<RunSummary, "createdAt" | "id">
    | Pick<RunSummaryCursor, "lastCreatedAt" | "lastRunId">,
): number {
  const rightCreatedAt = "lastCreatedAt" in right ? right.lastCreatedAt : right.createdAt;
  const rightId = "lastRunId" in right ? right.lastRunId : right.id;
  return compareUtf8(rightCreatedAt, left.createdAt) || compareUtf8(left.id, rightId);
}

function activeAttempt(attempt: AgentAttemptRecord): boolean {
  return (
    spendingAttempt(attempt) ||
    attempt.status === "waiting_question" ||
    attempt.status === "terminal_accepted"
  );
}

function spendingAttempt(attempt: AgentAttemptRecord): boolean {
  return attempt.status === "queued" || attempt.status === "running";
}

function actionableProposal(ticket: TicketRecord): boolean {
  return (
    ticket.status === "proposed" &&
    ticket.executionControl?.proposalRequest !== undefined &&
    ticket.executionControl.proposalDisposition === undefined
  );
}

function humanize(value: string, maximum: number, fallback: string): string {
  const words = value
    .replace(/[._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (words.length === 0) return fallback;
  return safe(`${words[0]!.toLocaleUpperCase("en-US")}${words.slice(1)}`, maximum, fallback);
}

function shortBranch(value: string): string {
  return safe(value.replace(/^refs\/heads\//u, ""), 1_024, "target");
}

function safe(value: string, maximum: number, fallback: string): string {
  const normalized = terminalSafeText(value, { maxCodePoints: maximum });
  return normalized.length === 0 ? fallback : normalized;
}

function optionalSafe(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = terminalSafeText(value, { maxCodePoints: maximum });
  return normalized.length === 0 ? undefined : normalized;
}

function sum<Value>(values: readonly Value[], select: (value: Value) => number): number {
  let total = 0;
  for (const value of values) total = safeAdd(total, select(value));
  return total;
}

function safeAdd(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function parseSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${name} is invalid`);
  return Number(value);
}

function integer(value: unknown, name: string): number {
  return parseSafeInteger(value, name);
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} is invalid`);
  return value;
}

function text(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || [...value].length > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function safeText(value: unknown, name: string, maximum: number): string {
  const result = text(value, name, maximum);
  if (terminalSafeText(result, { maxCodePoints: maximum }) !== result)
    throw new Error(`${name} is not terminal-safe`);
  return result;
}

function optionalText(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return text(value, name, maximum);
}

function optionalSafeText(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return safeText(value, name, maximum);
}

function timestamp(value: unknown, name: string): string {
  const result = text(value, name, 64);
  return canonicalTimestamp(result, name);
}

function canonicalTimestamp(value: string, name: string): string {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value)
    throw new Error(`${name} is invalid`);
  return value;
}

function identity(value: unknown, name: string): string {
  const result = safeText(value, name, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function counts(value: unknown, name: string): RunSummaryCounts {
  const row = record(value, name);
  exactKeys(row, ["completed", "active", "blocked", "total"], name);
  const completed = integer(row.completed, `${name} completed`);
  const active = integer(row.active, `${name} active`);
  const blocked = integer(row.blocked, `${name} blocked`);
  const total = integer(row.total, `${name} total`);
  if (
    completed > total ||
    active > total ||
    blocked > total ||
    completed + active + blocked > total
  ) {
    throw new Error(`${name} status counts exceed total`);
  }
  return { completed, active, blocked, total };
}

function agentCounts(value: unknown): RunSummaryAgentCounts {
  const row = record(value, "run agents");
  exactKeys(row, ["active", "spending", "total"], "run agents");
  const active = integer(row.active, "active agents");
  const spending = integer(row.spending, "spending agents");
  const total = integer(row.total, "total agents");
  if (spending > active || active > total) throw new Error("run agent counts are inconsistent");
  return { active, spending, total };
}

function tokenCounts(value: unknown): RunSummaryTokenCounts {
  const row = record(value, "run tokens");
  exactKeys(row, ["new", "cached", "providerTotal"], "run tokens");
  const fresh = integer(row.new, "new tokens");
  const cached = integer(row.cached, "cached tokens");
  const providerTotal = integer(row.providerTotal, "provider total tokens");
  if (providerTotal !== safeAdd(fresh, cached))
    throw new Error("run token totals are inconsistent");
  return { new: fresh, cached, providerTotal };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${name} is invalid`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  const required = allowed.filter((key) => !OPTIONAL_KEYS.has(key) && !Object.hasOwn(value, key));
  if (extras.length > 0 || required.length > 0)
    throw new Error(`${name} has unknown or missing fields`);
}

function cursorInteger(value: unknown, name: string): number {
  try {
    return integer(value, `cursor ${name}`);
  } catch {
    throw new RunSummaryPageError("run_page_cursor", `run page cursor ${name} is invalid`);
  }
}

function cursorIdentity(value: unknown): string {
  try {
    return identity(value, "cursor run identity");
  } catch {
    throw new RunSummaryPageError("run_page_cursor", "run page cursor run identity is invalid");
  }
}

function cursorTimestamp(value: unknown): string {
  try {
    return timestamp(value, "cursor timestamp");
  } catch {
    throw new RunSummaryPageError("run_page_cursor", "run page cursor timestamp is invalid");
  }
}

const OPTIONAL_KEYS = new Set([
  "resumePhase",
  "stageId",
  "stage",
  "blocker",
  "failure",
  "previousCursor",
  "nextCursor",
  "title",
  "pausePending",
]);
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
const RESUMABLE_PHASES = new Set<ResumableRunPhase>([
  "draft",
  "planning",
  "awaiting_questions",
  "awaiting_approval",
  "approving",
  "executing",
  "verifying",
  "merge_ready",
  "merging",
  "blocked",
  "completed",
  "failed",
]);
