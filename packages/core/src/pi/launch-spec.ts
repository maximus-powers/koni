import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import path from "node:path";
import { canonicalHash, isSha256Digest, rawSha256, type Sha256Digest } from "../shared/canonical.js";

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
  | "initial"
  | "retry"
  | "rework"
  | "review"
  | "recovery"
  | "integration";

export interface AgentAttemptLineage {
  branchEpoch: number;
  reason: AgentBranchReason;
  parentAttemptId?: string;
  parentSessionId?: string;
  parentEntryId?: string;
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
    };
    retries: {
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
  return canonicalHash(entries.map(({ kind, id, relativePath, sha256, sizeBytes }) => ({
    kind,
    id,
    relativePath,
    sha256,
    sizeBytes,
  })));
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
  if (!isThinkingLevel(draft.model.thinkingLevel)) {
    fail("thinking_level", "/model/thinkingLevel", "unsupported Pi thinking level");
  }
  if (draft.tools.length === 0) {
    fail("tool_count", "/tools", "an autonomous attempt requires at least one authority-backed tool");
  }
  const toolNames = new Set<string>();
  for (const [index, tool] of draft.tools.entries()) {
    validateId(tool.name, `/tools/${index}/name`);
    validateDigest(tool.schemaHash, `/tools/${index}/schemaHash`);
    if (tool.executionMode !== "sequential" && tool.executionMode !== "parallel") {
      fail("execution_mode", `/tools/${index}/executionMode`, "invalid tool execution mode");
    }
    validatePositiveInt(tool.maxResultBytes, `/tools/${index}/maxResultBytes`, false);
    if (tool.maxResultBytes < MIN_TOOL_RESULT_BYTES || tool.maxResultBytes > MAX_TOOL_RESULT_BYTES) {
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
  validatePositiveInt(draft.budgets.retries.maxProviderRetries, "/budgets/retries/maxProviderRetries", true);
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
    fail("terminal_tool", "/terminal/toolName", "terminal tool is not present in the exact tool inventory");
  }
  if (draft.tools.find((tool) => tool.name === draft.terminal.toolName)?.executionMode !== "sequential") {
    fail("terminal_tool", "/terminal/toolName", "terminal tool must execute sequentially");
  }
  validateDigest(draft.terminal.outputSchemaHash, "/terminal/outputSchemaHash");
  validatePositiveInt(draft.terminal.maxOutputBytes, "/terminal/maxOutputBytes", false);
  if (draft.terminal.maxOutputBytes > MAX_RESOURCE_BYTES) {
    fail("terminal_size", "/terminal/maxOutputBytes", "terminal output bound exceeds 4 MiB");
  }
}

function validateResources(entries: readonly LaunchResource[]): void {
  if (entries.length > MAX_RESOURCE_COUNT) {
    fail("resource_count", "/resources/entries", `resource inventory exceeds ${MAX_RESOURCE_COUNT} entries`);
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
      fail("duplicate_resource_path", `${base}/relativePath`, `duplicate resource path ${resource.relativePath}`);
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
  if (tokens.maxNew > tokens.maxAll || tokens.maxInput > tokens.maxNew || tokens.maxOutput > tokens.maxNew) {
    fail("token_budget", "/budgets/tokens", "component token budgets must fit within aggregate budgets");
  }
  if (tokens.maxCacheRead > tokens.maxAll || tokens.maxCacheWrite > tokens.maxAll) {
    fail("token_budget", "/budgets/tokens", "cache token budgets must fit within maxAll");
  }
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
  const lineage = draft.lineage;
  if (lineage === null || typeof lineage !== "object" || Array.isArray(lineage)) {
    fail("lineage", "/lineage", "attempt lineage must be an object");
  }
  if (!Number.isSafeInteger(lineage.branchEpoch) || lineage.branchEpoch < 0) {
    fail("lineage_epoch", "/lineage/branchEpoch", "branch epoch must be a non-negative safe integer");
  }
  if (!["initial", "retry", "rework", "review", "recovery", "integration"].includes(lineage.reason)) {
    fail("lineage_reason", "/lineage/reason", "branch reason is unsupported");
  }
  const hasParentAttempt = lineage.parentAttemptId !== undefined;
  const hasParentSession = lineage.parentSessionId !== undefined;
  if (hasParentAttempt !== hasParentSession) {
    fail(
      "lineage_parent",
      "/lineage",
      "parent attempt and parent session identities must be supplied together",
    );
  }
  if (lineage.parentAttemptId !== undefined) {
    validateId(lineage.parentAttemptId, "/lineage/parentAttemptId");
    validateSessionId(lineage.parentSessionId!, "/lineage/parentSessionId");
    if (
      lineage.parentAttemptId === draft.identity.attemptId ||
      lineage.parentSessionId === draft.identity.sessionId
    ) {
      fail("lineage_cycle", "/lineage", "an attempt cannot be its own lineage parent");
    }
  }
  if (lineage.parentEntryId !== undefined) {
    if (!hasParentAttempt) {
      fail("lineage_entry", "/lineage/parentEntryId", "parent entry requires a parent attempt and session");
    }
    validateSessionEntryId(lineage.parentEntryId, "/lineage/parentEntryId");
  }
  if (lineage.reason === "initial") {
    if (hasParentAttempt || lineage.branchEpoch !== 0) {
      fail("lineage_initial", "/lineage", "initial attempts must be root epoch zero");
    }
  } else if (lineage.reason === "recovery" && !hasParentAttempt) {
    // A migrated run deliberately starts a new authenticated Pi lineage: retained Rust transport
    // logs are evidence, not a Pi SessionManager parent that could safely be resumed or branched.
    if (lineage.branchEpoch !== 0) {
      fail("lineage_recovery", "/lineage", "root recovery attempts must use epoch zero");
    }
  } else if (!hasParentAttempt || lineage.branchEpoch === 0) {
    fail("lineage_parent", "/lineage", "branched attempts require a parent and positive branch epoch");
  }
}

function validateSessionEntryId(value: string, pointer: string): void {
  if (
    Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("lineage_entry", pointer, "parent entry identity is empty, oversized, or contains control characters");
  }
}

function validateDigest(value: string, pointer: string): asserts value is Sha256Digest {
  if (!isSha256Digest(value)) {
    fail("digest", pointer, "value must be a lowercase sha256 digest");
  }
}

function validatePositiveInt(value: number, pointer: string, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    fail("integer", pointer, allowZero ? "value must be a non-negative safe integer" : "value must be a positive safe integer");
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
