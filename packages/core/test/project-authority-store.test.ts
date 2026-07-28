import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalHash, rawSha256 } from "../src/shared/canonical.js";
import { newRunLifecycle, reduceRunLifecycle } from "../src/state/run-lifecycle.js";
import type { RunRecord, TicketRecord, TicketStatus } from "../src/state/run-record.js";
import {
  STATE_MACHINE_CATALOG_PROTOCOL,
  type CompiledStateMachine,
  type CompiledStateMachineCatalog,
  type CompiledStateTransition,
} from "../src/contracts/rules.js";
import {
  authorityRequestHash,
  createAuthorityQuiesceOperation,
  createAuthorityStartupEpoch,
  ProjectAuthorityStore,
  type ProjectAuthorityStoreError,
} from "../src/authority/project-store.js";
import { FileTransactionStore } from "../src/authority/file-journal.js";
import { MAX_TRANSACTION_BYTES, MAX_TRANSACTION_EFFECTS } from "../src/authority/durable-limits.js";
import { fixtureRunGit } from "./run-record-fixtures.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project authority transaction store", () => {
  it("CAS-binds startup epochs and permits only fresh-recovering then exact-ready transitions", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const recovering = createAuthorityStartupEpoch({
      epochId: "startup-one",
      status: "recovering",
      startedAt: "2026-07-18T01:00:00.000Z",
      startingRevision: 0,
    });
    await expect(store.replaceAuthorityStartup(null, recovering)).resolves.toMatchObject({
      revision: 0,
      authorityStartup: { epochId: "startup-one", status: "recovering" },
    });

    const inventedReady = createAuthorityStartupEpoch({
      epochId: "startup-invented",
      status: "ready",
      startedAt: recovering.startedAt,
      startingRevision: 0,
      readyAt: "2026-07-18T01:00:01.000Z",
    });
    await expect(
      store.replaceAuthorityStartup(recovering.sha256, inventedReady),
    ).rejects.toMatchObject({ code: "authority_startup_transition" });
    const reusedRecovering = createAuthorityStartupEpoch({
      epochId: recovering.epochId,
      status: "recovering",
      startedAt: "2026-07-18T01:00:02.000Z",
      startingRevision: 0,
    });
    await expect(
      store.replaceAuthorityStartup(recovering.sha256, reusedRecovering),
    ).rejects.toMatchObject({ code: "authority_startup_transition" });

    const ready = createAuthorityStartupEpoch({
      epochId: recovering.epochId,
      status: "ready",
      startedAt: recovering.startedAt,
      startingRevision: recovering.startingRevision,
      readyAt: "2026-07-18T01:00:03.000Z",
    });
    const changedMaterialReady = createAuthorityStartupEpoch({
      epochId: recovering.epochId,
      status: "ready",
      startedAt: "2026-07-18T00:59:59.000Z",
      startingRevision: recovering.startingRevision,
      readyAt: "2026-07-18T01:00:03.000Z",
    });
    await expect(
      store.replaceAuthorityStartup(recovering.sha256, changedMaterialReady),
    ).rejects.toMatchObject({ code: "authority_startup_transition" });
    await expect(store.replaceAuthorityStartup(recovering.sha256, ready)).resolves.toMatchObject({
      revision: 0,
      authorityStartup: { epochId: recovering.epochId, status: "ready" },
    });
    await expect(store.replaceAuthorityStartup(recovering.sha256, ready)).rejects.toMatchObject({
      code: "authority_startup_conflict",
    });
    await expect(store.replaceAuthorityStartup(ready.sha256, ready)).rejects.toMatchObject({
      code: "authority_startup_transition",
    });

    const wrongRevision = createAuthorityStartupEpoch({
      epochId: "startup-two",
      status: "recovering",
      startedAt: "2026-07-18T01:00:04.000Z",
      startingRevision: 1,
    });
    await expect(store.replaceAuthorityStartup(ready.sha256, wrongRevision)).rejects.toMatchObject({
      code: "authority_startup_transition",
    });
    expect((await store.state()).authorityStartup).toEqual(ready);
  });

  it("persists a maximum validator-admitted startup identity with a fixed-width journal id", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const epoch = createAuthorityStartupEpoch({
      epochId: `s${"a".repeat(255)}`,
      status: "recovering",
      startedAt: "2026-07-18T01:10:00.000Z",
      startingRevision: 0,
    });
    await expect(store.replaceAuthorityStartup(null, epoch)).resolves.toMatchObject({
      authorityStartup: { epochId: epoch.epochId },
    });
    const statePath = path.join(root, "state", "authority", "state.json");
    const rawState = JSON.parse(await readFile(statePath, "utf8")) as {
      authorityStartup: Record<string, unknown> & { sha256: string };
    };
    const { sha256: _sha256, ...epochMaterial } = rawState.authorityStartup;
    const widened = { ...epochMaterial, ambientAuthority: true };
    rawState.authorityStartup = { ...widened, sha256: canonicalHash(widened) };
    await writeFile(statePath, `${JSON.stringify(rawState)}\n`);
    await expect(store.state()).rejects.toMatchObject({ code: "authority_startup_shape" });
  });

  it("hash-binds quiesce purpose and treats legacy purpose-less records as non-privileged", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const operation = createAuthorityQuiesceOperation({
      purpose: "operator_restart",
      requestHash: rawSha256("operator restart"),
      idempotencyKey: "startup-failure:caller-controlled-spoof",
      requestedAt: "2026-07-18T01:20:00.000Z",
      totalRunCount: 0,
      targetRunCount: 0,
      pausedRunIds: [],
      pausedRunIdsTruncated: false,
    });
    await store.commit({
      expectedRevision: 0,
      authorityQuiesce: { expectedSha256: null, value: operation },
    });
    expect((await store.state()).authorityQuiesce?.purpose).toBe("operator_restart");

    const statePath = path.join(root, "state", "authority", "state.json");
    const tampered = JSON.parse(await readFile(statePath, "utf8")) as {
      authorityQuiesce: { purpose?: string };
    };
    tampered.authorityQuiesce.purpose = "startup_failure";
    await writeFile(statePath, `${JSON.stringify(tampered)}\n`);
    await expect(store.state()).rejects.toMatchObject({ code: "authority_quiesce_shape" });

    // Purpose-less records produced before this field existed retain their original hash and load
    // only as legacy operator restarts; engine code never grants them draft-blocking authority.
    const legacyMaterial = structuredClone(operation) as typeof operation & { purpose?: string };
    delete legacyMaterial.purpose;
    const { sha256: _oldSha, ...legacyHashMaterial } = legacyMaterial;
    legacyMaterial.sha256 = canonicalHash(legacyHashMaterial);
    const repaired = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    repaired.authorityQuiesce = legacyMaterial;
    await writeFile(statePath, `${JSON.stringify(repaired)}\n`);
    await expect(store.state()).resolves.toMatchObject({
      authorityQuiesce: { idempotencyKey: operation.idempotencyKey },
    });
    const widenedState = JSON.parse(await readFile(statePath, "utf8")) as {
      authorityQuiesce: Record<string, unknown> & { sha256: string };
    };
    const { sha256: _legacySha, ...legacyMaterialWithExtra } = widenedState.authorityQuiesce;
    const widenedLegacy = { ...legacyMaterialWithExtra, ambientAuthority: true };
    widenedState.authorityQuiesce = { ...widenedLegacy, sha256: canonicalHash(widenedLegacy) };
    await writeFile(statePath, `${JSON.stringify(widenedState)}\n`);
    await expect(store.state()).rejects.toMatchObject({ code: "authority_quiesce_shape" });
  });

  it("atomically commits authority revision, run bytes, and a durable replay receipt", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const requestHash = authorityRequestHash("run.create", { objective: "Build it" });
    const result = await store.commit({
      expectedRevision: 0,
      runWrites: [{ record: runRecord(root), expectedRevision: null }],
      receipt: {
        method: "run.create",
        idempotencyKey: "create-one",
        requestHash,
        result: { runId: "run-one" },
      },
    });
    expect(result.state.revision).toBe(1);
    expect((await store.getRun("run-one")).objective).toBe("Build it");
    expect(await store.findReceipt("run.create", "create-one", requestHash)).toMatchObject({
      revision: 1,
      result: { runId: "run-one" },
    });

    const reopened = await openStore(root);
    expect((await reopened.state()).revision).toBe(1);
    expect(await reopened.findReceipt("run.create", "create-one", requestHash)).toBeDefined();
  });

  it("anchors the exact run-id set and raw bytes across multi-run and state-only commits", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const first = runRecord(root, "run-one");
    const second = runRecord(root, "run-two");
    await store.commit({
      expectedRevision: 0,
      runWrites: [
        { record: first, expectedRevision: null },
        { record: second, expectedRevision: null },
      ],
    });
    const created = await store.state();
    expect(Object.keys(created.runRecordSha256 ?? {})).toEqual(["run-one", "run-two"]);
    for (const run of [first, second]) {
      const bytes = await readFile(path.join(root, "state", "runs", run.id, "run.json"));
      expect(created.runRecordSha256?.[run.id]).toBe(rawSha256(bytes));
    }

    const anchors = structuredClone(created.runRecordSha256);
    await store.commit({ expectedRevision: 1 });
    expect((await store.state()).runRecordSha256).toEqual(anchors);

    const updatedFirst = structuredClone(first);
    updatedFirst.revision = 1;
    updatedFirst.objective = "Updated first";
    const updatedSecond = structuredClone(second);
    updatedSecond.revision = 1;
    updatedSecond.objective = "Updated second";
    await store.commit({
      expectedRevision: 2,
      runWrites: [
        { record: updatedSecond, expectedRevision: 0 },
        { record: updatedFirst, expectedRevision: 0 },
      ],
    });
    const updated = await store.state();
    for (const run of [updatedFirst, updatedSecond]) {
      const bytes = await readFile(path.join(root, "state", "runs", run.id, "run.json"));
      expect(updated.runRecordSha256?.[run.id]).toBe(rawSha256(bytes));
    }
  });

  it("keeps reads and transactions on the canonical state root after a symlink is retargeted", async () => {
    const root = await temporaryRoot();
    const firstState = path.join(root, "state-first");
    const secondState = path.join(root, "state-second");
    const stateLink = path.join(root, "state-link");
    await mkdir(firstState);
    await mkdir(secondState);
    await symlink(firstState, stateLink);
    const store = await ProjectAuthorityStore.open({
      stateRoot: stateLink,
      projectRoot: root,
      commonDirectory: path.join(root, ".git"),
    });
    const run = runRecord(root);
    await store.commit({
      expectedRevision: 0,
      runWrites: [{ record: run, expectedRevision: null }],
    });

    await unlink(stateLink);
    await symlink(secondState, stateLink);
    await expect(store.getRun(run.id)).resolves.toMatchObject({ id: run.id });
    await expect(store.commit({ expectedRevision: 1 })).resolves.toMatchObject({
      state: { revision: 2 },
    });
    await expect(
      readFile(path.join(firstState, "authority", "state.json"), "utf8"),
    ).resolves.toContain('"revision":2');
    await expect(
      readFile(path.join(secondState, "authority", "state.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlink, directory, FIFO, and oversized artifact reads without blocking", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const stateRoot = path.join(root, "state");
    await writeFile(path.join(stateRoot, "target.bin"), "target");
    await symlink(path.join(stateRoot, "target.bin"), path.join(stateRoot, "link.bin"));
    await mkdir(path.join(stateRoot, "directory.bin"));
    await writeFile(path.join(stateRoot, "oversized.bin"), "12345");
    await expect(store.readArtifact("link.bin")).rejects.toMatchObject({ code: "file_type" });
    await expect(store.readArtifact("directory.bin")).rejects.toMatchObject({ code: "file_type" });
    await expect(store.readArtifact("oversized.bin", 4)).rejects.toMatchObject({
      code: "file_size",
    });

    if (process.platform !== "win32") {
      const fifo = path.join(stateRoot, "pipe.bin");
      await execFileAsync("mkfifo", [fifo]);
      await expect(
        Promise.race([
          store.readArtifact("pipe.bin"),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("FIFO read blocked")), 2_000),
          ),
        ]),
      ).rejects.toMatchObject({ code: "file_type" });
    }
  });

  it("rejects an oversized ProjectMutation aggregate before journal staging", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const synthetic = { byteLength: MAX_TRANSACTION_BYTES + 1 } as unknown as Uint8Array;
    await expect(
      store.commit({
        expectedRevision: 0,
        writes: [{ path: "evidence/oversized.bin", bytes: synthetic }],
      }),
    ).rejects.toMatchObject({ code: "transaction_size" });
  });

  it("rejects an oversized raw effect array before mapping any entry", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const before = await store.state();
    let touched = false;
    const writes = new Proxy([] as Array<{ path: string; bytes: Buffer }>, {
      get(target, property, receiver) {
        if (property === "length") return MAX_TRANSACTION_EFFECTS;
        touched = true;
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(store.commit({ expectedRevision: before.revision, writes })).rejects.toMatchObject(
      { code: "transaction_effects" },
    );
    expect(touched).toBe(false);
    expect((await store.state()).revision).toBe(before.revision);
    expect(await readdir(path.join(root, "state", ".transactions"))).toEqual([]);
  });

  it("rejects semantically valid raw run drift on read and guarded reopen", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const run = runRecord(root);
    await store.commit({
      expectedRevision: 0,
      runWrites: [{ record: run, expectedRevision: null }],
    });
    const attacked = structuredClone(run);
    attacked.objective = "Coordinated attacker rewrite";
    await writeFile(
      path.join(root, "state", "runs", run.id, "run.json"),
      `${JSON.stringify(attacked)}\n`,
    );
    await expect(store.getRun(run.id)).rejects.toMatchObject({ code: "run_anchor_mismatch" });
    await expect(openStore(root)).rejects.toMatchObject({ code: "run_anchor_mismatch" });
  });

  it("guardedly bootstraps a pre-anchor project exactly once", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const run = runRecord(root);
    await store.commit({
      expectedRevision: 0,
      runWrites: [{ record: run, expectedRevision: null }],
    });
    const stateFile = path.join(root, "state", "authority", "state.json");
    const legacy = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, unknown>;
    delete legacy.runRecordSha256;
    await writeFile(stateFile, `${JSON.stringify(legacy)}\n`);

    const reopened = await openStore(root);
    const migrated = await reopened.state();
    const runBytes = await readFile(path.join(root, "state", "runs", run.id, "run.json"));
    expect(migrated.revision).toBe(2);
    expect(migrated.runRecordSha256).toEqual({ [run.id]: rawSha256(runBytes) });
    const reopenedAgain = await openStore(root);
    expect((await reopenedAgain.state()).revision).toBe(migrated.revision);
  });

  it("reserves normalized run and archive authority paths from generic effects", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const run = runRecord(root);
    await store.commit({
      expectedRevision: 0,
      runWrites: [{ record: run, expectedRevision: null }],
    });
    for (const alias of [
      "runs/alias/../run-one/run.json",
      "runs//run-one/run.json",
      "./runs/run-one/run.json",
      "RUNS/RUN-ONE/RUN.JSON",
    ]) {
      await expect(
        store.commit({
          expectedRevision: 1,
          writes: [{ path: alias, bytes: Buffer.from("{}\n"), expectedSha256: null }],
        }),
      ).rejects.toMatchObject({ code: "run_record_transaction" });
      await expect(
        store.commit({
          expectedRevision: 1,
          deletes: [{ path: alias }],
        }),
      ).rejects.toMatchObject({ code: "run_record_transaction" });
    }
    for (const effect of ["write", "delete"] as const) {
      const mutation =
        effect === "write"
          ? { writes: [{ path: "runſ/run-one/run.json", bytes: Buffer.from("{}\n") }] }
          : { deletes: [{ path: "runſ/run-one/run.json" }] };
      await expect(store.commit({ expectedRevision: 1, ...mutation })).rejects.toMatchObject({
        code: "transaction_path",
      });
    }
    await expect(
      store.commit({
        expectedRevision: 1,
        writes: [
          {
            path: "RUNS/RUN-ONE/ACTIONS/ARCHIVE/unowned.json",
            bytes: Buffer.from("{}\n"),
            expectedSha256: null,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "action_archive_transaction" });
    await expect(
      store.commit({
        expectedRevision: 1,
        writes: [{ path: "AUTHORITY/STATE.JSON", bytes: Buffer.from("{}\n") }],
      }),
    ).rejects.toMatchObject({ code: "duplicate_write" });
    await expect(
      store.commit({
        expectedRevision: 1,
        deletes: [{ path: "AUTHORITY/STATE.JSON" }],
      }),
    ).rejects.toMatchObject({ code: "duplicate_write" });

    const unrelated = structuredClone(run);
    unrelated.revision = 1;
    unrelated.objective = "Unrelated run update";
    await expect(
      store.commit({
        expectedRevision: 1,
        runWrites: [{ record: unrelated, expectedRevision: 0 }],
        writes: [
          {
            path: "RUNS/RUN-ONE/ACTIONS/ARCHIVE/extra.json",
            bytes: Buffer.from("{}\n"),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "action_archive_transaction" });
    await expect(
      store.commit({
        expectedRevision: 1,
        runWrites: [{ record: unrelated, expectedRevision: 0 }],
        deletes: [{ path: "RUNS/RUN-ONE/ACTIONS/ARCHIVE/extra.json" }],
      }),
    ).rejects.toMatchObject({ code: "action_archive_transaction" });
  });

  it("accepts a valid run id that is also an Object prototype property", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const run = runRecord(root, "constructor");
    await expect(
      store.commit({
        expectedRevision: 0,
        runWrites: [{ record: run, expectedRevision: null }],
      }),
    ).resolves.toBeDefined();
    await expect(store.getRun("constructor")).resolves.toMatchObject({ id: "constructor" });
  });

  it("retains the exact run-byte anchor when a run reaches durable deletion", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const run = runRecord(root);
    await store.commit({
      expectedRevision: 0,
      runWrites: [{ record: run, expectedRevision: null }],
    });
    const deleting = reduceRunLifecycle(run.lifecycle, { type: "delete_requested", atMs: 1 }).state;
    const deletedLifecycle = reduceRunLifecycle(deleting, {
      type: "delete_settled",
      atMs: 2,
    }).state;
    const deleted = structuredClone(run);
    deleted.revision = 1;
    deleted.lifecycle = deletedLifecycle;
    await store.commit({
      expectedRevision: 1,
      runWrites: [{ record: deleted, expectedRevision: 0 }],
    });
    const bytes = await readFile(path.join(root, "state", "runs", run.id, "run.json"));
    expect((await store.state()).runRecordSha256?.[run.id]).toBe(rawSha256(bytes));
    await expect(store.getRun(run.id)).resolves.toMatchObject({ lifecycle: { phase: "deleted" } });
    await expect(store.listRuns()).resolves.toEqual([]);
    await expect(store.listRuns({ includeDeleted: true })).resolves.toHaveLength(1);
  });

  it("rejects stale authority and run revisions", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const run = runRecord(root);
    await store.commit({
      expectedRevision: 0,
      runWrites: [{ record: run, expectedRevision: null }],
    });
    await expect(store.commit({ expectedRevision: 0 })).rejects.toMatchObject({
      code: "revision_conflict",
    } satisfies Partial<ProjectAuthorityStoreError>);
    run.revision = 2;
    await expect(
      store.commit({
        expectedRevision: 1,
        runWrites: [{ record: run, expectedRevision: 0 }],
      }),
    ).rejects.toMatchObject({ code: "run_revision" } satisfies Partial<ProjectAuthorityStoreError>);
  });

  it("serializes multi-file context reads with concurrent artifact transactions", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const read = store.readConsistently(async () => {
      readStarted();
      await readGate;
      return (await store.state()).revision;
    });
    await started;

    let committed = false;
    const commit = store.commit({ expectedRevision: 0 }).then((result) => {
      committed = true;
      return result;
    });
    await Promise.resolve();
    expect(committed).toBe(false);

    releaseRead();
    await expect(read).resolves.toBe(0);
    await expect(commit).resolves.toMatchObject({ state: { revision: 1 } });
  });

  it("enforces consistent projections as read-only without advancing authority", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const prepare = vi.spyOn(FileTransactionStore.prototype, "prepare");

    await expect(
      store.readConsistently(async () => {
        expect((await store.state()).revision).toBe(0);
        return store.commit({ expectedRevision: 0 });
      }),
    ).rejects.toMatchObject({
      code: "read_only_projection",
    } satisfies Partial<ProjectAuthorityStoreError>);

    await expect(
      store.readConsistently(() =>
        store.readConsistently(() => store.commit({ expectedRevision: 0 })),
      ),
    ).rejects.toMatchObject({
      code: "read_only_projection",
    } satisfies Partial<ProjectAuthorityStoreError>);

    const startup = createAuthorityStartupEpoch({
      epochId: "read-only-startup",
      status: "recovering",
      startedAt: "2026-07-18T02:00:00.000Z",
      startingRevision: 0,
    });
    await expect(
      store.readConsistently(() => store.replaceAuthorityStartup(null, startup)),
    ).rejects.toMatchObject({ code: "read_only_projection" });
    await expect(
      store.readConsistently(() =>
        store.readConsistently(() => store.replaceAuthorityStartup(null, startup)),
      ),
    ).rejects.toMatchObject({ code: "read_only_projection" });

    expect(prepare).not.toHaveBeenCalled();
    await expect(store.state()).resolves.toMatchObject({ revision: 0 });
  });

  it("queues a detached startup-epoch replacement after its consistent-read lease closes", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const startup = createAuthorityStartupEpoch({
      epochId: "detached-startup",
      status: "recovering",
      startedAt: "2026-07-18T02:01:00.000Z",
      startingRevision: 0,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let detached!: Promise<unknown>;
    await store.readConsistently(async () => {
      detached = (async () => {
        await gate;
        return store.replaceAuthorityStartup(null, startup);
      })();
    });
    release();
    await expect(detached).resolves.toMatchObject({
      revision: 0,
      authorityStartup: { epochId: startup.epochId, status: "recovering" },
    });
  });

  it("retains the lane for entered descendants while late detached work queues normally", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const run = runRecord(root);
    await store.commit({
      expectedRevision: 0,
      runWrites: [{ record: run, expectedRevision: null }],
    });

    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let childEntered!: () => void;
    const enteredChild = new Promise<void>((resolve) => {
      childEntered = resolve;
    });
    let releaseLate!: () => void;
    const lateGate = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    let parentReturned!: () => void;
    const returnedParent = new Promise<void>((resolve) => {
      parentReturned = resolve;
    });
    const order: string[] = [];
    let childRead!: Promise<RunRecord>;
    let lateRead!: Promise<RunRecord>;

    const parent = store.readConsistently(async () => {
      childRead = store.readConsistently(async () => {
        order.push("child-entered");
        childEntered();
        await childGate;
        const observed = await store.getRun("run-one");
        order.push("child-completed");
        return observed;
      });
      lateRead = (async () => {
        await lateGate;
        const observed = await store.getRun("run-one");
        order.push("late-completed");
        return observed;
      })();
      await enteredChild;
      order.push("parent-callback-returned");
      parentReturned();
    });
    await returnedParent;

    let nextEntered = false;
    const next = store.readConsistently(async () => {
      nextEntered = true;
      order.push("next-entered");
      return (await store.state()).revision;
    });
    let lateSettled = false;
    const observedLate = lateRead.then((value) => {
      lateSettled = true;
      return value;
    });
    // This continuation inherited the outer token, but its first store access occurs only after
    // the outer callback returned. It must queue behind the still-entered child rather than join
    // the lease during the close/drain boundary.
    releaseLate();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(nextEntered).toBe(false);
    expect(lateSettled).toBe(false);

    releaseChild();
    await expect(childRead).resolves.toMatchObject({ objective: "Build it" });
    await expect(parent).resolves.toBeUndefined();
    await expect(next).resolves.toBe(1);
    await expect(observedLate).resolves.toMatchObject({ objective: "Build it" });
    expect(order).toEqual([
      "child-entered",
      "parent-callback-returned",
      "child-completed",
      "next-entered",
      "late-completed",
    ]);
  });

  it("publishes transaction artifacts before referencing run records and authority state", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const run = runRecord(root);
    await store.commit({
      expectedRevision: 0,
      runWrites: [{ record: run, expectedRevision: null }],
    });

    const originalPrepare = FileTransactionStore.prototype.prepare;
    let destinations: string[] = [];
    vi.spyOn(FileTransactionStore.prototype, "prepare").mockImplementation(async function (
      this: FileTransactionStore,
      id,
      writes,
      deletes,
    ) {
      destinations = writes.map((write) => write.path);
      return originalPrepare.call(this, id, writes, deletes);
    });

    const completed = structuredClone(run);
    completed.revision = 1;
    completed.updatedAt = "2026-07-16T00:00:01.000Z";
    completed.objective = "Completed with exact evidence";
    const evidencePath = "runs/run-one/evidence/exact-terminal-proof.json";
    await store.commit({
      expectedRevision: 1,
      runWrites: [{ record: completed, expectedRevision: 0 }],
      writes: [
        {
          path: evidencePath,
          bytes: Buffer.from('{"proof":true}\n', "utf8"),
          expectedSha256: null,
        },
      ],
    });

    expect(destinations).toEqual([evidencePath, "runs/run-one/run.json", "authority/state.json"]);
  });

  it("keeps ordinary authoritative reads outside an in-flight multi-file commit", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const run = runRecord(root);
    await store.commit({
      expectedRevision: 0,
      runWrites: [{ record: run, expectedRevision: null }],
    });

    const originalCommit = FileTransactionStore.prototype.commit;
    let enterCommit!: () => void;
    const enteredCommit = new Promise<void>((resolve) => {
      enterCommit = resolve;
    });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    vi.spyOn(FileTransactionStore.prototype, "commit").mockImplementation(async function (
      this: FileTransactionStore,
      id,
    ) {
      enterCommit();
      await commitGate;
      return originalCommit.call(this, id);
    });

    const completed = structuredClone(run);
    completed.revision = 1;
    completed.updatedAt = "2026-07-16T00:00:01.000Z";
    completed.objective = "Published after the complete transaction";
    const committing = store.commit({
      expectedRevision: 1,
      runWrites: [{ record: completed, expectedRevision: 0 }],
      writes: [
        {
          path: "runs/run-one/evidence/settled.json",
          bytes: Buffer.from('{"settled":true}\n', "utf8"),
          expectedSha256: null,
        },
      ],
    });
    await enteredCommit;

    let readSettled = false;
    const reading = store.getRun("run-one").then((value) => {
      readSettled = true;
      return value;
    });
    await Promise.resolve();
    expect(readSettled).toBe(false);

    releaseCommit();
    await committing;
    await expect(reading).resolves.toMatchObject({
      objective: "Published after the complete transaction",
    });
  });

  it("does not let a detached consistent-read continuation inherit the transaction lane", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const run = runRecord(root);
    await store.commit({
      expectedRevision: 0,
      runWrites: [{ record: run, expectedRevision: null }],
    });

    let releaseDetached!: () => void;
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detachedRead!: Promise<RunRecord>;
    await store.readConsistently(async () => {
      detachedRead = (async () => {
        await detachedGate;
        return store.getRun("run-one");
      })();
    });

    const originalCommit = FileTransactionStore.prototype.commit;
    let enterCommit!: () => void;
    const enteredCommit = new Promise<void>((resolve) => {
      enterCommit = resolve;
    });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    vi.spyOn(FileTransactionStore.prototype, "commit").mockImplementation(async function (
      this: FileTransactionStore,
      id,
    ) {
      enterCommit();
      await commitGate;
      return originalCommit.call(this, id);
    });

    const completed = structuredClone(run);
    completed.revision = 1;
    completed.updatedAt = "2026-07-16T00:00:01.000Z";
    completed.objective = "Detached read waited for publication";
    const committing = store.commit({
      expectedRevision: 1,
      runWrites: [{ record: completed, expectedRevision: 0 }],
    });
    await enteredCommit;

    let readSettled = false;
    const observed = detachedRead.then((value) => {
      readSettled = true;
      return value;
    });
    releaseDetached();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readSettled).toBe(false);

    releaseCommit();
    await committing;
    await expect(observed).resolves.toMatchObject({
      objective: "Detached read waited for publication",
    });
  });

  it("rejects reuse of an idempotency key for different request bytes", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const first = authorityRequestHash("run.pause", { runId: "run-one" });
    await store.commit({
      expectedRevision: 0,
      receipt: { method: "run.pause", idempotencyKey: "pause", requestHash: first },
    });
    const changed = authorityRequestHash("run.pause", { runId: "run-two" });
    await expect(store.findReceipt("run.pause", "pause", changed)).rejects.toMatchObject({
      code: "idempotency_reuse",
    } satisfies Partial<ProjectAuthorityStoreError>);
  });

  it("authorizes configured run lifecycle changes inside the durable CAS boundary", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const run = runRecord(root);
    run.lifecycleCatalog = lifecycleCatalog(run.compiledConfigHash);
    await store.commit({
      expectedRevision: 0,
      runWrites: [{ record: run, expectedRevision: null }],
    });

    const unauthorized = structuredClone(run);
    unauthorized.revision = 1;
    unauthorized.lifecycle.phase = "completed";
    await expect(
      store.commit({
        expectedRevision: 1,
        runWrites: [{ record: unauthorized, expectedRevision: 0 }],
      }),
    ).rejects.toThrow(/transition_not_configured/u);

    const paused = structuredClone(run);
    paused.revision = 1;
    paused.lifecycle.phase = "pausing";
    paused.lifecycle.resumePhase = "draft";
    await expect(
      store.commit({
        expectedRevision: 1,
        runWrites: [{ record: paused, expectedRevision: 0 }],
      }),
    ).resolves.toMatchObject({ state: { revision: 2 } });

    const stripped = structuredClone(paused);
    stripped.revision = 2;
    delete stripped.lifecycleCatalog;
    await expect(
      store.commit({
        expectedRevision: 2,
        runWrites: [{ record: stripped, expectedRevision: 1 }],
      }),
    ).rejects.toMatchObject({ code: "lifecycle_catalog_removed" });
  });

  it("authorizes every configured ticket transition in the same durable CAS", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const run = runRecord(root);
    run.lifecycleCatalog = lifecycleCatalog(run.compiledConfigHash);
    run.tickets.proposal = ticketRecord("proposal", "proposed");
    await store.commit({
      expectedRevision: 0,
      runWrites: [{ record: run, expectedRevision: null }],
    });

    const unownedApproval = structuredClone(run);
    unownedApproval.revision = 1;
    unownedApproval.tickets.proposal!.status = "ready";
    await expect(
      store.commit({
        expectedRevision: 1,
        runWrites: [{ record: unownedApproval, expectedRevision: 0 }],
      }),
    ).rejects.toThrow(/actor_not_allowed/u);

    const approved = structuredClone(unownedApproval);
    await expect(
      store.commit({
        expectedRevision: 1,
        runWrites: [
          {
            record: approved,
            expectedRevision: 0,
            lifecycleActors: { tickets: { proposal: "lead" } },
          },
        ],
      }),
    ).resolves.toMatchObject({ state: { revision: 2 } });

    const removed = structuredClone(approved);
    removed.revision = 2;
    delete removed.tickets.proposal;
    await expect(
      store.commit({
        expectedRevision: 2,
        runWrites: [{ record: removed, expectedRevision: 1 }],
      }),
    ).rejects.toMatchObject({ code: "lifecycle_ticket_removed" });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-project-store-"));
  roots.push(root);
  return root;
}

function openStore(root: string): Promise<ProjectAuthorityStore> {
  return ProjectAuthorityStore.open({
    stateRoot: path.join(root, "state"),
    projectRoot: root,
    commonDirectory: path.join(root, ".git"),
  });
}

function runRecord(root: string, runId = "run-one"): RunRecord {
  const now = "2026-07-16T00:00:00.000Z";
  const git = fixtureRunGit(root, runId);
  const namespaceRoot = path.join(root, ".git", "koni", "worktrees", "runs", runId);
  git.namespace.planningWorktree = path.join(namespaceRoot, "planning");
  git.namespace.runWorktree = path.join(namespaceRoot, "integration");
  git.namespace.ticketRoot = path.join(namespaceRoot, "tickets");
  git.planning.worktree = git.namespace.planningWorktree;
  git.run.worktree = git.namespace.runWorktree;
  return {
    protocol: "koni.run-record.v1",
    id: runId,
    revision: 0,
    generation: 0,
    projectRoot: root,
    profile: {
      packageName: "@koni/coding-profile",
      packageVersion: "0.6.0",
      lineage: "koni.software",
      bundleHash: rawSha256("profile"),
    },
    compiledConfigHash: rawSha256("config"),
    runTypeId: "medium",
    objective: "Build it",
    intake: { goal: "Build it" },
    createdAt: now,
    updatedAt: now,
    lifecycle: newRunLifecycle(runId),
    pipelineStageIds: [],
    currentPipelineStageId: undefined,
    plan: undefined,
    graphRevision: 0,
    graphHash: undefined,
    tickets: {},
    attempts: {},
    questions: {},
    activity: [],
    git,
  };
}

function lifecycleCatalog(configurationSha256: `sha256:${string}`): CompiledStateMachineCatalog {
  const ticket = machine(
    "ticket",
    "todo",
    ["proposed", "todo", "in_progress", "closed"],
    ["closed"],
    [
      transition("propose", ["todo"], "proposed", ["compiler"]),
      transition("approve", ["proposed"], "todo", ["lead"]),
      transition("start", ["todo"], "in_progress", ["compiler"]),
      transition("finish", ["in_progress"], "closed", ["compiler"]),
    ],
  );
  const run = machine(
    "run",
    "active",
    ["active", "paused", "concluded"],
    ["concluded"],
    [
      transition("pause", ["active"], "paused", ["human"]),
      transition("resume", ["paused"], "active", ["human"]),
    ],
  );
  const material = {
    protocol: STATE_MACHINE_CATALOG_PROTOCOL,
    configuration_sha256: configurationSha256,
    machines: { ticket, run },
  };
  return { ...material, catalog_sha256: canonicalHash(material) };
}

function ticketRecord(id: string, status: TicketStatus): TicketRecord {
  const now = "2026-07-16T00:00:00.000Z";
  return {
    id,
    operationId: "proposal-operation",
    title: "Review proposed change",
    summary: "Review one typed upstream change request.",
    status,
    priority: 0,
    dependencyIds: [],
    targetNodeIds: [],
    readPaths: [],
    writePaths: [],
    steps: [],
    worktreePath: undefined,
    branch: undefined,
    blocker: undefined,
    createdAt: now,
    updatedAt: now,
  };
}

function transition(
  id: string,
  from: readonly string[],
  to: string,
  actors: readonly string[],
): CompiledStateTransition {
  const material = { id, from: [...from], to, actors: [...actors] };
  return { ...material, transition_sha256: canonicalHash(material) };
}

function machine(
  id: string,
  initial: string,
  states: readonly string[],
  terminalStates: readonly string[],
  transitions: readonly CompiledStateTransition[],
): CompiledStateMachine {
  const material = {
    id,
    initial,
    states: [...states],
    terminal_states: [...terminalStates],
    transitions: [...transitions],
  };
  return { ...material, machine_sha256: canonicalHash(material) };
}
