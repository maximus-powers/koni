import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { RunRecord } from "../state/run-record.js";
import { assertRunRecord, assertTicketGraph } from "../state/run-record.js";
import {
  hasLegacyFlatRunGitRecord,
  migrateLegacyRunGitRecord,
} from "../state/legacy-run-git-migration.js";
import {
  canonicalHash,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import { FileTransactionStore, type TransactionDelete, type TransactionWrite } from "./file-journal.js";
import type { JsonValue } from "./protocol.js";

export const PROJECT_AUTHORITY_STATE_PROTOCOL = "koni.project-authority-state.v1" as const;

const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_RUN_BYTES = 64 * 1024 * 1024;
const MAX_RECEIPTS = 20_000;

export interface DurableAuthorityReceipt {
  id: Sha256Digest;
  method: string;
  idempotencyKey: string;
  requestHash: Sha256Digest;
  revision: number;
  result?: JsonValue;
  recordedAt: string;
}

export interface ProjectAuthorityState {
  protocol: typeof PROJECT_AUTHORITY_STATE_PROTOCOL;
  projectRoot: string;
  commonDirectory: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  runIds: string[];
  receipts: Record<string, DurableAuthorityReceipt>;
}

export interface RunWrite {
  record: RunRecord;
  /** `null` means that this run must not exist yet. */
  expectedRevision: number | null;
}

export interface ProjectMutation {
  expectedRevision: number;
  runWrites?: readonly RunWrite[];
  writes?: readonly TransactionWrite[];
  deletes?: readonly TransactionDelete[];
  receipt?: {
    method: string;
    idempotencyKey: string;
    requestHash: Sha256Digest;
    result?: JsonValue;
  };
  mutateState?: (draft: ProjectAuthorityState) => void;
}

export interface ProjectMutationResult {
  state: ProjectAuthorityState;
  receipt?: DurableAuthorityReceipt;
}

export class ProjectAuthorityStoreError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ProjectAuthorityStoreError";
    this.code = code;
  }
}

/**
 * One crash-forward transaction boundary for repository authority metadata, run records,
 * compiler artifacts, and durable idempotency receipts.
 */
export class ProjectAuthorityStore {
  readonly #root: string;
  readonly #projectRoot: string;
  readonly #commonDirectory: string;
  readonly #transactions: FileTransactionStore;
  #tail: Promise<void> = Promise.resolve();

  private constructor(
    root: string,
    projectRoot: string,
    commonDirectory: string,
    transactions: FileTransactionStore,
  ) {
    this.#root = root;
    this.#projectRoot = projectRoot;
    this.#commonDirectory = commonDirectory;
    this.#transactions = transactions;
  }

  public static async open(options: {
    stateRoot: string;
    projectRoot: string;
    commonDirectory: string;
  }): Promise<ProjectAuthorityStore> {
    await mkdir(options.stateRoot, { recursive: true, mode: 0o700 });
    const transactions = await FileTransactionStore.open(options.stateRoot);
    await transactions.recoverPrepared();
    const store = new ProjectAuthorityStore(
      options.stateRoot,
      options.projectRoot,
      options.commonDirectory,
      transactions,
    );
    await store.#initialize();
    await store.#migrateLegacyRunRecords();
    return store;
  }

  public async state(): Promise<ProjectAuthorityState> {
    const state = await readState(this.#stateFile());
    if (state.projectRoot !== this.#projectRoot || state.commonDirectory !== this.#commonDirectory) {
      throw new ProjectAuthorityStoreError(
        "project_identity",
        "durable authority state belongs to a different Git repository",
      );
    }
    return state;
  }

  public async listRuns(options: { includeDeleted?: boolean } = {}): Promise<RunRecord[]> {
    const state = await this.state();
    const runs = await Promise.all(state.runIds.map((runId) => this.getRun(runId)));
    return runs
      .filter((run) => options.includeDeleted === true || run.lifecycle.phase !== "deleted")
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id)
      );
  }

  public async getRun(runId: string): Promise<RunRecord> {
    assertRunId(runId);
    const bytes = await readBounded(this.#runFile(runId), MAX_RUN_BYTES, `run ${runId}`);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new ProjectAuthorityStoreError("run_json", `run record is not valid JSON: ${runId}`);
    }
    assertRunRecord(value);
    assertTicketGraph(value.tickets);
    if (value.id !== runId) {
      throw new ProjectAuthorityStoreError("run_identity", `run path does not match record: ${runId}`);
    }
    return value;
  }

  /** Read a compiler-owned immutable artifact by normalized state-root-relative path. */
  public async readArtifact(relative: string, maximum = 16 * 1024 * 1024): Promise<Buffer> {
    if (
      relative.length === 0 ||
      relative.startsWith("/") ||
      relative.includes("\\") ||
      relative.includes("\u0000") ||
      relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > MAX_RUN_BYTES
    ) {
      throw new ProjectAuthorityStoreError("artifact_path", "artifact path or byte bound is unsafe");
    }
    return readBounded(path.join(this.#root, relative), maximum, `artifact ${relative}`);
  }

  public async findReceipt(
    method: string,
    idempotencyKey: string,
    requestHash: Sha256Digest,
  ): Promise<DurableAuthorityReceipt | undefined> {
    const state = await this.state();
    const id = receiptId(method, idempotencyKey);
    const receipt = state.receipts[id];
    if (receipt === undefined) return undefined;
    if (receipt.method !== method || receipt.idempotencyKey !== idempotencyKey) {
      throw new ProjectAuthorityStoreError("receipt_corrupt", `receipt identity does not match ${id}`);
    }
    if (receipt.requestHash !== requestHash) {
      throw new ProjectAuthorityStoreError(
        "idempotency_reuse",
        "idempotency key was already used with a different request",
      );
    }
    return structuredClone(receipt);
  }

  public commit(mutation: ProjectMutation): Promise<ProjectMutationResult> {
    return this.#serialized(async () => {
      const current = await this.state();
      if (current.revision !== mutation.expectedRevision) {
        throw new ProjectAuthorityStoreError(
          "revision_conflict",
          `expected authority revision ${mutation.expectedRevision}, current ${current.revision}`,
        );
      }
      const next = structuredClone(current);
      next.revision += 1;
      next.updatedAt = new Date().toISOString();
      mutation.mutateState?.(next);

      const destinations = new Set<string>();
      const writes: TransactionWrite[] = [];
      for (const runWrite of mutation.runWrites ?? []) {
        const record = structuredClone(runWrite.record);
        assertRunRecord(record);
        assertTicketGraph(record.tickets);
        assertRunId(record.id);
        const relative = relativeRunFile(record.id);
        assertUniqueDestination(destinations, relative);
        const previous = await readOptionalRun(this.#runFile(record.id));
        if (runWrite.expectedRevision === null) {
          if (previous !== undefined || record.revision !== 0) {
            throw new ProjectAuthorityStoreError(
              "run_create_conflict",
              `new run ${record.id} already exists or does not start at revision zero`,
            );
          }
        } else {
          if (previous === undefined || previous.revision !== runWrite.expectedRevision) {
            throw new ProjectAuthorityStoreError(
              "run_revision_conflict",
              `expected run ${record.id} revision ${runWrite.expectedRevision}`,
            );
          }
          if (record.revision !== runWrite.expectedRevision + 1) {
            throw new ProjectAuthorityStoreError(
              "run_revision",
              `updated run ${record.id} did not advance exactly one revision`,
            );
          }
        }
        const bytes = encodeBounded(record, MAX_RUN_BYTES, `run ${record.id}`);
        writes.push({
          path: relative,
          bytes,
          expectedSha256: previous === undefined ? null : rawSha256(encodeBounded(previous, MAX_RUN_BYTES, `run ${record.id}`)),
        });
        if (!next.runIds.includes(record.id)) next.runIds.push(record.id);
      }
      next.runIds = [...new Set(next.runIds)].sort();

      let durableReceipt: DurableAuthorityReceipt | undefined;
      if (mutation.receipt !== undefined) {
        validateMethod(mutation.receipt.method);
        validateIdempotencyKey(mutation.receipt.idempotencyKey);
        const id = receiptId(mutation.receipt.method, mutation.receipt.idempotencyKey);
        const prior = next.receipts[id];
        if (prior !== undefined) {
          if (prior.requestHash !== mutation.receipt.requestHash) {
            throw new ProjectAuthorityStoreError(
              "idempotency_reuse",
              "idempotency key was already used with a different request",
            );
          }
          throw new ProjectAuthorityStoreError(
            "idempotency_committed",
            "idempotent mutation was already committed",
          );
        }
        durableReceipt = {
          id,
          method: mutation.receipt.method,
          idempotencyKey: mutation.receipt.idempotencyKey,
          requestHash: mutation.receipt.requestHash,
          revision: next.revision,
          ...(mutation.receipt.result === undefined ? {} : { result: mutation.receipt.result }),
          recordedAt: next.updatedAt,
        };
        next.receipts[id] = durableReceipt;
        pruneReceipts(next.receipts);
      }

      validateState(next);
      const stateRelative = "authority/state.json";
      assertUniqueDestination(destinations, stateRelative);
      writes.push({
        path: stateRelative,
        bytes: encodeBounded(next, MAX_STATE_BYTES, "authority state"),
        expectedSha256: rawSha256(encodeBounded(current, MAX_STATE_BYTES, "authority state")),
      });
      for (const write of mutation.writes ?? []) {
        assertUniqueDestination(destinations, write.path);
        writes.push(write);
      }
      for (const entry of mutation.deletes ?? []) {
        assertUniqueDestination(destinations, entry.path);
      }
      const txId = `authority-${next.revision}-${randomUUID()}`;
      await this.#transactions.prepare(txId, writes, mutation.deletes ?? []);
      await this.#transactions.commit(txId);
      await this.#transactions.cleanupCommitted(txId);
      return {
        state: structuredClone(next),
        ...(durableReceipt === undefined ? {} : { receipt: structuredClone(durableReceipt) }),
      };
    });
  }

  async #initialize(): Promise<void> {
    try {
      await this.state();
      return;
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
    const now = new Date().toISOString();
    const initial: ProjectAuthorityState = {
      protocol: PROJECT_AUTHORITY_STATE_PROTOCOL,
      projectRoot: this.#projectRoot,
      commonDirectory: this.#commonDirectory,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      runIds: [],
      receipts: Object.create(null) as Record<string, DurableAuthorityReceipt>,
    };
    validateState(initial);
    const txId = `authority-init-${randomUUID()}`;
    try {
      await this.#transactions.prepare(txId, [{
        path: "authority/state.json",
        bytes: encodeBounded(initial, MAX_STATE_BYTES, "authority state"),
        expectedSha256: null,
      }]);
      await this.#transactions.commit(txId);
      await this.#transactions.cleanupCommitted(txId);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "expected_hash") {
        return;
      }
      throw error;
    }
  }

  /**
   * Upgrade flat pre-isolation Git records before any caller can observe them.
   * The proof adapter is read-only with respect to Git; this transaction changes
   * only authority metadata and preserves ambiguous resources as blocked state.
   */
  async #migrateLegacyRunRecords(): Promise<void> {
    const current = await this.state();
    const migratedAt = new Date().toISOString();
    const writes: TransactionWrite[] = [];
    for (const runId of current.runIds) {
      const file = this.#runFile(runId);
      const bytes = await readBounded(file, MAX_RUN_BYTES, `run ${runId}`);
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new ProjectAuthorityStoreError("run_json", `run record is not valid JSON: ${runId}`);
      }
      try {
        assertRunRecord(value);
        assertTicketGraph(value.tickets);
        continue;
      } catch (strictError) {
        if (!hasLegacyFlatRunGitRecord(value)) throw strictError;
      }
      const migration = await migrateLegacyRunGitRecord(value, {
        projectRoot: this.#projectRoot,
        commonDirectory: this.#commonDirectory,
        migratedAt,
      });
      if (migration.status === "not_legacy") {
        throw new ProjectAuthorityStoreError(
          "legacy_git_shape",
          `run ${runId} did not match the explicit legacy Git schema`,
        );
      }
      if (migration.status === "blocked") {
        throw new ProjectAuthorityStoreError(
          "legacy_git_migration_blocked",
          `run ${runId} cannot be migrated safely: ${migration.reason}`,
        );
      }
      if (migration.record.id !== runId) {
        throw new ProjectAuthorityStoreError(
          "run_identity",
          `legacy run path does not match record: ${runId}`,
        );
      }
      assertRunRecord(migration.record);
      assertTicketGraph(migration.record.tickets);
      writes.push({
        path: relativeRunFile(runId),
        bytes: encodeBounded(migration.record, MAX_RUN_BYTES, `run ${runId}`),
        expectedSha256: rawSha256(bytes),
      });
    }
    if (writes.length === 0) return;

    const next = structuredClone(current);
    next.revision += 1;
    next.updatedAt = migratedAt;
    validateState(next);
    writes.push({
      path: "authority/state.json",
      bytes: encodeBounded(next, MAX_STATE_BYTES, "authority state"),
      expectedSha256: rawSha256(encodeBounded(current, MAX_STATE_BYTES, "authority state")),
    });
    const txId = `legacy-git-migration-${next.revision}-${randomUUID()}`;
    await this.#transactions.prepare(txId, writes);
    await this.#transactions.commit(txId);
    await this.#transactions.cleanupCommitted(txId);
  }

  #stateFile(): string {
    return path.join(this.#root, "authority", "state.json");
  }

  #runFile(runId: string): string {
    return path.join(this.#root, relativeRunFile(runId));
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#tail.then(operation, operation);
    this.#tail = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

export function authorityRequestHash(method: string, params: JsonValue | undefined): Sha256Digest {
  return canonicalHash({ method, params: params ?? null });
}

function receiptId(method: string, idempotencyKey: string): Sha256Digest {
  return canonicalHash({ method, idempotencyKey });
}

function pruneReceipts(receipts: Record<string, DurableAuthorityReceipt>): void {
  const ordered = Object.values(receipts).sort((left, right) =>
    left.revision - right.revision || left.id.localeCompare(right.id)
  );
  for (const receipt of ordered.slice(0, Math.max(0, ordered.length - MAX_RECEIPTS))) {
    delete receipts[receipt.id];
  }
}

function validateState(state: ProjectAuthorityState): void {
  if (
    state.protocol !== PROJECT_AUTHORITY_STATE_PROTOCOL ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !path.isAbsolute(state.projectRoot) ||
    !path.isAbsolute(state.commonDirectory) ||
    !Array.isArray(state.runIds) ||
    !isRecord(state.receipts)
  ) {
    throw new ProjectAuthorityStoreError("state_shape", "authority state has an invalid shape");
  }
  const sorted = [...state.runIds].sort();
  if (new Set(sorted).size !== sorted.length || sorted.some((id, index) => id !== state.runIds[index])) {
    throw new ProjectAuthorityStoreError("state_runs", "authority run index is not unique and sorted");
  }
  for (const id of state.runIds) assertRunId(id);
  for (const [id, receipt] of Object.entries(state.receipts)) {
    if (
      receipt.id !== id ||
      !Number.isSafeInteger(receipt.revision) ||
      receipt.revision < 1 ||
      typeof receipt.method !== "string" ||
      typeof receipt.idempotencyKey !== "string" ||
      typeof receipt.requestHash !== "string"
    ) {
      throw new ProjectAuthorityStoreError("receipt_shape", `authority receipt is invalid: ${id}`);
    }
  }
}

async function readState(file: string): Promise<ProjectAuthorityState> {
  const bytes = await readBounded(file, MAX_STATE_BYTES, "authority state");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ProjectAuthorityStoreError("state_json", "authority state is not valid JSON");
  }
  validateState(value as ProjectAuthorityState);
  return value as ProjectAuthorityState;
}

async function readOptionalRun(file: string): Promise<RunRecord | undefined> {
  try {
    const bytes = await readBounded(file, MAX_RUN_BYTES, "run record");
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    assertRunRecord(value);
    assertTicketGraph(value.tickets);
    return value;
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function readBounded(file: string, maximum: number, label: string): Promise<Buffer> {
  const bytes = await readFile(file);
  if (bytes.byteLength === 0 || bytes.byteLength > maximum) {
    throw new ProjectAuthorityStoreError("file_size", `${label} exceeds its durable byte bound`);
  }
  return bytes;
}

function encodeBounded(value: unknown, maximum: number, label: string): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > maximum) {
    throw new ProjectAuthorityStoreError("file_size", `${label} exceeds its durable byte bound`);
  }
  return bytes;
}

function relativeRunFile(runId: string): string {
  assertRunId(runId);
  return `runs/${runId}/run.json`;
}

function assertRunId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new ProjectAuthorityStoreError("run_id", `invalid run id: ${value}`);
  }
}

function validateMethod(value: string): void {
  if (!/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/u.test(value)) {
    throw new ProjectAuthorityStoreError("method", `invalid authority method: ${value}`);
  }
}

function validateIdempotencyKey(value: string): void {
  if (Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > 512 || value.includes("\u0000")) {
    throw new ProjectAuthorityStoreError("idempotency_key", "idempotency key is empty or oversized");
  }
}

function assertUniqueDestination(destinations: Set<string>, relative: string): void {
  if (destinations.has(relative)) {
    throw new ProjectAuthorityStoreError("duplicate_write", `transaction writes ${relative} more than once`);
  }
  destinations.add(relative);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
