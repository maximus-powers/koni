import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { FileTransactionStore } from "../authority/file-journal.js";
import { rawSha256 } from "../shared/canonical.js";
import { assertRunRecord, assertTicketGraph, type RunRecord } from "./run-record.js";

const MAX_RUN_RECORD_BYTES = 64 * 1024 * 1024;

export class RunRevisionConflictError extends Error {
  public readonly expected: number;
  public readonly actual: number;

  public constructor(expected: number, actual: number) {
    super(`run revision conflict: expected ${expected}, current ${actual}`);
    this.name = "RunRevisionConflictError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class DurableRunStore {
  readonly #root: string;
  readonly #transactions: FileTransactionStore;
  #tail: Promise<void> = Promise.resolve();

  private constructor(root: string, transactions: FileTransactionStore) {
    this.#root = root;
    this.#transactions = transactions;
  }

  public static async open(root: string): Promise<DurableRunStore> {
    await mkdir(path.join(root, "runs"), { recursive: true, mode: 0o700 });
    const transactions = await FileTransactionStore.open(root);
    await transactions.recoverPrepared();
    return new DurableRunStore(root, transactions);
  }

  public async list(): Promise<RunRecord[]> {
    const entries = await readdir(path.join(this.#root, "runs"), { withFileTypes: true });
    const records: RunRecord[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !isRunId(entry.name)) {
        continue;
      }
      records.push(await this.get(entry.name));
    }
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  }

  public async get(runId: string): Promise<RunRecord> {
    const file = this.#runFile(runId);
    const bytes = await readFile(file);
    if (bytes.byteLength > MAX_RUN_RECORD_BYTES) {
      throw new Error(`run record exceeds ${MAX_RUN_RECORD_BYTES} bytes: ${runId}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`run record is not valid JSON: ${runId}`);
    }
    assertRunRecord(value);
    assertTicketGraph(value.tickets);
    if (value.id !== runId) {
      throw new Error(`run record identity does not match path: ${runId}`);
    }
    return value;
  }

  public async create(record: RunRecord): Promise<RunRecord> {
    assertRunRecord(record);
    assertTicketGraph(record.tickets);
    if (record.revision !== 0) {
      throw new Error("a new durable run record must start at revision zero");
    }
    return this.#serialized(async () => {
      const relative = this.#relativeRunFile(record.id);
      const bytes = encodeRun(record);
      const txId = makeTransactionId(record.id, 0);
      await this.#transactions.prepare(txId, [
        { path: relative, bytes, expectedSha256: null },
      ]);
      await this.#transactions.commit(txId);
      await this.#transactions.cleanupCommitted(txId);
      return structuredClone(record);
    });
  }

  public async transact(
    runId: string,
    expectedRevision: number,
    mutate: (draft: RunRecord) => void | Promise<void>,
  ): Promise<RunRecord> {
    return this.#serialized(async () => {
      const current = await this.get(runId);
      if (current.revision !== expectedRevision) {
        throw new RunRevisionConflictError(expectedRevision, current.revision);
      }
      const draft = structuredClone(current);
      await mutate(draft);
      if (draft.id !== current.id || draft.protocol !== current.protocol) {
        throw new Error("run mutation changed immutable identity");
      }
      draft.revision = current.revision + 1;
      draft.updatedAt = new Date().toISOString();
      assertRunRecord(draft);
      assertTicketGraph(draft.tickets);
      const before = encodeRun(current);
      const after = encodeRun(draft);
      const txId = makeTransactionId(runId, draft.revision);
      await this.#transactions.prepare(txId, [
        {
          path: this.#relativeRunFile(runId),
          bytes: after,
          expectedSha256: rawSha256(before),
        },
      ]);
      await this.#transactions.commit(txId);
      await this.#transactions.cleanupCommitted(txId);
      return draft;
    });
  }

  #relativeRunFile(runId: string): string {
    if (!isRunId(runId)) {
      throw new Error(`invalid run id: ${runId}`);
    }
    return `runs/${runId}/run.json`;
  }

  #runFile(runId: string): string {
    return path.join(this.#root, this.#relativeRunFile(runId));
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(operation, operation);
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function encodeRun(record: RunRecord): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (bytes.byteLength > MAX_RUN_RECORD_BYTES) {
    throw new Error(`run record exceeds ${MAX_RUN_RECORD_BYTES} bytes`);
  }
  return bytes;
}

function makeTransactionId(_runId: string, revision: number): string {
  return `run-${revision}-${randomUUID()}`;
}

function isRunId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}
