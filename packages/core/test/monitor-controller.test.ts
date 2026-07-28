import type { JsonValue, RpcEvent, RpcSuccess } from "../src/authority/protocol.js";
import { describe, expect, it, vi } from "vitest";
import type { MonitorAuthorityConnection } from "../src/monitor/client.js";
import { MonitorDecisionConflictError } from "../src/monitor/client.js";
import { MonitorController } from "../src/monitor/controller.js";
import { MONITOR_EVENTS_PROTOCOL } from "../src/monitor/protocol.js";
import {
  monitorAttentionFixture,
  monitorProposalFixture,
  monitorSnapshotFixture,
} from "./fixtures/monitor-fixtures.js";

describe("Pi companion monitor controller", () => {
  it("never connects passively outside a trusted initialized project", async () => {
    const connect = vi.fn(async () => undefined);
    const untrusted = new MonitorController({
      eligibility: { trusted: false, initialized: true },
      connect,
    });
    const uninitialized = new MonitorController({
      eligibility: { trusted: true, initialized: false },
      connect,
    });
    await untrusted.start();
    await uninitialized.start();
    expect(connect).not.toHaveBeenCalled();
    expect(untrusted.snapshot.connection).toBe("disabled");
    expect(uninitialized.snapshot.connection).toBe("disabled");
    untrusted.dispose();
    uninitialized.dispose();
  });

  it("shows a stopped state and uses bounded reconnect without an authority-start capability", async () => {
    vi.useFakeTimers();
    const connect = vi.fn(async () => undefined);
    const controller = new MonitorController({
      eligibility: { trusted: true, initialized: true },
      connect,
      reconnectDelaysMs: [2_000, 5_000],
    });
    await controller.start();
    expect(controller.snapshot.connection).toBe("stopped");
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(connect).toHaveBeenCalledTimes(3);
    controller.dispose();
    vi.useRealTimers();
  });

  it("coalesces events, publishes transition notices once, and keeps one heartbeat", async () => {
    vi.useFakeTimers();
    const notices: string[] = [];
    const connection = new FakeMonitorConnection();
    const controller = new MonitorController({
      eligibility: { trusted: true, initialized: true },
      connect: async () => connection,
      heartbeatMs: 20_000,
      eventDebounceMs: 100,
      onNotice: (notice) => notices.push(notice.message),
    });
    await controller.start();
    expect(notices).toEqual(["Koni needs input: 1 question · 1 plan"]);
    expect(connection.calls.map((call) => call.method)).toEqual([
      "monitor.snapshot",
      "monitor.attention",
    ]);

    connection.nextEvents = [
      {
        sequence: 9,
        at: "2026-07-17T12:00:01.000Z",
        kind: "stage_changed",
        runId: "run-a",
        runRevision: 5,
        title: "Executing",
        detail: "Notes run entered execution",
        ticketId: undefined,
      },
      {
        sequence: 10,
        at: "2026-07-17T12:00:02.000Z",
        kind: "ticket_completed",
        runId: "run-a",
        runRevision: 6,
        title: "Notes editor",
        detail: "Notes editor ticket completed",
        ticketId: "ticket-a",
      },
    ];
    connection.snapshot = { ...monitorSnapshotFixture(), eventCursor: 10, revision: 16 };
    connection.emit("run.changed");
    connection.emit("run.changed");
    connection.emit("agent.changed");
    await vi.advanceTimersByTimeAsync(99);
    expect(connection.calls.filter((call) => call.method === "monitor.events")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.calls.filter((call) => call.method === "monitor.events")).toHaveLength(1);
    expect(notices).toContain("Notes run entered execution");
    expect(notices).toContain("Notes editor ticket completed");

    const beforeHeartbeat = connection.calls.filter(
      (call) => call.method === "monitor.snapshot",
    ).length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(connection.calls.filter((call) => call.method === "monitor.snapshot").length).toBe(
      beforeHeartbeat + 1,
    );
    expect(notices.filter((notice) => notice.includes("entered execution"))).toHaveLength(1);
    controller.dispose();
    vi.useRealTimers();
  });

  it("keeps exactly one refresh in flight and coalesces all overlap into one queued rerun", async () => {
    const connection = new FakeMonitorConnection();
    const controller = new MonitorController({
      eligibility: { trusted: true, initialized: true },
      connect: async () => connection,
    });
    await controller.start();
    let release!: () => void;
    connection.snapshotGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = controller.refresh();
    await flushPromises();
    const second = controller.refresh();
    const third = controller.refresh();
    expect(connection.maxSnapshotsInFlight).toBe(1);
    release();
    await Promise.all([first, second, third]);
    expect(connection.maxSnapshotsInFlight).toBe(1);
    expect(connection.calls.filter((call) => call.method === "monitor.snapshot")).toHaveLength(3);
    controller.dispose();
  });

  it("accepts a monotonic attention race and immediately refreshes the older summary", async () => {
    const connection = new FakeMonitorConnection();
    const controller = new MonitorController({
      eligibility: { trusted: true, initialized: true },
      connect: async () => connection,
    });
    await controller.start();
    connection.attention = { ...monitorAttentionFixture(), runRevision: 5 };
    connection.advanceSnapshotAfterAttention = true;
    await controller.refresh();
    expect(controller.snapshot.monitor?.runs[0]?.runRevision).toBe(5);
    expect(controller.snapshot.attentions["run-a"]?.runRevision).toBe(5);
    controller.dispose();
  });

  it("notifies durable blocker state on attach and does not repeat it on a heartbeat", async () => {
    const connection = new FakeMonitorConnection();
    connection.snapshot = {
      ...monitorSnapshotFixture(),
      runs: [
        {
          ...monitorSnapshotFixture().runs[0],
          phase: "blocked",
          planApproval: false,
          questionCount: 0,
          blocker: "Migration precondition failed",
        },
      ],
    };
    const notices: string[] = [];
    const controller = new MonitorController({
      eligibility: { trusted: true, initialized: true },
      connect: async () => connection,
      onNotice: (notice) => notices.push(notice.message),
    });
    await controller.start();
    expect(notices).toEqual(["Koni needs attention: 1 blocker"]);
    await controller.refresh();
    expect(notices).toEqual(["Koni needs attention: 1 blocker"]);
    controller.dispose();
  });

  it("uses only revisioned idempotent decisions and never replays on CAS conflict", async () => {
    const connection = new FakeMonitorConnection();
    const keys = ["answer-key", "approve-key", "revise-key", "proposal-key"];
    const controller = new MonitorController({
      eligibility: { trusted: true, initialized: true },
      connect: async () => connection,
      idempotencyKey: () => keys.shift() ?? "unexpected-key",
    });
    await controller.start();
    await controller.answerQuestion({
      runId: "run-a",
      questionId: "question-a",
      selectedOptionId: "database",
      notes: "Keep old notes readable.",
    });
    await controller.approvePlan("run-a");
    await controller.revisePlan("run-a", "Keep the migration reversible.\nRetain the old field.");
    connection.snapshot = {
      ...monitorSnapshotFixture(),
      runs: monitorSnapshotFixture().runs.map((run: any) => ({ ...run, proposalCount: 1 })),
    };
    connection.attention = {
      ...monitorAttentionFixture(),
      proposals: [monitorProposalFixture()],
    };
    await controller.refresh();
    await controller.decideProposal({
      runId: "run-a",
      ticketId: "proposal-a",
      decision: "rejection",
      message: "Keep the current storage boundary.",
    });
    const mutations = connection.calls.filter((call) => call.options?.idempotencyKey !== undefined);
    expect(mutations.map((call) => call.method)).toEqual([
      "question.answer",
      "plan.approve",
      "plan.revise",
      "proposal.decide",
    ]);
    expect(mutations.map((call) => call.options)).toEqual([
      { expectedRevision: 12, idempotencyKey: "answer-key" },
      { expectedRevision: 13, idempotencyKey: "approve-key" },
      { expectedRevision: 14, idempotencyKey: "revise-key" },
      { expectedRevision: 15, idempotencyKey: "proposal-key" },
    ]);
    expect(mutations.at(-1)?.params).toEqual({
      runId: "run-a",
      ticketId: "proposal-a",
      decision: "rejection",
      message: "Keep the current storage boundary.",
    });
    expect(mutations.at(-1)?.params).not.toHaveProperty("actor");
    expect(
      connection.calls.some((call) => /steer|follow|pause|delete|merge|config/iu.test(call.method)),
    ).toBe(false);

    connection.mutationError = Object.assign(new Error("revision changed"), {
      code: "revision_conflict",
    });
    const before = connection.calls.filter((call) => call.method === "plan.approve").length;
    await expect(controller.approvePlan("run-a")).rejects.toBeInstanceOf(
      MonitorDecisionConflictError,
    );
    expect(connection.calls.filter((call) => call.method === "plan.approve")).toHaveLength(
      before + 1,
    );
    controller.dispose();
  });

  it("suspends and disposes timers, sockets, listeners, and stale UI updates idempotently", async () => {
    vi.useFakeTimers();
    const first = new FakeMonitorConnection();
    const second = new FakeMonitorConnection();
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const controller = new MonitorController({
      eligibility: { trusted: true, initialized: true },
      connect,
      heartbeatMs: 20_000,
    });
    const listener = vi.fn();
    controller.subscribe(listener);
    await controller.start();
    controller.suspend();
    expect(first.closed).toBe(true);
    expect(controller.snapshot.connection).toBe("suspended");
    first.emit("run.changed");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connect).toHaveBeenCalledTimes(1);
    await controller.resume();
    expect(connect).toHaveBeenCalledTimes(2);
    controller.dispose();
    controller.dispose();
    expect(second.closed).toBe(true);
    const calls = listener.mock.calls.length;
    second.emit("run.changed");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(listener).toHaveBeenCalledTimes(calls);
    vi.useRealTimers();
  });
});

class FakeMonitorConnection implements MonitorAuthorityConnection {
  public revision = 12;
  public snapshot = monitorSnapshotFixture();
  public attention = monitorAttentionFixture();
  public nextEvents: any[] = [];
  public mutationError: Error | undefined;
  public advanceSnapshotAfterAttention = false;
  public snapshotGate: Promise<void> | undefined;
  public snapshotsInFlight = 0;
  public maxSnapshotsInFlight = 0;
  public closed = false;
  public readonly calls: Array<{
    method: string;
    params: JsonValue | undefined;
    options: { expectedRevision?: number; idempotencyKey?: string } | undefined;
  }> = [];
  readonly #listeners = new Set<(event: RpcEvent) => void>();

  public async request(
    method: string,
    params?: JsonValue,
    options?: { expectedRevision?: number; idempotencyKey?: string },
  ): Promise<RpcSuccess> {
    this.calls.push({ method, params, options });
    if (options?.idempotencyKey !== undefined) {
      if (this.mutationError !== undefined) throw this.mutationError;
      this.revision += 1;
      return { type: "response", id: `r-${this.calls.length}`, ok: true, revision: this.revision };
    }
    let result: JsonValue;
    if (method === "monitor.snapshot") {
      this.snapshotsInFlight += 1;
      this.maxSnapshotsInFlight = Math.max(this.maxSnapshotsInFlight, this.snapshotsInFlight);
      if (this.snapshotGate !== undefined) {
        const gate = this.snapshotGate;
        this.snapshotGate = undefined;
        await gate;
      }
      result = structuredClone(this.snapshot);
      this.snapshotsInFlight -= 1;
    } else if (method === "monitor.attention") {
      result = structuredClone(this.attention);
      if (this.advanceSnapshotAfterAttention) {
        this.advanceSnapshotAfterAttention = false;
        this.snapshot = {
          ...this.snapshot,
          runs: this.snapshot.runs.map((run: any) => ({
            ...run,
            runRevision: this.attention.runRevision,
          })),
        };
      }
    } else if (method === "monitor.events") {
      const after = (params as any).after as number;
      const events = this.nextEvents.filter((event) => event.sequence > after);
      const nextCursor = events.at(-1)?.sequence ?? after;
      result = {
        protocol: MONITOR_EVENTS_PROTOCOL,
        fromCursor: after,
        nextCursor,
        truncated: false,
        events,
      };
    } else throw new Error(`unexpected method ${method}`);
    return {
      type: "response",
      id: `r-${this.calls.length}`,
      ok: true,
      revision: this.revision,
      result,
    };
  }

  public onEvent(listener: (event: RpcEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public emit(topic: string): void {
    for (const listener of this.#listeners)
      listener({ type: "event", sequence: 1, revision: this.revision, topic });
  }

  public close(): void {
    this.closed = true;
    this.#listeners.clear();
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
