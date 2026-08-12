import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import path from "node:path";
import {
  canonicalHash,
  isSha256Digest,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";

export const AGENT_LAUNCH_SPEC_PROTOCOL = "koni.agent-launch-spec.v1" as const;

const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/;
const MAX_ID_BYTES = 256;
const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 4 * 1024 * 1024;
const MAX_RESOURCE_COUNT = 256;
const MIN_TRANSCRIPT_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 512 * 1024 * 1024;
const MIN_TOOL_RESULT_BYTES = 4 * 1024;
const MAX_TOOL_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_LINEAGE_FOREST_NODES = 100_000;

export type LaunchResourceKind = "skill" | "prompt" | "context" | "append_system_prompt";

export interface LaunchResource {
  kind: LaunchResourceKind;
  id: string;
  relativePath: string;
  content: string;
  sha256: Sha256Digest;
  sizeBytes: number;
}

export interface LaunchToolBinding {
  name: string;
  schemaHash: Sha256Digest;
  executionMode: "sequential" | "parallel";
  /** Maximum canonical Pi result payload bytes reserved before this tool may execute. */
  maxResultBytes: number;
}

export type AgentBranchReason =
  "initial" | "retry" | "rework" | "review" | "recovery" | "integration";

export interface AgentAttemptLineage {
  branchEpoch: number;
  reason: AgentBranchReason;
  parentAttemptId?: string;
  parentSessionId?: string;
  parentEntryId?: string;
  /**
   * Authorizes a new immutable Pi session to inherit the exact active conversation prefix from
   * its same-scope parent. The child still receives a new grant, ledger, resources, and terminal
   * contract; only the hash-bound conversational context is forked.
   */
  conversationFork?: {
    parentLaunchSpecHash: Sha256Digest;
    parentTranscriptSha256: Sha256Digest;
  };
}

/**
 * Minimal durable identity needed to authenticate relationships between separately persisted Pi
 * sessions. Each node is still one immutable, linear autonomous attempt. A same-scope
 * retry/rework/recovery edge may explicitly authorize a hash-bound Pi conversation fork without
 * reusing the parent session identity or authority ledger.
 */
export interface AgentAttemptLineageBinding {
  runId: string;
  ticketId: string;
  stepId: string;
  attemptId: string;
  sessionId: string;
  /**
   * Authenticated terminal leaf of this attempt's immutable Pi session. Required only when a
   * descendant names `parentEntryId`; omission is valid for lineage that binds parent identity but
   * deliberately has no transcript-entry anchor.
   */
  sessionLeafEntryId?: string;
  launchSpecHash?: Sha256Digest;
  sessionSnapshotSha256?: Sha256Digest;
  lineage: AgentAttemptLineage;
}

export interface AgentLaunchSpec {
  protocol: typeof AGENT_LAUNCH_SPEC_PROTOCOL;
  specHash: Sha256Digest;
  issuedAt: string;
  identity: {
    runId: string;
    ticketId: string;
    stepId: string;
    attemptId: string;
    sessionId: string;
  };
  lineage: AgentAttemptLineage;
  /** Immutable revision epoch inside one stable continuous planning attempt and Pi session. */
  planningRevision?: PlanningRevisionLaunchBinding;
  authority: {
    grantId: string;
    grantHash: Sha256Digest;
    generation: number;
    epoch: number;
    expectedRevision: number;
    expectedStateHash: Sha256Digest;
    authoritativeContextHash: Sha256Digest;
  };
  workspace: {
    cwd: string;
    sessionDirectory: string;
  };
  persona: {
    id: string;
    systemPrompt: string;
    systemPromptHash: Sha256Digest;
    initialPrompt: string;
    initialPromptHash: Sha256Digest;
  };
  model: {
    provider: string;
    id: string;
    /** Exact Pi transport adapter selected from the compiler's offline catalog. */
    api: string;
    /** Authenticated total context capacity. Optional only for already-issued v1 launches. */
    catalogContextWindow?: number;
    /** Full output exposure advertised by that authenticated catalog entry. */
    catalogMaxTokens: number;
    /** Secret-free canonical transport descriptor digest; headers/credentials are never persisted. */
    catalogSha256: Sha256Digest;
    thinkingLevel: ThinkingLevel;
  };
  tools: readonly LaunchToolBinding[];
  resources: {
    setHash: Sha256Digest;
    entries: readonly LaunchResource[];
  };
  budgets: {
    tokens: {
      maxInput: number;
      maxOutput: number;
      maxCacheRead: number;
      maxCacheWrite: number;
      maxNew: number;
      maxAll: number;
      /** One in-flight provider-generation exposure beyond desired settled-usage targets. */
      providerOutputHeadroom: number;
    };
    retries: {
      /** Provider adapters are single-transport; semantic retries require a fresh authority attempt. */
      maxProviderRetries: number;
      baseDelayMs: number;
    };
    transcript: {
      maxBytes: number;
    };
    /**
     * Durable authority-side ceiling for repository discovery calls. Optional only
     * so launch specifications issued before this budget existed remain resumable.
     */
    repositoryCalls?: {
      max: number;
    };
  };
  terminal: {
    toolName: string;
    outputSchemaHash: Sha256Digest;
    maxOutputBytes: number;
  };
}

export interface PlanningRevisionLaunchBinding {
  revision: number;
  baseRevision: number | null;
  priorCheckpointSha256: Sha256Digest | null;
  steeringSha256: Sha256Digest | null;
  budgetBaseline: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}

export type AgentLaunchSpecDraft = Omit<AgentLaunchSpec, "specHash">;

export class AgentLaunchSpecError extends Error {
  public readonly code: string;
  public readonly path: string;

  public constructor(code: string, path: string, message: string) {
    super(message);
    this.name = "AgentLaunchSpecError";
    this.code = code;
    this.path = path;
  }
}

/** Validate, clone, hash, and deeply freeze one compiler-issued attempt boundary. */
export function createAgentLaunchSpec(draft: AgentLaunchSpecDraft): Readonly<AgentLaunchSpec> {
  validateDraft(draft);
  const cloned = structuredClone(draft);
  const spec: AgentLaunchSpec = {
    ...cloned,
    specHash: canonicalHash(cloned),
  };
  return deepFreeze(spec);
}

/** Revalidate a deserialized launch specification and reject any hash drift. */
export function validateAgentLaunchSpec(value: AgentLaunchSpec): Readonly<AgentLaunchSpec> {
  if (value.protocol !== AGENT_LAUNCH_SPEC_PROTOCOL) {
    fail("protocol", "/protocol", "unsupported agent launch specification protocol");
  }
  if (!isSha256Digest(value.specHash)) {
    fail("digest", "/specHash", "specHash must be a lowercase sha256 digest");
  }
  const { specHash, ...draft } = structuredClone(value);
  validateDraft(draft);
  if (canonicalHash(draft) !== specHash) {
    fail("spec_hash", "/specHash", "agent launch specification contents do not match specHash");
  }
  return deepFreeze({ ...draft, specHash });
}

export function computeLaunchResourceSetHash(entries: readonly LaunchResource[]): Sha256Digest {
  return canonicalHash(
    entries.map(({ kind, id, relativePath, sha256, sizeBytes }) => ({
      kind,
      id,
      relativePath,
      sha256,
      sizeBytes,
    })),
  );
}

/**
 * Validate the cross-attempt lineage forest that per-launch validation cannot see by itself.
 *
 * The caller may supply multiple runs; attempt and session identities are unique within each run.
 * A parent must be in the same run, name the parent's exact session, and advance the epoch by one.
 * This authenticates Koni's retry/rework/review/recovery/integration topology. Only an explicit
 * same-scope `conversationFork` may populate Pi's path-valued `parentSession` header; mutable
 * in-session navigation remains unavailable to contained attempts.
 */
export function validateAgentAttemptLineageForest(
  values: readonly AgentAttemptLineageBinding[],
): void {
  if (!Array.isArray(values) || values.length > MAX_LINEAGE_FOREST_NODES) {
    fail(
      "lineage_forest_size",
      "/attempts",
      `attempt lineage forest must contain at most ${MAX_LINEAGE_FOREST_NODES} nodes`,
    );
  }
  const nodes = new Map<string, AgentAttemptLineageBinding>();
  const sessions = new Set<string>();
  for (const [index, value] of values.entries()) {
    const base = `/attempts/${index}`;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail("lineage_forest_node", base, "attempt lineage binding must be an object");
    }
    validateId(value.runId, `${base}/runId`);
    validateId(value.ticketId, `${base}/ticketId`);
    validateId(value.stepId, `${base}/stepId`);
    validateId(value.attemptId, `${base}/attemptId`);
    validateSessionId(value.sessionId, `${base}/sessionId`);
    if (value.sessionLeafEntryId !== undefined) {
      validateSessionEntryId(value.sessionLeafEntryId, `${base}/sessionLeafEntryId`);
    }
    if (value.launchSpecHash !== undefined && !isSha256Digest(value.launchSpecHash)) {
      fail("lineage_parent_spec", `${base}/launchSpecHash`, "attempt launch-spec hash is invalid");
    }
    if (value.sessionSnapshotSha256 !== undefined && !isSha256Digest(value.sessionSnapshotSha256)) {
      fail(
        "lineage_parent_transcript",
        `${base}/sessionSnapshotSha256`,
        "attempt transcript hash is invalid",
      );
    }
    validateLineageIdentity(
      { attemptId: value.attemptId, sessionId: value.sessionId },
      value.lineage,
      `${base}/lineage`,
    );
    const attemptKey = lineageKey(value.runId, value.attemptId);
    if (nodes.has(attemptKey)) {
      fail(
        "lineage_duplicate_attempt",
        `${base}/attemptId`,
        "attempt identity is duplicated within its run",
      );
    }
    const sessionKey = lineageKey(value.runId, value.sessionId);
    if (sessions.has(sessionKey)) {
      fail(
        "lineage_duplicate_session",
        `${base}/sessionId`,
        "Pi session identity is reused within its run",
      );
    }
    nodes.set(attemptKey, value);
    sessions.add(sessionKey);
  }

  for (const [index, value] of values.entries()) {
    const parentAttemptId = value.lineage.parentAttemptId;
    if (parentAttemptId === undefined) continue;
    const base = `/attempts/${index}/lineage`;
    const parent = nodes.get(lineageKey(value.runId, parentAttemptId));
    if (parent === undefined) {
      fail(
        "lineage_parent_missing",
        `${base}/parentAttemptId`,
        "lineage parent does not exist in the same run",
      );
    }
    if (parent.sessionId !== value.lineage.parentSessionId) {
      fail(
        "lineage_parent_session",
        `${base}/parentSessionId`,
        "lineage parent session does not match its attempt",
      );
    }
    if (value.lineage.reason === "review" && value.ticketId !== parent.ticketId) {
      fail(
        "lineage_parent_scope",
        base,
        "review lineage must remain inside the ticket whose work it reviews",
      );
    }
    if (
      ["retry", "rework", "recovery"].includes(value.lineage.reason) &&
      (value.ticketId !== parent.ticketId || value.stepId !== parent.stepId)
    ) {
      fail(
        "lineage_parent_scope",
        base,
        `${value.lineage.reason} lineage must preserve its parent ticket and step scope`,
      );
    }
    if (value.lineage.parentEntryId !== undefined) {
      if (parent.sessionLeafEntryId === undefined) {
        fail(
          "lineage_parent_entry_unverified",
          `${base}/parentEntryId`,
          "lineage parent entry cannot be authenticated without its parent session leaf",
        );
      }
      if (parent.sessionLeafEntryId !== value.lineage.parentEntryId) {
        fail(
          "lineage_parent_entry",
          `${base}/parentEntryId`,
          "lineage parent entry is not the authenticated terminal leaf of its parent session",
        );
      }
    }
    if (value.lineage.conversationFork !== undefined) {
      if (parent.launchSpecHash !== value.lineage.conversationFork.parentLaunchSpecHash) {
        fail(
          "lineage_parent_spec",
          `${base}/conversationFork/parentLaunchSpecHash`,
          "conversation fork does not name the authenticated parent launch spec",
        );
      }
      if (parent.sessionSnapshotSha256 !== value.lineage.conversationFork.parentTranscriptSha256) {
        fail(
          "lineage_parent_transcript",
          `${base}/conversationFork/parentTranscriptSha256`,
          "conversation fork does not name the authenticated parent transcript snapshot",
        );
      }
    }
  }

  // Epoch sequencing already makes a cycle impossible, but retain an explicit traversal so a
  // future relaxation cannot silently turn this authority check into a merely local invariant.
  const settled = new Set<string>();
  for (const value of values) {
    const path = new Set<string>();
    let current: AgentAttemptLineageBinding | undefined = value;
    while (current !== undefined) {
      const key = lineageKey(current.runId, current.attemptId);
      if (settled.has(key)) break;
      if (path.has(key)) {
        fail(
          "lineage_cycle",
          "/attempts",
          `attempt lineage contains a cycle at ${current.attemptId}`,
        );
      }
      path.add(key);
      const parentId = current.lineage.parentAttemptId;
      current = parentId === undefined ? undefined : nodes.get(lineageKey(current.runId, parentId));
    }
    for (const key of path) settled.add(key);
  }
  for (const [index, value] of values.entries()) {
    const parentAttemptId = value.lineage.parentAttemptId;
    if (parentAttemptId === undefined) continue;
    const parent = nodes.get(lineageKey(value.runId, parentAttemptId))!;
    if (value.lineage.branchEpoch !== parent.lineage.branchEpoch + 1) {
      fail(
        "lineage_epoch_sequence",
        `/attempts/${index}/lineage/branchEpoch`,
        "lineage epoch must be exactly one greater than its parent",
      );
    }
  }
}

function lineageKey(runId: string, identity: string): string {
  return `${runId}\u0000${identity}`;
}

function validateDraft(draft: AgentLaunchSpecDraft): void {
  if (draft.protocol !== AGENT_LAUNCH_SPEC_PROTOCOL) {
    fail("protocol", "/protocol", "unsupported agent launch specification protocol");
  }
  if (!isIsoTimestamp(draft.issuedAt)) {
    fail("timestamp", "/issuedAt", "issuedAt must be an ISO-8601 timestamp");
  }
  validateId(draft.identity.runId, "/identity/runId");
  validateId(draft.identity.ticketId, "/identity/ticketId");
  validateId(draft.identity.stepId, "/identity/stepId");
  validateId(draft.identity.attemptId, "/identity/attemptId");
  validateSessionId(draft.identity.sessionId, "/identity/sessionId");
  validateLineage(draft);
  validatePlanningRevision(draft);
  validateId(draft.authority.grantId, "/authority/grantId");
  validateDigest(draft.authority.grantHash, "/authority/grantHash");
  validatePositiveInt(draft.authority.generation, "/authority/generation", true);
  validatePositiveInt(draft.authority.epoch, "/authority/epoch", true);
  validatePositiveInt(draft.authority.expectedRevision, "/authority/expectedRevision", true);
  validateDigest(draft.authority.expectedStateHash, "/authority/expectedStateHash");
  validateDigest(draft.authority.authoritativeContextHash, "/authority/authoritativeContextHash");
  validateAbsolutePath(draft.workspace.cwd, "/workspace/cwd");
  validateAbsolutePath(draft.workspace.sessionDirectory, "/workspace/sessionDirectory");
  validateId(draft.persona.id, "/persona/id");
  validateBoundedText(draft.persona.systemPrompt, "/persona/systemPrompt", MAX_PROMPT_BYTES);
  validateDigest(draft.persona.systemPromptHash, "/persona/systemPromptHash");
  if (rawSha256(draft.persona.systemPrompt) !== draft.persona.systemPromptHash) {
    fail("content_hash", "/persona/systemPromptHash", "system prompt does not match its hash");
  }
  validateBoundedText(draft.persona.initialPrompt, "/persona/initialPrompt", MAX_PROMPT_BYTES);
  validateDigest(draft.persona.initialPromptHash, "/persona/initialPromptHash");
  if (rawSha256(draft.persona.initialPrompt) !== draft.persona.initialPromptHash) {
    fail("content_hash", "/persona/initialPromptHash", "initial prompt does not match its hash");
  }
  validateId(draft.model.provider, "/model/provider");
  validateModelId(draft.model.id, "/model/id");
  validateModelId(draft.model.api, "/model/api");
  if (draft.model.catalogContextWindow !== undefined) {
    validatePositiveInt(draft.model.catalogContextWindow, "/model/catalogContextWindow", false);
    if (draft.model.catalogContextWindow < draft.model.catalogMaxTokens) {
      fail(
        "token_budget",
        "/model/catalogContextWindow",
        "model context window cannot be smaller than its maximum output",
      );
    }
  }
  validatePositiveInt(draft.model.catalogMaxTokens, "/model/catalogMaxTokens", false);
  validateDigest(draft.model.catalogSha256, "/model/catalogSha256");
  if (!isThinkingLevel(draft.model.thinkingLevel)) {
    fail("thinking_level", "/model/thinkingLevel", "unsupported Pi thinking level");
  }
  if (draft.tools.length === 0) {
    fail(
      "tool_count",
      "/tools",
      "an autonomous attempt requires at least one authority-backed tool",
    );
  }
  const toolNames = new Set<string>();
  for (const [index, tool] of draft.tools.entries()) {
    validateId(tool.name, `/tools/${index}/name`);
    validateDigest(tool.schemaHash, `/tools/${index}/schemaHash`);
    if (tool.executionMode !== "sequential" && tool.executionMode !== "parallel") {
      fail("execution_mode", `/tools/${index}/executionMode`, "invalid tool execution mode");
    }
    validatePositiveInt(tool.maxResultBytes, `/tools/${index}/maxResultBytes`, false);
    if (
      tool.maxResultBytes < MIN_TOOL_RESULT_BYTES ||
      tool.maxResultBytes > MAX_TOOL_RESULT_BYTES
    ) {
      fail(
        "tool_result_budget",
        `/tools/${index}/maxResultBytes`,
        `tool result budget must be between ${MIN_TOOL_RESULT_BYTES} and ${MAX_TOOL_RESULT_BYTES} bytes`,
      );
    }
    if (toolNames.has(tool.name)) {
      fail("duplicate_tool", `/tools/${index}/name`, `duplicate tool ${tool.name}`);
    }
    toolNames.add(tool.name);
  }
  validateResources(draft.resources.entries);
  if (computeLaunchResourceSetHash(draft.resources.entries) !== draft.resources.setHash) {
    fail("resource_set_hash", "/resources/setHash", "resource inventory does not match setHash");
  }
  validateTokenBudgets(draft.budgets.tokens);
  if (draft.budgets.tokens.providerOutputHeadroom > draft.model.catalogMaxTokens) {
    fail(
      "token_budget",
      "/budgets/tokens/providerOutputHeadroom",
      "provider output headroom cannot exceed the authenticated catalog maximum",
    );
  }
  if (
    draft.model.api === "openai-codex-responses" &&
    draft.budgets.tokens.providerOutputHeadroom !== draft.model.catalogMaxTokens
  ) {
    fail(
      "token_budget",
      "/budgets/tokens/providerOutputHeadroom",
      "OpenAI Codex requires reservation of the full uncapped catalog output exposure",
    );
  }
  validatePositiveInt(
    draft.budgets.retries.maxProviderRetries,
    "/budgets/retries/maxProviderRetries",
    true,
  );
  if (draft.budgets.retries.maxProviderRetries !== 0) {
    fail(
      "provider_retry_policy",
      "/budgets/retries/maxProviderRetries",
      "contained provider retries must be zero so one reservation authorizes exactly one transport",
    );
  }
  validatePositiveInt(draft.budgets.retries.baseDelayMs, "/budgets/retries/baseDelayMs", true);
  validatePositiveInt(draft.budgets.transcript.maxBytes, "/budgets/transcript/maxBytes", false);
  if (
    draft.budgets.transcript.maxBytes < MIN_TRANSCRIPT_BYTES ||
    draft.budgets.transcript.maxBytes > MAX_TRANSCRIPT_BYTES
  ) {
    fail(
      "transcript_budget",
      "/budgets/transcript/maxBytes",
      `transcript budget must be between ${MIN_TRANSCRIPT_BYTES} and ${MAX_TRANSCRIPT_BYTES} bytes`,
    );
  }
  if (draft.budgets.repositoryCalls !== undefined) {
    validatePositiveInt(draft.budgets.repositoryCalls.max, "/budgets/repositoryCalls/max", false);
  }
  validateId(draft.terminal.toolName, "/terminal/toolName");
  if (!toolNames.has(draft.terminal.toolName)) {
    fail(
      "terminal_tool",
      "/terminal/toolName",
      "terminal tool is not present in the exact tool inventory",
    );
  }
  if (
    draft.tools.find((tool) => tool.name === draft.terminal.toolName)?.executionMode !==
    "sequential"
  ) {
    fail("terminal_tool", "/terminal/toolName", "terminal tool must execute sequentially");
  }
  validateDigest(draft.terminal.outputSchemaHash, "/terminal/outputSchemaHash");
  validatePositiveInt(draft.terminal.maxOutputBytes, "/terminal/maxOutputBytes", false);
  if (draft.terminal.maxOutputBytes > MAX_RESOURCE_BYTES) {
    fail("terminal_size", "/terminal/maxOutputBytes", "terminal output bound exceeds 4 MiB");
  }
}

function validatePlanningRevision(draft: AgentLaunchSpecDraft): void {
  const revision = draft.planningRevision;
  if (revision === undefined) return;
  const pointer = "/planningRevision";
  if (
    revision === null ||
    typeof revision !== "object" ||
    Array.isArray(revision) ||
    draft.identity.ticketId !== "run-planning" ||
    draft.lineage.branchEpoch !== 0 ||
    draft.lineage.reason !== "initial" ||
    draft.lineage.parentAttemptId !== undefined ||
    draft.lineage.parentSessionId !== undefined ||
    draft.lineage.parentEntryId !== undefined ||
    draft.lineage.conversationFork !== undefined
  ) {
    fail(
      "planning_revision",
      pointer,
      "planning revisions require one root planning attempt and cannot use conversation lineage",
    );
  }
  if (!Number.isSafeInteger(revision.revision) || revision.revision < 0) {
    fail("planning_revision", `${pointer}/revision`, "planning revision must be non-negative");
  }
  const initial = revision.revision === 0;
  if (
    (initial && revision.baseRevision !== null) ||
    (!initial && revision.baseRevision !== revision.revision - 1)
  ) {
    fail(
      "planning_revision",
      `${pointer}/baseRevision`,
      "planning revision must name its exact contiguous base revision",
    );
  }
  if (
    (initial && revision.priorCheckpointSha256 !== null) ||
    (!initial && !isSha256Digest(revision.priorCheckpointSha256))
  ) {
    fail(
      "planning_revision",
      `${pointer}/priorCheckpointSha256`,
      "later planning revisions require the prior checkpoint digest",
    );
  }
  if (
    (initial && revision.steeringSha256 !== null) ||
    (!initial && !isSha256Digest(revision.steeringSha256))
  ) {
    fail(
      "planning_revision",
      `${pointer}/steeringSha256`,
      "later planning revisions require the operator steering digest",
    );
  }
  const baseline = revision.budgetBaseline;
  if (baseline === null || typeof baseline !== "object" || Array.isArray(baseline)) {
    fail("planning_revision", `${pointer}/budgetBaseline`, "planning token baseline is invalid");
  }
  for (const field of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const) {
    validatePositiveInt(baseline[field], `${pointer}/budgetBaseline/${field}`, true);
    if (initial && baseline[field] !== 0) {
      fail(
        "planning_revision",
        `${pointer}/budgetBaseline/${field}`,
        "initial planning revision must begin from a zero provider baseline",
      );
    }
  }
}

function validateResources(entries: readonly LaunchResource[]): void {
  if (entries.length > MAX_RESOURCE_COUNT) {
    fail(
      "resource_count",
      "/resources/entries",
      `resource inventory exceeds ${MAX_RESOURCE_COUNT} entries`,
    );
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const [index, resource] of entries.entries()) {
    const base = `/resources/entries/${index}`;
    if (!["skill", "prompt", "context", "append_system_prompt"].includes(resource.kind)) {
      fail("resource_kind", `${base}/kind`, "unsupported compiler-issued resource kind");
    }
    validateId(resource.id, `${base}/id`);
    validateRelativePath(resource.relativePath, `${base}/relativePath`);
    validateBoundedText(resource.content, `${base}/content`, MAX_RESOURCE_BYTES);
    validateDigest(resource.sha256, `${base}/sha256`);
    const bytes = Buffer.byteLength(resource.content, "utf8");
    if (resource.sizeBytes !== bytes || rawSha256(resource.content) !== resource.sha256) {
      fail("content_hash", base, "resource bytes do not match the declared size and hash");
    }
    if (ids.has(resource.id)) {
      fail("duplicate_resource", `${base}/id`, `duplicate resource id ${resource.id}`);
    }
    if (paths.has(resource.relativePath)) {
      fail(
        "duplicate_resource_path",
        `${base}/relativePath`,
        `duplicate resource path ${resource.relativePath}`,
      );
    }
    ids.add(resource.id);
    paths.add(resource.relativePath);
    totalBytes += bytes;
  }
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_RESOURCE_BYTES) {
    fail("resource_bytes", "/resources/entries", "combined compiler-issued resources exceed 4 MiB");
  }
}

function validateTokenBudgets(tokens: AgentLaunchSpec["budgets"]["tokens"]): void {
  for (const [name, value] of Object.entries(tokens)) {
    validatePositiveInt(value, `/budgets/tokens/${name}`, false);
  }
  if (
    tokens.maxNew > tokens.maxAll ||
    tokens.maxInput > tokens.maxNew ||
    tokens.maxOutput > tokens.maxNew
  ) {
    fail(
      "token_budget",
      "/budgets/tokens",
      "component token budgets must fit within aggregate budgets",
    );
  }
  if (tokens.maxCacheRead > tokens.maxAll || tokens.maxCacheWrite > tokens.maxAll) {
    fail("token_budget", "/budgets/tokens", "cache token budgets must fit within maxAll");
  }
  if (
    safeIntegerSum(tokens.maxOutput, tokens.providerOutputHeadroom) === undefined ||
    safeIntegerSum(tokens.maxNew, tokens.providerOutputHeadroom) === undefined ||
    safeIntegerSum(tokens.maxAll, tokens.providerOutputHeadroom) === undefined
  ) {
    fail(
      "token_budget",
      "/budgets/tokens/providerOutputHeadroom",
      "provider headroom would overflow a token ceiling",
    );
  }
}

function safeIntegerSum(left: number, right: number): number | undefined {
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : undefined;
}

function validateId(value: string, pointer: string): void {
  if (!SAFE_ID.test(value) || Buffer.byteLength(value, "utf8") > MAX_ID_BYTES) {
    fail("id", pointer, "identifier contains unsupported characters or is too long");
  }
}

function validateSessionId(value: string, pointer: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value) || value.length > MAX_ID_BYTES) {
    fail("session_id", pointer, "session id is not valid for Pi SessionManager");
  }
}

function validateLineage(draft: AgentLaunchSpecDraft): void {
  validateLineageIdentity(draft.identity, draft.lineage, "/lineage");
}

function validateLineageIdentity(
  identity: Pick<AgentLaunchSpec["identity"], "attemptId" | "sessionId">,
  lineage: AgentAttemptLineage,
  pointer: string,
): void {
  if (lineage === null || typeof lineage !== "object" || Array.isArray(lineage)) {
    fail("lineage", pointer, "attempt lineage must be an object");
  }
  if (!Number.isSafeInteger(lineage.branchEpoch) || lineage.branchEpoch < 0) {
    fail(
      "lineage_epoch",
      `${pointer}/branchEpoch`,
      "branch epoch must be a non-negative safe integer",
    );
  }
  if (
    !["initial", "retry", "rework", "review", "recovery", "integration"].includes(lineage.reason)
  ) {
    fail("lineage_reason", `${pointer}/reason`, "branch reason is unsupported");
  }
  const hasParentAttempt = lineage.parentAttemptId !== undefined;
  const hasParentSession = lineage.parentSessionId !== undefined;
  if (hasParentAttempt !== hasParentSession) {
    fail(
      "lineage_parent",
      pointer,
      "parent attempt and parent session identities must be supplied together",
    );
  }
  if (lineage.parentAttemptId !== undefined) {
    validateId(lineage.parentAttemptId, `${pointer}/parentAttemptId`);
    validateSessionId(lineage.parentSessionId!, `${pointer}/parentSessionId`);
    if (
      lineage.parentAttemptId === identity.attemptId ||
      lineage.parentSessionId === identity.sessionId
    ) {
      fail("lineage_cycle", pointer, "an attempt cannot be its own lineage parent");
    }
  }
  if (lineage.parentEntryId !== undefined) {
    if (!hasParentAttempt) {
      fail(
        "lineage_entry",
        `${pointer}/parentEntryId`,
        "parent entry requires a parent attempt and session",
      );
    }
    validateSessionEntryId(lineage.parentEntryId, `${pointer}/parentEntryId`);
  }
  if (lineage.conversationFork !== undefined) {
    if (
      lineage.parentEntryId === undefined ||
      !["retry", "rework", "recovery"].includes(lineage.reason) ||
      !isSha256Digest(lineage.conversationFork.parentLaunchSpecHash) ||
      !isSha256Digest(lineage.conversationFork.parentTranscriptSha256)
    ) {
      fail(
        "lineage_conversation_fork",
        `${pointer}/conversationFork`,
        "conversation forks require an authenticated parent leaf and a same-scope retry/rework/recovery edge",
      );
    }
  }
  if (lineage.reason === "initial") {
    if (hasParentAttempt || lineage.branchEpoch !== 0) {
      fail("lineage_initial", pointer, "initial attempts must be root epoch zero");
    }
  } else if (lineage.reason === "recovery" && !hasParentAttempt) {
    // A migrated run deliberately starts a new authenticated Pi lineage: retained Rust transport
    // logs are evidence, not a Pi SessionManager parent that could safely be resumed or branched.
    if (lineage.branchEpoch !== 0) {
      fail("lineage_recovery", pointer, "root recovery attempts must use epoch zero");
    }
  } else if (!hasParentAttempt || lineage.branchEpoch === 0) {
    fail("lineage_parent", pointer, "branched attempts require a parent and positive branch epoch");
  }
}

function validateSessionEntryId(value: string, pointer: string): void {
  if (
    Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(
      "lineage_entry",
      pointer,
      "parent entry identity is empty, oversized, or contains control characters",
    );
  }
}

function validateDigest(value: string, pointer: string): asserts value is Sha256Digest {
  if (!isSha256Digest(value)) {
    fail("digest", pointer, "value must be a lowercase sha256 digest");
  }
}

function validatePositiveInt(value: number, pointer: string, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    fail(
      "integer",
      pointer,
      allowZero
        ? "value must be a non-negative safe integer"
        : "value must be a positive safe integer",
    );
  }
}

function validateBoundedText(value: string, pointer: string, maximum: number): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes === 0 || bytes > maximum || value.includes("\u0000")) {
    fail("text", pointer, `text must contain between 1 and ${maximum} UTF-8 bytes and no NUL`);
  }
}

function validateAbsolutePath(value: string, pointer: string): void {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || value.includes("\u0000")) {
    fail("absolute_path", pointer, "path must be normalized, absolute, and NUL-free");
  }
}

function validateModelId(value: string, pointer: string): void {
  if (
    Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail("model_id", pointer, "model id is empty, too long, or contains control characters");
  }
}

function validateRelativePath(value: string, pointer: string): void {
  const segments = value.split("/");
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail("relative_path", pointer, "resource path must be a normalized safe relative path");
  }
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value));
}

function isIsoTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function fail(code: string, pointer: string, message: string): never {
  throw new AgentLaunchSpecError(code, pointer, message);
}
