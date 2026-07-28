import type { JsonValue, RpcEvent, RpcSuccess } from "../src/authority/protocol.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { MonitorAuthorityConnection } from "../src/monitor/client.js";
import { plainMonitorPalette } from "../src/monitor/presentation.js";
import { GuidedRunModalComponent } from "../src/monitor/run-intake-component.js";
import {
  adjustGuidedRunSelection,
  buildGuidedRunCreateInput,
  createGuidedRunState,
  GuidedRunIntakeSession,
  prepareGuidedRunIntake,
  type GuidedRunState,
} from "../src/monitor/run-intake.js";
import { CONTROL_CATALOG_PROTOCOL } from "../src/control-center/protocol.js";
import { monitorModelsFixture, monitorRunTypesFixture } from "./fixtures/monitor-fixtures.js";

describe("guided /koni-run intake", () => {
  it("explains exact initialization commands and stops without connecting", async () => {
    const connect = vi.fn(async () => new FakeIntakeConnection());
    const result = await prepareGuidedRunIntake({
      trusted: true,
      initialized: false,
      connect,
      models: monitorModelsFixture(),
    });
    expect(result).toEqual({
      kind: "blocked",
      reason: "uninitialized",
      message:
        "Koni is not initialized in this repository. Run `/koni init coding` or `/koni init research`, then retry `/koni-run`.",
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("loads the compiled catalog and recent branches only after explicit preparation", async () => {
    const discoveryConnection = new FakeIntakeConnection();
    const creationConnection = new FakeIntakeConnection();
    const connect = vi
      .fn()
      .mockResolvedValueOnce(discoveryConnection)
      .mockResolvedValueOnce(creationConnection);
    const result = await prepareGuidedRunIntake({
      trusted: true,
      initialized: true,
      connect,
      models: monitorModelsFixture(),
      requestedRunType: "large",
      idempotencyKey: () => "run-key",
    });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.state.runTypes.map((runType) => runType.id)).toEqual([
      "small",
      "medium",
      "large",
    ]);
    expect(result.state.runTypes[result.state.runTypeIndex]?.id).toBe("large");
    expect(result.state.target.branches).toEqual([
      { label: "feature/notes", reference: "refs/heads/feature/notes" },
      { label: "main", reference: "refs/heads/main" },
    ]);
    expect(discoveryConnection.closed).toBe(true);
    expect(discoveryConnection.calls.map((call) => call.method)).toEqual([
      "control.catalog",
      "branches.list",
    ]);
    result.state.objective = "Build the notes app";
    const created = await result.session.create(result.state);
    expect(created).toEqual({ runId: "run-created" });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(creationConnection.calls).toHaveLength(1);
    expect(creationConnection.calls.at(-1)).toMatchObject({
      method: "run.create",
      options: { expectedRevision: 7, idempotencyKey: "run-key" },
      params: {
        objective: "Build the notes app",
        runTypeId: "large",
        targetRef: "refs/heads/feature/notes",
        overrides: { questionPolicy: "many", maxParallel: 5 },
      },
    });
    expect(creationConnection.closed).toBe(true);
    result.session.close();
    await expect(result.session.create(result.state)).rejects.toThrow("run intake is closed");
  });

  it("does not retain an authority socket while the operator is editing the modal", async () => {
    const discoveryConnection = new FakeIntakeConnection();
    const creationConnection = new FakeIntakeConnection();
    const connect = vi
      .fn()
      .mockResolvedValueOnce(discoveryConnection)
      .mockResolvedValueOnce(creationConnection);
    const result = await prepareGuidedRunIntake({
      trusted: true,
      initialized: true,
      connect,
      models: monitorModelsFixture(),
    });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;

    expect(discoveryConnection.closed).toBe(true);
    expect(connect).toHaveBeenCalledOnce();
    result.state.objective = "A deliberately considered objective";
    await result.session.create(result.state);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(creationConnection.calls.map((call) => call.method)).toEqual(["run.create"]);
    expect(creationConnection.closed).toBe(true);
  });

  it("permits a corrected resubmission after a failed creation and surfaces the authority warning", async () => {
    const failing = new FakeIntakeConnection();
    failing.runCreateError = new Error(
      "selected target checkout has uncommitted work (scratch.txt)",
    );
    const succeeding = new FakeIntakeConnection();
    succeeding.runCreateResult = {
      runId: "run-created",
      warning: "target checkout has uncommitted changes (scratch.txt)",
    };
    const connect = vi.fn().mockResolvedValueOnce(failing).mockResolvedValueOnce(succeeding);
    const keys = ["key-1", "key-2"];
    const session = new GuidedRunIntakeSession(connect, () => keys.shift()!);
    const state = fixtureState();
    state.objective = "First attempt";
    await expect(session.create(state)).rejects.toThrow("uncommitted work");
    expect(failing.closed).toBe(true);
    state.objective = "Second attempt";
    const created = await session.create(state);
    expect(created).toEqual({
      runId: "run-created",
      warning: "target checkout has uncommitted changes (scratch.txt)",
    });
    expect(succeeding.closed).toBe(true);
    expect(failing.calls.at(-1)?.options?.idempotencyKey).toBe("key-1");
    expect(succeeding.calls.at(-1)?.options?.idempotencyKey).toBe("key-2");
    await expect(session.create(state)).rejects.toThrow("run intake has already been submitted");
  });

  it("blocks a duplicate submission while a creation is in flight", async () => {
    const connection = new FakeIntakeConnection();
    let open = () => {};
    connection.runCreateGate = new Promise((resolve) => {
      open = resolve;
    });
    const session = new GuidedRunIntakeSession(
      async () => connection,
      () => "key-inflight",
    );
    const state = fixtureState();
    state.objective = "In flight";
    const first = session.create(state);
    await expect(session.create(state)).rejects.toThrow("run intake has already been submitted");
    open();
    await expect(first).resolves.toEqual({ runId: "run-created" });
    await expect(session.create(state)).rejects.toThrow("run intake has already been submitted");
  });

  it("renders every stage and intuitive independent model/reasoning selectors", () => {
    const state = fixtureState();
    const done = vi.fn();
    const component = new GuidedRunModalComponent({
      state,
      create: async () => ({ runId: "run-render" }),
      done,
      palette: plainMonitorPalette,
      viewportRows: () => 56,
    });
    const frame = component.render(92).join("\n");
    expect(frame).toContain("Goal Prompt");
    expect(frame).toContain("Run Config");
    expect(frame).not.toContain("What should Koni build?");
    expect(frame).toContain("Small");
    expect(frame).toContain("Medium");
    expect(frame).toContain("Large");
    for (const stage of state.runTypes[1]!.stages) expect(frame).toContain(stage.title);
    expect(frame).toContain("Plan risk controls  skipped");
    expect(frame).toContain("Questions");
    expect(frame).toContain("[ no ]");
    expect(frame).toContain("[• some ]");
    expect(frame).toContain("[ many ]");
    expect(frame).toContain("Max parallel agents");
    expect(frame).toContain("Agent  Model  Reasoning");
    expect(frame).toContain("Start Planning");
    expect(component.render(36).every((line) => visibleWidth(line) <= 36)).toBe(true);
  });

  it("cycles all available models, model-specific reasoning, questions, and unbounded parallelism", () => {
    let state = fixtureState();
    state.focus = "questions";
    state = adjustGuidedRunSelection(state, 1);
    expect(state.questionPolicy).toBe("many");
    state.focus = "parallel";
    for (let index = 0; index < 20; index += 1) state = adjustGuidedRunSelection(state, 1);
    expect(state.maxParallel).toBe(23);
    for (let index = 0; index < 40; index += 1) state = adjustGuidedRunSelection(state, -1);
    expect(state.maxParallel).toBe(1);

    state.focus = "role:planner:model";
    const models = new Set<string>();
    for (let index = 0; index < 4; index += 1) {
      models.add(state.roles[0]!.model);
      state = adjustGuidedRunSelection(state, 1);
    }
    expect(models).toEqual(new Set(["gpt-sol", "gpt-luna", "gpt-terra"]));
    expect(models.has("custom")).toBe(false);
    state.focus = "role:planner:reasoning";
    const selectedModel = state.models.find((model) => model.id === state.roles[0]!.model)!;
    const reasoning = new Set<string>();
    for (let index = 0; index < selectedModel.thinkingLevels.length; index += 1) {
      reasoning.add(state.roles[0]!.thinkingLevel);
      state = adjustGuidedRunSelection(state, 1);
    }
    expect(reasoning).toEqual(new Set(selectedModel.thinkingLevels));
  });

  it("starts the run through the injected creator and closes only after it succeeds", async () => {
    const done = vi.fn();
    const create = vi.fn(async (_state: GuidedRunState) => ({ runId: "run-1" }));
    const component = new GuidedRunModalComponent({
      state: fixtureState(),
      create,
      done,
      palette: plainMonitorPalette,
      viewportRows: () => 50,
    });
    component.handleInput("Build notes 🧪");
    expect(done).not.toHaveBeenCalled();
    const focusCount = component.state.roles.length * 2 + 5;
    for (let index = 0; index < focusCount; index += 1) component.handleInput("\t");
    expect(component.state.focus).toBe("start");
    component.handleInput("\r");
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledOnce();
    // The creator receives the complete state; the session rebuilds the authority payload from it.
    expect(buildGuidedRunCreateInput(create.mock.calls[0]![0])).toMatchObject({
      objective: "Build notes 🧪",
      runTypeId: "medium",
      targetRef: "refs/heads/feature/notes",
      overrides: {
        questionPolicy: "some",
        maxParallel: 3,
        roles: {
          planner: { provider: "openai-codex", model: "gpt-sol", thinkingLevel: "max" },
          worker: { provider: "openai-codex", model: "gpt-terra", thinkingLevel: "high" },
        },
      },
    });
    expect(done.mock.calls[0]?.[0]).toMatchObject({
      kind: "started",
      runId: "run-1",
      state: expect.objectContaining({ objective: "Build notes 🧪" }),
    });
  });

  it("keeps the modal open with the inline error and preserved config when creation fails, then retries", async () => {
    const done = vi.fn();
    const create = vi
      .fn<(state: GuidedRunState) => Promise<{ runId: string; warning?: string }>>()
      .mockRejectedValueOnce(
        new Error("selected target checkout has uncommitted work (scratch.txt)"),
      )
      .mockResolvedValueOnce({
        runId: "run-2",
        warning: "target checkout has uncommitted changes (scratch.txt)",
      });
    const component = new GuidedRunModalComponent({
      state: fixtureState(),
      create,
      done,
      palette: plainMonitorPalette,
      viewportRows: () => 50,
    });
    component.handleInput("Keep this goal");
    const focusCount = component.state.roles.length * 2 + 5;
    for (let index = 0; index < focusCount; index += 1) component.handleInput("\t");
    component.handleInput("\r");
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(done).not.toHaveBeenCalled();
    expect(component.state).toMatchObject({
      busy: false,
      focus: "start",
      objective: "Keep this goal",
      error: expect.stringContaining("uncommitted work"),
    });
    expect(component.render(92).join("\n")).toContain("uncommitted work");
    component.handleInput("\r");
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(done.mock.calls[0]?.[0]).toMatchObject({
      kind: "started",
      runId: "run-2",
      warning: "target checkout has uncommitted changes (scratch.txt)",
      state: expect.objectContaining({ objective: "Keep this goal" }),
    });
  });

  it("blocks every key while creation is in flight and renders the busy Start control", async () => {
    const done = vi.fn();
    let release: (created: { runId: string }) => void = () => {};
    const create = vi.fn(
      () =>
        new Promise<{ runId: string }>((resolve) => {
          release = resolve;
        }),
    );
    const component = new GuidedRunModalComponent({
      state: fixtureState(),
      create,
      done,
      palette: plainMonitorPalette,
      viewportRows: () => 50,
    });
    component.handleInput("Busy objective");
    const focusCount = component.state.roles.length * 2 + 5;
    for (let index = 0; index < focusCount; index += 1) component.handleInput("\t");
    component.handleInput("\r");
    expect(component.state.busy).toBe(true);
    expect(component.render(92).join("\n")).toContain("Starting…");
    component.handleInput("\t");
    component.handleInput("\u001b");
    expect(component.state.focus).toBe("start");
    expect(done).not.toHaveBeenCalled();
    release({ runId: "run-3" });
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(done.mock.calls[0]?.[0]).toMatchObject({ kind: "started", runId: "run-3" });
  });

  it("keeps every focused control visible at Pi's 42-row viewport and provides the full Unicode caret editor", async () => {
    const done = vi.fn();
    const component = new GuidedRunModalComponent({
      state: fixtureState(),
      create: async () => ({ runId: "run-visible" }),
      done,
      palette: plainMonitorPalette,
      viewportRows: () => 42,
    });

    component.handleInput("A🙂B");
    component.handleInput("\u001b[D");
    component.handleInput("\u001b[D");
    component.handleInput("Ω");
    component.handleInput("\u001b[3~");
    component.handleInput("\r");
    expect(component.state).toMatchObject({
      objective: "AΩ\nB",
      objectiveCursor: 3,
      focus: "objective",
    });
    expect(component.render(92).join("\n")).toContain("▌");

    const transitions = component.state.roles.length * 2 + 5;
    for (let index = 0; index < transitions; index += 1) {
      component.handleInput("\t");
      const frame = component.render(92).join("\n");
      expect(
        frame,
        `focused control ${component.state.focus} must be inside the 42-row viewport`,
      ).toContain("‹");
    }
    expect(component.state.focus).toBe("start");
    const startFrame = component.render(92).join("\n");
    expect(startFrame).toContain("‹ Start Planning ›");
    expect(startFrame).toContain("↑ more");
    component.handleInput("\r");
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
  });

  it("refuses unavailable models and preserves provider/model/reasoning in the payload", () => {
    const state = fixtureState();
    state.objective = "Build notes";
    state.roles[0]!.provider = "ambient";
    state.roles[0]!.model = "custom";
    expect(() => buildGuidedRunCreateInput(state)).toThrow(
      /unavailable to contained Koni attempts/u,
    );
  });
});

class FakeIntakeConnection implements MonitorAuthorityConnection {
  public revision = 7;
  public closed = false;
  public runCreateResult: JsonValue = { runId: "run-created" };
  public runCreateError: Error | undefined;
  public runCreateGate: Promise<void> | undefined;
  public readonly calls: Array<{
    method: string;
    params?: JsonValue;
    options?: { expectedRevision?: number; idempotencyKey?: string };
  }> = [];

  public async request(
    method: string,
    params?: JsonValue,
    options?: { expectedRevision?: number; idempotencyKey?: string },
  ): Promise<RpcSuccess> {
    this.calls.push({
      method,
      ...(params === undefined ? {} : { params }),
      ...(options === undefined ? {} : { options }),
    });
    if (method === "run.create") {
      if (this.runCreateGate !== undefined) await this.runCreateGate;
      if (this.runCreateError !== undefined) throw this.runCreateError;
    }
    const result =
      method === "control.catalog"
        ? {
            protocol: CONTROL_CATALOG_PROTOCOL,
            defaultRunTypeId: "medium",
            runTypes: monitorRunTypesFixture(),
          }
        : method === "branches.list"
          ? [{ ref: "refs/heads/feature/notes" }, { name: "main" }]
          : method === "run.create"
            ? this.runCreateResult
            : undefined;
    return {
      type: "response",
      id: method,
      ok: true,
      revision: this.revision,
      ...(result === undefined ? {} : { result: result as JsonValue }),
    };
  }

  public onEvent(_listener: (event: RpcEvent) => void): () => void {
    return () => undefined;
  }

  public close(): void {
    this.closed = true;
  }
}

function fixtureState() {
  return createGuidedRunState({
    runTypes: monitorRunTypesFixture(),
    defaultRunTypeId: "medium",
    branches: [
      { label: "feature/notes", reference: "refs/heads/feature/notes" },
      { label: "main", reference: "refs/heads/main" },
    ],
    models: monitorModelsFixture(),
  });
}
