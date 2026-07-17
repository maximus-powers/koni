import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createAgentLaunchSpec, type AgentLaunchSpec } from "../src/pi/launch-spec.js";
import {
  assertSupportedPiRuntimeVersion,
  ManagedPiSession,
  type ManagedPiSessionFactory,
  type PiSessionAdapter,
  type RecoveredSessionState,
} from "../src/pi/managed-session.js";
import { ManagedSessionSupervisor } from "../src/pi/supervisor.js";
import type { KoniAuthorizedMessage, KoniContextProvider } from "../src/pi/compaction.js";
import { rawSha256 } from "../src/shared/canonical.js";
import {
  TERMINAL_TOOL_NAME,
  fixtureLaunchSpec,
  fixtureTool,
} from "./pi-managed-fixtures.js";

describe("managed Pi session", () => {
  it("fails closed when the private continuation seam is not the exact pinned Pi runtime", () => {
    expect(() => assertSupportedPiRuntimeVersion("0.80.11")).toThrowError(
      expect.objectContaining({ code: "pi_runtime_version" }),
    );
    expect(() => assertSupportedPiRuntimeVersion("0.80.10")).not.toThrow();
  });

  it("persists the full attempt mapping and accounts for cached and new tokens separately", async () => {
    const spec = specFor("attempt-one", "session-one");
    const adapter = new FakeSessionAdapter(spec);
    adapter.promptBehavior = async () => {
      adapter.emit(assistantUsageEvent(100, 20, 900, 30));
      emitTerminal(adapter, { result: "receipt-one" });
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
        lineage: spec.lineage,
        sessionFile: adapter.sessionFile,
      }),
    ]);
    expect(events).toContain("usage");
    expect(events).toContain("terminal");
    expect(adapter.disposeCalls).toBe(1);
  });

  it("isolates throwing observers from token accounting and terminal persistence", async () => {
    const spec = specFor("attempt-observer", "session-observer");
    const adapter = new FakeSessionAdapter(spec);
    adapter.promptBehavior = async () => {
      adapter.emit(assistantUsageEvent(5, 3, 2, 1));
      emitTerminal(adapter, { result: "accepted" });
    };
    const session = await ManagedPiSession.create(spec, runtimeOptions(adapter));
    session.subscribe(() => {
      throw new Error("broken TUI observer");
    });

    await expect(session.start()).resolves.toEqual(expect.objectContaining({
      status: "completed",
      terminalOutput: { result: "accepted" },
      usage: expect.objectContaining({ allTokens: 11 }),
    }));
  });

  it("rejects terminal arguments that do not match the hash-bound output schema", async () => {
    const spec = specFor("attempt-terminal-schema", "session-terminal-schema");
    const adapter = new FakeSessionAdapter(spec);
    adapter.promptBehavior = async () => emitTerminal(adapter, { unexpected: true });
    const session = await ManagedPiSession.create(spec, runtimeOptions(adapter));

    await expect(session.start()).resolves.toEqual(expect.objectContaining({
      status: "failed",
      error: expect.stringContaining("does not match the compiler-issued schema"),
    }));
    expect(adapter.abortCalls).toBe(1);
  });

  it("fails a mixed terminal tool batch before it can be accepted", async () => {
    const spec = specFor("attempt-terminal-batch", "session-terminal-batch");
    const adapter = new FakeSessionAdapter(spec);
    adapter.promptBehavior = async () => {
      adapter.emit(assistantUsageEvent(1, 1, 0, 0, [
        { type: "toolCall", id: "terminal", name: TERMINAL_TOOL_NAME, arguments: { result: "done" } },
        { type: "toolCall", id: "other", name: "unexpected_tool", arguments: {} },
      ]));
    };
    const session = await ManagedPiSession.create(spec, runtimeOptions(adapter));

    await expect(session.start()).resolves.toEqual(expect.objectContaining({
      status: "failed",
      error: expect.stringContaining("must be the only call"),
    }));
    expect(adapter.abortCalls).toBe(1);
  });

  it("requires the authority receipt to terminate the terminal tool batch", async () => {
    const spec = specFor("attempt-terminal-stop", "session-terminal-stop");
    const adapter = new FakeSessionAdapter(spec);
    adapter.promptBehavior = async () => emitTerminal(adapter, { result: "done" }, false);
    const session = await ManagedPiSession.create(spec, runtimeOptions(adapter));

    await expect(session.start()).resolves.toEqual(expect.objectContaining({
      status: "failed",
      error: expect.stringContaining("did not terminate"),
    }));
    expect(adapter.abortCalls).toBe(1);
  });

  it("blocks steering as soon as a terminal submission begins, even before the prompt settles", async () => {
    const spec = specFor("attempt-terminal-steer", "session-terminal-steer");
    const adapter = new FakeSessionAdapter(spec);
    const settled = deferred<void>();
    adapter.promptBehavior = async () => {
      emitTerminal(adapter, { result: "done" });
      await settled.promise;
    };
    const session = await ManagedPiSession.create(spec, runtimeOptions(adapter));
    const outcome = session.start();
    await Promise.resolve();

    await expect(session.steer(authorizedMessage(1, "steer", "change the result"))).rejects.toEqual(
      expect.objectContaining({ code: "message_state" }),
    );
    settled.resolve();
    await expect(outcome).resolves.toEqual(expect.objectContaining({ status: "completed" }));
  });

  it("does not roll back an authority-accepted terminal result when Pi cleanup fails", async () => {
    const spec = specFor("attempt-cleanup-failure", "session-cleanup-failure");
    const adapter = new FakeSessionAdapter(spec);
    adapter.promptBehavior = async () => emitTerminal(adapter, { result: "done" });
    adapter.disposeBehavior = async () => {
      throw new Error("extension shutdown failed");
    };
    const session = await ManagedPiSession.create(spec, runtimeOptions(adapter));

    await expect(session.start()).resolves.toEqual(expect.objectContaining({
      status: "completed",
      terminalOutput: { result: "done" },
    }));
    expect(adapter.disposeCalls).toBe(1);
  });

  it("rejects ambient active tools before the initial prompt", async () => {
    const spec = specFor("attempt-tools", "session-tools");
    const adapter = new FakeSessionAdapter(spec, [TERMINAL_TOOL_NAME, "bash"]);
    await expect(ManagedPiSession.create(spec, runtimeOptions(adapter))).rejects.toEqual(
      expect.objectContaining({ code: "ambient_tool" }),
    );
    expect(adapter.promptCalls).toBe(0);
    expect(adapter.mappings).toEqual([]);
    expect(adapter.abortCalls).toBe(1);
    expect(adapter.disposeCalls).toBe(1);
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

  it("aborts on the immutable new-token ceiling before the cache-inclusive ceiling", async () => {
    const base = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-new-token-budget",
      attemptId: "attempt-new-token-budget",
      sessionId: "session-new-token-budget",
    });
    const { specHash: _hash, ...draft } = structuredClone(base);
    draft.budgets.tokens = {
      maxInput: 15,
      maxOutput: 15,
      maxCacheRead: 10_000,
      maxCacheWrite: 10_000,
      maxNew: 15,
      maxAll: 10_000,
    };
    const spec = createAgentLaunchSpec(draft) as AgentLaunchSpec;
    const adapter = new FakeSessionAdapter(spec);
    adapter.promptBehavior = async () => {
      adapter.emit(assistantUsageEvent(10, 10, 90, 0));
      await Promise.resolve();
    };
    const session = await ManagedPiSession.create(spec, runtimeOptions(adapter));

    await expect(session.start()).resolves.toEqual(expect.objectContaining({
      status: "aborted",
      reason: "new-token token budget exceeded",
    }));
    expect(adapter.abortCalls).toBe(1);
  });

  it("does not report budget cancellation until Pi's abort has settled", async () => {
    const spec = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-budget-wait",
      attemptId: "attempt-budget-wait",
      sessionId: "session-budget-wait",
      maxAllTokens: 100,
    }) as AgentLaunchSpec;
    const adapter = new FakeSessionAdapter(spec);
    const aborted = deferred<void>();
    adapter.abortBehavior = () => aborted.promise;
    adapter.promptBehavior = async () => adapter.emit(assistantUsageEvent(10, 10, 90, 0));
    const session = await ManagedPiSession.create(spec, runtimeOptions(adapter));
    let settled = false;
    const outcome = session.start().finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    aborted.resolve();
    await expect(outcome).resolves.toEqual(expect.objectContaining({ status: "aborted" }));
  });

  it("reports a failed outcome when Pi cannot confirm token-stopping abort", async () => {
    const spec = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-abort-failure",
      attemptId: "attempt-abort-failure",
      sessionId: "session-abort-failure",
      maxAllTokens: 100,
    }) as AgentLaunchSpec;
    const adapter = new FakeSessionAdapter(spec);
    adapter.abortBehavior = async () => {
      throw new Error("provider loop did not acknowledge abort");
    };
    adapter.promptBehavior = async () => adapter.emit(assistantUsageEvent(10, 10, 90, 0));
    const session = await ManagedPiSession.create(spec, runtimeOptions(adapter));

    await expect(session.start()).resolves.toEqual(expect.objectContaining({
      status: "failed",
      error: expect.stringContaining("abort failed"),
    }));
  });

  it("memoizes disposal while still attempting adapter cleanup after abort failure", async () => {
    const spec = specFor("attempt-dispose", "session-dispose");
    const adapter = new FakeSessionAdapter(spec);
    adapter.abortBehavior = async () => {
      throw new Error("abort failed");
    };
    const session = await ManagedPiSession.create(spec, runtimeOptions(adapter));

    const results = await Promise.allSettled([session.dispose(), session.dispose()]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(adapter.abortCalls).toBe(1);
    expect(adapter.disposeCalls).toBe(1);
    expect(session.status).toBe("disposed");
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

  it("recovers a crash after session creation by issuing the initial prompt exactly once", async () => {
    const spec = specFor("attempt-recover-created", "session-recover-created");
    const adapter = new FakeSessionAdapter(spec, undefined, recovered("prompt"));
    adapter.promptBehavior = async () => emitTerminal(adapter, { result: "accepted" });

    const session = await ManagedPiSession.recover(spec, runtimeOptions(adapter));
    await expect(session.start()).resolves.toEqual(expect.objectContaining({ status: "completed" }));
    expect(adapter.promptCalls).toBe(1);
    expect(adapter.continueCalls).toBe(0);
    expect(adapter.mappings).toEqual([]);
  });

  it("recovers a crash after a persisted user turn without replaying its initial prompt", async () => {
    const spec = specFor("attempt-recover-turn", "session-recover-turn");
    const adapter = new FakeSessionAdapter(spec, undefined, recovered("continue"));
    adapter.continueBehavior = async () => emitTerminal(adapter, { result: "accepted" });

    const session = await ManagedPiSession.recover(spec, runtimeOptions(adapter));
    await expect(session.start()).resolves.toEqual(expect.objectContaining({ status: "completed" }));
    expect(adapter.promptCalls).toBe(0);
    expect(adapter.continueCalls).toBe(1);
    expect(adapter.mappings).toEqual([]);
  });

  it("projects an authority-accepted terminal receipt without spending another token", async () => {
    const spec = specFor("attempt-recover-terminal", "session-recover-terminal");
    const recovery: RecoveredSessionState = {
      usage: { input: 3, output: 2, cacheRead: 7, cacheWrite: 0, newTokens: 5, allTokens: 12 },
      disposition: { kind: "complete", terminalOutput: { result: "accepted" } },
    };
    const adapter = new FakeSessionAdapter(spec, undefined, recovery);

    const session = await ManagedPiSession.recover(spec, runtimeOptions(adapter));
    await expect(session.start()).resolves.toEqual({
      status: "completed",
      terminalOutput: { result: "accepted" },
      usage: recovery.usage,
    });
    expect(adapter.promptCalls).toBe(0);
    expect(adapter.continueCalls).toBe(0);
  });

  it("does not resume a persisted attempt whose cache-inclusive budget is already exhausted", async () => {
    const spec = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-recover-budget",
      attemptId: "attempt-recover-budget",
      sessionId: "session-recover-budget",
      maxAllTokens: 100,
    }) as AgentLaunchSpec;
    const recovery: RecoveredSessionState = {
      usage: { input: 10, output: 10, cacheRead: 81, cacheWrite: 0, newTokens: 20, allTokens: 101 },
      disposition: { kind: "continue" },
    };
    const adapter = new FakeSessionAdapter(spec, undefined, recovery);

    const session = await ManagedPiSession.recover(spec, runtimeOptions(adapter));
    await expect(session.start()).resolves.toEqual(expect.objectContaining({
      status: "aborted",
      reason: "cache-inclusive token budget exceeded",
    }));
    expect(adapter.promptCalls).toBe(0);
    expect(adapter.continueCalls).toBe(0);
    expect(adapter.abortCalls).toBe(1);
  });

  it("does not make a recovery provider call when a token budget has no remaining headroom", async () => {
    const spec = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-recover-exact-budget",
      attemptId: "attempt-recover-exact-budget",
      sessionId: "session-recover-exact-budget",
      maxAllTokens: 100,
    }) as AgentLaunchSpec;
    const recovery: RecoveredSessionState = {
      usage: { input: 10, output: 10, cacheRead: 80, cacheWrite: 0, newTokens: 20, allTokens: 100 },
      disposition: { kind: "continue" },
    };
    const adapter = new FakeSessionAdapter(spec, undefined, recovery);
    const session = await ManagedPiSession.recover(spec, runtimeOptions(adapter));

    await expect(session.start()).resolves.toEqual(expect.objectContaining({
      status: "aborted",
      reason: "cache-inclusive token budget exhausted",
    }));
    expect(adapter.promptCalls).toBe(0);
    expect(adapter.continueCalls).toBe(0);
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
    resumedAdapter.promptBehavior = async () => emitTerminal(resumedAdapter, { result: "accepted" });
    const resumed = await supervisor.launch(second, runtimeOptions(resumedAdapter));
    await expect(resumed.outcome).resolves.toEqual(expect.objectContaining({ status: "completed" }));
    expect(supervisor.get(second.identity.attemptId)).toBeUndefined();
  });

  it("supervises a recovered continuation without creating a fresh session", async () => {
    const spec = specFor("attempt-supervisor-recovery", "session-supervisor-recovery");
    const adapter = new FakeSessionAdapter(spec, undefined, recovered("continue"));
    adapter.continueBehavior = async () => emitTerminal(adapter, { result: "accepted" });
    const supervisor = new ManagedSessionSupervisor();

    const handle = await supervisor.recover(spec, runtimeOptions(adapter));
    await expect(handle.outcome).resolves.toEqual(expect.objectContaining({ status: "completed" }));
    expect(adapter.promptCalls).toBe(0);
    expect(adapter.continueCalls).toBe(1);
    expect(supervisor.get(spec.identity.attemptId)).toBeUndefined();
  });
});

class FakeSessionAdapter implements PiSessionAdapter {
  public readonly sessionId: string;
  public readonly sessionFile: string;
  public readonly mappings: unknown[] = [];
  public readonly activeTools: readonly string[];
  public readonly recovery: RecoveredSessionState | undefined;
  public promptCalls = 0;
  public continueCalls = 0;
  public abortCalls = 0;
  public disposeCalls = 0;
  public promptBehavior: () => Promise<void> = async () => {};
  public continueBehavior: () => Promise<void> = async () => {};
  public abortBehavior: () => Promise<void> = async () => {};
  public disposeBehavior: () => Promise<void> = async () => {};
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();

  public constructor(
    public readonly spec: AgentLaunchSpec,
    activeTools = [TERMINAL_TOOL_NAME],
    recovery?: RecoveredSessionState,
  ) {
    this.sessionId = spec.identity.sessionId;
    this.sessionFile = `${spec.workspace.sessionDirectory}/${spec.identity.sessionId}.jsonl`;
    this.activeTools = activeTools;
    this.recovery = recovery;
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

  public async continue(): Promise<void> {
    this.continueCalls += 1;
    await this.continueBehavior();
  }

  public async steer(_message: KoniAuthorizedMessage): Promise<void> {}

  public async followUp(_message: KoniAuthorizedMessage): Promise<void> {}

  public async abort(): Promise<void> {
    this.abortCalls += 1;
    await this.abortBehavior();
  }

  public async dispose(): Promise<void> {
    this.disposeCalls += 1;
    await this.disposeBehavior();
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
    contextProvider: contextProvider(adapter.spec),
    factory: (async () => adapter) satisfies ManagedPiSessionFactory,
  };
}

function contextProvider(spec: AgentLaunchSpec): KoniContextProvider {
  return {
    async loadBoundContext() {
      throw new Error("not called by the offline session seam");
    },
    async loadCompactionSnapshot() {
      throw new Error("not called by the offline session seam");
    },
    async authorizeCompaction() {
      throw new Error("not called by the offline session seam");
    },
    async acquireRecoveryClaim() {
      return {
        protocol: "koni.attempt-recovery-claim.v1",
        claimId: `claim-${spec.identity.attemptId}`,
        state: {
          protocol: "koni.attempt-recovery.v1",
          specHash: spec.specHash,
          ...spec.identity,
          grantHash: spec.authority.grantHash,
          generation: spec.authority.generation,
          epoch: spec.authority.epoch,
          stateHash: spec.authority.expectedStateHash,
          status: "continue",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
          authorizedMessages: [],
          authorizedToolResults: [],
          authorizedCompactions: [],
        },
        async release() {},
      };
    },
  };
}

function recovered(kind: "prompt" | "continue"): RecoveredSessionState {
  return {
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
    disposition: { kind },
  };
}

function authorizedMessage(
  sequence: number,
  mode: KoniAuthorizedMessage["mode"],
  content: string,
): KoniAuthorizedMessage {
  return {
    sequence,
    mode,
    content,
    sha256: rawSha256(content),
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
}

function assistantUsageEvent(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  content: Array<Record<string, unknown>> = [{ type: "text", text: "working" }],
): AgentSessionEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content,
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
  } as unknown as AgentSessionEvent;
}

function emitTerminal(adapter: FakeSessionAdapter, output: unknown, terminate = true): void {
  adapter.emit({
    type: "tool_execution_start",
    toolCallId: "terminal-call",
    toolName: TERMINAL_TOOL_NAME,
    args: output,
  } as AgentSessionEvent);
  adapter.emit({
    type: "tool_execution_end",
    toolCallId: "terminal-call",
    toolName: TERMINAL_TOOL_NAME,
    result: {
      content: [{ type: "text", text: "accepted" }],
      details: { accepted: true },
      terminate,
    },
    isError: false,
  } as AgentSessionEvent);
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
