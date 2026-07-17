import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BoundedJsonLineDecoder,
  PI_ATTEMPT_PROCESS_PROTOCOL,
  PiAttemptProcessProtocolError,
  encodePiAttemptProcessFrame,
} from "../src/pi/attempt-process-protocol.js";
import {
  SupervisedPiAttemptProcess,
  type PiAttemptProcessAuthority,
} from "../src/pi/attempt-process-supervisor.js";
import { PiAttemptProcessSupervisor } from "../src/pi/attempt-process-pool.js";
import { TERMINAL_OUTPUT_SCHEMA, fixtureLaunchSpec } from "./pi-managed-fixtures.js";
import { rawSha256 } from "../src/shared/canonical.js";
import { KONI_TOOL_RECEIPT_PROTOCOL } from "../src/pi/tool-catalog.js";

const fixtureEntry = fileURLToPath(new URL("./fixtures/pi-attempt-process-fixture.mjs", import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounded attempt-process protocol", () => {
  it("decodes fragmented frames and rejects truncated or oversized input", () => {
    const frame = {
      protocol: PI_ATTEMPT_PROCESS_PROTOCOL,
      attemptId: "attempt-one",
      specHash: "sha256:".concat("a".repeat(64)),
      sequence: 1,
      type: "fatal" as const,
      error: "nope",
    };
    const bytes = encodePiAttemptProcessFrame(frame);
    const decoder = new BoundedJsonLineDecoder(1024);
    expect(decoder.push(bytes.subarray(0, 7))).toEqual([]);
    expect(decoder.push(bytes.subarray(7))).toEqual([frame]);
    expect(() => decoder.finish()).not.toThrow();

    const truncated = new BoundedJsonLineDecoder(16);
    truncated.push(Buffer.from("{\"partial\":"));
    expect(() => truncated.finish()).toThrow(PiAttemptProcessProtocolError);
    const oversized = new BoundedJsonLineDecoder(4);
    expect(() => oversized.push(Buffer.from("12345"))).toThrowError(/byte bound/);
  });
});

describe("supervised autonomous Pi attempt process", () => {
  it("forwards ordered lifecycle and cache-inclusive usage, then waits for clean exit", async () => {
    const { spec, options } = await fixture("normal");
    const child = new SupervisedPiAttemptProcess(spec, options);
    const events: string[] = [];
    child.subscribe(({ event }) => events.push(event.type));
    await child.ready;
    await expect(child.outcome).resolves.toEqual({
      status: "completed",
      terminalOutput: { result: "ok" },
      usage: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, newTokens: 5, allTokens: 17 },
    });
    expect(events).toEqual(["usage"]);
  });

  it("cannot begin a deferred attempt until authority explicitly activates it", async () => {
    const { spec, options } = await fixture("deferred");
    const child = new SupervisedPiAttemptProcess(spec, { ...options, deferActivation: true });
    await child.ready;
    let settled = false;
    void child.outcome.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);

    await child.activate();
    await expect(child.outcome).resolves.toEqual({
      status: "completed",
      terminalOutput: { result: "activated" },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
    });
  });

  it("aborts a deferred ready session without activating provider work", async () => {
    const { spec, options } = await fixture("deferred");
    const child = new SupervisedPiAttemptProcess(spec, { ...options, deferActivation: true });
    await child.ready;
    await child.abort("provider-free release probe complete");
    await expect(child.outcome).resolves.toMatchObject({
      status: "aborted",
      reason: "provider-free release probe complete",
    });
  });

  it("round-trips meaningful tool effects through parent authority", async () => {
    let invocation: unknown;
    const { spec, options } = await fixture("authority", {
      invokeTool: async (call) => {
        invocation = call;
        return {
          protocol: KONI_TOOL_RECEIPT_PROTOCOL,
          receiptId: "receipt-one",
          outcome: "accepted",
          summary: "accepted by authority",
        };
      },
    });
    const child = new SupervisedPiAttemptProcess(spec, options);
    await child.ready;
    await expect(child.outcome).resolves.toMatchObject({
      status: "completed",
      terminalOutput: { result: "authority-ok" },
    });
    expect(invocation).toMatchObject({
      callId: "call-one",
      name: "koni_submit_output",
      arguments: { result: "fixture" },
    });
  });

  it("forwards the complete authority-committed steering record", async () => {
    const { spec, options } = await fixture("message");
    const child = new SupervisedPiAttemptProcess(spec, options);
    await child.ready;
    const content = "Use the existing component contract.";
    const message = {
      sequence: 4,
      mode: "steer" as const,
      content,
      sha256: rawSha256(content),
      sizeBytes: Buffer.byteLength(content),
    };
    await child.steer(message);
    await expect(child.outcome).resolves.toMatchObject({
      status: "completed",
      terminalOutput: { result: `steer:4:${message.sha256}` },
    });
  });

  it("records a no-effect transcript-budget rejection through authority", async () => {
    let rejected = false;
    const { spec, options } = await fixture("authority_reject", {
      rejectTool: async (_call, rejection) => {
        rejected = true;
        return {
          protocol: KONI_TOOL_RECEIPT_PROTOCOL,
          receiptId: "rejection-one",
          outcome: "rejected",
          code: rejection.code,
          summary: rejection.summary,
        };
      },
    });
    const child = new SupervisedPiAttemptProcess(spec, options);
    await child.ready;
    await expect(child.outcome).resolves.toMatchObject({
      status: "completed",
      terminalOutput: { result: "rejection-recorded" },
    });
    expect(rejected).toBe(true);
  });

  it("preserves provider environment while stripping ambient Node code injection", async () => {
    const { spec, options } = await fixture("environment");
    options.runtime = {
      ...options.runtime,
      additionalEnvironment: {
        ...options.runtime?.additionalEnvironment,
        KONI_TEST_PROVIDER_CREDENTIAL: "normal-pi-auth",
        NODE_OPTIONS: "--require=/definitely/not/a/koni/module.cjs",
      },
    };
    const child = new SupervisedPiAttemptProcess(spec, options);
    await child.ready;
    await expect(child.outcome).resolves.toMatchObject({
      status: "completed",
      terminalOutput: { result: "normal-pi-auth:no-node-options" },
    });
  });

  it("reports a child crash as failure instead of replayable completion", async () => {
    const { spec, options } = await fixture("crash");
    const child = new SupervisedPiAttemptProcess(spec, options);
    await child.ready;
    await expect(child.outcome).resolves.toMatchObject({ status: "failed" });
  });

  it("deletion escalates past a stuck child and resolves only after exit", async () => {
    const { spec, options } = await fixture("stuck");
    const child = new SupervisedPiAttemptProcess(spec, options);
    await child.ready;
    const pid = child.pid!;
    await child.delete("run deleted in test");
    await expect(child.outcome).resolves.toMatchObject({ status: "aborted", reason: "run deleted in test" });
    expect(processExists(pid)).toBe(false);
    const content = "should fail";
    await expect(child.steer({
      sequence: 1,
      mode: "steer",
      content,
      sha256: rawSha256(content),
      sizeBytes: Buffer.byteLength(content),
    })).rejects.toMatchObject({ code: "run_deleted" });
  });

  it("kills descendants in the same attempt process group", async () => {
    const { spec, options } = await fixture("descendant");
    const child = new SupervisedPiAttemptProcess(spec, options);
    let descendantPid: number | undefined;
    child.subscribe(({ event }) => {
      if (event.type === "pi_lifecycle" && event.eventType.startsWith("fixture_descendant:")) {
        descendantPid = Number(event.eventType.split(":")[1]);
      }
    });
    await child.ready;
    await waitUntil(() => descendantPid !== undefined);
    await child.delete("delete process tree");
    expect(processExists(descendantPid!)).toBe(false);
  });
});

describe("run-level attempt process pool", () => {
  it("checks the authority's executable closure before constructing any child", async () => {
    const { spec, options } = await fixture("normal");
    const { mode: _mode, ...launchOptions } = options;
    const beforeLaunch = vi.fn(async () => {
      throw new Error("runtime bytes changed");
    });
    const pool = new PiAttemptProcessSupervisor({ beforeLaunch });
    await expect(pool.launch(spec, launchOptions)).rejects.toThrow(/runtime bytes changed/);
    expect(beforeLaunch).toHaveBeenCalledOnce();
    expect(pool.list(spec.identity.runId)).toEqual([]);
    await pool.dispose();
  });

  it("matches engine launch/get/list semantics and emits outcome after early lifecycle events", async () => {
    const { spec, options } = await fixture("normal");
    const { mode: _mode, ...launchOptions } = options;
    const pool = new PiAttemptProcessSupervisor({ deferActivationUntilAuthorityCommit: false });
    const eventTypes: string[] = [];
    pool.subscribe(({ event }) => eventTypes.push(event.type));
    const handle = await pool.launch(spec, launchOptions);
    expect(pool.get(spec.identity.attemptId)).toBe(handle);
    expect(pool.list(spec.identity.runId)).toEqual([handle]);
    await expect(handle.outcome).resolves.toMatchObject({ status: "completed" });
    await waitUntil(() => eventTypes.includes("outcome"));
    expect(eventTypes).toEqual(["usage", "outcome"]);
    await pool.dispose();
  });

  it("exposes a created session for durable authority admission before activation", async () => {
    const { spec, options } = await fixture("deferred");
    const { mode: _mode, ...launchOptions } = options;
    const pool = new PiAttemptProcessSupervisor({ deferActivationUntilAuthorityCommit: true });
    const handle = await pool.launch(spec, launchOptions);
    expect(handle.session.status).toBe("created");
    let settled = false;
    void handle.outcome.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);

    await handle.session.activate();
    await expect(handle.outcome).resolves.toMatchObject({
      status: "completed",
      terminalOutput: { result: "activated" },
    });
    await pool.dispose();
  });

  it("tombstones a run before killing every pending process", async () => {
    const { spec, options } = await fixture("stuck");
    const { mode: _mode, ...launchOptions } = options;
    const pool = new PiAttemptProcessSupervisor({ deferActivationUntilAuthorityCommit: false });
    const launch = pool.launch(spec, launchOptions);
    await pool.deleteRun(spec.identity.runId);
    await expect(launch).rejects.toMatchObject({ code: "run_deleted" });
    expect(() => pool.launch(spec, launchOptions)).toThrowError(/deleted/);
    expect(pool.list(spec.identity.runId)).toEqual([]);
  });

  it("run deletion cannot leave any concurrently active attempt process alive", async () => {
    const first = await fixture("stuck", {}, { attemptId: "attempt-a", sessionId: "session-a" });
    const second = await fixture("stuck", {}, { attemptId: "attempt-b", sessionId: "session-b" });
    const { mode: _firstMode, ...firstOptions } = first.options;
    const { mode: _secondMode, ...secondOptions } = second.options;
    const pool = new PiAttemptProcessSupervisor({ deferActivationUntilAuthorityCommit: false });
    const [firstHandle, secondHandle] = await Promise.all([
      pool.launch(first.spec, firstOptions),
      pool.launch(second.spec, secondOptions),
    ]);
    await pool.deleteRun(first.spec.identity.runId);
    await expect(Promise.all([firstHandle.outcome, secondHandle.outcome])).resolves.toEqual([
      expect.objectContaining({ status: "aborted" }),
      expect.objectContaining({ status: "aborted" }),
    ]);
    expect(pool.list(first.spec.identity.runId)).toEqual([]);
  });
});

async function fixture(
  behavior: string,
  overrides: Partial<PiAttemptProcessAuthority> = {},
  identities: { attemptId?: string; sessionId?: string } = {},
): Promise<{
  spec: ReturnType<typeof fixtureLaunchSpec>;
  options: ConstructorParameters<typeof SupervisedPiAttemptProcess>[1];
}> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-attempt-process-"));
  roots.push(root);
  const sessions = path.join(root, "sessions");
  await mkdir(sessions);
  const spec = fixtureLaunchSpec({ cwd: root, sessionDirectory: sessions, ...identities });
  const authority: PiAttemptProcessAuthority = {
    invokeTool: overrides.invokeTool ?? (async () => ({
      protocol: KONI_TOOL_RECEIPT_PROTOCOL,
      receiptId: "receipt",
      outcome: "accepted",
      summary: "accepted",
    })),
    rejectTool: overrides.rejectTool ?? (async (_call, rejection) => ({
      protocol: KONI_TOOL_RECEIPT_PROTOCOL,
      receiptId: "rejection",
      outcome: "rejected",
      code: rejection.code,
      summary: rejection.summary,
    })),
    contextProvider: overrides.contextProvider ?? {
      async loadBoundContext() {
        throw new Error("fixture did not request context");
      },
      async loadCompactionSnapshot() {
        throw new Error("fixture did not request compaction");
      },
      async authorizeCompaction() {
        throw new Error("fixture did not request compaction authorization");
      },
      async acquireRecoveryClaim() {
        throw new Error("fixture did not request recovery");
      },
    },
  };
  return {
    spec,
    options: {
      mode: "fresh",
      terminalOutputSchema: TERMINAL_OUTPUT_SCHEMA,
      authority,
      timings: { launchTimeoutMs: 2_000, abortGraceMs: 50, termGraceMs: 50, killGraceMs: 2_000 },
      runtime: {
        childEntry: fixtureEntry,
        additionalEnvironment: { KONI_TEST_ATTEMPT_BEHAVIOR: behavior },
      },
    },
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!predicate()) throw new Error("condition did not become true");
}
