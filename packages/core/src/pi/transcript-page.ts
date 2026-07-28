import { canonicalHash, isSha256Digest, type Sha256Digest } from "../shared/canonical.js";
import {
  assertAutonomousPiSession,
  readPiSessionDurably,
  summarizeUsage,
  type AutonomousPiSessionBinding,
  type ParsedPiSession,
  type PiSessionEntry,
} from "./session-transcript.js";

export const PI_TRANSCRIPT_PAGE_PROTOCOL = "koni.pi-transcript-page.v1" as const;
const PI_TRANSCRIPT_CURSOR_PROTOCOL = "koni.pi-transcript-cursor.v1" as const;
const DEFAULT_PAGE_LIMIT = 24;
const MAX_PAGE_LIMIT = 64;
const MAX_CURSOR_BYTES = 4 * 1024;
const MAX_TITLE_BYTES = 16 * 1024;
const MAX_MARKDOWN_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_DIAGNOSTICS = 32;

export type PiTranscriptBlockKind =
  "user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "compaction" | "notice";

export interface PiTranscriptBlock {
  id: string;
  kind: PiTranscriptBlockKind;
  title: string;
  markdown: string;
  timestamp?: string;
  branch: boolean;
  error: boolean;
  /** True when this semantic block spans more than one finite presentation chunk. */
  truncated: boolean;
  /** Ordered, lossless safe-text chunk metadata. Concatenating every part reconstructs the block. */
  chunk?: {
    index: number;
    total: number;
    totalBytes: number;
  };
}

export interface PiTranscriptUsageStrings {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  newTokens: string;
  allTokens: string;
}

export interface PiTranscriptPage {
  protocol: typeof PI_TRANSCRIPT_PAGE_PROTOCOL;
  session: {
    id: string;
    version: number;
    cwd?: string;
    /** Autonomous Koni attempts intentionally leave this absent. */
    parentSession?: string;
  };
  snapshot: {
    entryCount: number;
    lastEntryId?: string;
    sha256: Sha256Digest;
  };
  totalBlocks: number;
  /** Zero-based ordinal of the first presentation block in this stable snapshot window. */
  startBlock: number;
  blocks: readonly PiTranscriptBlock[];
  usage: PiTranscriptUsageStrings;
  diagnostics: readonly string[];
  /** Adjacent newer history window within the exact same snapshot. */
  previousCursor?: string;
  /** Adjacent older history window within the exact same snapshot. */
  nextCursor?: string;
}

interface PiTranscriptCursor {
  protocol: typeof PI_TRANSCRIPT_CURSOR_PROTOCOL;
  sessionId: string;
  snapshotEntryCount: number;
  snapshotLastEntryId: string | null;
  snapshotSha256: Sha256Digest;
  totalBlocks: number;
  beforeBlock: number;
}

export class PiTranscriptPageError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "PiTranscriptPageError";
    this.code = code;
  }
}

/**
 * Authenticate and page one live autonomous transcript through a stable, owner-bound file
 * identity. The returned page is bounded even though the canonical Pi JSONL remains complete.
 * Authority callers should derive `filePath`, `sessionId`, and `cwd` from the validated launch
 * specification rather than accepting them directly from an operator request.
 */
export async function readAutonomousPiTranscriptPage(
  filePath: string,
  binding: AutonomousPiSessionBinding,
  options: { cursor?: string; limit?: number; maxBytes?: number } = {},
): Promise<PiTranscriptPage> {
  const session = await readPiSessionDurably(filePath, {
    allowTruncatedTail: true,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  assertAutonomousPiSession(session, binding);
  return projectPiTranscriptPage(session, options);
}

/**
 * Project a bounded, newest-first page window from one authenticated native Pi session snapshot.
 * Blocks within the page remain chronological. A cursor pins the original prefix, so later JSONL
 * appends do not reorder older pages and any mutation/truncation of that prefix fails closed.
 *
 * This is a presentation projection only. It never rewrites, compacts, branches, or replaces the
 * canonical Pi JSONL transcript and never grants authority to steer the represented attempt.
 */
export function projectPiTranscriptPage(
  session: ParsedPiSession,
  options: { cursor?: string; limit?: number } = {},
): PiTranscriptPage {
  const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new PiTranscriptPageError(
      "page_limit",
      `transcript page limit must be between 1 and ${MAX_PAGE_LIMIT}`,
    );
  }
  const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
  if (cursor !== undefined && cursor.sessionId !== session.header.id) {
    throw new PiTranscriptPageError(
      "cursor_session",
      "transcript cursor belongs to another Pi session",
    );
  }
  const snapshotEntryCount = cursor?.snapshotEntryCount ?? session.entries.length;
  if (snapshotEntryCount > session.entries.length) {
    throw new PiTranscriptPageError(
      "cursor_snapshot",
      "Pi transcript was truncated after this page cursor was issued",
    );
  }
  const snapshotEntries = session.entries.slice(0, snapshotEntryCount);
  const snapshotLastEntryId = snapshotEntries.at(-1)?.id ?? null;
  const snapshotSha256 = transcriptSnapshotHash(session, snapshotEntries);
  if (
    cursor !== undefined &&
    (cursor.snapshotLastEntryId !== snapshotLastEntryId || cursor.snapshotSha256 !== snapshotSha256)
  ) {
    throw new PiTranscriptPageError(
      "cursor_snapshot",
      "Pi transcript snapshot changed after this page cursor was issued",
    );
  }

  const requestedBefore = cursor?.beforeBlock;
  const selected: PiTranscriptBlock[] = [];
  const newestRing: PiTranscriptBlock[] = [];
  let totalBlocks = 0;
  let previousId: string | undefined;
  for (const [entryIndex, entry] of snapshotEntries.entries()) {
    const branch = entryIndex > 0 && entry.parentId !== previousId;
    previousId = entry.id;
    for (const block of projectEntry(entry, branch)) {
      if (requestedBefore === undefined) {
        newestRing.push(block);
        if (newestRing.length > limit) newestRing.shift();
      } else {
        const start = Math.max(0, requestedBefore - limit);
        if (totalBlocks >= start && totalBlocks < requestedBefore) selected.push(block);
      }
      totalBlocks += 1;
    }
  }
  if (cursor !== undefined && cursor.totalBlocks !== totalBlocks) {
    throw new PiTranscriptPageError(
      "cursor_projection",
      "Pi transcript block projection changed for this snapshot",
    );
  }
  const beforeBlock = requestedBefore ?? totalBlocks;
  if (beforeBlock < 0 || beforeBlock > totalBlocks) {
    throw new PiTranscriptPageError(
      "cursor_position",
      "transcript cursor points outside its snapshot",
    );
  }
  const blocks = requestedBefore === undefined ? newestRing : selected;
  const startBlock = Math.max(0, beforeBlock - blocks.length);
  const previousBefore = Math.min(totalBlocks, beforeBlock + limit);
  const previousCursor =
    beforeBlock >= totalBlocks
      ? undefined
      : encodeCursor({
          protocol: PI_TRANSCRIPT_CURSOR_PROTOCOL,
          sessionId: session.header.id,
          snapshotEntryCount,
          snapshotLastEntryId,
          snapshotSha256,
          totalBlocks,
          beforeBlock: previousBefore,
        });
  const nextCursor =
    startBlock === 0
      ? undefined
      : encodeCursor({
          protocol: PI_TRANSCRIPT_CURSOR_PROTOCOL,
          sessionId: session.header.id,
          snapshotEntryCount,
          snapshotLastEntryId,
          snapshotSha256,
          totalBlocks,
          beforeBlock: startBlock,
        });
  const usage = summarizeUsage(snapshotEntries);
  return {
    protocol: PI_TRANSCRIPT_PAGE_PROTOCOL,
    session: {
      id: session.header.id,
      version: session.header.version,
      ...(session.header.cwd === undefined ? {} : { cwd: session.header.cwd }),
      ...(session.header.parentSession === undefined
        ? {}
        : { parentSession: session.header.parentSession }),
    },
    snapshot: {
      entryCount: snapshotEntryCount,
      ...(snapshotLastEntryId === null ? {} : { lastEntryId: snapshotLastEntryId }),
      sha256: snapshotSha256,
    },
    totalBlocks,
    startBlock,
    blocks,
    usage: {
      input: usage.input.toString(),
      output: usage.output.toString(),
      cacheRead: usage.cacheRead.toString(),
      cacheWrite: usage.cacheWrite.toString(),
      newTokens: usage.newTokens.toString(),
      allTokens: usage.allTokens.toString(),
    },
    diagnostics: session.diagnostics
      .slice(0, MAX_DIAGNOSTICS)
      .map((entry) => boundedText(entry.message, MAX_DIAGNOSTIC_BYTES).value),
    ...(previousCursor === undefined ? {} : { previousCursor }),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function transcriptSnapshotHash(
  session: ParsedPiSession,
  entries: readonly PiSessionEntry[],
): Sha256Digest {
  return canonicalHash({ header: session.header, entries });
}

function projectEntry(entry: PiSessionEntry, branch: boolean): PiTranscriptBlock[] {
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
  if (entry.type === "message") return projectMessage(entry, branch, timestamp);
  if (entry.type === "compaction") {
    return blocks(
      entry.id,
      "compaction",
      "Context compacted",
      textValue(entry.summary) ?? textValue(entry.content) ?? "Pi compacted older session context.",
      branch,
      false,
      timestamp,
    );
  }
  if (entry.type === "branch_summary") {
    return blocks(
      entry.id,
      "compaction",
      "Branch summarized",
      textValue(entry.summary) ?? "Pi summarized an abandoned interactive branch.",
      true,
      false,
      timestamp,
    );
  }
  if (entry.type === "model_change" && typeof entry.modelId === "string") {
    const provider = typeof entry.provider === "string" ? `${entry.provider}/` : "";
    return blocks(
      entry.id,
      "notice",
      "Model changed",
      `${provider}${entry.modelId}`,
      branch,
      false,
      timestamp,
    );
  }
  if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
    return blocks(
      entry.id,
      "notice",
      "Reasoning changed",
      entry.thinkingLevel,
      branch,
      false,
      timestamp,
    );
  }
  if (entry.type === "label" && typeof entry.label === "string") {
    return blocks(entry.id, "notice", "Session label", entry.label, branch, false, timestamp);
  }
  if (entry.type === "session_info" && typeof entry.name === "string") {
    return blocks(entry.id, "notice", "Session name", entry.name, branch, false, timestamp);
  }
  if (entry.type === "custom_message" && entry.display !== false) {
    const visible = contentText(entry.content);
    const markdown = visible.length === 0 ? textValue(entry.message) : visible;
    return markdown === undefined
      ? []
      : blocks(entry.id, "notice", "Session note", markdown, branch, false, timestamp);
  }
  // Koni's mapping and authorization custom entries remain in canonical JSONL but are deliberately
  // audit metadata rather than chat. Unknown future state entries likewise stay losslessly stored.
  return [];
}

function projectMessage(
  entry: PiSessionEntry,
  branch: boolean,
  entryTimestamp: string | undefined,
): PiTranscriptBlock[] {
  const message = record(entry.message);
  if (message === undefined || typeof message.role !== "string") return [];
  const timestamp = safeIsoTimestamp(message.timestamp) ?? entryTimestamp;
  if (message.role === "user") {
    const text = contentText(message.content);
    return text.length === 0
      ? []
      : blocks(entry.id, "user", "You", text, branch, false, timestamp, "user");
  }
  if (message.role === "toolResult") {
    const title =
      typeof message.toolName === "string" ? humanToolName(message.toolName) : "Tool result";
    const text =
      contentText(message.content) || summarizeObject(message.details) || "Tool completed.";
    return blocks(
      entry.id,
      "tool_result",
      title,
      text,
      branch,
      message.isError === true,
      timestamp,
      "result",
    );
  }
  if (message.role !== "assistant") return [];
  const output: PiTranscriptBlock[] = [];
  if (typeof message.content === "string" && message.content.trim().length > 0) {
    output.push(
      ...blocks(
        entry.id,
        "assistant",
        "Assistant",
        message.content,
        branch,
        false,
        timestamp,
        "assistant",
      ),
    );
  } else if (Array.isArray(message.content)) {
    for (const [index, unknownContent] of message.content.entries()) {
      const content = record(unknownContent);
      if (content === undefined || typeof content.type !== "string") continue;
      if (
        content.type === "text" &&
        typeof content.text === "string" &&
        content.text.trim().length > 0
      ) {
        output.push(
          ...blocks(
            entry.id,
            "assistant",
            "Assistant",
            content.text,
            branch,
            false,
            timestamp,
            `assistant-${index}`,
          ),
        );
      } else if (content.type === "thinking") {
        const reasoning =
          typeof content.thinking === "string" && content.thinking.trim().length > 0
            ? content.thinking
            : content.redacted === true
              ? "Reasoning was redacted by the provider. Its opaque continuation signature remains only in canonical Pi JSONL."
              : undefined;
        if (reasoning !== undefined) {
          output.push(
            ...blocks(
              entry.id,
              "thinking",
              "Reasoning",
              reasoning,
              branch,
              false,
              timestamp,
              `thinking-${index}`,
            ),
          );
        }
      } else if (content.type === "toolCall" && typeof content.name === "string") {
        output.push(
          ...blocks(
            entry.id,
            "tool_call",
            humanToolName(content.name),
            summarizeArguments(content.arguments),
            branch,
            false,
            timestamp,
            `tool-${index}`,
          ),
        );
      }
    }
  }
  if (typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0) {
    output.push(
      ...blocks(
        entry.id,
        "notice",
        "Agent error",
        message.errorMessage,
        branch,
        true,
        timestamp,
        "error",
      ),
    );
  }
  return output;
}

function blocks(
  entryId: string,
  kind: PiTranscriptBlockKind,
  title: string,
  markdown: string,
  branch: boolean,
  error: boolean,
  timestamp?: string,
  suffix?: string,
): PiTranscriptBlock[] {
  const safeTitle = sanitizePiTranscriptDisplayText(title);
  const safeMarkdown = sanitizePiTranscriptDisplayText(markdown);
  const boundedTitle = boundedText(safeTitle, MAX_TITLE_BYTES);
  const markdownSource = boundedTitle.truncated
    ? `**Complete title:** ${safeTitle}\n\n${safeMarkdown}`
    : safeMarkdown;
  const markdownChunks = splitUtf8(markdownSource, MAX_MARKDOWN_BYTES);
  const totalBytes = Buffer.byteLength(markdownSource, "utf8");
  const baseId = suffix === undefined ? entryId : `${entryId}:${suffix}`;
  return markdownChunks.map((part, index) => ({
    id: markdownChunks.length === 1 ? baseId : `${baseId}:chunk-${index + 1}`,
    kind,
    title: boundedTitle.value,
    markdown: part,
    ...(timestamp === undefined ? {} : { timestamp }),
    branch: branch && index === 0,
    error,
    truncated: markdownChunks.length > 1 || boundedTitle.truncated,
    ...(markdownChunks.length === 1 && !boundedTitle.truncated
      ? {}
      : {
          chunk: { index: index + 1, total: markdownChunks.length, totalBytes },
        }),
  }));
}

function encodeCursor(cursor: PiTranscriptCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): PiTranscriptCursor {
  if (
    Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new PiTranscriptPageError(
      "cursor_shape",
      "transcript cursor is empty, oversized, or malformed",
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new PiTranscriptPageError("cursor_shape", "transcript cursor is not valid encoded JSON");
  }
  const cursor = record(decoded);
  const expectedKeys = [
    "beforeBlock",
    "protocol",
    "sessionId",
    "snapshotEntryCount",
    "snapshotLastEntryId",
    "snapshotSha256",
    "totalBlocks",
  ];
  if (
    cursor === undefined ||
    Object.keys(cursor).sort().join("\u0000") !== expectedKeys.sort().join("\u0000") ||
    cursor.protocol !== PI_TRANSCRIPT_CURSOR_PROTOCOL ||
    typeof cursor.sessionId !== "string" ||
    cursor.sessionId.length === 0 ||
    cursor.sessionId.length > 128 ||
    !Number.isSafeInteger(cursor.snapshotEntryCount) ||
    Number(cursor.snapshotEntryCount) < 0 ||
    !(cursor.snapshotLastEntryId === null || typeof cursor.snapshotLastEntryId === "string") ||
    !isSha256Digest(cursor.snapshotSha256) ||
    !Number.isSafeInteger(cursor.totalBlocks) ||
    Number(cursor.totalBlocks) < 0 ||
    !Number.isSafeInteger(cursor.beforeBlock) ||
    Number(cursor.beforeBlock) < 0
  ) {
    throw new PiTranscriptPageError("cursor_shape", "transcript cursor fields are invalid");
  }
  return cursor as unknown as PiTranscriptCursor;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      const content = record(item);
      if (content?.type === "text" && typeof content.text === "string") return content.text;
      if (content?.type === "image") return imageAttachmentSummary(content);
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function imageAttachmentSummary(content: Record<string, unknown>): string {
  const rawMime =
    typeof content.mimeType === "string" && content.mimeType.trim().length > 0
      ? content.mimeType.trim()
      : "unknown type";
  const mime = boundedText(sanitizePiTranscriptDisplayText(rawMime), 128).value;
  const bytes = decodedBase64ByteLength(content.data);
  return bytes === undefined
    ? `Image attachment · ${mime} · encoded size unavailable`
    : `Image attachment · ${mime} · ${bytes.toLocaleString("en-US")} ${bytes === 1 ? "byte" : "bytes"}`;
}

function decodedBase64ByteLength(value: unknown): number | undefined {
  if (
    typeof value !== "string" ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  ) {
    return undefined;
  }
  const firstPadding = value.indexOf("=");
  if (firstPadding >= 0 && firstPadding < value.length - 2) return undefined;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value;
  const nested = record(value);
  return nested === undefined ? undefined : (textValue(nested.text) ?? textValue(nested.summary));
}

function safeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined;
}

function humanToolName(value: string): string {
  return value
    .replace(/^koni_/u, "")
    .replace(/[_-]+/gu, " ")
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function summarizeArguments(value: unknown): string {
  const source = record(value);
  if (source === undefined) return "Called tool.";
  const fields = Object.entries(source).map(([key, item]) => {
    const rendered = typeof item === "string" ? item : JSON.stringify(item, null, 2);
    return typeof item === "string"
      ? `- **${humanToolName(key)}:** ${rendered}`
      : `- **${humanToolName(key)}:**\n\n\`\`\`json\n${rendered ?? "null"}\n\`\`\``;
  });
  return fields.length === 0 ? "Called tool." : fields.join("\n");
}

function summarizeObject(value: unknown): string {
  const source = record(value);
  if (source === undefined) return "";
  if (typeof source.summary === "string") return source.summary;
  return JSON.stringify(source, null, 2) ?? "";
}

/** Strip terminal protocols before chunk boundaries are chosen, so an escape cannot straddle pages. */
export function sanitizePiTranscriptDisplayText(value: string): string {
  const output: string[] = [];
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const next = value.charCodeAt(index + 1);
      if (next === 0x5b) index = consumeCsi(value, index + 2);
      else if (next === 0x5d) index = consumeStringControl(value, index + 2, true);
      else if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        index = consumeStringControl(value, index + 2, false);
      } else index = Math.min(value.length, index + 2);
      continue;
    }
    if (code === 0x9b) {
      index = consumeCsi(value, index + 1);
      continue;
    }
    if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      index = consumeStringControl(value, index + 1, code === 0x9d);
      continue;
    }
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f)
    ) {
      output.push("�");
      index += 1;
      continue;
    }
    const point = value.codePointAt(index)!;
    // Bidirectional/invisible controls can visually reorder authority text and are not content.
    if (
      !(point >= 0x200b && point <= 0x200f) &&
      !(point >= 0x202a && point <= 0x202e) &&
      !(point >= 0x2060 && point <= 0x206f) &&
      point !== 0xfeff
    ) {
      output.push(String.fromCodePoint(point));
    }
    index += point > 0xffff ? 2 : 1;
  }
  return output.join("");
}

function consumeCsi(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    index += 1;
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return index;
}

function consumeStringControl(value: string, start: number, bellTerminates: boolean): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (bellTerminates && code === 0x07) return index + 1;
    if (code === 0x9c) return index + 1;
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
    index += 1;
  }
  return index;
}

function splitUtf8(value: string, maximumBytes: number): string[] {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return [value];
  const chunks: string[] = [];
  let parts: string[] = [];
  let bytes = 0;
  for (const point of value) {
    const size = Buffer.byteLength(point, "utf8");
    if (bytes > 0 && bytes + size > maximumBytes) {
      chunks.push(parts.join(""));
      parts = [];
      bytes = 0;
    }
    parts.push(point);
    bytes += size;
  }
  if (parts.length > 0 || chunks.length === 0) chunks.push(parts.join(""));
  return chunks;
}

function boundedText(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return { value, truncated: false };
  const suffix = "\n\n… truncated in this view; complete bytes remain in canonical Pi JSONL.";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const prefixBudget = Math.max(0, maximumBytes - suffixBytes);
  let prefix = bytes
    .subarray(0, prefixBudget)
    .toString("utf8")
    .replace(/\uFFFD+$/u, "");
  while (Buffer.byteLength(prefix, "utf8") > prefixBudget) prefix = prefix.slice(0, -1);
  return { value: `${prefix}${suffix}`, truncated: true };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
