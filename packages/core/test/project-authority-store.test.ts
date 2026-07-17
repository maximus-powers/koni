import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rawSha256 } from "../src/shared/canonical.js";
import { newRunLifecycle } from "../src/state/run-lifecycle.js";
import type { RunRecord } from "../src/state/run-record.js";
import {
  authorityRequestHash,
  ProjectAuthorityStore,
  ProjectAuthorityStoreError,
} from "../src/authority/project-store.js";
import { fixtureRunGit } from "./run-record-fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project authority transaction store", () => {
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

  it("rejects stale authority and run revisions", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const run = runRecord(root);
    await store.commit({ expectedRevision: 0, runWrites: [{ record: run, expectedRevision: null }] });
    await expect(store.commit({ expectedRevision: 0 })).rejects.toMatchObject({
      code: "revision_conflict",
    } satisfies Partial<ProjectAuthorityStoreError>);
    run.revision = 2;
    await expect(store.commit({
      expectedRevision: 1,
      runWrites: [{ record: run, expectedRevision: 0 }],
    })).rejects.toMatchObject({ code: "run_revision" } satisfies Partial<ProjectAuthorityStoreError>);
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

function runRecord(root: string): RunRecord {
  const now = "2026-07-16T00:00:00.000Z";
  return {
    protocol: "koni.run-record.v1",
    id: "run-one",
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
    lifecycle: newRunLifecycle("run-one"),
    pipelineStageIds: [],
    currentPipelineStageId: undefined,
    plan: undefined,
    graphRevision: 0,
    graphHash: undefined,
    tickets: {},
    attempts: {},
    questions: {},
    activity: [],
    git: fixtureRunGit(root, "run-one"),
  };
}
