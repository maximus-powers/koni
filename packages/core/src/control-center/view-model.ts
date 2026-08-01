import type { GraphEdge, GraphNode } from "../graph/model.js";
import { projectRunSummary, type RunSummary } from "../authority/run-summary-page.js";
import { activeRuntimeMs } from "../state/run-lifecycle.js";
import {
  INTERRUPTED_DISPLAY_LABEL,
  interruptedByRunBlock,
  runExecutionHalted,
  ticketWaitingForCompilerGrant,
} from "../state/effective-status.js";
import { projectQuestionBatchCapabilities } from "../state/question-batch.js";
import type { StageCapabilityCatalog } from "../state/stage-capability.js";
import type {
  AgentAttemptRecord,
  RunActivityRecord,
  RunQuestionRecord,
  RunRecord,
  TicketRecord,
} from "../state/run-record.js";
import type { ControlRunAttemptLineage } from "./protocol.js";
import {
  cockpitStringArrayOption,
  cockpitStringOption,
  cockpitView,
  type CompiledCockpitViewCatalog,
} from "./cockpit-config.js";

export type DetailsTab = "overview" | "plan" | "chat";
export const TICKET_TABS = [
  "all",
  "active",
  "todo",
  "blocked",
  "proposed",
  "closed",
  "other",
] as const;
export type TicketTab = (typeof TICKET_TABS)[number];

export interface ControlCenterSelection {
  runId?: string;
  ticketId?: string;
  attemptId?: string;
  detailsTab: DetailsTab;
  objectiveExpanded: boolean;
}

export interface ControlCenterInput {
  projectRoot: string;
  authorityRevision: number;
  /** Compact, revision-bound rows. They are presentation only and never authorize an effect. */
  runSummaries?: readonly RunSummary[];
  /** The one exact selected record hydrated against its compact row revision. */
  selectedRun?: RunRecord;
  /** Compatibility seam for pure view-model callers; production controllers use summaries. */
  runs?: readonly RunRecord[];
  runPage?: {
    startIndex: number;
    totalRuns: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
  provisionalRuns?: readonly ProvisionalRunView[];
  selection: ControlCenterSelection;
  graph?: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };
  controls?: StageCapabilityCatalog;
  lineage?: ControlRunAttemptLineage;
  ticketTab?: TicketTab;
  cockpit?: CompiledCockpitViewCatalog;
  nowMs?: number;
}

export interface ProvisionalRunView {
  id: string;
  objective: string;
  runType: string;
  targetBranch: string;
  createdAt: string;
}

export interface RunRowView {
  id: string;
  /** Short identity + creation time: same-goal retries render identical titles otherwise. */
  shortId: string;
  createdAt: string;
  title: string;
  runType: string;
  stage: string;
  /** Raw lifecycle phase; drives the stage chip tone. */
  phase: string;
  targetBranch: string;
  state: string;
  ticketProgress: string;
  questionCount: number;
  proposalCount: number;
  activeAgentCount: number;
  newTokens: string;
  allTokens: string;
  mergeReady: boolean;
  awaitingApproval: boolean;
  paused: boolean;
  /** True while an operator pause is scheduled for the next pausable phase. */
  pausePending: boolean;
  provisional: boolean;
}

export interface TicketRowView {
  id: string;
  title: string;
  status: string;
  progress: string;
  active: boolean;
  rail: string;
  currentPersona?: string;
  recovery: boolean;
  proposalAwaitingDecision: boolean;
}

export interface TicketTabView {
  id: TicketTab;
  title: string;
  count: number;
}

export interface AgentRowView {
  id: string;
  label: string;
  work: string;
  persona: string;
  /** Step title when the attempt maps to a compiled step; used by the chat header. */
  stepTitle?: string;
  model: string;
  thinking: string;
  status: AgentAttemptRecord["status"];
  active: boolean;
  newTokens: string;
  allTokens: string;
  /** Nesting depth in the lineage tree (0 = root attempt). */
  depth: number;
  lineage?: {
    reason: string;
    branch: string;
    parent?: string;
    children: readonly string[];
    activeLeaf: boolean;
  };
}

export interface QuestionView extends RunQuestionRecord {
  index: number;
  total: number;
  batchVersion?: number;
  batchStatus?: "pending_answers" | "pending_resume" | "resolved";
  batchAnsweredCount?: number;
  batchQuestionCount?: number;
  answerSaved: boolean;
  resolvesBatchOnSubmit: boolean;
  batchPendingCount?: number;
  batchReadyToResolve: boolean;
  savedSelectedOptionId?: string;
  savedNotes?: string;
}

export interface ActivityView {
  id: string;
  timestamp: string;
  kind: RunActivityRecord["kind"];
  message: string;
  /** Explicit effect tone recorded at the emit site; kind-based fallback applies when absent. */
  tone?: RunActivityRecord["tone"];
}

export interface GraphNodeView {
  id: string;
  type: string;
  marker: string;
  label: string;
  /** Untruncated node title, rendered only for the cursor-focused node. */
  fullTitle: string;
  muted: boolean;
}

export interface ControlCenterViewModel {
  projectRoot: string;
  authorityRevision: number;
  cockpit?: CompiledCockpitViewCatalog;
  runs: RunRowView[];
  runPage: {
    startIndex: number;
    visibleRuns: number;
    totalRuns: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
  selectedRun?: {
    id: string;
    header: {
      runType: string;
      stage: string;
      ticketCount: number;
      newTokens: string;
      allTokens: string;
      awaitingApproval: boolean;
    };
    objective: { text: string; preview: string[]; full: string[]; expanded: boolean };
    /** Prominent blocked/failed banner: durable reason plus the projected recovery actions. */
    blockedBanner?: {
      reason: string;
      actions: { title: string; reason: string; available: boolean }[];
    };
    overviewSections: {
      title: "Run" | "Evidence";
      lines: string[];
      tone?: "neutral" | "success" | "error";
    }[];
    plan: {
      mode: "activity" | "review" | "approved";
      sections: { title: string; markdown: string }[];
    };
    approval?: {
      revision: number;
      sections: { id: string; title: string; items: { title: string; description: string }[] }[];
      graphSeed: string[];
    };
    stages: {
      id: string;
      title: string;
      state: "done" | "active" | "pending";
      kind?: string;
      category?: string;
      summary?: string;
      interaction?: { mode: "none" | "automatic" | "operator"; reason: string };
      actions: { id: string; title: string; available: boolean; reason: string }[];
    }[];
    ticketDetails?: {
      title: string;
      status: string;
      summary: string;
      blocker?: string;
      /** Graph-neighborhood node titles this ticket reads/writes/targets; never raw ids. */
      interactsWith: string[];
      /** Neighborhood ids not present in the current graph projection. */
      unresolvedNodeCount: number;
      /** Best-effort titles of the validation actions its steps must satisfy. */
      mustSatisfy: string[];
      /** Operator-grade execution policy label when the ticket is policy-bound. */
      policy?: string;
      steps: { title: string; persona: string; status: string; summary?: string }[];
    };
    tickets: TicketRowView[];
    ticketTabs: TicketTabView[];
    ticketTab: TicketTab;
    agents: AgentRowView[];
    questions?: QuestionView[];
    activity: ActivityView[];
    activeDuration?: string;
    graph: {
      scope: "Run integration" | "Ticket checkout";
      nodes: GraphNodeView[];
      edges: GraphEdge[];
    };
    /** Exact durable attempts that are currently capable of spending model tokens. */
    spendingTokens: boolean;
  };
}

export function buildControlCenterView(input: ControlCenterInput): ControlCenterViewModel {
  const nowMs = input.nowMs ?? Date.now();
  const compatibilityRuns = input.runs ?? [];
  const summaries = [...(input.runSummaries ?? compatibilityRuns.map(projectRunSummary))]
    .filter((run) => run.phase !== "deleted")
    .sort(summaryOrder);
  const provisionalRows = [...(input.provisionalRuns ?? [])]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(provisionalRunRow);
  const selectedProvisional = provisionalRows.some((run) => run.id === input.selection.runId);
  const selectedSummary = selectedProvisional
    ? undefined
    : (summaries.find((run) => run.id === input.selection.runId) ?? summaries[0]);
  const hydrated =
    input.selectedRun ?? compatibilityRuns.find((run) => run.id === selectedSummary?.id);
  const selected =
    hydrated !== undefined &&
    selectedSummary !== undefined &&
    hydrated.id === selectedSummary.id &&
    hydrated.revision === selectedSummary.runRevision
      ? hydrated
      : undefined;
  return {
    projectRoot: input.projectRoot,
    authorityRevision: input.authorityRevision,
    ...(input.cockpit === undefined ? {} : { cockpit: input.cockpit }),
    runs: [...provisionalRows, ...summaries.map(runRow)],
    runPage: {
      startIndex: input.runPage?.startIndex ?? 0,
      visibleRuns: summaries.length,
      totalRuns: input.runPage?.totalRuns ?? summaries.length,
      hasPrevious: input.runPage?.hasPrevious ?? false,
      hasNext: input.runPage?.hasNext ?? false,
    },
    ...(selected === undefined
      ? {}
      : {
          selectedRun: selectedRunView(
            selected,
            input.selection,
            input.graph,
            input.controls,
            input.lineage,
            nowMs,
            input.ticketTab ?? "all",
            input.cockpit,
          ),
        }),
  };
}

function runRow(run: RunSummary): RunRowView {
  return {
    id: run.id,
    // Objectives repeat verbatim across retries of the same goal; the short id plus creation
    // time are what let an operator tell same-titled runs apart.
    shortId: run.id.replace(/^run-/u, "").slice(0, 8),
    createdAt: run.createdAt,
    title: run.title ?? run.objectiveTitle,
    runType: run.runType,
    stage: run.stage ?? titleCase(run.phase),
    phase: run.phase,
    targetBranch: run.targetBranch,
    state: titleCase(run.phase),
    ticketProgress: `${run.tickets.completed}/${run.tickets.total}`,
    questionCount: run.pendingQuestions,
    proposalCount: run.pendingProposals,
    // The run-row cog is a truthful token-spend indicator. Sessions waiting for an
    // answer still participate in the lifecycle, but they are not presently working.
    activeAgentCount: run.agents.spending,
    newTokens: `${formatTokens(run.tokens.new)} new tks`,
    allTokens: `${formatTokens(run.tokens.providerTotal)} all`,
    mergeReady: run.mergeReady,
    awaitingApproval: run.planApproval,
    paused: run.paused,
    pausePending: run.pausePending === true,
    provisional: false,
  };
}

function summaryOrder(left: RunSummary, right: RunSummary): number {
  if (left.createdAt !== right.createdAt) return left.createdAt > right.createdAt ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function provisionalRunRow(run: ProvisionalRunView): RunRowView {
  return {
    id: run.id,
    shortId: run.id.replace(/^run-/u, "").slice(0, 8),
    createdAt: run.createdAt,
    title: objectiveTitle(run.objective),
    runType: run.runType,
    stage: "Starting",
    phase: "starting",
    targetBranch: shortBranch(run.targetBranch),
    state: "Starting",
    ticketProgress: "0/0",
    questionCount: 0,
    proposalCount: 0,
    activeAgentCount: 0,
    newTokens: "0 new tks",
    allTokens: "0 all",
    mergeReady: false,
    awaitingApproval: false,
    paused: false,
    pausePending: false,
    provisional: true,
  };
}

function selectedRunView(
  run: RunRecord,
  selection: ControlCenterSelection,
  graph: ControlCenterInput["graph"],
  controls: StageCapabilityCatalog | undefined,
  lineage: ControlRunAttemptLineage | undefined,
  nowMs: number,
  ticketTab: TicketTab,
  cockpit: CompiledCockpitViewCatalog | undefined,
): NonNullable<ControlCenterViewModel["selectedRun"]> {
  const tokens = runTokens(run);
  const tickets = Object.values(run.tickets).sort(ticketOrder);
  const selectedTicket = tickets.find((ticket) => ticket.id === selection.ticketId);
  const objectiveLines = wrapPlain(run.objective, 78);
  const pendingQuestions = Object.values(run.questions)
    .filter((question) => question.answeredAt === undefined)
    .sort((left, right) => {
      if (
        left.batchId !== undefined &&
        left.batchId === right.batchId &&
        left.batchPosition !== undefined &&
        right.batchPosition !== undefined
      ) {
        return left.batchPosition - right.batchPosition;
      }
      return left.askedAt.localeCompare(right.askedAt) || left.id.localeCompare(right.id);
    });
  const lineageRows = lineage?.attempts ?? [];
  const lineageByAttempt = new Map(lineageRows.map((attempt) => [attempt.attemptId, attempt]));
  // The durable run record is the complete attempt inventory. Lineage is
  // enrichment, never a filter: a partial lineage projection must not make an
  // inactive Lead or historical worker disappear from the Agents panel.
  // The Lead stays visible under a ticket filter — it orchestrates every ticket.
  const agents = lineageOrdered(
    Object.values(run.attempts).filter(
      (attempt) =>
        selectedTicket === undefined ||
        attempt.ticketId === selectedTicket.id ||
        attempt.kind === "lead" ||
        attempt.ticketId === "run-orchestration",
    ),
    lineageByAttempt,
  ).map(({ attempt, depth }) =>
    agentRow(run, attempt, selectedTicket === undefined, lineageByAttempt, depth),
  );
  const approval = approvalView(run);
  const configuredTicketView = cockpitView(cockpit, ["tabbed_table", "kanban"]);
  const configuredTabs = cockpitStringArrayOption(configuredTicketView, "tabs")?.filter(
    (tab): tab is TicketTab => (TICKET_TABS as readonly string[]).includes(tab),
  );
  const ticketTabs =
    configuredTabs !== undefined && configuredTabs.length > 0 ? configuredTabs : TICKET_TABS;
  const defaultTab = cockpitStringOption(configuredTicketView, "default_tab") as
    TicketTab | undefined;
  const effectiveTicketTab = ticketTabs.includes(ticketTab)
    ? ticketTab
    : defaultTab !== undefined && ticketTabs.includes(defaultTab)
      ? defaultTab
      : ticketTabs[0];
  // This signal must describe the complete run, even while the Agents panel is
  // narrowed to one ticket. Waiting-for-question and accepted-terminal states
  // are intentionally excluded: neither is evidence of an in-flight provider
  // request and neither may animate a token-spend cog.
  const spendingTokens = Object.values(run.attempts).some(
    (attempt) => attempt.status === "queued" || attempt.status === "running",
  );
  const blockedBanner = blockedBannerView(run, controls);
  return {
    id: run.id,
    header: {
      runType: titleCase(run.runTypeId),
      stage: stageTitle(run.currentPipelineStageId, run.lifecycle.phase),
      ticketCount: tickets.length,
      newTokens: `${formatTokens(tokens.newTokens)} new tks`,
      allTokens: `${formatTokens(tokens.allTokens)} incl. cache`,
      awaitingApproval: run.lifecycle.phase === "awaiting_approval",
    },
    objective: {
      text: run.objective,
      preview: objectiveLines.slice(0, 4),
      full: objectiveLines,
      expanded: selection.objectiveExpanded,
    },
    ...(blockedBanner === undefined ? {} : { blockedBanner }),
    overviewSections: overviewSections(run, selectedTicket),
    plan: planView(run),
    ...(approval === undefined ? {} : { approval }),
    stages: stageViews(run, controls),
    ...(selectedTicket === undefined
      ? {}
      : { ticketDetails: ticketDetails(selectedTicket, run.lifecycle, graph) }),
    tickets: tickets
      .filter((ticket) => ticketInTab(ticket, effectiveTicketTab, run.lifecycle))
      .map((ticket) => ticketRow(ticket, run.lifecycle)),
    ticketTabs: ticketTabs.map((id) => ({
      id,
      title: titleCase(id),
      count: tickets.filter((ticket) => ticketInTab(ticket, id, run.lifecycle)).length,
    })),
    ticketTab: effectiveTicketTab,
    agents,
    ...(pendingQuestions.length === 0
      ? {}
      : {
          questions: pendingQuestions.map((question, index) => ({
            ...structuredClone(question),
            index: index + 1,
            total: pendingQuestions.length,
            ...questionBatchView(run, question),
          })),
        }),
    activity: activityViews(run.activity),
    ...(run.lifecycle.approvedAtMs === undefined
      ? {}
      : {
          activeDuration: formatDuration(activeRuntimeMs(run.lifecycle, nowMs)),
        }),
    graph: {
      scope: selectedTicket === undefined ? "Run integration" : "Ticket checkout",
      ...graphView(graph),
    },
    spendingTokens,
  };
}

function questionBatchView(
  run: RunRecord,
  question: RunQuestionRecord,
): Pick<
  QuestionView,
  | "batchVersion"
  | "batchStatus"
  | "batchAnsweredCount"
  | "batchQuestionCount"
  | "answerSaved"
  | "resolvesBatchOnSubmit"
  | "batchPendingCount"
  | "batchReadyToResolve"
  | "savedSelectedOptionId"
  | "savedNotes"
> {
  const batch =
    question.batchId === undefined ? undefined : run.questionBatches?.[question.batchId];
  if (batch === undefined) {
    return {
      answerSaved: question.answeredAt !== undefined,
      resolvesBatchOnSubmit: true,
      batchReadyToResolve: true,
      ...(question.selectedOptionId === undefined
        ? {}
        : { savedSelectedOptionId: question.selectedOptionId }),
      ...(question.notes === undefined ? {} : { savedNotes: question.notes }),
    };
  }
  const capabilities = projectQuestionBatchCapabilities(batch);
  const revision = batch.revisions.find(
    (candidate) => candidate.revision === batch.currentRevision,
  );
  const answer = revision?.answers[question.id];
  const saved = answer !== undefined || question.answerRevision !== undefined;
  return {
    batchVersion: batch.version,
    batchStatus: batch.status,
    batchAnsweredCount: capabilities.answeredCount,
    batchQuestionCount: capabilities.totalCount,
    answerSaved: saved,
    batchPendingCount: capabilities.pendingQuestionIds.length,
    batchReadyToResolve: capabilities.actions.queueResume.allowed,
    resolvesBatchOnSubmit:
      batch.status === "pending_answers" &&
      capabilities.pendingQuestionIds.every((id) => id === question.id),
    ...(answer?.selectedOptionId === undefined
      ? {}
      : { savedSelectedOptionId: answer.selectedOptionId }),
    ...(answer?.notes === undefined ? {} : { savedNotes: answer.notes }),
  };
}

const BLOCKED_RECOVERY_INTENTS = new Set([
  "retry_blocked",
  "resume_run",
  "retry_supervised_stage",
  "retry_terminal_resolver",
  "delete_run",
]);

/** Blocked/failed runs surface their durable reason and recovery options at the top of Overview. */
function blockedBannerView(
  run: RunRecord,
  controls: StageCapabilityCatalog | undefined,
): NonNullable<ControlCenterViewModel["selectedRun"]>["blockedBanner"] {
  if (run.lifecycle.phase !== "blocked" && run.lifecycle.phase !== "failed") return undefined;
  const reason =
    safeOperatorText(
      run.lifecycle.blocker ?? run.lifecycle.terminalReason ?? "Run needs attention",
    ) ?? "Run needs attention";
  const currentStage = controls?.stages.find((stage) => stage.current);
  const candidates = [...(controls?.runActions ?? []), ...(currentStage?.actions ?? [])];
  const seen = new Set<string>();
  const actions = candidates
    .filter((action) => BLOCKED_RECOVERY_INTENTS.has(action.intent))
    .filter((action) => {
      if (seen.has(action.intent)) return false;
      seen.add(action.intent);
      return true;
    })
    .map((action) => ({
      title: action.title,
      reason:
        action.availability.state === "available" ? action.description : action.availability.reason,
      available: action.availability.state === "available",
    }));
  return { reason, actions };
}

function overviewSections(
  run: RunRecord,
  ticket: TicketRecord | undefined,
): NonNullable<ControlCenterViewModel["selectedRun"]>["overviewSections"] {
  const tokens = runTokens(run);
  const completed = Object.values(run.tickets).filter((item) => item.status === "completed").length;
  const evidence = evidenceOverview(run);
  return [
    {
      title: "Run",
      lines: [
        `Status: ${titleCase(run.lifecycle.phase)}`,
        `Target: ${shortBranch(run.git.target.ref)}`,
        `Tickets: ${completed}/${Object.keys(run.tickets).length}`,
        `Tokens: ${formatTokens(tokens.newTokens)} new · ${formatTokens(tokens.allTokens)} provider total`,
        `Cache: ${formatTokens(Math.max(0, tokens.allTokens - tokens.newTokens))} cached input/write`,
        ...(tokens.uncertainProviderExposure === 0
          ? []
          : [
              `Uncertain exposure: ≤${formatTokens(tokens.uncertainProviderExposure)} retired by operator`,
            ]),
        ...(ticket === undefined
          ? []
          : [`Selected ticket: ${ticket.title} · ${titleCase(ticket.status)}`]),
      ],
    },
    {
      title: "Evidence",
      lines: evidence.lines,
      tone: evidence.tone,
    },
  ];
}

function evidenceOverview(run: RunRecord): {
  tone: "neutral" | "success" | "error";
  lines: string[];
} {
  const failedChecks = unresolvedFailedCheckCount(run);
  const failedTickets = Object.values(run.tickets).filter(
    (ticket) => ticket.status === "failed",
  ).length;
  const blockedTickets = Object.values(run.tickets).filter(
    (ticket) => ticket.status === "blocked" && !ticketWaitingForCompilerGrant(ticket),
  ).length;
  // The run-level blocker itself renders in the Overview banner; Evidence keeps the
  // per-ticket/check consequences only.
  const failureLines: string[] = [];
  if (failedTickets > 0)
    failureLines.push(`${failedTickets} failed ${failedTickets === 1 ? "ticket" : "tickets"}`);
  if (blockedTickets > 0)
    failureLines.push(`${blockedTickets} blocked ${blockedTickets === 1 ? "ticket" : "tickets"}`);
  if (failedChecks > 0)
    failureLines.push(`${failedChecks} failed ${failedChecks === 1 ? "check" : "checks"}`);
  if (
    run.git.promotion?.status === "integration_required" ||
    run.git.promotion?.status === "preserved"
  ) {
    failureLines.push(
      safeOperatorText(run.git.promotion.blocker ?? "Target integration needs attention") ??
        "Target integration needs attention",
    );
  }
  if (failureLines.length > 0) {
    return { tone: "error", lines: ["Attention", ...failureLines] };
  }

  const acceptedChecks = (run.checks ?? []).filter((check) => check.accepted).length;
  const completedTickets = Object.values(run.tickets).filter(
    (ticket) => ticket.status === "completed",
  ).length;
  const acceptedOutputs = Object.values(run.attempts).filter(
    (attempt) =>
      attempt.kind !== "planning" &&
      attempt.kind !== "lead" &&
      attempt.ticketId !== "run-planning" &&
      (attempt.terminalOutputSha256 !== undefined ||
        (attempt.status === "completed" && attempt.terminalSummary !== undefined)),
  ).length;
  const verificationRecorded = new Set(["merge_ready", "merging", "completed"]).has(
    run.lifecycle.phase,
  );
  const positive: string[] = [];
  if (acceptedChecks > 0)
    positive.push(`${acceptedChecks} accepted ${acceptedChecks === 1 ? "check" : "checks"}`);
  if (completedTickets > 0)
    positive.push(`${completedTickets} completed ${completedTickets === 1 ? "ticket" : "tickets"}`);
  else if (acceptedOutputs > 0)
    positive.push(
      `${acceptedOutputs} accepted agent ${acceptedOutputs === 1 ? "output" : "outputs"}`,
    );
  if (verificationRecorded) positive.push("Verification completed");
  if (positive.length > 0) return { tone: "success", lines: ["Evidence recorded", ...positive] };
  return { tone: "neutral", lines: ["No recorded issues", "Evidence pending"] };
}

/**
 * Check receipts are an immutable audit trail, so expected-red baselines and
 * repaired retries remain in `run.checks` after their work succeeds. The
 * operator projection must only call a check unresolved when the latest
 * receipt for the current attempt of unfinished work is still rejected.
 */
function unresolvedFailedCheckCount(run: RunRecord): number {
  const currentAttemptIds = new Set<string>();
  for (const ticket of Object.values(run.tickets)) {
    if (ticket.status === "completed") continue;
    for (const step of ticket.steps) {
      if (step.status === "completed") continue;
      const attemptId = step.attemptIds.at(-1);
      if (attemptId !== undefined) currentAttemptIds.add(attemptId);
    }
  }

  const latestByAttemptAndCheck = new Map<string, NonNullable<RunRecord["checks"]>[number]>();
  for (const check of run.checks ?? []) {
    if (!currentAttemptIds.has(check.attemptId)) continue;
    const key = `${check.attemptId}\u0000${check.requestedCheckId}`;
    const previous = latestByAttemptAndCheck.get(key);
    if (previous === undefined || previous.recordedAt <= check.recordedAt) {
      latestByAttemptAndCheck.set(key, check);
    }
  }
  return [...latestByAttemptAndCheck.values()].filter((check) => !check.accepted).length;
}

function ticketDetails(
  ticket: TicketRecord,
  lifecycle: RunRecord["lifecycle"],
  graph: ControlCenterInput["graph"],
): NonNullable<NonNullable<ControlCenterViewModel["selectedRun"]>["ticketDetails"]> {
  const blocker = ticket.blocker === undefined ? undefined : safeOperatorText(ticket.blocker);
  const titleById = new Map((graph?.nodes ?? []).map((node) => [node.id, node.title]));
  const neighborhood = [
    ...new Set([
      ...ticket.targetNodeIds,
      ...(ticket.writeNodeIds ?? []),
      ...(ticket.readNodeIds ?? []),
    ]),
  ];
  // Only graph-resolved node titles are operator copy; raw node ids never render.
  const interactsWith = neighborhood
    .map((id) => titleById.get(id))
    .filter((title): title is string => title !== undefined)
    .map((title) => shortNodeTitle(title));
  const unresolvedNodeCount = neighborhood.length - interactsWith.length;
  // Best-effort: validation actions are compiled ids; no action-title catalog reaches this
  // projection, so the trailing id segment is titled for display.
  const mustSatisfy = [
    ...new Set(
      ticket.steps
        .map((step) => step.validationAction)
        .filter((action): action is string => typeof action === "string" && action.length > 0)
        .map((action) => titleCase(action.split(/[:./]/u).at(-1) ?? action)),
    ),
  ];
  const policy = ticket.executionPolicyBinding?.publicOperation;
  return {
    title: ticket.title,
    status: interruptedByRunBlock(ticket.status, lifecycle)
      ? INTERRUPTED_DISPLAY_LABEL
      : titleCase(ticket.status),
    summary: ticket.summary,
    ...(blocker === undefined ? {} : { blocker }),
    interactsWith,
    unresolvedNodeCount,
    mustSatisfy,
    ...(policy === undefined ? {} : { policy }),
    steps: ticket.steps.map((step) => ({
      title: step.title,
      persona: titleCase(step.personaId),
      status: interruptedByRunBlock(step.status, lifecycle)
        ? INTERRUPTED_DISPLAY_LABEL
        : titleCase(step.status),
      ...(step.summary === undefined || step.summary.trim().length === 0
        ? {}
        : { summary: step.summary }),
    })),
  };
}

function planView(run: RunRecord): NonNullable<ControlCenterViewModel["selectedRun"]>["plan"] {
  if (run.plan === undefined || run.plan.status === "planning" || run.plan.status === "revising") {
    return {
      mode: "activity",
      sections: [
        {
          title: "Planning activity",
          markdown: planningActivityMarkdown(run.activity),
        },
      ],
    };
  }
  // The Plan tab always shows the concise operator plan — the same human-readable items the
  // review modal surfaces. The full per-domain Markdown remains agent-facing material only.
  const preferred = ["architecture", "decisions", "risk", "verification"];
  const keys = [
    ...preferred,
    ...Object.keys(run.plan.concise)
      .filter((key) => !preferred.includes(key))
      .sort(),
  ];
  const sections = keys.map((key) => ({
    title: titleCase(key),
    markdown:
      (run.plan!.concise[key] ?? [])
        .map((item) => `### ${item.title}\n${item.description}`)
        .join("\n\n") || "No concise items were recorded for this section.",
  }));
  const review =
    run.plan.status === "awaiting_approval" || run.lifecycle.phase === "awaiting_approval";
  if (!review) {
    const graphSeed = graphSeedReview(run.plan.graphSeed);
    if (graphSeed.length > 0)
      sections.push({ title: "Graph Seed", markdown: graphSeed.join("\n") });
  }
  return {
    mode: review ? "review" : "approved",
    sections,
  };
}

function planningActivityMarkdown(activity: readonly RunActivityRecord[]): string {
  const generic = /^(?:planning\s+)?(?:agent\s+)?(?:event|activity|working|active)[.!]?$/iu;
  const lines: string[] = [];
  let previous = "";
  for (const event of activity) {
    if (event.kind !== "agent" && !event.message.toLocaleLowerCase("en-US").includes("plan"))
      continue;
    const message = event.message.replace(/\s+/gu, " ").trim();
    const normalized = message.toLocaleLowerCase("en-US");
    if (message.length === 0 || generic.test(message) || normalized === previous) continue;
    lines.push(`- ${message}`);
    previous = normalized;
  }
  return lines.slice(-40).join("\n") || "Planning is active. Semantic milestones will appear here.";
}

function approvalView(
  run: RunRecord,
): NonNullable<ControlCenterViewModel["selectedRun"]>["approval"] | undefined {
  if (run.plan === undefined || run.plan.status !== "awaiting_approval") return undefined;
  const ids = ["architecture", "decisions", "risk", "verification"];
  return {
    revision: run.plan.revision,
    sections: ids.map((id) => ({
      id,
      title: titleCase(id),
      items: (run.plan!.concise[id] ?? []).map((item) => ({ ...item })),
    })),
    graphSeed: graphSeedReview(run.plan.graphSeed),
  };
}

function graphSeedReview(value: unknown): string[] {
  if (!isPlainRecord(value)) return [];
  const rootSpec = isPlainRecord(value.rootSpec) ? value.rootSpec : {};
  const nodes = Array.isArray(value.nodes) ? value.nodes : [];
  const edges = Array.isArray(value.edges) ? value.edges : [];
  if (Object.keys(rootSpec).length === 0 && nodes.length === 0 && edges.length === 0) return [];
  const titles = new Map<string, string>([["$root", "Run goal"]]);
  const lines = [
    `${Object.keys(rootSpec).length} goal facts · ${nodes.length} semantic nodes · ${edges.length} relationships`,
  ];
  let shownRootFacts = 0;
  for (const [key, fact] of Object.entries(rootSpec)) {
    if (shownRootFacts >= 6) break;
    const safe = safeGraphFact(fact);
    if (safe === undefined) continue;
    lines.push(`- ${titleCase(key)}: ${safe}`);
    shownRootFacts += 1;
  }
  for (const unknownNode of nodes.slice(0, 12)) {
    if (!isPlainRecord(unknownNode)) continue;
    const key = typeof unknownNode.key === "string" ? unknownNode.key : undefined;
    const title =
      typeof unknownNode.title === "string" ? shortNodeTitle(unknownNode.title) : undefined;
    const type = typeof unknownNode.type === "string" ? titleCase(unknownNode.type) : "Node";
    if (key !== undefined && title !== undefined) titles.set(key, title);
    if (title !== undefined) {
      const spec = isPlainRecord(unknownNode.spec) ? unknownNode.spec : undefined;
      const purpose =
        spec === undefined
          ? undefined
          : ["purpose", "description", "summary", "intent"]
              .map((field) => safeGraphFact(spec[field]))
              .find((candidate) => candidate !== undefined);
      lines.push(`- ${type}: ${title}${purpose === undefined ? "" : ` — ${purpose}`}`);
    }
  }
  for (const unknownEdge of edges.slice(0, 16)) {
    if (!isPlainRecord(unknownEdge)) continue;
    const source =
      typeof unknownEdge.source === "string" ? titles.get(unknownEdge.source) : undefined;
    const target =
      typeof unknownEdge.target === "string" ? titles.get(unknownEdge.target) : undefined;
    const relation =
      typeof unknownEdge.relation === "string"
        ? titleCase(unknownEdge.relation).toLowerCase()
        : undefined;
    if (source !== undefined && target !== undefined && relation !== undefined)
      lines.push(`- ${source} ${relation} ${target}`);
  }
  const omittedRoot = Math.max(0, Object.keys(rootSpec).length - shownRootFacts);
  const omittedNodes = Math.max(0, nodes.length - 12);
  const omittedEdges = Math.max(0, edges.length - 16);
  const omitted = [
    ...(omittedRoot === 0 ? [] : [`${omittedRoot} goal ${omittedRoot === 1 ? "fact" : "facts"}`]),
    ...(omittedNodes === 0 ? [] : [`${omittedNodes} ${omittedNodes === 1 ? "node" : "nodes"}`]),
    ...(omittedEdges === 0
      ? []
      : [`${omittedEdges} ${omittedEdges === 1 ? "relationship" : "relationships"}`]),
  ];
  if (omitted.length > 0) lines.push(`- ${omitted.join(", ")} omitted from this concise review.`);
  return lines;
}

function stageViews(
  run: RunRecord,
  controls: StageCapabilityCatalog | undefined,
): NonNullable<ControlCenterViewModel["selectedRun"]>["stages"] {
  if (controls !== undefined) {
    return controls.stages.map((stage) => ({
      id: stage.id,
      title: stage.title,
      state:
        stage.status === "succeeded" || stage.status === "skipped"
          ? "done"
          : stage.current
            ? "active"
            : "pending",
      kind: stage.kind,
      category: stage.category,
      ...(stage.summary === undefined ? {} : { summary: stage.summary }),
      interaction: { mode: stage.interaction.mode, reason: stage.interaction.reason },
      actions: stage.actions.map((action) => ({
        id: action.id,
        title: action.title,
        available: action.availability.state === "available",
        reason: action.availability.reason,
      })),
    }));
  }
  const activeIndex =
    run.currentPipelineStageId === undefined
      ? -1
      : run.pipelineStageIds.indexOf(run.currentPipelineStageId);
  return run.pipelineStageIds.map((id, index) => ({
    id,
    title: titleCase(id),
    state:
      run.lifecycle.phase === "completed"
        ? "done"
        : index < activeIndex
          ? "done"
          : index === activeIndex &&
              !new Set(["completed", "deleted", "failed"]).has(run.lifecycle.phase)
            ? "active"
            : "pending",
    actions: [],
  }));
}

function ticketRow(ticket: TicketRecord, lifecycle: RunRecord["lifecycle"]): TicketRowView {
  const halted = runExecutionHalted(lifecycle);
  const waitingForCompilerGrant = ticketWaitingForCompilerGrant(ticket);
  const done = ticket.steps.filter(
    (step) => step.status === "completed" || step.status === "skipped",
  ).length;
  const current =
    ticket.steps.find((step) => step.status === "running") ??
    ticket.steps.find((step) => step.status !== "completed" && step.status !== "skipped");
  const rail = ticket.steps
    .map((step) => {
      if (step.status === "completed" || step.status === "skipped") return "●";
      if (step.status === "running") return halted ? "◌" : "◉";
      if (step.status === "failed") return "!";
      return "○";
    })
    .join("─");
  const running = ticket.steps.some((step) => step.status === "running");
  return {
    id: ticket.id,
    title: ticket.title,
    status: waitingForCompilerGrant
      ? "Waiting for compiler grant"
      : interruptedByRunBlock(ticket.status, lifecycle)
        ? INTERRUPTED_DISPLAY_LABEL
        : titleCase(ticket.status),
    progress: `${done}/${ticket.steps.length}`,
    active: running && !halted,
    rail,
    ...(current === undefined ? {} : { currentPersona: titleCase(current.personaId) }),
    recovery:
      ticket.status === "failed" ||
      (ticket.status === "blocked" && !waitingForCompilerGrant) ||
      ticket.steps.some((step) => step.status === "failed") ||
      (halted && running),
    proposalAwaitingDecision: ticket.status === "proposed",
  };
}

function ticketInTab(
  ticket: TicketRecord,
  tab: TicketTab,
  lifecycle: RunRecord["lifecycle"],
): boolean {
  const status = ticket.status.toLocaleLowerCase("en-US");
  const waitingForCompilerGrant = ticketWaitingForCompilerGrant(ticket);
  const halted = runExecutionHalted(lifecycle);
  const active =
    !halted &&
    (ticket.steps.some((step) => step.status === "running") ||
      new Set(["active", "running", "in_progress"]).has(status));
  const interrupted =
    halted &&
    (ticket.steps.some((step) => step.status === "running") ||
      new Set(["active", "running", "in_progress", "review"]).has(status));
  if (tab === "all") return true;
  if (tab === "active") return active;
  if (tab === "todo")
    return (
      waitingForCompilerGrant ||
      (!active && new Set(["pending", "ready", "todo", "open"]).has(status))
    );
  if (tab === "blocked") return (!waitingForCompilerGrant && status === "blocked") || interrupted;
  if (tab === "proposed") return status === "proposed";
  if (tab === "closed")
    return new Set(["completed", "closed", "cancelled", "superseded"]).has(status);
  return !TICKET_TABS.slice(0, -1).some(
    (candidate) => candidate !== "all" && ticketInTab(ticket, candidate, lifecycle),
  );
}

/**
 * Orders attempts as a lineage tree: roots keep the active-first ordering, children nest
 * under their parent in branch order. Attempts without lineage stay roots, so a partial
 * lineage projection degrades to the flat active-first list rather than hiding rows.
 */
function lineageOrdered(
  attempts: readonly AgentAttemptRecord[],
  lineageByAttempt: ReadonlyMap<string, ControlRunAttemptLineage["attempts"][number]>,
): { attempt: AgentAttemptRecord; depth: number }[] {
  const included = new Set(attempts.map((attempt) => attempt.id));
  const childrenOf = new Map<string, AgentAttemptRecord[]>();
  const roots: AgentAttemptRecord[] = [];
  for (const attempt of attempts) {
    const parent = lineageByAttempt.get(attempt.id)?.parentAttemptId;
    if (parent !== undefined && included.has(parent)) {
      const siblings = childrenOf.get(parent);
      if (siblings === undefined) childrenOf.set(parent, [attempt]);
      else siblings.push(attempt);
    } else {
      roots.push(attempt);
    }
  }
  const siblingOrder = (left: AgentAttemptRecord, right: AgentAttemptRecord): number =>
    (lineageByAttempt.get(left.id)?.branchEpoch ?? 0) -
      (lineageByAttempt.get(right.id)?.branchEpoch ?? 0) ||
    (left.startedAt ?? "").localeCompare(right.startedAt ?? "") ||
    left.id.localeCompare(right.id);
  roots.sort(agentOrder);
  const ordered: { attempt: AgentAttemptRecord; depth: number }[] = [];
  const visit = (attempt: AgentAttemptRecord, depth: number): void => {
    ordered.push({ attempt, depth });
    for (const child of [...(childrenOf.get(attempt.id) ?? [])].sort(siblingOrder)) {
      visit(child, depth + 1);
    }
  };
  for (const root of roots) visit(root, 0);
  return ordered;
}

function agentRow(
  run: RunRecord,
  attempt: AgentAttemptRecord,
  includeTicketPrefix: boolean,
  lineageByAttempt: ReadonlyMap<string, ControlRunAttemptLineage["attempts"][number]>,
  depth = 0,
): AgentRowView {
  const ticket = run.tickets[attempt.ticketId];
  const lineage = lineageByAttempt.get(attempt.id);
  const persona = lineage?.persona ?? titleCase(attempt.personaId);
  const ticketLabel = lineage?.ticket ?? ticket?.title;
  const prefix =
    includeTicketPrefix && ticketLabel !== undefined && attempt.ticketId !== "run-planning"
      ? `${ticketLabel} · `
      : "";
  const step = ticket?.steps.find((candidate) => candidate.id === attempt.stepId);
  const active = attempt.status === "queued" || attempt.status === "running";
  const newTokens = attempt.inputTokens + attempt.outputTokens;
  const allTokens = newTokens + attempt.cacheReadTokens + attempt.cacheWriteTokens;
  const parentLabel =
    lineage?.parentAttemptId === undefined
      ? undefined
      : lineageSemanticLabel(lineageByAttempt.get(lineage.parentAttemptId));
  const stepTitle = step?.title ?? lineage?.step;
  return {
    id: attempt.id,
    label: `${prefix}${persona}`,
    work: compactWorkTitle(
      step?.title ??
        attempt.terminalSummary ??
        attemptPhaseTitle(attempt, ticket !== undefined, active),
    ),
    persona,
    ...(stepTitle === undefined ? {} : { stepTitle }),
    model: attempt.modelId,
    thinking: attempt.thinkingLevel,
    status: attempt.status,
    active,
    newTokens: formatTokens(newTokens),
    allTokens: formatTokens(allTokens),
    depth,
    ...(lineage === undefined
      ? {}
      : {
          lineage: {
            reason: lineageReasonLabel(lineage.reason),
            branch:
              lineage.branchEpoch === 0 ? "Original attempt" : `Branch ${lineage.branchEpoch + 1}`,
            ...(parentLabel === undefined ? {} : { parent: parentLabel }),
            children: lineage.childAttemptIds
              .map((id) => lineageSemanticLabel(lineageByAttempt.get(id)))
              .filter((label): label is string => label !== undefined),
            activeLeaf: lineage.activeLeaf,
          },
        }),
  };
}

function lineageSemanticLabel(
  lineage: ControlRunAttemptLineage["attempts"][number] | undefined,
): string | undefined {
  if (lineage === undefined) return undefined;
  return `${lineage.persona} · ${lineage.step}`;
}

function lineageReasonLabel(
  reason: ControlRunAttemptLineage["attempts"][number]["reason"],
): string {
  if (reason === "initial") return "Initial attempt";
  if (reason === "retry") return "Retry";
  if (reason === "rework") return "Rework";
  if (reason === "review") return "Review branch";
  if (reason === "recovery") return "Recovery";
  return "Integration branch";
}

function attemptPhaseTitle(
  attempt: AgentAttemptRecord,
  hasTicket: boolean,
  active: boolean,
): string {
  if (attempt.status === "waiting_question") return "Waiting for answer";
  if (attempt.status === "terminal_accepted") return "Finishing attempt";
  const kind =
    attempt.kind ??
    (attempt.ticketId === "run-planning" ? "planning" : hasTicket ? "ticket" : undefined);
  if (kind === "planning") return active ? "Planning run" : "Planned run";
  if (kind === "lead") return active ? "Reviewing readiness" : "Readiness reviewed";
  if (kind === "verification") return active ? "Reviewing evidence" : "Reviewed evidence";
  if (kind === "integration") return active ? "Resolving integration" : "Integration finished";
  if (kind === "ticket") return active ? "Working ticket" : "Ticket work finished";
  return active ? "Working" : "Attempt finished";
}

function activityViews(events: readonly RunActivityRecord[]): ActivityView[] {
  const collapsed = new Map<string, { event: RunActivityRecord; message: string; count: number }>();
  for (const event of [...events].sort(
    (left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id),
  )) {
    const semantic = semanticActivityMessage(event);
    if (semantic === undefined) continue;
    const key = `${event.kind}\u0000${semantic.toLocaleLowerCase("en-US")}`;
    const existing = collapsed.get(key);
    if (existing === undefined) collapsed.set(key, { event, message: semantic, count: 1 });
    else existing.count += 1;
  }
  return [...collapsed.values()].slice(0, 500).map(({ event, message, count }) => ({
    id: event.id,
    timestamp: formatTimestamp(event.at),
    kind: event.kind,
    message: count === 1 ? message : `${message} ×${count}`,
    ...(event.tone === undefined ? {} : { tone: event.tone }),
  }));
}

function semanticActivityMessage(event: RunActivityRecord): string | undefined {
  let message = event.message
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\b(?:sha256:)?[a-f0-9]{40,64}\b/giu, "[digest]")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gu, "[local checkout]")
    .replace(/(^|[\s(])\/(?:[^\s/]+\/)*[^\s,;:)]*/gu, "$1[local checkout]")
    .replace(
      /\b(run|ticket|attempt|session|question|claim|experiment|gate|node|step)[-_:][\p{L}\p{N}._:-]+\b/giu,
      (_match, kind: string) => `the ${kind.toLowerCase()}`,
    )
    .replace(/\s+/gu, " ")
    .trim();
  if (message.length === 0) return undefined;
  if (/^(?:(?:planning|compiler|agent)\s+)*(?:event|activity|working|active)[.!]?$/iu.test(message))
    return undefined;
  if (event.kind === "compiler" && /^[a-z0-9_.:-]+$/u.test(message) && /[_.:]/u.test(message)) {
    message = "Compiler recorded an internal state transition";
  }
  if (event.kind === "graph_added" && !/\b(?:add|added|create|created)\b/iu.test(message))
    message = `Added: ${message}`;
  if (
    event.kind === "graph_modified" &&
    !/\b(?:modify|modified|update|updated|change|changed)\b/iu.test(message)
  )
    message = `Modified: ${message}`;
  if (event.kind === "graph_deleted" && !/\b(?:delete|deleted|remove|removed)\b/iu.test(message))
    message = `Deleted: ${message}`;
  const words = message.split(/\s+/u);
  return words.length > 30 ? `${words.slice(0, 30).join(" ")}…` : message;
}

function graphView(graph: ControlCenterInput["graph"]): {
  nodes: GraphNodeView[];
  edges: GraphEdge[];
} {
  if (graph === undefined) return { nodes: [], edges: [] };
  const nodes = [...graph.nodes]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((node) => ({
      id: node.id,
      type: node.type,
      marker: graphMarker(node.type),
      label: shortNodeTitle(node.title),
      fullTitle: node.title.replace(/\s+/gu, " ").trim() || "Untitled",
      muted: !new Set(["active", "planned", "open", "unresolved", "pending"]).has(node.status),
    }));
  return {
    nodes,
    edges: [...graph.edges].sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.relation.localeCompare(right.relation) ||
        left.target.localeCompare(right.target),
    ),
  };
}

function runTokens(run: RunRecord): {
  newTokens: number;
  allTokens: number;
  uncertainProviderExposure: number;
} {
  let newTokens = 0;
  let allTokens = 0;
  let uncertainProviderExposure = 0;
  for (const attempt of Object.values(run.attempts)) {
    const attemptNew = attempt.inputTokens + attempt.outputTokens;
    newTokens += attemptNew;
    allTokens += attemptNew + attempt.cacheReadTokens + attempt.cacheWriteTokens;
    for (const request of attempt.authorityProviderRequests ?? []) {
      if (request.retirement !== undefined) {
        uncertainProviderExposure += request.prospectiveInputTokens + request.reservedOutputTokens;
      }
    }
  }
  return { newTokens, allTokens, uncertainProviderExposure };
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value >= 1_000_000_000) return `${trimDecimal(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimDecimal(value / 1_000)}K`;
  return Math.round(value).toString();
}

function trimDecimal(value: number): string {
  return value >= 100
    ? value.toFixed(0)
    : value >= 10
      ? value.toFixed(1).replace(/\.0$/u, "")
      : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

function objectiveTitle(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= 52 ? normalized : `${normalized.slice(0, 49).trimEnd()}…`;
}

function compactWorkTitle(value: string): string {
  const words = value
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const normalized = words.join(" ").toLocaleLowerCase("en-US");
  if (normalized === "execute compiled work") return "Coordinating tickets";
  if (normalized === "combined plan" || normalized === "plan run") return "Planning run";
  return words.slice(0, 3).join(" ") || "Working";
}

function shortNodeTitle(value: string): string {
  const words = value
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const selected = words.slice(0, 4).join(" ");
  return selected || "Untitled";
}

function safeGraphFact(value: unknown): string | undefined {
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
    return String(value);
  if (typeof value !== "string") return undefined;
  const safe = safeOperatorText(value);
  if (
    safe === undefined ||
    safe.includes("[local path]") ||
    safe.includes("[redacted digest]") ||
    safe.includes("[structured detail]")
  )
    return undefined;
  const words = safe.split(/\s+/u);
  const concise = words.slice(0, 12).join(" ");
  return words.length > 12 ? `${concise}…` : concise;
}

/** Keep normal presentation semantic even when a compiler failure contains control metadata. */
function safeOperatorText(value: string): string | undefined {
  let safe = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\{[^{}]{0,2048}\}|\[[^\[\]]{0,2048}\]/gu, "[structured detail]")
    .replace(/\b(?:sha256:)?[a-f0-9]{40,64}\b/giu, "[redacted digest]")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gu, "[local path]")
    .replace(/(^|[\s(])\/(?:[^\s/]+\/)*[^\s,;:)]*/gu, "$1[local path]")
    .replace(/(?:\.\.?\/)[^\s,;:)]+/gu, "[local path]")
    .replace(
      /\b(run|ticket|attempt|session|question|claim|experiment|gate|node|step)[-_:][\p{L}\p{N}._:-]+\b/giu,
      (_match, kind: string) => `the ${kind.toLowerCase()}`,
    )
    .replace(/\s+/gu, " ")
    .trim();
  safe = safe.replace(/(?:\[structured detail\]\s*){2,}/gu, "[structured detail] ").trim();
  if (safe.length === 0) return undefined;
  const normalized = safe.toLocaleLowerCase("en-US").replace(/[.!]+$/u, "");
  if (
    new Set([
      "blocked",
      "failed",
      "error",
      "unknown",
      "needs attention",
      "waiting",
      "not available",
    ]).has(normalized)
  )
    return undefined;
  return safe;
}

function graphMarker(type: string): string {
  return type.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "N";
}

function ticketOrder(left: TicketRecord, right: TicketRecord): number {
  return (
    left.priority - right.priority ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id)
  );
}

function agentOrder(left: AgentAttemptRecord, right: AgentAttemptRecord): number {
  const leftActive = new Set(["queued", "running", "waiting_question", "terminal_accepted"]).has(
    left.status,
  );
  const rightActive = new Set(["queued", "running", "waiting_question", "terminal_accepted"]).has(
    right.status,
  );
  return (
    Number(rightActive) - Number(leftActive) ||
    (right.startedAt ?? "").localeCompare(left.startedAt ?? "") ||
    left.personaId.localeCompare(right.personaId) ||
    left.id.localeCompare(right.id)
  );
}

function stageTitle(stage: string | undefined, phase: string): string {
  if (phase === "approving") return "Preparing Workspace";
  return titleCase(stage ?? phase);
}

function titleCase(value: string): string {
  return value.replace(/[-_]+/gu, " ").replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function shortBranch(reference: string): string {
  return reference.replace(/^refs\/heads\//u, "");
}

function wrapPlain(value: string, width: number): string[] {
  const words = value.replace(/\s+/gu, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length > 0 && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "--:--:--";
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}h ${minutes}m`
    : minutes > 0
      ? `${minutes}m ${seconds}s`
      : `${seconds}s`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
