import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, opendir, rm } from "node:fs/promises";
import path from "node:path";
import {
  assertRunExecutionControlMutation,
  assertRunRecord,
  assertTicketGraph,
  createTerminalFailureSettlementProof,
  createTerminalSuccessSettlementProof,
  deriveRunActionExecutionArchive,
  deriveRunActionTerminalArchiveAuthority,
  validateRunActionArchiveArtifact,
  validateRunActionArchiveMutation,
  validateRunActionArchiveSegmentArtifact,
  type RunActionExecutionArchiveRecord,
  type RunActionExecutionRecord,
  type RunActionTerminalArchiveAuthority,
  type AgentAttemptRecord,
  type RunRecord,
} from "../state/run-record.js";
import {
  authorizeConfiguredTicketTransition,
  authorizeConfiguredRunTransition,
  configuredRunState,
  configuredTicketState,
} from "./configured-lifecycle.js";
import {
  hasLegacyFlatRunGitRecord,
  migrateLegacyRunGitRecord,
} from "../state/legacy-run-git-migration.js";
import {
  canonicalHash,
  compareUtf8,
  isSha256Digest,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import {
  FileTransactionStore,
  type TransactionDelete,
  type TransactionWrite,
} from "./file-journal.js";
import type { JsonValue } from "./protocol.js";
import type { MonitorEvent } from "../monitor/protocol.js";
import {
  appendMonitorEvents,
  deriveMonitorEvents,
  validateDurableMonitorJournal,
} from "./monitor-projection.js";
import {
  AsyncSemaphore,
  mapBoundedDrained,
  MAX_ARCHIVE_ARTIFACT_BYTES,
  MAX_ARCHIVE_READ_CONCURRENCY,
  MAX_RUN_BYTES,
  MAX_STATE_BYTES,
  MAX_TRANSACTION_BYTES,
  MAX_TRANSACTION_EFFECTS,
  portableDurablePathIdentity,
  transactionPayloadBytes,
} from "./durable-limits.js";
import { DurableFileReadError, readStableDurableFile } from "./durable-file-read.js";
import {
  RunSummaryPageCollector,
  RunSummaryPageError,
  type RunSummaryPage,
  type RunSummaryPageAnchor,
} from "./run-summary-page.js";

export const PROJECT_AUTHORITY_STATE_PROTOCOL = "koni.project-authority-state.v1" as const;

const MAX_RECEIPTS = 20_000;
/** Leaves framing headroom for the compatibility response envelope and revision metadata. */
export const MAX_LEGACY_RUN_LIST_BYTES = 12 * 1024 * 1024;

interface StoreLaneLease {
  readonly descendants: Set<Promise<void>>;
}

interface StoreLaneContext {
  active: boolean;
  readonly lease: StoreLaneLease;
  readonly readOnly: boolean;
}

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
  /**
   * Local trust-root binding for the exact raw bytes of every indexed run record. Absent only on
   * projects created before run-byte anchoring; guarded open installs it before returning.
   */
  runRecordSha256?: Record<string, Sha256Digest>;
  receipts: Record<string, DurableAuthorityReceipt>;
  /** Optional only for state written before the Pi companion introduced durable notifications. */
  monitorEventCursor?: number;
  /** Bounded tail; sequence numbers remain global when older entries are pruned. */
  monitorEvents?: MonitorEvent[];
  /** Compact restart tombstone for a bounded multi-transaction authority quiesce. */
  authorityQuiesce?: DurableAuthorityQuiesceOperation;
  /** Lifetime startup epoch: `recovering` distinguishes an unclean partial startup from steady state. */
  authorityStartup?: DurableAuthorityStartupEpoch;
}

export const AUTHORITY_QUIESCE_OPERATION_PROTOCOL = "koni.authority-quiesce-operation.v1" as const;
export const MAX_QUIESCE_ID_SAMPLE = 20;

export interface DurableAuthorityQuiesceOperation {
  protocol: typeof AUTHORITY_QUIESCE_OPERATION_PROTOCOL;
  /** Legacy v1 records may omit this and are conservatively treated as operator restart only. */
  purpose?: "operator_restart" | "startup_failure" | "dirty_startup_recovery";
  requestHash: Sha256Digest;
  idempotencyKey: string;
  requestedAt: string;
  totalRunCount: number;
  targetRunCount: number;
  pausedRunIds: string[];
  pausedRunIdsTruncated: boolean;
  sha256: Sha256Digest;
}

export function createAuthorityQuiesceOperation(
  input: Omit<DurableAuthorityQuiesceOperation, "protocol" | "purpose" | "sha256"> & {
    purpose: NonNullable<DurableAuthorityQuiesceOperation["purpose"]>;
  },
): DurableAuthorityQuiesceOperation {
  const material = {
    protocol: AUTHORITY_QUIESCE_OPERATION_PROTOCOL,
    ...structuredClone(input),
  };
  const operation: DurableAuthorityQuiesceOperation = {
    ...material,
    sha256: canonicalHash(material),
  };
  validateAuthorityQuiesceOperation(operation);
  return operation;
}

export const AUTHORITY_STARTUP_EPOCH_PROTOCOL = "koni.authority-startup-epoch.v1" as const;

export interface DurableAuthorityStartupEpoch {
  protocol: typeof AUTHORITY_STARTUP_EPOCH_PROTOCOL;
  epochId: string;
  status: "recovering" | "ready";
  startedAt: string;
  startingRevision: number;
  readyAt?: string;
  sha256: Sha256Digest;
}

export function createAuthorityStartupEpoch(
  input: Omit<DurableAuthorityStartupEpoch, "protocol" | "sha256">,
): DurableAuthorityStartupEpoch {
  const material = {
    protocol: AUTHORITY_STARTUP_EPOCH_PROTOCOL,
    ...structuredClone(input),
  };
  const epoch: DurableAuthorityStartupEpoch = { ...material, sha256: canonicalHash(material) };
  validateAuthorityStartupEpoch(epoch);
  return epoch;
}

export interface RunWrite {
  record: RunRecord;
  /** `null` means that this run must not exist yet. */
  expectedRevision: number | null;
  /**
   * Explicit semantic actors for configured lifecycle changes in this one CAS. Compiler-owned
   * transitions need no entry. Human/Lead approval paths must name their exact configured actor.
   */
  lifecycleActors?: Readonly<{
    run?: string;
    tickets?: Readonly<Record<string, string>>;
  }>;
}

export interface ProjectMutation {
  expectedRevision: number;
  runWrites?: readonly RunWrite[];
  writes?: readonly TransactionWrite[];
  deletes?: readonly TransactionDelete[];
  authorityQuiesce?: {
    expectedSha256: Sha256Digest | null;
    value: DurableAuthorityQuiesceOperation | null;
  };
  receipt?: {
    method: string;
    idempotencyKey: string;
    requestHash: Sha256Digest;
    result?: JsonValue;
  };
}

export interface ProjectMutationResult {
  state: ProjectAuthorityState;
  receipt?: DurableAuthorityReceipt;
}

export interface RunIdSnapshot {
  revision: number;
  runIds: readonly string[];
}

export interface RunScanSnapshot extends RunIdSnapshot {
  /** Exact anchored read from the captured state; later byte movement rejects, never widens. */
  getRun(runId: string): Promise<RunRecord>;
}

export interface RunAttemptMatch {
  run: RunRecord;
  attempt: AgentAttemptRecord;
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
  readonly #archiveReads = new AsyncSemaphore(MAX_ARCHIVE_READ_CONCURRENCY);
  readonly #laneContext = new AsyncLocalStorage<StoreLaneContext>();
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
      transactions.canonicalRoot(),
      options.projectRoot,
      options.commonDirectory,
      transactions,
    );
    await store.#initialize();
    await store.#migrateLegacyRunRecordAnchors();
    await store.#migrateLegacyRunRecords();
    return store;
  }

  public state(): Promise<ProjectAuthorityState> {
    return this.#serialized(async () => {
      const { state } = await this.#readCurrentState();
      return state;
    });
  }

  public listRuns(options: { includeDeleted?: boolean } = {}): Promise<RunRecord[]> {
    return this.listRunsForLegacyFrame(options);
  }

  /**
   * Compatibility-only full-record list. Mandatory product consumers use `runSummaryPage` or an
   * exact one-record scan. The method stops before retaining a response that cannot fit the local
   * authority protocol and never silently truncates the underlying project.
   */
  public listRunsForLegacyFrame(options: { includeDeleted?: boolean } = {}): Promise<RunRecord[]> {
    return this.#serialized(async () => {
      const { state } = await this.#readCurrentState();
      const runs: RunRecord[] = [];
      let encodedBytes = 2; // JSON array brackets.
      for (const runId of state.runIds) {
        const run = await this.#getRunAtState(runId, state);
        if (options.includeDeleted !== true && run.lifecycle.phase === "deleted") continue;
        const bytes = Buffer.byteLength(JSON.stringify(run), "utf8") + (runs.length === 0 ? 0 : 1);
        if (bytes > MAX_LEGACY_RUN_LIST_BYTES - encodedBytes) {
          throw new ProjectAuthorityStoreError(
            "run_list_pagination_required",
            "complete run list exceeds the compatibility frame; use revision-bound run.page",
          );
        }
        runs.push(run);
        encodedBytes += bytes;
      }
      return runs.sort(
        (left, right) =>
          compareUtf8(right.createdAt, left.createdAt) || compareUtf8(left.id, right.id),
      );
    });
  }

  /** Snapshot only the already-bounded authority ID index for one-record-at-a-time recovery. */
  public runIdSnapshot(): Promise<RunIdSnapshot> {
    return this.#serialized(async () => {
      const { state } = await this.#readCurrentState();
      return { revision: state.revision, runIds: [...state.runIds] };
    });
  }

  /**
   * Capture one validated state/index for sequential mandatory scans without rereading a large
   * state file per record. The snapshot retains no full run; each exact read is still serialized.
   */
  public runScanSnapshot(): Promise<RunScanSnapshot> {
    return this.#serialized(async () => {
      const { state } = await this.#readCurrentState();
      const snapshot = structuredClone(state);
      return {
        revision: snapshot.revision,
        runIds: [...snapshot.runIds],
        getRun: (runId: string) =>
          this.#serialized(() => this.#getRunAtState(runId, snapshot), true),
      };
    });
  }

  /** Scan exact anchored records while retaining only a fixed top-K compact projection. */
  public runSummaryPage(options: {
    includeDeleted?: boolean;
    limit: number;
    cursor?: string;
    aroundRunId?: string;
  }): Promise<RunSummaryPage> {
    return this.#serialized(async () => {
      const { state } = await this.#readCurrentState();
      try {
        if (options.cursor !== undefined && options.aroundRunId !== undefined) {
          throw new RunSummaryPageError(
            "run_page_cursor",
            "run page cursor and aroundRunId are mutually exclusive",
          );
        }
        const around =
          options.aroundRunId === undefined
            ? undefined
            : await this.#runSummaryPageAnchor(
                options.aroundRunId,
                state,
                options.includeDeleted === true,
              );
        const collector = new RunSummaryPageCollector({
          revision: state.revision,
          includeDeleted: options.includeDeleted === true,
          limit: options.limit,
          ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          ...(around === undefined ? {} : { around }),
        });
        for (const runId of state.runIds) {
          collector.accept(await this.#getRunAtState(runId, state));
        }
        return collector.finish();
      } catch (error) {
        if (error instanceof RunSummaryPageError) {
          throw new ProjectAuthorityStoreError(error.code, error.message);
        }
        throw error;
      }
    });
  }

  public getRun(runId: string): Promise<RunRecord> {
    return this.#serialized(async () => {
      const state = await this.state();
      return this.#getRunAtState(runId, state);
    });
  }

  /** Hydrate one selected row only while its page and run revisions remain exact. */
  public getRunAtRevision(options: {
    runId: string;
    authorityRevision: number;
    runRevision: number;
  }): Promise<RunRecord> {
    return this.#serialized(async () => {
      const { state } = await this.#readCurrentState();
      if (state.revision !== options.authorityRevision) {
        throw new ProjectAuthorityStoreError(
          "run_page_stale",
          "selected run page is no longer current",
        );
      }
      const run = await this.#getRunAtState(options.runId, state);
      if (run.revision !== options.runRevision) {
        throw new ProjectAuthorityStoreError(
          "run_page_stale",
          "selected run revision is no longer current",
        );
      }
      return run;
    });
  }

  /** Find one project-unique attempt without retaining every full run. */
  public findAttempt(attemptId: string): Promise<RunAttemptMatch | undefined> {
    return this.#serialized(async () => {
      const { state } = await this.#readCurrentState();
      let matchedRunId: string | undefined;
      for (const runId of state.runIds) {
        const run = await this.#getRunAtState(runId, state);
        if (run.attempts[attemptId] === undefined) continue;
        if (matchedRunId !== undefined) {
          throw new ProjectAuthorityStoreError(
            "attempt_identity",
            "agent attempt identity is not project-unique",
          );
        }
        matchedRunId = runId;
      }
      if (matchedRunId === undefined) return undefined;
      const run = await this.#getRunAtState(matchedRunId, state);
      return { run, attempt: run.attempts[attemptId]! };
    });
  }

  /** Read a compiler-owned immutable artifact by normalized state-root-relative path. */
  public readArtifact(relative: string, maximum = MAX_ARCHIVE_ARTIFACT_BYTES): Promise<Buffer> {
    return this.#serialized(async () => {
      if (
        relative.length === 0 ||
        relative.startsWith("/") ||
        relative.includes("\\") ||
        relative.includes("\u0000") ||
        relative
          .split("/")
          .some((segment) => segment === "" || segment === "." || segment === "..") ||
        !Number.isSafeInteger(maximum) ||
        maximum < 1 ||
        maximum > MAX_RUN_BYTES
      ) {
        throw new ProjectAuthorityStoreError(
          "artifact_path",
          "artifact path or byte bound is unsafe",
        );
      }
      return readBounded(path.join(this.#root, relative), maximum, `artifact ${relative}`);
    });
  }

  /**
   * Run one read-only projection between complete artifact transactions. The callback may use the
   * ordinary read methods. `commit` is rejected before it can enter the lane, including through
   * nested consistent reads. This is used for provider-bound graph snapshots that span run and
   * artifact files.
   */
  public readConsistently<Value>(operation: () => Promise<Value>): Promise<Value> {
    return this.#serialized(operation, true);
  }

  public async findReceipt(
    method: string,
    idempotencyKey: string,
    requestHash: Sha256Digest,
  ): Promise<DurableAuthorityReceipt | undefined> {
    return this.#serialized(async () => {
      const state = await this.state();
      const id = receiptId(method, idempotencyKey);
      const receipt = state.receipts[id];
      if (receipt === undefined) return undefined;
      if (receipt.method !== method || receipt.idempotencyKey !== idempotencyKey) {
        throw new ProjectAuthorityStoreError(
          "receipt_corrupt",
          `receipt identity does not match ${id}`,
        );
      }
      if (receipt.requestHash !== requestHash) {
        throw new ProjectAuthorityStoreError(
          "idempotency_reuse",
          "idempotency key was already used with a different request",
        );
      }
      return structuredClone(receipt);
    });
  }

  public commit(mutation: ProjectMutation): Promise<ProjectMutationResult> {
    const context = this.#laneContext.getStore();
    if (context?.active === true && context.readOnly) {
      return Promise.reject(
        new ProjectAuthorityStoreError(
          "read_only_projection",
          "a consistent read projection cannot commit project authority",
        ),
      );
    }
    return this.#serialized(async () => {
      const { state: current, bytes: currentStateBytes } = await this.#readCurrentState();
      if (current.revision !== mutation.expectedRevision) {
        throw new ProjectAuthorityStoreError(
          "revision_conflict",
          `expected authority revision ${mutation.expectedRevision}, current ${current.revision}`,
        );
      }
      const next = structuredClone(current);
      next.revision += 1;
      next.updatedAt = new Date().toISOString();
      if (mutation.authorityQuiesce !== undefined) {
        const existingSha256 = current.authorityQuiesce?.sha256 ?? null;
        if (existingSha256 !== mutation.authorityQuiesce.expectedSha256) {
          throw new ProjectAuthorityStoreError(
            "authority_quiesce_conflict",
            "durable authority quiesce operation changed before this transaction",
          );
        }
        if (mutation.authorityQuiesce.value === null) {
          delete next.authorityQuiesce;
        } else {
          validateAuthorityQuiesceOperation(mutation.authorityQuiesce.value);
          next.authorityQuiesce = structuredClone(mutation.authorityQuiesce.value);
        }
      }
      const rawRunWrites = mutation.runWrites ?? [];
      const rawWrites = mutation.writes ?? [];
      const rawDeletes = mutation.deletes ?? [];
      if (
        !Number.isSafeInteger(rawRunWrites.length) ||
        !Number.isSafeInteger(rawWrites.length) ||
        !Number.isSafeInteger(rawDeletes.length) ||
        rawRunWrites.length > MAX_TRANSACTION_EFFECTS - 1 ||
        rawWrites.length > MAX_TRANSACTION_EFFECTS - 1 - rawRunWrites.length ||
        rawDeletes.length > MAX_TRANSACTION_EFFECTS - 1 - rawRunWrites.length - rawWrites.length
      ) {
        throw new ProjectAuthorityStoreError(
          "transaction_effects",
          `authority transaction exceeds ${MAX_TRANSACTION_EFFECTS} durable effects`,
        );
      }
      const suppliedWrites = rawWrites.map((write) => ({
        ...write,
        path: normalizeTransactionPath(write.path),
      }));
      const suppliedDeletes = rawDeletes.map((entry) => ({
        ...entry,
        path: normalizeTransactionPath(entry.path),
      }));
      const runWriteIds = new Set(rawRunWrites.map(({ record }) => record.id));
      for (const entry of [...suppliedWrites, ...suppliedDeletes]) {
        assertGenericAuthorityPath(entry.path, runWriteIds);
      }

      const destinations = new Set<string>();
      const runRecordWrites: TransactionWrite[] = [];
      const pendingMonitorEvents = [];
      for (const runWrite of rawRunWrites) {
        const record = structuredClone(runWrite.record);
        assertRunRecord(record);
        assertTicketGraph(record.tickets);
        assertRunId(record.id);
        const relative = relativeRunFile(record.id);
        assertUniqueDestination(destinations, relative);
        const previousBytes = await readOptionalBounded(
          this.#runFile(record.id),
          MAX_RUN_BYTES,
          `run ${record.id}`,
        );
        if (previousBytes !== undefined) {
          assertExactRunRecordAnchor(current, record.id, previousBytes);
        } else if (
          current.runIds.includes(record.id) ||
          Object.hasOwn(current.runRecordSha256 ?? {}, record.id)
        ) {
          throw new ProjectAuthorityStoreError(
            "run_anchor_missing",
            `authority state names missing run bytes: ${record.id}`,
          );
        }
        const previous =
          previousBytes === undefined ? undefined : parseRunRecord(previousBytes, record.id);
        if (runWrite.expectedRevision === null) {
          if (previous !== undefined || record.revision !== 0) {
            throw new ProjectAuthorityStoreError(
              "run_create_conflict",
              `new run ${record.id} already exists or does not start at revision zero`,
            );
          }
          assertConfiguredInitialLifecycle(record, runWrite.lifecycleActors);
          if (
            (record.actionExecutionArchive?.length ?? 0) !== 0 ||
            (record.actionExecutionArchiveSegments?.length ?? 0) !== 0
          ) {
            throw new ProjectAuthorityStoreError(
              "action_archive_create",
              `new run ${record.id} cannot begin with historical action authority`,
            );
          }
          assertExactArchiveMutationWrites(record.id, suppliedWrites, suppliedDeletes, []);
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
          assertConfiguredLifecycleMutation(previous, record, runWrite.lifecycleActors);
          const requiredArchivedActions = await this.#loadArchivedActions(
            previous,
            requiredArchivedActionIdsForMutation(previous, record),
          );
          assertRunExecutionControlMutation(previous, record, requiredArchivedActions);
          const archiveMutation = validateRunActionArchiveMutation(previous, record);
          assertExactArchiveMutationWrites(
            record.id,
            suppliedWrites,
            suppliedDeletes,
            archiveMutation.writes,
          );
        }
        const bytes = encodeBounded(record, MAX_RUN_BYTES, `run ${record.id}`);
        pendingMonitorEvents.push(...deriveMonitorEvents(previous, record));
        runRecordWrites.push({
          path: relative,
          bytes,
          expectedSha256: previousBytes === undefined ? null : rawSha256(previousBytes),
        });
        if (!next.runIds.includes(record.id)) next.runIds.push(record.id);
        next.runRecordSha256![record.id] = rawSha256(bytes);
      }
      next.runIds = [...new Set(next.runIds)].sort();
      appendMonitorEvents(next, pendingMonitorEvents);

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
      const stateWrite: TransactionWrite = {
        path: stateRelative,
        bytes: encodeBounded(next, MAX_STATE_BYTES, "authority state"),
        expectedSha256: rawSha256(currentStateBytes),
      };
      const writes: TransactionWrite[] = [];
      // The journal is crash-forward rather than magically atomic across filesystem paths. Publish
      // immutable/new artifacts first, then every run record that may reference them, and expose
      // the project revision/receipt only after both are durable. A crash at any prefix is safely
      // completed by journal recovery; an unsynchronized reader can never observe a newly
      // published run whose transaction-local evidence destination has not yet been installed.
      for (const write of suppliedWrites) {
        assertUniqueDestination(destinations, write.path);
        writes.push(write);
      }
      writes.push(...runRecordWrites, stateWrite);
      for (const entry of suppliedDeletes) {
        assertUniqueDestination(destinations, entry.path);
      }
      assertProjectTransactionPayload(writes);
      const txId = `authority-${next.revision}-${randomUUID()}`;
      await this.#transactions.prepare(txId, writes, suppliedDeletes);
      await this.#transactions.commit(txId);
      await this.#transactions.cleanupCommitted(txId);
      return {
        state: structuredClone(next),
        ...(durableReceipt === undefined ? {} : { receipt: structuredClone(durableReceipt) }),
      };
    });
  }

  /**
   * CAS the daemon-lifetime startup epoch without consuming a project semantic revision. No
   * client can connect while `recovering`; the epoch is trust-root metadata used only to decide
   * whether the next authority must conservatively quiesce a partial startup.
   */
  public replaceAuthorityStartup(
    expectedSha256: Sha256Digest | null,
    value: DurableAuthorityStartupEpoch,
  ): Promise<ProjectAuthorityState> {
    const context = this.#laneContext.getStore();
    if (context?.active === true && context.readOnly) {
      return Promise.reject(
        new ProjectAuthorityStoreError(
          "read_only_projection",
          "a consistent read projection cannot replace the authority startup epoch",
        ),
      );
    }
    return this.#serialized(async () => {
      const { state: current, bytes: currentStateBytes } = await this.#readCurrentState();
      if ((current.authorityStartup?.sha256 ?? null) !== expectedSha256) {
        throw new ProjectAuthorityStoreError(
          "authority_startup_conflict",
          "durable authority startup epoch changed before this transaction",
        );
      }
      validateAuthorityStartupEpoch(value);
      assertAuthorityStartupTransition(current.authorityStartup, value, current.revision);
      const next = structuredClone(current);
      next.authorityStartup = structuredClone(value);
      validateState(next);
      const bytes = encodeBounded(next, MAX_STATE_BYTES, "authority state");
      // The authenticated epoch identity is state data, not a journal path component. Keep the
      // transaction identity fixed-width so every validator-admitted epoch remains writable.
      const txId = `authority-startup-${randomUUID()}`;
      const writes: TransactionWrite[] = [
        {
          path: "authority/state.json",
          bytes,
          expectedSha256: rawSha256(currentStateBytes),
        },
      ];
      assertProjectTransactionPayload(writes);
      await this.#transactions.prepare(txId, writes, []);
      await this.#transactions.commit(txId);
      await this.#transactions.cleanupCommitted(txId);
      return structuredClone(next);
    });
  }

  /**
   * Authenticate a pre-anchor or genuine-v1 history before installing current run-byte authority.
   * This is deliberately a streaming compatibility path: prior schemas admitted up to 10,000
   * segments, so a new cumulative row/byte ceiling would strand already-valid durable histories.
   * A disk-backed exact identity index closes cross-segment duplicates without an unbounded heap
   * Set. At most four decoded actions exist at once; only compact terminal authorities survive.
   */
  async #validateRunArchiveArtifacts(run: Readonly<RunRecord>): Promise<RunRecord> {
    const segmentDirectory = `runs/${run.id}/actions/archive-index`;
    await assertExactArchiveArtifactInventory({
      root: this.#root,
      runId: run.id,
      kind: "segment",
      directory: segmentDirectory,
      expectedPaths: (run.actionExecutionArchiveSegments ?? []).map(
        (segment) => segment.artifactPath,
      ),
    });
    return withArchiveInvocationIndex(
      this.#root,
      Object.keys(run.actionExecutions ?? {}),
      async (identityIndex) => {
        const projected = structuredClone(run);
        let projectedSizeBytes = serializedJsonBytes(projected);
        const reserveLegacyProjection = (field: string, value: unknown): void => {
          projectedSizeBytes += Buffer.byteLength(
            `,${JSON.stringify(field)}:${JSON.stringify(value)}`,
            "utf8",
          );
          if (projectedSizeBytes > MAX_RUN_BYTES) {
            throw new ProjectAuthorityStoreError(
              "legacy_archive_projection_capacity",
              `run ${run.id} authenticated legacy archive projection exceeds ${MAX_RUN_BYTES} bytes`,
            );
          }
        };
        const reserveLegacyReplacement = (before: unknown, after: unknown): void => {
          projectedSizeBytes += serializedJsonValueBytes(after) - serializedJsonValueBytes(before);
          if (projectedSizeBytes > MAX_RUN_BYTES) {
            throw new ProjectAuthorityStoreError(
              "legacy_archive_projection_capacity",
              `run ${run.id} authenticated legacy archive projection exceeds ${MAX_RUN_BYTES} bytes`,
            );
          }
        };
        const segmentPaths = new Set<string>();
        const pendingFailureProofs = indexTerminalProofs(
          run.id,
          Object.values(run.terminalFailureProofs ?? {}),
          "failure",
        );
        const pendingSuccessProofs = indexTerminalProofs(
          run.id,
          Object.values(run.terminalSuccessProofs ?? {}),
          "success",
        );

        const consumeSemanticAuthority = (
          action: Readonly<RunActionExecutionRecord>,
        ): RunActionTerminalArchiveAuthority | undefined => {
          const failure = pendingFailureProofs.get(action.invocationId);
          if (failure !== undefined) {
            const exact = createTerminalFailureSettlementProof(projected, action);
            if (exact === undefined || canonicalHash(exact) !== canonicalHash(failure)) {
              throw new ProjectAuthorityStoreError(
                "action_archive_authority",
                `run ${run.id} terminal failure proof differs from action ${action.invocationId}`,
              );
            }
            pendingFailureProofs.delete(action.invocationId);
          }
          const success = pendingSuccessProofs.get(action.invocationId);
          if (success !== undefined) {
            const exact = createTerminalSuccessSettlementProof(projected, action);
            if (exact === undefined || canonicalHash(exact) !== canonicalHash(success)) {
              throw new ProjectAuthorityStoreError(
                "action_archive_authority",
                `run ${run.id} terminal success proof differs from action ${action.invocationId}`,
              );
            }
            pendingSuccessProofs.delete(action.invocationId);
          }
          return deriveRunActionTerminalArchiveAuthority(projected, action);
        };

        for (const action of Object.values(run.actionExecutions ?? {})) {
          consumeSemanticAuthority(action);
        }

        const authenticateRows = async (
          rows: readonly RunActionExecutionArchiveRecord[],
          source: string,
          onAuthority: (
            index: number,
            authority: RunActionTerminalArchiveAuthority | undefined,
            action: RunActionExecutionRecord,
          ) => void,
        ): Promise<void> => {
          identityIndex.registerArchived(rows.map((row) => row.invocationId));
          for (const row of rows) {
            if (row.artifactSizeBytes > MAX_ARCHIVE_ARTIFACT_BYTES) {
              throw new ProjectAuthorityStoreError(
                "action_archive_budget",
                `run ${run.id} archived action ${row.invocationId} exceeds its durable artifact bound`,
              );
            }
          }
          for (let start = 0; start < rows.length; start += MAX_ARCHIVE_READ_CONCURRENCY) {
            const batch: Array<{ row: RunActionExecutionArchiveRecord; index: number }> = [];
            for (
              let index = start;
              index < Math.min(rows.length, start + MAX_ARCHIVE_READ_CONCURRENCY);
              index += 1
            ) {
              batch.push({ row: rows[index]!, index });
            }
            await mapBoundedDrained(batch, MAX_ARCHIVE_READ_CONCURRENCY, async ({ row, index }) => {
              const bytes = await this.#archiveReads.run(() =>
                readBounded(
                  path.join(this.#root, row.artifactPath),
                  MAX_ARCHIVE_ARTIFACT_BYTES,
                  `run ${run.id} archived action ${row.invocationId}`,
                ),
              );
              try {
                const action = validateRunActionArchiveArtifact(run, row, bytes);
                onAuthority(index, consumeSemanticAuthority(action), action);
              } catch (error) {
                if (error instanceof ProjectAuthorityStoreError) throw error;
                throw new ProjectAuthorityStoreError(
                  "action_archive_artifact",
                  error instanceof Error
                    ? error.message
                    : `run ${run.id} ${source} action archive artifact is invalid`,
                );
              }
            });
          }
        };

        const directRows = run.actionExecutionArchive ?? [];
        await authenticateRows(directRows, "direct", (index, authority, action) => {
          const projectedRow = projected.actionExecutionArchive?.[index];
          if (projectedRow?.protocol !== "koni.run-action-archive.v1") return;
          if (authority === undefined) {
            const current = deriveRunActionExecutionArchive(projected, action).row;
            reserveLegacyReplacement(projectedRow, current);
            projected.actionExecutionArchive![index] = current;
          } else if (projectedRow.terminalAuthority === undefined) {
            reserveLegacyProjection("terminalAuthority", authority);
            projectedRow.terminalAuthority = authority;
          }
        });

        for (
          let segmentIndex = 0;
          segmentIndex < (run.actionExecutionArchiveSegments?.length ?? 0);
          segmentIndex += 1
        ) {
          const segment = run.actionExecutionArchiveSegments![segmentIndex]!;
          if (segment.artifactSizeBytes > MAX_ARCHIVE_ARTIFACT_BYTES) {
            throw new ProjectAuthorityStoreError(
              "action_archive_budget",
              `run ${run.id} action archive segment exceeds its durable artifact bound`,
            );
          }
          if (segmentPaths.has(segment.artifactPath)) {
            throw new ProjectAuthorityStoreError(
              "action_archive_segment",
              `run ${run.id} reuses an action archive segment artifact`,
            );
          }
          segmentPaths.add(segment.artifactPath);
          const bytes = await this.#archiveReads.run(() =>
            readBounded(
              path.join(this.#root, segment.artifactPath),
              MAX_ARCHIVE_ARTIFACT_BYTES,
              `run ${run.id} action archive segment`,
            ),
          );
          try {
            const rows = validateRunActionArchiveSegmentArtifact(run.id, segment, bytes);
            const authoritiesByIndex = new Array<RunActionTerminalArchiveAuthority | undefined>(
              rows.length,
            );
            await authenticateRows(rows, segment.artifactPath, (index, authority) => {
              authoritiesByIndex[index] = authority;
            });
            const authorities = authoritiesByIndex.filter(
              (authority): authority is RunActionTerminalArchiveAuthority =>
                authority !== undefined,
            );
            const projectedSegment = projected.actionExecutionArchiveSegments?.[segmentIndex];
            if (projectedSegment?.protocol === "koni.run-action-archive-segment.v1") {
              if (projectedSegment.terminalAuthorities === undefined) {
                reserveLegacyProjection("terminalAuthorities", authorities);
                projectedSegment.terminalAuthorities = authorities;
              } else if (
                canonicalHash(projectedSegment.terminalAuthorities) !== canonicalHash(authorities)
              ) {
                throw new ProjectAuthorityStoreError(
                  "action_archive_authority",
                  `run ${run.id} legacy segment terminal authority differs from its actions`,
                );
              }
            }
          } catch (error) {
            if (error instanceof ProjectAuthorityStoreError) throw error;
            throw new ProjectAuthorityStoreError(
              "action_archive_segment",
              error instanceof Error
                ? error.message
                : `run ${run.id} action archive segment is invalid`,
            );
          }
        }

        await assertExactStreamingArchiveRowInventory({
          root: this.#root,
          runId: run.id,
          identityIndex,
        });
        if (pendingFailureProofs.size !== 0 || pendingSuccessProofs.size !== 0) {
          throw new ProjectAuthorityStoreError(
            "action_archive_authority",
            `run ${run.id} terminal proof lacks exact live/archive action authority`,
          );
        }
        try {
          assertRunRecord(projected);
          return projected;
        } catch (error) {
          throw new ProjectAuthorityStoreError(
            "action_archive_authority",
            error instanceof Error
              ? error.message
              : `run ${run.id} action archive authority is invalid`,
          );
        }
      },
    );
  }

  /**
   * Compose every recognized run-record compatibility adapter in memory and require one final
   * strict record. In particular, flat Git is normalized before archive hydration; neither
   * intermediate representation is published or independently treated as current authority.
   */
  async #normalizeStoredRun(
    value: unknown,
    runId: string,
    migratedAt: string,
  ): Promise<{ record: RunRecord; requiresMigration: boolean }> {
    if (
      !isRecord(value) ||
      value.protocol !== "koni.run-record.v1" ||
      value.id !== runId ||
      value.projectRoot !== this.#projectRoot ||
      !isRecord(value.tickets)
    ) {
      throw new ProjectAuthorityStoreError(
        "legacy_run_migration",
        `run does not match its project authority identity: ${runId}`,
      );
    }
    let candidate: unknown = value;
    let requiresMigration = false;
    if (hasLegacyFlatRunGitRecord(candidate)) {
      const migration = await migrateLegacyRunGitRecord(candidate, {
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
      candidate = migration.record;
      requiresMigration = true;
    }

    const needsArchiveProjection = hasLegacyTerminalArchiveProjection(candidate);
    if (!needsArchiveProjection) assertRunRecord(candidate);
    const run = candidate as RunRecord;
    if (run.id !== runId) {
      throw new ProjectAuthorityStoreError(
        "run_identity",
        `run path does not match record: ${runId}`,
      );
    }
    assertTicketGraph(run.tickets);
    const candidateProjection = JSON.stringify(run);
    const authenticated = await this.#validateRunArchiveArtifacts(run);
    assertRunRecord(authenticated);
    assertTicketGraph(authenticated.tickets);
    if (authenticated.id !== runId || authenticated.projectRoot !== this.#projectRoot) {
      throw new ProjectAuthorityStoreError(
        "run_identity",
        `run path does not match record: ${runId}`,
      );
    }
    if (JSON.stringify(authenticated) !== candidateProjection) requiresMigration = true;
    if (requiresMigration && serializedJsonBytes(authenticated) > MAX_RUN_BYTES) {
      throw new ProjectAuthorityStoreError(
        "legacy_archive_projection_capacity",
        `run ${runId} authenticated legacy archive projection exceeds ${MAX_RUN_BYTES} bytes`,
      );
    }
    return { record: authenticated, requiresMigration };
  }

  /** Load only cold v2 action authority named by a newly appended resolver-retry request. */
  async #loadArchivedActions(
    run: Readonly<RunRecord>,
    invocationIds: ReadonlySet<string>,
  ): Promise<ReadonlyMap<string, RunActionExecutionRecord>> {
    if (invocationIds.size === 0) return new Map();
    const requested = [...invocationIds].sort();
    const directById = new Map<string, RunActionExecutionArchiveRecord[]>();
    for (const row of run.actionExecutionArchive ?? []) {
      if (!invocationIds.has(row.invocationId)) continue;
      const matches = directById.get(row.invocationId) ?? [];
      matches.push(row);
      directById.set(row.invocationId, matches);
    }
    type ArchiveSegment = NonNullable<RunRecord["actionExecutionArchiveSegments"]>[number];
    const segmentsById = new Map<string, ArchiveSegment[]>();
    for (const segment of run.actionExecutionArchiveSegments ?? []) {
      for (const authority of segment.terminalAuthorities ?? []) {
        if (!invocationIds.has(authority.invocationId)) continue;
        const matches = segmentsById.get(authority.invocationId) ?? [];
        matches.push(segment);
        segmentsById.set(authority.invocationId, matches);
      }
    }

    const selectedRows = new Map<string, RunActionExecutionArchiveRecord>();
    const segmentGroups = new Map<
      string,
      {
        segment: ArchiveSegment;
        invocationIds: string[];
      }
    >();
    for (const invocationId of requested) {
      const direct = directById.get(invocationId) ?? [];
      const segments = segmentsById.get(invocationId) ?? [];
      if (direct.length + segments.length !== 1) {
        throw new ProjectAuthorityStoreError(
          "action_archive_identity",
          `run ${run.id} lacks one exact archived action authority: ${invocationId}`,
        );
      }
      if (direct.length === 1) {
        const row = direct[0]!;
        if (
          row.protocol !== "koni.run-action-archive.v2" ||
          row.terminalAuthority?.invocationId !== invocationId
        ) {
          throw new ProjectAuthorityStoreError(
            "action_archive_read_only",
            `run ${run.id} archived action is not current mutation authority: ${invocationId}`,
          );
        }
        selectedRows.set(invocationId, row);
        continue;
      }
      const segment = segments[0]!;
      if (
        segment.protocol !== "koni.run-action-archive-segment.v2" ||
        segment.artifactSizeBytes > MAX_ARCHIVE_ARTIFACT_BYTES
      ) {
        throw new ProjectAuthorityStoreError(
          "action_archive_read_only",
          `run ${run.id} archived segment is not current mutation authority: ${invocationId}`,
        );
      }
      const existing = segmentGroups.get(segment.artifactPath);
      if (existing !== undefined && canonicalHash(existing.segment) !== canonicalHash(segment)) {
        throw new ProjectAuthorityStoreError(
          "action_archive_identity",
          `run ${run.id} reuses one selected segment path with different authority`,
        );
      }
      const group = existing ?? { segment, invocationIds: [] };
      group.invocationIds.push(invocationId);
      segmentGroups.set(segment.artifactPath, group);
    }

    const groups = [...segmentGroups.values()].sort((left, right) =>
      left.segment.artifactPath.localeCompare(right.segment.artifactPath),
    );
    assertSelectedArchiveDeclaredBytes(run.id, [
      ...groups.map(({ segment }) => segment.artifactSizeBytes),
      ...requested.flatMap((invocationId) => {
        const direct = selectedRows.get(invocationId);
        return direct === undefined ? [] : [direct.artifactSizeBytes];
      }),
    ]);
    const segmentSelections = await mapBoundedDrained(
      groups,
      MAX_ARCHIVE_READ_CONCURRENCY,
      async ({ segment, invocationIds: selectedIds }) => {
        const bytes = await this.#archiveReads.run(() =>
          readBounded(
            path.join(this.#root, segment.artifactPath),
            MAX_ARCHIVE_ARTIFACT_BYTES,
            `run ${run.id} action archive segment`,
          ),
        );
        let rows: RunActionExecutionArchiveRecord[];
        try {
          rows = validateRunActionArchiveSegmentArtifact(run.id, segment, bytes);
        } catch (error) {
          throw new ProjectAuthorityStoreError(
            "action_archive_segment",
            error instanceof Error
              ? error.message
              : `run ${run.id} action archive segment is invalid`,
          );
        }
        const wanted = new Set(selectedIds);
        const matches = new Map<string, RunActionExecutionArchiveRecord>();
        for (const row of rows) {
          if (!wanted.has(row.invocationId)) continue;
          if (
            matches.has(row.invocationId) ||
            row.protocol !== "koni.run-action-archive.v2" ||
            row.terminalAuthority?.invocationId !== row.invocationId
          ) {
            throw new ProjectAuthorityStoreError(
              "action_archive_identity",
              `run ${run.id} segment lacks exact current action row ${row.invocationId}`,
            );
          }
          matches.set(row.invocationId, row);
        }
        if (matches.size !== wanted.size) {
          throw new ProjectAuthorityStoreError(
            "action_archive_identity",
            `run ${run.id} selected segment lacks requested action authority`,
          );
        }
        return matches;
      },
    );
    for (const matches of segmentSelections) {
      for (const [invocationId, row] of matches) selectedRows.set(invocationId, row);
    }
    if (selectedRows.size !== requested.length) {
      throw new ProjectAuthorityStoreError(
        "action_archive_identity",
        `run ${run.id} did not resolve every selected archived action`,
      );
    }

    assertSelectedArchiveDeclaredBytes(run.id, [
      ...groups.map(({ segment }) => segment.artifactSizeBytes),
      ...requested.map((invocationId) => selectedRows.get(invocationId)!.artifactSizeBytes),
    ]);
    const actions = await mapBoundedDrained(
      requested,
      MAX_ARCHIVE_READ_CONCURRENCY,
      async (invocationId) => {
        const row = selectedRows.get(invocationId)!;
        if (row.artifactSizeBytes > MAX_ARCHIVE_ARTIFACT_BYTES) {
          throw new ProjectAuthorityStoreError(
            "action_archive_budget",
            `run ${run.id} archived action ${invocationId} exceeds its durable artifact bound`,
          );
        }
        const bytes = await this.#archiveReads.run(() =>
          readBounded(
            path.join(this.#root, row.artifactPath),
            MAX_ARCHIVE_ARTIFACT_BYTES,
            `run ${run.id} archived action ${invocationId}`,
          ),
        );
        try {
          return [invocationId, validateRunActionArchiveArtifact(run, row, bytes)] as const;
        } catch (error) {
          throw new ProjectAuthorityStoreError(
            "action_archive_artifact",
            error instanceof Error
              ? error.message
              : `run ${run.id} action archive artifact is invalid`,
          );
        }
      },
    );
    return new Map(actions);
  }

  async #readCurrentState(
    options: Readonly<{ allowLegacyRunAnchors?: boolean }> = {},
  ): Promise<{ state: ProjectAuthorityState; bytes: Buffer }> {
    const result = await readStateWithBytes(
      this.#stateFile(),
      options.allowLegacyRunAnchors === true,
    );
    if (
      result.state.projectRoot !== this.#projectRoot ||
      result.state.commonDirectory !== this.#commonDirectory
    ) {
      throw new ProjectAuthorityStoreError(
        "project_identity",
        "durable authority state belongs to a different Git repository",
      );
    }
    return result;
  }

  async #getRunAtState(runId: string, state: Readonly<ProjectAuthorityState>): Promise<RunRecord> {
    assertRunId(runId);
    // `validateState` already proves exact equality between sorted runIds and anchor-map keys.
    // Anchor membership is therefore the O(1) indexed-membership proof for large scans.
    if (!Object.hasOwn(state.runRecordSha256 ?? {}, runId)) {
      throw new ProjectAuthorityStoreError(
        "run_unindexed",
        `run is not indexed by project authority state: ${runId}`,
      );
    }
    const bytes = await readBounded(this.#runFile(runId), MAX_RUN_BYTES, `run ${runId}`);
    assertExactRunRecordAnchor(state, runId, bytes);
    return parseRunRecord(bytes, runId);
  }

  async #runSummaryPageAnchor(
    runId: string,
    state: Readonly<ProjectAuthorityState>,
    includeDeleted: boolean,
  ): Promise<RunSummaryPageAnchor> {
    let selected: RunRecord;
    try {
      selected = await this.#getRunAtState(runId, state);
    } catch (error) {
      if (
        error instanceof ProjectAuthorityStoreError &&
        (error.code === "run_missing" || error.code === "run_unindexed")
      ) {
        throw new RunSummaryPageError(
          "run_page_target",
          "selected run is not in this authority snapshot",
        );
      }
      throw error;
    }
    if (!includeDeleted && selected.lifecycle.phase === "deleted") {
      throw new RunSummaryPageError(
        "run_page_target",
        "selected run is excluded by the deleted-run filter",
      );
    }
    return { id: selected.id, createdAt: selected.createdAt, runRevision: selected.revision };
  }

  async #initialize(): Promise<void> {
    try {
      await this.#readCurrentState({ allowLegacyRunAnchors: true });
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
      runRecordSha256: Object.create(null) as Record<string, Sha256Digest>,
      receipts: Object.create(null) as Record<string, DurableAuthorityReceipt>,
      monitorEventCursor: 0,
      monitorEvents: [],
    };
    validateState(initial);
    const txId = `authority-init-${randomUUID()}`;
    try {
      await this.#transactions.prepare(txId, [
        {
          path: "authority/state.json",
          bytes: encodeBounded(initial, MAX_STATE_BYTES, "authority state"),
          expectedSha256: null,
        },
      ]);
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
   * One-time trust-root bootstrap for projects written before exact run-byte anchors. This is a
   * guarded TOFU migration: every indexed run must still be a strict or explicitly recognized
   * legacy Koni record with authenticated archive inventory. Once installed, later coordinated
   * run/archive edits cannot be accepted without also rewriting the authority root itself.
   */
  async #migrateLegacyRunRecordAnchors(): Promise<void> {
    const { state: current, bytes: currentStateBytes } = await this.#readCurrentState({
      allowLegacyRunAnchors: true,
    });
    if (current.runRecordSha256 !== undefined) return;

    const anchors: Record<string, Sha256Digest> = Object.create(null) as Record<
      string,
      Sha256Digest
    >;
    for (const runId of current.runIds) {
      const bytes = await readBounded(this.#runFile(runId), MAX_RUN_BYTES, `run ${runId}`);
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new ProjectAuthorityStoreError("run_json", `run record is not valid JSON: ${runId}`);
      }
      try {
        await this.#normalizeStoredRun(value, runId, current.updatedAt);
      } catch (error) {
        if (error instanceof ProjectAuthorityStoreError) throw error;
        throw new ProjectAuthorityStoreError(
          "legacy_run_anchor_migration",
          error instanceof Error
            ? `pre-anchor run is not a recognized guarded compatibility record: ${runId}: ${error.message}`
            : `pre-anchor run is not a recognized guarded compatibility record: ${runId}`,
        );
      }
      anchors[runId] = rawSha256(bytes);
    }

    const next = structuredClone(current);
    next.revision += 1;
    next.updatedAt = new Date().toISOString();
    next.runRecordSha256 = anchors;
    validateState(next);
    let nextBytes: Buffer;
    try {
      nextBytes = encodeBounded(next, MAX_STATE_BYTES, "authority state");
    } catch (error) {
      if (error instanceof ProjectAuthorityStoreError && error.code === "file_size") {
        throw new ProjectAuthorityStoreError(
          "legacy_run_anchor_capacity",
          `pre-anchor authority state cannot represent exact run-byte anchors within ${MAX_STATE_BYTES} bytes`,
        );
      }
      throw error;
    }
    const txId = `legacy-run-anchor-migration-${next.revision}-${randomUUID()}`;
    await this.#transactions.prepare(txId, [
      {
        path: "authority/state.json",
        bytes: nextBytes,
        expectedSha256: rawSha256(currentStateBytes),
      },
    ]);
    await this.#transactions.commit(txId);
    await this.#transactions.cleanupCommitted(txId);
  }

  /**
   * Normalize at most one legacy run per state-last transaction. Flat Git and field-absent-v1
   * archive projections compose in memory, so only one strict final record and exact raw anchor
   * are ever published.
   */
  async #migrateLegacyRunRecords(): Promise<void> {
    const indexedRunIds = (await this.#readCurrentState()).state.runIds;
    for (const runId of indexedRunIds) {
      const { state: current, bytes: currentStateBytes } = await this.#readCurrentState();
      if (!current.runIds.includes(runId)) continue;
      const file = this.#runFile(runId);
      const bytes = await readBounded(file, MAX_RUN_BYTES, `run ${runId}`);
      assertExactRunRecordAnchor(current, runId, bytes);
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new ProjectAuthorityStoreError("run_json", `run record is not valid JSON: ${runId}`);
      }
      if (!hasLegacyFlatRunGitRecord(value) && !hasLegacyTerminalArchiveProjection(value)) {
        assertRunRecord(value);
        assertTicketGraph(value.tickets);
        continue;
      }
      const migratedAt = new Date().toISOString();
      const normalized = await this.#normalizeStoredRun(value, runId, migratedAt);
      if (!normalized.requiresMigration) continue;
      const migratedBytes = encodeBounded(normalized.record, MAX_RUN_BYTES, `run ${runId}`);
      if (migratedBytes.equals(bytes)) {
        throw new ProjectAuthorityStoreError(
          "legacy_run_migration",
          `run ${runId} requires compatibility migration but final bytes did not change`,
        );
      }
      const runWrite: TransactionWrite = {
        path: relativeRunFile(runId),
        bytes: migratedBytes,
        expectedSha256: rawSha256(bytes),
      };
      const next = structuredClone(current);
      next.revision += 1;
      next.updatedAt = migratedAt;
      next.runRecordSha256![runId] = rawSha256(migratedBytes);
      validateState(next);
      const stateWrite: TransactionWrite = {
        path: "authority/state.json",
        bytes: encodeBounded(next, MAX_STATE_BYTES, "authority state"),
        expectedSha256: rawSha256(currentStateBytes),
      };
      const writes = [runWrite, stateWrite];
      assertProjectTransactionPayload(writes);
      const txId = `legacy-run-migration-${next.revision}-${randomUUID()}`;
      await this.#transactions.prepare(txId, writes);
      await this.#transactions.commit(txId);
      await this.#transactions.cleanupCommitted(txId);
    }
  }

  #stateFile(): string {
    return path.join(this.#root, "authority", "state.json");
  }

  #runFile(runId: string): string {
    return path.join(this.#root, relativeRunFile(runId));
  }

  async #serialized<T>(operation: () => Promise<T>, readOnly = false): Promise<T> {
    const inherited = this.#laneContext.getStore();
    if (inherited?.active === true) {
      return this.#runReentrant(inherited.lease, inherited.readOnly || readOnly, operation);
    }
    const invoke = () => {
      const lease: StoreLaneLease = { descendants: new Set() };
      const context: StoreLaneContext = { active: true, lease, readOnly };
      return this.#laneContext.run(context, async () => {
        try {
          return await operation();
        } finally {
          // The outer callback has ended, so a continuation that has not yet entered a store
          // operation must queue normally. Operations that already entered have their own scoped
          // token and keep this lease until their complete nested operation tree settles.
          context.active = false;
          while (lease.descendants.size > 0) {
            await Promise.all([...lease.descendants]);
          }
        }
      });
    };
    const pending = this.#tail.then(invoke, invoke);
    this.#tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  #runReentrant<T>(
    lease: StoreLaneLease,
    readOnly: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    const context: StoreLaneContext = { active: true, lease, readOnly };
    const pending = this.#laneContext.run(context, async () => {
      try {
        return await operation();
      } finally {
        // Descendants created after this exact operation settles are detached. They inherit this
        // inactive token and therefore cannot bypass the outer transaction's publication barrier.
        context.active = false;
      }
    });
    let completion!: Promise<void>;
    completion = pending
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => lease.descendants.delete(completion));
    lease.descendants.add(completion);
    return pending;
  }
}

interface ArchiveInvocationIdentityIndex {
  registerArchived(invocationIds: readonly string[]): void;
  hasArchived(invocationId: string): boolean;
  archivedCount(): number;
}

async function withArchiveInvocationIndex<Value>(
  root: string,
  liveInvocationIds: readonly string[],
  operation: (index: ArchiveInvocationIdentityIndex) => Promise<Value>,
): Promise<Value> {
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } catch (error) {
    throw new ProjectAuthorityStoreError(
      "legacy_migration_runtime",
      error instanceof Error
        ? `guarded legacy archive authentication requires node:sqlite: ${error.message}`
        : "guarded legacy archive authentication requires node:sqlite",
    );
  }

  const scratch = await mkdtemp(path.join(root, ".archive-validation-"));
  let database: import("node:sqlite").DatabaseSync | undefined;
  let value: Value | undefined;
  let primaryError: unknown;
  let completed = false;
  try {
    database = new sqlite.DatabaseSync(path.join(scratch, "invocations.sqlite"), {
      allowExtension: false,
    });
    database.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = FILE;
      PRAGMA cache_size = -2048;
      CREATE TABLE invocation_identity (
        id TEXT PRIMARY KEY,
        archived INTEGER NOT NULL CHECK (archived IN (0, 1))
      ) WITHOUT ROWID;
    `);
    const insert = database.prepare(
      "INSERT OR IGNORE INTO invocation_identity (id, archived) VALUES (?, ?)",
    );
    const findArchived = database.prepare("SELECT archived FROM invocation_identity WHERE id = ?");
    let archivedCount = 0;
    const register = (ids: readonly string[], archived: 0 | 1): void => {
      database!.exec("BEGIN IMMEDIATE");
      try {
        for (const id of ids) {
          const result = insert.run(id, archived);
          if (Number(result.changes) !== 1) {
            throw new ProjectAuthorityStoreError(
              "action_archive_identity",
              `run archive repeats live/archived action ${id}`,
            );
          }
        }
        database!.exec("COMMIT");
        if (archived === 1) archivedCount += ids.length;
      } catch (error) {
        try {
          database!.exec("ROLLBACK");
        } catch {
          // The exact validation error remains primary; this scratch database is never authority.
        }
        throw error;
      }
    };
    register(liveInvocationIds, 0);
    const index: ArchiveInvocationIdentityIndex = {
      registerArchived: (ids) => register(ids, 1),
      hasArchived: (id) => {
        const row = findArchived.get(id) as { archived?: unknown } | undefined;
        return row?.archived === 1;
      },
      archivedCount: () => archivedCount,
    };
    value = await operation(index);
    completed = true;
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  if (database !== undefined) {
    try {
      database.close();
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    await rm(scratch, { recursive: true, force: true });
  } catch (error) {
    cleanupError ??= error;
  }
  if (!completed) throw primaryError;
  if (cleanupError !== undefined) {
    throw new ProjectAuthorityStoreError(
      "legacy_migration_cleanup",
      cleanupError instanceof Error
        ? `legacy archive authentication scratch cleanup failed: ${cleanupError.message}`
        : "legacy archive authentication scratch cleanup failed",
    );
  }
  return value as Value;
}

function indexTerminalProofs<Proof extends Readonly<{ actionInvocationId: string }>>(
  runId: string,
  proofs: readonly Proof[],
  kind: "failure" | "success",
): Map<string, Proof> {
  const indexed = new Map<string, Proof>();
  for (const proof of proofs) {
    if (indexed.has(proof.actionInvocationId)) {
      throw new ProjectAuthorityStoreError(
        "action_archive_authority",
        `run ${runId} repeats terminal ${kind} proof action ${proof.actionInvocationId}`,
      );
    }
    indexed.set(proof.actionInvocationId, proof);
  }
  return indexed;
}

async function assertExactStreamingArchiveRowInventory(
  options: Readonly<{
    root: string;
    runId: string;
    identityIndex: ArchiveInvocationIdentityIndex;
  }>,
): Promise<void> {
  const expected = options.identityIndex.archivedCount();
  const absolute = path.join(options.root, `runs/${options.runId}/actions/archive`);
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch (error) {
    if (isCode(error, "ENOENT") && expected === 0) return;
    if (isCode(error, "ENOENT")) {
      throw new ProjectAuthorityStoreError(
        "action_archive_inventory",
        `run ${options.runId} archive row artifact directory is missing`,
      );
    }
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ProjectAuthorityStoreError(
      "action_archive_inventory",
      `run ${options.runId} archive row artifact directory is unsafe`,
    );
  }
  const canonicalName = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/u;
  const directory = await opendir(absolute);
  let count = 0;
  for await (const entry of directory) {
    count += 1;
    const match = canonicalName.exec(entry.name);
    if (
      count > expected ||
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      match === null ||
      !options.identityIndex.hasArchived(match[1]!)
    ) {
      throw new ProjectAuthorityStoreError(
        "action_archive_inventory",
        `run ${options.runId} archive row inventory contains an unexpected entry`,
      );
    }
    if (count % 4_096 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  if (count !== expected) {
    throw new ProjectAuthorityStoreError(
      "action_archive_inventory",
      `run ${options.runId} archive row inventory is incomplete`,
    );
  }
}

async function assertExactArchiveArtifactInventory(
  options: Readonly<{
    root: string;
    runId: string;
    kind: "row" | "segment";
    directory: string;
    expectedPaths: readonly string[];
  }>,
): Promise<void> {
  const expected = new Set(options.expectedPaths);
  if (expected.size !== options.expectedPaths.length) {
    throw new ProjectAuthorityStoreError(
      "action_archive_inventory",
      `run ${options.runId} repeats an archive ${options.kind} artifact path`,
    );
  }
  const canonicalName =
    options.kind === "row" ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u : /^[a-f0-9]{64}\.json$/u;
  for (const relative of expected) {
    if (
      path.posix.dirname(relative) !== options.directory ||
      !canonicalName.test(path.posix.basename(relative))
    ) {
      throw new ProjectAuthorityStoreError(
        "action_archive_inventory",
        `run ${options.runId} names a noncanonical archive ${options.kind} artifact`,
      );
    }
  }

  const absolute = path.join(options.root, options.directory);
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch (error) {
    if (isCode(error, "ENOENT") && expected.size === 0) return;
    if (isCode(error, "ENOENT")) {
      throw new ProjectAuthorityStoreError(
        "action_archive_inventory",
        `run ${options.runId} archive ${options.kind} artifact directory is missing`,
      );
    }
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ProjectAuthorityStoreError(
      "action_archive_inventory",
      `run ${options.runId} archive ${options.kind} artifact directory is unsafe`,
    );
  }

  const remaining = new Set(expected);
  const directory = await opendir(absolute);
  let count = 0;
  for await (const entry of directory) {
    count += 1;
    // The authenticated run index is also the enumeration bound. Recovery has already completed,
    // so even one extra entry is neither transaction debris nor admissible archive authority.
    if (
      count > expected.size ||
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !canonicalName.test(entry.name)
    ) {
      throw new ProjectAuthorityStoreError(
        "action_archive_inventory",
        `run ${options.runId} archive ${options.kind} inventory contains an unexpected entry`,
      );
    }
    const relative = `${options.directory}/${entry.name}`;
    if (!remaining.delete(relative)) {
      throw new ProjectAuthorityStoreError(
        "action_archive_inventory",
        `run ${options.runId} archive ${options.kind} inventory contains an unindexed artifact`,
      );
    }
  }
  if (remaining.size !== 0) {
    throw new ProjectAuthorityStoreError(
      "action_archive_inventory",
      `run ${options.runId} archive ${options.kind} inventory is incomplete`,
    );
  }
}

function requiredArchivedActionIdsForMutation(
  previous: Readonly<RunRecord>,
  next: Readonly<RunRecord>,
): ReadonlySet<string> {
  const required = new Set<string>();
  for (const [ticketId, priorTicket] of Object.entries(previous.tickets)) {
    const prior = priorTicket.executionControl?.terminalResolverRetryRequests ?? [];
    const current = next.tickets[ticketId]?.executionControl?.terminalResolverRetryRequests ?? [];
    for (const request of current.slice(prior.length)) {
      const invocationId = request.failureProof.actionInvocationId;
      if (previous.actionExecutions?.[invocationId] === undefined) required.add(invocationId);
    }
  }
  return required;
}

function assertSelectedArchiveDeclaredBytes(runId: string, sizes: readonly number[]): void {
  let total = 0;
  for (const size of sizes) {
    if (
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > MAX_ARCHIVE_ARTIFACT_BYTES ||
      total > MAX_TRANSACTION_BYTES - size
    ) {
      throw new ProjectAuthorityStoreError(
        "action_archive_budget",
        `run ${runId} selected archive authority exceeds ${MAX_TRANSACTION_BYTES} declared bytes`,
      );
    }
    total += size;
  }
}

function assertExactArchiveMutationWrites(
  runId: string,
  supplied: readonly TransactionWrite[],
  deletes: readonly TransactionDelete[],
  required: readonly Readonly<{ path: string; bytes: Buffer }>[],
): void {
  const archivePrefix = `runs/${runId}/actions/archive/`;
  const segmentPrefix = `runs/${runId}/actions/archive-index/`;
  const archiveIdentity = portableDurablePathIdentity(archivePrefix);
  const segmentIdentity = portableDurablePathIdentity(segmentPrefix);
  const relevant = supplied.filter(
    (write) =>
      portableDurablePathIdentity(write.path).startsWith(archiveIdentity) ||
      portableDurablePathIdentity(write.path).startsWith(segmentIdentity),
  );
  if (
    deletes.some(
      (entry) =>
        portableDurablePathIdentity(entry.path).startsWith(archiveIdentity) ||
        portableDurablePathIdentity(entry.path).startsWith(segmentIdentity),
    )
  ) {
    throw new ProjectAuthorityStoreError(
      "action_archive_transaction",
      `run ${runId} cannot delete immutable archive artifacts`,
    );
  }
  if (relevant.length !== required.length) {
    throw new ProjectAuthorityStoreError(
      "action_archive_transaction",
      `run ${runId} archive state and artifact writes differ`,
    );
  }
  const byPath = new Map(relevant.map((write) => [write.path, write]));
  if (byPath.size !== relevant.length) {
    throw new ProjectAuthorityStoreError(
      "action_archive_transaction",
      `run ${runId} repeats an archive artifact destination`,
    );
  }
  for (const expected of required) {
    const write = byPath.get(expected.path);
    if (
      write === undefined ||
      write.expectedSha256 !== null ||
      !Buffer.from(write.bytes).equals(expected.bytes)
    ) {
      throw new ProjectAuthorityStoreError(
        "action_archive_transaction",
        `run ${runId} did not introduce its exact archive artifact in the same CAS`,
      );
    }
  }
}

function assertConfiguredLifecycleMutation(
  previous: Readonly<RunRecord>,
  next: Readonly<RunRecord>,
  actors: RunWrite["lifecycleActors"],
): void {
  if (previous.lifecycleCatalog === undefined) {
    // A guarded compatibility migration may attach the exact pinned catalog. The run-record
    // validator already authenticates its configuration binding before this point.
    return;
  }
  if (next.lifecycleCatalog === undefined) {
    throw new ProjectAuthorityStoreError(
      "lifecycle_catalog_removed",
      `run ${next.id} cannot discard its configured lifecycle authority`,
    );
  }
  if (next.lifecycleCatalog.catalog_sha256 !== previous.lifecycleCatalog.catalog_sha256) {
    throw new ProjectAuthorityStoreError(
      "lifecycle_catalog_changed",
      `run ${next.id} cannot reinterpret lifecycle state under a different catalog`,
    );
  }
  assertConfiguredTicketLifecycleMutation(previous, next, actors?.tickets);
  const from = configuredRunState(previous.lifecycle.phase);
  const to = configuredRunState(next.lifecycle.phase);
  if (from === to) return;
  const actor =
    actors?.run ??
    (to === "paused" || (from === "paused" && to === "active") || to === "stopped"
      ? "human"
      : "compiler");
  assertLifecycleActor(actor, `run ${next.id}`);
  authorizeConfiguredRunTransition(next.lifecycleCatalog, {
    from: previous.lifecycle.phase,
    to: next.lifecycle.phase,
    actor,
  });
}

function assertConfiguredInitialLifecycle(
  run: Readonly<RunRecord>,
  actors: RunWrite["lifecycleActors"],
): void {
  const catalog = run.lifecycleCatalog;
  if (catalog === undefined) return;
  if (configuredRunState(run.lifecycle.phase) !== "active") {
    throw new ProjectAuthorityStoreError(
      "lifecycle_initial_run",
      `new run ${run.id} must enter the configured active lifecycle`,
    );
  }
  const synthetic: Pick<RunRecord, "id" | "tickets" | "lifecycleCatalog"> = {
    id: run.id,
    tickets: {},
    lifecycleCatalog: catalog,
  };
  assertConfiguredTicketLifecycleMutation(synthetic, run, actors?.tickets);
}

function assertConfiguredTicketLifecycleMutation(
  previous: Readonly<Pick<RunRecord, "id" | "tickets" | "lifecycleCatalog">>,
  next: Readonly<Pick<RunRecord, "id" | "tickets" | "lifecycleCatalog">>,
  actors: Readonly<Record<string, string>> | undefined,
): void {
  const catalog = next.lifecycleCatalog;
  if (catalog === undefined) return;
  const machine = catalog.machines.ticket;
  if (machine === undefined) {
    // The configured authorizer emits the canonical missing-machine diagnostic below for any
    // actual transition. Fail here as well when a run happens to contain no tickets.
    throw new ProjectAuthorityStoreError(
      "lifecycle_ticket_machine_missing",
      `run ${next.id} has no configured ticket lifecycle authority`,
    );
  }
  const changed = new Set<string>();
  for (const ticketId of Object.keys(previous.tickets)) {
    if (next.tickets[ticketId] === undefined) {
      throw new ProjectAuthorityStoreError(
        "lifecycle_ticket_removed",
        `run ${next.id} cannot remove durable ticket ${ticketId}`,
      );
    }
  }
  for (const [ticketId, ticket] of Object.entries(next.tickets)) {
    const priorStatus = previous.tickets[ticketId]?.status ?? "todo";
    if (
      configuredTicketState(machine, priorStatus) === configuredTicketState(machine, ticket.status)
    ) {
      continue;
    }
    changed.add(ticketId);
    const actor = actors?.[ticketId] ?? "compiler";
    assertLifecycleActor(actor, `ticket ${next.id}/${ticketId}`);
    authorizeConfiguredTicketTransition(catalog, {
      from: priorStatus,
      to: ticket.status,
      actor,
    });
  }
  for (const ticketId of Object.keys(actors ?? {})) {
    if (!changed.has(ticketId)) {
      throw new ProjectAuthorityStoreError(
        "lifecycle_ticket_actor_unused",
        `ticket lifecycle actor was supplied without a configured transition: ${next.id}/${ticketId}`,
      );
    }
  }
}

function assertLifecycleActor(actor: string, label: string): void {
  if (actor.trim().length === 0 || actor.includes("\u0000")) {
    throw new ProjectAuthorityStoreError(
      "lifecycle_actor",
      `${label} has an invalid configured lifecycle actor`,
    );
  }
}

export function authorityRequestHash(method: string, params: JsonValue | undefined): Sha256Digest {
  return canonicalHash({ method, params: params ?? null });
}

function receiptId(method: string, idempotencyKey: string): Sha256Digest {
  return canonicalHash({ method, idempotencyKey });
}

function pruneReceipts(receipts: Record<string, DurableAuthorityReceipt>): void {
  const ordered = Object.values(receipts).sort(
    (left, right) => left.revision - right.revision || left.id.localeCompare(right.id),
  );
  for (const receipt of ordered.slice(0, Math.max(0, ordered.length - MAX_RECEIPTS))) {
    delete receipts[receipt.id];
  }
}

function validateState(
  state: ProjectAuthorityState,
  options: Readonly<{ allowLegacyRunAnchors?: boolean }> = {},
): void {
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
  if (
    new Set(sorted).size !== sorted.length ||
    new Set(sorted.map((id) => portableDurablePathIdentity(id))).size !== sorted.length ||
    sorted.some((id, index) => id !== state.runIds[index])
  ) {
    throw new ProjectAuthorityStoreError(
      "state_runs",
      "authority run index is not unique and sorted",
    );
  }
  for (const id of state.runIds) assertRunId(id);
  if (state.runRecordSha256 === undefined) {
    if (options.allowLegacyRunAnchors !== true) {
      throw new ProjectAuthorityStoreError(
        "state_run_anchors",
        "authority state predates exact run-byte anchors",
      );
    }
  } else {
    if (!isRecord(state.runRecordSha256)) {
      throw new ProjectAuthorityStoreError("state_run_anchors", "run-byte anchor map is invalid");
    }
    const anchorIds = Object.keys(state.runRecordSha256).sort();
    if (
      anchorIds.length !== state.runIds.length ||
      anchorIds.some(
        (id, index) => id !== state.runIds[index] || !isSha256Digest(state.runRecordSha256?.[id]),
      )
    ) {
      throw new ProjectAuthorityStoreError(
        "state_run_anchors",
        "run-byte anchor keys and authority run ids differ",
      );
    }
  }
  try {
    validateDurableMonitorJournal(state);
  } catch (error) {
    throw new ProjectAuthorityStoreError(
      "monitor_journal",
      error instanceof Error ? error.message : "authority monitor journal is invalid",
    );
  }
  if (state.authorityQuiesce !== undefined)
    validateAuthorityQuiesceOperation(state.authorityQuiesce);
  if (state.authorityStartup !== undefined) validateAuthorityStartupEpoch(state.authorityStartup);
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

function validateAuthorityQuiesceOperation(operation: DurableAuthorityQuiesceOperation): void {
  const { sha256, ...material } = operation;
  const requestedAtMs = Date.parse(operation.requestedAt);
  const expectedKeys = [
    "protocol",
    "requestHash",
    "idempotencyKey",
    "requestedAt",
    "totalRunCount",
    "targetRunCount",
    "pausedRunIds",
    "pausedRunIdsTruncated",
    "sha256",
    ...(operation.purpose === undefined ? [] : ["purpose"]),
  ];
  if (
    !hasExactOwnKeys(operation, expectedKeys) ||
    operation.protocol !== AUTHORITY_QUIESCE_OPERATION_PROTOCOL ||
    (operation.purpose !== undefined &&
      !new Set(["operator_restart", "startup_failure", "dirty_startup_recovery"]).has(
        operation.purpose,
      )) ||
    !isSha256Digest(operation.requestHash) ||
    !isSha256Digest(sha256) ||
    sha256 !== canonicalHash(material) ||
    !Number.isFinite(requestedAtMs) ||
    new Date(requestedAtMs).toISOString() !== operation.requestedAt ||
    !Number.isSafeInteger(operation.totalRunCount) ||
    operation.totalRunCount < 0 ||
    !Number.isSafeInteger(operation.targetRunCount) ||
    operation.targetRunCount < 0 ||
    operation.targetRunCount > operation.totalRunCount ||
    !Array.isArray(operation.pausedRunIds) ||
    operation.pausedRunIds.length > MAX_QUIESCE_ID_SAMPLE ||
    operation.pausedRunIdsTruncated !== operation.targetRunCount > operation.pausedRunIds.length
  ) {
    throw new ProjectAuthorityStoreError(
      "authority_quiesce_shape",
      "durable authority quiesce operation is invalid",
    );
  }
  validateIdempotencyKey(operation.idempotencyKey);
  const sorted = [...operation.pausedRunIds].sort(compareUtf8);
  if (
    new Set(sorted).size !== sorted.length ||
    sorted.some((id, index) => id !== operation.pausedRunIds[index])
  ) {
    throw new ProjectAuthorityStoreError(
      "authority_quiesce_shape",
      "durable authority quiesce sample is not unique and sorted",
    );
  }
  for (const id of sorted) assertRunId(id);
}

function validateAuthorityStartupEpoch(epoch: DurableAuthorityStartupEpoch): void {
  const { sha256, ...material } = epoch;
  const startedAtMs = Date.parse(epoch.startedAt);
  const readyAtMs = epoch.readyAt === undefined ? undefined : Date.parse(epoch.readyAt);
  const expectedKeys = [
    "protocol",
    "epochId",
    "status",
    "startedAt",
    "startingRevision",
    "sha256",
    ...(epoch.status === "ready" ? ["readyAt"] : []),
  ];
  if (
    !hasExactOwnKeys(epoch, expectedKeys) ||
    epoch.protocol !== AUTHORITY_STARTUP_EPOCH_PROTOCOL ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(epoch.epochId) ||
    (epoch.status !== "recovering" && epoch.status !== "ready") ||
    !Number.isSafeInteger(epoch.startingRevision) ||
    epoch.startingRevision < 0 ||
    !Number.isFinite(startedAtMs) ||
    new Date(startedAtMs).toISOString() !== epoch.startedAt ||
    (epoch.status === "recovering" && epoch.readyAt !== undefined) ||
    (epoch.status === "ready" &&
      (readyAtMs === undefined ||
        !Number.isFinite(readyAtMs) ||
        new Date(readyAtMs).toISOString() !== epoch.readyAt ||
        readyAtMs < startedAtMs)) ||
    !isSha256Digest(sha256) ||
    sha256 !== canonicalHash(material)
  ) {
    throw new ProjectAuthorityStoreError(
      "authority_startup_shape",
      "durable authority startup epoch is invalid",
    );
  }
}

function assertAuthorityStartupTransition(
  current: DurableAuthorityStartupEpoch | undefined,
  next: DurableAuthorityStartupEpoch,
  authorityRevision: number,
): void {
  if (next.status === "recovering") {
    if (next.startingRevision !== authorityRevision || current?.epochId === next.epochId) {
      throw new ProjectAuthorityStoreError(
        "authority_startup_transition",
        "a recovering startup epoch must be a fresh identity at the exact authority revision",
      );
    }
    return;
  }
  if (
    current?.status !== "recovering" ||
    next.epochId !== current.epochId ||
    next.startedAt !== current.startedAt ||
    next.startingRevision !== current.startingRevision
  ) {
    throw new ProjectAuthorityStoreError(
      "authority_startup_transition",
      "only the exact recovering startup epoch may transition to ready",
    );
  }
}

function hasExactOwnKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareUtf8);
  const required = [...expected].sort(compareUtf8);
  return actual.length === required.length && actual.every((key, index) => key === required[index]);
}

async function readStateWithBytes(
  file: string,
  allowLegacyRunAnchors = false,
): Promise<{ state: ProjectAuthorityState; bytes: Buffer }> {
  const bytes = await readBounded(file, MAX_STATE_BYTES, "authority state");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ProjectAuthorityStoreError("state_json", "authority state is not valid JSON");
  }
  validateState(value as ProjectAuthorityState, { allowLegacyRunAnchors });
  return { state: value as ProjectAuthorityState, bytes };
}

async function readOptionalBounded(
  file: string,
  maximum: number,
  label: string,
): Promise<Buffer | undefined> {
  try {
    return await readBounded(file, maximum, label);
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function parseRunRecord(bytes: Buffer, runId: string): RunRecord {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ProjectAuthorityStoreError("run_json", `run record is not valid JSON: ${runId}`);
  }
  assertRunRecord(value);
  assertTicketGraph(value.tickets);
  if (value.id !== runId) {
    throw new ProjectAuthorityStoreError(
      "run_identity",
      `run path does not match record: ${runId}`,
    );
  }
  return value;
}

function assertExactRunRecordAnchor(
  state: Readonly<ProjectAuthorityState>,
  runId: string,
  bytes: Buffer,
): void {
  const anchors = state.runRecordSha256 ?? {};
  const expected = Object.hasOwn(anchors, runId) ? anchors[runId] : undefined;
  // Valid state proves anchor keys and runIds are identical; avoid an O(n) includes call per row.
  if (expected === undefined || rawSha256(bytes) !== expected) {
    throw new ProjectAuthorityStoreError(
      "run_anchor_mismatch",
      `exact run bytes differ from project authority anchor: ${runId}`,
    );
  }
}

function normalizeTransactionPath(input: string): string {
  if (
    input.includes("\\") ||
    input.includes("\0") ||
    path.isAbsolute(input) ||
    !/^[\x20-\x7E]+$/u.test(input)
  ) {
    throw new ProjectAuthorityStoreError("transaction_path", `unsafe transaction path: ${input}`);
  }
  const normalized = path.posix.normalize(input);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new ProjectAuthorityStoreError("transaction_path", `unsafe transaction path: ${input}`);
  }
  return normalized;
}

function assertGenericAuthorityPath(relative: string, runWriteIds: ReadonlySet<string>): void {
  const folded = portableDurablePathIdentity(relative);
  const runRecord = /^runs\/([^/]+)\/run\.json$/u.exec(folded);
  if (runRecord !== null) {
    throw new ProjectAuthorityStoreError(
      "run_record_transaction",
      "generic artifact writes and deletes cannot target an authority-owned run record",
    );
  }
  const archive = /^runs\/([^/]+)\/actions\/(?:archive|archive-index)\//u.exec(folded);
  const foldedRunWriteIds = new Set(
    [...runWriteIds].map((runId) => portableDurablePathIdentity(runId)),
  );
  if (archive !== null && !foldedRunWriteIds.has(archive[1]!)) {
    throw new ProjectAuthorityStoreError(
      "action_archive_transaction",
      "archive artifacts require one exact matching authority run transition",
    );
  }
}

async function readBounded(file: string, maximum: number, label: string): Promise<Buffer> {
  try {
    return await readStableDurableFile(file, { maximum, label });
  } catch (error) {
    if (error instanceof DurableFileReadError) {
      throw new ProjectAuthorityStoreError(error.code, error.message);
    }
    throw error;
  }
}

function assertProjectTransactionPayload(writes: readonly TransactionWrite[]): void {
  const total = transactionPayloadBytes(writes);
  if (!Number.isSafeInteger(total) || total > MAX_TRANSACTION_BYTES) {
    throw new ProjectAuthorityStoreError(
      "transaction_size",
      `authority transaction payload ${String(total)} exceeds ${MAX_TRANSACTION_BYTES} bytes`,
    );
  }
}

function encodeBounded(value: unknown, maximum: number, label: string): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > maximum) {
    throw new ProjectAuthorityStoreError("file_size", `${label} exceeds its durable byte bound`);
  }
  return bytes;
}

function serializedJsonBytes(value: unknown): number {
  return serializedJsonValueBytes(value) + 1;
}

function serializedJsonValueBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
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
  if (
    Buffer.byteLength(value, "utf8") < 1 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    value.includes("\u0000")
  ) {
    throw new ProjectAuthorityStoreError(
      "idempotency_key",
      "idempotency key is empty or oversized",
    );
  }
}

function assertUniqueDestination(destinations: Set<string>, relative: string): void {
  const identity = portableDurablePathIdentity(relative);
  if (destinations.has(identity)) {
    throw new ProjectAuthorityStoreError(
      "duplicate_write",
      `transaction writes ${relative} more than once`,
    );
  }
  destinations.add(identity);
}

function hasLegacyTerminalArchiveProjection(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const rows = Array.isArray(value.actionExecutionArchive) ? value.actionExecutionArchive : [];
  const segments = Array.isArray(value.actionExecutionArchiveSegments)
    ? value.actionExecutionArchiveSegments
    : [];
  return (
    rows.some(
      (row) =>
        isRecord(row) &&
        row.protocol === "koni.run-action-archive.v1" &&
        row.terminalAuthority === undefined,
    ) ||
    segments.some(
      (segment) =>
        isRecord(segment) &&
        segment.protocol === "koni.run-action-archive-segment.v1" &&
        segment.terminalAuthorities === undefined,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
