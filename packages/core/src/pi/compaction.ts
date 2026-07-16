import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { isSha256Digest, rawSha256, type Sha256Digest } from "../shared/canonical.js";
import type { AgentLaunchSpec } from "./launch-spec.js";

const MAX_CONTEXT_BYTES = 4 * 1024 * 1024;
const MAX_SUMMARY_FIELD_BYTES = 64 * 1024;
const MAX_SUMMARY_ITEMS = 1_024;

export interface BoundAuthoritativeContext {
  runId: string;
  ticketId: string;
  stepId: string;
  attemptId: string;
  sessionId: string;
  grantId: string;
  generation: number;
  epoch: number;
  stateHash: Sha256Digest;
  contextHash: Sha256Digest;
  content: string;
}

export interface KoniCompactionSnapshot {
  objective: string;
  plan: {
    architecture: string;
    decisions: string;
    risk: string;
    verification: string;
  };
  graphRefs: readonly string[];
  touchedFiles: readonly string[];
  receiptIds: readonly string[];
  checkIds: readonly string[];
  unresolvedQuestions: readonly string[];
  nextAction: string;
}

export interface KoniContextProvider {
  loadBoundContext(spec: Readonly<AgentLaunchSpec>): Promise<BoundAuthoritativeContext>;
  loadCompactionSnapshot(spec: Readonly<AgentLaunchSpec>): Promise<KoniCompactionSnapshot>;
}

export interface CompactionLifecycleNotice {
  type: "context_reissued" | "compaction_created" | "compaction_denied" | "linear_navigation_denied";
  detail: string;
}

/**
 * The sole inline extension for contained attempts. It makes session history linear, supplies a
 * deterministic structured compaction, and reissues the compiler-bound context before every model
 * call (therefore also on the first request after compaction/restoration).
 */
export function createKoniManagedExtension(options: {
  spec: Readonly<AgentLaunchSpec>;
  contextProvider: KoniContextProvider;
  onNotice?: (notice: CompactionLifecycleNotice) => void;
}): InlineExtension {
  return {
    name: "koni-managed-session",
    factory: (pi) => {
      pi.on("session_before_switch", () => denyLinear(options, "session switching"));
      pi.on("session_before_fork", () => denyLinear(options, "session forking"));
      pi.on("session_before_tree", () => denyLinear(options, "session tree navigation"));

      pi.on("context", async (event) => {
        const bound = await options.contextProvider.loadBoundContext(options.spec);
        validateBoundContext(options.spec, bound);
        options.onNotice?.({ type: "context_reissued", detail: bound.contextHash });
        const contextMessage: AgentMessage = {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                `<koni_authoritative_context protocol="koni.context-reissue.v1"`,
                ` run="${xmlAttribute(bound.runId)}" ticket="${xmlAttribute(bound.ticketId)}"`,
                ` step="${xmlAttribute(bound.stepId)}" attempt="${xmlAttribute(bound.attemptId)}"`,
                ` state_hash="${bound.stateHash}" context_hash="${bound.contextHash}">`,
                bound.content,
                "</koni_authoritative_context>",
              ].join(""),
            },
          ],
          timestamp: Date.now(),
        };
        return { messages: [contextMessage, ...event.messages] };
      });

      pi.on("session_before_compact", async (event) => {
        try {
          const snapshot = await options.contextProvider.loadCompactionSnapshot(options.spec);
          validateSnapshot(snapshot);
          const summary = renderCompactionSummary(options.spec, snapshot);
          options.onNotice?.({ type: "compaction_created", detail: event.reason });
          return {
            compaction: {
              summary,
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
              details: {
                protocol: "koni.compaction.v1",
                specHash: options.spec.specHash,
                runId: options.spec.identity.runId,
                ticketId: options.spec.identity.ticketId,
                stepId: options.spec.identity.stepId,
                attemptId: options.spec.identity.attemptId,
                grantHash: options.spec.authority.grantHash,
                stateHash: options.spec.authority.expectedStateHash,
                contextHash: options.spec.authority.authoritativeContextHash,
                contextReissueRequired: true,
              },
            },
          };
        } catch (error) {
          options.onNotice?.({
            type: "compaction_denied",
            detail: error instanceof Error ? error.message : String(error),
          });
          // Losing compiler-bound references is worse than retaining a large session.
          return { cancel: true };
        }
      });
    },
  };
}

export function validateBoundContext(
  spec: Readonly<AgentLaunchSpec>,
  bound: BoundAuthoritativeContext,
): void {
  const expected = {
    runId: spec.identity.runId,
    ticketId: spec.identity.ticketId,
    stepId: spec.identity.stepId,
    attemptId: spec.identity.attemptId,
    sessionId: spec.identity.sessionId,
    grantId: spec.authority.grantId,
    generation: spec.authority.generation,
    epoch: spec.authority.epoch,
    stateHash: spec.authority.expectedStateHash,
    contextHash: spec.authority.authoritativeContextHash,
  } as const;
  for (const [key, value] of Object.entries(expected)) {
    if (bound[key as keyof typeof expected] !== value) {
      throw new Error(`authoritative context ${key} does not match the immutable launch binding`);
    }
  }
  if (!isSha256Digest(bound.contextHash) || rawSha256(bound.content) !== bound.contextHash) {
    throw new Error("authoritative context bytes do not match their launch-bound hash");
  }
  const bytes = Buffer.byteLength(bound.content, "utf8");
  if (bytes === 0 || bytes > MAX_CONTEXT_BYTES || bound.content.includes("\u0000")) {
    throw new Error("authoritative context is empty, oversized, or contains NUL");
  }
}

export function renderCompactionSummary(
  spec: Readonly<AgentLaunchSpec>,
  snapshot: KoniCompactionSnapshot,
): string {
  validateSnapshot(snapshot);
  return [
    "# Koni attempt checkpoint",
    "",
    `- Run: ${spec.identity.runId}`,
    `- Ticket: ${spec.identity.ticketId}`,
    `- Step: ${spec.identity.stepId}`,
    `- Attempt: ${spec.identity.attemptId}`,
    `- Grant: ${spec.authority.grantHash}`,
    `- Expected state: ${spec.authority.expectedStateHash}`,
    `- Authoritative context: ${spec.authority.authoritativeContextHash} (reissued before the next provider request)`,
    "",
    "## Objective",
    snapshot.objective,
    "",
    "## Plan",
    `### Architecture\n${snapshot.plan.architecture}`,
    `### Decisions\n${snapshot.plan.decisions}`,
    `### Risk\n${snapshot.plan.risk}`,
    `### Verification\n${snapshot.plan.verification}`,
    "",
    renderList("Graph nodes and edges touched", snapshot.graphRefs),
    renderList("Files read or modified", snapshot.touchedFiles),
    renderList("Receipts", snapshot.receiptIds),
    renderList("Checks", snapshot.checkIds),
    renderList("Unresolved questions", snapshot.unresolvedQuestions),
    "## Next required action",
    snapshot.nextAction,
  ].join("\n");
}

function denyLinear(
  options: Parameters<typeof createKoniManagedExtension>[0],
  operation: string,
): { cancel: true } {
  options.onNotice?.({ type: "linear_navigation_denied", detail: operation });
  return { cancel: true };
}

function validateSnapshot(snapshot: KoniCompactionSnapshot): void {
  validateSummaryText(snapshot.objective, "objective");
  validateSummaryText(snapshot.plan.architecture, "plan.architecture");
  validateSummaryText(snapshot.plan.decisions, "plan.decisions");
  validateSummaryText(snapshot.plan.risk, "plan.risk");
  validateSummaryText(snapshot.plan.verification, "plan.verification");
  validateSummaryText(snapshot.nextAction, "nextAction");
  for (const [name, values] of Object.entries({
    graphRefs: snapshot.graphRefs,
    touchedFiles: snapshot.touchedFiles,
    receiptIds: snapshot.receiptIds,
    checkIds: snapshot.checkIds,
    unresolvedQuestions: snapshot.unresolvedQuestions,
  })) {
    if (values.length > MAX_SUMMARY_ITEMS) {
      throw new Error(`${name} exceeds the structured compaction item limit`);
    }
    for (const value of values) {
      validateSummaryText(value, name);
    }
  }
}

function validateSummaryText(value: string, name: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes === 0 || bytes > MAX_SUMMARY_FIELD_BYTES || value.includes("\u0000")) {
    throw new Error(`${name} is empty, oversized, or contains NUL`);
  }
}

function renderList(title: string, items: readonly string[]): string {
  return [`## ${title}`, ...(items.length === 0 ? ["- None"] : items.map((item) => `- ${item}`)), ""].join("\n");
}

function xmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
