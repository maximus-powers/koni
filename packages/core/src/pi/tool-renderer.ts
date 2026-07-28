import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { GraphEdge, GraphNode } from "../graph/model.js";
import type { ControlProposalInspection } from "../control-center/protocol.js";

export const KONI_PROJECT_STATUS_PROTOCOL = "koni.interactive-project-status.v1" as const;
export const KONI_RUN_STATUS_PROTOCOL = "koni.interactive-run-status.v2" as const;
export const KONI_GRAPH_CONTEXT_PROTOCOL = "koni.interactive-graph-context.v1" as const;
export const KONI_TICKET_CONTEXT_PROTOCOL = "koni.interactive-ticket-context.v1" as const;
export const KONI_AGENT_TRANSCRIPT_PROTOCOL = "koni.interactive-agent-transcript.v1" as const;
export const KONI_PROPOSAL_PROTOCOL = "koni.interactive-proposal.v1" as const;

export interface KoniSemanticRunSummary {
  id: string;
  objective: string;
  runType: string;
  phase: string;
  stage?: string;
  targetRef: string;
  tickets: { completed: number; active: number; blocked: number; total: number };
  agents: { active: number; total: number };
  pendingQuestions: number;
  tokens: { new: number; cache: number; total: number };
  awaitingApproval: boolean;
  updatedAt: string;
  blocker?: string;
}

export interface KoniProjectStatusDetails {
  protocol: typeof KONI_PROJECT_STATUS_PROTOCOL;
  project: {
    root: string;
    version: string;
    revision: number;
    runCount: number;
  };
  runs: KoniSemanticRunSummary[];
  totalRuns: number;
  truncated: boolean;
}

export interface KoniRunStatusDetails {
  protocol: typeof KONI_RUN_STATUS_PROTOCOL;
  run: KoniSemanticRunSummary & {
    profile: string;
    createdAt: string;
    graphRevision: number;
    graphHash?: string;
  };
  tickets: Array<{
    id: string;
    title: string;
    status: string;
    completedSteps: number;
    totalSteps: number;
    blocker?: string;
  }>;
  agents: Array<{
    id: string;
    ticketId: string;
    stepId: string;
    persona: string;
    model: string;
    reasoning: string;
    status: string;
    workTitle: string;
    summary?: string;
  }>;
  attention: {
    pendingQuestions: Array<{ id: string; prompt: string }>;
    awaitingPlanApproval: boolean;
    blocked?: string;
    failed?: string;
    mergeReady: boolean;
  };
  recentActivity: Array<{
    at: string;
    kind: string;
    message: string;
    ticketId?: string;
  }>;
  plan?: {
    revision: number;
    status: string;
    concise: Record<string, Array<{ title: string; description: string }>>;
  };
}

export interface KoniGraphContextDetails {
  protocol: typeof KONI_GRAPH_CONTEXT_PROTOCOL;
  run: Pick<KoniSemanticRunSummary, "id" | "objective" | "phase" | "stage">;
  scope: { kind: "run" | "ticket" | "nodes"; ticketId?: string; ticketTitle?: string };
  nodes: GraphNode[];
  edges: GraphEdge[];
  totals: { nodes: number; edges: number };
  truncated: boolean;
}

export interface KoniTicketContextDetails {
  protocol: typeof KONI_TICKET_CONTEXT_PROTOCOL;
  run: Pick<KoniSemanticRunSummary, "id" | "objective" | "phase" | "stage">;
  ticket: {
    id: string;
    operationId: string;
    title: string;
    summary: string;
    status: string;
    priority: number;
    dependencies: Array<{ id: string; title?: string; status?: string }>;
    targetNodeIds: string[];
    readPaths: string[];
    writePaths: string[];
    branch?: string;
    blocker?: string;
    updatedAt: string;
    steps: Array<{
      id: string;
      title: string;
      persona: string;
      status: string;
      summary?: string;
      attemptCount: number;
    }>;
  };
  agents: KoniRunStatusDetails["agents"];
}

export interface KoniAgentTranscriptDetails {
  protocol: typeof KONI_AGENT_TRANSCRIPT_PROTOCOL;
  run: Pick<KoniSemanticRunSummary, "id" | "objective" | "phase" | "stage">;
  agent: {
    id: string;
    ticketId: string;
    stepId: string;
    persona: string;
    model: string;
    reasoning: string;
    status: string;
  };
  /** Opaque authority-issued cursor for an older snapshot-bound page. */
  cursor?: string;
  nextCursor?: string;
  totalBlocks: number;
  blocks: Array<{
    id: string;
    kind: "user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "compaction" | "notice";
    title: string;
    markdown: string;
    timestamp?: string;
    branch: boolean;
    error: boolean;
  }>;
  diagnostics: string[];
}

export interface KoniProposalDetails {
  protocol: typeof KONI_PROPOSAL_PROTOCOL;
  outcome: "inspected" | "decided" | "cancelled";
  proposal: ControlProposalInspection;
}

export type KoniInteractiveSemanticDetails =
  | KoniProjectStatusDetails
  | KoniRunStatusDetails
  | KoniGraphContextDetails
  | KoniTicketContextDetails
  | KoniAgentTranscriptDetails
  | KoniProposalDetails;

interface ReceiptLike {
  protocol: "koni.tool-receipt.v1";
  outcome: "accepted" | "rejected";
  receiptId: string;
  summary: string;
  code?: string;
  value?: unknown;
}

/**
 * Pi 0.80.10 supplies custom tool renderers with a reusable component slot. This renderer is pure:
 * it never reads project state, invokes an authority, or changes a session. Both installed and
 * contained Koni tools use it so receipts and graph projections look identical in native Pi chat.
 */
export function renderKoniToolCall(
  toolName: string,
  label: string,
  args: unknown,
  theme: Theme,
  previous?: Component,
): Component {
  const scope = callScope(toolName, args);
  const output =
    theme.fg("toolTitle", theme.bold(label)) +
    (scope === undefined ? "" : ` ${theme.fg("muted", scope)}`);
  return updateText(previous, output);
}

export function renderKoniToolResult(
  label: string,
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  previous?: Component,
): Component {
  const details = result.details;
  const receipt = receiptLike(details);
  const failed = receipt?.outcome === "rejected";
  const semantic = interactiveDetails(details);
  const cancelled =
    semantic?.protocol === KONI_PROPOSAL_PROTOCOL && semantic.outcome === "cancelled";
  const marker = failed
    ? theme.fg("error", "✕")
    : cancelled
      ? theme.fg("warning", "○")
      : theme.fg(options.isPartial ? "warning" : "success", options.isPartial ? "◌" : "✓");
  const title = receipt?.summary ?? semanticTitle(details) ?? label;
  const body = semanticResultText(details, result, options.expanded);
  const header = `${marker} ${theme.fg("toolTitle", theme.bold(title))}`;
  const styledBody = body.length === 0 ? "" : `\n${styleBody(body, theme, failed)}`;
  return updateText(previous, `${header}${styledBody}`);
}

/** Full, unstyled semantic text placed in model context by installed interactive tools. */
export function renderKoniModelText(details: KoniInteractiveSemanticDetails): string {
  return semanticDetailsText(details, true);
}

function semanticResultText(
  details: unknown,
  result: AgentToolResult<unknown>,
  expanded: boolean,
): string {
  const receipt = receiptLike(details);
  if (receipt !== undefined) {
    const lines: string[] = [];
    if (receipt.outcome === "rejected" && receipt.code !== undefined)
      lines.push(`Code: ${receipt.code}`);
    if (expanded) lines.push(`Receipt: ${receipt.receiptId}`);
    if (receipt.value !== undefined) {
      const graph = graphProjection(receipt.value);
      if (graph !== undefined) lines.push(...graphLines(graph.nodes, graph.edges, expanded));
      else if (expanded) lines.push(`Value:\n${safeJson(receipt.value)}`);
    }
    return lines.join("\n");
  }
  const interactive = interactiveDetails(details);
  if (interactive !== undefined) return semanticDetailsText(interactive, expanded);
  const text = result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  if (expanded) return text;
  return boundedLines(text, 6);
}

function semanticDetailsText(details: KoniInteractiveSemanticDetails, expanded: boolean): string {
  switch (details.protocol) {
    case KONI_PROJECT_STATUS_PROTOCOL: {
      const lines = [
        `Project: ${details.project.root}`,
        `Authority: ${details.project.version} · revision ${details.project.revision}`,
        `Runs: ${details.totalRuns}${details.truncated ? ` · showing ${details.runs.length}` : ""}`,
      ];
      for (const run of details.runs.slice(0, expanded ? details.runs.length : 4)) {
        lines.push(...runSummaryLines(run, expanded));
      }
      if (!expanded && details.runs.length > 4) lines.push(`… ${details.runs.length - 4} more`);
      return lines.join("\n");
    }
    case KONI_RUN_STATUS_PROTOCOL: {
      const lines = [
        ...runSummaryLines(details.run, true),
        `Profile: ${details.run.profile}`,
        `Graph: revision ${details.run.graphRevision}${details.run.graphHash === undefined ? "" : ` · ${details.run.graphHash}`}`,
        "Tickets:",
      ];
      const tickets = details.tickets.slice(0, expanded ? details.tickets.length : 5);
      for (const ticket of tickets) {
        lines.push(
          `- ${ticket.title} · ${ticket.status} · ${ticket.completedSteps}/${ticket.totalSteps} steps`,
        );
        if (expanded)
          lines.push(
            `  ${ticket.id}${ticket.blocker === undefined ? "" : ` · blocked: ${ticket.blocker}`}`,
          );
      }
      if (!expanded && details.tickets.length > tickets.length)
        lines.push(`… ${details.tickets.length - tickets.length} more tickets`);
      if (expanded && details.agents.length > 0) {
        lines.push("Agents:");
        for (const agent of details.agents) {
          lines.push(
            `- ${agent.persona} · ${agent.status} · ${agent.workTitle} · ${agent.model} (${agent.reasoning})`,
          );
          lines.push(
            `  ${agent.ticketId} / ${agent.stepId}${agent.summary === undefined ? "" : ` · ${agent.summary}`}`,
          );
        }
      }
      if (details.attention.pendingQuestions.length > 0) {
        lines.push("Questions:");
        for (const question of details.attention.pendingQuestions) {
          lines.push(`- ${question.prompt} · ${question.id}`);
        }
      }
      if (details.attention.awaitingPlanApproval)
        lines.push("Attention: plan approval is pending in the Koni overlay.");
      if (details.attention.blocked !== undefined)
        lines.push(`Blocked: ${details.attention.blocked}`);
      if (details.attention.failed !== undefined) lines.push(`Failed: ${details.attention.failed}`);
      if (details.attention.mergeReady)
        lines.push("Attention: run is ready for explicit merge in the full Koni control center.");
      if (expanded && details.recentActivity.length > 0) {
        lines.push("Recent Activity:");
        for (const activity of details.recentActivity) {
          lines.push(
            `- ${activity.at} · ${titleCase(activity.kind)} · ${activity.message}${activity.ticketId === undefined ? "" : ` · ${activity.ticketId}`}`,
          );
        }
      }
      if (expanded && details.plan !== undefined) {
        lines.push(`Plan: ${details.plan.status} · revision ${details.plan.revision}`);
        for (const [section, items] of Object.entries(details.plan.concise)) {
          lines.push(`${titleCase(section)}:`);
          for (const item of items) lines.push(`- ${item.title}: ${item.description}`);
        }
      }
      return lines.join("\n");
    }
    case KONI_GRAPH_CONTEXT_PROTOCOL: {
      const scope =
        details.scope.kind === "ticket"
          ? `Ticket: ${details.scope.ticketTitle ?? details.scope.ticketId ?? "selected ticket"}`
          : details.scope.kind === "nodes"
            ? "Scope: requested nodes"
            : "Scope: full run graph";
      return [
        `Run: ${details.run.objective} · ${details.run.phase}`,
        scope,
        `Graph: ${details.nodes.length}/${details.totals.nodes} nodes · ${details.edges.length}/${details.totals.edges} edges${details.truncated ? " · truncated" : ""}`,
        ...graphLines(details.nodes, details.edges, expanded),
      ].join("\n");
    }
    case KONI_TICKET_CONTEXT_PROTOCOL: {
      const ticket = details.ticket;
      const lines = [
        `Run: ${details.run.objective} · ${details.run.phase}`,
        `Ticket: ${ticket.title} · ${ticket.status} · priority ${ticket.priority}`,
        ticket.summary,
      ];
      if (ticket.blocker !== undefined) lines.push(`Blocked: ${ticket.blocker}`);
      lines.push("Steps:");
      const steps = ticket.steps.slice(0, expanded ? ticket.steps.length : 6);
      for (const step of steps) {
        lines.push(`- ${step.title} · ${step.persona} · ${step.status}`);
        if (step.summary !== undefined) lines.push(`  ${step.summary}`);
      }
      if (!expanded && ticket.steps.length > steps.length)
        lines.push(`… ${ticket.steps.length - steps.length} more steps`);
      if (expanded) {
        lines.push(`Ticket ID: ${ticket.id}`, `Operation: ${ticket.operationId}`);
        if (ticket.dependencies.length > 0) {
          lines.push("Dependencies:");
          for (const dependency of ticket.dependencies) {
            lines.push(
              `- ${dependency.title ?? dependency.id}${dependency.status === undefined ? "" : ` · ${dependency.status}`} · ${dependency.id}`,
            );
          }
        }
        if (ticket.targetNodeIds.length > 0)
          lines.push(`Graph nodes: ${ticket.targetNodeIds.join(", ")}`);
        if (ticket.readPaths.length > 0) lines.push(`Reads: ${ticket.readPaths.join(", ")}`);
        if (ticket.writePaths.length > 0) lines.push(`Writes: ${ticket.writePaths.join(", ")}`);
        if (details.agents.length > 0) {
          lines.push("Agents:");
          for (const agent of details.agents) {
            lines.push(
              `- ${agent.persona} · ${agent.status} · ${agent.model} (${agent.reasoning})`,
            );
          }
        }
      }
      return lines.join("\n");
    }
    case KONI_AGENT_TRANSCRIPT_PROTOCOL: {
      const lines = [
        `Run: ${details.run.objective} · ${details.run.phase}`,
        `Agent: ${details.agent.persona} · ${details.agent.status} · ${details.agent.model} (${details.agent.reasoning})`,
        `Transcript: ${details.blocks.length} ${details.cursor === undefined ? "latest" : "older"} blocks of ${details.totalBlocks}`,
      ];
      for (const block of details.blocks) {
        const timestamp = block.timestamp === undefined ? "" : ` · ${block.timestamp}`;
        const branch = block.branch ? " · branch" : "";
        const failed = block.error ? " · error" : "";
        lines.push(`\n[${titleCase(block.kind)}] ${block.title}${timestamp}${branch}${failed}`);
        lines.push(block.markdown);
      }
      if (details.nextCursor !== undefined) {
        lines.push("\nMore transcript history is available with the returned cursor.");
      }
      for (const diagnostic of details.diagnostics) lines.push(`\nTranscript note: ${diagnostic}`);
      return lines.join("\n");
    }
    case KONI_PROPOSAL_PROTOCOL: {
      const proposal = details.proposal;
      const scope = `${proposal.targetNodeIds.length} graph ${proposal.targetNodeIds.length === 1 ? "node" : "nodes"}`;
      const lines = [
        `Proposal: ${proposal.title} · ${proposal.status}`,
        proposal.summary,
        `Outcome: ${titleCase(details.outcome)} · Scope: ${scope}`,
        `Disposition: ${proposalDispositionText(proposal)}`,
      ];
      if (proposal.decision !== undefined) {
        lines.push(
          `Decision: ${proposal.decision.decision} · ${proposal.decision.actor} · ${proposal.decision.decidedAt}`,
        );
        if (proposal.decision.message !== undefined)
          lines.push(`Message: ${proposal.decision.message}`);
      }
      if (expanded) {
        lines.push(
          `Run: ${proposal.runId}`,
          `Ticket: ${proposal.ticketId}`,
          `Source ticket: ${proposal.sourceTicketId}`,
          `Created: ${proposal.createdAt}`,
        );
        if (proposal.targetNodeIds.length > 0)
          lines.push(`Graph nodes: ${proposal.targetNodeIds.join(", ")}`);
      }
      if (details.outcome === "cancelled") {
        lines.push("No decision was sent to Koni authority.");
      }
      return lines.join("\n");
    }
  }
}

function proposalDispositionText(proposal: ControlProposalInspection): string {
  const disposition = proposal.disposition;
  if (disposition.kind === "pending") return "awaiting operator decision";
  if (disposition.kind === "rejected") return "rejected";
  if (disposition.kind === "no_op")
    return disposition.summary === undefined
      ? "reviewed; no application required"
      : `reviewed; no application required · ${disposition.summary}`;
  return `application ${disposition.applicationStatus}`;
}

function graphLines(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  expanded: boolean,
): string[] {
  const nodeLimit = expanded ? nodes.length : Math.min(nodes.length, 5);
  const edgeLimit = expanded ? edges.length : Math.min(edges.length, 5);
  const lines: string[] = [];
  if (nodes.length > 0) lines.push("Nodes:");
  for (const node of nodes.slice(0, nodeLimit)) {
    lines.push(`- [${node.type}] ${node.title} · ${node.status}`);
    if (expanded) {
      lines.push(`  ID: ${node.id}`);
      if (Object.keys(node.spec).length > 0) lines.push(`  Spec: ${safeJson(node.spec)}`);
      if (Object.keys(node.annotations).length > 0)
        lines.push(`  Annotations: ${safeJson(node.annotations)}`);
    }
  }
  if (!expanded && nodes.length > nodeLimit) lines.push(`… ${nodes.length - nodeLimit} more nodes`);
  if (edges.length > 0) lines.push("Edges:");
  for (const edge of edges.slice(0, edgeLimit)) {
    lines.push(`- ${edge.source} —${edge.relation}→ ${edge.target}`);
  }
  if (!expanded && edges.length > edgeLimit) lines.push(`… ${edges.length - edgeLimit} more edges`);
  return lines;
}

function runSummaryLines(run: KoniSemanticRunSummary, expanded: boolean): string[] {
  const lines = [
    `- ${run.objective} · ${run.runType} · ${run.stage ?? run.phase}`,
    `  ${run.tickets.completed}/${run.tickets.total} tickets · ${run.agents.active}/${run.agents.total} active agents · ${run.tokens.total} tokens incl. cache`,
  ];
  if (expanded) {
    lines.push(`  ${run.id} · ${run.targetRef} · ${run.phase} · updated ${run.updatedAt}`);
    if (run.pendingQuestions > 0) lines.push(`  ${run.pendingQuestions} pending question(s)`);
    if (run.awaitingApproval) lines.push("  Awaiting plan approval");
    if (run.blocker !== undefined) lines.push(`  Blocked: ${run.blocker}`);
  }
  return lines;
}

function styleBody(text: string, theme: Theme, failed: boolean): string {
  return text
    .split("\n")
    .map((line) => {
      if (
        /^(?:Nodes|Edges|Tickets|Agents|Questions|Recent Activity|Steps|Dependencies|Architecture|Decisions|Risk|Verification):$/u.test(
          line,
        )
      ) {
        return theme.fg("accent", theme.bold(line));
      }
      if (/^(?:Code|Blocked):/u.test(line)) return theme.fg("error", line);
      if (/^(?:Receipt|Ticket ID|Operation|Graph nodes|Reads|Writes):/u.test(line))
        return theme.fg("muted", line);
      if (
        line.startsWith("…") ||
        line.startsWith("  ID:") ||
        line.startsWith("  Spec:") ||
        line.startsWith("  Annotations:")
      ) {
        return theme.fg("muted", line);
      }
      return theme.fg(failed ? "error" : "toolOutput", line);
    })
    .join("\n");
}

function callScope(toolName: string, value: unknown): string | undefined {
  const args = record(value);
  if (args === undefined) return undefined;
  const runId = stringValue(args.runId);
  const ticketId = stringValue(args.ticketId);
  const path = stringValue(args.path);
  const resourceId = stringValue(args.resourceId);
  const checkId = stringValue(args.checkId);
  if (toolName === "koni_project_status") return undefined;
  if (toolName === "koni_proposal_inspect") return undefined;
  if (toolName === "koni_proposal_decide") return stringValue(args.decision) ?? "review";
  if (ticketId !== undefined && runId !== undefined) return `${runId} · ${ticketId}`;
  if (runId !== undefined) return runId;
  if (path !== undefined) return path;
  if (resourceId !== undefined) return resourceId;
  if (checkId !== undefined) return checkId;
  const anchors = Array.isArray(args.anchors) ? args.anchors.length : 0;
  return anchors > 0 ? `${anchors} graph anchor${anchors === 1 ? "" : "s"}` : undefined;
}

function semanticTitle(value: unknown): string | undefined {
  const details = interactiveDetails(value);
  if (details === undefined) return undefined;
  switch (details.protocol) {
    case KONI_PROJECT_STATUS_PROTOCOL:
      return "Koni project status";
    case KONI_RUN_STATUS_PROTOCOL:
      return details.run.objective;
    case KONI_GRAPH_CONTEXT_PROTOCOL:
      return "Koni graph context";
    case KONI_TICKET_CONTEXT_PROTOCOL:
      return details.ticket.title;
    case KONI_AGENT_TRANSCRIPT_PROTOCOL:
      return `${details.agent.persona} transcript`;
    case KONI_PROPOSAL_PROTOCOL:
      return details.outcome === "cancelled"
        ? "Proposal decision cancelled"
        : details.outcome === "decided" && details.proposal.decision !== undefined
          ? `Proposal ${details.proposal.decision.decision === "approval" ? "approved" : "rejected"}`
          : details.proposal.title;
  }
}

function interactiveDetails(value: unknown): KoniInteractiveSemanticDetails | undefined {
  const candidate = record(value);
  if (candidate === undefined) return undefined;
  if (
    !new Set<string>([
      KONI_PROJECT_STATUS_PROTOCOL,
      KONI_RUN_STATUS_PROTOCOL,
      KONI_GRAPH_CONTEXT_PROTOCOL,
      KONI_TICKET_CONTEXT_PROTOCOL,
      KONI_AGENT_TRANSCRIPT_PROTOCOL,
      KONI_PROPOSAL_PROTOCOL,
    ]).has(String(candidate.protocol))
  )
    return undefined;
  return value as KoniInteractiveSemanticDetails;
}

function receiptLike(value: unknown): ReceiptLike | undefined {
  const candidate = record(value);
  if (
    candidate?.protocol !== "koni.tool-receipt.v1" ||
    (candidate.outcome !== "accepted" && candidate.outcome !== "rejected") ||
    typeof candidate.receiptId !== "string" ||
    typeof candidate.summary !== "string"
  )
    return undefined;
  return candidate as unknown as ReceiptLike;
}

function graphProjection(value: unknown): { nodes: GraphNode[]; edges: GraphEdge[] } | undefined {
  const candidate = record(value);
  if (candidate === undefined) return undefined;
  const direct =
    Array.isArray(candidate.nodes) && Array.isArray(candidate.edges)
      ? candidate
      : record(candidate.graph);
  if (direct === undefined || !Array.isArray(direct.nodes) || !Array.isArray(direct.edges))
    return undefined;
  return { nodes: direct.nodes as GraphNode[], edges: direct.edges as GraphEdge[] };
}

function updateText(previous: Component | undefined, value: string): Component {
  if (previous instanceof Text) {
    previous.setText(value);
    return previous;
  }
  return new Text(value, 0, 0);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unrenderable structured value]";
  }
}

function boundedLines(value: string, maximum: number): string {
  const lines = value.split("\n");
  return lines.length <= maximum
    ? value
    : `${lines.slice(0, maximum).join("\n")}\n… ${lines.length - maximum} more lines`;
}

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase("en-US"));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
