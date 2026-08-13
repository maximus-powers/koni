import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import { AuthorityClient } from "../src/authority/client.js";
import { discoverAuthorityEndpoint } from "../src/authority/endpoint.js";
import type { AuthorityGrant } from "../src/authority/grants.js";
import {
  authorityRevisionStateHash,
  executionActionBoundaryLifecycleIsCurrent,
  inheritedRepositoryDiscoveryCalls,
  isProviderRateLimitErrorMessage,
  planningRevisionTokenUsage,
  providerRecoveryEpochAttempts,
  providerRateLimitRecoveryDelayMs,
  recoverablePlanningTerminalAuthority,
  RunAuthorityEngine,
  type RunCompilerProgram,
} from "../src/authority/run-engine.js";
import { PiAttemptProcessSupervisor } from "../src/pi/attempt-process-pool.js";
import { createAgentLaunchSpec, type AgentLaunchSpec } from "../src/pi/launch-spec.js";
import { koniToolMaxResultBytes, koniToolSchemaHash } from "../src/pi/tool-catalog.js";
import { canonicalEncode, canonicalHash, rawSha256 } from "../src/shared/canonical.js";
import { reduceRunLifecycle } from "../src/state/run-lifecycle.js";
import type {
  AgentAttemptRecord,
  PlanningRevisionRecord,
  RunRecord,
  TicketRecord,
} from "../src/state/run-record.js";
import { fixtureLaunchSpec, TERMINAL_OUTPUT_SCHEMA } from "./pi-managed-fixtures.js";
import { NativeRunProgramError } from "../src/compiler/run-program.js";
import { runBehaviorSnapshotFixture } from "./fixtures/compiled-behavior.js";

const fixtureEntry = path.join(
  import.meta.dirname,
  "fixtures",
  "run-provider-authority-fixture.mjs",
);
const roots: string[] = [];
const engines: RunAuthorityEngine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("run authority provider reservation lifecycle", () => {
  it("recovers only an exact authority-accepted planning terminal artifact", () => {
    const output = {
      baseRevision: 0,
      operations: [{ op: "replace", path: "/title", value: "Revised" }],
    };
    const encoded = canonicalEncode(output);
    const attempt = {
      authorityToolResults: [
        {
          sequence: 1,
          callId: "planning-terminal",
          toolName: "koni_submit_output",
          outcome: "accepted",
          argumentsSha256: rawSha256(encoded),
          argumentsSizeBytes: Buffer.byteLength(encoded, "utf8"),
          recordedAt: "2026-08-09T00:00:00.000Z",
        },
      ],
    } as AgentAttemptRecord;

    expect(
      recoverablePlanningTerminalAuthority(attempt, "koni_submit_output", output),
    ).toMatchObject({
      callId: "planning-terminal",
      recordedAt: "2026-08-09T00:00:00.000Z",
    });
    expect(
      recoverablePlanningTerminalAuthority(attempt, "koni_submit_output", {
        ...output,
        baseRevision: 1,
      }),
    ).toBeUndefined();
  });

  it("records an exact terminal-schema mismatch as a durable no-effect rejection", async () => {
    const harness = await authorityHarness("invalid_terminal_arguments");
    const runId = await createRun(harness.client);

    await waitFor(async () =>
      Object.values((await harness.engine.store.getRun(runId)).attempts).some((attempt) =>
        attempt.authorityToolResults?.some(
          (result) => result.toolName === "koni_submit_output" && result.outcome === "rejected",
        ),
      ),
    );

    const attempt = onlyAttempt(await harness.engine.store.getRun(runId));
    const rejection = attempt.authorityToolResults?.find(
      (result) => result.toolName === "koni_submit_output",
    );
    expect(rejection).toMatchObject({
      callId: "terminal-call",
      outcome: "rejected",
      argumentsSha256: rawSha256(canonicalEncode({ result: "provider-plan" })),
    });
    const receipt = JSON.parse(
      await readFile(path.join(harness.root, ".git", "koni", rejection!.artifactPath), "utf8"),
    );
    expect(receipt).toMatchObject({
      protocol: "koni.tool-receipt.v1",
      outcome: "rejected",
      code: "tool_arguments",
    });
  }, 60_000);

  it("records a planning compiler diagnostic as a durable no-effect rejection", async () => {
    const harness = await authorityHarness("planning_compiler_rejection");
    const runId = await createRun(harness.client);

    await waitFor(async () =>
      Object.values((await harness.engine.store.getRun(runId)).attempts).some((attempt) =>
        attempt.authorityToolResults?.some(
          (result) => result.toolName === "koni_submit_output" && result.outcome === "rejected",
        ),
      ),
    );

    const attempt = onlyAttempt(await harness.engine.store.getRun(runId));
    const rejection = attempt.authorityToolResults?.find(
      (result) => result.toolName === "koni_submit_output",
    );
    expect(rejection).toMatchObject({
      callId: "terminal-call",
      outcome: "rejected",
      argumentsSha256: rawSha256(canonicalEncode({ result: "provider-plan" })),
    });
    const receipt = JSON.parse(
      await readFile(path.join(harness.root, ".git", "koni", rejection!.artifactPath), "utf8"),
    );
    expect(receipt).toMatchObject({
      protocol: "koni.tool-receipt.v1",
      outcome: "rejected",
      code: "graph_seed_invalid",
    });
    expect(Buffer.byteLength(receipt.summary, "utf8")).toBeLessThanOrEqual(60 * 1024);
    expect(Buffer.byteLength(JSON.stringify(receipt.value), "utf8")).toBeLessThanOrEqual(48 * 1024);
    expect(receipt.summary).toContain("planning graph seed violates its typed schema");
    expect(receipt.summary).toContain("[compiler diagnostic truncated]");
    expect(receipt.value.diagnostics).toEqual([
      expect.stringContaining("unknown proof field"),
      expect.stringContaining("[compiler diagnostic truncated]"),
    ]);
  }, 60_000);

  it("resets only revision token allowance while retaining cumulative usage and discovery", () => {
    const attempt = {
      id: "attempt-plan",
      inputTokens: 80_000,
      outputTokens: 20_000,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 1_000,
      authorityToolResults: [
        {
          sequence: 1,
          toolName: "koni_read_file",
          outcome: "accepted",
        },
      ],
      lineage: { branchEpoch: 0, reason: "initial" },
    } as AgentAttemptRecord;
    const revision = {
      budgetBaseline: {
        inputTokens: 72_000,
        outputTokens: 18_000,
        cacheReadTokens: 4_000,
        cacheWriteTokens: 500,
      },
    } as PlanningRevisionRecord;
    const run = { attempts: { [attempt.id]: attempt } } as RunRecord;

    expect(planningRevisionTokenUsage(attempt, revision)).toEqual({
      inputTokens: 8_000,
      outputTokens: 2_000,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 500,
    });
    expect(attempt.inputTokens + attempt.outputTokens).toBe(100_000);
    expect(inheritedRepositoryDiscoveryCalls(run, attempt)).toBe(1);
  });

  it("classifies canonical 429s and assigns bounded token-bucket backoff", () => {
    expect(
      isProviderRateLimitErrorMessage(
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
      ),
    ).toBe(true);
    expect(isProviderRateLimitErrorMessage("500 Internal server error")).toBe(false);
    expect(isProviderRateLimitErrorMessage("429 unrelated gateway response")).toBe(false);

    expect([0, 1, 2, 3, 4, 12].map(providerRateLimitRecoveryDelayMs)).toEqual([
      60_000, 120_000, 240_000, 480_000, 900_000, 900_000,
    ]);
  });

  it("does not let a failed provider hold reset its own bounded recovery epoch", () => {
    const settledAt = "2026-08-13T00:00:01.000Z";
    const providerHold = (id: string, status: "failed" | "aborted") =>
      ({
        id,
        status,
        error:
          "Provider request remains reserved without a canonical assistant settlement; worst-case exposure is held; provider reported: transient failure",
        authorityProviderRequests: [
          {
            settledAt,
            retirement: { disposition: "operator_acknowledged_provider_error" },
          },
        ],
      }) as unknown as AgentAttemptRecord;
    const completed = {
      id: "completed-boundary",
      status: "completed",
      authorityProviderRequests: [{ settledAt }],
    } as unknown as AgentAttemptRecord;
    const run = {
      attempts: {
        completed,
        failed: providerHold("failed-hold", "failed"),
        aborted: providerHold("aborted-hold", "aborted"),
        current: { id: "current", status: "running" } as AgentAttemptRecord,
      },
    } as unknown as RunRecord;

    expect(providerRecoveryEpochAttempts(run).map((attempt) => attempt.id)).toEqual([
      "failed-hold",
      "aborted-hold",
      "current",
    ]);
  });

  it("keeps admitted execution actions current only through a provider-exposure hold", () => {
    expect(
      executionActionBoundaryLifecycleIsCurrent({ phase: "executing", blocker: undefined }),
    ).toBe(true);
    expect(
      executionActionBoundaryLifecycleIsCurrent({
        phase: "blocked",
        blocker:
          "Provider request remains reserved without a canonical assistant settlement; worst-case exposure is held",
      }),
    ).toBe(true);
    expect(
      executionActionBoundaryLifecycleIsCurrent({
        phase: "blocked",
        blocker: "configured validation needs operator input",
      }),
    ).toBe(false);
    expect(executionActionBoundaryLifecycleIsCurrent({ phase: "paused", blocker: undefined })).toBe(
      false,
    );
  });

  it("auto-clears a stale provider hold after its terminal settlement arrives", async () => {
    const harness = await authorityHarness("normal");
    const runId = await createRun(harness.client);
    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      return (
        run.lifecycle.phase === "awaiting_approval" &&
        onlyAttempt(run).status === "waiting_plan_review"
      );
    });

    await harness.engine.server.mutateInternal(async ({ revision }) => {
      const run = await harness.engine.store.getRun(runId);
      const draft = structuredClone(run);
      draft.revision += 1;
      draft.updatedAt = new Date(Date.parse(run.updatedAt) + 1).toISOString();
      draft.lifecycle = reduceRunLifecycle(draft.lifecycle, {
        type: "blocked",
        atMs: Date.parse(draft.updatedAt),
        reason:
          "A prior provider request remains unsettled; its worst-case exposure blocks a successor attempt",
        remedy: "resume",
      }).state;
      const committed = await harness.engine.store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
      });
      return { revision: committed.state.revision };
    });

    // Startup recovery models the real race: the launch path set its hold before the sibling
    // settlement committed, so the durable attempt is now settled even though the run is blocked.
    await harness.engine.stop();
    harness.client.close();
    const restarted = await RunAuthorityEngine.open({
      projectRoot: harness.root,
      version: "1.0.0",
      program: providerProgram(
        () => {},
        () => {},
        "normal",
      ),
      supervisor: new PiAttemptProcessSupervisor({
        deferActivationUntilAuthorityCommit: true,
        runtime: {
          childEntry: fixtureEntry,
          additionalEnvironment: { KONI_TEST_PROVIDER_SCENARIO: "normal" },
        },
      }),
    });
    engines.push(restarted);
    try {
      await restarted.start();
    } catch (error) {
      const stopped = await restarted.store.getRun(runId);
      throw new Error(
        `restart failed from ${JSON.stringify({ phase: stopped.lifecycle.phase, blocker: stopped.lifecycle.blocker, attempt: onlyAttempt(stopped), session: stopped.planningSession })}`,
        { cause: error },
      );
    }

    await waitFor(async () => {
      const recovered = await restarted.store.getRun(runId);
      return (
        recovered.lifecycle.phase === "awaiting_approval" &&
        recovered.lifecycle.blocker === undefined
      );
    });
  }, 60_000);

  it("crosses once into authenticated synthesis and closes repository discovery", async () => {
    const harness = await authorityHarness("synthesis_threshold");
    const runId = await createRun(harness.client);
    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      if (run.lifecycle.phase === "blocked" || run.lifecycle.phase === "failed") {
        throw new Error(
          `synthesis run stopped: ${run.lifecycle.blocker ?? run.lifecycle.terminalReason}`,
        );
      }
      return (
        run.lifecycle.phase === "awaiting_approval" &&
        onlyAttempt(run).status === "waiting_plan_review"
      );
    });
    const run = await harness.engine.store.getRun(runId);
    const attempt = onlyAttempt(run);
    expect(run.planningSession?.revisions[0]?.planningSynthesis).toMatchObject({
      protocol: "koni.planning-synthesis.v1",
      thresholdNewTokens: 14,
      limitNewTokens: 5_000,
      reserveNewTokens: 4_986,
      instructionSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(attempt.authorityProviderRequests).toHaveLength(1);
    expect(
      run.activity.filter((entry) => entry.message.includes("synthesis is now required")),
    ).toHaveLength(1);
    expect(run.plan?.status).toBe("awaiting_approval");
  }, 60_000);

  it("durably closes planning exploration before rejecting a provider request under input pressure", async () => {
    const harness = await authorityHarness("input_pressure_synthesis");
    const runId = await createRun(harness.client);
    await waitFor(
      async () => (await harness.engine.store.getRun(runId)).lifecycle.phase === "blocked",
    );

    const run = await harness.engine.store.getRun(runId);
    const attempt = onlyAttempt(run);
    expect(run.planningSession?.revisions[0]?.planningSynthesis).toMatchObject({
      protocol: "koni.planning-synthesis.v1",
      triggerReason: "provider_input_pressure",
      triggeredNewTokens: 0,
      thresholdNewTokens: 14,
      limitNewTokens: 5_000,
      reserveNewTokens: 4_986,
      instructionSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(attempt.authorityProviderRequests ?? []).toHaveLength(0);
    expect(
      run.activity.some((entry) =>
        entry.message.includes("Provider input pressure closed planning exploration"),
      ),
    ).toBe(true);
  }, 60_000);

  it("commits exact reserve/settle totals before accepting a normal planner outcome", async () => {
    const harness = await authorityHarness("normal");
    const runId = await createRun(harness.client);

    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      return (
        run.lifecycle.phase === "awaiting_approval" &&
        Object.values(run.attempts)[0]?.status === "waiting_plan_review"
      );
    });
    const run = await harness.engine.store.getRun(runId);
    const attempt = onlyAttempt(run);

    expect(attempt.status).toBe("waiting_plan_review");
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

  it("admits a provider turn through the current revision map while preserving the initial attempt mapping", async () => {
    const harness = await authorityHarness("normal");
    const runId = await createRun(harness.client);
    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      return (
        run.lifecycle.phase === "awaiting_approval" &&
        onlyAttempt(run).status === "waiting_plan_review"
      );
    });
    const before = await harness.engine.store.getRun(runId);
    const attemptId = before.planningSession!.attemptId;
    const sessionId = before.planningSession!.sessionId;
    const initialLaunchHash = before.attempts[attemptId]!.launchSpecHash;

    await harness.client.request(
      "plan.revise",
      { runId, instructions: "Keep the artifact and revise only its provider-bound checkpoint." },
      { expectedRevision: harness.client.revision, idempotencyKey: "provider-planning-revision" },
    );
    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      if (run.lifecycle.phase === "blocked" || run.lifecycle.phase === "failed") {
        throw new Error(
          `revision provider turn stopped: ${run.lifecycle.blocker ?? run.lifecycle.terminalReason}`,
        );
      }
      return (
        run.lifecycle.phase === "awaiting_approval" &&
        run.planningSession?.currentRevision === 1 &&
        onlyAttempt(run).status === "waiting_plan_review"
      );
    });

    const revised = await harness.engine.store.getRun(runId);
    const attempt = onlyAttempt(revised);
    expect(revised.planningSession).toMatchObject({ attemptId, sessionId, currentRevision: 1 });
    expect(attempt.launchSpecHash).toBe(initialLaunchHash);
    expect(attempt.authorityProviderRequests).toHaveLength(2);
    const transcript = (await readFile(attempt.sessionFile!, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      transcript.filter((entry) => entry.customType === "koni.attempt-session-map"),
    ).toHaveLength(1);
    expect(
      transcript.filter((entry) => entry.customType === "koni.planning-revision-map"),
    ).toHaveLength(1);
  }, 60_000);

  it("scopes identical planning-synthesis instructions to their immutable revisions", async () => {
    const harness = await authorityHarness("synthesis_threshold");
    const runId = await createRun(harness.client);
    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      if (run.lifecycle.phase === "blocked" || run.lifecycle.phase === "failed") {
        throw new Error(
          `initial synthesis stopped: ${run.lifecycle.blocker ?? run.lifecycle.terminalReason}`,
        );
      }
      return run.lifecycle.phase === "awaiting_approval";
    });
    const initial = await harness.engine.store.getRun(runId);
    const attemptId = initial.planningSession!.attemptId;
    const sessionId = initial.planningSession!.sessionId;
    const firstSynthesis = initial.planningSession!.revisions[0]!.planningSynthesis!;

    await harness.client.request(
      "plan.revise",
      { runId, instructions: "Preserve the plan and reissue the same bounded synthesis policy." },
      {
        expectedRevision: harness.client.revision,
        idempotencyKey: "revision-scoped-planning-synthesis",
      },
    );
    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      if (run.lifecycle.phase === "blocked" || run.lifecycle.phase === "failed") {
        throw new Error(
          `revision synthesis stopped: ${run.lifecycle.blocker ?? run.lifecycle.terminalReason}`,
        );
      }
      return (
        run.lifecycle.phase === "awaiting_approval" && run.planningSession?.currentRevision === 1
      );
    });

    const revised = await harness.engine.store.getRun(runId);
    const secondSynthesis = revised.planningSession!.revisions[1]!.planningSynthesis!;
    expect(revised.planningSession).toMatchObject({ attemptId, sessionId, currentRevision: 1 });
    expect(secondSynthesis.instructionSha256).toBe(firstSynthesis.instructionSha256);
    expect(secondSynthesis.instructionArtifactPath).not.toBe(
      firstSynthesis.instructionArtifactPath,
    );
    expect(firstSynthesis.instructionArtifactPath).toContain("planning/revisions/0/");
    expect(secondSynthesis.instructionArtifactPath).toContain("planning/revisions/1/");
    await expect(
      harness.engine.store.readArtifact(
        firstSynthesis.instructionArtifactPath,
        firstSynthesis.instructionSizeBytes + 1,
      ),
    ).resolves.toHaveLength(firstSynthesis.instructionSizeBytes);
    await expect(
      harness.engine.store.readArtifact(
        secondSynthesis.instructionArtifactPath,
        secondSynthesis.instructionSizeBytes + 1,
      ),
    ).resolves.toHaveLength(secondSynthesis.instructionSizeBytes);
  }, 60_000);

  it("uses authority-accepted terminal bytes after a lost settlement ACK and still compiles the plan", async () => {
    const harness = await authorityHarness("lost_settlement_ack");
    const runId = await createRun(harness.client);

    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      if (run.lifecycle.phase === "blocked" || run.lifecycle.phase === "failed") {
        const attempt = onlyAttempt(run);
        throw new Error(
          `lost-ack run stopped: ${run.lifecycle.blocker ?? run.lifecycle.terminalReason}; ${JSON.stringify({ status: attempt.status, error: attempt.error, requests: attempt.authorityProviderRequests, session: run.planningSession })}`,
        );
      }
      return (
        run.lifecycle.phase === "awaiting_approval" &&
        Object.values(run.attempts)[0]?.status === "waiting_plan_review"
      );
    });
    const run = await harness.engine.store.getRun(runId);
    const attempt = onlyAttempt(run);

    expect(attempt.status).toBe("waiting_plan_review");
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
      const lifecycleParams =
        operation === "delete" ? await guardedDeleteParams(harness.client, runId) : { runId };
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
      expect(providerTotals(attempt)).toEqual({
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
      });
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
        return (
          attempt.status === "terminal_accepted" &&
          attempt.authorityProviderRequests?.[0]?.settledAt !== undefined
        );
      });
      const beforeStop = await harness.engine.store.getRun(runId);
      const acceptedTerminalHash = onlyAttempt(beforeStop).terminalOutputSha256;

      await harness.client.request("authority.ping");
      const lifecycleParams =
        operation === "delete" ? await guardedDeleteParams(harness.client, runId) : { runId };
      await harness.client.request(`run.${operation}`, lifecycleParams, {
        expectedRevision: harness.client.revision,
        idempotencyKey: `${operation}-terminal-provider-run`,
      });
      await waitFor(async () => {
        const phase = (await harness.engine.store.getRun(runId)).lifecycle.phase;
        return phase === (operation === "pause" ? "paused" : "deleted");
      });

      const stopped = await harness.engine.store.getRun(runId);
      expect(stopped.plan).toEqual(beforeStop.plan);
      expect(harness.compileCount()).toBe(1);
      expect(onlyAttempt(stopped)).toMatchObject({
        status: expect.stringMatching(/terminal_accepted|interrupted/u),
        terminalOutputSha256: acceptedTerminalHash,
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
        return (
          run.lifecycle.phase === "awaiting_approval" &&
          Object.values(run.attempts).some(
            (attempt) => attempt.kind === "planning" && attempt.status === "waiting_plan_review",
          )
        );
      });

      await harness.client.request("authority.ping");
      await harness.client.request(
        "plan.approve",
        { runId },
        {
          expectedRevision: harness.client.revision,
          idempotencyKey: `approve-${scenario}`,
        },
      );
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
            throw new Error(
              `assignment run stopped: ${run.lifecycle.blocker ?? run.lifecycle.terminalReason}`,
            );
          }
          const attempt = Object.values(run.attempts).find(
            (candidate) => candidate.ticketId === "ticket-one",
          );
          return (
            attempt?.status === "terminal_accepted" &&
            attempt.authorityProviderRequests?.[0]?.settledAt !== undefined
          );
        });
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; last state: ${lastObserved}`,
        );
      }
      const beforeStop = await harness.engine.store.getRun(runId);
      const compiledAssignmentHash = canonicalHash({
        tickets: beforeStop.tickets,
        runGit: beforeStop.git.run,
      });
      const acceptedAttemptCount = Object.keys(beforeStop.attempts).length;

      await harness.client.request("authority.ping");
      const lifecycleParams =
        operation === "delete" ? await guardedDeleteParams(harness.client, runId) : { runId };
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
        expect(canonicalHash({ tickets: stopped.tickets, runGit: stopped.git.run })).toBe(
          compiledAssignmentHash,
        );
      }
      expect(harness.compileCount()).toBe(2);
      expect(Object.keys(stopped.attempts)).toHaveLength(acceptedAttemptCount);
      expect(Object.values(stopped.tickets)).toHaveLength(1);
      expect(stopped.tickets["ticket-one"]?.steps[0]?.summary).toBe("Provider assignment compiled");
      expect(stopped.git.promotion).toBeUndefined();
    },
    60_000,
  );

  it("auto-recovers a canonical provider error with an inert tool call and never writes its effects", async () => {
    const harness = await authorityHarness("failed_provider_tool_call");
    const runId = await createRun(harness.client);

    // A transient provider error (e.g. "servers overloaded, try again later") holds a reservation
    // koni cannot settle. koni does zero automatic provider retries, so without auto-recovery the
    // run would wedge needing an operator resume. It must instead retire the held reservation and
    // re-drive the same authenticated planning session on its own — no operator action.
    await waitFor(async () => {
      const recovered = await harness.engine.store.getRun(runId);
      if (
        recovered.lifecycle.phase === "blocked" &&
        !String(recovered.lifecycle.blocker).includes("worst-case exposure")
      ) {
        throw new Error(
          `provider-error recovery stopped: ${recovered.lifecycle.blocker}; ${JSON.stringify({ attempt: onlyAttempt(recovered), session: recovered.planningSession, activity: recovered.activity.slice(-5) })}`,
        );
      }
      return (
        recovered.lifecycle.phase === "awaiting_approval" &&
        Object.keys(recovered.attempts).length === 1 &&
        onlyAttempt(recovered).status === "waiting_plan_review"
      );
    });

    const recovered = await harness.engine.store.getRun(runId);
    expect(recovered.lifecycle.blocker).toBeUndefined();
    const attempts = Object.values(recovered.attempts).sort((left, right) =>
      String(left.startedAt).localeCompare(String(right.startedAt)),
    );
    // The inert terminal tool call from the errored attempt must never have been applied.
    await expect(
      readFile(path.join(recovered.projectRoot, "never-written.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((attempts[0]?.authorityToolResults ?? []).map((result) => result.toolName)).toEqual([
      "koni_submit_output",
    ]);
    expect(attempts[0]?.authorityProviderRequests?.[0]?.retirement).toMatchObject({
      protocol: "koni.provider-exposure-retirement.v1",
      disposition: "operator_acknowledged_provider_error",
      assistantEntryId: "assistant",
      responseId: "resp_fixture_provider_error",
      errorMessageSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      authorizationSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    // Retirement is not a settlement: exposure is retained, not billed.
    expect(providerTotals(attempts[0]!)).toEqual({
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).not.toHaveProperty("terminalOutputSha256");
    expect(attempts[0]).not.toHaveProperty("terminalOutputSizeBytes");
    expect(attempts[0]).not.toHaveProperty("terminalAcceptedAt");
    expect(attempts[0]).not.toHaveProperty("terminalPolicy");
    expect(attempts[0]?.terminalSummary).toBeUndefined();
    expect(attempts[0]?.endedAt).toBeUndefined();
    expect(attempts[0]?.lineage).toMatchObject({ branchEpoch: 0, reason: "initial" });
    expect(attempts[0]?.lineage?.conversationFork).toBeUndefined();
    expect(
      recovered.activity.some(
        (entry) =>
          entry.message.includes("Auto-recovered after a canonical provider error") &&
          entry.message.includes("without an operator retry"),
      ),
    ).toBe(true);
  }, 60_000);

  it("keeps a canonical 429 blocked during its token-bucket backoff", async () => {
    const harness = await authorityHarness("rate_limit_provider_error");
    const runId = await createRun(harness.client);

    await waitFor(
      async () => (await harness.engine.store.getRun(runId)).lifecycle.phase === "blocked",
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const waiting = await harness.engine.store.getRun(runId);
    expect(waiting.lifecycle.phase).toBe("blocked");
    expect(Object.keys(waiting.attempts)).toHaveLength(1);
    expect(
      waiting.attempts[Object.keys(waiting.attempts)[0]!]!.authorityProviderRequests?.[0],
    ).not.toHaveProperty("retirement");
  }, 60_000);

  it("auto-recovers a ticket provider error by resetting the failed assignment", async () => {
    const harness = await authorityHarness("assignment_provider_error");
    const runId = await createRun(harness.client);
    await waitFor(
      async () =>
        (await harness.engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
    );
    await harness.client.request("authority.ping");
    await harness.client.request(
      "plan.approve",
      { runId },
      {
        expectedRevision: harness.client.revision,
        idempotencyKey: "approve-ticket-provider-error",
      },
    );

    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      const ticketAttempts = Object.values(run.attempts).filter(
        (attempt) => attempt.kind === "ticket" && attempt.ticketId === "ticket-one",
      );
      return (
        ticketAttempts.length === 2 &&
        ticketAttempts.some((attempt) => attempt.status === "completed")
      );
    });

    const recovered = await harness.engine.store.getRun(runId);
    expect(recovered.tickets["ticket-one"]?.status).not.toBe("blocked");
    expect(recovered.tickets["ticket-one"]?.steps[0]).toMatchObject({ status: "completed" });
    const attempts = Object.values(recovered.attempts)
      .filter((attempt) => attempt.kind === "ticket" && attempt.ticketId === "ticket-one")
      .sort((left, right) => String(left.startedAt).localeCompare(String(right.startedAt)));
    // The accounting consequence stays the prefix that retry classification matches, and the
    // provider's own reported cause — previously discarded entirely — now follows it.
    expect(attempts[0]).toMatchObject({
      status: "failed",
      error:
        "Provider request remains reserved without a canonical assistant settlement; worst-case exposure is held; provider reported: worker exited with code 23",
    });
    expect(attempts[0]?.authorityProviderRequests?.[0]?.retirement).toMatchObject({
      disposition: "operator_acknowledged_provider_error",
    });
    expect(attempts[1]).toMatchObject({
      status: "completed",
      lineage: {
        branchEpoch: 1,
        reason: "retry",
        parentAttemptId: attempts[0]?.id,
      },
    });
  }, 60_000);

  it("auto-recovers an unreconciled ticket request when the failure retains its provider cause", async () => {
    const harness = await authorityHarness("assignment_unreconciled_request");
    const runId = await createRun(harness.client);
    await waitFor(
      async () =>
        (await harness.engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
    );
    await harness.client.request("authority.ping");
    await harness.client.request(
      "plan.approve",
      { runId },
      {
        expectedRevision: harness.client.revision,
        idempotencyKey: "approve-ticket-unreconciled-request",
      },
    );

    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      const attempts = Object.values(run.attempts).filter(
        (attempt) => attempt.kind === "ticket" && attempt.ticketId === "ticket-one",
      );
      return attempts.length === 2 && attempts.some((attempt) => attempt.status === "completed");
    });

    const recovered = await harness.engine.store.getRun(runId);
    const attempts = Object.values(recovered.attempts)
      .filter((attempt) => attempt.kind === "ticket" && attempt.ticketId === "ticket-one")
      .sort((left, right) => String(left.startedAt).localeCompare(String(right.startedAt)));
    expect(attempts[0]).toMatchObject({
      status: "failed",
      error:
        "Provider request remains reserved without a canonical assistant settlement; worst-case exposure is held; provider reported: worker exited with code 23",
    });
    expect(attempts[0]?.authorityProviderRequests?.[0]?.retirement).toMatchObject({
      disposition: "operator_acknowledged_unreconciled_request",
    });
    expect(recovered.tickets["ticket-one"]?.steps[0]).toMatchObject({ status: "completed" });
  }, 60_000);

  it("fails over an exhausted Sol lead recovery to Terra without an operator retry", async () => {
    const harness = await authorityHarness("lead_sol_fallback");
    const runId = await createRun(harness.client);
    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      return run.lifecycle.phase === "awaiting_approval";
    });

    await harness.client.request("authority.ping");
    await harness.client.request(
      "plan.approve",
      { runId },
      {
        expectedRevision: harness.client.revision,
        idempotencyKey: "approve-lead-sol-fallback",
      },
    );

    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      return Object.values(run.attempts).some(
        (attempt) => attempt.kind === "lead" && attempt.status === "completed",
      );
    }, 60_000);

    const run = await harness.engine.store.getRun(runId);
    const leadAttempts = Object.values(run.attempts)
      .filter((attempt) => attempt.kind === "lead")
      .sort((left, right) => String(left.startedAt).localeCompare(String(right.startedAt)));
    expect(leadAttempts.slice(0, 4).map((attempt) => attempt.modelId)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-sol",
      "gpt-5.6-sol",
      "gpt-5.6-sol",
    ]);
    expect(leadAttempts[4]).toMatchObject({
      modelProvider: "openai-codex",
      modelId: "gpt-5.6-terra",
      status: "completed",
    });
    expect(
      run.activity.some((entry) =>
        entry.message.includes("switched the next lead recovery to gpt-5.6-terra"),
      ),
    ).toBe(true);
  }, 60_000);

  it("keeps the exhausted Sol lead fallback after a failed Terra turn is acknowledged", async () => {
    const harness = await authorityHarness("lead_sol_fallback_resume");
    const runId = await createRun(harness.client);
    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      return run.lifecycle.phase === "awaiting_approval";
    });

    await harness.client.request("authority.ping");
    await harness.client.request(
      "plan.approve",
      { runId },
      {
        expectedRevision: harness.client.revision,
        idempotencyKey: "approve-lead-sol-fallback-resume",
      },
    );

    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      const leadAttempts = Object.values(run.attempts).filter((attempt) => attempt.kind === "lead");
      return (
        run.lifecycle.phase === "blocked" &&
        leadAttempts.length === 5 &&
        leadAttempts.at(-1)?.modelId === "gpt-5.6-terra"
      );
    }, 60_000);

    const blockedControls = (await harness.client.request("run.controls", { runId })).result as {
      binding: { runRevision: number; generation: number };
      runActions: Array<{
        id: string;
        intent: string;
        availability: { state: string };
      }>;
    };
    const acknowledge = blockedControls.runActions.find(
      (action) => action.intent === "retire_provider_exposure",
    )!;
    expect(acknowledge.availability.state).toBe("available");
    await harness.client.request(
      "run.action.execute",
      {
        protocol: "koni.stage-action-invocation.v1",
        runId,
        runRevision: blockedControls.binding.runRevision,
        generation: blockedControls.binding.generation,
        capabilityId: acknowledge.id,
        confirmed: true,
        values: {},
      },
      {
        expectedRevision: harness.client.revision,
        idempotencyKey: "acknowledge-failed-terra-fallback",
      },
    );

    const retryControls = (await harness.client.request("run.controls", { runId })).result as {
      binding: { runRevision: number; generation: number };
      runActions: Array<{
        id: string;
        intent: string;
        availability: { state: string };
      }>;
    };
    const retry = retryControls.runActions.find((action) => action.intent === "retry_blocked")!;
    expect(retry.availability.state).toBe("available");
    await harness.client.request(
      "run.action.execute",
      {
        protocol: "koni.stage-action-invocation.v1",
        runId,
        runRevision: retryControls.binding.runRevision,
        generation: retryControls.binding.generation,
        capabilityId: retry.id,
        confirmed: false,
        values: {},
      },
      {
        expectedRevision: harness.client.revision,
        idempotencyKey: "retry-after-failed-terra-fallback",
      },
    );

    await waitFor(async () => {
      const leadAttempts = Object.values(
        (await harness.engine.store.getRun(runId)).attempts,
      ).filter((attempt) => attempt.kind === "lead");
      return leadAttempts.length >= 6;
    }, 60_000);
    const resumed = await harness.engine.store.getRun(runId);
    const leadAttempts = Object.values(resumed.attempts)
      .filter((attempt) => attempt.kind === "lead")
      .sort((left, right) => String(left.startedAt).localeCompare(String(right.startedAt)));
    expect(leadAttempts.at(-1)?.modelId).toBe("gpt-5.6-terra");
  }, 60_000);

  it("retries terminal propagation and auto-recovers a zero-usage provider error without a response id", async () => {
    // A transient upstream error (observed live: an Anthropic api_error "Internal server error")
    // reports all-zero usage and frequently carries no response id. It is provably unbilled and its
    // content is durably inert, so it has no worst-case exposure to hold. The contained outcome can
    // race its JSONL tail, so the authority must re-probe that bounded propagation window and
    // recover via the assistant-entry-id fallback without an operator resume.
    const harness = await authorityHarness("uncanonical_provider_error");
    const runId = await createRun(harness.client);
    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      return (
        run.lifecycle.phase === "awaiting_approval" &&
        Object.keys(run.attempts).length === 1 &&
        onlyAttempt(run).status === "waiting_plan_review"
      );
    });

    const recovered = await harness.engine.store.getRun(runId);
    const attempts = Object.values(recovered.attempts).sort((left, right) =>
      String(left.startedAt).localeCompare(String(right.startedAt)),
    );
    expect(attempts[0]?.authorityProviderRequests?.[0]?.retirement).toMatchObject({
      protocol: "koni.provider-exposure-retirement.v1",
      disposition: "operator_acknowledged_provider_error",
      responseId: "assistant",
    });
  }, 60_000);

  it("auto-recovers a zero-usage provider error when authority startup finds the held run", async () => {
    const harness = await authorityHarness("uncanonical_provider_error");
    const runId = await createRun(harness.client);
    await waitFor(
      async () => (await harness.engine.store.getRun(runId)).lifecycle.phase === "blocked",
    );

    // The live recovery hook has already declined this held request. Simulate the only remaining
    // path: an authority restart after the canonical zero-usage error was durably recorded.
    await harness.engine.stop();
    harness.client.close();
    const attemptsAtShutdown = Object.keys(
      (await harness.engine.store.getRun(runId)).attempts,
    ).length;
    const restarted = await RunAuthorityEngine.open({
      projectRoot: harness.root,
      version: "1.0.0",
      program: providerProgram(
        () => {},
        () => {},
        "uncanonical_provider_error",
      ),
      supervisor: new PiAttemptProcessSupervisor({
        deferActivationUntilAuthorityCommit: true,
        runtime: {
          childEntry: fixtureEntry,
          additionalEnvironment: { KONI_TEST_PROVIDER_SCENARIO: "uncanonical_provider_error" },
        },
      }),
    });
    engines.push(restarted);
    try {
      await restarted.start();
    } catch (error) {
      const stopped = await restarted.store.getRun(runId);
      throw new Error(
        `provider restart failed from ${JSON.stringify({ phase: stopped.lifecycle.phase, blocker: stopped.lifecycle.blocker, attempt: onlyAttempt(stopped), session: stopped.planningSession })}`,
        { cause: error },
      );
    }

    await waitFor(async () => {
      const run = await restarted.store.getRun(runId);
      return (
        run.lifecycle.phase === "awaiting_approval" &&
        Object.keys(run.attempts).length === attemptsAtShutdown &&
        onlyAttempt(run).status === "waiting_plan_review"
      );
    });
    expect((await restarted.store.getRun(runId)).lifecycle.blocker).toBeUndefined();
  }, 60_000);

  it("auto-recovers a canonical Pi abort without an operator resume and preserves exact usage totals", async () => {
    const harness = await authorityHarness("canonical_abort_recovery");
    const runId = await createRun(harness.client);
    // No operator resume: a canonical Pi abort holds a reservation koni can never settle, so the
    // authority auto-retires it and re-drives planning on its own. The run must reach approval with
    // the same stable attempt entirely autonomously.
    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      return (
        run.lifecycle.phase === "awaiting_approval" &&
        Object.keys(run.attempts).length === 1 &&
        onlyAttempt(run).status === "waiting_plan_review"
      );
    });

    const recovered = await harness.engine.store.getRun(runId);
    expect(recovered.lifecycle.blocker).toBeUndefined();
    const attempts = Object.values(recovered.attempts).sort((left, right) =>
      String(left.startedAt).localeCompare(String(right.startedAt)),
    );
    expect(attempts[0]?.authorityProviderRequests?.[0]?.retirement).toMatchObject({
      protocol: "koni.provider-exposure-retirement.v1",
      disposition: "operator_acknowledged_canonical_abort",
      assistantEntryId: "assistant-aborted",
      responseId: "resp_fixture_canonical_abort",
      authorizationSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    // Retirement is not a settlement: the conservative worst-case exposure is retained, not billed.
    expect(providerTotals(attempts[0]!)).toEqual({
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.lineage).toMatchObject({ branchEpoch: 0, reason: "initial" });
    expect(
      recovered.activity.some(
        (entry) =>
          entry.message.includes("Auto-recovered after a canonical") &&
          entry.message.includes("without an operator retry"),
      ),
    ).toBe(true);
  }, 60_000);

  it("auto-recovers a canonical Pi abort after an earlier assistant entry", async () => {
    // A tool-result race can leave an earlier assistant entry followed by Pi's canonical abort
    // terminal for the same reserved request. The abort still proves the provider did not settle;
    // Koni must retain its worst-case exposure and re-drive without operator intervention.
    const harness = await authorityHarness("canonical_abort_after_prior_assistant");
    const runId = await createRun(harness.client);
    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      return (
        run.lifecycle.phase === "awaiting_approval" &&
        Object.keys(run.attempts).length === 1 &&
        onlyAttempt(run).status === "waiting_plan_review"
      );
    });

    const recovered = await harness.engine.store.getRun(runId);
    const attempts = Object.values(recovered.attempts).sort((left, right) =>
      String(left.startedAt).localeCompare(String(right.startedAt)),
    );
    expect(attempts[0]?.authorityProviderRequests?.[0]?.retirement).toMatchObject({
      protocol: "koni.provider-exposure-retirement.v1",
      disposition: "operator_acknowledged_canonical_abort",
      assistantEntryId: "assistant-aborted",
      responseId: "resp_fixture_canonical_abort",
    });
  }, 60_000);

  it("aborts and re-drives a provider request that exceeds the liveness boundary", async () => {
    const harness = await authorityHarness("provider_liveness_timeout", {
      providerRequestLivenessTimeoutMs: 250,
    });
    const runId = await createRun(harness.client);

    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      if (
        run.lifecycle.phase === "blocked" &&
        run.activity.some((entry) => entry.message.includes("Auto-recovered"))
      ) {
        throw new Error(
          `liveness recovery stopped: ${JSON.stringify({ blocker: run.lifecycle.blocker, attempt: onlyAttempt(run), session: run.planningSession, activity: run.activity.slice(-8) })}`,
        );
      }
      return (
        run.lifecycle.phase === "awaiting_approval" &&
        Object.keys(run.attempts).length === 1 &&
        onlyAttempt(run).status === "waiting_plan_review"
      );
    });

    const recovered = await harness.engine.store.getRun(runId);
    const attempts = Object.values(recovered.attempts).sort((left, right) =>
      String(left.startedAt).localeCompare(String(right.startedAt)),
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("waiting_plan_review");
    expect(attempts[0]?.authorityProviderRequests?.[0]?.retirement).toMatchObject({
      disposition: "operator_acknowledged_canonical_abort",
    });
    expect(
      recovered.activity.some((entry) => entry.message.includes("Provider request exceeded")),
    ).toBe(true);
  }, 60_000);

  it("retires a canonical Pi abort on the first explicit resume from paused", async () => {
    const harness = await authorityHarness("pause_canonical_abort");
    const runId = await createRun(harness.client);
    await waitFor(async () => {
      const attempt = Object.values((await harness.engine.store.getRun(runId)).attempts)[0];
      const request = attempt?.authorityProviderRequests?.[0];
      return request !== undefined && request.settledAt === undefined;
    });

    await harness.client.request(
      "run.pause",
      { runId },
      {
        expectedRevision: harness.client.revision,
        idempotencyKey: "pause-before-canonical-provider-abort",
      },
    );
    await waitFor(
      async () => (await harness.engine.store.getRun(runId)).lifecycle.phase === "paused",
    );

    const paused = await harness.engine.store.getRun(runId);
    const first = onlyAttempt(paused);
    expect(first.authorityProviderRequests?.[0]?.settledAt).toBeUndefined();
    expect(first.authorityProviderRequests?.[0]?.retirement).toBeUndefined();

    await harness.client.request(
      "run.resume",
      { runId },
      {
        expectedRevision: harness.client.revision,
        idempotencyKey: "resume-once-after-paused-canonical-provider-abort",
      },
    );
    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      if (run.lifecycle.phase === "blocked") {
        throw new Error(
          `paused recovery stopped: ${JSON.stringify({ blocker: run.lifecycle.blocker, attempt: onlyAttempt(run), session: run.planningSession, activity: run.activity.slice(-8) })}`,
        );
      }
      return (
        run.lifecycle.phase === "awaiting_approval" &&
        Object.keys(run.attempts).length === 1 &&
        onlyAttempt(run).status === "waiting_plan_review"
      );
    });

    const recovered = await harness.engine.store.getRun(runId);
    const attempts = Object.values(recovered.attempts).sort((left, right) =>
      String(left.startedAt).localeCompare(String(right.startedAt)),
    );
    expect(attempts[0]?.authorityProviderRequests?.[0]?.retirement).toMatchObject({
      protocol: "koni.provider-exposure-retirement.v1",
      disposition: "operator_acknowledged_canonical_abort",
      assistantEntryId: "assistant-aborted",
      responseId: "resp_fixture_canonical_abort",
    });
    expect(recovered.lifecycle.blocker).toBeUndefined();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.lineage).toMatchObject({ branchEpoch: 0, reason: "initial" });
  }, 60_000);

  it("settles a committed assistant before an unterminated following JSONL tail", async () => {
    const harness = await authorityHarness("torn_after_assistant");
    const runId = await createRun(harness.client);
    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      return (
        run.lifecycle.phase === "awaiting_approval" &&
        Object.values(run.attempts)[0]?.status === "waiting_plan_review"
      );
    });
    const attempt = onlyAttempt(await harness.engine.store.getRun(runId));
    expect(attempt.authorityProviderRequests?.[0]?.settledAt).toEqual(expect.any(String));
    expect(providerTotals(attempt)).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1 });
  }, 60_000);

  it("holds a reservation when the assistant entry itself is only a torn tail", async () => {
    const harness = await authorityHarness("partial_assistant");
    const runId = await createRun(harness.client);
    await waitFor(
      async () => (await harness.engine.store.getRun(runId)).lifecycle.phase === "blocked",
    );
    const attempt = onlyAttempt(await harness.engine.store.getRun(runId));
    expect(attempt.status).toBe("failed");
    expect(attempt.authorityProviderRequests?.[0]?.settledAt).toBeUndefined();
  }, 60_000);

  it("settles one bounded response overshoot but denies the next provider request", async () => {
    const harness = await authorityHarness("response_overshoot");
    const runId = await createRun(harness.client);
    await waitFor(
      async () => (await harness.engine.store.getRun(runId)).lifecycle.phase === "blocked",
    );
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
        throw new Error(
          `context-window run stopped: ${run.lifecycle.blocker ?? run.lifecycle.terminalReason}; ${JSON.stringify(
            {
              status: attempt.status,
              error: attempt.error,
              requests: attempt.authorityProviderRequests,
              activity: run.activity.slice(-8),
            },
          )}`,
        );
      }
      return (
        run.lifecycle.phase === "awaiting_approval" &&
        onlyAttempt(run).status === "waiting_plan_review"
      );
    });

    const run = await harness.engine.store.getRun(runId);
    const attempt = onlyAttempt(run);
    expect(attempt.authorityProviderRequests).toHaveLength(2);
    expect(attempt.authorityProviderRequests?.[1]).toMatchObject({
      prospectiveInputTokens: 53_741,
      settledAt: expect.any(String),
    });
    expect(providerTotals(attempt)).toEqual({
      input: 43_248,
      output: 166,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(run.lifecycle.blocker).toBeUndefined();
  }, 60_000);

  it("holds an unsettled terminal predecessor and admits no revision successor", async () => {
    const harness = await authorityHarness("normal");
    const runId = await createRun(harness.client);
    await waitFor(async () => {
      const run = await harness.engine.store.getRun(runId);
      if (run.lifecycle.phase === "blocked" || run.lifecycle.phase === "failed") {
        throw new Error(
          `run stopped before provider checkpoint: ${run.lifecycle.blocker ?? run.lifecycle.terminalReason}`,
        );
      }
      return (
        run.lifecycle.phase === "awaiting_approval" &&
        Object.values(run.attempts)[0]?.status === "waiting_plan_review"
      );
    });

    await harness.engine.server.mutateInternal(async ({ revision }) => {
      const run = await harness.engine.store.getRun(runId);
      const draft = structuredClone(run);
      draft.revision += 1;
      draft.updatedAt = new Date(Date.parse(run.updatedAt) + 1).toISOString();
      const attempt = onlyAttempt(draft);
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
    await harness.client.request(
      "plan.revise",
      {
        runId,
        instructions: "Revise without replaying an ambiguous provider request.",
      },
      {
        expectedRevision: harness.client.revision,
        idempotencyKey: "revise-with-provider-hold",
      },
    );
    await waitFor(
      async () => (await harness.engine.store.getRun(runId)).lifecycle.phase === "blocked",
    );

    const blocked = await harness.engine.store.getRun(runId);
    expect(Object.keys(blocked.attempts)).toHaveLength(1);
    expect(harness.prepareCount()).toBe(1);
    expect(blocked.lifecycle.blocker).toContain("worst-case exposure remains held");
  }, 60_000);
});

async function authorityHarness(
  scenario: string,
  options: { providerRequestLivenessTimeoutMs?: number } = {},
): Promise<{
  root: string;
  engine: RunAuthorityEngine;
  client: AuthorityClient;
  prepareCount(): number;
  compileCount(): number;
}> {
  const root = await repository();
  let prepared = 0;
  let compiled = 0;
  const program = providerProgram(
    () => {
      prepared += 1;
    },
    () => {
      compiled += 1;
    },
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
    ...options,
  });
  engines.push(engine);
  await engine.start();
  const client = await AuthorityClient.connect({
    projectRoot: root,
    client: "tui",
    version: "1.0.0",
  });
  return { root, engine, client, prepareCount: () => prepared, compileCount: () => compiled };
}

function providerProgram(
  onPrepare: () => void,
  onCompile: () => void,
  scenario: string,
): RunCompilerProgram {
  const terminalOutputSchema =
    scenario === "invalid_terminal_arguments"
      ? Type.Object(
          { result: Type.Literal("compiler-approved-plan") },
          { additionalProperties: false },
        )
      : TERMINAL_OUTPUT_SCHEMA;
  const program: RunCompilerProgram = {
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
        pipelineStageIds: [
          "intake",
          "combined-plan",
          "approval",
          "orchestrate",
          "verification",
          "promotion",
        ],
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
          agents: {
            lead: {
              provider: "openai-codex",
              model: scenario.startsWith("lead_sol_fallback") ? "gpt-5.6-sol" : "gpt-5.6-terra",
              thinkingLevel: "high",
            },
            // The lead downgrade is drawn from another model this run already authorized on the
            // lead's provider, so a real run's worker selection is part of the fixture.
            implementer: {
              provider: "openai-codex",
              model: "gpt-5.6-terra",
              thinkingLevel: "high",
            },
          },
        },
      };
    },
    async initializeDirectApproval() {
      throw new Error("direct approval is not used");
    },
    async prepareAttempt(input) {
      onPrepare();
      const ticketId =
        input.kind === "lead"
          ? "run-orchestration"
          : (input.assignment?.ticketId ?? "run-planning");
      const stepId =
        input.kind === "lead"
          ? input.leadTrigger === "compiler_deadlock"
            ? "lead-compiler-deadlock"
            : "lead-orchestration-entry"
          : (input.assignment?.stepId ?? "combined-plan");
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
        allowedTools:
          scenario === "synthesis_threshold"
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
        cwd:
          input.kind === "lead"
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
      if (scenario === "invalid_terminal_arguments") {
        const terminalTool = draft.tools.find((tool) => tool.name === "koni_submit_output")!;
        terminalTool.schemaHash = koniToolSchemaHash("koni_submit_output", terminalOutputSchema);
        draft.terminal.outputSchemaHash = canonicalHash(terminalOutputSchema);
      }
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
      const initialPlanningRevision = input.run.planningSession?.revisions[0];
      if (input.kind === "planning" && initialPlanningRevision !== undefined) {
        draft.planningRevision = {
          revision: 0,
          baseRevision: null,
          priorCheckpointSha256: null,
          steeringSha256: null,
          budgetBaseline: structuredClone(initialPlanningRevision.budgetBaseline),
        };
      }
      if (scenario.startsWith("lead_sol_fallback")) {
        draft.model.id = input.run.executionConfig!.agents.lead!.model;
      }
      const spec = createAgentLaunchSpec(draft) as AgentLaunchSpec;
      return {
        spec,
        authorityGrant: grant,
        toolNames:
          scenario === "synthesis_threshold"
            ? ["koni_read_file", "koni_submit_output"]
            : ["koni_submit_output"],
        terminalOutputSchema,
        contextContent: context,
        compactionSnapshot: {
          objective: input.run.objective,
          plan: {
            architecture: "Pending",
            decisions: "Pending",
            risk: "Pending",
            verification: "Pending",
          },
          graphRefs: [],
          touchedFiles: [],
          receiptIds: [],
          checkIds: [],
          unresolvedQuestions: [],
          nextAction: "Submit the bounded plan",
        },
      };
    },
    async compilePlanningOutput({ run, output }) {
      onCompile();
      expect(output).toEqual({ result: "provider-plan" });
      if (scenario === "planning_compiler_rejection") {
        throw new NativeRunProgramError(
          "graph_seed_invalid",
          "planning graph seed violates its typed schema",
          ["unknown proof field", `oversized field ${"x".repeat(96 * 1024)}`],
        );
      }
      return {
        plan: {
          revision: run.planningSession?.currentRevision ?? 1,
          status: "planning",
          full: {
            architecture: "## Authority-backed plan\nUse the accepted terminal artifact.",
            decisions: "## Decisions\nKeep authority ownership.",
            risk: "## Risk\nHold ambiguous provider exposure.",
            verification: "## Verification\nExercise the process boundary.",
          },
          concise: {
            architecture: [
              { title: "Authority-backed plan", description: "Compile accepted durable bytes." },
            ],
            decisions: [
              { title: "Authority owns effects", description: "The child only projects outcomes." },
            ],
            risk: [
              { title: "Ambiguous exposure", description: "Unsettled requests block successors." },
            ],
            verification: [
              { title: "Process proof", description: "Exercise reserve, settle, and stop." },
            ],
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
        tickets: scenario.startsWith("assignment_") ? { "ticket-one": providerTicket() } : {},
      };
    },
    async compileAssignmentOutput({ output }) {
      onCompile();
      expect(output).toEqual({ result: "provider-plan" });
      return { outcome: { status: "completed" as const, summary: "Provider assignment compiled" } };
    },
    async verifyRun() {
      return { ok: true };
    },
    async createIntegrationTicket() {
      throw new Error("integration is not used");
    },
  };
  program.compilePlanningRevision = async ({ run, attemptId, patch }) => {
    const compiled = await program.compilePlanningOutput({ run, attemptId, output: patch });
    const revision = run.planningSession!.currentRevision;
    return {
      ...compiled,
      artifactWrites: [
        {
          path: `runs/${run.id}/attempts/${attemptId}/planning/revisions/${revision}/artifact.json`,
          bytes: Buffer.from(`${JSON.stringify({ revision, fixture: true })}\n`, "utf8"),
          expectedSha256: null,
        },
      ],
    };
  };
  program.preparePlanningRevision = async (input) => {
    const attempt = input.run.attempts[input.attemptId]!;
    const prepared = await program.prepareAttempt({
      kind: "planning",
      run: input.run,
      attemptId: input.attemptId,
      sessionId: input.sessionId,
      nextAuthorityRevision: input.nextAuthorityRevision,
      expectedAuthorityStateHash: input.expectedAuthorityStateHash,
      lineage: structuredClone(attempt.lineage!),
    });
    const current =
      input.run.planningSession!.revisions[input.run.planningSession!.currentRevision]!;
    const prior =
      input.run.planningSession!.revisions[input.run.planningSession!.currentRevision - 1]!;
    const { specHash: _preparedHash, ...draft } = structuredClone(prepared.spec);
    draft.persona.initialPrompt = input.steering ?? draft.persona.initialPrompt;
    draft.persona.initialPromptHash = rawSha256(draft.persona.initialPrompt);
    draft.planningRevision = {
      revision: current.revision,
      baseRevision: current.revision - 1,
      priorCheckpointSha256: prior.artifactSha256!,
      steeringSha256: current.steering!.instructionsSha256,
      budgetBaseline: structuredClone(current.budgetBaseline),
    };
    return { ...prepared, spec: createAgentLaunchSpec(draft) };
  };
  program.recoverAttempt = async ({ run, attempt, spec }) => {
    if (attempt.kind !== "planning") throw new Error("fixture only recovers planning attempts");
    const recovered = await program.prepareAttempt({
      kind: "planning",
      run,
      attemptId: attempt.id,
      sessionId: attempt.sessionId,
      nextAuthorityRevision: spec.authority.expectedRevision,
      expectedAuthorityStateHash: spec.authority.expectedStateHash,
      lineage: structuredClone(spec.lineage),
    });
    return { ...recovered, spec };
  };
  return program;
}

function providerTicket(): TicketRecord {
  const now = "2026-07-17T00:00:00.000Z";
  return {
    id: "ticket-one",
    operationId: "provider-authority-assignment",
    title: "Exercise assignment authority",
    summary: "Prove terminal assignment effects are compiled once",
    status: "queued",
    priority: 0,
    dependencyIds: [],
    targetNodeIds: ["provider-authority"],
    readPaths: ["."],
    writePaths: [],
    steps: [
      {
        id: "implement",
        title: "Implement",
        personaId: "implementer",
        kind: "production",
        status: "pending",
        attemptIds: [],
        summary: undefined,
        startedAt: undefined,
        completedAt: undefined,
      },
    ],
    worktreePath: undefined,
    branch: undefined,
    blocker: undefined,
    createdAt: now,
    updatedAt: now,
  };
}

async function createRun(client: AuthorityClient): Promise<string> {
  const created = await client.request(
    "run.create",
    {
      objective: "Verify provider authority lifecycle",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Verify provider authority lifecycle" },
    },
    { expectedRevision: client.revision, idempotencyKey: `create-${Date.now()}-${Math.random()}` },
  );
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
  if (typeof preview.previewToken !== "string")
    throw new Error("deletion preview token is missing");
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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(Buffer.concat(stderr).toString("utf8"))),
    );
  });
}
