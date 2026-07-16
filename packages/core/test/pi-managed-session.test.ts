import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentLaunchSpec } from "../src/pi/launch-spec.js";
import {
  ManagedPiSession,
  type ManagedPiSessionFactory,
  type PiSessionAdapter,
} from "../src/pi/managed-session.js";
import { ManagedSessionSupervisor } from "../src/pi/supervisor.js";
import type { KoniContextProvider } from "../src/pi/compaction.js";
import {
  TERMINAL_TOOL_NAME,
  fixtureLaunchSpec,
  fixtureTool,
} from "./pi-managed-fixtures.js";

describe("managed Pi session", () => {
  it("persists the full attempt mapping and accounts for cached and new tokens separately", async () => {
    const spec = specFor("attempt-one", "session-one");
    const adapter = new FakeSessionAdapter(spec);
    adapter.promptBehavior = async () => {
      adapter.emit(assistantUsageEvent(100, 20, 900, 30));
      adapter.emit(terminalEvent({ accepted: true, receipt: "receipt-one" }));
    };
    const session = await ManagedPiSession.create(spec, runtimeOptions(adapter));
    const events: string[] = [];
    session.subscribe((event) => events.push(event.type));
    const outcome = await session.start();

    expect(outcome).toMatchObject({
      status: "completed",
      usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 30, newTokens: 120, allTokens: 1_050 },
    });
    expect(adapter.mappings).toEqual([
      expect.objectContaining({
        protocol: "koni.attempt-session-map.v1",
        specHash: spec.specHash,
        runId: spec.identity.runId,
        ticketId: spec.identity.ticketId,
        stepId: spec.identity.stepId,
        attemptId: spec.identity.attemptId,
        sessionId: spec.identity.sessionId,
        grantHash: spec.authority.grantHash,
        resourceSetHash: spec.resources.setHash,
        sessionFile: adapter.sessionFile,
      }),
    ]);
    expect(events).toContain("usage");
    expect(events).toContain("terminal");
  });

  it("rejects ambient active tools before the initial prompt", async () => {
    const spec = specFor("attempt-tools", "session-tools");
    const adapter = new FakeSessionAdapter(spec, [TERMINAL_TOOL_NAME, "bash"]);
    await expect(ManagedPiSession.create(spec, runtimeOptions(adapter))).rejects.toEqual(
      expect.objectContaining({ code: "ambient_tool" }),
    );
    expect(adapter.promptCalls).toBe(0);
    expect(adapter.mappings).toEqual([]);
  });

  it("aborts on cache-inclusive token budget exhaustion", async () => {
    const spec = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-budget",
      attemptId: "attempt-budget",
      sessionId: "session-budget",
      maxAllTokens: 100,
    }) as AgentLaunchSpec;
    const adapter = new FakeSessionAdapter(spec);
    adapter.promptBehavior = async () => {
      adapter.emit(assistantUsageEvent(10, 10, 90, 0));
      await Promise.resolve();
    };
    const session = await ManagedPiSession.create(spec, runtimeOptions(adapter));
    const outcome = await session.start();
    expect(outcome).toEqual(expect.objectContaining({
      status: "aborted",
      reason: "cache-inclusive token budget exceeded",
    }));
    expect(adapter.abortCalls).toBe(1);
  });

  it("fails attempts that settle without the required terminal contract", async () => {
    const spec = specFor("attempt-missing", "session-missing");
    const adapter = new FakeSessionAdapter(spec);
    adapter.promptBehavior = async () => {
      adapter.emit(assistantUsageEvent(10, 2, 0, 0));
    };
    const session = await ManagedPiSession.create(spec, runtimeOptions(adapter));
    await expect(session.start()).resolves.toEqual(expect.objectContaining({
      status: "failed",
      error: expect.stringContaining("settled without calling terminal tool"),
    }));
  });
});

describe("managed session supervisor", () => {
  it("tombstones deletion before a concurrent factory can start spending tokens", async () => {
    const spec = specFor("attempt-race", "session-race");
    const adapter = new FakeSessionAdapter(spec);
    const gate = deferred<void>();
    const factory: ManagedPiSessionFactory = async () => {
      await gate.promise;
      return adapter;
    };
    const supervisor = new ManagedSessionSupervisor();
    const launch = supervisor.launch(spec, { ...runtimeOptions(adapter), factory });
    const deletion = supervisor.deleteRun(spec.identity.runId);
    gate.resolve();

    await expect(launch).rejects.toEqual(expect.objectContaining({ code: "run_deleted" }));
    await deletion;
    expect(adapter.promptCalls).toBe(0);
    expect(adapter.abortCalls).toBe(1);
    expect(adapter.disposeCalls).toBe(1);
    expect(supervisor.isDeleted(spec.identity.runId)).toBe(true);
    expect(() => supervisor.launch(spec, { ...runtimeOptions(adapter), factory })).toThrowError(
      expect.objectContaining({ code: "run_deleted" }),
    );
  });

  it("aborts and disposes an active session exactly once when its run is deleted", async () => {
    const spec = specFor("attempt-active", "session-active");
    const adapter = new FakeSessionAdapter(spec);
    const stopped = deferred<void>();
    adapter.promptBehavior = () => stopped.promise;
    adapter.abortBehavior = async () => stopped.resolve();
    const supervisor = new ManagedSessionSupervisor();
    const handle = await supervisor.launch(spec, runtimeOptions(adapter));
    expect(adapter.promptCalls).toBe(1);
    await supervisor.deleteRun(spec.identity.runId);
    await expect(handle.outcome).resolves.toEqual(expect.objectContaining({ status: "aborted" }));
    expect(adapter.abortCalls).toBe(1);
    expect(adapter.disposeCalls).toBe(1);
    await supervisor.deleteRun(spec.identity.runId);
    expect(adapter.abortCalls).toBe(1);
    expect(adapter.disposeCalls).toBe(1);
  });

  it("keeps pause admission closed until an explicit resume", async () => {
    const spec = specFor("attempt-pause", "session-pause");
    const adapter = new FakeSessionAdapter(spec);
    const stopped = deferred<void>();
    adapter.promptBehavior = () => stopped.promise;
    adapter.abortBehavior = async () => stopped.resolve();
    const supervisor = new ManagedSessionSupervisor();
    await supervisor.launch(spec, runtimeOptions(adapter));
    await supervisor.abortByRun(spec.identity.runId);
    const second = specFor("attempt-after-pause", "session-after-pause");
    expect(() => supervisor.launch(second, runtimeOptions(new FakeSessionAdapter(second)))).toThrowError(
      expect.objectContaining({ code: "run_suspended" }),
    );
    supervisor.resumeRun(spec.identity.runId);
    const resumedAdapter = new FakeSessionAdapter(second);
    resumedAdapter.promptBehavior = async () => resumedAdapter.emit(terminalEvent({ accepted: true }));
    const resumed = await supervisor.launch(second, runtimeOptions(resumedAdapter));
    await expect(resumed.outcome).resolves.toEqual(expect.objectContaining({ status: "completed" }));
  });
});

class FakeSessionAdapter implements PiSessionAdapter {
  public readonly sessionId: string;
  public readonly sessionFile: string;
  public readonly mappings: unknown[] = [];
  public readonly activeTools: readonly string[];
  public promptCalls = 0;
  public abortCalls = 0;
  public disposeCalls = 0;
  public promptBehavior: () => Promise<void> = async () => {};
  public abortBehavior: () => Promise<void> = async () => {};
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();

  public constructor(spec: AgentLaunchSpec, activeTools = [TERMINAL_TOOL_NAME]) {
    this.sessionId = spec.identity.sessionId;
    this.sessionFile = `${spec.workspace.sessionDirectory}/${spec.identity.sessionId}.jsonl`;
    this.activeTools = activeTools;
  }

  public getActiveToolNames(): readonly string[] {
    return this.activeTools;
  }

  public appendMapping(data: unknown): void {
    this.mappings.push(structuredClone(data));
  }

  public subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async prompt(_text: string): Promise<void> {
    this.promptCalls += 1;
    await this.promptBehavior();
  }

  public async steer(_text: string): Promise<void> {}

  public async followUp(_text: string): Promise<void> {}

  public async abort(): Promise<void> {
    this.abortCalls += 1;
    await this.abortBehavior();
  }

  public dispose(): void {
    this.disposeCalls += 1;
  }

  public emit(event: AgentSessionEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}

function specFor(attemptId: string, sessionId: string): AgentLaunchSpec {
  return fixtureLaunchSpec({
    cwd: "/tmp/koni-workspace",
    sessionDirectory: `/tmp/koni-sessions/${attemptId}`,
    attemptId,
    sessionId,
  }) as AgentLaunchSpec;
}

function runtimeOptions(adapter: FakeSessionAdapter) {
  return {
    tools: [fixtureTool()],
    contextProvider: contextProvider(),
    factory: (async () => adapter) satisfies ManagedPiSessionFactory,
  };
}

function contextProvider(): KoniContextProvider {
  return {
    async loadBoundContext() {
      throw new Error("not called by the offline session seam");
    },
    async loadCompactionSnapshot() {
      throw new Error("not called by the offline session seam");
    },
  };
}

function assistantUsageEvent(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): AgentSessionEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "working" }],
      api: "openai-responses",
      provider: "openai-codex",
      model: "gpt-5.6-terra",
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  } as AgentSessionEvent;
}

function terminalEvent(output: unknown): AgentSessionEvent {
  return {
    type: "tool_execution_end",
    toolCallId: "terminal-call",
    toolName: TERMINAL_TOOL_NAME,
    result: output,
    isError: false,
  };
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
