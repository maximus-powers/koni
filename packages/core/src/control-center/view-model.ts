import type { GraphEdge, GraphNode } from "../graph/model.js";
import { activeRuntimeMs } from "../state/run-lifecycle.js";
import type {
  AgentAttemptRecord,
  RunActivityRecord,
  RunQuestionRecord,
  RunRecord,
  TicketRecord,
} from "../state/run-record.js";

export type DetailsTab = "overview" | "plan" | "stages" | "chat";

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
  runs: readonly RunRecord[];
  provisionalRuns?: readonly ProvisionalRunView[];
  selection: ControlCenterSelection;
  graph?: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };
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
  title: string;
  runType: string;
  stage: string;
  targetBranch: string;
  state: string;
  ticketProgress: string;
  newTokens: string;
  allTokens: string;
  mergeReady: boolean;
  awaitingApproval: boolean;
  paused: boolean;
  provisional: boolean;
}

export interface TicketRowView {
  id: string;
  title: string;
  status: string;
  progress: string;
  active: boolean;
}

export interface AgentRowView {
  id: string;
  label: string;
  work: string;
  model: string;
  thinking: string;
  status: AgentAttemptRecord["status"];
  active: boolean;
  newTokens: string;
  allTokens: string;
}

export interface QuestionView extends RunQuestionRecord {
  index: number;
  total: number;
}

export interface ActivityView {
  id: string;
  timestamp: string;
  kind: RunActivityRecord["kind"];
  message: string;
}

export interface GraphNodeView {
  id: string;
  type: string;
  marker: string;
  label: string;
  muted: boolean;
}

export interface ControlCenterViewModel {
  projectRoot: string;
  authorityRevision: number;
  runs: RunRowView[];
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
    overviewSections: {
      title: "Goal" | "Run" | "Evidence";
      lines: string[];
      tone?: "neutral" | "success" | "error";
    }[];
    plan: { mode: "activity" | "review" | "approved"; sections: { title: string; markdown: string }[] };
    approval?: {
      revision: number;
      sections: { id: string; title: string; items: { title: string; description: string }[] }[];
      graphSeed: string[];
    };
    stages: { id: string; title: string; state: "done" | "active" | "pending" }[];
    ticketDetails?: {
      title: string;
      status: string;
      summary: string;
      blocker?: string;
      steps: { title: string; persona: string; status: string; summary?: string }[];
    };
    tickets: TicketRowView[];
    agents: AgentRowView[];
    questions?: QuestionView[];
    activity: ActivityView[];
    activeDuration?: string;
    graph: { scope: "Run integration" | "Ticket checkout"; nodes: GraphNodeView[]; edges: GraphEdge[] };
  };
}

export function buildControlCenterView(input: ControlCenterInput): ControlCenterViewModel {
  const nowMs = input.nowMs ?? Date.now();
  const runs = [...input.runs]
    .filter((run) => run.lifecycle.phase !== "deleted")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  const provisionalRows = [...(input.provisionalRuns ?? [])]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(provisionalRunRow);
  const selectedProvisional = provisionalRows.some((run) => run.id === input.selection.runId);
  const selected = selectedProvisional
    ? undefined
    : runs.find((run) => run.id === input.selection.runId) ?? runs[0];
  return {
    projectRoot: input.projectRoot,
    authorityRevision: input.authorityRevision,
    runs: [...provisionalRows, ...runs.map(runRow)],
    ...(selected === undefined ? {} : {
      selectedRun: selectedRunView(selected, input.selection, input.graph, nowMs),
    }),
  };
}

function runRow(run: RunRecord): RunRowView {
  const tokens = runTokens(run);
  const completed = Object.values(run.tickets).filter((ticket) => ticket.status === "completed").length;
  return {
    id: run.id,
    title: objectiveTitle(run.objective),
    runType: titleCase(run.runTypeId),
    stage: stageTitle(run.currentPipelineStageId, run.lifecycle.phase),
    targetBranch: shortBranch(run.git.target.ref),
    state: titleCase(run.lifecycle.phase),
    ticketProgress: `${completed}/${Object.keys(run.tickets).length}`,
    newTokens: `${formatTokens(tokens.newTokens)} new tks`,
    allTokens: `${formatTokens(tokens.allTokens)} all`,
    mergeReady: run.lifecycle.phase === "merge_ready" && run.git.promotion?.status === "ready" && run.git.promotion.candidateOid !== undefined,
    awaitingApproval: run.lifecycle.phase === "awaiting_approval",
    paused: run.lifecycle.phase === "paused" || run.lifecycle.phase === "pausing",
    provisional: false,
  };
}

function provisionalRunRow(run: ProvisionalRunView): RunRowView {
  return {
    id: run.id,
    title: objectiveTitle(run.objective),
    runType: run.runType,
    stage: "Starting",
    targetBranch: shortBranch(run.targetBranch),
    state: "Starting",
    ticketProgress: "0/0",
    newTokens: "0 new tks",
    allTokens: "0 all",
    mergeReady: false,
    awaitingApproval: false,
    paused: false,
    provisional: true,
  };
}

function selectedRunView(
  run: RunRecord,
  selection: ControlCenterSelection,
  graph: ControlCenterInput["graph"],
  nowMs: number,
): NonNullable<ControlCenterViewModel["selectedRun"]> {
  const tokens = runTokens(run);
  const tickets = Object.values(run.tickets).sort(ticketOrder);
  const selectedTicket = tickets.find((ticket) => ticket.id === selection.ticketId);
  const objectiveLines = wrapPlain(run.objective, 78);
  const pendingQuestions = Object.values(run.questions)
    .filter((question) => question.answeredAt === undefined)
    .sort((left, right) => left.askedAt.localeCompare(right.askedAt) || left.id.localeCompare(right.id));
  const agents = Object.values(run.attempts)
    .filter((attempt) => selectedTicket === undefined || attempt.ticketId === selectedTicket.id)
    .sort(agentOrder)
    .map((attempt) => agentRow(run, attempt, selectedTicket === undefined));
  const approval = approvalView(run);
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
    overviewSections: overviewSections(run, selectedTicket),
    plan: planView(run),
    ...(approval === undefined ? {} : { approval }),
    stages: stageViews(run),
    ...(selectedTicket === undefined ? {} : { ticketDetails: ticketDetails(selectedTicket) }),
    tickets: tickets.map(ticketRow),
    agents,
    ...(pendingQuestions.length === 0 ? {} : {
      questions: pendingQuestions.map((question, index) => ({
        ...structuredClone(question),
        index: index + 1,
        total: pendingQuestions.length,
      })),
    }),
    activity: [...run.activity]
      .sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id))
      .map(activityView),
    ...(run.lifecycle.approvedAtMs === undefined ? {} : {
      activeDuration: formatDuration(activeRuntimeMs(run.lifecycle, nowMs)),
    }),
    graph: {
      scope: selectedTicket === undefined ? "Run integration" : "Ticket checkout",
      ...graphView(graph),
    },
  };
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
      title: "Goal",
      lines: objectiveContext(run),
    },
    {
      title: "Run",
      lines: [
        `Status: ${titleCase(run.lifecycle.phase)}`,
        `Target: ${shortBranch(run.git.target.ref)}`,
        `Tickets: ${completed}/${Object.keys(run.tickets).length}`,
        `Tokens: ${formatTokens(tokens.newTokens)} new · ${formatTokens(tokens.allTokens)} provider total`,
        `Cache: ${formatTokens(Math.max(0, tokens.allTokens - tokens.newTokens))} cached input/write`,
        ...(ticket === undefined ? [] : [`Selected ticket: ${ticket.title} · ${titleCase(ticket.status)}`]),
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
  const failedChecks = (run.checks ?? []).filter((check) => !check.accepted).length;
  const failedTickets = Object.values(run.tickets).filter((ticket) => ticket.status === "failed").length;
  const blockedTickets = Object.values(run.tickets).filter((ticket) => ticket.status === "blocked").length;
  const failureLines: string[] = [];
  if (run.lifecycle.phase === "failed" || run.lifecycle.phase === "blocked") {
    failureLines.push(safeOperatorText(run.lifecycle.blocker ?? run.lifecycle.terminalReason ?? "Run needs attention") ?? "Run needs attention");
  }
  if (failedTickets > 0) failureLines.push(`${failedTickets} failed ${failedTickets === 1 ? "ticket" : "tickets"}`);
  if (blockedTickets > 0) failureLines.push(`${blockedTickets} blocked ${blockedTickets === 1 ? "ticket" : "tickets"}`);
  if (failedChecks > 0) failureLines.push(`${failedChecks} failed ${failedChecks === 1 ? "check" : "checks"}`);
  if (run.git.promotion?.status === "integration_required" || run.git.promotion?.status === "preserved") {
    failureLines.push(safeOperatorText(run.git.promotion.blocker ?? "Target integration needs attention") ?? "Target integration needs attention");
  }
  if (failureLines.length > 0) return { tone: "error", lines: ["Attention", ...failureLines] };

  const acceptedChecks = (run.checks ?? []).filter((check) => check.accepted).length;
  const completedTickets = Object.values(run.tickets).filter((ticket) => ticket.status === "completed").length;
  const acceptedOutputs = Object.values(run.attempts).filter((attempt) =>
    attempt.kind !== "planning" && attempt.ticketId !== "run-planning" &&
    (attempt.terminalOutputSha256 !== undefined || (attempt.status === "completed" && attempt.terminalSummary !== undefined))
  ).length;
  const verificationRecorded = new Set(["merge_ready", "merging", "completed"]).has(run.lifecycle.phase);
  const positive: string[] = [];
  if (acceptedChecks > 0) positive.push(`${acceptedChecks} accepted ${acceptedChecks === 1 ? "check" : "checks"}`);
  if (completedTickets > 0) positive.push(`${completedTickets} completed ${completedTickets === 1 ? "ticket" : "tickets"}`);
  else if (acceptedOutputs > 0) positive.push(`${acceptedOutputs} accepted agent ${acceptedOutputs === 1 ? "output" : "outputs"}`);
  if (verificationRecorded) positive.push("Verification completed");
  if (positive.length > 0) return { tone: "success", lines: ["Evidence recorded", ...positive] };
  return { tone: "neutral", lines: ["No recorded issues", "Evidence pending"] };
}

function objectiveContext(run: RunRecord): string[] {
  const entries = Object.entries(run.intake)
    .filter(([key, value]) => key !== "goal" && value.trim().length > 0)
    .map(([key, value]) => `${titleCase(key)}: ${value}`);
  return entries.length === 0 ? ["Scope follows the approved objective."] : entries;
}

function ticketDetails(ticket: TicketRecord): NonNullable<NonNullable<ControlCenterViewModel["selectedRun"]>["ticketDetails"]> {
  const blocker = ticket.blocker === undefined ? undefined : safeOperatorText(ticket.blocker);
  return {
    title: ticket.title,
    status: titleCase(ticket.status),
    summary: ticket.summary,
    ...(blocker === undefined ? {} : { blocker }),
    steps: ticket.steps.map((step) => ({
      title: step.title,
      persona: titleCase(step.personaId),
      status: titleCase(step.status),
      ...(step.summary === undefined || step.summary.trim().length === 0 ? {} : { summary: step.summary }),
    })),
  };
}

function planView(run: RunRecord): NonNullable<ControlCenterViewModel["selectedRun"]>["plan"] {
  if (run.plan === undefined || run.plan.status === "planning" || run.plan.status === "revising") {
    return {
      mode: "activity",
      sections: [{
        title: "Planning activity",
        markdown: planningActivityMarkdown(run.activity),
      }],
    };
  }
  if (run.plan.status === "awaiting_approval" || run.lifecycle.phase === "awaiting_approval") {
    const preferred = ["architecture", "decisions", "risk", "verification"];
    return {
      mode: "review",
      sections: preferred.map((key) => ({
        title: titleCase(key),
        markdown: (run.plan!.concise[key] ?? []).map((item) => `### ${item.title}\n${item.description}`).join("\n\n")
          || "Awaiting operator review; no concise items were recorded for this section.",
      })),
    };
  }
  const preferred = ["architecture", "decisions", "risk", "verification"];
  const keys = [
    ...preferred.filter((key) => run.plan!.full[key] !== undefined),
    ...Object.keys(run.plan.full).filter((key) => !preferred.includes(key)).sort(),
  ];
  const sections = keys.map((key) => ({ title: titleCase(key), markdown: run.plan!.full[key]! }));
  const graphSeed = graphSeedReview(run.plan.graphSeed);
  if (graphSeed.length > 0) sections.push({ title: "Graph Seed", markdown: graphSeed.join("\n") });
  return {
    mode: "approved",
    sections,
  };
}

function planningActivityMarkdown(activity: readonly RunActivityRecord[]): string {
  const generic = /^(?:planning\s+)?(?:agent\s+)?(?:event|activity|working|active)[.!]?$/iu;
  const lines: string[] = [];
  let previous = "";
  for (const event of activity) {
    if (event.kind !== "agent" && !event.message.toLocaleLowerCase("en-US").includes("plan")) continue;
    const message = event.message.replace(/\s+/gu, " ").trim();
    const normalized = message.toLocaleLowerCase("en-US");
    if (message.length === 0 || generic.test(message) || normalized === previous) continue;
    lines.push(`- ${message}`);
    previous = normalized;
  }
  return lines.slice(-40).join("\n") || "Planning is active. Semantic milestones will appear here.";
}

function approvalView(run: RunRecord): NonNullable<ControlCenterViewModel["selectedRun"]>["approval"] | undefined {
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
  const lines = [`${Object.keys(rootSpec).length} goal facts · ${nodes.length} semantic nodes · ${edges.length} relationships`];
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
    const title = typeof unknownNode.title === "string" ? shortNodeTitle(unknownNode.title) : undefined;
    const type = typeof unknownNode.type === "string" ? titleCase(unknownNode.type) : "Node";
    if (key !== undefined && title !== undefined) titles.set(key, title);
    if (title !== undefined) {
      const spec = isPlainRecord(unknownNode.spec) ? unknownNode.spec : undefined;
      const purpose = spec === undefined ? undefined : ["purpose", "description", "summary", "intent"]
        .map((field) => safeGraphFact(spec[field]))
        .find((candidate) => candidate !== undefined);
      lines.push(`- ${type}: ${title}${purpose === undefined ? "" : ` — ${purpose}`}`);
    }
  }
  for (const unknownEdge of edges.slice(0, 16)) {
    if (!isPlainRecord(unknownEdge)) continue;
    const source = typeof unknownEdge.source === "string" ? titles.get(unknownEdge.source) : undefined;
    const target = typeof unknownEdge.target === "string" ? titles.get(unknownEdge.target) : undefined;
    const relation = typeof unknownEdge.relation === "string" ? titleCase(unknownEdge.relation).toLowerCase() : undefined;
    if (source !== undefined && target !== undefined && relation !== undefined) lines.push(`- ${source} ${relation} ${target}`);
  }
  const omittedRoot = Math.max(0, Object.keys(rootSpec).length - shownRootFacts);
  const omittedNodes = Math.max(0, nodes.length - 12);
  const omittedEdges = Math.max(0, edges.length - 16);
  const omitted = [
    ...(omittedRoot === 0 ? [] : [`${omittedRoot} goal ${omittedRoot === 1 ? "fact" : "facts"}`]),
    ...(omittedNodes === 0 ? [] : [`${omittedNodes} ${omittedNodes === 1 ? "node" : "nodes"}`]),
    ...(omittedEdges === 0 ? [] : [`${omittedEdges} ${omittedEdges === 1 ? "relationship" : "relationships"}`]),
  ];
  if (omitted.length > 0) lines.push(`- ${omitted.join(", ")} omitted from this concise review.`);
  return lines;
}

function stageViews(run: RunRecord): NonNullable<ControlCenterViewModel["selectedRun"]>["stages"] {
  const activeIndex = run.currentPipelineStageId === undefined
    ? -1
    : run.pipelineStageIds.indexOf(run.currentPipelineStageId);
  return run.pipelineStageIds.map((id, index) => ({
    id,
    title: titleCase(id),
    state: run.lifecycle.phase === "completed"
      ? "done"
      : index < activeIndex
      ? "done"
      : index === activeIndex && !new Set(["completed", "deleted", "failed"]).has(run.lifecycle.phase)
        ? "active"
        : "pending",
  }));
}

function ticketRow(ticket: TicketRecord): TicketRowView {
  const done = ticket.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
  return {
    id: ticket.id,
    title: ticket.title,
    status: titleCase(ticket.status),
    progress: `${done}/${ticket.steps.length}`,
    active: ticket.steps.some((step) => step.status === "running"),
  };
}

function agentRow(run: RunRecord, attempt: AgentAttemptRecord, includeTicketPrefix: boolean): AgentRowView {
  const ticket = run.tickets[attempt.ticketId];
  const persona = titleCase(attempt.personaId);
  const prefix = includeTicketPrefix && ticket !== undefined ? `${ticket.title} · ` : "";
  const step = ticket?.steps.find((candidate) => candidate.id === attempt.stepId);
  const active = new Set(["queued", "running", "waiting_question", "terminal_accepted"]).has(attempt.status);
  const newTokens = attempt.inputTokens + attempt.outputTokens;
  const allTokens = newTokens + attempt.cacheReadTokens + attempt.cacheWriteTokens;
  return {
    id: attempt.id,
    label: `${prefix}${persona}`,
    work: compactWorkTitle(
      step?.title ?? attempt.terminalSummary ?? attemptPhaseTitle(attempt, ticket !== undefined, active),
    ),
    model: attempt.modelId,
    thinking: attempt.thinkingLevel,
    status: attempt.status,
    active,
    newTokens: formatTokens(newTokens),
    allTokens: formatTokens(allTokens),
  };
}

function attemptPhaseTitle(attempt: AgentAttemptRecord, hasTicket: boolean, active: boolean): string {
  const kind = attempt.kind ?? (attempt.ticketId === "run-planning" ? "planning" : hasTicket ? "ticket" : undefined);
  if (kind === "planning") return active ? "Planning run" : "Planned run";
  if (kind === "verification") return active ? "Reviewing evidence" : "Reviewed evidence";
  if (kind === "integration") return active ? "Resolving integration" : "Integration finished";
  if (kind === "ticket") return active ? "Working ticket" : "Ticket work finished";
  return active ? "Working" : "Attempt finished";
}

function activityView(event: RunActivityRecord): ActivityView {
  return {
    id: event.id,
    timestamp: formatTimestamp(event.at),
    kind: event.kind,
    message: event.message,
  };
}

function graphView(graph: ControlCenterInput["graph"]): {
  nodes: GraphNodeView[];
  edges: GraphEdge[];
} {
  if (graph === undefined) return { nodes: [], edges: [] };
  const nodes = [...graph.nodes].sort((left, right) => left.id.localeCompare(right.id)).map((node) => ({
    id: node.id,
    type: node.type,
    marker: graphMarker(node.type),
    label: shortNodeTitle(node.title),
    muted: !new Set(["active", "planned", "open", "unresolved", "pending"]).has(node.status),
  }));
  return {
    nodes,
    edges: [...graph.edges].sort((left, right) =>
      left.source.localeCompare(right.source) ||
      left.relation.localeCompare(right.relation) ||
      left.target.localeCompare(right.target)
    ),
  };
}

function runTokens(run: RunRecord): { newTokens: number; allTokens: number } {
  let newTokens = 0;
  let allTokens = 0;
  for (const attempt of Object.values(run.attempts)) {
    const attemptNew = attempt.inputTokens + attempt.outputTokens;
    newTokens += attemptNew;
    allTokens += attemptNew + attempt.cacheReadTokens + attempt.cacheWriteTokens;
  }
  return { newTokens, allTokens };
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value >= 1_000_000_000) return `${trimDecimal(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimDecimal(value / 1_000)}K`;
  return Math.round(value).toString();
}

function trimDecimal(value: number): string {
  return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1).replace(/\.0$/u, "") : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

function objectiveTitle(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= 52 ? normalized : `${normalized.slice(0, 49).trimEnd()}…`;
}

function compactWorkTitle(value: string): string {
  const words = value.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/u).filter(Boolean);
  const normalized = words.join(" ").toLocaleLowerCase("en-US");
  if (normalized === "execute compiled work") return "Coordinating tickets";
  if (normalized === "combined plan" || normalized === "plan run") return "Planning run";
  return words.slice(0, 3).join(" ") || "Working";
}

function shortNodeTitle(value: string): string {
  const words = value.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/u).filter(Boolean);
  const selected = words.slice(0, 4).join(" ");
  return selected || "Untitled";
}

function safeGraphFact(value: unknown): string | undefined {
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return String(value);
  if (typeof value !== "string") return undefined;
  const safe = safeOperatorText(value);
  if (
    safe === undefined ||
    safe.includes("[local path]") ||
    safe.includes("[redacted digest]") ||
    safe.includes("[structured detail]")
  ) return undefined;
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
    .replace(/\b(run|ticket|attempt|session|question|claim|experiment|gate|node|step)[-_:][\p{L}\p{N}._:-]+\b/giu, (_match, kind: string) => `the ${kind.toLowerCase()}`)
    .replace(/\s+/gu, " ")
    .trim();
  safe = safe.replace(/(?:\[structured detail\]\s*){2,}/gu, "[structured detail] ").trim();
  if (safe.length === 0) return undefined;
  const normalized = safe.toLocaleLowerCase("en-US").replace(/[.!]+$/u, "");
  if (new Set([
    "blocked",
    "failed",
    "error",
    "unknown",
    "needs attention",
    "waiting",
    "not available",
  ]).has(normalized)) return undefined;
  return safe;
}

function graphMarker(type: string): string {
  return type.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "N";
}

function ticketOrder(left: TicketRecord, right: TicketRecord): number {
  return left.priority - right.priority || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
}

function agentOrder(left: AgentAttemptRecord, right: AgentAttemptRecord): number {
  const leftActive = new Set(["queued", "running", "waiting_question", "terminal_accepted"]).has(left.status);
  const rightActive = new Set(["queued", "running", "waiting_question", "terminal_accepted"]).has(right.status);
  return Number(rightActive) - Number(leftActive) ||
    (right.startedAt ?? "").localeCompare(left.startedAt ?? "") ||
    left.personaId.localeCompare(right.personaId) ||
    left.id.localeCompare(right.id);
}

function stageTitle(stage: string | undefined, phase: string): string {
  if (phase === "approving") return "Preparing Workspace";
  return titleCase(stage ?? phase);
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/gu, " ")
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
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
