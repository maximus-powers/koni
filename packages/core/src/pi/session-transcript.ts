import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";

const DEFAULT_MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_LINES = 200_000;
const MAX_SESSION_LINE_BYTES = 24 * 1024 * 1024;

export interface PiSessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp?: string;
  cwd?: string;
  parentSession?: string;
  [key: string]: unknown;
}

export interface PiSessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  [key: string]: unknown;
}

export interface TranscriptDiagnostic {
  code: "truncated_tail" | "malformed_line";
  line: number;
  message: string;
}

export interface ParsedPiSession {
  header: PiSessionHeader;
  entries: readonly PiSessionEntry[];
  byId: ReadonlyMap<string, PiSessionEntry>;
  lastEntryId?: string;
  diagnostics: readonly TranscriptDiagnostic[];
}

export interface TokenUsageTotals {
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite: bigint;
  newTokens: bigint;
  allTokens: bigint;
}

export interface AutonomousPiSessionBinding {
  sessionId: string;
  cwd: string;
  /** Exact authenticated Pi parent path for a compiler-authorized conversation fork. */
  parentSession?: string;
}

export class SessionTranscriptError extends Error {
  public readonly code: string;
  public readonly line: number | undefined;

  public constructor(code: string, message: string, line?: number) {
    super(message);
    this.name = "SessionTranscriptError";
    this.code = code;
    this.line = line;
  }
}

export async function readPiSession(
  filePath: string,
  options: { allowTruncatedTail?: boolean; maxBytes?: number } = {},
): Promise<ParsedPiSession> {
  const bytes = await readFile(filePath);
  return parsePiSession(bytes, options);
}

/**
 * Fsync and read a session through one no-follow file identity.
 *
 * Provider-usage settlement uses this stronger boundary so an authority record can never outlive
 * the canonical assistant entry that justifies it. The path is re-statted around the handle read;
 * replacement, concurrent mutation, hard links, weak permissions, or foreign ownership fail
 * closed rather than settling from ambiguous bytes.
 */
export async function readPiSessionDurably(
  filePath: string,
  options: { allowTruncatedTail?: boolean; maxBytes?: number } = {},
): Promise<ParsedPiSession> {
  const maximumBytes = options.maxBytes ?? DEFAULT_MAX_SESSION_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new SessionTranscriptError("session_size", "Pi session byte limit is invalid");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, constants.O_RDWR | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    const pathBefore = await lstat(filePath, { bigint: true });
    assertDurableSessionIdentity(before, pathBefore, maximumBytes);
    await handle.sync();
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(filePath, { bigint: true });
    assertDurableSessionIdentity(after, pathAfter, maximumBytes);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      bytes.byteLength !== Number(after.size)
    ) {
      throw new SessionTranscriptError(
        "session_race",
        "Pi session changed while authority was fsyncing it",
      );
    }
    return parsePiSession(bytes, options);
  } catch (error) {
    if (error instanceof SessionTranscriptError) throw error;
    throw new SessionTranscriptError(
      "session_durability",
      `Pi session could not be authenticated and fsynced: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function parsePiSession(
  input: Uint8Array | string,
  options: { allowTruncatedTail?: boolean; maxBytes?: number } = {},
): ParsedPiSession {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const maximumBytes = options.maxBytes ?? DEFAULT_MAX_SESSION_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new SessionTranscriptError("session_size", "Pi session byte limit is invalid");
  }
  if (bytes.byteLength > maximumBytes) {
    throw new SessionTranscriptError("session_size", `Pi session exceeds ${maximumBytes} bytes`);
  }
  const hasFinalLf = bytes.byteLength === 0 || bytes.at(-1) === 0x0a;
  let decoded: string;
  try {
    // Pi JSONL is canonical UTF-8. Replacement decoding could turn corrupted transcript bytes
    // into different valid JSON and then incorrectly authenticate/replay that changed meaning.
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new SessionTranscriptError("session_encoding", "Pi session is not valid UTF-8");
  }
  const rawLines = decoded.split("\n");
  if (hasFinalLf) {
    rawLines.pop();
  }
  if (rawLines.length > MAX_SESSION_LINES) {
    throw new SessionTranscriptError("line_count", `Pi session exceeds ${MAX_SESSION_LINES} lines`);
  }
  if (rawLines.length === 0) {
    throw new SessionTranscriptError("missing_header", "Pi session is empty");
  }

  const diagnostics: TranscriptDiagnostic[] = [];
  const values: unknown[] = [];
  for (const [index, line] of rawLines.entries()) {
    const lineNumber = index + 1;
    const isUnterminatedTail = index === rawLines.length - 1 && !hasFinalLf;
    if (Buffer.byteLength(line, "utf8") > MAX_SESSION_LINE_BYTES) {
      throw new SessionTranscriptError(
        "line_size",
        `Pi session line exceeds ${MAX_SESSION_LINE_BYTES} bytes`,
        lineNumber,
      );
    }
    if (line.length === 0) {
      throw new SessionTranscriptError(
        "blank_line",
        "Pi session contains a blank record",
        lineNumber,
      );
    }
    // Pi appends `JSON + LF` and does not prepend a separator. Even syntactically complete JSON
    // without its commit LF is therefore uncommitted: reopening and appending would concatenate
    // the next record onto it. Ignore/block that tail under crash-tolerant recovery.
    if (isUnterminatedTail && options.allowTruncatedTail === true) {
      diagnostics.push({
        code: "truncated_tail",
        line: lineNumber,
        message: "Ignored an unterminated final Pi session record",
      });
      break;
    }
    try {
      values.push(JSON.parse(line));
    } catch {
      const isTail = isUnterminatedTail;
      if (isTail && options.allowTruncatedTail === true) {
        diagnostics.push({
          code: "truncated_tail",
          line: lineNumber,
          message: "Ignored an incomplete final Pi session record",
        });
        break;
      }
      throw new SessionTranscriptError(
        isTail ? "truncated_tail" : "malformed_line",
        `Pi session line ${lineNumber} is not valid JSON`,
        lineNumber,
      );
    }
  }

  const header = validateHeader(values[0]);
  const entries: PiSessionEntry[] = [];
  const byId = new Map<string, PiSessionEntry>();
  for (let index = 1; index < values.length; index += 1) {
    const entry = validateEntry(values[index], index + 1);
    if (byId.has(entry.id)) {
      throw new SessionTranscriptError(
        "duplicate_entry",
        `Pi session entry id is duplicated: ${entry.id}`,
        index + 1,
      );
    }
    byId.set(entry.id, entry);
    entries.push(entry);
  }
  for (const entry of entries) {
    if (entry.parentId !== null && !byId.has(entry.parentId)) {
      throw new SessionTranscriptError(
        "orphan_entry",
        `Pi session entry ${entry.id} has missing parent ${entry.parentId}`,
      );
    }
  }
  assertAcyclic(entries, byId);
  return {
    header,
    entries,
    byId,
    ...(entries.length === 0 ? {} : { lastEntryId: entries.at(-1)!.id }),
    diagnostics,
  };
}

export function transcriptPath(session: ParsedPiSession, leafId: string): PiSessionEntry[] {
  const result: PiSessionEntry[] = [];
  const seen = new Set<string>();
  let current = session.byId.get(leafId);
  if (current === undefined) {
    throw new SessionTranscriptError("missing_leaf", `Pi session leaf does not exist: ${leafId}`);
  }
  while (current !== undefined) {
    if (seen.has(current.id)) {
      throw new SessionTranscriptError("parent_cycle", `Pi session parent cycle at ${current.id}`);
    }
    seen.add(current.id);
    result.push(current);
    current = current.parentId === null ? undefined : session.byId.get(current.parentId);
  }
  result.reverse();
  return result;
}

/**
 * Authenticate the Pi-native shape shared by every autonomous Koni attempt.
 *
 * Interactive operator sessions may navigate mutable Pi trees. Autonomous attempts remain one
 * immutable linear session each. A same-scope retry/rework/recovery may carry one exact
 * compiler-authenticated `parentSession` path, but in-file navigation and unbound ancestry remain
 * forbidden. This assertion is intentionally reusable by recovery, transcript paging, and
 * authority admission.
 */
export function assertAutonomousPiSession(
  session: ParsedPiSession,
  binding: AutonomousPiSessionBinding,
): void {
  if (session.header.id !== binding.sessionId || session.header.cwd !== binding.cwd) {
    throw new SessionTranscriptError(
      "autonomous_binding",
      "Pi session header does not match its autonomous attempt binding",
      1,
    );
  }
  if (session.header.parentSession !== binding.parentSession) {
    throw new SessionTranscriptError(
      "autonomous_parent_session",
      "Pi parentSession does not match the autonomous attempt's conversation-fork binding",
      1,
    );
  }
  let expectedParent: string | null = null;
  for (const [index, entry] of session.entries.entries()) {
    if (entry.parentId !== expectedParent) {
      throw new SessionTranscriptError(
        "autonomous_branch",
        `autonomous Pi session entry ${entry.id} does not extend its single linear leaf`,
        index + 2,
      );
    }
    expectedParent = entry.id;
  }
}

export function summarizeUsage(entries: readonly PiSessionEntry[]): TokenUsageTotals {
  let input = 0n;
  let output = 0n;
  let cacheRead = 0n;
  let cacheWrite = 0n;
  for (const entry of entries) {
    const usage = findUsage(entry);
    if (usage === undefined) {
      continue;
    }
    input += safeTokenCount(usage.input, "input");
    output += safeTokenCount(usage.output, "output");
    cacheRead += safeTokenCount(usage.cacheRead, "cacheRead");
    cacheWrite += safeTokenCount(usage.cacheWrite, "cacheWrite");
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    newTokens: input + output,
    allTokens: input + output + cacheRead + cacheWrite,
  };
}

function validateHeader(value: unknown): PiSessionHeader {
  if (!isRecord(value) || value.type !== "session" || typeof value.id !== "string") {
    throw new SessionTranscriptError("invalid_header", "Pi session header is invalid", 1);
  }
  if (!Number.isSafeInteger(value.version) || Number(value.version) !== 3) {
    throw new SessionTranscriptError(
      "session_version",
      `unsupported Pi session version ${String(value.version)}`,
      1,
    );
  }
  validateIdentity(value.id, "session", 1);
  validateOptionalText(value.timestamp, "session timestamp", 1, 256);
  validateOptionalText(value.cwd, "session cwd", 1, 64 * 1024);
  validateOptionalText(value.parentSession, "parent session path", 1, 64 * 1024);
  return value as PiSessionHeader;
}

function assertDurableSessionIdentity(
  handle: BigIntStats,
  pathIdentity: BigIntStats,
  maximumBytes: number,
): void {
  const expectedUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
  if (
    !handle.isFile() ||
    !pathIdentity.isFile() ||
    handle.dev !== pathIdentity.dev ||
    handle.ino !== pathIdentity.ino ||
    handle.nlink !== 1n ||
    pathIdentity.nlink !== 1n ||
    (handle.mode & 0o777n) !== 0o600n ||
    (pathIdentity.mode & 0o777n) !== 0o600n ||
    (expectedUid !== undefined &&
      (handle.uid !== expectedUid || pathIdentity.uid !== expectedUid)) ||
    handle.size < 1n ||
    handle.size > BigInt(maximumBytes) ||
    pathIdentity.size !== handle.size
  ) {
    throw new SessionTranscriptError(
      "session_identity",
      "Pi session is not one private, owner-bound, stable regular file",
    );
  }
}

function validateEntry(value: unknown, line: number): PiSessionEntry {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    typeof value.id !== "string" ||
    !(value.parentId === null || typeof value.parentId === "string")
  ) {
    throw new SessionTranscriptError("invalid_entry", "Pi session entry is invalid", line);
  }
  validateIdentity(value.id, "entry", line);
  validateIdentity(value.type, "entry type", line);
  if (value.parentId !== null) {
    validateIdentity(value.parentId, "parent", line);
  }
  validateOptionalText(value.timestamp, "entry timestamp", line, 256);
  return value as PiSessionEntry;
}

function validateOptionalText(
  value: unknown,
  kind: string,
  line: number,
  maximumBytes: number,
): void {
  if (value === undefined) return;
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    value.includes("\u0000")
  ) {
    throw new SessionTranscriptError("invalid_metadata", `Pi ${kind} is invalid`, line);
  }
}

function validateIdentity(value: string, kind: string, line: number): void {
  if (value.length === 0 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new SessionTranscriptError("invalid_identity", `Pi ${kind} identity is invalid`, line);
  }
}

function assertAcyclic(
  entries: readonly PiSessionEntry[],
  byId: ReadonlyMap<string, PiSessionEntry>,
): void {
  const settled = new Set<string>();
  for (const entry of entries) {
    const path = new Set<string>();
    let current: PiSessionEntry | undefined = entry;
    while (current !== undefined && !settled.has(current.id)) {
      if (path.has(current.id)) {
        throw new SessionTranscriptError(
          "parent_cycle",
          `Pi session parent cycle at ${current.id}`,
        );
      }
      path.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    for (const id of path) {
      settled.add(id);
    }
  }
}

function findUsage(entry: PiSessionEntry): Record<string, unknown> | undefined {
  const direct = entry.usage;
  if (isRecord(direct)) {
    return direct;
  }
  if (isRecord(entry.message) && isRecord(entry.message.usage)) {
    return entry.message.usage;
  }
  return undefined;
}

function safeTokenCount(value: unknown, field: string): bigint {
  if (value === undefined) {
    return 0n;
  }
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new SessionTranscriptError("usage_value", `Pi usage ${field} is not a safe token count`);
  }
  return BigInt(Number(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
