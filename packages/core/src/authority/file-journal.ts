import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  opendir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  MAX_JOURNAL_BYTES,
  MAX_TRANSACTION_BYTES,
  MAX_TRANSACTION_EFFECTS,
  MAX_TRANSACTION_PATH_BYTES,
  portableDurablePathIdentity,
  transactionPayloadBytes,
} from "./durable-limits.js";
import {
  DurableFileReadError,
  hashStableDurableFile,
  readStableDurableFile,
} from "./durable-file-read.js";

const JOURNAL_PROTOCOL = "koni.file-transaction.v1" as const;
const PREPARED_JOURNAL_TEMP = "journal.json.prepare" as const;

export interface TransactionWrite {
  path: string;
  bytes: Uint8Array;
  expectedSha256?: string | null;
}

export interface TransactionDelete {
  path: string;
  expectedSha256?: string;
}

interface JournalWrite {
  path: string;
  stage: string;
  sha256: string;
  sizeBytes: number;
  expectedSha256?: string | null;
}

interface JournalDelete {
  path: string;
  expectedSha256?: string;
}

interface FileTransactionJournal {
  protocol: typeof JOURNAL_PROTOCOL;
  id: string;
  status: "prepared" | "committed";
  createdAt: string;
  writes: JournalWrite[];
  deletes: JournalDelete[];
}

export class FileJournalError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "FileJournalError";
    this.code = code;
  }
}

export class FileTransactionStore {
  readonly #root: string;
  readonly #transactionRoot: string;

  private constructor(root: string) {
    this.#root = root;
    this.#transactionRoot = path.join(root, ".transactions");
  }

  public static async open(root: string): Promise<FileTransactionStore> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const canonical = await realpath(root);
    const rootStat = await lstat(canonical);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new FileJournalError("unsafe_root", "transaction root must be a real directory");
    }
    const transactionRoot = path.join(canonical, ".transactions");
    try {
      await mkdir(transactionRoot, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const transactionStat = await lstat(transactionRoot);
    if (
      !transactionStat.isDirectory() ||
      transactionStat.isSymbolicLink() ||
      (await realpath(transactionRoot)) !== transactionRoot
    ) {
      throw new FileJournalError(
        "unsafe_transaction_root",
        "transaction journal root must be the exact real directory under state root",
      );
    }
    return new FileTransactionStore(canonical);
  }

  /** The exact realpath used for every transaction destination. */
  public canonicalRoot(): string {
    return this.#root;
  }

  public async prepare(
    id: string,
    writes: readonly TransactionWrite[],
    deletes: readonly TransactionDelete[] = [],
  ): Promise<void> {
    validateTransactionId(id);
    if (writes.length === 0 && deletes.length === 0) {
      throw new FileJournalError("empty_transaction", "a transaction must contain an effect");
    }
    if (
      !Number.isSafeInteger(writes.length) ||
      !Number.isSafeInteger(deletes.length) ||
      writes.length > MAX_TRANSACTION_EFFECTS - deletes.length
    ) {
      throw new FileJournalError(
        "transaction_effects",
        `transaction exceeds ${MAX_TRANSACTION_EFFECTS} durable effects`,
      );
    }
    const normalizedWrites = writes.map((write) => ({
      ...write,
      path: safeRelativePath(write.path),
    }));
    const normalizedDeletes = deletes.map((entry) => ({
      ...entry,
      path: safeRelativePath(entry.path),
    }));
    rejectDuplicateDestinations(normalizedWrites, normalizedDeletes);
    rejectDerivedTemporaryCollisions(id, normalizedWrites, normalizedDeletes);
    const totalBytes = transactionPayloadBytes(normalizedWrites);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TRANSACTION_BYTES) {
      throw new FileJournalError(
        "transaction_size",
        `transaction exceeds ${MAX_TRANSACTION_BYTES} bytes`,
      );
    }

    const journalWrites: JournalWrite[] = normalizedWrites.map((write, index) => ({
      path: write.path,
      stage: `stage/${String(index).padStart(6, "0")}`,
      sha256: sha256(write.bytes),
      sizeBytes: write.bytes.byteLength,
      ...(write.expectedSha256 === undefined ? {} : { expectedSha256: write.expectedSha256 }),
    }));
    const journal: FileTransactionJournal = {
      protocol: JOURNAL_PROTOCOL,
      id,
      status: "prepared",
      createdAt: new Date().toISOString(),
      writes: journalWrites,
      deletes: normalizedDeletes,
    };
    const journalBytes = encodeJournal(journal);

    for (const effect of [...normalizedWrites, ...normalizedDeletes]) {
      await this.#assertSafeDestination(effect.path);
    }
    for (const write of normalizedWrites) {
      await this.#verifyExpected(write.path, write.expectedSha256);
    }
    for (const entry of normalizedDeletes) {
      await this.#verifyExpected(entry.path, entry.expectedSha256);
    }
    // A transaction never owns a pre-existing handoff path. Prove that every derived path is
    // absent before publishing any stage or journal bytes; commit repeats this check atomically
    // with an exclusive hard-link handoff, so a later arrival also fails closed.
    for (const write of normalizedWrites) {
      const handoff = derivedTemporaryRelativePath(write.path, id);
      await this.#assertSafeDestination(handoff);
      await assertPathAbsent(path.join(this.#root, handoff), handoff);
    }

    const transactionDirectory = this.#transactionDirectory(id);
    try {
      await mkdir(transactionDirectory, { mode: 0o700 });
    } catch {
      throw new FileJournalError("transaction_exists", `transaction already exists: ${id}`);
    }
    const stageDirectory = path.join(transactionDirectory, "stage");
    await mkdir(stageDirectory, { mode: 0o700 });

    for (const [index, write] of normalizedWrites.entries()) {
      const stage = journalWrites[index]!.stage;
      const stagePath = path.join(transactionDirectory, stage);
      await writeDurableNewFile(stagePath, write.bytes);
    }
    // The journal is the prepared-transaction publication marker. Persist every stage entry before
    // publishing it, so recovery cannot observe a durable journal whose declared stage existed
    // only in volatile directory metadata.
    await syncDirectory(stageDirectory);
    await publishPreparedJournal(transactionDirectory, journalBytes);
    await syncDirectory(this.#transactionRoot);
  }

  public async commit(id: string): Promise<void> {
    validateTransactionId(id);
    const transactionDirectory = this.#transactionDirectory(id);
    const journalPath = path.join(transactionDirectory, "journal.json");
    const journal = await readJournal(journalPath);
    if (journal.id !== id) {
      throw new FileJournalError("journal_identity", "journal id does not match its directory");
    }
    if (journal.status === "committed") {
      return;
    }

    for (const write of journal.writes) {
      await this.#assertSafeDestination(write.path);
      const destinationHash = await hashExistingFile(path.join(this.#root, write.path));
      if (destinationHash !== write.sha256) {
        await this.#verifyExpected(write.path, write.expectedSha256);
        const stagePath = path.join(transactionDirectory, safeRelativePath(write.stage));
        const stageSha256 = await hashExistingFile(stagePath, write.sizeBytes);
        const destination = path.join(this.#root, write.path);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await this.#assertSafeDestination(write.path);
        const temporaryRelative = derivedTemporaryRelativePath(write.path, id);
        const temporary = path.join(this.#root, temporaryRelative);
        if (stageSha256 === undefined) {
          // A crash after stage -> temporary but before temporary -> destination leaves the exact
          // payload at this deterministic handoff path. It is usable only while the destination
          // still matches its expected preimage and the descriptor-pinned regular file has the
          // exact declared size and hash.
          const temporarySha256 = await hashExistingFile(temporary, write.sizeBytes);
          if (temporarySha256 !== write.sha256) {
            throw new FileJournalError(
              "temporary_corrupt",
              `transaction handoff bytes do not match journal: ${write.path}`,
            );
          }
        } else if (stageSha256 !== write.sha256) {
          throw new FileJournalError(
            "stage_corrupt",
            `staged bytes do not match journal: ${write.path}`,
          );
        } else {
          // Publish the handoff without replacement. A crash between the exclusive link and stage
          // unlink can leave both names for the same inode; that exact state is the only present
          // temporary accepted while a stage remains. Any unrelated file is preserved and blocks
          // the transaction rather than being deleted.
          const existingHandoff = await handoffMatchesStage(stagePath, temporary, write);
          if (existingHandoff === "different") {
            throw new FileJournalError(
              "temporary_exists",
              `transaction handoff path already exists: ${write.path}`,
            );
          }
          if (existingHandoff === "absent") {
            try {
              await link(stagePath, temporary);
            } catch (error) {
              if (isCode(error, "EEXIST")) {
                throw new FileJournalError(
                  "temporary_exists",
                  `transaction handoff path already exists: ${write.path}`,
                );
              }
              throw error;
            }
          }
          await syncDirectory(path.dirname(temporary));
          await unlink(stagePath);
          await syncDirectory(path.dirname(stagePath));
          const temporarySha256 = await hashExistingFile(temporary, write.sizeBytes);
          if (temporarySha256 !== write.sha256) {
            throw new FileJournalError(
              "temporary_corrupt",
              `transaction handoff bytes do not match journal: ${write.path}`,
            );
          }
        }
        await rename(temporary, destination);
        await syncDirectory(path.dirname(destination));
      }
    }

    for (const entry of journal.deletes) {
      await this.#assertSafeDestination(entry.path);
      const destination = path.join(this.#root, entry.path);
      const existing = await hashExistingFile(destination);
      if (existing === undefined) {
        continue;
      }
      if (entry.expectedSha256 !== undefined && existing !== entry.expectedSha256) {
        throw new FileJournalError("expected_hash", `delete target changed: ${entry.path}`);
      }
      await unlink(destination);
      await syncDirectory(path.dirname(destination));
    }

    await replaceJournal(journalPath, { ...journal, status: "committed" });
    await syncDirectory(transactionDirectory);
  }

  public async recoverPrepared(): Promise<string[]> {
    const entries = await readdir(this.#transactionRoot, { withFileTypes: true });
    const recovered: string[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) {
        continue;
      }
      const id = entry.name;
      validateTransactionId(id);
      let journal: FileTransactionJournal;
      try {
        journal = await readJournal(path.join(this.#transactionDirectory(id), "journal.json"));
      } catch (error) {
        if (error instanceof FileJournalError && error.code === "journal_missing") {
          await this.#cleanupUnpublished(id);
          continue;
        }
        throw error;
      }
      if (journal.status === "prepared") {
        await this.commit(id);
        recovered.push(id);
      }
      // A crash after the durable committed marker but before ordinary cleanup
      // must not leave an ambiguous transaction forever. Once commit has been
      // replayed (or was already complete), retirement is safe and recoverable.
      await this.cleanupCommitted(id);
    }
    return recovered;
  }

  public async cleanupCommitted(id: string): Promise<void> {
    const transactionDirectory = this.#transactionDirectory(id);
    let metadata;
    try {
      metadata = await lstat(transactionDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new FileJournalError(
        "transaction_type",
        `transaction path is not a real directory: ${id}`,
      );
    }
    const journal = await readJournal(path.join(transactionDirectory, "journal.json"));
    if (journal.status !== "committed") {
      throw new FileJournalError("transaction_active", `transaction is not committed: ${id}`);
    }
    await rm(transactionDirectory, { recursive: true, force: true });
    await syncDirectory(this.#transactionRoot);
  }

  /** Remove only an exact real transaction directory that never published a journal marker. */
  async #cleanupUnpublished(id: string): Promise<void> {
    const transactionDirectory = this.#transactionDirectory(id);
    let metadata;
    try {
      metadata = await lstat(transactionDirectory);
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      throw error;
    }
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (await realpath(transactionDirectory)) !== transactionDirectory
    ) {
      throw new FileJournalError(
        "transaction_type",
        `unpublished transaction path is not the exact real directory: ${id}`,
      );
    }
    // Delete only the exact unpublished prepare prefix: an optional real `stage/` directory whose
    // children are real six-digit stage files. Never recursively remove the transaction directory.
    // If a journal appears at any point, the final rmdir fails ENOTEMPTY and preserves it.
    const entries = await readdir(transactionDirectory, { withFileTypes: true });
    if (
      entries.length > 2 ||
      entries.some((entry) => entry.name !== "stage" && entry.name !== PREPARED_JOURNAL_TEMP)
    ) {
      throw new FileJournalError(
        "unpublished_shape",
        `unpublished transaction contains unknown authority: ${id}`,
      );
    }
    const journalTemp = entries.find((entry) => entry.name === PREPARED_JOURNAL_TEMP);
    if (journalTemp !== undefined) {
      const journalTempPath = path.join(transactionDirectory, PREPARED_JOURNAL_TEMP);
      const journalTempMetadata = await lstat(journalTempPath);
      if (
        !journalTemp.isFile() ||
        !journalTempMetadata.isFile() ||
        journalTempMetadata.isSymbolicLink()
      ) {
        throw new FileJournalError(
          "unpublished_shape",
          `unpublished transaction journal temp is not a real file: ${id}`,
        );
      }
      // Its bytes are deliberately not parsed: a write failure may leave any partial prefix, and
      // the private name has never become authority. Only the exact no-follow file is removed.
      await unlink(journalTempPath);
    }
    const stageEntry = entries.find((entry) => entry.name === "stage");
    if (stageEntry !== undefined) {
      const stageDirectory = path.join(transactionDirectory, "stage");
      const stageMetadata = await lstat(stageDirectory);
      if (
        !stageEntry.isDirectory() ||
        !stageMetadata.isDirectory() ||
        stageMetadata.isSymbolicLink() ||
        (await realpath(stageDirectory)) !== stageDirectory
      ) {
        throw new FileJournalError(
          "transaction_type",
          `unpublished transaction stage is not the exact real directory: ${id}`,
        );
      }
      const stages = await readBoundedDirectoryEntries(stageDirectory, MAX_TRANSACTION_EFFECTS);
      stages.sort((left, right) => left.name.localeCompare(right.name));
      for (const stage of stages) {
        const stagePath = path.join(stageDirectory, stage.name);
        const stageStat = await lstat(stagePath);
        if (
          !/^\d{6}$/u.test(stage.name) ||
          Number(stage.name) >= MAX_TRANSACTION_EFFECTS ||
          !stageStat.isFile() ||
          stageStat.isSymbolicLink()
        ) {
          throw new FileJournalError(
            "unpublished_shape",
            `unpublished transaction contains an unsafe stage: ${id}/${stage.name}`,
          );
        }
        await unlink(stagePath);
      }
      await rmdir(stageDirectory);
    }
    await rmdir(transactionDirectory);
    await syncDirectory(this.#transactionRoot);
  }

  #transactionDirectory(id: string): string {
    return path.join(this.#transactionRoot, id);
  }

  async #verifyExpected(relative: string, expected: string | null | undefined): Promise<void> {
    if (expected === undefined) {
      return;
    }
    const actual = await hashExistingFile(path.join(this.#root, relative));
    if (expected === null ? actual !== undefined : actual !== expected) {
      throw new FileJournalError("expected_hash", `expected state changed: ${relative}`);
    }
  }

  async #assertSafeDestination(relative: string): Promise<void> {
    const segments = relative.split("/");
    let cursor = this.#root;
    for (const [index, segment] of segments.entries()) {
      const isLeaf = index === segments.length - 1;
      cursor = path.join(cursor, segment);
      try {
        const metadata = await lstat(cursor);
        if (metadata.isSymbolicLink()) {
          throw new FileJournalError(
            "symlink",
            `transaction path traverses a symlink: ${relative}`,
          );
        }
        if (!isLeaf && !metadata.isDirectory()) {
          throw new FileJournalError(
            "path_type",
            `transaction parent is not a directory: ${relative}`,
          );
        }
        if (isLeaf && !metadata.isFile()) {
          throw new FileJournalError(
            "path_type",
            `transaction destination must be a regular file or absent: ${relative}`,
          );
        }
      } catch (error) {
        if (error instanceof FileJournalError) {
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    const resolved = path.resolve(this.#root, relative);
    if (resolved !== this.#root && !resolved.startsWith(`${this.#root}${path.sep}`)) {
      throw new FileJournalError("path_escape", `transaction path escapes its root: ${relative}`);
    }
  }
}

function validateTransactionId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) {
    throw new FileJournalError("transaction_id", "transaction id is not safe");
  }
}

function safeRelativePath(input: string): string {
  if (input.includes("\\") || input.includes("\0") || path.isAbsolute(input)) {
    throw new FileJournalError("path_escape", `unsafe transaction path: ${input}`);
  }
  const normalized = path.posix.normalize(input);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new FileJournalError("path_escape", `unsafe transaction path: ${input}`);
  }
  if (normalized.endsWith("/")) {
    throw new FileJournalError(
      "path_shape",
      `transaction destination must name one exact leaf: ${input}`,
    );
  }
  if (Buffer.byteLength(normalized, "utf8") > MAX_TRANSACTION_PATH_BYTES) {
    throw new FileJournalError(
      "path_size",
      `transaction path exceeds ${MAX_TRANSACTION_PATH_BYTES} UTF-8 bytes`,
    );
  }
  const identity = portableDurablePathIdentity(normalized);
  if (identity === ".transactions" || identity.startsWith(".transactions/")) {
    throw new FileJournalError(
      "reserved_path",
      `transaction path is reserved for journal authority: ${input}`,
    );
  }
  return normalized;
}

function rejectDuplicateDestinations(
  writes: readonly { path: string }[],
  deletes: readonly { path: string }[],
): void {
  const seen = new Set<string>();
  for (const effect of [...writes, ...deletes]) {
    const identity = portableDurablePathIdentity(effect.path);
    if (seen.has(identity)) {
      throw new FileJournalError(
        "duplicate_path",
        `transaction path appears twice: ${effect.path}`,
      );
    }
    seen.add(identity);
  }
}

function rejectDerivedTemporaryCollisions(
  id: string,
  writes: readonly { path: string }[],
  deletes: readonly { path: string }[],
): void {
  const namespace = new Map<string, { path: string; temporary: boolean }>();
  for (const effect of [...writes, ...deletes]) {
    namespace.set(portableDurablePathIdentity(effect.path), {
      path: effect.path,
      temporary: false,
    });
  }
  for (const write of writes) {
    const handoff = derivedTemporaryRelativePath(write.path, id);
    const identity = portableDurablePathIdentity(handoff);
    if (namespace.has(identity)) {
      throw new FileJournalError(
        "temporary_path_collision",
        `transaction destination collides with an internal handoff path: ${handoff}`,
      );
    }
    namespace.set(identity, { path: handoff, temporary: true });
  }

  // Exact identities are handled above (and declared duplicates by rejectDuplicateDestinations).
  // Also reject every portable path-segment ancestor relationship. Without this invariant an
  // effect such as `foo` can turn a later `foo/bar` into a partial commit, and a declared child of
  // an internal handoff can strand or overwrite recovery state.
  for (const [identity, entry] of namespace) {
    let separator = identity.indexOf("/");
    while (separator >= 0) {
      const ancestor = namespace.get(identity.slice(0, separator));
      if (ancestor !== undefined) {
        const temporary = entry.temporary || ancestor.temporary;
        throw new FileJournalError(
          temporary ? "temporary_path_collision" : "path_overlap",
          temporary
            ? `transaction destination overlaps an internal handoff path: ${entry.path}`
            : `transaction destinations overlap: ${ancestor.path} and ${entry.path}`,
        );
      }
      separator = identity.indexOf("/", separator + 1);
    }
  }
}

function derivedTemporaryRelativePath(destination: string, id: string): string {
  return safeRelativePath(`${destination}.koni-${id}.tmp`);
}

function validateJournal(value: unknown): FileTransactionJournal {
  if (
    !isRecord(value) ||
    value.protocol !== JOURNAL_PROTOCOL ||
    typeof value.id !== "string" ||
    (value.status !== "prepared" && value.status !== "committed") ||
    typeof value.createdAt !== "string" ||
    !Array.isArray(value.writes) ||
    !Array.isArray(value.deletes)
  ) {
    throw new FileJournalError("journal_schema", "transaction journal has an unsupported schema");
  }
  validateTransactionId(value.id);
  if (
    !isCanonicalTimestamp(value.createdAt) ||
    value.writes.length + value.deletes.length > MAX_TRANSACTION_EFFECTS
  ) {
    throw new FileJournalError("journal_schema", "transaction journal metadata is invalid");
  }
  const writes: JournalWrite[] = [];
  let declaredBytes = 0;
  for (const [index, raw] of value.writes.entries()) {
    if (
      !isRecord(raw) ||
      typeof raw.path !== "string" ||
      typeof raw.stage !== "string" ||
      raw.stage !== `stage/${String(index).padStart(6, "0")}` ||
      !isSha256(raw.sha256) ||
      !Number.isSafeInteger(raw.sizeBytes) ||
      (raw.sizeBytes as number) < 0 ||
      (raw.sizeBytes as number) > MAX_TRANSACTION_BYTES ||
      (raw.expectedSha256 !== undefined &&
        raw.expectedSha256 !== null &&
        !isSha256(raw.expectedSha256))
    ) {
      throw new FileJournalError("journal_schema", "transaction journal write is invalid");
    }
    const relative = safeRelativePath(raw.path);
    declaredBytes += raw.sizeBytes as number;
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_TRANSACTION_BYTES) {
      throw new FileJournalError("transaction_size", "transaction journal payload is oversized");
    }
    writes.push({
      path: relative,
      stage: raw.stage,
      sha256: raw.sha256,
      sizeBytes: raw.sizeBytes as number,
      ...(raw.expectedSha256 === undefined ? {} : { expectedSha256: raw.expectedSha256 }),
    });
  }
  const deletes: JournalDelete[] = [];
  for (const raw of value.deletes) {
    if (
      !isRecord(raw) ||
      typeof raw.path !== "string" ||
      (raw.expectedSha256 !== undefined && !isSha256(raw.expectedSha256))
    ) {
      throw new FileJournalError("journal_schema", "transaction journal delete is invalid");
    }
    deletes.push({
      path: safeRelativePath(raw.path),
      ...(raw.expectedSha256 === undefined ? {} : { expectedSha256: raw.expectedSha256 }),
    });
  }
  rejectDuplicateDestinations(writes, deletes);
  rejectDerivedTemporaryCollisions(value.id, writes, deletes);
  return {
    protocol: JOURNAL_PROTOCOL,
    id: value.id,
    status: value.status,
    createdAt: value.createdAt,
    writes,
    deletes,
  };
}

async function readBoundedDirectoryEntries(directory: string, maximum: number): Promise<Dirent[]> {
  const handle = await opendir(directory);
  const entries: Dirent[] = [];
  try {
    while (true) {
      const entry = await handle.read();
      if (entry === null) break;
      if (entries.length >= maximum) {
        throw new FileJournalError(
          "unpublished_shape",
          `unpublished transaction stage count exceeds ${maximum}`,
        );
      }
      entries.push(entry);
    }
  } finally {
    await handle.close().catch((error: unknown) => {
      if (!isCode(error, "ERR_DIR_CLOSED")) throw error;
    });
  }
  return entries;
}

function encodeJournal(journal: FileTransactionJournal): Buffer {
  const canonical = validateJournal(journal);
  const bytes = Buffer.from(`${JSON.stringify(canonical)}\n`, "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_JOURNAL_BYTES) {
    throw new FileJournalError(
      "journal_size",
      `transaction journal exceeds ${MAX_JOURNAL_BYTES} bytes`,
    );
  }
  return bytes;
}

function isCanonicalTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJournal(journalPath: string): Promise<FileTransactionJournal> {
  let bytes: Buffer;
  try {
    bytes = await readStableDurableFile(journalPath, {
      maximum: MAX_JOURNAL_BYTES,
      label: "transaction journal",
    });
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      throw new FileJournalError(
        "journal_missing",
        `transaction did not publish a journal: ${journalPath}`,
      );
    }
    if (error instanceof DurableFileReadError) {
      if (error.code === "file_size" && error.reason === "initial_oversize") {
        throw new FileJournalError(
          "legacy_journal_capacity",
          `existing transaction journal exceeds ${MAX_JOURNAL_BYTES} bytes and was left unchanged`,
        );
      }
      throw new FileJournalError(error.code, error.message);
    }
    throw new FileJournalError("journal_read", `cannot read transaction journal: ${String(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new FileJournalError("journal_read", `cannot read transaction journal: ${String(error)}`);
  }
  const journal = validateJournal(value);
  if (!bytes.equals(encodeJournal(journal))) {
    throw new FileJournalError(
      "journal_canonical",
      "transaction journal does not use its canonical byte representation",
    );
  }
  return journal;
}

async function replaceJournal(journalPath: string, journal: FileTransactionJournal): Promise<void> {
  const temporary = `${journalPath}.next`;
  await rm(temporary, { force: true });
  await writeDurableNewFile(temporary, encodeJournal(journal));
  await rename(temporary, journalPath);
  await syncDirectory(path.dirname(journalPath));
}

async function publishPreparedJournal(
  transactionDirectory: string,
  bytes: Uint8Array,
): Promise<void> {
  const temporary = path.join(transactionDirectory, PREPARED_JOURNAL_TEMP);
  const journal = path.join(transactionDirectory, "journal.json");
  await writeDurableNewFile(temporary, bytes);
  // Persist the private name first. The later link is an exclusive, atomic publication of the
  // already-complete inode, so it cannot expose partial bytes or replace another visible journal.
  await syncDirectory(transactionDirectory);
  try {
    await link(temporary, journal);
  } catch (error) {
    if (isCode(error, "EEXIST")) {
      throw new FileJournalError("journal_exists", "prepared journal authority already exists");
    }
    throw error;
  }
  await syncDirectory(transactionDirectory);
  await unlink(temporary);
  await syncDirectory(transactionDirectory);
}

async function writeDurableNewFile(filePath: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertPathAbsent(filePath: string, relative: string): Promise<void> {
  try {
    await lstat(filePath);
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  throw new FileJournalError(
    "temporary_exists",
    `transaction handoff path already exists: ${relative}`,
  );
}

async function handoffMatchesStage(
  stagePath: string,
  temporaryPath: string,
  write: JournalWrite,
): Promise<"absent" | "same" | "different"> {
  let temporaryStat;
  try {
    temporaryStat = await lstat(temporaryPath);
  } catch (error) {
    if (isCode(error, "ENOENT")) return "absent";
    throw error;
  }
  const stageStat = await lstat(stagePath);
  if (
    !stageStat.isFile() ||
    stageStat.isSymbolicLink() ||
    !temporaryStat.isFile() ||
    temporaryStat.isSymbolicLink() ||
    stageStat.dev !== temporaryStat.dev ||
    stageStat.ino !== temporaryStat.ino ||
    temporaryStat.size !== write.sizeBytes
  ) {
    return "different";
  }
  const temporarySha256 = await hashExistingFile(temporaryPath, write.sizeBytes);
  return temporarySha256 === write.sha256 ? "same" : "different";
}

async function hashExistingFile(
  filePath: string,
  maximum = Number.MAX_SAFE_INTEGER,
): Promise<string | undefined> {
  try {
    return await hashStableDurableFile(filePath, {
      maximum,
      minimum: 0,
      label: `transaction file ${filePath}`,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    if (error instanceof DurableFileReadError) {
      throw new FileJournalError(error.code, error.message);
    }
    throw error;
  }
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
