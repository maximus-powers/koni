import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  canonicalEncode,
  canonicalHash,
  isSha256Digest,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import {
  MAX_DYNAMIC_GRAPH_BYTES,
  MAX_DYNAMIC_GRAPH_RECORDS,
  type SelectedDynamicGraphContext,
} from "../graph/context-selector.js";
import type { AgentLaunchSpec } from "./launch-spec.js";
import {
  KONI_TOOL_RECEIPT_PROTOCOL,
  validateKoniToolReceipt,
  type KoniToolReceipt,
} from "./tool-catalog.js";

const MAX_CONTEXT_BYTES = 4 * 1024 * 1024;
const MAX_SUMMARY_FIELD_BYTES = 64 * 1024;
const MAX_SUMMARY_ITEMS = 1_024;
const MAX_COMPACTION_SUMMARY_BYTES = 4 * 1024 * 1024;

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
  /** Durable compiler-policy context reissued after a runtime threshold transition. */
  runtimePolicy?: {
    protocol: "koni.runtime-policy-context.v1";
    kind: "planning_synthesis";
    sha256: Sha256Digest;
    sizeBytes: number;
    content: string;
  };
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
  /** Fully read immutable skill resources retained across compaction. */
  loadedResources?: readonly string[];
  /** Exact authenticated bytes for loaded skill resources whose original receipts may be dropped. */
  loadedResourceContents?: readonly {
    relativePath: string;
    sha256: Sha256Digest;
    content: string;
  }[];
  receiptIds: readonly string[];
  checkIds: readonly string[];
  unresolvedQuestions: readonly string[];
  nextAction: string;
  workingSpec?: {
    id: string;
    version: number;
    digest: Sha256Digest;
    guidance: string;
  };
  dynamicGraphContext?: {
    envelopeHash: Sha256Digest;
    semanticRevision: number;
    semanticHash: Sha256Digest;
    contextualRevision: number;
    contextualHash: Sha256Digest;
    selectedIds: readonly string[];
  };
}

export interface KoniContextProvider {
  loadBoundContext(spec: Readonly<AgentLaunchSpec>): Promise<BoundAuthoritativeContext>;
  /** Optional only for compatibility test providers; production authority always supplies it. */
  loadDynamicGraphContext?(spec: Readonly<AgentLaunchSpec>): Promise<SelectedDynamicGraphContext>;
  loadCompactionSnapshot(spec: Readonly<AgentLaunchSpec>): Promise<KoniCompactionSnapshot>;
  /** Durably authorize the exact summary Pi is about to append. */
  authorizeCompaction(
    spec: Readonly<AgentLaunchSpec>,
    record: Omit<KoniAuthorizedCompaction, "sequence" | "authorizationId">,
  ): Promise<{ authorizationId: string }>;
  /** Atomically claim one recovery owner and return its durable authority view. */
  acquireRecoveryClaim(spec: Readonly<AgentLaunchSpec>): Promise<KoniAttemptRecoveryClaim>;
  /** Durably reserve one exact provider request before transport. Required in production. */
  reserveProviderRequest?(
    spec: Readonly<AgentLaunchSpec>,
    request: KoniProviderRequestReservationInput,
  ): Promise<KoniProviderRequestReservation>;
  /** Settle one reservation from canonical, fsynced Pi JSONL evidence. Required in production. */
  reconcileProviderRequest?(
    spec: Readonly<AgentLaunchSpec>,
    settlement: KoniProviderRequestSettlementInput,
  ): Promise<KoniProviderRequestSettlement>;
}

export interface KoniAuthorizedMessage {
  sequence: number;
  mode: "steer" | "follow_up";
  sha256: Sha256Digest;
  sizeBytes: number;
  content: string;
}

export interface KoniAuthorizedToolResult {
  sequence: number;
  callId: string;
  toolName: string;
  outcome: "accepted" | "rejected";
  argumentsSha256: Sha256Digest;
  argumentsSizeBytes: number;
  /** Canonical hash and canonical byte size of the parsed KoniToolReceipt details object. */
  receiptSha256: Sha256Digest;
  receiptSizeBytes: number;
  /** Exact parsed canonical KoniToolReceipt used to repair a crash-before-Pi-append boundary. */
  receipt: KoniToolReceipt;
}

export interface KoniAuthorizedCompaction {
  sequence: number;
  authorizationId: string;
  summaryHash: Sha256Digest;
  summaryBytes: number;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface KoniProviderRequestReservationInput {
  sequence: number;
  api: string;
  modelId: string;
  payloadSha256: Sha256Digest;
  payloadSizeBytes: number;
  prospectiveInputTokens: number;
  reservedOutputTokens: number;
  serializedOutputCap?: {
    path: string;
    value: number;
  };
}

export interface KoniProviderRequestReservation {
  protocol: "koni.provider-request-reservation.v1";
  sequence: number;
  reservationId: string;
  baselineEntryId: string;
}

export interface KoniProviderRequestSettlementInput {
  sequence: number;
  reservationId: string;
  assistantEntryId: string;
  assistantEntrySha256: Sha256Digest;
  usage: KoniAttemptUsage;
}

export interface KoniProviderRequestSettlement {
  protocol: "koni.provider-request-settlement.v1";
  sequence: number;
  reservationId: string;
  assistantEntryId: string;
  assistantEntrySha256: Sha256Digest;
  usage: KoniAttemptUsage;
}

export type KoniProviderRequestRetirement =
  | {
      protocol: "koni.provider-exposure-retirement.v1";
      disposition: "operator_acknowledged_canonical_abort" | "operator_acknowledged_provider_error";
      assistantEntryId: string;
      assistantEntrySha256: Sha256Digest;
      responseId: string;
      errorMessageSha256?: Sha256Digest;
      authorizationSha256: Sha256Digest;
      retiredAt: string;
      sha256: Sha256Digest;
    }
  | {
      protocol: "koni.provider-exposure-retirement.v1";
      disposition: "operator_acknowledged_authority_pause";
      pauseReasonSha256: Sha256Digest;
      authorizationSha256: Sha256Digest;
      retiredAt: string;
      sha256: Sha256Digest;
    }
  | {
      protocol: "koni.provider-exposure-retirement.v1";
      disposition: "operator_acknowledged_unreconciled_request";
      failureReasonSha256: Sha256Digest;
      authorizationSha256: Sha256Digest;
      retiredAt: string;
      sha256: Sha256Digest;
    };

export function providerRequestRetirementValidationError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "provider request retirement is not an object";
  }
  const retirement = value as Record<string, unknown>;
  if (
    retirement.protocol !== "koni.provider-exposure-retirement.v1" ||
    !isSha256Digest(retirement.authorizationSha256) ||
    !safeRetirementIdentity(retirement.retiredAt, 128) ||
    !isSha256Digest(retirement.sha256)
  ) {
    return "provider request retirement identity is malformed";
  }
  const common = ["protocol", "disposition", "authorizationSha256", "retiredAt", "sha256"];
  let variant: string[];
  switch (retirement.disposition) {
    case "operator_acknowledged_canonical_abort":
      variant = ["assistantEntryId", "assistantEntrySha256", "responseId"];
      break;
    case "operator_acknowledged_provider_error":
      variant = ["assistantEntryId", "assistantEntrySha256", "responseId", "errorMessageSha256"];
      break;
    case "operator_acknowledged_authority_pause":
      variant = ["pauseReasonSha256"];
      break;
    case "operator_acknowledged_unreconciled_request":
      variant = ["failureReasonSha256"];
      break;
    default:
      return "provider request retirement disposition is unsupported";
  }
  const expectedKeys = [...common, ...variant].sort();
  if (JSON.stringify(Object.keys(retirement).sort()) !== JSON.stringify(expectedKeys)) {
    return "provider request retirement fields do not match its disposition";
  }
  if (
    retirement.disposition === "operator_acknowledged_authority_pause"
      ? !isSha256Digest(retirement.pauseReasonSha256)
      : retirement.disposition === "operator_acknowledged_unreconciled_request"
        ? !isSha256Digest(retirement.failureReasonSha256)
        : !safeRetirementIdentity(retirement.assistantEntryId, 128) ||
          !isSha256Digest(retirement.assistantEntrySha256) ||
          !safeRetirementIdentity(retirement.responseId, 512) ||
          (retirement.disposition === "operator_acknowledged_provider_error" &&
            !isSha256Digest(retirement.errorMessageSha256))
  ) {
    return "provider request retirement fields are malformed";
  }
  const { sha256, ...material } = retirement;
  if (canonicalHash(material) !== sha256) {
    return "provider request retirement hash does not match its material";
  }
  return undefined;
}

function safeRetirementIdentity(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export interface KoniProviderRequestRecoveryRecord extends KoniProviderRequestReservationInput {
  reservationId: string;
  baselineEntryId: string;
  settlement?: Omit<KoniProviderRequestSettlement, "protocol" | "sequence" | "reservationId">;
  /** Authenticated non-billing terminal that conservatively retains the original exposure bound. */
  retirement?: KoniProviderRequestRetirement;
}

export interface KoniAttemptRecoveryClaim {
  protocol: "koni.attempt-recovery-claim.v1";
  claimId: string;
  state: KoniAttemptRecoveryState;
  /** Release is idempotent. Authority must also revoke the claim when its client disconnects. */
  release(): Promise<void>;
}

export interface KoniAttemptRecoveryState {
  protocol: "koni.attempt-recovery.v1";
  specHash: Sha256Digest;
  runId: string;
  ticketId: string;
  stepId: string;
  attemptId: string;
  sessionId: string;
  grantHash: Sha256Digest;
  generation: number;
  epoch: number;
  stateHash: Sha256Digest;
  usage: KoniAttemptUsage;
  status: "continue" | "terminal_accepted" | "terminal_inflight" | "revoked";
  authorizedMessages: readonly KoniAuthorizedMessage[];
  authorizedToolResults: readonly KoniAuthorizedToolResult[];
  authorizedCompactions: readonly KoniAuthorizedCompaction[];
  /** Absent only on attempts issued before provider reservations existed. */
  providerRequests?: readonly KoniProviderRequestRecoveryRecord[];
  /** Settled authority totals imported before request-level reservations were introduced. */
  providerUsageBaseline?: KoniAttemptUsage;
  terminalOutput?: unknown;
  reason?: string;
}

export interface KoniAttemptUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  newTokens: number;
  allTokens: number;
}

export interface CompactionLifecycleNotice {
  type:
    "context_reissued" | "compaction_created" | "compaction_denied" | "linear_navigation_denied";
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
  beforeProviderRequest?: () => void | Promise<void>;
  selectCompactionFirstKeptEntryId?: (preparedFirstKeptEntryId: string) => string;
  onTurnStart?: () => void;
  onNotice?: (notice: CompactionLifecycleNotice) => void;
}): InlineExtension {
  return {
    name: "koni-managed-session",
    factory: (pi) => {
      pi.on("session_before_switch", () => denyLinear(options, "session switching"));
      pi.on("session_before_fork", () => denyLinear(options, "session forking"));
      pi.on("session_before_tree", () => denyLinear(options, "session tree navigation"));
      pi.on("turn_start", () => options.onTurnStart?.());
      pi.on("tool_result", (event) => {
        if (
          typeof event.details !== "object" ||
          event.details === null ||
          Array.isArray(event.details) ||
          (event.details as Record<string, unknown>).protocol !== KONI_TOOL_RECEIPT_PROTOCOL
        ) {
          return undefined;
        }
        validateKoniToolReceipt(event.details);
        return { isError: event.details.outcome === "rejected" };
      });

      pi.on("context", async (event) => {
        await options.beforeProviderRequest?.();
        const bound = await options.contextProvider.loadBoundContext(options.spec);
        validateBoundContext(options.spec, bound);
        const dynamic =
          options.contextProvider.loadDynamicGraphContext === undefined
            ? undefined
            : await options.contextProvider.loadDynamicGraphContext(options.spec);
        if (dynamic !== undefined) validateDynamicGraphContext(options.spec, dynamic);
        const runtimePolicy = bound.runtimePolicy;
        if (runtimePolicy !== undefined) validateRuntimePolicyContext(runtimePolicy);
        emitNotice(options, {
          type: "context_reissued",
          detail:
            dynamic === undefined
              ? bound.contextHash
              : `${bound.contextHash}/${dynamic.envelopeHash}`,
        });
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
        const dynamicMessage: AgentMessage | undefined =
          dynamic === undefined
            ? undefined
            : {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: [
                      `<koni_dynamic_graph_context protocol="koni.dynamic-graph-context.v1"`,
                      ` run="${xmlAttribute(dynamic.envelope.binding.runId)}"`,
                      ` ticket="${xmlAttribute(dynamic.envelope.binding.ticketId)}"`,
                      ` step="${xmlAttribute(dynamic.envelope.binding.stepId)}"`,
                      ` attempt="${xmlAttribute(dynamic.envelope.binding.attemptId)}"`,
                      ` semantic_hash="${dynamic.envelope.binding.semanticHash}"`,
                      ` contextual_hash="${dynamic.envelope.binding.contextualHash}"`,
                      ` envelope_hash="${dynamic.envelopeHash}">`,
                      dynamic.content,
                      "</koni_dynamic_graph_context>",
                    ].join(""),
                  },
                ],
                timestamp: Date.now(),
              };
        const runtimePolicyMessage: AgentMessage | undefined =
          runtimePolicy === undefined
            ? undefined
            : {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: [
                      `<koni_runtime_policy protocol="${runtimePolicy.protocol}"`,
                      ` kind="${runtimePolicy.kind}" sha256="${runtimePolicy.sha256}">`,
                      runtimePolicy.content,
                      "</koni_runtime_policy>",
                    ].join(""),
                  },
                ],
                timestamp: Date.now(),
              };
        return {
          messages: [
            contextMessage,
            ...(dynamicMessage === undefined ? [] : [dynamicMessage]),
            ...(runtimePolicyMessage === undefined ? [] : [runtimePolicyMessage]),
            ...event.messages,
          ],
        };
      });

      pi.on("session_before_compact", async (event) => {
        try {
          const snapshot = await options.contextProvider.loadCompactionSnapshot(options.spec);
          validateSnapshot(snapshot);
          const summary = renderCompactionSummary(options.spec, snapshot);
          const summaryHash = rawSha256(summary);
          const summaryBytes = Buffer.byteLength(summary, "utf8");
          const firstKeptEntryId =
            options.selectCompactionFirstKeptEntryId?.(event.preparation.firstKeptEntryId) ??
            event.preparation.firstKeptEntryId;
          const authorized = await options.contextProvider.authorizeCompaction(options.spec, {
            summaryHash,
            summaryBytes,
            firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          });
          validateAuthorizationId(authorized.authorizationId);
          emitNotice(options, { type: "compaction_created", detail: event.reason });
          return {
            compaction: {
              summary,
              firstKeptEntryId,
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
                summaryHash,
                summaryBytes,
                authorizationId: authorized.authorizationId,
                contextReissueRequired: true,
              },
            },
          };
        } catch (error) {
          emitNotice(options, {
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

function validateAuthorizationId(value: string): void {
  if (
    Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("compaction authority returned an invalid authorization identity");
  }
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
  if (bound.runtimePolicy !== undefined) validateRuntimePolicyContext(bound.runtimePolicy);
}

function validateRuntimePolicyContext(
  value: NonNullable<BoundAuthoritativeContext["runtimePolicy"]>,
): void {
  if (
    value.protocol !== "koni.runtime-policy-context.v1" ||
    value.kind !== "planning_synthesis" ||
    !isSha256Digest(value.sha256) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 1 ||
    Buffer.byteLength(value.content, "utf8") !== value.sizeBytes ||
    rawSha256(value.content) !== value.sha256 ||
    value.content.includes("\u0000") ||
    value.sizeBytes > 64 * 1024
  )
    throw new Error("runtime policy context is malformed or unauthenticated");
}

export function validateDynamicGraphContext(
  spec: Readonly<AgentLaunchSpec>,
  dynamic: SelectedDynamicGraphContext,
): void {
  const envelope = dynamic.envelope;
  const binding = envelope.binding;
  if (
    envelope.protocol !== "koni.dynamic-graph-context.v1" ||
    binding.runId !== spec.identity.runId ||
    binding.ticketId !== spec.identity.ticketId ||
    binding.stepId !== spec.identity.stepId ||
    binding.attemptId !== spec.identity.attemptId ||
    binding.sessionId !== spec.identity.sessionId ||
    binding.personaId !== spec.persona.id ||
    binding.grantHash !== spec.authority.grantHash ||
    binding.launchSpecHash !== spec.specHash ||
    binding.generation !== spec.authority.generation ||
    !isSha256Digest(binding.semanticHash) ||
    !isSha256Digest(binding.contextualHash) ||
    !Number.isSafeInteger(binding.semanticRevision) ||
    binding.semanticRevision < 0 ||
    !Number.isSafeInteger(binding.contextualRevision) ||
    binding.contextualRevision < 0
  ) {
    throw new Error("dynamic graph context does not match the current immutable attempt binding");
  }
  if (
    canonicalEncode(envelope) !== dynamic.content ||
    rawSha256(dynamic.content) !== dynamic.envelopeHash
  ) {
    throw new Error("dynamic graph context bytes do not match their transient envelope hash");
  }
  const bytes = Buffer.byteLength(dynamic.content, "utf8");
  const estimatedTokens = Math.ceil(bytes / 4);
  const tokenLimit = Math.max(1, Math.floor(spec.budgets.tokens.maxInput / 4));
  const byteLimit = Math.min(MAX_DYNAMIC_GRAPH_BYTES, 4 * tokenLimit);
  const projectedIds = envelope.records.map(projectedDynamicRecordId);
  const selectedIds = envelope.selection.selected.map((entry) => entry.id);
  const counts = [
    envelope.selection.candidateCount,
    envelope.selection.filteredCount,
    envelope.selection.budgetOmissionCount,
  ];
  if (
    dynamic.content.includes("\u0000") ||
    envelope.records.length > MAX_DYNAMIC_GRAPH_RECORDS ||
    bytes > byteLimit ||
    estimatedTokens > tokenLimit ||
    envelope.budget.maxRecords !== MAX_DYNAMIC_GRAPH_RECORDS ||
    envelope.budget.maxBytes !== byteLimit ||
    envelope.budget.maxEstimatedTokens !== tokenLimit ||
    envelope.budget.selectedRecords !== envelope.records.length ||
    envelope.budget.utf8Bytes !== bytes ||
    envelope.budget.estimatedTokens !== estimatedTokens ||
    envelope.selection.selected.length !== envelope.records.length ||
    counts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    envelope.selection.candidateCount !==
      envelope.records.length +
        envelope.selection.filteredCount +
        envelope.selection.budgetOmissionCount ||
    new Set(projectedIds).size !== projectedIds.length ||
    JSON.stringify(selectedIds) !== JSON.stringify(projectedIds) ||
    envelope.selection.selected.some(
      (entry) =>
        Buffer.byteLength(entry.reason, "utf8") === 0 ||
        Buffer.byteLength(entry.reason, "utf8") > 4_096 ||
        entry.reason.includes("\u0000"),
    ) ||
    envelope.records.filter((record) => record.kind === "run_objective").length !== 1 ||
    envelope.records.filter((record) => record.kind === "working_spec").length > 1 ||
    envelope.records.some(
      (record) => !validProjectedDynamicRecord(record, binding.runId, binding.generation),
    )
  ) {
    throw new Error("dynamic graph context exceeds or misstates its centralized envelope budget");
  }
}

function projectedDynamicRecordId(
  record: SelectedDynamicGraphContext["envelope"]["records"][number],
): string {
  return `${record.kind}:${record.id}`;
}

function validProjectedDynamicRecord(
  record: SelectedDynamicGraphContext["envelope"]["records"][number],
  runId: string,
  generation: number,
): boolean {
  if (record.kind === "run_objective") {
    return record.objective.length > 0 && !record.objective.includes("\u0000");
  }
  if (record.kind === "semantic_node") return record.node.id === record.id;
  if (record.kind === "working_spec") {
    return (
      record.value.protocol === "koni.working-spec.v1" &&
      record.value.recordType === "working_spec" &&
      record.value.id === record.id &&
      record.value.runId === runId &&
      record.value.generation === generation
    );
  }
  const value = record.value;
  return (
    value.id === record.id &&
    value.runId === runId &&
    (value.protocol === "koni.graph-note.v1"
      ? value.generation === undefined || value.generation === generation
      : value.recordType === "change_note" && value.generation === generation)
  );
}

export function renderCompactionSummary(
  spec: Readonly<AgentLaunchSpec>,
  snapshot: KoniCompactionSnapshot,
): string {
  validateSnapshot(snapshot);
  const summary = [
    "# Koni attempt checkpoint",
    "",
    `- Run: ${spec.identity.runId}`,
    `- Ticket: ${spec.identity.ticketId}`,
    `- Step: ${spec.identity.stepId}`,
    `- Attempt: ${spec.identity.attemptId}`,
    `- Branch: ${spec.lineage.reason} (epoch ${spec.lineage.branchEpoch})`,
    ...(spec.lineage.parentAttemptId === undefined
      ? []
      : [
          `- Parent attempt/session: ${spec.lineage.parentAttemptId} / ${spec.lineage.parentSessionId}`,
        ]),
    ...(spec.lineage.parentEntryId === undefined
      ? []
      : [`- Parent Pi entry: ${spec.lineage.parentEntryId}`]),
    `- Grant: ${spec.authority.grantHash}`,
    `- Expected state: ${spec.authority.expectedStateHash}`,
    `- Authoritative context: ${spec.authority.authoritativeContextHash} (reissued before the next provider request)`,
    "",
    "## Objective",
    snapshot.objective,
    "",
    ...(snapshot.workingSpec === undefined
      ? []
      : [
          "## Active canonical working specification",
          `- ${snapshot.workingSpec.id} v${snapshot.workingSpec.version} (${snapshot.workingSpec.digest})`,
          snapshot.workingSpec.guidance,
          "",
        ]),
    ...(snapshot.dynamicGraphContext === undefined
      ? []
      : [
          "## Dynamic graph context binding",
          `- Envelope: ${snapshot.dynamicGraphContext.envelopeHash}`,
          `- Semantic: r${snapshot.dynamicGraphContext.semanticRevision} ${snapshot.dynamicGraphContext.semanticHash}`,
          `- Contextual: r${snapshot.dynamicGraphContext.contextualRevision} ${snapshot.dynamicGraphContext.contextualHash}`,
          "",
        ]),
    "## Plan",
    `### Architecture\n${snapshot.plan.architecture}`,
    `### Decisions\n${snapshot.plan.decisions}`,
    `### Risk\n${snapshot.plan.risk}`,
    `### Verification\n${snapshot.plan.verification}`,
    "",
    renderList("Graph nodes and edges touched", snapshot.graphRefs),
    renderList("Files read or modified", snapshot.touchedFiles),
    renderList("Skills already loaded", snapshot.loadedResources ?? []),
    renderLoadedResourceContents(snapshot.loadedResourceContents ?? []),
    renderList("Receipts", snapshot.receiptIds),
    renderList("Checks", snapshot.checkIds),
    renderList("Unresolved questions", snapshot.unresolvedQuestions),
    "## Next required action",
    snapshot.nextAction,
  ].join("\n");
  if (Buffer.byteLength(summary, "utf8") > MAX_COMPACTION_SUMMARY_BYTES) {
    throw new Error(`structured compaction exceeds ${MAX_COMPACTION_SUMMARY_BYTES} UTF-8 bytes`);
  }
  return summary;
}

function denyLinear(
  options: Parameters<typeof createKoniManagedExtension>[0],
  operation: string,
): { cancel: true } {
  emitNotice(options, { type: "linear_navigation_denied", detail: operation });
  return { cancel: true };
}

function emitNotice(
  options: Parameters<typeof createKoniManagedExtension>[0],
  notice: CompactionLifecycleNotice,
): void {
  try {
    options.onNotice?.(notice);
  } catch {
    // Audit/TUI observers never participate in context persistence or compaction control flow.
  }
}

function validateSnapshot(snapshot: KoniCompactionSnapshot): void {
  validateSummaryText(snapshot.objective, "objective");
  validateSummaryText(snapshot.plan.architecture, "plan.architecture");
  validateSummaryText(snapshot.plan.decisions, "plan.decisions");
  validateSummaryText(snapshot.plan.risk, "plan.risk");
  validateSummaryText(snapshot.plan.verification, "plan.verification");
  validateSummaryText(snapshot.nextAction, "nextAction");
  if (snapshot.workingSpec !== undefined) {
    if (
      snapshot.workingSpec.id.length === 0 ||
      !Number.isSafeInteger(snapshot.workingSpec.version) ||
      snapshot.workingSpec.version < 1 ||
      !isSha256Digest(snapshot.workingSpec.digest) ||
      Buffer.byteLength(snapshot.workingSpec.guidance, "utf8") === 0 ||
      Buffer.byteLength(snapshot.workingSpec.guidance, "utf8") > 1024 * 1024 ||
      snapshot.workingSpec.guidance.includes("\u0000")
    )
      throw new Error("workingSpec is malformed or oversized");
  }
  if (snapshot.dynamicGraphContext !== undefined) {
    if (
      !isSha256Digest(snapshot.dynamicGraphContext.envelopeHash) ||
      !isSha256Digest(snapshot.dynamicGraphContext.semanticHash) ||
      !isSha256Digest(snapshot.dynamicGraphContext.contextualHash) ||
      !Number.isSafeInteger(snapshot.dynamicGraphContext.semanticRevision) ||
      !Number.isSafeInteger(snapshot.dynamicGraphContext.contextualRevision) ||
      snapshot.dynamicGraphContext.selectedIds.length > MAX_DYNAMIC_GRAPH_RECORDS
    )
      throw new Error("dynamicGraphContext is malformed");
  }
  for (const [name, values] of Object.entries({
    graphRefs: snapshot.graphRefs,
    touchedFiles: snapshot.touchedFiles,
    loadedResources: snapshot.loadedResources ?? [],
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
  const loadedResourceContents = snapshot.loadedResourceContents ?? [];
  if (loadedResourceContents.length > MAX_SUMMARY_ITEMS) {
    throw new Error("loadedResourceContents exceeds the structured compaction item limit");
  }
  const loadedIdentities = loadedResourceContents.map(
    (resource) => `${resource.relativePath} (${resource.sha256})`,
  );
  if (canonicalEncode(loadedIdentities) !== canonicalEncode(snapshot.loadedResources ?? [])) {
    throw new Error("loaded resource identities and reissued contents do not match");
  }
  for (const resource of loadedResourceContents) {
    validateSummaryText(resource.relativePath, "loadedResourceContents.relativePath");
    if (
      !isSha256Digest(resource.sha256) ||
      Buffer.byteLength(resource.content, "utf8") === 0 ||
      Buffer.byteLength(resource.content, "utf8") > 1024 * 1024 ||
      resource.content.includes("\u0000") ||
      rawSha256(resource.content) !== resource.sha256
    ) {
      throw new Error("loaded resource content is malformed, oversized, or unauthenticated");
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
  return [
    `## ${title}`,
    ...(items.length === 0 ? ["- None"] : items.map((item) => `- ${item}`)),
    "",
  ].join("\n");
}

function renderLoadedResourceContents(
  resources: NonNullable<KoniCompactionSnapshot["loadedResourceContents"]>,
): string {
  if (resources.length === 0) return "";
  return [
    "## Reissued loaded skill resources",
    "These exact immutable bytes were fully read before compaction. Continue to apply them without rereading the resources.",
    "",
    ...resources.flatMap((resource) => [
      `<koni_loaded_skill_resource path="${xmlAttribute(resource.relativePath)}" sha256="${resource.sha256}">`,
      resource.content,
      "</koni_loaded_skill_resource>",
      "",
    ]),
  ].join("\n");
}

function xmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
