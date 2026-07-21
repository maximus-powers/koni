import { canonicalHash, rawSha256, type Sha256Digest } from "../shared/canonical.js";
import type { KoniAttemptUsage } from "./compaction.js";
import type { PiSessionEntry } from "./session-transcript.js";

export const PROVIDER_PAYLOAD_TOKEN_RESERVE = 4 * 1024;
export const PROVIDER_INPUT_ESTIMATE_ALGORITHM = "pi-wire-bytes-div2-v1" as const;
const MAX_PROVIDER_PAYLOAD_BYTES = 64 * 1024 * 1024;

export interface SerializedProviderOutputCap {
  path: string;
  value: number;
}

export interface ProviderPayloadIdentity {
  payloadSha256: Sha256Digest;
  payloadSizeBytes: number;
  prospectiveInputTokens: number;
}

/**
 * Reserve worst-case prompt tokens for the exact serialized wire body.
 *
 * Settlement treats this reservation as a hard exposure ceiling, so the divisor must lower-bound
 * every supported provider tokenizer's bytes-per-token across real payload mixes. Observed live on
 * Claude: prose/tool-schema payloads settle at ~3.0-3.1 bytes/token (79,139 bytes → 25,565 prompt
 * tokens), while code-heavy payloads with embedded TSX tool results settle at ~2.7 (182,488 bytes
 * → 67,579 prompt tokens, which exceeded the interim bytes/3 estimate). GPT-family tokenizers run
 * ≥4. bytes/2 bounds all observed mixes with margin while remaining a bounded worst-case hold; the
 * fixed reserve covers provider framing that is not represented in the JSON body. Canonical
 * provider usage remains the accounting authority after every settled response.
 */
export function estimateProviderInputTokens(payloadSizeBytes: number): number {
  if (!Number.isSafeInteger(payloadSizeBytes) || payloadSizeBytes < 1 || payloadSizeBytes > MAX_PROVIDER_PAYLOAD_BYTES) {
    throw new Error("Pi provider payload exceeds its authority admission bound");
  }
  const estimate = Math.ceil(payloadSizeBytes / 2) + PROVIDER_PAYLOAD_TOKEN_RESERVE;
  if (!Number.isSafeInteger(estimate)) {
    throw new Error("Pi provider payload exceeds safe token accounting range");
  }
  return estimate;
}

/** Accept persisted pre-migration ledgers without allowing any unrecognized estimate formula. */
export function isSupportedStoredProviderInputEstimate(
  payloadSizeBytes: number,
  prospectiveInputTokens: number,
): boolean {
  if (!Number.isSafeInteger(prospectiveInputTokens) || prospectiveInputTokens < 1) return false;
  let current: number;
  try {
    current = estimateProviderInputTokens(payloadSizeBytes);
  } catch {
    return false;
  }
  const legacyDiv3 = Math.ceil(payloadSizeBytes / 3) + PROVIDER_PAYLOAD_TOKEN_RESERVE;
  const legacyDiv4 = Math.ceil(payloadSizeBytes / 4) + PROVIDER_PAYLOAD_TOKEN_RESERVE;
  const legacyBytes = payloadSizeBytes + PROVIDER_PAYLOAD_TOKEN_RESERVE;
  return Number.isSafeInteger(legacyBytes) && (
    prospectiveInputTokens === current ||
    prospectiveInputTokens === legacyDiv3 ||
    prospectiveInputTokens === legacyDiv4 ||
    prospectiveInputTokens === legacyBytes
  );
}

export interface DerivedProviderSettlement {
  assistantEntryId: string;
  assistantEntrySha256: Sha256Digest;
  usage: KoniAttemptUsage;
}

export interface ProviderSettlementBoundary {
  baselineEntryId: string;
  nextBaselineEntryId?: string;
}

const OUTPUT_CAP_PATHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "openai-completions": ["/max_tokens", "/max_completion_tokens"],
  "openai-responses": ["/max_output_tokens"],
  "azure-openai-responses": ["/max_output_tokens"],
  "anthropic-messages": ["/max_tokens"],
  "google-generative-ai": ["/config/maxOutputTokens"],
  "google-vertex": ["/config/maxOutputTokens"],
  "bedrock-converse-stream": ["/inferenceConfig/maxTokens"],
  "mistral-conversations": ["/maxTokens"],
  "pi-messages": ["/options/maxTokens"],
});

export function providerPayloadIdentity(payload: unknown): ProviderPayloadIdentity {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(payload);
  } catch {
    throw new Error("Pi built a non-serializable provider payload");
  }
  if (encoded === undefined) throw new Error("Pi built an empty provider payload");
  const payloadSizeBytes = Buffer.byteLength(encoded, "utf8");
  if (payloadSizeBytes < 1 || payloadSizeBytes > MAX_PROVIDER_PAYLOAD_BYTES) {
    throw new Error("Pi provider payload exceeds its authority admission bound");
  }
  const prospectiveInputTokens = estimateProviderInputTokens(payloadSizeBytes);
  return {
    payloadSha256: rawSha256(encoded),
    payloadSizeBytes,
    prospectiveInputTokens,
  };
}

/** Return the exact cap Pi serialized, or undefined when this API has no supported wire cap. */
export function serializedProviderOutputCap(
  api: string,
  payload: unknown,
): SerializedProviderOutputCap | undefined {
  if (api === "openai-codex-responses") {
    if (readPath(payload, "/max_output_tokens") !== undefined) {
      throw new Error("Pi Codex payload contains unsupported max_output_tokens");
    }
    return undefined;
  }
  const paths = OUTPUT_CAP_PATHS[api];
  if (paths === undefined) return undefined;
  const present = paths.flatMap((path) => {
    const value = readPath(payload, path);
    return value === undefined ? [] : [{ path, value }];
  });
  if (
    present.length !== 1 ||
    !Number.isSafeInteger(present[0]!.value) ||
    Number(present[0]!.value) < 1
  ) {
    throw new Error(`Pi ${api} payload omitted or duplicated its supported output cap`);
  }
  return { path: present[0]!.path, value: Number(present[0]!.value) };
}

export function isSupportedProviderOutputCap(api: string, cap: SerializedProviderOutputCap): boolean {
  return OUTPUT_CAP_PATHS[api]?.includes(cap.path) === true &&
    Number.isSafeInteger(cap.value) && cap.value > 0;
}

export function providerApiHasSupportedOutputCap(api: string): boolean {
  return OUTPUT_CAP_PATHS[api] !== undefined;
}

/**
 * Derive one provider settlement from the linear Pi transcript suffix after its reservation.
 *
 * Tool results and custom records may follow the assistant entry before the next provider turn,
 * but a second assistant entry proves that the prior reservation was not reconciled in time and
 * therefore fails closed.
 */
export function deriveProviderSettlement(
  entries: readonly PiSessionEntry[],
  baselineEntryId: string,
  nextBaselineEntryId?: string,
): DerivedProviderSettlement | undefined {
  return deriveProviderSettlements(entries, [{
    baselineEntryId,
    ...(nextBaselineEntryId === undefined ? {} : { nextBaselineEntryId }),
  }])[0];
}

/** Re-derive an ordered request ledger in one linear transcript pass. */
export function deriveProviderSettlements(
  entries: readonly PiSessionEntry[],
  boundaries: readonly ProviderSettlementBoundary[],
): Array<DerivedProviderSettlement | undefined> {
  let expectedParent: string | null = null;
  const entryIndexes = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    if (entry.parentId !== expectedParent) {
      throw new Error("Pi provider transcript is not one linear parent chain");
    }
    if (entryIndexes.has(entry.id)) throw new Error("Pi provider transcript contains a duplicate entry id");
    entryIndexes.set(entry.id, index);
    expectedParent = entry.id;
  }
  let previousEnd = -1;
  return boundaries.map((boundary) => {
    const baselineIndex = entryIndexes.get(boundary.baselineEntryId) ?? -1;
    const nextBaselineIndex = boundary.nextBaselineEntryId === undefined
      ? entries.length - 1
      : entryIndexes.get(boundary.nextBaselineEntryId) ?? -1;
    if (baselineIndex === -1) throw new Error("Pi provider baseline is missing from its transcript");
    if (
      nextBaselineIndex < baselineIndex ||
      (boundary.nextBaselineEntryId !== undefined && nextBaselineIndex === baselineIndex)
    ) {
      throw new Error("Pi provider next baseline is missing or precedes its reservation");
    }
    if (baselineIndex < previousEnd) {
      throw new Error("Pi provider reservation baselines are not in transcript order");
    }
    previousEnd = nextBaselineIndex;
    let assistant: PiSessionEntry | undefined;
    for (let index = baselineIndex + 1; index <= nextBaselineIndex; index += 1) {
      const entry = entries[index]!;
      if (!isAssistantEntry(entry)) continue;
      if (assistant !== undefined) {
        throw new Error("Pi transcript contains multiple assistant turns after one provider reservation");
      }
      assistant = entry;
    }
    if (assistant === undefined) return undefined;
    return {
      assistantEntryId: assistant.id,
      assistantEntrySha256: canonicalHash(assistant),
      usage: strictAssistantUsage(assistant),
    };
  });
}

function readPath(payload: unknown, pointer: string): unknown {
  let current = payload;
  for (const segment of pointer.slice(1).split("/")) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAssistantEntry(entry: PiSessionEntry): boolean {
  return entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant";
}

function strictAssistantUsage(entry: PiSessionEntry): KoniAttemptUsage {
  const message = entry.message;
  if (!isRecord(message) || !isRecord(message.usage)) {
    throw new Error("Pi provider assistant is missing its canonical usage record");
  }
  if (!new Set(["stop", "toolUse", "length"]).has(String(message.stopReason))) {
    throw new Error("Pi provider assistant did not reach a trustworthy terminal response boundary");
  }
  const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
  for (const field of fields) {
    if (
      !Object.hasOwn(message.usage, field) ||
      !Number.isSafeInteger(message.usage[field]) ||
      Number(message.usage[field]) < 0
    ) {
      throw new Error(`Pi provider assistant has invalid ${field} usage`);
    }
  }
  const input = Number(message.usage.input);
  const output = Number(message.usage.output);
  const cacheRead = Number(message.usage.cacheRead);
  const cacheWrite = Number(message.usage.cacheWrite);
  const newTokens = checkedUsageSum(input, output);
  const allTokens = checkedUsageSum(newTokens, cacheRead, cacheWrite);
  // Pi's raw totalTokens has provider-specific cache semantics. Its presence and numeric safety
  // are authenticated above, while Koni's canonical totals are always derived from the four
  // complete component fields.
  return { input, output, cacheRead, cacheWrite, newTokens, allTokens };
}

function checkedUsageSum(...values: number[]): number {
  const sum = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(sum)) {
    throw new Error("Pi provider assistant usage exceeds safe accounting range");
  }
  return sum;
}
