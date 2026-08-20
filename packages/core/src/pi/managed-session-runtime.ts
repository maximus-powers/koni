import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { canonicalHash, type Sha256Digest } from "../shared/canonical.js";
import { type KoniAttemptUsage, type KoniContextProvider } from "./compaction.js";
import type { AgentLaunchSpec } from "./launch-spec.js";
import type { PiSessionEntry } from "./session-transcript.js";
import {
  koniToolResultPayloadBytes,
  renderKoniToolReceipt,
  validateKoniToolReceipt,
  type KoniRuntimeToolRejection,
  type KoniToolReceipt,
} from "./tool-catalog.js";
import {
  ManagedSessionError,
  type AuthorityBackedTool,
  type ManagedTokenUsage,
} from "./managed-session-contracts.js";

const TRANSCRIPT_TOOL_RESULT_OVERHEAD_BYTES = 4 * 1024;
const RUNTIME_REJECTION_RESULT_BYTES = 64 * 1024;
const PROVIDER_INPUT_PRESSURE_MARKER =
  "Koni provider admission rejected: request exceeds the context window. ";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateToolBindings(
  spec: Readonly<AgentLaunchSpec>,
  tools: readonly AuthorityBackedTool[],
): AuthorityBackedTool {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  if (byName.size !== tools.length || tools.length !== spec.tools.length) {
    throw new ManagedSessionError(
      "tool_inventory",
      "authority tool bindings do not exactly match the launch inventory",
    );
  }
  for (const expected of spec.tools) {
    const actual = byName.get(expected.name);
    if (
      actual === undefined ||
      actual.definition.name !== expected.name ||
      actual.schemaHash !== expected.schemaHash ||
      actual.maxResultBytes !== expected.maxResultBytes ||
      canonicalHash(actual.definition.parameters) !== expected.schemaHash ||
      (actual.definition.executionMode ?? "parallel") !== expected.executionMode ||
      actual.definition.prepareArguments !== undefined
    ) {
      throw new ManagedSessionError(
        "tool_binding",
        `authority tool ${expected.name} does not match its launch binding`,
      );
    }
  }
  const terminal = byName.get(spec.terminal.toolName);
  if (
    terminal === undefined ||
    terminal.definition.executionMode !== "sequential" ||
    terminal.terminalOutputSchema === undefined ||
    terminal.terminalOutputSchemaHash !== spec.terminal.outputSchemaHash ||
    canonicalHash(terminal.terminalOutputSchema) !== spec.terminal.outputSchemaHash
  ) {
    throw new ManagedSessionError(
      "terminal_schema",
      "terminal tool output schema does not match its launch binding",
    );
  }
  try {
    Compile(terminal.terminalOutputSchema);
  } catch (error) {
    throw new ManagedSessionError(
      "terminal_schema",
      `terminal output schema cannot be compiled: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const tool of tools) {
    if (
      tool.name !== spec.terminal.toolName &&
      (tool.terminalOutputSchema !== undefined || tool.terminalOutputSchemaHash !== undefined)
    ) {
      throw new ManagedSessionError(
        "terminal_schema",
        `non-terminal tool ${tool.name} declares a terminal schema`,
      );
    }
  }
  return terminal;
}

export function runtimeToolDefinitions(
  spec: Readonly<AgentLaunchSpec>,
  tools: readonly AuthorityBackedTool[],
  sessionManager: SessionManager,
  resultBudget: TranscriptToolResultBudget,
): ToolDefinition[] {
  return tools.map((tool) => {
    const definition = tool.definition;
    return {
      ...definition,
      ...(tool.name === spec.terminal.toolName ? { executionMode: "sequential" as const } : {}),
      async execute(toolCallId, params, signal, _onUpdate, _context) {
        const sessionFile = sessionManager.getSessionFile();
        if (sessionFile === undefined) {
          throw new ManagedSessionError(
            "session_persistence",
            "authority tool call has no durable Pi session file",
          );
        }
        // Pi persists the assistant tool-call entry before invoking a tool. Commit that entry
        // before any authority-backed effect so recovery can always authenticate the call.
        await syncSessionFile(sessionFile);
        const argumentsRecord = params as Record<string, unknown>;
        const budgetDisposition = await resultBudget.reserve(tool.maxResultBytes);
        const result =
          budgetDisposition === "execute"
            ? await tool.execute(toolCallId, argumentsRecord, signal)
            : await tool.reject(
                toolCallId,
                argumentsRecord,
                transcriptBudgetRejection(spec),
                signal,
              );
        const receipt = validatedReceiptFromResult(result, tool.maxResultBytes);
        if (tool.name !== spec.terminal.toolName && result.terminate === true) {
          throw new ManagedSessionError(
            "tool_result",
            "non-terminal authority tool attempted to terminate",
          );
        }
        return tool.name === spec.terminal.toolName && receipt.outcome === "accepted"
          ? { ...result, terminate: true }
          : result;
      },
    };
  });
}

/**
 * Reserve transcript space before an authority effect. Pi may execute a parallel tool batch, so
 * reservations are serialized and retained through the whole turn; no result can borrow bytes
 * another in-flight result has already been promised.
 */
export class TranscriptToolResultBudget {
  readonly #spec: Readonly<AgentLaunchSpec>;
  readonly #sessionManager: SessionManager;
  #baseBytes: number | undefined;
  #reservedBytes = 0;
  #lock: Promise<void> = Promise.resolve();

  public constructor(spec: Readonly<AgentLaunchSpec>, sessionManager: SessionManager) {
    this.#spec = spec;
    this.#sessionManager = sessionManager;
  }

  public reset(): void {
    this.#baseBytes = undefined;
    this.#reservedBytes = 0;
  }

  public reserve(maxResultBytes: number): Promise<"execute" | "reject"> {
    return this.#serialized(async () => {
      validatePositiveResultBound(maxResultBytes);
      const executeBytes = maxResultBytes + TRANSCRIPT_TOOL_RESULT_OVERHEAD_BYTES;
      if (await this.#canReserve(executeBytes)) {
        this.#reservedBytes += executeBytes;
        return "execute" as const;
      }
      const rejectionBytes = RUNTIME_REJECTION_RESULT_BYTES + TRANSCRIPT_TOOL_RESULT_OVERHEAD_BYTES;
      if (await this.#canReserve(rejectionBytes)) {
        this.#reservedBytes += rejectionBytes;
        return "reject" as const;
      }
      throw new ManagedSessionError(
        "transcript_budget",
        `Pi transcript cannot safely persist even a bounded rejection within its ${this.#spec.budgets.transcript.maxBytes}-byte attempt budget`,
      );
    });
  }

  public reserveExact(resultBytes: number): Promise<void> {
    return this.#serialized(async () => {
      validatePositiveResultBound(resultBytes);
      const reservation = resultBytes + TRANSCRIPT_TOOL_RESULT_OVERHEAD_BYTES;
      if (!(await this.#canReserve(reservation))) {
        throw new ManagedSessionError(
          "transcript_budget",
          `Pi transcript cannot persist an authenticated recovery result within its ${this.#spec.budgets.transcript.maxBytes}-byte attempt budget`,
        );
      }
      this.#reservedBytes += reservation;
    });
  }

  async #canReserve(bytes: number): Promise<boolean> {
    if (this.#baseBytes === undefined) {
      const sessionFile = this.#sessionManager.getSessionFile();
      if (sessionFile === undefined) {
        throw new ManagedSessionError(
          "session_persistence",
          "tool-result reservation has no durable Pi session file",
        );
      }
      this.#baseBytes = await safeRegularFileSize(sessionFile);
    }
    return this.#baseBytes + this.#reservedBytes + bytes <= this.#spec.budgets.transcript.maxBytes;
  }

  #serialized<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.#lock.then(operation, operation);
    this.#lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export async function safeRegularFileSize(file: string): Promise<number> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new ManagedSessionError("session_persistence", "Pi session path is not a regular file");
    }
    return metadata.size;
  } catch (error) {
    if (error instanceof ManagedSessionError) throw error;
    throw new ManagedSessionError(
      "session_persistence",
      `Pi session size cannot be authenticated: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function validatePositiveResultBound(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 16 * 1024 * 1024) {
    throw new ManagedSessionError("tool_result", "tool result byte bound is invalid");
  }
}

export function transcriptBudgetRejection(
  spec: Readonly<AgentLaunchSpec>,
): KoniRuntimeToolRejection {
  return {
    code: "transcript_result_budget",
    summary: `Tool was not executed because its worst-case result would exceed this attempt's ${spec.budgets.transcript.maxBytes}-byte transcript budget.`,
  };
}

export function validatedReceiptFromResult(
  result: AgentToolResult<unknown>,
  maxResultBytes: number,
): KoniToolReceipt {
  validateKoniToolReceipt(result.details);
  if (
    koniToolResultPayloadBytes(result) > maxResultBytes ||
    result.content.length !== 1 ||
    result.content[0]?.type !== "text" ||
    result.content[0].text !== renderKoniToolReceipt(result.details)
  ) {
    throw new ManagedSessionError(
      "tool_result",
      "authority tool result exceeds its bound or is not canonical",
    );
  }
  if (result.details.outcome === "rejected" && result.terminate === true) {
    throw new ManagedSessionError(
      "tool_result",
      "a rejected authority tool result cannot terminate an attempt",
    );
  }
  return result.details;
}

export function snapshotToolBindings(tools: readonly AuthorityBackedTool[]): AuthorityBackedTool[] {
  return tools.map((tool) => ({
    ...tool,
    definition: {
      ...tool.definition,
      parameters: structuredClone(tool.definition.parameters),
      ...(tool.definition.promptGuidelines === undefined
        ? {}
        : { promptGuidelines: [...tool.definition.promptGuidelines] }),
    },
    ...(tool.terminalOutputSchema === undefined
      ? {}
      : { terminalOutputSchema: structuredClone(tool.terminalOutputSchema) }),
  }));
}

export function assertExactToolInventory(
  spec: Readonly<AgentLaunchSpec>,
  active: readonly string[],
): void {
  const expected = spec.tools.map((tool) => tool.name).sort();
  const actual = [...active].sort();
  if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
    throw new ManagedSessionError(
      "ambient_tool",
      "Pi exposed a tool outside the compiler-issued inventory",
    );
  }
}

export function addUsage(
  total: ManagedTokenUsage,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): void {
  for (const [name, value] of Object.entries({ input, output, cacheRead, cacheWrite })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ManagedSessionError("usage", `Pi reported invalid ${name} token usage`);
    }
  }
  total.input = safeUsageSum(total.input, input);
  total.output = safeUsageSum(total.output, output);
  total.cacheRead = safeUsageSum(total.cacheRead, cacheRead);
  total.cacheWrite = safeUsageSum(total.cacheWrite, cacheWrite);
  total.newTokens = safeUsageSum(total.input, total.output);
  total.allTokens = safeUsageSum(total.newTokens, total.cacheRead, total.cacheWrite);
}

export function validateManagedUsage(usage: ManagedTokenUsage): void {
  for (const [name, value] of Object.entries(usage)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ManagedSessionError("recovery_usage", `recovered ${name} usage is invalid`);
    }
  }
  if (
    usage.newTokens !== usage.input + usage.output ||
    usage.allTokens !== usage.newTokens + usage.cacheRead + usage.cacheWrite
  ) {
    throw new ManagedSessionError("recovery_usage", "recovered token aggregates are inconsistent");
  }
}

export function assertMonotonicUsage(
  prior: Readonly<ManagedTokenUsage>,
  next: Readonly<ManagedTokenUsage>,
): void {
  if (
    next.input < prior.input ||
    next.output < prior.output ||
    next.cacheRead < prior.cacheRead ||
    next.cacheWrite < prior.cacheWrite
  ) {
    throw new ManagedSessionError("usage", "authority provider usage moved backwards");
  }
}

export function safeUsageSum(...values: number[]): number {
  const result = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result)) {
    throw new ManagedSessionError("usage", "Pi token usage exceeds safe accounting range");
  }
  return result;
}

export function tokenBudgetViolation(
  spec: Readonly<AgentLaunchSpec>,
  cumulativeUsage: ManagedTokenUsage,
): string | undefined {
  const usage = planningRevisionBudgetUsage(spec, cumulativeUsage);
  const maximum = spec.budgets.tokens;
  const checks: Array<[number, number, string]> = [
    [usage.input, maximum.maxInput, "input"],
    [usage.output, maximum.maxOutput, "output"],
    [usage.cacheRead, maximum.maxCacheRead, "cache-read"],
    [usage.cacheWrite, maximum.maxCacheWrite, "cache-write"],
    [usage.newTokens, maximum.maxNew, "new-token"],
    [usage.allTokens, maximum.maxAll, "cache-inclusive"],
  ];
  return checks.find(([actual, allowed]) => actual > allowed)?.[2].concat(" token budget exceeded");
}

export function tokenBudgetExhaustion(
  spec: Readonly<AgentLaunchSpec>,
  cumulativeUsage: ManagedTokenUsage,
): string | undefined {
  const usage = planningRevisionBudgetUsage(spec, cumulativeUsage);
  const maximum = spec.budgets.tokens;
  const checks: Array<[number, number, string]> = [
    [usage.input, maximum.maxInput, "input"],
    [usage.output, maximum.maxOutput, "output"],
    [usage.cacheRead, maximum.maxCacheRead, "cache-read"],
    [usage.cacheWrite, maximum.maxCacheWrite, "cache-write"],
    [usage.newTokens, maximum.maxNew, "new-token"],
    [usage.allTokens, maximum.maxAll, "cache-inclusive"],
  ];
  return checks
    .find(([actual, allowed]) => actual >= allowed)?.[2]
    .concat(" token budget exhausted");
}

/**
 * Bound one request's output reservation independently of the run-wide token budget.
 *
 * A model can advertise an output maximum large enough to consume most of its context
 * window. Reserving that entire maximum alongside an already-large prompt leaves no
 * allowance for provider framing or context reissue messages, which can turn an otherwise
 * admissible synthesis turn into a canonical provider abort. Keep at least three quarters of
 * an authenticated context window available for prompt and transport overhead.
 */
export function providerOutputLimit(
  spec: Readonly<AgentLaunchSpec>,
  recoveredUsage: ManagedTokenUsage | undefined,
): number {
  const usage = planningRevisionBudgetUsage(spec, recoveredUsage ?? emptyUsage());
  const maximum = spec.budgets.tokens;
  const contextOutputCap =
    spec.model.catalogContextWindow === undefined
      ? Number.MAX_SAFE_INTEGER
      : Math.floor(spec.model.catalogContextWindow / 4);
  return Math.max(
    1,
    Math.min(
      maximum.maxOutput - usage.output,
      maximum.maxNew - usage.newTokens,
      maximum.maxAll - usage.allTokens,
      contextOutputCap,
    ),
  );
}

export function planningRevisionBudgetUsage(
  spec: Readonly<AgentLaunchSpec>,
  cumulative: Readonly<ManagedTokenUsage>,
): ManagedTokenUsage {
  const baseline = spec.planningRevision?.budgetBaseline;
  if (baseline === undefined) return { ...cumulative };
  const input = cumulative.input - baseline.inputTokens;
  const output = cumulative.output - baseline.outputTokens;
  const cacheRead = cumulative.cacheRead - baseline.cacheReadTokens;
  const cacheWrite = cumulative.cacheWrite - baseline.cacheWriteTokens;
  if ([input, output, cacheRead, cacheWrite].some((value) => value < 0)) {
    throw new ManagedSessionError(
      "planning_revision_budget",
      "cumulative provider usage moved behind the authenticated planning revision baseline",
    );
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    newTokens: safeUsageSum(input, output),
    allTokens: safeUsageSum(input, output, cacheRead, cacheWrite),
  };
}

export function containedCompactionKeepRecentTokens(spec: Readonly<AgentLaunchSpec>): number {
  return Math.max(2_000, Math.min(8_000, Math.floor(spec.budgets.tokens.maxInput / 32)));
}

export function selectContainedCompactionFirstKeptEntryId(
  spec: Readonly<AgentLaunchSpec>,
  sessionManager: Pick<SessionManager, "getLeafEntry" | "getBranch">,
  failure: ManagedSessionError | undefined,
  preparedFirstKeptEntryId: string,
): string {
  if (failure?.code === "provider_input_exposure" || failure?.code === "provider_token_exposure") {
    return providerPressureCompactionFirstKeptEntryId(
      spec,
      sessionManager,
      failure,
      preparedFirstKeptEntryId,
    );
  }
  const pressureBoundary = providerPressureCompactionFirstKeptEntryId(
    spec,
    sessionManager,
    failure,
    preparedFirstKeptEntryId,
  );
  if (pressureBoundary !== preparedFirstKeptEntryId) return pressureBoundary;
  return rejectedToolDraftCompactionFirstKeptEntryId(
    spec,
    sessionManager,
    preparedFirstKeptEntryId,
  );
}

export function providerPressureCompactionFirstKeptEntryId(
  spec: Readonly<AgentLaunchSpec>,
  sessionManager: Pick<SessionManager, "getLeafEntry" | "getBranch">,
  failure: ManagedSessionError | undefined,
  preparedFirstKeptEntryId: string,
): string {
  if (failure?.code !== "provider_input_exposure" && failure?.code !== "provider_token_exposure") {
    return preparedFirstKeptEntryId;
  }
  const leaf = sessionManager.getLeafEntry();
  const assistant =
    leaf?.type === "message" && leaf.message.role === "assistant" ? leaf.message : undefined;
  const leafId = leaf?.id;
  const usage = assistant?.usage;
  const cost = usage?.cost;
  if (
    assistant === undefined ||
    leafId === undefined ||
    !Array.isArray(assistant.content) ||
    assistant.content.length !== 0 ||
    assistant.api !== spec.model.api ||
    assistant.provider !== spec.model.provider ||
    assistant.model !== spec.model.id ||
    assistant.stopReason !== "error" ||
    !failure.message.startsWith(PROVIDER_INPUT_PRESSURE_MARKER) ||
    assistant.errorMessage !== failure.message ||
    usage?.input !== 0 ||
    usage?.output !== 0 ||
    usage?.cacheRead !== 0 ||
    usage?.cacheWrite !== 0 ||
    usage?.totalTokens !== 0 ||
    cost?.input !== 0 ||
    cost?.output !== 0 ||
    cost?.cacheRead !== 0 ||
    cost?.cacheWrite !== 0 ||
    cost?.total !== 0
  ) {
    return preparedFirstKeptEntryId;
  }
  return boundedToolExchangeBeforePressure(spec, sessionManager, leafId) ?? leafId;
}

/**
 * Preserve a small, authenticated tool exchange immediately before an input-pressure error.
 * Keeping only Pi's empty error boundary discards the native call/result relationship and can
 * make a model replay the same read after every provider-free compaction. Large payloads still
 * fall back to the error boundary so compaction always reduces the active provider suffix.
 */
export function boundedToolExchangeBeforePressure(
  spec: Readonly<AgentLaunchSpec>,
  sessionManager: Pick<SessionManager, "getBranch">,
  pressureEntryId: string,
): string | undefined {
  const branch = sessionManager.getBranch() as unknown as readonly PiSessionEntry[];
  const pressureIndex = branch.findIndex((entry) => entry.id === pressureEntryId);
  if (pressureIndex < 1) return undefined;
  let boundaryStart = 0;
  for (let index = pressureIndex - 1; index >= 0; index -= 1) {
    if (branch[index]?.type !== "compaction") continue;
    boundaryStart = index + 1;
    break;
  }

  const resultEntry = branch[pressureIndex - 1];
  const result =
    resultEntry?.type === "message" && isRecord(resultEntry.message)
      ? resultEntry.message
      : undefined;
  if (
    result?.role !== "toolResult" ||
    typeof result.toolName !== "string" ||
    typeof result.toolCallId !== "string" ||
    !isRecord(result.details) ||
    !spec.tools.some((tool) => tool.name === result.toolName)
  ) {
    return undefined;
  }
  try {
    validateKoniToolReceipt(result.details);
  } catch {
    return undefined;
  }
  if (
    (result.details.outcome === "rejected") !== (result.isError === true) ||
    userText(result.content) !== renderKoniToolReceipt(result.details)
  ) {
    return undefined;
  }

  let assistantIndex = pressureIndex - 2;
  let assistantEntryId: string | undefined;
  for (; assistantIndex >= boundaryStart; assistantIndex -= 1) {
    const entry = branch[assistantIndex]!;
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) {
      return undefined;
    }
    const toolCalls = entry.message.content.filter(
      (block) => isRecord(block) && block.type === "toolCall",
    );
    if (
      toolCalls.length !== 1 ||
      toolCalls[0]!.id !== result.toolCallId ||
      toolCalls[0]!.name !== result.toolName
    ) {
      return undefined;
    }
    assistantEntryId = entry.id;
    break;
  }
  if (assistantEntryId === undefined) return undefined;

  const suffixTokens = Math.ceil(
    Buffer.byteLength(JSON.stringify(branch.slice(assistantIndex)), "utf8") / 4,
  );
  return suffixTokens <= containedCompactionKeepRecentTokens(spec) ? assistantEntryId : undefined;
}

/**
 * A rejected authority result describes a correction to the immediately preceding complete draft.
 * Pi's small recent-message window can otherwise retain only the rejection (or a following empty
 * assistant message), forcing the model to reconstruct a planning artifact or file payload from
 * the summary. Keep that exact issued tool call when its active suffix is safely bounded; authority
 * still revalidates the next call against the immutable tool schema, grant, and run state.
 */
export function rejectedToolDraftCompactionFirstKeptEntryId(
  spec: Readonly<AgentLaunchSpec>,
  sessionManager: Pick<SessionManager, "getBranch">,
  preparedFirstKeptEntryId: string,
): string {
  const branch = sessionManager.getBranch() as unknown as readonly PiSessionEntry[];
  const preparedIndex = branch.findIndex((entry) => entry.id === preparedFirstKeptEntryId);
  if (preparedIndex < 0) return preparedFirstKeptEntryId;
  let boundaryStart = 0;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index]?.type === "compaction") {
      boundaryStart = index + 1;
      break;
    }
  }

  let resultIndex = branch.length - 1;
  while (resultIndex >= boundaryStart) {
    const entry = branch[resultIndex]!;
    if (
      entry.type === "message" &&
      isRecord(entry.message) &&
      entry.message.role === "assistant" &&
      Array.isArray(entry.message.content) &&
      entry.message.content.length === 0
    ) {
      resultIndex -= 1;
      continue;
    }
    if (
      entry.type === "custom" ||
      entry.type === "model_change" ||
      entry.type === "thinking_level_change"
    ) {
      resultIndex -= 1;
      continue;
    }
    break;
  }
  const resultEntry = branch[resultIndex];
  const resultMessage =
    resultEntry?.type === "message" && isRecord(resultEntry.message)
      ? resultEntry.message
      : undefined;
  if (
    resultMessage?.role !== "toolResult" ||
    typeof resultMessage.toolName !== "string" ||
    resultMessage.isError !== true ||
    typeof resultMessage.toolCallId !== "string" ||
    !isRecord(resultMessage.details)
  ) {
    return preparedFirstKeptEntryId;
  }
  if (!spec.tools.some((tool) => tool.name === resultMessage.toolName)) {
    return preparedFirstKeptEntryId;
  }
  try {
    validateKoniToolReceipt(resultMessage.details);
  } catch {
    return preparedFirstKeptEntryId;
  }
  if (
    resultMessage.details.outcome !== "rejected" ||
    userText(resultMessage.content) !== renderKoniToolReceipt(resultMessage.details)
  ) {
    return preparedFirstKeptEntryId;
  }

  const callId = resultMessage.toolCallId;
  const toolName = resultMessage.toolName;
  let assistantIndex = resultIndex - 1;
  for (; assistantIndex >= boundaryStart; assistantIndex -= 1) {
    const entry = branch[assistantIndex]!;
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) {
      return preparedFirstKeptEntryId;
    }
    const hasMatchingCall = entry.message.content.some(
      (block) =>
        isRecord(block) &&
        block.type === "toolCall" &&
        block.id === callId &&
        block.name === toolName,
    );
    if (!hasMatchingCall) return preparedFirstKeptEntryId;
    break;
  }
  if (
    assistantIndex < boundaryStart ||
    preparedIndex <= assistantIndex ||
    branch[assistantIndex]?.id === undefined
  ) {
    return preparedFirstKeptEntryId;
  }

  const suffixTokens = Math.ceil(
    Buffer.byteLength(JSON.stringify(branch.slice(assistantIndex)), "utf8") / 4,
  );
  const providerContextWindow =
    typeof spec.model.catalogContextWindow === "number" &&
    Number.isSafeInteger(spec.model.catalogContextWindow)
      ? spec.model.catalogContextWindow
      : spec.budgets.tokens.maxInput + spec.budgets.tokens.providerOutputHeadroom;
  const providerInputCapacity = Math.max(
    0,
    providerContextWindow - spec.budgets.tokens.providerOutputHeadroom,
  );
  const maximumDraftSuffixTokens = Math.max(
    containedCompactionKeepRecentTokens(spec),
    Math.min(Math.floor(spec.budgets.tokens.maxInput / 2), Math.floor(providerInputCapacity / 2)),
  );
  return suffixTokens <= maximumDraftSuffixTokens
    ? branch[assistantIndex]!.id
    : preparedFirstKeptEntryId;
}

export function exactProviderPayload(
  api: string,
  payload: unknown,
): { wirePayload: unknown; transportPayload: unknown } {
  let jsonPayload = payload;
  let abortSignal: AbortSignal | undefined;
  if (api === "google-generative-ai" || api === "google-vertex") {
    if (
      !isRecord(payload) ||
      !isRecord(payload.config) ||
      !(payload.config.abortSignal instanceof AbortSignal)
    ) {
      throw new ManagedSessionError(
        "provider_payload",
        `Pi built a ${api} payload without its live abort control`,
      );
    }
    abortSignal = payload.config.abortSignal;
    const config = { ...payload.config };
    delete config.abortSignal;
    jsonPayload = { ...payload, config };
  }
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(jsonPayload);
  } catch {
    throw new ManagedSessionError(
      "provider_payload",
      "Pi built a non-serializable provider payload",
    );
  }
  if (encoded === undefined) {
    throw new ManagedSessionError("provider_payload", "Pi built an empty provider payload");
  }
  // The authority hashes the exact JSON body projection. Google keeps AbortSignal as a live SDK
  // control outside those bytes, so preserve that exact object while freezing every wire field.
  const wirePayload = JSON.parse(encoded) as unknown;
  if (abortSignal === undefined) return { wirePayload, transportPayload: wirePayload };
  if (!isRecord(wirePayload) || !isRecord(wirePayload.config)) {
    throw new ManagedSessionError("provider_payload", `Pi built a malformed ${api} payload`);
  }
  return {
    wirePayload,
    transportPayload: {
      ...wirePayload,
      config: { ...wirePayload.config, abortSignal },
    },
  };
}

export function assertSelectedProviderModel(
  spec: Readonly<AgentLaunchSpec>,
  selected: Readonly<Model<Api>>,
  expectedMaxTokens: number,
): void {
  if (
    selected.provider !== spec.model.provider ||
    selected.id !== spec.model.id ||
    selected.api !== spec.model.api ||
    selected.maxTokens !== expectedMaxTokens
  ) {
    throw new ManagedSessionError(
      "provider_model",
      "Pi selected a provider model different from the authenticated contained model",
    );
  }
}

export function assertExactProviderSettlement(
  expected: {
    sequence: number;
    reservationId: string;
    assistantEntryId: string;
    assistantEntrySha256: Sha256Digest;
    usage: KoniAttemptUsage;
  },
  settled: Awaited<ReturnType<NonNullable<KoniContextProvider["reconcileProviderRequest"]>>>,
): void {
  if (
    settled.protocol !== "koni.provider-request-settlement.v1" ||
    settled.sequence !== expected.sequence ||
    settled.reservationId !== expected.reservationId ||
    settled.assistantEntryId !== expected.assistantEntryId ||
    settled.assistantEntrySha256 !== expected.assistantEntrySha256 ||
    canonicalHash(settled.usage) !== canonicalHash(expected.usage)
  ) {
    throw new ManagedSessionError(
      "provider_settlement",
      "authority settled a different provider request or canonical assistant usage",
    );
  }
}

export function assertCodexProviderPayload(
  spec: Readonly<AgentLaunchSpec>,
  payload: unknown,
): asserts payload is Record<string, unknown> {
  if (
    !isRecord(payload) ||
    payload.model !== spec.model.id ||
    payload.store !== false ||
    payload.stream !== true ||
    typeof payload.instructions !== "string" ||
    !Array.isArray(payload.input) ||
    !isRecord(payload.text) ||
    !Array.isArray(payload.include) ||
    payload.parallel_tool_calls !== true ||
    !(typeof payload.tool_choice === "string" || isRecord(payload.tool_choice)) ||
    (payload.tools !== undefined && !Array.isArray(payload.tools)) ||
    (payload.reasoning !== undefined && !isRecord(payload.reasoning))
  ) {
    throw new ManagedSessionError(
      "provider_payload",
      "Pi built a malformed or differently bound OpenAI Codex request payload",
    );
  }
}

export function emptyUsage(): ManagedTokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 };
}

export function sanitizeText(value: string): string {
  const clean = value.replaceAll("\u0000", "").trim();
  return clean.length === 0 ? "aborted by authority" : clean.slice(0, 4_096);
}

export function sanitizeProviderError(value: string | undefined): string {
  const clean = (value ?? "provider request failed").replaceAll("\u0000", "").trim();
  return (clean.length === 0 ? "provider request failed" : clean).slice(0, 4_096);
}

export function providerAdmissionFailure(error: unknown): ManagedSessionError {
  const failure =
    error instanceof ManagedSessionError
      ? error
      : new ManagedSessionError(
          "provider_admission",
          error instanceof Error ? error.message : String(error),
        );
  if (failure.code !== "provider_input_exposure" && failure.code !== "provider_token_exposure") {
    return failure;
  }
  // Pi owns the provider-free compact-and-retry lifecycle, but identifies overflow from the
  // persisted assistant error text. Preserve Koni's typed code while projecting a stable marker
  // that Pi recognizes instead of coupling recovery to authority wording.
  return new ManagedSessionError(
    failure.code,
    `${PROVIDER_INPUT_PRESSURE_MARKER}${sanitizeProviderError(failure.message)}`.slice(0, 4_096),
  );
}

export async function syncSessionFile(sessionFile: string): Promise<void> {
  let handle;
  try {
    handle = await open(sessionFile, constants.O_RDWR | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new ManagedSessionError("session_persistence", "Pi session path is not a regular file");
    }
    await handle.sync();
  } catch (error) {
    if (error instanceof ManagedSessionError) throw error;
    throw new ManagedSessionError(
      "session_persistence",
      `Pi session could not be committed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function userText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return undefined;
    parts.push(item.text);
  }
  return parts.join("");
}
