import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

const JOURNAL_PROTOCOL = "koni.file-transaction.v1" as const;
const MAX_TRANSACTION_BYTES = 64 * 1024 * 1024;

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
    await mkdir(path.join(canonical, ".transactions"), { recursive: true, mode: 0o700 });
    return new FileTransactionStore(canonical);
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
    const normalizedWrites = writes.map((write) => ({ ...write, path: safeRelativePath(write.path) }));
    const normalizedDeletes = deletes.map((entry) => ({ ...entry, path: safeRelativePath(entry.path) }));
    rejectDuplicateDestinations(normalizedWrites, normalizedDeletes);
    const totalBytes = normalizedWrites.reduce((total, write) => total + write.bytes.byteLength, 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TRANSACTION_BYTES) {
      throw new FileJournalError(
        "transaction_size",
        `transaction exceeds ${MAX_TRANSACTION_BYTES} bytes`,
      );
    }

    for (const effect of [...normalizedWrites, ...normalizedDeletes]) {
      await this.#assertSafeDestination(effect.path);
    }
    for (const write of normalizedWrites) {
      await this.#verifyExpected(write.path, write.expectedSha256);
    }
    for (const entry of normalizedDeletes) {
      await this.#verifyExpected(entry.path, entry.expectedSha256);
    }

    const transactionDirectory = this.#transactionDirectory(id);
    try {
      await mkdir(transactionDirectory, { mode: 0o700 });
    } catch (error) {
      throw new FileJournalError("transaction_exists", `transaction already exists: ${id}`);
    }
    const stageDirectory = path.join(transactionDirectory, "stage");
    await mkdir(stageDirectory, { mode: 0o700 });

    const journalWrites: JournalWrite[] = [];
    for (const [index, write] of normalizedWrites.entries()) {
      const stage = `stage/${String(index).padStart(6, "0")}`;
      const stagePath = path.join(transactionDirectory, stage);
      await writeDurableNewFile(stagePath, write.bytes);
      journalWrites.push({
        path: write.path,
        stage,
        sha256: sha256(write.bytes),
        sizeBytes: write.bytes.byteLength,
        ...(write.expectedSha256 === undefined
          ? {}
          : { expectedSha256: write.expectedSha256 }),
      });
    }
    const journal: FileTransactionJournal = {
      protocol: JOURNAL_PROTOCOL,
      id,
      status: "prepared",
      createdAt: new Date().toISOString(),
      writes: journalWrites,
      deletes: normalizedDeletes,
    };
    await writeDurableNewFile(
      path.join(transactionDirectory, "journal.json"),
      Buffer.from(`${JSON.stringify(journal)}\n`, "utf8"),
    );
    await syncDirectory(stageDirectory);
    await syncDirectory(transactionDirectory);
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
        const stageBytes = await readFile(stagePath);
        if (stageBytes.byteLength !== write.sizeBytes || sha256(stageBytes) !== write.sha256) {
          throw new FileJournalError("stage_corrupt", `staged bytes do not match journal: ${write.path}`);
        }
        const destination = path.join(this.#root, write.path);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await this.#assertSafeDestination(write.path);
        const temporary = `${destination}.koni-${id}.tmp`;
        await rm(temporary, { force: true });
        await rename(stagePath, temporary);
        await syncDirectory(path.dirname(temporary));
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
      const journal = await readJournal(path.join(this.#transactionDirectory(id), "journal.json"));
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
      throw new FileJournalError("transaction_type", `transaction path is not a real directory: ${id}`);
    }
    const journal = await readJournal(path.join(transactionDirectory, "journal.json"));
    if (journal.status !== "committed") {
      throw new FileJournalError("transaction_active", `transaction is not committed: ${id}`);
    }
    await rm(transactionDirectory, { recursive: true, force: true });
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
          throw new FileJournalError("symlink", `transaction path traverses a symlink: ${relative}`);
        }
        if (!isLeaf && !metadata.isDirectory()) {
          throw new FileJournalError("path_type", `transaction parent is not a directory: ${relative}`);
        }
        if (isLeaf && !metadata.isFile() && !metadata.isDirectory()) {
          throw new FileJournalError("path_type", `transaction leaf has an unsupported type: ${relative}`);
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
  return normalized;
}

function rejectDuplicateDestinations(
  writes: readonly { path: string }[],
  deletes: readonly { path: string }[],
): void {
  const seen = new Set<string>();
  for (const effect of [...writes, ...deletes]) {
    if (seen.has(effect.path)) {
      throw new FileJournalError("duplicate_path", `transaction path appears twice: ${effect.path}`);
    }
    seen.add(effect.path);
  }
}

async function readJournal(journalPath: string): Promise<FileTransactionJournal> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(journalPath, "utf8"));
  } catch (error) {
    throw new FileJournalError("journal_read", `cannot read transaction journal: ${String(error)}`);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { protocol?: unknown }).protocol !== JOURNAL_PROTOCOL
  ) {
    throw new FileJournalError("journal_schema", "transaction journal has an unsupported schema");
  }
  return value as FileTransactionJournal;
}

async function replaceJournal(journalPath: string, journal: FileTransactionJournal): Promise<void> {
  const temporary = `${journalPath}.next`;
  await rm(temporary, { force: true });
  await writeDurableNewFile(temporary, Buffer.from(`${JSON.stringify(journal)}\n`, "utf8"));
  await rename(temporary, journalPath);
  await syncDirectory(path.dirname(journalPath));
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

async function hashExistingFile(filePath: string): Promise<string | undefined> {
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile()) {
      throw new FileJournalError("path_type", `expected a regular file: ${filePath}`);
    }
    return sha256(await readFile(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
