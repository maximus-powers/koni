import {
  PI_TRANSCRIPT_PAGE_PROTOCOL,
  sanitizePiTranscriptDisplayText,
  type PiTranscriptBlockKind,
} from "../pi/transcript-page.js";
import { isSha256Digest, type Sha256Digest } from "../shared/canonical.js";

export type TranscriptBlockKind = PiTranscriptBlockKind;

export interface TranscriptBlock {
  id: string;
  kind: TranscriptBlockKind;
  title: string;
  markdown: string;
  timestamp?: string;
  branch: boolean;
  error: boolean;
  chunk?: {
    index: number;
    total: number;
    totalBytes: number;
  };
}

export interface TranscriptPageProjection {
  sessionId: string;
  snapshot: {
    entryCount: number;
    lastEntryId?: string;
    sha256: Sha256Digest;
  };
  totalBlocks: number;
  startBlock: number;
  blocks: TranscriptBlock[];
  diagnostics: string[];
  previousCursor?: string;
  nextCursor?: string;
}

export interface TranscriptProjection {
  blocks: TranscriptBlock[];
  diagnostics: string[];
}

/** Authority already bounds each block; this is a presentation-boundary defense in depth. */
export const MAX_PROJECTED_TRANSCRIPT_BLOCK_CHARACTERS = 64 * 1024;
/** `run.transcript` rejects larger pages and the control center always asks for the maximum. */
export const TRANSCRIPT_PAGE_LIMIT = 64;
const MAX_TRANSCRIPT_TITLE_BYTES = 16 * 1024;
const MAX_TRANSCRIPT_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_TRANSCRIPT_DIAGNOSTICS = 32;
const MAX_TRANSCRIPT_ID_CHARACTERS = 256;
const MAX_TRANSCRIPT_SESSION_ID_CHARACTERS = 128;
const MAX_TRANSCRIPT_CURSOR_BYTES = 4 * 1024;
const MAX_TRANSCRIPT_TIMESTAMP_BYTES = 256;

const TRANSCRIPT_BLOCK_KINDS = new Set<TranscriptBlockKind>([
  "user",
  "assistant",
  "thinking",
  "tool_call",
  "tool_result",
  "compaction",
  "notice",
]);

/**
 * Validate one semantic page from Koni authority. Projection of native Pi entries belongs to
 * the authority; the control center deliberately does not parse or reconstruct Pi JSONL.
 */
export function parsePiTranscriptPage(value: unknown): TranscriptPageProjection {
  const page = record(value);
  const session = record(page?.session);
  const snapshot = record(page?.snapshot);
  if (
    page === undefined ||
    page.protocol !== PI_TRANSCRIPT_PAGE_PROTOCOL ||
    session === undefined ||
    typeof session.id !== "string" ||
    session.id.length === 0 || session.id.length > MAX_TRANSCRIPT_SESSION_ID_CHARACTERS ||
    snapshot === undefined ||
    !Number.isSafeInteger(snapshot.entryCount) ||
    (snapshot.entryCount as number) < 0 ||
    !isSha256Digest(snapshot.sha256) ||
    (snapshot.lastEntryId !== undefined && (
      typeof snapshot.lastEntryId !== "string" || snapshot.lastEntryId.length === 0
      || snapshot.lastEntryId.length > MAX_TRANSCRIPT_ID_CHARACTERS
    )) ||
    !Number.isSafeInteger(page.totalBlocks) ||
    (page.totalBlocks as number) < 0 ||
    !Number.isSafeInteger(page.startBlock) ||
    (page.startBlock as number) < 0 ||
    !Array.isArray(page.blocks) ||
    page.blocks.length > TRANSCRIPT_PAGE_LIMIT ||
    !Array.isArray(page.diagnostics) ||
    page.diagnostics.length > MAX_TRANSCRIPT_DIAGNOSTICS ||
    page.diagnostics.some((diagnostic) =>
      typeof diagnostic !== "string" ||
      Buffer.byteLength(diagnostic, "utf8") > MAX_TRANSCRIPT_DIAGNOSTIC_BYTES) ||
    (page.previousCursor !== undefined && (
      typeof page.previousCursor !== "string" || page.previousCursor.length === 0
      || Buffer.byteLength(page.previousCursor, "utf8") > MAX_TRANSCRIPT_CURSOR_BYTES
    )) ||
    (page.nextCursor !== undefined && (
      typeof page.nextCursor !== "string" || page.nextCursor.length === 0
      || Buffer.byteLength(page.nextCursor, "utf8") > MAX_TRANSCRIPT_CURSOR_BYTES
    ))
  ) {
    throw new Error("authority returned an invalid Pi transcript page");
  }
  if (((snapshot.entryCount as number) > 0) !== (snapshot.lastEntryId !== undefined)) {
    throw new Error("authority transcript snapshot has an inconsistent terminal entry identity");
  }

  const blocks = page.blocks.map((value): TranscriptBlock => {
    const block = record(value);
    if (
      block === undefined ||
      typeof block.id !== "string" ||
      block.id.length === 0 || block.id.length > MAX_TRANSCRIPT_ID_CHARACTERS ||
      typeof block.kind !== "string" ||
      !TRANSCRIPT_BLOCK_KINDS.has(block.kind as TranscriptBlockKind) ||
      typeof block.title !== "string" ||
      typeof block.markdown !== "string" ||
      typeof block.branch !== "boolean" ||
      typeof block.error !== "boolean" ||
      typeof block.truncated !== "boolean" ||
      (block.timestamp !== undefined && (
        typeof block.timestamp !== "string" ||
        Buffer.byteLength(block.timestamp, "utf8") > MAX_TRANSCRIPT_TIMESTAMP_BYTES
      ))
    ) {
      throw new Error("authority returned an invalid Pi transcript block");
    }
    const chunk = block.chunk === undefined ? undefined : record(block.chunk);
    if (block.chunk !== undefined && chunk === undefined) {
      throw new Error("authority returned invalid Pi transcript chunk metadata");
    }
    if (chunk !== undefined && (
      !Number.isSafeInteger(chunk.index) || (chunk.index as number) < 1 ||
      !Number.isSafeInteger(chunk.total) || (chunk.total as number) < 1 ||
      (chunk.index as number) > (chunk.total as number) ||
      !Number.isSafeInteger(chunk.totalBytes) || (chunk.totalBytes as number) < 0
    )) throw new Error("authority returned invalid Pi transcript chunk metadata");
    if ((block.truncated === true) !== (chunk !== undefined)) {
      throw new Error("authority transcript truncation does not expose one complete chunk path");
    }
    if (Buffer.byteLength(block.markdown, "utf8") > MAX_PROJECTED_TRANSCRIPT_BLOCK_CHARACTERS ||
        Buffer.byteLength(block.title, "utf8") > MAX_TRANSCRIPT_TITLE_BYTES) {
      throw new Error("authority returned an oversized Pi transcript block");
    }
    const title = sanitizePiTranscriptDisplayText(block.title);
    const markdown = sanitizePiTranscriptDisplayText(block.markdown);
    if (chunk !== undefined && (chunk.totalBytes as number) < Buffer.byteLength(markdown, "utf8")) {
      throw new Error("authority transcript chunk is larger than its declared complete content");
    }
    if (chunk !== undefined && !block.id.endsWith(`:chunk-${String(chunk.index)}`)) {
      throw new Error("authority transcript chunk identity disagrees with its ordinal");
    }
    return {
      id: block.id,
      kind: block.kind as TranscriptBlockKind,
      title,
      markdown,
      ...(block.timestamp === undefined ? {} : { timestamp: block.timestamp }),
      branch: block.branch,
      error: block.error,
      ...(chunk === undefined ? {} : {
        chunk: {
          index: chunk.index as number,
          total: chunk.total as number,
          totalBytes: chunk.totalBytes as number,
        },
      }),
    };
  });

  const totalBlocks = page.totalBlocks as number;
  const startBlock = page.startBlock as number;
  if (blocks.length > totalBlocks || startBlock > totalBlocks || startBlock + blocks.length > totalBlocks) {
    throw new Error("authority transcript page exceeds its total block count");
  }
  if (blocks.length === 0 && (startBlock !== 0 || totalBlocks !== 0)) {
    throw new Error("authority returned an empty window for non-empty Pi transcript history");
  }
  if ((page.previousCursor !== undefined) !== (startBlock + blocks.length < totalBlocks) ||
      (page.nextCursor !== undefined) !== (startBlock > 0)) {
    throw new Error("authority transcript cursors disagree with their window ordinals");
  }
  if (new Set(blocks.map((block) => block.id)).size !== blocks.length) {
    throw new Error("authority returned duplicate Pi transcript blocks in one window");
  }
  validateChunkGroups(blocks);
  return {
    sessionId: session.id as string,
    snapshot: {
      entryCount: snapshot.entryCount as number,
      ...(snapshot.lastEntryId === undefined ? {} : { lastEntryId: snapshot.lastEntryId as string }),
      sha256: snapshot.sha256 as Sha256Digest,
    },
    totalBlocks,
    startBlock,
    blocks,
    diagnostics: (page.diagnostics as string[]).map(sanitizePiTranscriptDisplayText),
    ...(page.previousCursor === undefined ? {} : { previousCursor: page.previousCursor as string }),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor as string }),
  };
}

/**
 * Compatibility helper for tests and non-controller callers. Production retains one page and
 * navigates adjacent windows; this helper requires one stable, exactly contiguous page sequence.
 */
export function assemblePiTranscriptPages(
  newestToOldestPages: readonly TranscriptPageProjection[],
): TranscriptProjection {
  if (newestToOldestPages.length === 0) return { blocks: [], diagnostics: [] };
  const totalBlocks = newestToOldestPages[0]!.totalBlocks;
  const first = newestToOldestPages[0]!;
  if (newestToOldestPages.some((page) =>
    page.totalBlocks !== totalBlocks || page.sessionId !== first.sessionId ||
    page.snapshot.sha256 !== first.snapshot.sha256 ||
    page.snapshot.entryCount !== first.snapshot.entryCount ||
    page.snapshot.lastEntryId !== first.snapshot.lastEntryId
  )) {
    throw new Error("authority transcript pages do not describe one stable snapshot");
  }

  const chronological = [...newestToOldestPages]
    .reverse()
    .flatMap((page) => page.blocks);
  if (chronological.length > totalBlocks) {
    throw new Error("authority transcript pages exceed their total block count");
  }
  if (new Set(chronological.map((block) => block.id)).size !== chronological.length) {
    throw new Error("authority transcript pages repeat one projected block");
  }
  validateChunkGroups(chronological);
  for (let index = 1; index < newestToOldestPages.length; index += 1) {
    const newer = newestToOldestPages[index - 1]!;
    const older = newestToOldestPages[index]!;
    if (older.startBlock + older.blocks.length !== newer.startBlock) {
      throw new Error("authority transcript pages are not exactly adjacent");
    }
  }
  const diagnostics = [...new Set(newestToOldestPages.flatMap((page) => page.diagnostics))];
  return { blocks: chronological, diagnostics };
}

function validateChunkGroups(blocks: readonly TranscriptBlock[]): void {
  const groups = new Map<string, { total: number; totalBytes: number; indexes: number[]; bytes: number }>();
  for (const block of blocks) {
    if (block.chunk === undefined) continue;
    const suffix = `:chunk-${String(block.chunk.index)}`;
    const base = block.id.slice(0, -suffix.length);
    if (base.length === 0) throw new Error("authority returned an empty Pi transcript chunk identity");
    const group = groups.get(base);
    if (group === undefined) {
      groups.set(base, {
        total: block.chunk.total,
        totalBytes: block.chunk.totalBytes,
        indexes: [block.chunk.index],
        bytes: Buffer.byteLength(block.markdown, "utf8"),
      });
      continue;
    }
    if (group.total !== block.chunk.total || group.totalBytes !== block.chunk.totalBytes) {
      throw new Error("authority transcript chunks disagree about their complete content");
    }
    group.indexes.push(block.chunk.index);
    group.bytes += Buffer.byteLength(block.markdown, "utf8");
  }
  for (const group of groups.values()) {
    if (new Set(group.indexes).size !== group.indexes.length || group.indexes.some((value, index) =>
      index > 0 && value !== group.indexes[index - 1]! + 1)) {
      throw new Error("authority returned duplicate or non-contiguous Pi transcript chunks");
    }
    if (group.indexes[0] === 1 && group.indexes.at(-1) === group.total &&
        group.bytes !== group.totalBytes) {
      throw new Error("authority transcript chunks do not reconstruct their declared complete content");
    }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
