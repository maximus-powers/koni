import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityClient } from "../src/authority/client.js";
import { discoverAuthorityEndpoint } from "../src/authority/endpoint.js";
import type { AuthorityGrant } from "../src/authority/grants.js";
import {
  authorityRevisionStateHash,
  RunAuthorityEngine,
  type RunCompilerProgram,
} from "../src/authority/run-engine.js";
import { PiAttemptProcessSupervisor } from "../src/pi/attempt-process-pool.js";
import {
  createAgentLaunchSpec,
  type AgentLaunchSpec,
} from "../src/pi/launch-spec.js";
import { koniToolMaxResultBytes, koniToolSchemaHash } from "../src/pi/tool-catalog.js";
import { canonicalHash, rawSha256 } from "../src/shared/canonical.js";
import type { RunRecord, TicketRecord } from "../src/state/run-record.js";
import {
  fixtureLaunchSpec,
  TERMINAL_OUTPUT_SCHEMA,
} from "./pi-managed-fixtures.js";
import { runBehaviorSnapshotFixture } from "./fixtures/compiled-behavior.js";

const fixtureEntry = path.join(import.meta.dirname, "fixtures", "run-provider-authority-fixture.mjs");
const roots: string[] = [];
const engines: RunAuthorityEngine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("run authority provider reservation lifecycle", () => {
  it("crosses once into authenticated synthesis and closes repository discovery", async () => {
    const harness = await authorityHarness("synthesis_threshold");
    const runId = await createRun(harness.client);
    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      if (run.lifecycle.phase === "blocked" || run.lifecycle.phase === "failed") {
        throw new Error(`synthesis run stopped: ${run.lifecycle.blocker ?? run.lifecycle.terminalReason}`);
      }
      return run.lifecycle.phase === "awaiting_approval" && onlyAttempt(run).status === "completed";
    });
    const run = await harness.engine.store.getRun(runId);
    const attempt = onlyAttempt(run);
    expect(attempt.planningSynthesis).toMatchObject({
      protocol: "koni.planning-synthesis.v1",
      thresholdNewTokens: 14,
      limitNewTokens: 5_000,
      reserveNewTokens: 4_986,
      instructionSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(attempt.authorityProviderRequests).toHaveLength(1);
    expect(run.activity.filter((entry) => entry.message.includes("synthesis is now required"))).toHaveLength(1);
    expect(run.plan?.status).toBe("awaiting_approval");
  }, 60_000);

  it("durably closes planning exploration before rejecting a provider request under input pressure", async () => {
    const harness = await authorityHarness("input_pressure_synthesis");
    const runId = await createRun(harness.client);
    await waitFor(async () => (await harness.engine.store.getRun(runId)).lifecycle.phase === "blocked");

    const run = await harness.engine.store.getRun(runId);
    const attempt = onlyAttempt(run);
    expect(attempt.planningSynthesis).toMatchObject({
      protocol: "koni.planning-synthesis.v1",
      triggerReason: "provider_input_pressure",
      triggeredNewTokens: 0,
      thresholdNewTokens: 14,
      limitNewTokens: 5_000,
      reserveNewTokens: 4_986,
      instructionSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(attempt.authorityProviderRequests ?? []).toHaveLength(0);
    expect(run.activity.some((entry) =>
      entry.message.includes("Provider input pressure closed planning exploration")
    )).toBe(true);
  }, 60_000);

  it("commits exact reserve/settle totals before accepting a normal planner outcome", async () => {
    const harness = await authorityHarness("normal");
    const runId = await createRun(harness.client);

    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      return run.lifecycle.phase === "awaiting_approval" &&
        Object.values(run.attempts)[0]?.status === "completed";
    });
    const run = await harness.engine.store.getRun(runId);
    const attempt = onlyAttempt(run);

    expect(attempt.status).toBe("completed");
    expect(attempt.authorityProviderRequests).toHaveLength(1);
    expect(attempt.authorityProviderRequests?.[0]).toMatchObject({
      sequence: 1,
      assistantEntryId: "assistant",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      settledAt: expect.any(String),
    });
    expect(providerTotals(attempt)).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1 });
    expect(run.plan?.status).toBe("awaiting_approval");
    expect(harness.compileCount()).toBe(1);
  }, 60_000);

  it("uses authority-accepted terminal bytes after a lost settlement ACK and still compiles the plan", async () => {
    const harness = await authorityHarness("lost_settlement_ack");
    const runId = await createRun(harness.client);

    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      return run.lifecycle.phase === "awaiting_approval" &&
        Object.values(run.attempts)[0]?.status === "completed";
    });
    const run = await harness.engine.store.getRun(runId);
    const attempt = onlyAttempt(run);

    expect(attempt.status).toBe("completed");
    expect(attempt.authorityProviderRequests?.[0]?.settledAt).toEqual(expect.any(String));
    expect(providerTotals(attempt)).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1 });
    expect(run.plan?.full.architecture).toContain("Authority-backed plan");
    expect(harness.compileCount()).toBe(1);
  }, 60_000);

  it.each(["pause", "delete"] as const)(
    "reconciles a persisted response during final post-stop %s sweep",
    async (operation) => {
      const harness = await authorityHarness(operation);
      const runId = await createRun(harness.client);
      await waitFor(async () => {
        const attempt = Object.values((await harness.engine.store.getRun(runId)).attempts)[0];
        const request = attempt?.authorityProviderRequests?.[0];
        return request !== undefined && request.settledAt === undefined;
      });

      await harness.client.request("authority.ping");
      const lifecycleParams = operation === "delete"
        ? await guardedDeleteParams(harness.client, runId)
        : { runId };
      await harness.client.request(`run.${operation}`, lifecycleParams, {
        expectedRevision: harness.client.revision,
        idempotencyKey: `${operation}-provider-run`,
      });
      await waitFor(async () => {
        const phase = (await harness.engine.store.getRun(runId)).lifecycle.phase;
        return phase === (operation === "pause" ? "paused" : "deleted");
      });

      const stopped = await harness.engine.store.getRun(runId);
      const attempt = onlyAttempt(stopped);
      expect(attempt.authorityProviderRequests?.[0]?.settledAt).toEqual(expect.any(String));
      expect(providerTotals(attempt)).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1 });
      expect(attempt.status).toMatch(/aborted|interrupted/u);
    },
    60_000,
  );

  it.each(["terminal_pause", "terminal_delete"] as const)(
    "preserves the once-compiled planning terminal without replay after %s wins the lifecycle race",
    async (scenario) => {
      const operation = scenario === "terminal_pause" ? "pause" : "delete";
      const harness = await authorityHarness(scenario);
      const runId = await createRun(harness.client);
      await waitFor(async () => {
        const attempt = Object.values((await harness.engine.store.getRun(runId)).attempts)[0];
        if (attempt === undefined) return false;
        return attempt.status === "terminal_accepted" &&
          attempt.authorityProviderRequests?.[0]?.settledAt !== undefined;
      });
      const beforeStop = await harness.engine.store.getRun(runId);
      const compiledPlanHash = canonicalHash(beforeStop.plan);

      await harness.client.request("authority.ping");
      const lifecycleParams = operation === "delete"
        ? await guardedDeleteParams(harness.client, runId)
        : { runId };
      await harness.client.request(`run.${operation}`, lifecycleParams, {
        expectedRevision: harness.client.revision,
        idempotencyKey: `${operation}-terminal-provider-run`,
      });
      await waitFor(async () => {
        const phase = (await harness.engine.store.getRun(runId)).lifecycle.phase;
        return phase === (operation === "pause" ? "paused" : "deleted");
      });

      const stopped = await harness.engine.store.getRun(runId);
      expect(canonicalHash(stopped.plan)).toBe(compiledPlanHash);
      expect(harness.compileCount()).toBe(1);
      expect(onlyAttempt(stopped)).toMatchObject({
        status: expect.stringMatching(/completed|terminal_accepted/u),
        terminalOutputSha256: expect.any(String),
      });
    },
    60_000,
  );

  it.each(["assignment_terminal_pause", "assignment_terminal_delete"] as const)(
    "suppresses assignment publication and follow-on scheduling after %s wins the lifecycle race",
    async (scenario) => {
      const operation = scenario === "assignment_terminal_pause" ? "pause" : "delete";
      const harness = await authorityHarness(scenario);
      const runId = await createRun(harness.client);
      await waitFor(async () => {
        const run = await harness.engine.store.getRun(runId);
        return run.lifecycle.phase === "awaiting_approval" &&
          Object.values(run.attempts).some((attempt) => attempt.kind === "planning" && attempt.status === "completed");
      });

      await harness.client.request("authority.ping");
      await harness.client.request("plan.approve", { runId }, {
        expectedRevision: harness.client.revision,
        idempotencyKey: `approve-${scenario}`,
      });
      let lastObserved = "no state";
      try {
        await waitFor(async () => {
          const run = await harness.engine.store.getRun(runId);
          lastObserved = JSON.stringify({
            phase: run.lifecycle.phase,
            blocker: run.lifecycle.blocker,
            attempts: Object.values(run.attempts).map((attempt) => ({
              kind: attempt.kind,
              ticketId: attempt.ticketId,
              stepId: attempt.stepId,
              status: attempt.status,
              error: attempt.error,
            })),
          });
          if (run.lifecycle.phase === "blocked" || run.lifecycle.phase === "failed") {
            throw new Error(`assignment run stopped: ${run.lifecycle.blocker ?? run.lifecycle.terminalReason}`);
          }
          const attempt = Object.values(run.attempts).find((candidate) => candidate.ticketId === "ticket-one");
          return attempt?.status === "terminal_accepted" &&
            attempt.authorityProviderRequests?.[0]?.settledAt !== undefined;
        });
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; last state: ${lastObserved}`);
      }
      const beforeStop = await harness.engine.store.getRun(runId);
      const compiledAssignmentHash = canonicalHash({
        tickets: beforeStop.tickets,
        runGit: beforeStop.git.run,
      });
      const acceptedAttemptCount = Object.keys(beforeStop.attempts).length;

      await harness.client.request("authority.ping");
      const lifecycleParams = operation === "delete"
        ? await guardedDeleteParams(harness.client, runId)
        : { runId };
      await harness.client.request(`run.${operation}`, lifecycleParams, {
        expectedRevision: harness.client.revision,
        idempotencyKey: `${operation}-${scenario}`,
      });
      await waitFor(async () => {
        const phase = (await harness.engine.store.getRun(runId)).lifecycle.phase;
        return phase === (operation === "pause" ? "paused" : "deleted");
      });

      const stopped = await harness.engine.store.getRun(runId);
      expect(stopped.graphHash).toBe(beforeStop.graphHash);
      expect(stopped.graphRevision).toBe(beforeStop.graphRevision);
      if (operation === "pause") {
        expect(canonicalHash({ tickets: stopped.tickets, runGit: stopped.git.run }))
          .toBe(compiledAssignmentHash);
      }
      expect(harness.compileCount()).toBe(2);
      expect(Object.keys(stopped.attempts)).toHaveLength(acceptedAttemptCount);
      expect(Object.values(stopped.tickets)).toHaveLength(1);
      expect(stopped.tickets["ticket-one"]?.steps[0]?.summary).toBe("Provider assignment compiled");
      expect(stopped.git.promotion).toBeUndefined();
    },
    60_000,
  );

  it("acknowledges a canonical provider error with an inert tool call before a separate retry", async () => {
    const harness = await authorityHarness("failed_provider_tool_call");
    const runId = await createRun(harness.client);

    await waitFor(async () => (await harness.engine.store.getRun(runId)).lifecycle.phase === "blocked");
    const run = await harness.engine.store.getRun(runId);
    const attempt = onlyAttempt(run);
    expect(attempt.status).toBe("failed");
    expect(attempt.endedAt).toEqual(expect.any(String));
    expect(attempt.authorityProviderRequests?.[0]?.settledAt).toBeUndefined();
    expect(providerTotals(attempt)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(run.lifecycle.blocker).toContain("worst-case exposure");

    const controlsResponse = await harness.client.request("run.controls", { runId });
    const controls = controlsResponse.result as {
      binding: { runId: string; runRevision: number; generation: number };
      stages: Array<{ actions: Array<{ intent: string; availability: { state: string } }> }>;
      runActions: Array<{ id: string; intent: string; availability: { state: string } }>;
    };
    const resume = controls.runActions.find((action) => action.intent === "retry_blocked");
    const acknowledge = controls.runActions.find((action) => action.intent === "retire_provider_exposure");
    expect(resume).toMatchObject({ id: "run:resume", availability: { state: "disabled" } });
    expect(acknowledge).toMatchObject({
      id: "run:retire-provider-exposure",
      availability: { state: "available" },
    });
    expect(controls.stages.flatMap((stage) => stage.actions).filter((action) =>
      action.intent === "retry_supervised_stage" && action.availability.state === "available"
    )).toEqual([]);

    await harness.client.request("run.action.execute", {
      protocol: "koni.stage-action-invocation.v1",
      runId,
      runRevision: controls.binding.runRevision,
      generation: controls.binding.generation,
      capabilityId: acknowledge!.id,
      confirmed: true,
      values: {},
    }, {
      expectedRevision: harness.client.revision,
      idempotencyKey: "acknowledge-canonical-provider-error",
    });
    const acknowledged = await harness.engine.store.getRun(runId);
    expect(acknowledged.lifecycle.phase).toBe("blocked");
    expect(Object.keys(acknowledged.attempts)).toHaveLength(1);
    expect(acknowledged.pendingEffects).toEqual({});
    expect(onlyAttempt(acknowledged).authorityToolResults ?? []).toHaveLength(0);
    expect(onlyAttempt(acknowledged).authorityProviderRequests?.[0]?.retirement).toMatchObject({
      protocol: "koni.provider-exposure-retirement.v1",
      disposition: "operator_acknowledged_provider_error",
      assistantEntryId: "assistant",
      responseId: "resp_fixture_provider_error",
      errorMessageSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    await expect(readFile(path.join(acknowledged.projectRoot, "never-written.txt")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const retryControls = (await harness.client.request("run.controls", { runId })).result as typeof controls;
    const retry = retryControls.runActions.find((action) => action.intent === "retry_blocked");
    expect(retry).toMatchObject({ id: "run:resume", availability: { state: "available" } });
    expect(retryControls.runActions.some((action) => action.intent === "retire_provider_exposure")).toBe(false);
    await harness.client.request("run.action.execute", {
      protocol: "koni.stage-action-invocation.v1",
      runId,
      runRevision: retryControls.binding.runRevision,
      generation: retryControls.binding.generation,
      capabilityId: retry!.id,
      confirmed: false,
      values: {},
    }, {
      expectedRevision: harness.client.revision,
      idempotencyKey: "retry-after-canonical-provider-error",
    });
    await waitFor(async () => {
      const recovered = await harness.engine.store.getRun(runId);
      if (recovered.lifecycle.phase === "blocked" && recovered.revision > acknowledged.revision) {
        throw new Error(`provider-error retry blocked: ${recovered.lifecycle.blocker}`);
      }
      return recovered.lifecycle.phase === "awaiting_approval" && Object.keys(recovered.attempts).length === 2;
    });

    const recovered = await harness.engine.store.getRun(runId);
    const attempts = Object.values(recovered.attempts).sort((left, right) =>
      String(left.startedAt).localeCompare(String(right.startedAt))
    );
    expect(attempts[0]?.authorityProviderRequests?.[0]?.retirement).toMatchObject({
      protocol: "koni.provider-exposure-retirement.v1",
      disposition: "operator_acknowledged_provider_error",
      assistantEntryId: "assistant",
      responseId: "resp_fixture_provider_error",
      errorMessageSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      authorizationSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(attempts[1]?.lineage).toMatchObject({
      branchEpoch: 1,
      reason: "retry",
      parentAttemptId: attempts[0]?.id,
      conversationFork: {
        parentLaunchSpecHash: attempts[0]?.launchSpecHash,
        parentTranscriptSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
    });
    expect(recovered.activity.some((entry) =>
      entry.message.includes("canonical provider error") &&
      entry.message.includes("uncertain provider exposure")
    )).toBe(true);
  }, 60_000);

  it("keeps a provider error without an authenticated response id blocked after resume", async () => {
    const harness = await authorityHarness("uncanonical_provider_error");
    const runId = await createRun(harness.client);
    await waitFor(async () => (await harness.engine.store.getRun(runId)).lifecycle.phase === "blocked");
    const before = await harness.engine.store.getRun(runId);

    await harness.client.request("run.resume", { runId }, {
      expectedRevision: harness.client.revision,
      idempotencyKey: "resume-after-uncanonical-provider-error",
    });
    await waitFor(async () => {
      const current = await harness.engine.store.getRun(runId);
      return current.lifecycle.phase === "blocked" && current.revision > before.revision;
    });

    const held = await harness.engine.store.getRun(runId);
    expect(Object.keys(held.attempts)).toHaveLength(1);
    expect(onlyAttempt(held).authorityProviderRequests?.[0]?.retirement).toBeUndefined();
    expect(held.lifecycle.blocker).toContain("worst-case exposure");
  }, 60_000);

  it("retires only a canonical Pi abort under explicit resume and preserves exact usage totals", async () => {
    const harness = await authorityHarness("canonical_abort_recovery");
    const runId = await createRun(harness.client);
    await waitFor(async () => (await harness.engine.store.getRun(runId)).lifecycle.phase === "blocked");

    const blocked = await harness.engine.store.getRun(runId);
    const first = onlyAttempt(blocked);
    expect(first.authorityProviderRequests?.[0]?.settledAt).toBeUndefined();
    expect(first.authorityProviderRequests?.[0]?.retirement).toBeUndefined();
    expect(providerTotals(first)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

    await harness.client.request("run.resume", { runId }, {
      expectedRevision: harness.client.revision,
      idempotencyKey: "resume-after-canonical-provider-abort",
    });
    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      return run.lifecycle.phase === "awaiting_approval" && Object.keys(run.attempts).length === 2;
    });

    const recovered = await harness.engine.store.getRun(runId);
    const attempts = Object.values(recovered.attempts).sort((left, right) =>
      String(left.startedAt).localeCompare(String(right.startedAt))
    );
    expect(attempts[0]?.authorityProviderRequests?.[0]?.retirement).toMatchObject({
      protocol: "koni.provider-exposure-retirement.v1",
      disposition: "operator_acknowledged_canonical_abort",
      assistantEntryId: "assistant-aborted",
      responseId: "resp_fixture_canonical_abort",
      authorizationSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(providerTotals(attempts[0]!)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(attempts[1]?.lineage).toMatchObject({ branchEpoch: 1 });
    expect(recovered.activity.some((entry) =>
      entry.message.includes("retained up to") && entry.message.includes("uncertain provider exposure")
    )).toBe(true);
  }, 60_000);

  it("retires a canonical Pi abort on the first explicit resume from paused", async () => {
    const harness = await authorityHarness("pause_canonical_abort");
    const runId = await createRun(harness.client);
    await waitFor(async () => {
      const attempt = Object.values((await harness.engine.store.getRun(runId)).attempts)[0];
      const request = attempt?.authorityProviderRequests?.[0];
      return request !== undefined && request.settledAt === undefined;
    });

    await harness.client.request("run.pause", { runId }, {
      expectedRevision: harness.client.revision,
      idempotencyKey: "pause-before-canonical-provider-abort",
    });
    await waitFor(async () => (await harness.engine.store.getRun(runId)).lifecycle.phase === "paused");

    const paused = await harness.engine.store.getRun(runId);
    const first = onlyAttempt(paused);
    expect(first.authorityProviderRequests?.[0]?.settledAt).toBeUndefined();
    expect(first.authorityProviderRequests?.[0]?.retirement).toBeUndefined();

    await harness.client.request("run.resume", { runId }, {
      expectedRevision: harness.client.revision,
      idempotencyKey: "resume-once-after-paused-canonical-provider-abort",
    });
    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      return run.lifecycle.phase === "awaiting_approval" && Object.keys(run.attempts).length === 2;
    });

    const recovered = await harness.engine.store.getRun(runId);
    const attempts = Object.values(recovered.attempts).sort((left, right) =>
      String(left.startedAt).localeCompare(String(right.startedAt))
    );
    expect(attempts[0]?.authorityProviderRequests?.[0]?.retirement).toMatchObject({
      protocol: "koni.provider-exposure-retirement.v1",
      disposition: "operator_acknowledged_canonical_abort",
      assistantEntryId: "assistant-aborted",
      responseId: "resp_fixture_canonical_abort",
    });
    expect(recovered.lifecycle.blocker).toBeUndefined();
    expect(attempts[1]?.lineage).toMatchObject({ branchEpoch: 1 });
  }, 60_000);

  it("settles a committed assistant before an unterminated following JSONL tail", async () => {
    const harness = await authorityHarness("torn_after_assistant");
    const runId = await createRun(harness.client);
    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      return run.lifecycle.phase === "awaiting_approval" &&
        Object.values(run.attempts)[0]?.status === "completed";
    });
    const attempt = onlyAttempt(await harness.engine.store.getRun(runId));
    expect(attempt.authorityProviderRequests?.[0]?.settledAt).toEqual(expect.any(String));
    expect(providerTotals(attempt)).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1 });
  }, 60_000);

  it("holds a reservation when the assistant entry itself is only a torn tail", async () => {
    const harness = await authorityHarness("partial_assistant");
    const runId = await createRun(harness.client);
    await waitFor(async () => (await harness.engine.store.getRun(runId)).lifecycle.phase === "blocked");
    const attempt = onlyAttempt(await harness.engine.store.getRun(runId));
    expect(attempt.status).toBe("failed");
    expect(attempt.authorityProviderRequests?.[0]?.settledAt).toBeUndefined();
  }, 60_000);

  it("settles one bounded response overshoot but denies the next provider request", async () => {
    const harness = await authorityHarness("response_overshoot");
    const runId = await createRun(harness.client);
    await waitFor(async () => (await harness.engine.store.getRun(runId)).lifecycle.phase === "blocked");
    const run = await harness.engine.store.getRun(runId);
    const attempt = onlyAttempt(run);
    expect(attempt.authorityProviderRequests).toHaveLength(1);
    expect(attempt.authorityProviderRequests?.[0]?.settledAt).toEqual(expect.any(String));
    expect(providerTotals(attempt)).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1 });
    expect(run.lifecycle.blocker).toContain("next provider request correctly denied");
  }, 60_000);

  it("uses the authenticated model context window for a normal second provider turn", async () => {
    const harness = await authorityHarness("context_window_headroom");
    const runId = await createRun(harness.client);
    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      if (run.lifecycle.phase === "blocked" || run.lifecycle.phase === "failed") {
        const attempt = onlyAttempt(run);
        throw new Error(`context-window run stopped: ${run.lifecycle.blocker ?? run.lifecycle.terminalReason}; ${JSON.stringify({
          status: attempt.status,
          error: attempt.error,
          requests: attempt.authorityProviderRequests,
          activity: run.activity.slice(-8),
        })}`);
      }
      return run.lifecycle.phase === "awaiting_approval" && onlyAttempt(run).status === "completed";
    });

    const run = await harness.engine.store.getRun(runId);
    const attempt = onlyAttempt(run);
    expect(attempt.authorityProviderRequests).toHaveLength(2);
    expect(attempt.authorityProviderRequests?.[1]).toMatchObject({
      prospectiveInputTokens: 53_741,
      settledAt: expect.any(String),
    });
    expect(providerTotals(attempt)).toEqual({ input: 43_248, output: 166, cacheRead: 0, cacheWrite: 0 });
    expect(run.lifecycle.blocker).toBeUndefined();
  }, 60_000);

  it("holds an unsettled terminal predecessor and admits no revision successor", async () => {
    const harness = await authorityHarness("normal");
    const runId = await createRun(harness.client);
    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      return run.lifecycle.phase === "awaiting_approval" &&
        Object.values(run.attempts)[0]?.status === "completed";
    });

    await harness.engine.server.mutateInternal(async ({ revision }) => {
      const run = await harness.engine.store.getRun(runId);
      const draft = structuredClone(run);
      draft.revision += 1;
      draft.updatedAt = new Date(Date.parse(run.updatedAt) + 1).toISOString();
      const attempt = onlyAttempt(draft);
      attempt.status = "terminal_accepted";
      attempt.authorityProviderRequests!.push({
        sequence: 2,
        reservationId: "provider-unsettled-successor-hold",
        api: "openai-codex-responses",
        modelId: "gpt-5.6-terra",
        payloadSha256: rawSha256("unsettled-successor-payload"),
        payloadSizeBytes: 30,
        baselineEntryId: "assistant",
        prospectiveInputTokens: 4_126,
        reservedOutputTokens: 128_000,
        reservedAt: draft.updatedAt,
      });
      const committed = await harness.engine.store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
      });
      return { revision: committed.state.revision };
    });

    await harness.client.request("authority.ping");
    await harness.client.request("plan.revise", {
      runId,
      instructions: "Revise without replaying an ambiguous provider request.",
    }, {
      expectedRevision: harness.client.revision,
      idempotencyKey: "revise-with-provider-hold",
    });
    await waitFor(async () => (await harness.engine.store.getRun(runId)).lifecycle.phase === "blocked");

    const blocked = await harness.engine.store.getRun(runId);
    expect(Object.keys(blocked.attempts)).toHaveLength(1);
    expect(harness.prepareCount()).toBe(1);
    expect(blocked.lifecycle.blocker).toContain("worst-case exposure remains held");
  }, 60_000);
});

async function authorityHarness(scenario: string): Promise<{
  engine: RunAuthorityEngine;
  client: AuthorityClient;
  prepareCount(): number;
  compileCount(): number;
}> {
  const root = await repository();
  let prepared = 0;
  let compiled = 0;
  const program = providerProgram(
    () => { prepared += 1; },
    () => { compiled += 1; },
    scenario,
  );
  const supervisor = new PiAttemptProcessSupervisor({
    deferActivationUntilAuthorityCommit: true,
    runtime: {
      childEntry: fixtureEntry,
      additionalEnvironment: { KONI_TEST_PROVIDER_SCENARIO: scenario },
    },
  });
  const engine = await RunAuthorityEngine.open({
    projectRoot: root,
    version: "1.0.0",
    program,
    supervisor,
  });
  engines.push(engine);
  await engine.start();
  const client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });
  return { engine, client, prepareCount: () => prepared, compileCount: () => compiled };
}

function providerProgram(onPrepare: () => void, onCompile: () => void, scenario: string): RunCompilerProgram {
  return {
    async resolveRun(request) {
      return {
        profile: {
          packageName: "@koni/coding-profile",
          packageVersion: "1.0.0",
          lineage: "koni.software",
          bundleHash: rawSha256("provider-authority-profile"),
        },
        compiledConfigHash: rawSha256("provider-authority-config"),
        runTypeId: request.runTypeId,
        objective: request.objective,
        intake: request.intake,
        behavior: runBehaviorSnapshotFixture(
          request.runTypeId,
          "software",
          scenario === "synthesis_threshold" || scenario === "input_pressure_synthesis"
            ? { planning: { limit: 5_000, synthesisReserve: 4_986 } }
            : {},
        ),
        workingSpecOwnerId: "lead",
        planningMode: "agent",
        pipelineStageIds: ["intake", "combined-plan", "approval", "orchestrate", "verification", "promotion"],
        pipelineStages: [
          { id: "intake", title: "Intake", kind: "action", automatic: true },
          { id: "combined-plan", title: "Combined plan", kind: "planning", automatic: true },
          { id: "approval", title: "Approval", kind: "approval", automatic: false },
          { id: "orchestrate", title: "Orchestrate", kind: "orchestration", automatic: true },
          { id: "verification", title: "Verification", kind: "checkpoint", automatic: true },
          { id: "promotion", title: "Promotion", kind: "promotion", automatic: false },
        ],
        executionConfig: {
          maxParallel: 1,
          questionPolicy: "some",
          instructions: "Produce one bounded plan.",
          agents: { lead: { provider: "openai-codex", model: "gpt-5.6-terra", thinkingLevel: "high" } },
        },
      };
    },
    async initializeDirectApproval() { throw new Error("direct approval is not used"); },
    async prepareAttempt(input) {
      onPrepare();
      const ticketId = input.kind === "lead"
        ? "run-orchestration"
        : input.assignment?.ticketId ?? "run-planning";
      const stepId = input.kind === "lead"
        ? input.leadTrigger === "compiler_deadlock"
          ? "lead-compiler-deadlock"
          : "lead-orchestration-entry"
        : input.assignment?.stepId ?? "combined-plan";
      const context = "Authority-bound provider lifecycle context";
      const stateRoot = (await discoverAuthorityEndpoint(input.run.projectRoot)).stateRoot;
      const grant: AuthorityGrant = {
        protocol: "koni.authority-grant.v1",
        grantId: `grant-${input.attemptId}`,
        runId: input.run.id,
        ticketId,
        stepId,
        attemptId: input.attemptId,
        sessionId: input.sessionId,
        epoch: 1,
        generation: input.run.generation,
        allowedTools: scenario === "synthesis_threshold"
          ? ["koni_read_file", "koni_submit_output"]
          : ["koni_submit_output"],
        readPaths: ["."],
        writePaths: [],
        expectedRevision: input.nextAuthorityRevision,
        expectedStateHash: input.expectedAuthorityStateHash,
      };
      expect(grant.expectedStateHash).toBe(
        authorityRevisionStateHash(input.run.projectRoot, input.nextAuthorityRevision),
      );
      const base = fixtureLaunchSpec({
        cwd: input.kind === "lead"
          ? input.run.projectRoot
          : input.assignment === undefined
            ? input.run.git.planning.worktree
            : input.run.git.ticketCycles[input.run.tickets[ticketId]!.gitCycleId!]!.worktree,
        sessionDirectory: path.join(stateRoot, "runs", input.run.id, "sessions", input.attemptId),
        runId: input.run.id,
        ticketId,
        stepId,
        attemptId: input.attemptId,
        sessionId: input.sessionId,
        lineage: input.lineage,
        maxAllTokens: 300_000,
      });
      const { specHash: _baseHash, ...draft } = structuredClone(base);
      if (scenario === "response_overshoot") draft.budgets.transcript.maxBytes = 1024 * 1024;
      if (scenario === "synthesis_threshold") {
        draft.budgets.tokens = {
          ...draft.budgets.tokens,
          maxInput: 5_000,
          maxOutput: 5_000,
          maxNew: 5_000,
          maxAll: 80_000,
          maxCacheRead: 80_000,
          maxCacheWrite: 80_000,
        };
        (draft.tools as Array<(typeof draft.tools)[number]>).unshift({
          name: "koni_read_file",
          schemaHash: koniToolSchemaHash("koni_read_file", TERMINAL_OUTPUT_SCHEMA),
          executionMode: "parallel",
          maxResultBytes: koniToolMaxResultBytes("koni_read_file"),
        });
      }
      if (scenario === "input_pressure_synthesis") {
        draft.budgets.tokens = {
          ...draft.budgets.tokens,
          maxInput: 4_096,
          maxOutput: 5_000,
          maxNew: 5_000,
          maxAll: 80_000,
          maxCacheRead: 80_000,
          maxCacheWrite: 80_000,
        };
      }
      if (scenario === "context_window_headroom") {
        draft.model.catalogContextWindow = 372_000;
        draft.budgets.tokens = {
          ...draft.budgets.tokens,
          maxInput: 120_000,
          maxOutput: 120_000,
          maxNew: 120_000,
          maxAll: 1_920_000,
          maxCacheRead: 1_920_000,
          maxCacheWrite: 1_920_000,
        };
      }
      draft.issuedAt = new Date().toISOString();
      draft.authority = {
        grantId: grant.grantId,
        grantHash: canonicalHash(grant),
        generation: grant.generation,
        epoch: grant.epoch,
        expectedRevision: grant.expectedRevision,
        expectedStateHash: input.expectedAuthorityStateHash,
        authoritativeContextHash: rawSha256(context),
      };
      draft.persona.id = input.assignment?.personaId ?? "lead";
      const spec = createAgentLaunchSpec(draft) as AgentLaunchSpec;
      return {
        spec,
        authorityGrant: grant,
        toolNames: scenario === "synthesis_threshold"
          ? ["koni_read_file", "koni_submit_output"]
          : ["koni_submit_output"],
        terminalOutputSchema: TERMINAL_OUTPUT_SCHEMA,
        contextContent: context,
        compactionSnapshot: {
          objective: input.run.objective,
          plan: { architecture: "Pending", decisions: "Pending", risk: "Pending", verification: "Pending" },
          graphRefs: [],
          touchedFiles: [],
          receiptIds: [],
          checkIds: [],
          unresolvedQuestions: [],
          nextAction: "Submit the bounded plan",
        },
      };
    },
    async compilePlanningOutput({ output }) {
      onCompile();
      expect(output).toEqual({ result: "provider-plan" });
      return {
        plan: {
          revision: 1,
          status: "planning",
          full: {
            architecture: "## Authority-backed plan\nUse the accepted terminal artifact.",
            decisions: "## Decisions\nKeep authority ownership.",
            risk: "## Risk\nHold ambiguous provider exposure.",
            verification: "## Verification\nExercise the process boundary.",
          },
          concise: {
            architecture: [{ title: "Authority-backed plan", description: "Compile accepted durable bytes." }],
            decisions: [{ title: "Authority owns effects", description: "The child only projects outcomes." }],
            risk: [{ title: "Ambiguous exposure", description: "Unsettled requests block successors." }],
            verification: [{ title: "Process proof", description: "Exercise reserve, settle, and stop." }],
          },
          graphSeed: { objective: "provider lifecycle" },
          steeringHistory: [],
        },
      };
    },
    async compileLeadJudgmentOutput({ output }) {
      expect(output).toEqual({ result: "provider-plan" });
      return {
        protocol: "koni.lead-judgment-output.v1",
        disposition: "proceed",
        summary: "Provider-backed Lead released deterministic orchestration",
      };
    },
    async initializeApprovedPlan() {
      return {
        graphHash: rawSha256("approved-provider-graph"),
        graphRevision: 1,
        tickets: scenario.startsWith("assignment_terminal_")
          ? { "ticket-one": providerTicket() }
          : {},
      };
    },
    async compileAssignmentOutput({ output }) {
      onCompile();
      expect(output).toEqual({ result: "provider-plan" });
      return { outcome: { status: "completed" as const, summary: "Provider assignment compiled" } };
    },
    async verifyRun() { return { ok: true }; },
    async createIntegrationTicket() { throw new Error("integration is not used"); },
  };
}

function providerTicket(): TicketRecord {
  const now = "2026-07-17T00:00:00.000Z";
  return {
    id: "ticket-one",
    operationId: "provider-authority-assignment",
    title: "Exercise assignment authority",
    summary: "Prove terminal assignment effects are compiled once",
    status: "todo",
    priority: 0,
    dependencyIds: [],
    targetNodeIds: ["provider-authority"],
    readPaths: ["."],
    writePaths: [],
    steps: [{
      id: "implement",
      title: "Implement",
      personaId: "implementer",
      kind: "production",
      status: "pending",
      attemptIds: [],
      summary: undefined,
      startedAt: undefined,
      completedAt: undefined,
    }],
    worktreePath: undefined,
    branch: undefined,
    blocker: undefined,
    createdAt: now,
    updatedAt: now,
  };
}

async function createRun(client: AuthorityClient): Promise<string> {
  const created = await client.request("run.create", {
    objective: "Verify provider authority lifecycle",
    runTypeId: "small",
    targetRef: "refs/heads/main",
    intake: { goal: "Verify provider authority lifecycle" },
  }, { expectedRevision: client.revision, idempotencyKey: `create-${Date.now()}-${Math.random()}` });
  return (created.result as { runId: string }).runId;
}

async function guardedDeleteParams(
  client: AuthorityClient,
  runId: string,
): Promise<{
  runId: string;
  mode: "delete_owned_branches";
  previewToken: string;
}> {
  const inspected = await client.request("run.deletion.inspect", { runId });
  const preview = inspected.result as {
    protocol?: unknown;
    runId?: unknown;
    canDeleteOwnedBranches?: unknown;
    previewToken?: unknown;
  };
  expect(preview).toMatchObject({
    protocol: "koni.run-deletion-preview.v1",
    runId,
    canDeleteOwnedBranches: true,
  });
  expect(preview.previewToken).toEqual(expect.stringMatching(/^sha256:[a-f0-9]{64}$/u));
  if (typeof preview.previewToken !== "string") throw new Error("deletion preview token is missing");
  return {
    runId,
    mode: "delete_owned_branches",
    previewToken: preview.previewToken,
  };
}

function onlyAttempt(run: RunRecord) {
  const attempts = Object.values(run.attempts);
  expect(attempts).toHaveLength(1);
  return attempts[0]!;
}

function providerTotals(attempt: ReturnType<typeof onlyAttempt>) {
  return {
    input: attempt.inputTokens,
    output: attempt.outputTokens,
    cacheRead: attempt.cacheReadTokens,
    cacheWrite: attempt.cacheWriteTokens,
  };
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for provider authority state");
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-provider-authority-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "koni@example.invalid");
  await git(root, "config", "user.name", "Koni Test");
  await writeFile(path.join(root, "README.md"), "initial\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "initial");
  return root;
}

function git(cwd: string, ...argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...argv], { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve()
      : reject(new Error(Buffer.concat(stderr).toString("utf8"))));
  });
}
