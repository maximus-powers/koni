import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BoundedJsonLineDecoder,
  PI_ATTEMPT_PROCESS_PROTOCOL,
  PiAttemptProcessProtocolError,
  encodePiAttemptProcessFrame,
  parseChildFrame,
  parseParentFrame,
} from "../src/pi/attempt-process-protocol.js";
import {
  SupervisedPiAttemptProcess,
  type PiAttemptProcessAuthority,
} from "../src/pi/attempt-process-supervisor.js";
import { PiAttemptProcessSupervisor } from "../src/pi/attempt-process-pool.js";
import { TERMINAL_OUTPUT_SCHEMA, fixtureLaunchSpec } from "./pi-managed-fixtures.js";
import { createAgentLaunchSpec } from "../src/pi/launch-spec.js";
import { rawSha256 } from "../src/shared/canonical.js";
import { KONI_TOOL_RECEIPT_PROTOCOL } from "../src/pi/tool-catalog.js";

const fixtureEntry = fileURLToPath(
  new URL("./fixtures/pi-attempt-process-fixture.mjs", import.meta.url),
);
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounded attempt-process protocol", () => {
  it("preserves a bounded authority error code for the contained child", () => {
    const frame = parseParentFrame({
      protocol: PI_ATTEMPT_PROCESS_PROTOCOL,
      attemptId: "attempt-one",
      specHash: `sha256:${"a".repeat(64)}`,
      sequence: 2,
      type: "authority_response",
      requestId: "request-one",
      ok: false,
      error: "request exceeds authenticated context",
      errorCode: "provider_input_exposure",
    });
    expect(frame).toMatchObject({
      type: "authority_response",
      errorCode: "provider_input_exposure",
    });
    expect(() => parseParentFrame({ ...frame, errorCode: "not bounded" })).toThrow(
      PiAttemptProcessProtocolError,
    );
  });

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
    truncated.push(Buffer.from('{"partial":'));
    expect(() => truncated.finish()).toThrow(PiAttemptProcessProtocolError);
    const oversized = new BoundedJsonLineDecoder(4);
    expect(() => oversized.push(Buffer.from("12345"))).toThrowError(/byte bound/);
  });

  it("requires prefixed digests for provider reservation and settlement frames", () => {
    const base = {
      protocol: PI_ATTEMPT_PROCESS_PROTOCOL,
      attemptId: "attempt-one",
      specHash: `sha256:${"a".repeat(64)}`,
      sequence: 1,
      type: "authority_request",
      requestId: "provider-one",
      activationToken: "activation-one",
    } as const;
    const reservation = {
      ...base,
      request: {
        operation: "reserve_provider_request",
        request: {
          sequence: 1,
          api: "openai-codex-responses",
          modelId: "gpt-5.6-terra",
          payloadSha256: `sha256:${"b".repeat(64)}`,
          payloadSizeBytes: 64,
          prospectiveInputTokens: 4_160,
          reservedOutputTokens: 128_000,
        },
      },
    };
    expect(parseChildFrame(reservation)).toEqual(reservation);
    expect(() =>
      parseChildFrame({
        ...reservation,
        request: {
          ...reservation.request,
          request: { ...reservation.request.request, payloadSha256: "b".repeat(64) },
        },
      }),
    ).toThrow(PiAttemptProcessProtocolError);

    const settlement = {
      ...base,
      requestId: "provider-two",
      request: {
        operation: "reconcile_provider_request",
        settlement: {
          sequence: 1,
          reservationId: "provider-one",
          assistantEntryId: "assistant-one",
          assistantEntrySha256: `sha256:${"c".repeat(64)}`,
          usage: {
            input: 10,
            output: 5,
            cacheRead: 2,
            cacheWrite: 1,
            newTokens: 15,
            allTokens: 18,
          },
        },
      },
    };
    expect(parseChildFrame(settlement)).toEqual(settlement);
    expect(() =>
      parseChildFrame({
        ...settlement,
        request: {
          ...settlement.request,
          settlement: { ...settlement.request.settlement, assistantEntrySha256: "c".repeat(64) },
        },
      }),
    ).toThrow(PiAttemptProcessProtocolError);
  });

  it("preserves native Pi provider tool-call identities while rejecting controls", () => {
    const providerCallId =
      "call_uFEFdD6HHZGqXrYjOXrmhs9B|fc_0026f017a57d688a016a5aa2f8f1848198aeb6563c26633a5d";
    const frame = {
      protocol: PI_ATTEMPT_PROCESS_PROTOCOL,
      attemptId: "attempt-one",
      specHash: `sha256:${"a".repeat(64)}`,
      sequence: 1,
      type: "authority_request",
      requestId: "tool-one",
      activationToken: "activation-one",
      request: {
        operation: "invoke_tool",
        callId: providerCallId,
        name: "koni_list_files",
        arguments: { path: ".", recursive: false, limit: 200 },
      },
    } as const;
    expect(parseChildFrame(frame)).toEqual(frame);
    expect(() =>
      parseChildFrame({
        ...frame,
        request: { ...frame.request, callId: `${providerCallId}\nforged` },
      }),
    ).toThrowError(/bounded printable identifier/);
    expect(() =>
      parseChildFrame({
        ...frame,
        request: { ...frame.request, callId: "x".repeat(1_025) },
      }),
    ).toThrowError(/bounded printable identifier/);
  });
});

describe("supervised autonomous Pi attempt process", () => {
  it("contains exactly one self-group destructive call site and no numeric-group destructive call", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../src/pi/attempt-process-supervisor.ts", import.meta.url)),
      "utf8",
    );
    expect(source.match(/process\.kill\(0,\s*"SIGKILL"\)/g) ?? []).toHaveLength(1);
    expect(source).not.toMatch(/process\.kill\(-processGroupId,\s*"SIGKILL"\)/);
  });

  it("forwards ordered lifecycle and cache-inclusive usage, then waits for clean exit", async () => {
    const { spec, options } = await fixture("normal");
    // Production permits a bounded 120-second cold session construction window. Keep the fixture
    // fast while proving that the accepted timing ceiling matches that launch contract.
    const child = new SupervisedPiAttemptProcess(spec, {
      ...options,
      timings: { ...options.timings, launchTimeoutMs: 120_000 },
    });
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
    void child.outcome.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);

    await child.activate();
    await expect(child.outcome).resolves.toEqual({
      status: "completed",
      terminalOutput: { result: "activated" },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
    });
  });

  it("preserves typed runtime failure codes across the contained child boundary", async () => {
    const { spec, options } = await fixture("failed_code");
    const child = new SupervisedPiAttemptProcess(spec, options);
    await child.ready;
    await expect(child.outcome).resolves.toEqual({
      status: "failed",
      code: "provider_admission",
      error: "input budget cannot reserve the prospective provider input",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
    });
  });

  it("reports a planning checkpoint revision without completing the stable attempt", async () => {
    const { spec: initial, options } = await fixture("planning_checkpoint");
    const { specHash: _initialHash, ...draft } = structuredClone(initial);
    const spec = createAgentLaunchSpec({
      ...draft,
      identity: {
        ...draft.identity,
        ticketId: "run-planning",
        stepId: "planning",
      },
      planningRevision: {
        revision: 1,
        baseRevision: 0,
        priorCheckpointSha256: rawSha256("checkpoint-zero"),
        steeringSha256: rawSha256("steering-one"),
        budgetBaseline: {
          inputTokens: 20,
          outputTokens: 10,
          cacheReadTokens: 5,
          cacheWriteTokens: 2,
        },
      },
    });
    const child = new SupervisedPiAttemptProcess(spec, options);

    await child.ready;
    await expect(child.outcome).resolves.toEqual({
      status: "checkpointed",
      revision: 1,
      terminalOutput: { result: "planning-checkpoint" },
      usage: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, newTokens: 5, allTokens: 17 },
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

  it("round-trips durable provider reservation and settlement through parent authority", async () => {
    const { spec, options } = await fixture("provider_authority");
    const provider = options.authority.contextProvider;
    const calls: string[] = [];
    provider.reserveProviderRequest = async (_requested, request) => {
      calls.push(`reserve:${request.sequence}:${request.payloadSha256}`);
      return {
        protocol: "koni.provider-request-reservation.v1",
        sequence: request.sequence,
        reservationId: "provider-one",
        baselineEntryId: "baseline-provider-one",
      };
    };
    provider.reconcileProviderRequest = async (_requested, settlement) => {
      calls.push(`settle:${settlement.sequence}:${settlement.assistantEntrySha256}`);
      return {
        protocol: "koni.provider-request-settlement.v1",
        ...structuredClone(settlement),
      };
    };
    const child = new SupervisedPiAttemptProcess(spec, { ...options, deferActivation: true });
    await child.ready;
    await child.activate();
    await expect(child.outcome).resolves.toMatchObject({
      status: "completed",
      terminalOutput: { result: "provider-authority-ok" },
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, newTokens: 15, allTokens: 18 },
    });
    expect(calls).toEqual([
      `reserve:1:sha256:${"b".repeat(64)}`,
      `settle:1:sha256:${"c".repeat(64)}`,
    ]);
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
        HOME: "/tmp/koni-normal-pi-home",
        PI_CODING_AGENT_DIR: "/tmp/koni-normal-pi-agent",
        NODE_OPTIONS: "--require=/definitely/not/a/koni/module.cjs",
        AWS_MAX_ATTEMPTS: "99",
      },
    };
    const child = new SupervisedPiAttemptProcess(spec, options);
    await child.ready;
    await expect(child.outcome).resolves.toMatchObject({
      status: "completed",
      terminalOutput: {
        result:
          "normal-pi-auth:no-node-options:aws-1:home-/tmp/koni-normal-pi-home:agent-/tmp/koni-normal-pi-agent",
      },
    });
  });

  it("reports a child crash as failure instead of replayable completion", async () => {
    const { spec, options } = await fixture("crash");
    const child = new SupervisedPiAttemptProcess(spec, options);
    await child.ready;
    await expect(child.outcome).resolves.toMatchObject({ status: "failed" });
  });

  it("retires descendants before publishing a normal terminal outcome", async () => {
    const { spec, options } = await fixture("normal_descendant");
    const child = new SupervisedPiAttemptProcess(spec, options);
    let descendantPid: number | undefined;
    child.subscribe(({ event }) => {
      if (event.type === "pi_lifecycle" && event.eventType.startsWith("fixture_descendant:")) {
        descendantPid = Number(event.eventType.split(":")[1]);
      }
    });
    await child.ready;
    await waitUntil(() => descendantPid !== undefined);
    await expect(child.outcome).resolves.toMatchObject({
      status: "completed",
      terminalOutput: { result: "descendant-retired" },
    });
    expect(processExists(descendantPid!)).toBe(false);
  });

  it("retires descendants after the attempt worker crashes", async () => {
    const { spec, options } = await fixture("crash_descendant");
    const child = new SupervisedPiAttemptProcess(spec, options);
    let descendantPid: number | undefined;
    child.subscribe(({ event }) => {
      if (event.type === "pi_lifecycle" && event.eventType.startsWith("fixture_descendant:")) {
        descendantPid = Number(event.eventType.split(":")[1]);
      }
    });
    await child.ready;
    await waitUntil(() => descendantPid !== undefined);
    await expect(child.outcome).resolves.toMatchObject({ status: "failed" });
    expect(processExists(descendantPid!)).toBe(false);
  });

  it("revokes its numeric PGID and never signals that number from the parent", async () => {
    const kill = vi.spyOn(process, "kill");
    const { spec, options } = await fixture("normal");
    const child = new SupervisedPiAttemptProcess(spec, options);
    const processGroupId = child.pid!;
    await child.ready;
    await expect(child.outcome).resolves.toMatchObject({ status: "completed" });
    expect(processGroupId).toBeGreaterThan(0);
    expect(kill).not.toHaveBeenCalled();
    expect(child.pid).toBeUndefined();

    kill.mockClear();
    await child.delete("delete after the old PGID could have been recycled");
    expect(kill).not.toHaveBeenCalled();
  });

  it("automatically re-drives bounded cleanup proof after the coordinator cannot prove absence", async () => {
    const { spec, options } = await fixture("normal_descendant");
    options.runtime = {
      ...options.runtime,
      cleanupOwnerFault: "fail_first_observation",
    };
    const child = new SupervisedPiAttemptProcess(spec, options);
    let descendantPid: number | undefined;
    child.subscribe(({ event }) => {
      if (event.type === "pi_lifecycle" && event.eventType.startsWith("fixture_descendant:")) {
        descendantPid = Number(event.eventType.split(":")[1]);
      }
    });
    await child.ready;
    await waitUntil(() => descendantPid !== undefined);
    await waitUntil(() => !processExists(descendantPid!));
    await expect(child.outcome).resolves.toMatchObject({ status: "completed" });
    expect(child.pid).toBeUndefined();
  });

  it("replays one retained command when the in-group guardian exits before its self-group signal", async () => {
    const { spec, options } = await fixture("normal_descendant");
    options.runtime = { ...options.runtime, cleanupOwnerFault: "exit_before_signal_once" };
    const child = new SupervisedPiAttemptProcess(spec, options);
    let descendantPid: number | undefined;
    child.subscribe(({ event }) => {
      if (event.type === "pi_lifecycle" && event.eventType.startsWith("fixture_descendant:")) {
        descendantPid = Number(event.eventType.split(":")[1]);
      }
    });
    await child.ready;
    await waitUntil(() => descendantPid !== undefined);
    await expect(child.outcome).resolves.toMatchObject({ status: "completed" });
    expect(processExists(descendantPid!)).toBe(false);
    expect(child.pid).toBeUndefined();
  });

  it("fails a ready attempt on pre-signal guardian loss and retires through one replacement", async () => {
    const { spec, options } = await fixture("descendant");
    options.runtime = { ...options.runtime, groupGuardianFault: "exit_before_signal_once" };
    const child = new SupervisedPiAttemptProcess(spec, options);
    let descendantPid: number | undefined;
    child.subscribe(({ event }) => {
      if (event.type === "pi_lifecycle" && event.eventType.startsWith("fixture_descendant:")) {
        descendantPid = Number(event.eventType.split(":")[1]);
      }
    });
    await child.ready;
    await waitUntil(() => descendantPid !== undefined);
    await expect(child.outcome).resolves.toMatchObject({ status: "failed" });
    expect(processExists(descendantPid!)).toBe(false);
    expect(child.pid).toBeUndefined();
  });

  it("retires a stuck descendant after the attempt sentinel exits unexpectedly", async () => {
    const { spec, options } = await fixture("sentinel_crash_descendant");
    const child = new SupervisedPiAttemptProcess(spec, options);
    let descendantPid: number | undefined;
    child.subscribe(({ event }) => {
      if (event.type === "pi_lifecycle" && event.eventType.startsWith("fixture_descendant:")) {
        descendantPid = Number(event.eventType.split(":")[1]);
      }
    });
    await child.ready;
    await waitUntil(() => descendantPid !== undefined);
    await expect(child.outcome).resolves.toMatchObject({ status: "failed" });
    expect(processExists(descendantPid!)).toBe(false);
    expect(child.pid).toBeUndefined();
  });

  it("arms cleanup on authority retirement-channel EOF while the in-group guardian anchors the PGID", async () => {
    const { spec, options } = await fixture("descendant");
    options.runtime = { ...options.runtime, closeRetirementChannelAfterReady: true };
    const child = new SupervisedPiAttemptProcess(spec, options);
    const processGroupId = child.pid!;
    await child.ready;
    await expect(child.outcome).resolves.toMatchObject({ status: "failed" });
    expect(processExists(processGroupId)).toBe(false);
    expect(child.pid).toBeUndefined();
  });

  it("replaces a coordinator that crashes after topology readiness and still proves group absence", async () => {
    const { spec, options } = await fixture("descendant");
    options.runtime = { ...options.runtime, cleanupOwnerFault: "exit_after_ready_once" };
    const child = new SupervisedPiAttemptProcess(spec, options);
    let descendantPid: number | undefined;
    child.subscribe(({ event }) => {
      if (event.type === "pi_lifecycle" && event.eventType.startsWith("fixture_descendant:")) {
        descendantPid = Number(event.eventType.split(":")[1]);
      }
    });
    await child.ready;
    await waitUntil(() => descendantPid !== undefined);
    await expect(child.outcome).resolves.toMatchObject({ status: "failed" });
    expect(processExists(descendantPid!)).toBe(false);
    expect(child.pid).toBeUndefined();
  });

  it("replaces a coordinator after dispatch without issuing a second numeric-group signal", async () => {
    const kill = vi.spyOn(process, "kill");
    const { spec, options } = await fixture("normal_descendant");
    options.runtime = { ...options.runtime, cleanupOwnerFault: "exit_after_dispatch_once" };
    const child = new SupervisedPiAttemptProcess(spec, options);
    let descendantPid: number | undefined;
    child.subscribe(({ event }) => {
      if (event.type === "pi_lifecycle" && event.eventType.startsWith("fixture_descendant:")) {
        descendantPid = Number(event.eventType.split(":")[1]);
      }
    });
    await child.ready;
    await waitUntil(() => descendantPid !== undefined);
    await expect(child.outcome).resolves.toMatchObject({ status: "failed" });
    expect(kill).not.toHaveBeenCalled();
    expect(processExists(descendantPid!)).toBe(false);
    expect(child.pid).toBeUndefined();
  });

  it("withholds outcome until the parent-supervised fallback proves ESRCH after coordinator loss", async () => {
    const { spec, options } = await fixture("normal_descendant");
    options.runtime = {
      ...options.runtime,
      cleanupOwnerFault: "exit_after_absence_once",
      fallbackObservationDelayMs: 100,
    };
    const child = new SupervisedPiAttemptProcess(spec, options);
    let descendantPid: number | undefined;
    child.subscribe(({ event }) => {
      if (event.type === "pi_lifecycle" && event.eventType.startsWith("fixture_descendant:")) {
        descendantPid = Number(event.eventType.split(":")[1]);
      }
    });
    await child.ready;
    await waitUntil(() => descendantPid !== undefined);
    const kill = vi.spyOn(process, "kill");
    let settled = false;
    void child.outcome.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);

    await expect(child.outcome).resolves.toMatchObject({ status: "completed" });
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
    expect(processExists(descendantPid!)).toBe(false);
    expect(child.pid).toBeUndefined();
  });

  it("automatically retries observation when the first fallback observer crashes", async () => {
    const { spec, options } = await fixture("normal_descendant");
    options.runtime = {
      ...options.runtime,
      cleanupOwnerFault: "exit_after_absence_once",
      fallbackObserverFault: "exit_once",
    };
    const child = new SupervisedPiAttemptProcess(spec, options);
    let descendantPid: number | undefined;
    child.subscribe(({ event }) => {
      if (event.type === "pi_lifecycle" && event.eventType.startsWith("fixture_descendant:")) {
        descendantPid = Number(event.eventType.split(":")[1]);
      }
    });
    await child.ready;
    await waitUntil(() => descendantPid !== undefined);
    await expect(child.outcome).resolves.toMatchObject({ status: "completed" });
    expect(processExists(descendantPid!)).toBe(false);
    expect(child.pid).toBeUndefined();
  });

  it("surfaces cleanup failure after bounded observation-only recovery is exhausted", async () => {
    const { spec, options } = await fixture("normal_descendant");
    options.runtime = {
      ...options.runtime,
      cleanupOwnerFault: "exit_after_absence_once",
      fallbackObserverFault: "exit_always",
    };
    const child = new SupervisedPiAttemptProcess(spec, options);
    await child.ready;

    await expect(child.cleanupFailure).resolves.toMatchObject({
      code: "termination_unconfirmed",
    });
    let outcomeSettled = false;
    void child.outcome.then(() => {
      outcomeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(outcomeSettled).toBe(false);
    expect(child.pid).toBeGreaterThan(0);
  });

  it("accepts a proven-absence acknowledgement that arrives after the caller timeout", async () => {
    const { spec, options } = await fixture("normal_descendant");
    options.timings = { ...options.timings, killGraceMs: 25 };
    options.runtime = { ...options.runtime, cleanupOwnerFault: "delay_first_ack" };
    const child = new SupervisedPiAttemptProcess(spec, options);
    await child.ready;
    await expect(child.outcome).resolves.toMatchObject({ status: "completed" });
    expect(child.pid).toBeUndefined();
  });

  it("does not treat EPERM as absence and automatically re-drives a later proof attempt", async () => {
    const { spec, options } = await fixture("normal_descendant");
    options.timings = { ...options.timings, killGraceMs: 25 };
    options.runtime = { ...options.runtime, cleanupOwnerFault: "eperm_first_attempt" };
    const child = new SupervisedPiAttemptProcess(spec, options);
    let descendantPid: number | undefined;
    child.subscribe(({ event }) => {
      if (event.type === "pi_lifecycle" && event.eventType.startsWith("fixture_descendant:")) {
        descendantPid = Number(event.eventType.split(":")[1]);
      }
    });
    await child.ready;
    await waitUntil(() => descendantPid !== undefined);
    await waitUntil(() => !processExists(descendantPid!));
    await expect(child.outcome).resolves.toMatchObject({ status: "completed" });
    expect(child.pid).toBeUndefined();
  });

  it("never sends the worker launch when the initial guardian fails before topology readiness", async () => {
    const { spec, options } = await fixture("descendant");
    options.runtime = { ...options.runtime, groupGuardianFault: "exit_before_ready_once" };
    const child = new SupervisedPiAttemptProcess(spec, options);
    const events: string[] = [];
    child.subscribe(({ event }) => events.push(event.type));

    await expect(child.ready).rejects.toMatchObject({ code: "termination_unconfirmed" });
    await expect(child.outcome).resolves.toMatchObject({ status: "failed" });
    expect(events).toEqual([]);
    expect(child.pid).toBeUndefined();
  });

  it("never sends the worker launch when the initial coordinator exits before readiness", async () => {
    const { spec, options } = await fixture("descendant");
    options.runtime = { ...options.runtime, cleanupOwnerFault: "exit_before_ready_once" };
    const child = new SupervisedPiAttemptProcess(spec, options);
    const events: string[] = [];
    child.subscribe(({ event }) => events.push(event.type));

    await expect(child.ready).rejects.toMatchObject({ code: "termination_unconfirmed" });
    await expect(child.outcome).resolves.toMatchObject({ status: "failed" });
    expect(events).toEqual([]);
    expect(child.pid).toBeUndefined();
  });

  it("denies an effect request before the child is ready", async () => {
    const invokeTool = vi.fn(async () => ({
      protocol: KONI_TOOL_RECEIPT_PROTOCOL,
      receiptId: "must-not-exist",
      outcome: "accepted" as const,
      summary: "must not execute",
    }));
    const { spec, options } = await fixture("authority_before_ready", { invokeTool });
    const child = new SupervisedPiAttemptProcess(spec, { ...options, deferActivation: true });
    await child.ready;
    expect(invokeTool).not.toHaveBeenCalled();
    await child.activate();
    await expect(child.outcome).resolves.toMatchObject({
      status: "completed",
      terminalOutput: { result: "before-ready-denied" },
    });
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("denies effects until commit and admits the first request after activation", async () => {
    const invokeTool = vi.fn(async () => ({
      protocol: KONI_TOOL_RECEIPT_PROTOCOL,
      receiptId: "post-activation",
      outcome: "accepted" as const,
      summary: "executed after activation",
    }));
    const { spec, options } = await fixture("authority_before_activation", { invokeTool });
    const child = new SupervisedPiAttemptProcess(spec, { ...options, deferActivation: true });
    await child.ready;
    expect(invokeTool).not.toHaveBeenCalled();
    await child.activate();
    const outcome = await child.outcome;
    expect(outcome).toEqual({
      status: "completed",
      terminalOutput: { result: "activation-gated" },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
    });
    expect(invokeTool).toHaveBeenCalledOnce();
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "after-activation-call" }),
    );
  });

  it.each(["recover", "planning_revision"] as const)(
    "keeps %s construction read-only and acquires its exact claim only after activation",
    async (mode) => {
      const invokeTool = vi.fn(async () => ({
        protocol: KONI_TOOL_RECEIPT_PROTOCOL,
        receiptId: "arbitrary-recovery-effect",
        outcome: "accepted" as const,
        summary: "must not execute",
      }));
      const { spec, options } = await fixture("recovery_admission", { invokeTool });
      const child = new SupervisedPiAttemptProcess(spec, {
        ...options,
        mode,
        deferActivation: true,
        ...(mode === "planning_revision"
          ? { priorTranscriptSha256: rawSha256("prior planning transcript") }
          : {}),
      });
      await child.ready;
      expect(invokeTool).not.toHaveBeenCalled();
      await child.activate();
      await expect(child.outcome).resolves.toMatchObject({
        status: "completed",
        terminalOutput: { result: "recovery-gated" },
      });
      expect(invokeTool).not.toHaveBeenCalled();
    },
  );

  it("deletion escalates past a stuck child and resolves only after exit", async () => {
    const { spec, options } = await fixture("stuck");
    const child = new SupervisedPiAttemptProcess(spec, options);
    await child.ready;
    const pid = child.pid!;
    await child.delete("run deleted in test");
    await expect(child.outcome).resolves.toMatchObject({
      status: "aborted",
      reason: "run deleted in test",
    });
    expect(processExists(pid)).toBe(false);
    const content = "should fail";
    await expect(
      child.steer({
        sequence: 1,
        mode: "steer",
        content,
        sha256: rawSha256(content),
        sizeBytes: Buffer.byteLength(content),
      }),
    ).rejects.toMatchObject({ code: "run_deleted" });
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
  it("keeps process admission globally closed after bounded authority suspension", async () => {
    const { spec, options } = await fixture("normal");
    const { mode: _mode, ...launchOptions } = options;
    const pool = new PiAttemptProcessSupervisor({ deferActivationUntilAuthorityCommit: false });
    await pool.suspendAll("authority restart");
    pool.resumeRun(spec.identity.runId);
    expect(() => pool.launch(spec, launchOptions)).toThrowError(
      expect.objectContaining({ code: "authority_suspended" }),
    );
    await pool.dispose();
  });

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
    await waitUntil(() => pool.get(spec.identity.attemptId) === undefined);
    expect(pool.list(spec.identity.runId)).toEqual([]);
    await expect(pool.launch(spec, launchOptions)).rejects.toMatchObject({
      code: "attempt_terminal",
    });
    await pool.dispose();
  });

  it("reopens the next continuous planning revision after the prior host checkpoints", async () => {
    const { spec: base, options } = await fixture("planning_checkpoint");
    const { mode: _mode, ...launchOptions } = options;
    const { specHash: _baseHash, ...baseDraft } = structuredClone(base);
    const initial = createAgentLaunchSpec({
      ...baseDraft,
      identity: {
        ...baseDraft.identity,
        ticketId: "run-planning",
        stepId: "combined-plan",
      },
      planningRevision: {
        revision: 0,
        baseRevision: null,
        priorCheckpointSha256: null,
        steeringSha256: null,
        budgetBaseline: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    });
    const pool = new PiAttemptProcessSupervisor({ deferActivationUntilAuthorityCommit: true });

    const first = await pool.launch(initial, launchOptions);
    await first.session.activate();
    await expect(first.outcome).resolves.toMatchObject({ status: "checkpointed", revision: 0 });
    await waitUntil(() => pool.get(initial.identity.attemptId) === undefined);

    const { specHash: _initialHash, ...revisionDraft } = structuredClone(initial);
    const revision = createAgentLaunchSpec({
      ...revisionDraft,
      planningRevision: {
        revision: 1,
        baseRevision: 0,
        priorCheckpointSha256: rawSha256("planning checkpoint zero"),
        steeringSha256: rawSha256("planning steering one"),
        budgetBaseline: {
          inputTokens: 2,
          outputTokens: 3,
          cacheReadTokens: 5,
          cacheWriteTokens: 7,
        },
      },
    });

    const continued = await pool.continuePlanningRevision(revision, {
      ...launchOptions,
      priorTranscriptSha256: rawSha256("planning transcript zero"),
    });
    await continued.session.activate();
    await expect(continued.outcome).resolves.toMatchObject({
      status: "checkpointed",
      revision: 1,
    });
    await pool.dispose();
  });

  it("exposes a created session for durable authority admission before activation", async () => {
    const { spec, options } = await fixture("deferred");
    const { mode: _mode, ...launchOptions } = options;
    const pool = new PiAttemptProcessSupervisor({ deferActivationUntilAuthorityCommit: true });
    const handle = await pool.launch(spec, launchOptions);
    expect(handle.session.status).toBe("created");
    let settled = false;
    void handle.outcome.then(() => {
      settled = true;
    });
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

  it("retains a failed-cleanup process entry and retries deletion without re-signalling the group", async () => {
    const { spec, options } = await fixture("descendant");
    options.runtime = { ...options.runtime, cleanupOwnerFault: "fail_first_observation" };
    const { mode: _mode, ...launchOptions } = options;
    const pool = new PiAttemptProcessSupervisor({ deferActivationUntilAuthorityCommit: false });
    let descendantPid: number | undefined;
    pool.subscribe(({ event }) => {
      if (event.type === "pi_lifecycle" && event.eventType.startsWith("fixture_descendant:")) {
        descendantPid = Number(event.eventType.split(":")[1]);
      }
    });
    const handle = await pool.launch(spec, launchOptions);
    await waitUntil(() => descendantPid !== undefined);

    await expect(pool.deleteRun(spec.identity.runId)).rejects.toMatchObject({
      code: "termination_unconfirmed",
    });
    expect(pool.get(spec.identity.attemptId)).toBe(handle);
    expect(pool.list(spec.identity.runId)).toEqual([handle]);
    let outcomeSettled = false;
    void handle.outcome.then(() => {
      outcomeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(outcomeSettled).toBe(false);
    expect(processExists(descendantPid!)).toBe(false);

    await pool.deleteRun(spec.identity.runId);
    await expect(handle.outcome).resolves.toMatchObject({ status: "failed" });
    await waitUntil(() => pool.get(spec.identity.attemptId) === undefined);
    expect(pool.list(spec.identity.runId)).toEqual([]);
    expect(() => pool.launch(spec, launchOptions)).toThrowError(/deleted/);
  });

  it("retains cleanup ownership when retirement proof fails before admission", async () => {
    const { spec, options } = await fixture("protocol_before_ready");
    options.runtime = { ...options.runtime, cleanupOwnerFault: "fail_first_observation" };
    const { mode: _mode, ...launchOptions } = options;
    const pool = new PiAttemptProcessSupervisor({ deferActivationUntilAuthorityCommit: false });

    await expect(pool.launch(spec, launchOptions)).rejects.toMatchObject({
      code: "event_before_ready",
    });
    // The failed admission is still the same supervised attempt, rather than a new provider-capable
    // process with a reused identity.
    await expect(pool.launch(spec, launchOptions)).rejects.toMatchObject({
      code: "event_before_ready",
    });

    await pool.abortByRun(spec.identity.runId, "retry never-admitted cleanup proof");
    pool.resumeRun(spec.identity.runId);
    await expect(pool.launch(spec, launchOptions)).rejects.toMatchObject({
      code: "attempt_terminal",
    });
    expect(pool.list(spec.identity.runId)).toEqual([]);
    await pool.dispose();
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
    invokeTool:
      overrides.invokeTool ??
      (async () => ({
        protocol: KONI_TOOL_RECEIPT_PROTOCOL,
        receiptId: "receipt",
        outcome: "accepted",
        summary: "accepted",
      })),
    rejectTool:
      overrides.rejectTool ??
      (async (_call, rejection) => ({
        protocol: KONI_TOOL_RECEIPT_PROTOCOL,
        receiptId: "rejection",
        outcome: "rejected",
        code: rejection.code,
        summary: rejection.summary,
      })),
    contextProvider: overrides.contextProvider ?? {
      async loadBoundContext() {
        return {
          ...spec.identity,
          grantId: spec.authority.grantId,
          generation: spec.authority.generation,
          epoch: spec.authority.epoch,
          stateHash: spec.authority.expectedStateHash,
          contextHash: rawSha256("fixture-bound-context"),
          content: "fixture context",
        };
      },
      async loadCompactionSnapshot() {
        throw new Error("fixture did not request compaction");
      },
      async authorizeCompaction() {
        throw new Error("fixture did not request compaction authorization");
      },
      async acquireRecoveryClaim() {
        return {
          protocol: "koni.attempt-recovery-claim.v1" as const,
          claimId: "fixture-recovery-claim",
          state: {
            protocol: "koni.attempt-recovery.v1" as const,
            specHash: spec.specHash,
            ...spec.identity,
            grantHash: spec.authority.grantHash,
            generation: spec.authority.generation,
            epoch: spec.authority.epoch,
            stateHash: spec.authority.expectedStateHash,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
            status: "continue" as const,
            authorizedMessages: [],
            authorizedToolResults: [],
            authorizedCompactions: [],
          },
          async release() {},
        };
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
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  if (!predicate()) throw new Error("condition did not become true");
}
