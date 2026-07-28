import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectAuthorityStore } from "../src/authority/project-store.js";
import { compareUtf8, rawSha256 } from "../src/shared/canonical.js";
import { newRunLifecycle, type RunPhase } from "../src/state/run-lifecycle.js";
import type { RunRecord } from "../src/state/run-record.js";
import { fixtureRunGit } from "./run-record-fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounded ProjectStore run enumeration", () => {
  it("traverses more than 200 anchored active/deleted records forward and backward", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const runs = Array.from({ length: 451 }, (_, index) =>
      runRecord(
        root,
        `run-${String(index).padStart(4, "0")}`,
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        index % 7 === 0 ? "deleted" : "paused",
      ),
    );
    let revision = 0;
    for (let index = 0; index < runs.length; index += 50) {
      await store.commit({
        expectedRevision: revision,
        runWrites: runs
          .slice(index, index + 50)
          .map((record) => ({ record, expectedRevision: null })),
      });
      revision += 1;
    }

    const expected = runs
      .filter((run) => run.lifecycle.phase !== "deleted")
      .sort(runOrder)
      .map((run) => run.id);
    const seen: string[] = [];
    let cursor: string | undefined;
    let previousPage: Awaited<ReturnType<ProjectAuthorityStore["runSummaryPage"]>> | undefined;
    do {
      const page = await store.runSummaryPage({
        limit: 73,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.revision).toBe(revision);
      expect(page.startIndex).toBe(seen.length);
      seen.push(...page.runs.map((run) => run.id));
      previousPage = page;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toEqual(expected);

    const selectedId = expected[300]!;
    const around = await store.runSummaryPage({ limit: 73, aroundRunId: selectedId });
    expect(around.startIndex).toBe(300);
    expect(around.runs[0]?.id).toBe(selectedId);
    expect(around.previousCursor).toBeDefined();
    expect(around.nextCursor).toBeDefined();
    await expect(
      store.runSummaryPage({ limit: 73, aroundRunId: "run-absent" }),
    ).rejects.toMatchObject({ code: "run_page_target" });
    const deletedId = runs.find((run) => run.lifecycle.phase === "deleted")!.id;
    await expect(store.runSummaryPage({ limit: 73, aroundRunId: deletedId })).rejects.toMatchObject(
      { code: "run_page_target" },
    );
    const deletedAround = await store.runSummaryPage({
      limit: 73,
      aroundRunId: deletedId,
      includeDeleted: true,
    });
    expect(deletedAround.runs[0]?.id).toBe(deletedId);

    // Walk the same authority snapshot back to its first page without accumulating full records.
    let backwards = previousPage;
    while (backwards.previousCursor !== undefined) {
      const preceding = await store.runSummaryPage({ limit: 73, cursor: backwards.previousCursor });
      expect(preceding.startIndex + preceding.runs.length).toBe(backwards.startIndex);
      backwards = preceding;
    }
    expect(backwards.startIndex).toBe(0);
    expect(backwards.runs.map((run) => run.id)).toEqual(expected.slice(0, 73));
  }, 30_000);

  it("binds cursors and selected hydration to exact authority/run revisions", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    await store.commit({
      expectedRevision: 0,
      runWrites: [
        { record: runRecord(root, "run-new", "2026-07-18T00:00:01.000Z"), expectedRevision: null },
        { record: runRecord(root, "run-old", "2026-07-18T00:00:00.000Z"), expectedRevision: null },
      ],
    });
    const first = await store.runSummaryPage({ limit: 1 });
    await expect(
      store.getRunAtRevision({
        runId: first.runs[0]!.id,
        authorityRevision: first.revision,
        runRevision: first.runs[0]!.runRevision,
      }),
    ).resolves.toMatchObject({ id: "run-new" });

    await store.commit({ expectedRevision: first.revision });
    await expect(
      store.runSummaryPage({ limit: 1, cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ code: "run_page_stale" });
    await expect(
      store.getRunAtRevision({
        runId: first.runs[0]!.id,
        authorityRevision: first.revision,
        runRevision: first.runs[0]!.runRevision,
      }),
    ).rejects.toMatchObject({ code: "run_page_stale" });
  });

  it("keeps an anchored scan exact across unrelated state commits and rejects run-byte movement", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const run = runRecord(root, "run-scan", "2026-07-18T00:00:00.000Z");
    await store.commit({
      expectedRevision: 0,
      runWrites: [{ record: run, expectedRevision: null }],
    });
    const scan = await store.runScanSnapshot();

    await store.commit({ expectedRevision: 1 });
    await expect(scan.getRun(run.id)).resolves.toMatchObject({ id: run.id, objective: "Build it" });

    const changed = structuredClone(run);
    changed.revision = 1;
    changed.updatedAt = "2026-07-18T00:00:01.000Z";
    changed.objective = "Changed after the scan anchor";
    await store.commit({
      expectedRevision: 2,
      runWrites: [{ record: changed, expectedRevision: 0 }],
    });
    await expect(scan.getRun(run.id)).rejects.toMatchObject({ code: "run_anchor_mismatch" });
  });

  it("fails the legacy full-list boundary explicitly instead of truncating it", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const run = runRecord(root, "run-wide", "2026-07-18T00:00:00.000Z");
    run.objective = "x".repeat(13 * 1024 * 1024);
    await store.commit({
      expectedRevision: 0,
      runWrites: [{ record: run, expectedRevision: null }],
    });
    await expect(store.listRunsForLegacyFrame()).rejects.toMatchObject({
      code: "run_list_pagination_required",
    });
    await expect(store.listRuns()).rejects.toMatchObject({ code: "run_list_pagination_required" });
    await expect(store.runSummaryPage({ limit: 1 })).resolves.toMatchObject({
      totalRuns: 1,
      startIndex: 0,
      runs: [{ id: "run-wide" }],
    });
  }, 30_000);
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-bounded-runs-"));
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

function runRecord(
  root: string,
  id: string,
  createdAt: string,
  phase: RunPhase = "planning",
): RunRecord {
  const lifecycle = newRunLifecycle(id);
  lifecycle.phase = phase;
  lifecycle.runningIntent = ["planning", "executing", "verifying"].includes(phase);
  lifecycle.activeSinceMs = lifecycle.runningIntent ? Date.parse(createdAt) : undefined;
  return {
    protocol: "koni.run-record.v1",
    id,
    revision: 0,
    generation: 0,
    projectRoot: root,
    profile: {
      packageName: "@koni/coding-profile",
      packageVersion: "1.0.0",
      lineage: "koni.software",
      bundleHash: rawSha256("profile"),
    },
    compiledConfigHash: rawSha256("config"),
    runTypeId: "medium",
    objective: "Build it",
    intake: { goal: "Build it" },
    createdAt,
    updatedAt: createdAt,
    lifecycle,
    pipelineStageIds: [],
    currentPipelineStageId: undefined,
    plan: undefined,
    graphRevision: 0,
    graphHash: undefined,
    tickets: {},
    attempts: {},
    questions: {},
    activity: [],
    git: fixtureRunGit(root, id),
  };
}

function runOrder(left: RunRecord, right: RunRecord): number {
  return compareUtf8(right.createdAt, left.createdAt) || compareUtf8(left.id, right.id);
}
