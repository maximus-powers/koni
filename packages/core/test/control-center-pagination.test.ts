import { describe, expect, it } from "vitest";
import { AuthorityClientError } from "../src/authority/client.js";
import type { JsonValue, RpcSuccess } from "../src/authority/protocol.js";
import { RunSummaryPageCollector } from "../src/authority/run-summary-page.js";
import { ControlCenterComponent } from "../src/control-center/component.js";
import {
  ControlCenterController,
  type ControlCenterAuthorityClient,
} from "../src/control-center/controller.js";
import { plainKoniPalette } from "../src/control-center/markdown.js";
import { rawSha256 } from "../src/shared/canonical.js";
import { newRunLifecycle } from "../src/state/run-lifecycle.js";
import type { RunRecord } from "../src/state/run-record.js";
import { fixtureRunGit } from "./run-record-fixtures.js";

describe("bounded control-center run pagination", () => {
  it("navigates forward and backward across more than two pages while retaining one compact window", async () => {
    const client = new PagedAuthority(makeRuns(405));
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();

    expect(controller.snapshot.view.runPage).toEqual({
      startIndex: 0,
      visibleRuns: 200,
      totalRuns: 405,
      hasPrevious: false,
      hasNext: true,
    });
    expect(controller.snapshot.view.runs).toHaveLength(200);
    const globalFirst = controller.snapshot.selection.runId;
    await controller.handle({ type: "move", delta: -1 });
    expect(controller.snapshot.selection.runId).toBe(globalFirst);
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 40,
    });
    expect(component.render(122).join("\n")).toContain("Runs 1–200 of 405");

    await controller.handle({
      type: "select_run",
      runId: controller.snapshot.view.runs.at(-1)!.id,
    });
    await controller.handle({ type: "move", delta: 1 });
    expect(controller.snapshot.view.runPage).toMatchObject({ startIndex: 200, visibleRuns: 200 });
    expect(controller.snapshot.selection.runId).toBe(controller.snapshot.view.runs[0]!.id);
    expect(component.render(122).join("\n")).toContain("Runs 201–400 of 405");

    await controller.handle({
      type: "select_run",
      runId: controller.snapshot.view.runs.at(-1)!.id,
    });
    await controller.handle({ type: "move", delta: 1 });
    expect(controller.snapshot.view.runPage).toMatchObject({
      startIndex: 400,
      visibleRuns: 5,
      totalRuns: 405,
      hasPrevious: true,
      hasNext: false,
    });
    expect(controller.snapshot.view.runs).toHaveLength(5);
    expect(component.render(122).join("\n")).toContain("Runs 401–405 of 405");

    await controller.handle({
      type: "select_run",
      runId: controller.snapshot.view.runs.at(-1)!.id,
    });
    const globalLast = controller.snapshot.selection.runId;
    await controller.handle({ type: "move", delta: 1 });
    expect(controller.snapshot.selection.runId).toBe(globalLast);
    expect(controller.snapshot.view.runPage).toMatchObject({ startIndex: 400, visibleRuns: 5 });

    await controller.handle({ type: "select_run", runId: controller.snapshot.view.runs[0]!.id });
    await controller.handle({ type: "move", delta: -1 });
    expect(controller.snapshot.view.runPage).toMatchObject({ startIndex: 200, visibleRuns: 200 });
    expect(controller.snapshot.selection.runId).toBe(controller.snapshot.view.runs.at(-1)!.id);
    expect(client.maximumReturnedRows).toBe(200);
    expect(client.calls.filter((call) => call.method === "run.get").length).toBeLessThan(12);
    for (const call of client.calls.filter((candidate) => candidate.method === "run.get")) {
      expect(call.params).toMatchObject({
        authorityRevision: client.revision,
        runRevision: expect.any(Number),
      });
    }

    component.dispose();
    controller.dispose();
  });

  it("restarts an adjacent-page move after a stale cursor without losing the selected boundary", async () => {
    const client = new PagedAuthority(makeRuns(205));
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({
      type: "select_run",
      runId: controller.snapshot.view.runs.at(-1)!.id,
    });
    client.staleNextCursorOnce = true;

    await controller.handle({ type: "move", delta: 1 });

    expect(client.staleCursorCount).toBe(1);
    expect(controller.snapshot.view.runPage).toMatchObject({ startIndex: 199, visibleRuns: 6 });
    expect(controller.snapshot.selection.runId).toBe(controller.snapshot.view.runs[1]!.id);
    expect(controller.snapshot.notice).toBeUndefined();
    controller.dispose();
  });

  it("refreshes a later-page selection with one atomic around-run page request", async () => {
    const client = new PagedAuthority(makeRuns(405));
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({
      type: "select_run",
      runId: controller.snapshot.view.runs.at(-1)!.id,
    });
    await controller.handle({ type: "move", delta: 1 });
    const selected = controller.snapshot.view.runs[73]!;
    await controller.handle({ type: "select_run", runId: selected.id });
    const pageCallsBefore = client.calls.filter((call) => call.method === "run.page").length;

    await controller.refresh();

    const refreshPages = client.calls
      .filter((call) => call.method === "run.page")
      .slice(pageCallsBefore);
    expect(refreshPages).toEqual([
      {
        method: "run.page",
        params: { limit: 200, includeDeleted: false, aroundRunId: selected.id },
      },
    ]);
    expect(controller.snapshot.view.runPage).toMatchObject({ startIndex: 273, visibleRuns: 132 });
    expect(controller.snapshot.selection.runId).toBe(selected.id);
    expect(controller.snapshot.view.selectedRun?.id).toBe(selected.id);
    controller.dispose();
  });

  it("refreshes an exact selected row after its durable revision changes", async () => {
    const client = new PagedAuthority(makeRuns(4));
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    const selected = controller.snapshot.view.runs[2]!;
    await controller.handle({ type: "select_run", runId: selected.id });
    client.bumpRunRevision(selected.id);

    await controller.refresh();

    expect(controller.snapshot.selection.runId).toBe(selected.id);
    expect(controller.snapshot.view.selectedRun?.id).toBe(selected.id);
    expect(client.calls.filter((call) => call.method === "run.get").at(-1)?.params).toEqual({
      runId: selected.id,
      authorityRevision: client.revision,
      runRevision: 3,
    });
    controller.dispose();
  });

  it("recovers once to the first page when the selected durable run disappears", async () => {
    const client = new PagedAuthority(makeRuns(4));
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    const selected = controller.snapshot.view.runs[2]!;
    await controller.handle({ type: "select_run", runId: selected.id });
    client.deleteRun(selected.id);
    const pageCallsBefore = client.calls.filter((call) => call.method === "run.page").length;

    await controller.refresh();

    expect(
      client.calls.filter((call) => call.method === "run.page").slice(pageCallsBefore),
    ).toEqual([
      {
        method: "run.page",
        params: { limit: 200, includeDeleted: false, aroundRunId: selected.id },
      },
      {
        method: "run.page",
        params: { limit: 200, includeDeleted: false },
      },
    ]);
    expect(controller.snapshot.selection.runId).not.toBe(selected.id);
    expect(controller.snapshot.view.selectedRun?.id).toBe(controller.snapshot.selection.runId);
    controller.dispose();
  });

  it("rejects a selected detail whose run revision does not match its compact row", async () => {
    const client = new PagedAuthority(makeRuns(3));
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    const target = controller.snapshot.view.runs[1]!;
    client.mismatchNextHydration = true;

    await controller.handle({ type: "select_run", runId: target.id });

    expect(controller.snapshot.selection.runId).toBe(target.id);
    expect(controller.snapshot.view.selectedRun).toBeUndefined();
    expect(controller.snapshot.notice).toMatchObject({
      kind: "error",
      message: expect.stringContaining("different summary revision"),
    });
    await controller.refresh();
    expect(controller.snapshot.view.selectedRun?.id).toBe(target.id);
    controller.dispose();
  });

  it("falls back once to a bounded old-daemon run.list and hydrates with legacy run.get", async () => {
    const client = new PagedAuthority(makeRuns(3), true);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();

    expect(controller.snapshot.view.runs).toHaveLength(3);
    expect(client.calls.filter((call) => call.method === "run.page")).toHaveLength(1);
    expect(client.calls.filter((call) => call.method === "run.list")).toHaveLength(1);
    expect(client.calls.find((call) => call.method === "run.get")?.params).toEqual({
      runId: controller.snapshot.selection.runId,
    });
    await controller.refresh();
    expect(client.calls.filter((call) => call.method === "run.page")).toHaveLength(1);
    expect(client.calls.filter((call) => call.method === "run.list")).toHaveLength(2);
    controller.dispose();
  });

  it("refuses an oversized legacy full-record list instead of silently truncating it", async () => {
    const client = new PagedAuthority(makeRuns(201), true);
    const controller = new ControlCenterController({ projectRoot: "/project", client });

    await controller.initialize();

    expect(controller.snapshot.view.runs).toEqual([]);
    expect(controller.snapshot.notice).toMatchObject({
      kind: "error",
      message: expect.stringContaining("more than 200 full runs"),
    });
    expect(client.calls.some((call) => call.method === "run.get")).toBe(false);
    controller.dispose();
  });
});

interface RecordedCall {
  method: string;
  params?: JsonValue;
}

class PagedAuthority implements ControlCenterAuthorityClient {
  public revision = 17;
  public staleNextCursorOnce = false;
  public mismatchNextHydration = false;
  public staleCursorCount = 0;
  public maximumReturnedRows = 0;
  public readonly calls: RecordedCall[] = [];
  readonly #runs: RunRecord[];
  readonly #legacy: boolean;

  public constructor(runs: RunRecord[], legacy = false) {
    this.#runs = runs;
    this.#legacy = legacy;
  }

  public bumpRunRevision(runId: string): void {
    const run = this.#runs.find((candidate) => candidate.id === runId);
    if (run === undefined) throw new Error("fixture run is missing");
    run.revision += 1;
    run.updatedAt = new Date(Date.parse(run.updatedAt) + 1).toISOString();
    this.revision += 1;
  }

  public deleteRun(runId: string): void {
    const run = this.#runs.find((candidate) => candidate.id === runId);
    if (run === undefined) throw new Error("fixture run is missing");
    run.revision += 1;
    run.lifecycle.phase = "deleted";
    run.lifecycle.runningIntent = false;
    run.updatedAt = new Date(Date.parse(run.updatedAt) + 1).toISOString();
    this.revision += 1;
  }

  public async request(method: string, params?: JsonValue): Promise<RpcSuccess> {
    this.calls.push({ method, ...(params === undefined ? {} : { params }) });
    if (method === "run.page") {
      if (this.#legacy)
        throw new AuthorityClientError("method_not_found", "run.page is unavailable");
      const request = record(params);
      if (this.staleNextCursorOnce && typeof request.cursor === "string") {
        this.staleNextCursorOnce = false;
        this.staleCursorCount += 1;
        this.revision += 1;
        throw new AuthorityClientError(
          "run_page_stale",
          "run page cursor belongs to an older revision",
          {
            revision: this.revision,
          },
        );
      }
      const aroundRunId = typeof request.aroundRunId === "string" ? request.aroundRunId : undefined;
      const aroundRun =
        aroundRunId === undefined
          ? undefined
          : this.#runs.find(
              (candidate) =>
                candidate.id === aroundRunId && candidate.lifecycle.phase !== "deleted",
            );
      if (aroundRunId !== undefined && aroundRun === undefined) {
        throw new AuthorityClientError(
          "run_page_target",
          "selected run is not in this authority snapshot",
        );
      }
      const collector = new RunSummaryPageCollector({
        revision: this.revision,
        limit: typeof request.limit === "number" ? request.limit : 50,
        includeDeleted: request.includeDeleted === true,
        ...(typeof request.cursor === "string" ? { cursor: request.cursor } : {}),
        ...(aroundRun === undefined
          ? {}
          : {
              around: {
                id: aroundRun.id,
                createdAt: aroundRun.createdAt,
                runRevision: aroundRun.revision,
              },
            }),
      });
      for (const run of this.#runs) collector.accept(run);
      const page = collector.finish();
      this.maximumReturnedRows = Math.max(this.maximumReturnedRows, page.runs.length);
      return response(method, this.revision, page as unknown as JsonValue);
    }
    if (method === "run.list") {
      if (!this.#legacy) throw new Error("new authority must not receive run.list");
      return response(method, this.revision, structuredClone(this.#runs) as unknown as JsonValue);
    }
    if (method === "run.get") {
      const request = record(params);
      const run = this.#runs.find((candidate) => candidate.id === request.runId);
      if (run === undefined) throw new Error("selected fixture run is missing");
      if (
        !this.#legacy &&
        (request.authorityRevision !== this.revision || request.runRevision !== run.revision)
      ) {
        throw new AuthorityClientError("run_page_stale", "selected row is stale", {
          revision: this.revision,
        });
      }
      const selected = structuredClone(run);
      if (this.mismatchNextHydration) {
        this.mismatchNextHydration = false;
        selected.revision += 1;
      }
      return response(method, this.revision, selected as unknown as JsonValue);
    }
    if (method === "run.graph" || method === "run.controls" || method === "run.lineage") {
      throw new AuthorityClientError(
        "method_not_found",
        `${method} is unavailable in this fixture`,
      );
    }
    throw new Error(`unexpected RPC ${method}`);
  }
}

function makeRuns(count: number): RunRecord[] {
  return Array.from({ length: count }, (_, index) => fixtureRun(index));
}

function fixtureRun(index: number): RunRecord {
  const id = `run-${String(index).padStart(3, "0")}`;
  const at = new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString();
  return {
    protocol: "koni.run-record.v1",
    id,
    revision: 2,
    generation: 0,
    projectRoot: "/project",
    profile: {
      packageName: "@koni/coding-profile",
      packageVersion: "1.0.0",
      lineage: "koni.software",
      bundleHash: rawSha256("profile"),
    },
    compiledConfigHash: rawSha256("config"),
    runTypeId: index % 2 === 0 ? "medium" : "large",
    objective: `Build bounded feature ${index}`,
    intake: { goal: `Build bounded feature ${index}` },
    createdAt: at,
    updatedAt: at,
    lifecycle: newRunLifecycle(id),
    pipelineStageIds: [],
    currentPipelineStageId: undefined,
    plan: undefined,
    graphRevision: 0,
    graphHash: undefined,
    tickets: {},
    attempts: {},
    questions: {},
    activity: [],
    git: fixtureRunGit("/project", id),
  };
}

function record(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function response(method: string, revision: number, result: JsonValue): RpcSuccess {
  return { type: "response", id: method, ok: true, revision, result };
}
