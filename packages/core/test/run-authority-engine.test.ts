import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type, type TSchema } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorityClient } from "../src/authority/client.js";
import {
  authorityRevisionStateHash,
  acceptedLeadJudgmentForRun,
  completedConfiguredCheckDependencyIds,
  configuredCheckHasNoExternalEffects,
  configuredCheckResultRequiresDependencyReopen,
  configuredResultArtifactPaths,
  inheritedRepositoryDiscoveryCalls,
  isRecoverableAssignmentValidationAction,
  isExactSettledLeadLaunchReplay,
  needsHistoricalPreservedDeletionWorktreeRetirement,
  questionBatchPlanningRevisionIsCurrent,
  retainTicketAuthorityFields,
  reopenCompletedConfiguredCheckDependencies,
  resetRetryableConfiguredCheckInfrastructureAssignments,
  resetRetryableInfrastructureAssignment,
  replacementTicketExecutionEpoch,
  shouldRefreshIntegrationCandidateCycle,
  shouldRearmCancelledTerminalResolver,
  shouldRetireInapplicableTicket,
  shouldDeferBlockedLeadDisposition,
  shouldBypassEntryLeadForExactActiveProposal,
  shouldRefreshUnusedTicketCycle,
  RunAuthorityEngine,
  hasProviderCapableSiblingAttempt,
  hasExactQueuedProposalApproval,
  hasExactActiveProposalApproval,
  terminalProtocolRecoveryCount,
  tokenBudgetRecoveryCount,
  type PreparedManagedAttempt,
  type RuntimeAssignmentTerminalPolicyProjection,
  type RunCompilerProgram,
} from "../src/authority/run-engine.js";
import {
  authorityRequestHash,
  createAuthorityQuiesceOperation,
  createAuthorityStartupEpoch,
  ProjectAuthorityStore,
  type DurableAuthorityQuiesceOperation,
} from "../src/authority/project-store.js";
import {
  createRunActionEffectReceipt,
  prepareRunActionExecution,
} from "../src/authority/action-execution.js";
import {
  resolveExecutionPolicyBinding,
  type ExecutionPolicyBinding,
} from "../src/authority/execution-policy.js";
import type { AuthorityGrant } from "../src/authority/grants.js";
import { ManagedSessionSupervisor } from "../src/pi/supervisor.js";
import type { KoniContextProvider } from "../src/pi/compaction.js";
import type {
  AuthorityBackedTool,
  ManagedPiSessionFactory,
  PiSessionAdapter,
} from "../src/pi/managed-session.js";
import { ManagedSessionError } from "../src/pi/managed-session.js";
import { readAutonomousPiTranscriptPage } from "../src/pi/transcript-page.js";
import {
  AGENT_LAUNCH_SPEC_PROTOCOL,
  computeLaunchResourceSetHash,
  createAgentLaunchSpec,
  type AgentLaunchSpec,
  validateAgentLaunchSpec,
} from "../src/pi/launch-spec.js";
import {
  koniToolMaxResultBytes,
  koniToolSchemaHash,
  type KoniToolName,
} from "../src/pi/tool-catalog.js";
import { canonicalHash, rawSha256, type Sha256Digest } from "../src/shared/canonical.js";
import { MAX_TRANSACTION_BYTES } from "../src/authority/durable-limits.js";
import { newRunLifecycle, reduceRunLifecycle } from "../src/state/run-lifecycle.js";
import { executeActionPlan } from "../src/compiler/action-recipes.js";
import { NativeRunProgramError } from "../src/compiler/run-program.js";
import {
  compileExecutionSemanticCatalog,
  type CompiledExecutionSemanticCatalog,
} from "../src/compiler/execution-semantics.js";
import type {
  CompiledActionCatalog,
  CompiledActionDefinition,
  CompiledRunStage,
} from "../src/contracts/behavior.js";
import type { CompiledConfiguration } from "../src/contracts/configuration.js";
import type {
  CompiledStateMachine,
  CompiledStateMachineCatalog,
  CompiledStateTransition,
  DerivedTicketDefinition,
  DerivedWorkflowStep,
} from "../src/contracts/rules.js";
import { STATE_MACHINE_CATALOG_PROTOCOL } from "../src/contracts/rules.js";
import { parseConfigCatalog, parseConfigSnapshot } from "../src/control-center/protocol.js";
import { installProfile } from "../src/profile/install.js";
import { IsolatedGitLifecycle } from "../src/git/lifecycle.js";
import { createGitRunTemplateContext } from "../src/git/behavior-policy.js";
import type {
  AgentAttemptRecord,
  RunActionExecutionRecord,
  RunBehaviorSnapshot,
  RunRecord,
  RunReportRecord,
  TicketExecutionControlRecord,
  TicketRecord,
} from "../src/state/run-record.js";
import type { QuestionBatchRecord } from "../src/state/question-batch.js";
import {
  assertRunExecutionControlMutation,
  assertRunRecord,
  createCompilerControlTicketAuthority,
  createRunActionSettlement,
  createTerminalSuccessSettlementProof,
  ticketImmutableProjection,
} from "../src/state/run-record.js";
import { deriveChangeControlPublication } from "../src/state/change-control.js";
import { TERMINAL_TOOL_NAME, fixtureLaunchSpec, fixtureTool } from "./pi-managed-fixtures.js";
import { runBehaviorSnapshotFixture } from "./fixtures/compiled-behavior.js";
import { fixtureRunGit } from "./run-record-fixtures.js";

const roots: string[] = [];
const engines: RunAuthorityEngine[] = [];
const codingProfile = path.resolve(import.meta.dirname, "../../coding-profile");

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("run authority engine", () => {
  it("reopens an effect-free failed submission after a typed configured-check infrastructure failure", () => {
    const at = "2026-08-10T00:00:00.000Z";
    const run = configuredCheckInfrastructureRetryFixture(at, {
      infrastructureFailure: "the check runner failed to launch",
    });

    expect(resetRetryableConfiguredCheckInfrastructureAssignments(run, at)).toEqual([
      { ticketId: "ticket-one", ticketTitle: "Prepare proof" },
    ]);
    expect(run.tickets["ticket-one"]).toMatchObject({
      status: "queued",
      blocker: undefined,
      steps: [
        expect.objectContaining({
          id: "author-historical-baseline",
          status: "pending",
          completedAt: undefined,
        }),
      ],
    });
  });

  it("supports the exact compiler-authored legacy infrastructure diagnostic without reopening semantic failures", () => {
    const at = "2026-08-10T00:00:00.000Z";
    const legacy = configuredCheckInfrastructureRetryFixture(at, {
      summary:
        "baseline-proof-set failed its configured result contract: command 0: command infrastructure failed before producing an admissible expected result: the check runner failed to launch",
    });
    const semantic = configuredCheckInfrastructureRetryFixture(at, {
      summary: "baseline-proof-set failed its configured result contract: assertion failed",
    });

    expect(resetRetryableConfiguredCheckInfrastructureAssignments(legacy, at)).toHaveLength(1);
    expect(resetRetryableConfiguredCheckInfrastructureAssignments(semantic, at)).toEqual([]);
    expect(semantic.tickets["ticket-one"]?.status).toBe("blocked");
  });

  it("rejects a delayed planning-question resolution from an earlier revision", () => {
    const run = {
      planningSession: { attemptId: "attempt-plan", currentRevision: 1 },
    } as RunRecord;
    const current = {
      attemptId: "attempt-plan",
      planningRevision: 1,
    } as QuestionBatchRecord;
    const stale = { ...current, planningRevision: 0 };

    expect(questionBatchPlanningRevisionIsCurrent(run, current)).toBe(true);
    expect(questionBatchPlanningRevisionIsCurrent(run, stale)).toBe(false);
    expect(
      questionBatchPlanningRevisionIsCurrent(run, {
        attemptId: "attempt-plan",
      } as QuestionBatchRecord),
    ).toBe(true);
  });

  it("validates contiguous append-only revisions for one stable planning session", () => {
    const run = largeAwaitingApprovalRun("/tmp/koni-continuous-plan", "run-continuous-plan", 16);
    run.lifecycle.planRevision = 1;
    run.attempts["attempt-plan"] = {
      id: "attempt-plan",
      sessionId: "session-plan",
      ticketId: "run-planning",
      stepId: "planning",
      personaId: "planner",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-5",
      thinkingLevel: "high",
      status: "waiting_plan_review",
      launchSpecHash: rawSha256("initial-planning-launch"),
      sessionFile: "runs/run-continuous-plan/sessions/attempt-plan/session-plan.jsonl",
      startedAt: "2026-08-09T00:00:00.000Z",
      endedAt: undefined,
      terminalSummary: undefined,
      inputTokens: 8_000,
      outputTokens: 2_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      kind: "planning",
    };
    const tokenPolicy = {
      metric: "new_tokens" as const,
      limit: 120_000,
      synthesisReserve: 20_000,
      synthesisThreshold: 100_000,
      onExhausted: "force_synthesis" as const,
    };
    run.planningSession = {
      protocol: "koni.planning-session.v1",
      attemptId: "attempt-plan",
      sessionId: "session-plan",
      status: "awaiting_review",
      currentRevision: 1,
      revisions: [
        {
          protocol: "koni.planning-revision.v1",
          revision: 0,
          status: "superseded",
          launchSpecSha256: rawSha256("planning-launch-0"),
          grantSha256: rawSha256("planning-grant-0"),
          budgetBaseline: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          budgetPolicy: tokenPolicy,
          startedAt: "2026-08-09T00:00:00.000Z",
          artifactSha256: rawSha256("planning-artifact-0"),
          graphSha256: rawSha256("planning-graph-0"),
          transcriptSha256: rawSha256("planning-transcript-0"),
          checkpointPath:
            "runs/run-continuous-plan/attempts/attempt-plan/planning/revisions/0/checkpoint.json",
          completedAt: "2026-08-09T00:01:00.000Z",
        },
        {
          protocol: "koni.planning-revision.v1",
          revision: 1,
          status: "awaiting_review",
          launchSpecSha256: rawSha256("planning-launch-1"),
          grantSha256: rawSha256("planning-grant-1"),
          budgetBaseline: {
            inputTokens: 6_000,
            outputTokens: 1_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          budgetPolicy: tokenPolicy,
          startedAt: "2026-08-09T00:02:00.000Z",
          steering: {
            sequence: 1,
            instructionsSha256: rawSha256("planning-steering-1"),
            instructionsSizeBytes: 42,
            artifactPath:
              "runs/run-continuous-plan/attempts/attempt-plan/planning/revisions/1/steering.txt",
            recordedAt: "2026-08-09T00:02:00.000Z",
          },
          patchSha256: rawSha256("planning-patch-1"),
          artifactSha256: rawSha256("planning-artifact-1"),
          graphSha256: rawSha256("planning-graph-1"),
          transcriptSha256: rawSha256("planning-transcript-1"),
          checkpointPath:
            "runs/run-continuous-plan/attempts/attempt-plan/planning/revisions/1/checkpoint.json",
          completedAt: "2026-08-09T00:03:00.000Z",
        },
      ],
    };

    expect(() => assertRunRecord(run)).not.toThrow();

    const runningNextRevision = structuredClone(run);
    const runningSession = runningNextRevision.planningSession as unknown as {
      status: string;
      currentRevision: number;
      revisions: Array<Record<string, unknown>>;
    };
    runningSession.status = "running";
    runningSession.currentRevision = 2;
    runningSession.revisions[1]!.status = "superseded";
    runningSession.revisions.push({
      protocol: "koni.planning-revision.v1",
      revision: 2,
      status: "running",
      launchSpecSha256: rawSha256("planning-launch-2"),
      grantSha256: rawSha256("planning-grant-2"),
      budgetBaseline: {
        inputTokens: 8_000,
        outputTokens: 2_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      budgetPolicy: tokenPolicy,
      startedAt: "2026-08-09T00:04:00.000Z",
      steering: {
        sequence: 2,
        instructionsSha256: rawSha256("planning-steering-2"),
        instructionsSizeBytes: 24,
        artifactPath:
          "runs/run-continuous-plan/attempts/attempt-plan/planning/revisions/2/steering.txt",
        recordedAt: "2026-08-09T00:04:00.000Z",
      },
    });
    runningNextRevision.attempts["attempt-plan"]!.status = "running";
    expect(runningNextRevision.plan?.revision).toBe(1);
    expect(() => assertRunRecord(runningNextRevision)).not.toThrow();

    const noncontiguous = structuredClone(run);
    (
      noncontiguous.planningSession as { revisions: Array<{ revision: number }> }
    ).revisions[1]!.revision = 2;
    expect(() => assertRunRecord(noncontiguous)).toThrow(/planning revision/u);

    const rewritten = structuredClone(run);
    rewritten.revision += 1;
    (
      rewritten.planningSession as {
        revisions: Array<{ artifactSha256: Sha256Digest }>;
      }
    ).revisions[0]!.artifactSha256 = rawSha256("rewritten-planning-artifact-0");
    expect(() => assertRunExecutionControlMutation(run, rewritten)).toThrow(/planning revision/u);
  });

  it("validates historical multi-attempt planning without synthesizing a session marker", () => {
    const run = largeAwaitingApprovalRun(
      "/tmp/koni-legacy-planning-lineage",
      "run-legacy-planning-lineage",
      32,
    );
    run.lifecycle.planRevision = 2;
    run.plan!.revision = 2;
    for (const revision of [1, 2]) {
      const id = `legacy-planner-${revision}`;
      run.attempts[id] = {
        id,
        sessionId: `legacy-session-${revision}`,
        kind: "planning",
        ticketId: "run-planning",
        stepId: "planning",
        personaId: "planner",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-5",
        thinkingLevel: "high",
        status: "completed",
        launchSpecHash: rawSha256(`legacy launch ${revision}`),
        sessionFile: `runs/run-legacy-planning-lineage/sessions/${id}.jsonl`,
        startedAt: `2026-08-09T00:0${revision}:00.000Z`,
        endedAt: `2026-08-09T00:0${revision}:30.000Z`,
        terminalSummary: `Legacy plan revision ${revision}`,
        inputTokens: revision * 1_000,
        outputTokens: revision * 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        lineage: {
          reason: revision === 1 ? "initial" : "rework",
          branchEpoch: revision - 1,
          ...(revision === 1
            ? {}
            : {
                parentAttemptId: "legacy-planner-1",
                parentSessionId: "legacy-session-1",
                parentEntryId: "legacy-leaf-1",
                conversationFork: {
                  parentLaunchSpecHash: rawSha256("legacy planning launch"),
                  parentTranscriptSha256: rawSha256("legacy planning transcript"),
                },
              }),
        },
      };
    }
    const before = structuredClone(run);

    expect(() => assertRunRecord(run)).not.toThrow();
    expect(run.planningSession).toBeUndefined();
    expect(Object.values(run.attempts).map((attempt) => attempt.sessionId)).toEqual([
      "legacy-session-1",
      "legacy-session-2",
    ]);
    expect(run).toEqual(before);
  });

  it("retires a blocked or freshly reissued ordinary ticket when its compiler predicate disappears", () => {
    const failed = ticket();
    failed.status = "blocked";
    failed.blocker = "The prior assignment failed.";
    failed.steps[0]!.status = "failed";
    failed.steps[0]!.attemptIds = ["attempt-old"];
    failed.gitCycleId = "cycle-old";

    const reissued = structuredClone(failed);
    reissued.status = "queued";
    reissued.executionEpoch = 1;
    reissued.gitCycleId = "cycle-fresh";
    reissued.steps[0]!.status = "pending";

    expect(shouldRetireInapplicableTicket(failed, new Set())).toBe(true);
    expect(shouldRetireInapplicableTicket(failed, new Set(), new Set([failed.id]))).toBe(false);
    expect(shouldRetireInapplicableTicket(reissued, new Set())).toBe(true);
    expect(shouldRetireInapplicableTicket(reissued, new Set([reissued.id]))).toBe(false);

    const preparedOnly = ticket();
    preparedOnly.status = "queued";
    preparedOnly.gitCycleId = "cycle-prepared-only";
    preparedOnly.worktreePath = "/tmp/koni-prepared-only";
    preparedOnly.branch = "koni/tickets/prepared-only";
    expect(preparedOnly.steps.every((step) => step.attemptIds.length === 0)).toBe(true);
    expect(shouldRetireInapplicableTicket(preparedOnly, new Set())).toBe(true);
    expect(shouldRetireInapplicableTicket(preparedOnly, new Set([preparedOnly.id]))).toBe(false);

    const running = structuredClone(reissued);
    running.status = "running";
    running.steps[0]!.status = "running";
    expect(shouldRetireInapplicableTicket(running, new Set())).toBe(false);

    const control = structuredClone(failed);
    control.executionControl = { controlTicketAuthority: {} } as TicketExecutionControlRecord;
    expect(shouldRetireInapplicableTicket(control, new Set())).toBe(false);

    const integration = structuredClone(reissued);
    integration.integrationForTicketId = failed.id;
    expect(shouldRetireInapplicableTicket(integration, new Set())).toBe(false);
  });

  it("recognizes only historical branch-preservation records that still own worktrees", () => {
    const git = fixtureRunGit("/tmp/koni-historical-delete", "run-historical-delete");
    git.planning.status = "preserved";
    git.planning.blocker = "Operator selected branch preservation during deletion";
    const historical = {
      lifecycle: { phase: "deleted" },
      deletion: { mode: "preserve_branches" },
      git,
    } as Pick<RunRecord, "lifecycle" | "deletion" | "legacyGitMigration" | "git">;

    expect(needsHistoricalPreservedDeletionWorktreeRetirement(historical)).toBe(true);
    expect(
      needsHistoricalPreservedDeletionWorktreeRetirement({
        ...historical,
        deletion: { mode: "delete_owned_branches" },
      } as typeof historical),
    ).toBe(false);
    expect(
      needsHistoricalPreservedDeletionWorktreeRetirement({
        ...historical,
        lifecycle: { ...historical.lifecycle, phase: "paused" },
      }),
    ).toBe(false);
    git.planning.blocker = "Operator preserved owned branches after clean worktree retirement";
    expect(needsHistoricalPreservedDeletionWorktreeRetirement(historical)).toBe(false);
  });

  it("does not charge a new review-rework epoch for recovery lineage inherited across its boundary", () => {
    const historicalFailure = {
      id: "attempt-historical-budget-failure",
      ticketId: "ticket-one",
      stepId: "implement",
      status: "aborted",
      error: "input token budget exceeded",
      startedAt: "2026-07-30T13:00:00.000Z",
    } as AgentAttemptRecord;
    const firstReworkAttempt = {
      id: "attempt-first-supervised-rework",
      ticketId: "ticket-one",
      stepId: "implement",
      status: "aborted",
      error: "new-token token budget exceeded",
      startedAt: "2026-07-30T13:02:00.000Z",
      lineage: {
        branchEpoch: 3,
        reason: "recovery",
        parentAttemptId: historicalFailure.id,
        parentSessionId: "session-parent",
      },
    } as AgentAttemptRecord;
    const run = {
      tickets: {
        "ticket-one": {
          id: "ticket-one",
          steps: [
            {
              id: "implement",
              kind: "production",
              dependsOn: [],
            },
            {
              id: "review",
              kind: "review",
              dependsOn: ["implement"],
            },
          ],
          reviewReworks: [
            {
              ordinal: 2,
              mode: "supervised",
              failedReviewAttemptId: "attempt-review",
              reopenFromStepId: "implement",
              blocker: "reviewer blocker",
              openedAt: "2026-07-30T13:01:00.000Z",
            },
          ],
        },
      },
      attempts: {
        [historicalFailure.id]: historicalFailure,
        [firstReworkAttempt.id]: firstReworkAttempt,
      },
      activity: [
        {
          at: "2026-07-30T13:00:30.000Z",
          ticketId: "ticket-one",
          message:
            "Automatically retrying Implement feature step implement after bounded token-budget recovery",
        },
      ],
    } as unknown as RunRecord;

    expect(
      tokenBudgetRecoveryCount(
        run,
        firstReworkAttempt,
        "Automatically retrying Implement feature step implement after bounded token-budget recovery",
      ),
    ).toBe(0);
  });

  it("does not charge a new ticket execution epoch for token recovery spent before an approved reissue", () => {
    const historicalFailure = {
      id: "attempt-historical-budget-failure",
      ticketId: "ticket-one",
      stepId: "implement",
      ticketExecutionEpoch: 0,
      status: "aborted",
      error: "input token budget exceeded",
      startedAt: "2026-08-12T10:10:00.000Z",
    } as AgentAttemptRecord;
    const historicalRecovery = {
      id: "attempt-historical-recovery",
      ticketId: "ticket-one",
      stepId: "implement",
      ticketExecutionEpoch: 0,
      status: "completed",
      startedAt: "2026-08-12T10:11:00.000Z",
      lineage: {
        branchEpoch: 1,
        reason: "recovery",
        parentAttemptId: historicalFailure.id,
        parentSessionId: "session-historical",
      },
    } as AgentAttemptRecord;
    const reissuedFailure = {
      id: "attempt-reissued-budget-failure",
      ticketId: "ticket-one",
      stepId: "implement",
      ticketExecutionEpoch: 1,
      status: "aborted",
      error: "new-token token budget exceeded",
      startedAt: "2026-08-12T10:20:00.000Z",
    } as AgentAttemptRecord;
    const recoveryMessage =
      "Automatically retrying Execute work step implement after bounded token-budget recovery";
    const run = {
      tickets: {
        "ticket-one": {
          id: "ticket-one",
          title: "Execute work",
          executionEpoch: 1,
          steps: [{ id: "implement", kind: "production", dependsOn: [] }],
        },
      },
      attempts: {
        [historicalFailure.id]: historicalFailure,
        [historicalRecovery.id]: historicalRecovery,
        [reissuedFailure.id]: reissuedFailure,
      },
      activity: [
        {
          // A regressed/equal wall clock cannot make this old display marker authoritative for
          // the new execution epoch.
          at: reissuedFailure.startedAt,
          ticketId: "ticket-one",
          message: recoveryMessage,
        },
      ],
    } as unknown as RunRecord;

    expect(tokenBudgetRecoveryCount(run, reissuedFailure, recoveryMessage)).toBe(0);
  });

  it("does not let a stale token-recovery callback reset a newer failed execution epoch", () => {
    const oldFailure = {
      id: "attempt-old-budget-failure",
      ticketId: "ticket-one",
      stepId: "implement",
      ticketExecutionEpoch: 0,
      status: "aborted",
      error: "input token budget exceeded",
    } as AgentAttemptRecord;
    const currentFailure = {
      id: "attempt-current-budget-failure",
      ticketId: "ticket-one",
      stepId: "implement",
      ticketExecutionEpoch: 1,
      status: "aborted",
      error: "new-token token budget exceeded",
    } as AgentAttemptRecord;
    const ticket = {
      id: "ticket-one",
      title: "Execute work",
      status: "blocked",
      blocker: currentFailure.error,
      executionEpoch: 1,
      steps: [
        {
          id: "implement",
          kind: "production",
          status: "failed",
          attemptIds: [oldFailure.id, currentFailure.id],
        },
      ],
    } as unknown as TicketRecord;
    const run = {
      tickets: { [ticket.id]: ticket },
      attempts: { [oldFailure.id]: oldFailure, [currentFailure.id]: currentFailure },
      git: { ticketCycles: {} },
    } as unknown as RunRecord;
    const before = structuredClone(run);

    expect(
      resetRetryableInfrastructureAssignment(run, ticket.id, "2026-08-12T10:30:00.000Z", {
        failedAttemptId: oldFailure.id,
        ticketExecutionEpoch: oldFailure.ticketExecutionEpoch,
      }),
    ).toBeUndefined();
    expect(run).toEqual(before);
  });

  it("counts an exact recovery marker before a successor exists and blocks a second spend in the same epoch", () => {
    const recoveryMaterial = {
      protocol: "koni.agent-token-budget-recovery.v1" as const,
      failedAttemptId: "attempt-first-budget-failure",
      ticketId: "ticket-one",
      stepId: "implement",
      ticketExecutionEpoch: 1,
      recoveredAt: "2026-08-12T10:20:01.000Z",
    };
    const firstFailure = {
      id: recoveryMaterial.failedAttemptId,
      ticketId: recoveryMaterial.ticketId,
      stepId: recoveryMaterial.stepId,
      ticketExecutionEpoch: recoveryMaterial.ticketExecutionEpoch,
      status: "aborted",
      error: "input token budget exceeded",
      startedAt: "2026-08-12T10:20:00.000Z",
      tokenBudgetRecovery: {
        ...recoveryMaterial,
        sha256: canonicalHash(recoveryMaterial),
      },
    } as AgentAttemptRecord;
    const secondFailure = {
      id: "attempt-second-budget-failure",
      ticketId: firstFailure.ticketId,
      stepId: firstFailure.stepId,
      ticketExecutionEpoch: firstFailure.ticketExecutionEpoch,
      status: "aborted",
      error: "new-token token budget exceeded",
      startedAt: "2026-08-12T10:21:00.000Z",
    } as AgentAttemptRecord;
    const run = {
      tickets: {
        "ticket-one": {
          id: "ticket-one",
          title: "Execute work",
          executionEpoch: 1,
          steps: [{ id: "implement", kind: "production", dependsOn: [] }],
        },
      },
      attempts: {
        [firstFailure.id]: firstFailure,
        [secondFailure.id]: secondFailure,
      },
      activity: [],
    } as unknown as RunRecord;

    expect(tokenBudgetRecoveryCount(run, secondFailure, "display text is non-authoritative")).toBe(
      1,
    );
  });

  it("normalizes legacy epoch-less token recovery into execution epoch zero", () => {
    const recoveryMaterial = {
      protocol: "koni.agent-token-budget-recovery.v1" as const,
      failedAttemptId: "attempt-legacy-budget-failure",
      ticketId: "ticket-one",
      stepId: "implement",
      ticketExecutionEpoch: 0,
      recoveredAt: "2026-08-12T10:20:01.000Z",
    };
    const legacyFailure = {
      id: recoveryMaterial.failedAttemptId,
      ticketId: recoveryMaterial.ticketId,
      stepId: recoveryMaterial.stepId,
      status: "aborted",
      error: "input token budget exceeded",
      startedAt: "2026-08-12T10:20:00.000Z",
      tokenBudgetRecovery: {
        ...recoveryMaterial,
        sha256: canonicalHash(recoveryMaterial),
      },
    } as AgentAttemptRecord;
    const retryFailure = {
      id: "attempt-epoch-zero-retry-failure",
      ticketId: legacyFailure.ticketId,
      stepId: legacyFailure.stepId,
      ticketExecutionEpoch: 0,
      status: "aborted",
      error: "new-token token budget exceeded",
      startedAt: "2026-08-12T10:21:00.000Z",
      lineage: {
        branchEpoch: 1,
        reason: "recovery",
        parentAttemptId: legacyFailure.id,
        parentSessionId: "session-legacy",
      },
    } as AgentAttemptRecord;
    const run = {
      tickets: {
        "ticket-one": {
          id: "ticket-one",
          title: "Execute work",
          executionEpoch: 0,
          steps: [{ id: "implement", kind: "production", dependsOn: [] }],
        },
      },
      attempts: {
        [legacyFailure.id]: legacyFailure,
        [retryFailure.id]: retryFailure,
      },
      activity: [],
      git: { ticketCycles: {} },
    } as unknown as RunRecord;

    expect(tokenBudgetRecoveryCount(run, retryFailure, "legacy display marker")).toBe(1);
  });

  it("recognizes only an exact settled Lead launch replay as already consumed", () => {
    const attemptId = "attempt-lead-replay";
    const invocationId = "action-lead-replay";
    const stepId = "lead-orchestration-entry";
    const productSha256 = rawSha256("lead-product");
    const run = {
      attempts: {
        [attemptId]: {
          id: attemptId,
          kind: "lead",
          ticketId: "run-orchestration",
          stepId,
          launchActionInvocationId: invocationId,
        },
      },
    } as unknown as Pick<RunRecord, "attempts">;
    const action = {
      invocationId,
      boundary: {
        kind: "lead_launch",
        attemptId,
        ticketId: "run-orchestration",
        stepId,
        productSha256,
      },
      journal: { status: "completed" },
      settlement: { disposition: "completed" },
      settledAt: "2026-07-30T10:25:00.662Z",
    } as Pick<
      RunActionExecutionRecord,
      "invocationId" | "boundary" | "journal" | "settlement" | "settledAt"
    >;

    expect(
      isExactSettledLeadLaunchReplay(run, action, {
        attemptId,
        stepId,
        productSha256,
      }),
    ).toBe(true);
    expect(
      isExactSettledLeadLaunchReplay(run, action, {
        attemptId,
        stepId,
        productSha256: rawSha256("different-product"),
      }),
    ).toBe(false);
    expect(
      isExactSettledLeadLaunchReplay(
        run,
        {
          ...action,
          settlement: { ...action.settlement!, disposition: "abandoned" },
        },
        { attemptId, stepId, productSha256 },
      ),
    ).toBe(false);
  });

  it("accepts a pause intent after unrelated authority revision churn", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: fakeProgram(),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const created = await client.request(
      "run.create",
      {
        objective: "Pause this run after unrelated authority churn",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Pause this run after unrelated authority churn" },
      },
      { expectedRevision: 0, idempotencyKey: "create-semantic-pause-run" },
    );
    const runId = (created.result as { runId: string }).runId;

    const paused = await client.request(
      "run.pause",
      { runId },
      {
        expectedRevision: 0,
        idempotencyKey: "pause-after-unrelated-authority-churn",
      },
    );

    expect(paused.result).toMatchObject({ runId });
    client.close();
  });

  it("runs the sealed runtime guard under the lease before authority-store recovery or migration", async () => {
    const root = await repository();
    await expect(
      RunAuthorityEngine.open({
        projectRoot: root,
        version: "1.0.0",
        program: fakeProgram(),
        supervisor: new ManagedSessionSupervisor(),
        runtimeGuard: async () => {
          throw new Error("sealed runtime drift");
        },
      }),
    ).rejects.toThrowError(/sealed runtime drift/);
    await expect(
      readFile(path.join(root, ".git", "koni", "authority", "state.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // Failure releases both lease and startup lock; a clean constructor can acquire immediately.
    const retry = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: fakeProgram(),
      supervisor: new ManagedSessionSupervisor(),
      runtimeGuard: async () => undefined,
    });
    await retry.stop();
  });

  it("lets only the lease winner open authority storage during two cold starts", async () => {
    const root = await repository();
    const openStore = vi.spyOn(ProjectAuthorityStore, "open");
    const winner = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: fakeProgram(),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(winner);
    expect(openStore).toHaveBeenCalledTimes(1);
    await expect(
      RunAuthorityEngine.open({
        projectRoot: root,
        version: "1.0.0",
        program: fakeProgram(),
        supervisor: new ManagedSessionSupervisor(),
      }),
    ).rejects.toMatchObject({ code: "authority_running" });
    expect(openStore).toHaveBeenCalledTimes(1);
    openStore.mockRestore();
  });

  it("releases the preacquired lease when construction fails after store recovery", async () => {
    const root = await repository();
    const broken = new ManagedSessionSupervisor();
    const subscribe = vi.spyOn(broken, "subscribe").mockImplementation(() => {
      throw new Error("injected post-store construction failure");
    });
    await expect(
      RunAuthorityEngine.open({
        projectRoot: root,
        version: "1.0.0",
        program: fakeProgram(),
        supervisor: broken,
      }),
    ).rejects.toThrowError(/post-store construction failure/);
    subscribe.mockRestore();

    const successor = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: fakeProgram(),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(successor);
    await successor.start();
  });

  it("fails closed when startup admits run A before run B recovery fails", async () => {
    const root = await repository();
    const seedProgram = fakeProgram();
    const runA = await recoveryDraftRun(
      root,
      "run-startup-a",
      "Recover A before failure",
      seedProgram,
    );
    const runB = await recoveryDraftRun(
      root,
      "run-startup-b",
      "Fail B while still draft",
      seedProgram,
    );
    delete runB.pipelineStages;
    const seed = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: seedProgram,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(seed);
    await seed.store.commit({
      expectedRevision: 0,
      runWrites: [
        { record: runA, expectedRevision: null },
        { record: runB, expectedRevision: null },
      ],
    });
    await seed.stop();
    engines.splice(engines.indexOf(seed), 1);

    const harness = new LifecycleHarness();
    const base = lifecycleProgram(harness);
    const failing: RunCompilerProgram = {
      ...base,
      async projectPipeline(run) {
        if (run.id === runB.id) throw new Error("injected B startup recovery failure");
        return projectedBehaviorPipeline(run.behavior!);
      },
    };
    const supervisor = new ManagedSessionSupervisor();
    let engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: failing,
      supervisor,
    });
    engines.push(engine);
    await expect(engine.start()).rejects.toThrowError(/injected B startup recovery failure/);
    expect(supervisor.list()).toEqual([]);
    expect((await engine.store.getRun(runA.id)).lifecycle.phase).toBe("paused");
    expect(await engine.store.getRun(runB.id)).toMatchObject({
      lifecycle: { phase: "blocked", resumePhase: "draft" },
    });
    expect(
      Object.values((await engine.store.getRun(runA.id)).attempts).some((attempt) =>
        new Set(["queued", "running", "waiting_question", "terminal_accepted"]).has(attempt.status),
      ),
    ).toBe(false);
    expect((await engine.store.state()).authorityQuiesce).toBeUndefined();
    expect((await engine.store.state()).authorityStartup?.status).toBe("recovering");

    const resumedHarness = new LifecycleHarness();
    const resumedBase = lifecycleProgram(resumedHarness);
    const resumedProgram: RunCompilerProgram = {
      ...resumedBase,
      async projectPipeline(run) {
        return projectedBehaviorPipeline(run.behavior!);
      },
    };
    const restarted = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: resumedProgram,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(restarted);
    await restarted.start();
    expect((await restarted.store.getRun(runA.id)).lifecycle.phase).toBe("paused");
    expect((await restarted.store.getRun(runB.id)).lifecycle.phase).toBe("blocked");
    expect(resumedHarness.adapters).toHaveLength(0);
    expect((await restarted.store.state()).authorityStartup?.status).toBe("ready");

    let client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    await client.request(
      "run.resume",
      { runId: runB.id },
      {
        expectedRevision: client.revision,
        idempotencyKey: "explicitly-retry-startup-draft",
      },
    );
    await waitFor(
      async () =>
        resumedHarness.adapters.length === 1 &&
        (await restarted.store.getRun(runB.id)).lifecycle.phase === "planning",
    );
    client.close();
  }, 30_000);

  it("uses fresh run anchors after startup recovery admits mutable continuations", async () => {
    const root = await repository();
    const program = fakeProgram();
    const run = await recoveryDraftRun(
      root,
      "run-startup-fresh-anchor",
      "Keep startup reads current",
      program,
    );
    run.lifecycle = reduceRunLifecycle(run.lifecycle, {
      type: "blocked",
      atMs: Date.parse("2026-07-18T00:00:01.000Z"),
      reason: "inert startup fixture",
      remedy: "resume",
    }).state;
    const seed = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(seed);
    await seed.store.commit({
      expectedRevision: 0,
      runWrites: [{ record: run, expectedRevision: null }],
    });
    await seed.stop();
    engines.splice(engines.indexOf(seed), 1);

    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.1",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    let mutated = false;
    let scanCalls = 0;
    let idCalls = 0;
    const mutateRunAfterSecondStartupScan = async (): Promise<void> => {
      if (mutated) return;
      mutated = true;
      const state = await engine.store.state();
      const current = await engine.store.getRun(run.id);
      const draft = structuredClone(current);
      draft.revision += 1;
      draft.updatedAt = "2026-07-18T00:00:02.000Z";
      await engine.store.commit({
        expectedRevision: state.revision,
        runWrites: [{ record: draft, expectedRevision: current.revision }],
      });
    };
    const originalScan = engine.store.runScanSnapshot.bind(engine.store);
    vi.spyOn(engine.store, "runScanSnapshot").mockImplementation(async () => {
      const snapshot = await originalScan();
      scanCalls += 1;
      if (scanCalls === 2) await mutateRunAfterSecondStartupScan();
      return snapshot;
    });
    const originalIds = engine.store.runIdSnapshot.bind(engine.store);
    vi.spyOn(engine.store, "runIdSnapshot").mockImplementation(async () => {
      const snapshot = await originalIds();
      idCalls += 1;
      if (idCalls === 2) await mutateRunAfterSecondStartupScan();
      return snapshot;
    });

    await engine.start();
    expect(mutated).toBe(true);
    expect((await engine.store.getRun(run.id)).revision).toBe(1);
    expect((await engine.store.state()).authorityStartup?.status).toBe("ready");
  });

  it("inherits a startup-failure marker that crashed before its first draft read", async () => {
    const root = await repository();
    const seedProgram = fakeProgram();
    const runA = await recoveryDraftRun(
      root,
      "run-dirty-a",
      "Admit A before dirty crash",
      seedProgram,
    );
    const runB = await recoveryDraftRun(
      root,
      "run-dirty-b",
      "Remain draft across dirty crash",
      seedProgram,
    );
    delete runB.pipelineStages;
    const seed = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: seedProgram,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(seed);
    await seed.store.commit({
      expectedRevision: 0,
      runWrites: [
        { record: runA, expectedRevision: null },
        { record: runB, expectedRevision: null },
      ],
    });
    await seed.stop();
    engines.splice(engines.indexOf(seed), 1);

    const harness = new LifecycleHarness();
    const base = lifecycleProgram(harness);
    const failing: RunCompilerProgram = {
      ...base,
      async projectPipeline(run) {
        if (run.id === runB.id) throw new Error("injected dirty startup failure");
        return projectedBehaviorPipeline(run.behavior!);
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: failing,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    const originalScan = engine.store.runScanSnapshot.bind(engine.store);
    let scans = 0;
    const scan = vi.spyOn(engine.store, "runScanSnapshot").mockImplementation(async () => {
      scans += 1;
      if (scans === 1) throw new Error("crash before startup-failure draft read");
      return originalScan();
    });
    await expect(engine.start()).rejects.toThrowError(/injected dirty startup failure/);
    await expect(engine.stop()).resolves.toBeUndefined();
    scan.mockRestore();
    expect((await engine.store.state()).authorityQuiesce).toMatchObject({
      purpose: "startup_failure",
    });
    expect((await engine.store.state()).authorityStartup?.status).toBe("recovering");
    expect((await engine.store.getRun(runB.id)).lifecycle.phase).toBe("draft");

    const safeHarness = new LifecycleHarness();
    const safeBase = lifecycleProgram(safeHarness);
    const restarted = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: {
        ...safeBase,
        async projectPipeline(run) {
          return projectedBehaviorPipeline(run.behavior!);
        },
      },
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(restarted);
    await restarted.start();
    expect((await restarted.store.state()).authorityQuiesce).toBeUndefined();
    expect((await restarted.store.state()).authorityStartup?.status).toBe("ready");
    expect((await restarted.store.getRun(runA.id)).lifecycle.phase).toBe("paused");
    expect(await restarted.store.getRun(runB.id)).toMatchObject({
      lifecycle: { phase: "blocked", resumePhase: "draft" },
    });
    expect(safeHarness.adapters).toHaveLength(0);
  }, 30_000);

  it("uses a recovering epoch alone to quiesce an admitted run and block a later draft", async () => {
    const root = await repository();
    const program = lifecycleProgram(new LifecycleHarness());
    const runA = await recoveryDraftRun(
      root,
      "run-epoch-prefix-a",
      "Admitted before crash",
      program,
    );
    runA.lifecycle = reduceRunLifecycle(runA.lifecycle, {
      type: "planning_started",
      atMs: Date.parse("2026-07-18T00:00:01.000Z"),
    }).state;
    const runB = await recoveryDraftRun(
      root,
      "run-epoch-prefix-b",
      "Uninspected at crash",
      program,
    );
    const seed = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(seed);
    const committed = await seed.store.commit({
      expectedRevision: 0,
      runWrites: [
        { record: runA, expectedRevision: null },
        { record: runB, expectedRevision: null },
      ],
    });
    const dirtyEpoch = createAuthorityStartupEpoch({
      epochId: "startup-crashed-before-catch",
      status: "recovering",
      startedAt: "2026-07-18T00:00:02.000Z",
      startingRevision: committed.state.revision,
    });
    await seed.store.replaceAuthorityStartup(null, dirtyEpoch);
    expect((await seed.store.state()).authorityQuiesce).toBeUndefined();
    await seed.stop();
    engines.splice(engines.indexOf(seed), 1);

    const harness = new LifecycleHarness();
    const recovered = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: lifecycleProgram(harness),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(recovered);
    await recovered.start();
    expect((await recovered.store.getRun(runA.id)).lifecycle.phase).toBe("paused");
    expect((await recovered.store.getRun(runB.id)).lifecycle).toMatchObject({
      phase: "blocked",
      resumePhase: "draft",
    });
    expect((await recovered.store.state()).authorityStartup?.status).toBe("ready");
    expect((await recovered.store.state()).authorityQuiesce).toBeUndefined();
    expect(harness.adapters).toHaveLength(0);
  }, 30_000);

  it("keeps the socket unready after durable startup readiness until memory admission publishes", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: fakeProgram(),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    const originalReplace = engine.store.replaceAuthorityStartup.bind(engine.store);
    let readyDurable!: () => void;
    let publishMemory!: () => void;
    const durable = new Promise<void>((resolve) => {
      readyDurable = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      publishMemory = resolve;
    });
    const replace = vi
      .spyOn(engine.store, "replaceAuthorityStartup")
      .mockImplementation(async (expected, value) => {
        const state = await originalReplace(expected, value);
        if (value.status === "ready") {
          readyDurable();
          await gate;
        }
        return state;
      });

    const starting = engine.start();
    await durable;
    expect((await engine.store.state()).authorityStartup?.status).toBe("ready");
    await expect(
      AuthorityClient.connect({
        projectRoot: root,
        client: "tui",
        version: "1.0.0",
      }),
    ).rejects.toMatchObject({ code: "authority_starting", retryable: true });
    publishMemory();
    await starting;
    replace.mockRestore();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    await expect(client.request("authority.ping")).resolves.toMatchObject({ ok: true });
    client.close();
  }, 30_000);

  it("joins foreground recovery and admits no post-stop effect after an in-flight Git prefix", async () => {
    const root = await repository();
    const harness = new LifecycleHarness();
    const program = lifecycleProgram(harness);
    const draft = await recoveryDraftRun(
      root,
      "run-start-stop-race",
      "Stop during recovery",
      program,
    );
    const seed = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(seed);
    await seed.store.commit({
      expectedRevision: 0,
      runWrites: [{ record: draft, expectedRevision: null }],
    });
    await seed.stop();
    engines.splice(engines.indexOf(seed), 1);

    const git = new IsolatedGitLifecycle(root);
    const originalMaterialize = git.materializePlanning.bind(git);
    let effectEntered!: () => void;
    let releaseEffect!: () => void;
    const entered = new Promise<void>((resolve) => {
      effectEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    const materialize = vi.spyOn(git, "materializePlanning").mockImplementation(async (...args) => {
      effectEntered();
      await gate;
      return originalMaterialize(...args);
    });
    const supervisor = new ManagedSessionSupervisor();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor,
      git,
    });
    engines.push(engine);
    // Observe the intentional startup cancellation immediately. Waiting to attach the rejection
    // assertion until after the Git gate is released lets Node report the expected rejection as
    // unhandled even though the test later consumes it.
    const starting = engine.start().then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await entered;
    // Queue a second startup recovery behind the already-admitted Git lane. Seven bounded run
    // reads carry a draft from the scan through initializeRun; after that, #withGit has no await
    // before publishing its tail. One event-loop turn therefore proves the second operation is
    // waiting on `prior`, rather than merely failing an earlier top-level cancellation check.
    const originalGetRun = engine.store.getRun.bind(engine.store);
    let queuedReads = 0;
    let reachedGitQueue!: () => void;
    const atGitQueue = new Promise<void>((resolve) => {
      reachedGitQueue = resolve;
    });
    const getRun = vi.spyOn(engine.store, "getRun").mockImplementation(async (...args) => {
      const value = await originalGetRun(...args);
      queuedReads += 1;
      if (queuedReads === 7) reachedGitQueue();
      return value;
    });
    const queuedRecovery = engine.recover().then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await atGitQueue;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stopping = engine.stop();
    expect(engine.stop()).toBe(stopping);
    let stopSettled = false;
    void stopping
      .finally(() => {
        stopSettled = true;
      })
      .catch(() => undefined);
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    releaseEffect();
    await expect(starting).resolves.toMatchObject({
      status: "rejected",
      error: { name: "RunAdvancementStoppedError" },
    });
    await expect(queuedRecovery).resolves.toMatchObject({
      status: "rejected",
      error: { name: "RunAdvancementStoppedError" },
    });
    await stopping;
    expect(materialize).toHaveBeenCalledTimes(1);
    getRun.mockRestore();
    materialize.mockRestore();
    expect(supervisor.list()).toEqual([]);
    expect(harness.adapters).toHaveLength(0);
    expect((await engine.store.getRun(draft.id)).lifecycle.phase).toBe("draft");
    expect((await engine.store.state()).authorityStartup?.status).toBe("recovering");

    const successorHarness = new LifecycleHarness();
    const successor = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: lifecycleProgram(successorHarness),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(successor);
    await successor.start();
    expect((await successor.store.getRun(draft.id)).lifecycle).toMatchObject({
      phase: "blocked",
      resumePhase: "draft",
    });
    expect((await successor.store.state()).authorityStartup?.status).toBe("ready");
    expect(successorHarness.adapters).toHaveLength(0);
  }, 30_000);

  it("blocks drafts for legacy receipt-less startup-failure markers but not receipt-backed operator spoofing", async () => {
    for (const receiptBacked of [false, true]) {
      const root = await repository();
      const harness = new LifecycleHarness();
      const program = lifecycleProgram(harness);
      const run = await recoveryDraftRun(
        root,
        receiptBacked ? "run-legacy-operator" : "run-legacy-startup-failure",
        receiptBacked ? "Legacy operator marker" : "Legacy startup failure marker",
        program,
      );
      const seed = await RunAuthorityEngine.open({
        projectRoot: root,
        version: "1.0.0",
        program,
        supervisor: new ManagedSessionSupervisor(),
      });
      engines.push(seed);
      const idempotencyKey = receiptBacked
        ? "startup-failure:operator-spoof"
        : "startup-failure:legacy-internal";
      const requestHash = receiptBacked
        ? authorityRequestHash("authority.quiesce", undefined)
        : rawSha256("legacy internal startup failure");
      const operation = legacyPurposeLessQuiesce(
        createAuthorityQuiesceOperation({
          purpose: receiptBacked ? "operator_restart" : "startup_failure",
          requestHash,
          idempotencyKey,
          requestedAt: "2026-07-18T00:00:00.000Z",
          totalRunCount: 1,
          targetRunCount: 0,
          pausedRunIds: [],
          pausedRunIdsTruncated: false,
        }),
      );
      await seed.store.commit({
        expectedRevision: 0,
        runWrites: [{ record: run, expectedRevision: null }],
        authorityQuiesce: { expectedSha256: null, value: operation },
        ...(receiptBacked
          ? {
              receipt: {
                method: "authority.quiesce",
                idempotencyKey,
                requestHash,
                result: { status: "quiesced" },
              },
            }
          : {}),
      });
      await seed.stop();
      engines.splice(engines.indexOf(seed), 1);

      const recovered = await RunAuthorityEngine.open({
        projectRoot: root,
        version: "1.0.0",
        program,
        supervisor: new ManagedSessionSupervisor(),
      });
      engines.push(recovered);
      await recovered.start();
      expect((await recovered.store.getRun(run.id)).lifecycle.phase).toBe(
        receiptBacked ? "awaiting_approval" : "blocked",
      );
      expect((await recovered.store.state()).authorityQuiesce).toBeUndefined();
      await recovered.stop();
      engines.splice(engines.indexOf(recovered), 1);
    }
  }, 30_000);

  it("admits a dirty target checkout with a warning and starts the run from the committed tip", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: directApprovalProgram(),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    await writeFile(path.join(root, "scratch.txt"), "work in progress\n");
    const created = await client.request(
      "run.create",
      {
        objective: "Ship despite local edits",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Ship despite local edits" },
      },
      { expectedRevision: 0, idempotencyKey: "create-dirty-target" },
    );
    expect(created.result).toMatchObject({
      runId: expect.any(String),
      status: "starting",
      warning: expect.stringContaining("uncommitted changes (scratch.txt)"),
    });
    const runId = (created.result as { runId: string }).runId;
    const run = await engine.store.getRun(runId);
    expect(
      run.activity.some(
        (entry) => entry.kind === "git" && entry.message.includes("uncommitted changes"),
      ),
    ).toBe(true);
    expect(run.git.target.selectedOid).toBe(await gitOutput(root, "rev-parse", "refs/heads/main"));
    expect(await readFile(path.join(root, "scratch.txt"), "utf8")).toBe("work in progress\n");

    await git(root, "add", "scratch.txt");
    await git(root, "commit", "-m", "commit the scratch work");
    await waitFor(
      async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
    );
    await client.request("authority.ping");
    const clean = await client.request(
      "run.create",
      {
        objective: "Start from a clean checkout",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Start from a clean checkout" },
      },
      { expectedRevision: client.revision, idempotencyKey: "create-clean-target" },
    );
    expect(clean.result).toMatchObject({ runId: expect.any(String), status: "starting" });
    expect(clean.result).not.toHaveProperty("warning");
    client.close();
  });

  it("records proposal approval and later audit-only steering through one idempotent authority RPC", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: directApprovalProgram(),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    let client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const created = await client.request(
      "run.create",
      {
        objective: "Review an upstream change",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Review an upstream change" },
      },
      { expectedRevision: 0, idempotencyKey: "create-proposal-decision" },
    );
    const runId = (created.result as { runId: string }).runId;
    await waitFor(
      async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
    );
    await client.request("authority.ping");
    const current = await engine.store.getRun(runId);
    const draft = structuredClone(current);
    draft.revision += 1;
    draft.updatedAt = "2026-07-18T00:00:00.000Z";
    // This test exercises the proposal-decision RPC directly while the run is still awaiting
    // plan approval. The normal source ticket is compiled by plan approval, so publish a complete
    // same-CAS compiler authority chain: operation/workflow bindings, terminal source settlement,
    // source hold, causal publication, derived definition, and immutable proposal projection.
    const proposal = await addCanonicalProposalFixture(draft);
    const state = await engine.store.state();
    await engine.store.commit({
      expectedRevision: state.revision,
      runWrites: [{ record: draft, expectedRevision: current.revision }],
    });
    client.close();
    await engine.stop();
    const restarted = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: directApprovalProgram(),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(restarted);
    await restarted.start();
    client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });
    const requestSha256 = proposal.executionControl!.proposalRequest!.requestSha256;
    await expect(
      client.request(
        "proposal.decide",
        {
          runId,
          ticketId: proposal.id,
          requestSha256: `sha256:${"f".repeat(64)}`,
          decision: "approval",
          message: "This reviewed digest is stale.",
        },
        { idempotencyKey: "reject-stale-proposal-review" },
      ),
    ).rejects.toMatchObject({ code: "proposal_revision_conflict" });
    const approved = await client.request(
      "proposal.decide",
      {
        runId,
        ticketId: proposal.id,
        requestSha256,
        decision: "approval",
        message: "Proceed with the bounded reviewed change.",
      },
      { expectedRevision: 0, idempotencyKey: "approve-proposal-one" },
    );
    expect(approved.result).toMatchObject({ status: "queued", decision: { decision: "approval" } });
    const afterApproval = await engine.store.getRun(runId);
    const approval = afterApproval.tickets[proposal.id]!.executionControl!.proposalDecision!;
    expect(afterApproval.tickets[proposal.id]!.executionControl!.proposalDecisionHistory).toEqual([
      approval,
    ]);

    const auditExpectedRevision = approved.revision;
    const audit = await client.request(
      "proposal.decide",
      {
        runId,
        ticketId: proposal.id,
        requestSha256,
        decision: "rejection",
        message: "Record this concern without revoking active approval.",
      },
      { expectedRevision: auditExpectedRevision, idempotencyKey: "audit-proposal-one" },
    );
    expect(audit.result).toMatchObject({ status: "queued", decision: { decision: "approval" } });
    const afterAudit = await engine.store.getRun(runId);
    expect(afterAudit.tickets[proposal.id]!.executionControl!.proposalDecision).toEqual(approval);
    expect(afterAudit.tickets[proposal.id]!.executionControl!.proposalDecisionHistory).toHaveLength(
      2,
    );
    await client.request(
      "proposal.decide",
      {
        runId,
        ticketId: proposal.id,
        requestSha256,
        decision: "rejection",
        message: "Record this concern without revoking active approval.",
      },
      { expectedRevision: auditExpectedRevision, idempotencyKey: "audit-proposal-one" },
    );
    expect(
      (await engine.store.getRun(runId)).tickets[proposal.id]!.executionControl!
        .proposalDecisionHistory,
    ).toHaveLength(2);
    await client.request("authority.ping");
    await authorizeDelete(client, runId, "delete-proposal-decision-run", "preserve_branches");
    await waitFor(async () => (await restarted.store.getRun(runId)).lifecycle.phase === "deleted");
    await client.request("authority.ping");
    await expect(
      client.request(
        "proposal.decide",
        {
          runId,
          ticketId: proposal.id,
          requestSha256,
          decision: "rejection",
          message: "This must not mutate a deleted run.",
        },
        { expectedRevision: client.revision, idempotencyKey: "reject-deleted-proposal" },
      ),
    ).rejects.toMatchObject({ code: "proposal_run_deleted" });
    client.close();
  }, 30_000);

  it("resumes a change-request-blocked execution and its suspended supervisor when its exact proposal is approved", async () => {
    const root = await repository();
    let engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: directApprovalProgram(),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    let client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const created = await client.request(
      "run.create",
      {
        objective: "Resume after approving a change request",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Resume after approving a change request" },
      },
      { expectedRevision: 0, idempotencyKey: "create-blocked-proposal-decision" },
    );
    const runId = (created.result as { runId: string }).runId;
    await waitFor(
      async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
    );

    const current = await engine.store.getRun(runId);
    const draft = structuredClone(current);
    draft.revision += 1;
    draft.updatedAt = "2026-07-18T00:00:00.000Z";
    draft.lifecycle = reduceRunLifecycle(draft.lifecycle, {
      type: "plan_approval_requested",
      atMs: Date.parse("2026-07-18T00:00:00.000Z"),
    }).state;
    draft.lifecycle = reduceRunLifecycle(draft.lifecycle, {
      type: "plan_approved",
      atMs: Date.parse("2026-07-18T00:00:01.000Z"),
    }).state;
    draft.plan = draft.plan === undefined ? undefined : { ...draft.plan, status: "approved" };
    draft.currentPipelineStageId = draft.behavior!.runType.pipeline.find(
      (stage) => stage.kind === "orchestration",
    )!.id;
    const proposal = await addCanonicalProposalFixture(draft);
    draft.lifecycle = reduceRunLifecycle(draft.lifecycle, {
      type: "blocked",
      atMs: Date.parse("2026-07-18T00:00:02.000Z"),
      reason: "Awaiting an operator decision on the exact change request",
      remedy: "change_request",
    }).state;
    const state = await engine.store.state();
    await engine.store.commit({
      expectedRevision: state.revision,
      runWrites: [{ record: draft, expectedRevision: current.revision }],
    });
    client.close();
    await engine.stop();
    engines.splice(engines.indexOf(engine), 1);
    const restartedSupervisor = new ManagedSessionSupervisor();
    engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: directApprovalProgram(),
      supervisor: restartedSupervisor,
    });
    engines.push(engine);
    await engine.start();
    client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    await restartedSupervisor.abortByRun(runId, "deterministic Lead deadlock");

    const requestSha256 = proposal.executionControl!.proposalRequest!.requestSha256;
    await client.request(
      "proposal.decide",
      {
        runId,
        ticketId: proposal.id,
        requestSha256,
        decision: "approval",
        message: "Proceed with the exact reviewed change.",
      },
      { expectedRevision: 0, idempotencyKey: "approve-blocked-proposal" },
    );

    const resumed = await engine.store.getRun(runId);
    expect(resumed.lifecycle).toMatchObject({ phase: "executing", runningIntent: true });
    expect(resumed.lifecycle.blocker).toBeUndefined();
    expect(resumed.lifecycle.blockerRemedy).toBeUndefined();
    expect(resumed.tickets[proposal.id]).toMatchObject({ status: "queued" });
    const admissionSpec = fixtureLaunchSpec({
      cwd: root,
      sessionDirectory: path.join(root, ".sessions", "proposal-resume-admission"),
      runId,
      ticketId: "ticket-admission-probe",
      stepId: "admission-probe",
      attemptId: "attempt-proposal-resume-admission",
      sessionId: "session-proposal-resume-admission",
    }) as AgentLaunchSpec;
    const admitted = await restartedSupervisor.launch(admissionSpec, {
      tools: [fixtureTool()],
      contextProvider: contextProvider(admissionSpec),
      factory: async () => new HangingAdapter(admissionSpec),
    });
    expect(admitted.session.spec.identity.runId).toBe(runId);
    client.close();
  }, 30_000);

  it("honors a compiler-pinned manual start by pausing immediately after approval", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: autoStartProgram(false),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const created = await client.request(
      "run.create",
      {
        objective: "Pause before implementation",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Pause before implementation" },
      },
      { expectedRevision: 0, idempotencyKey: "create-manual-start" },
    );
    const runId = (created.result as { runId: string }).runId;
    await waitFor(
      async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
    );
    await client.request("authority.ping");
    await client.request(
      "plan.approve",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "approve-manual-start",
      },
    );
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "paused");

    const paused = await engine.store.getRun(runId);
    expect(paused.plan?.status).toBe("approved");
    expect(paused.lifecycle.resumePhase).toBe("executing");
    expect(Object.values(paused.attempts).filter((attempt) => attempt.kind !== "planning")).toEqual(
      [],
    );
    expect(paused.activity.at(-1)?.message).toContain("paused by the selected run type");
    client.close();
  });

  it("keeps blocked Git/action recovery inert until the operator explicitly resumes it", async () => {
    const root = await repository();
    let injectCrash = true;
    const crashingGit = new IsolatedGitLifecycle(root, {
      effectFault: (point) => {
        if (point === "after_run_ref" && injectCrash) {
          injectCrash = false;
          throw new Error("simulated approval materialization crash");
        }
      },
    });
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: directApprovalProgram(),
      supervisor: new ManagedSessionSupervisor(),
      git: crashingGit,
    });
    engines.push(engine);
    await engine.start();
    let client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "restart-run-materialization");
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "blocked");

    const crashed = await engine.store.getRun(runId);
    const compile = Object.values(crashed.actionExecutions ?? {}).find(
      (action) => action.boundary.kind === "approved_plan_compile",
    )!;
    expect(Object.values(crashed.pendingGitIntents ?? {})).toEqual([
      expect.objectContaining({ kind: "run_materialize", runRef: crashed.git.run.branchRef }),
    ]);
    expect(crashed.git.run.status).toBe("unmaterialized");
    expect(compile).toMatchObject({ journal: { status: "running", steps: [] }, effects: {} });
    expect(await gitOutput(root, "rev-parse", crashed.git.run.branchRef)).toBe(
      crashed.git.target.selectedOid,
    );

    client.close();
    await engine.stop();
    const restarted = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: directApprovalProgram(),
      supervisor: new ManagedSessionSupervisor(),
      git: new IsolatedGitLifecycle(root),
    });
    engines.push(restarted);
    await restarted.start();
    const recovered = await restarted.store.getRun(runId);
    expect(recovered.lifecycle.phase).toBe("blocked");
    expect(Object.values(recovered.pendingGitIntents ?? {})).toEqual([
      expect.objectContaining({ kind: "run_materialize" }),
    ]);
    expect(recovered.git).toMatchObject({ run: { status: "unmaterialized" } });
    expect(recovered.actionExecutions?.[compile.invocationId]).toMatchObject({
      journal: { status: "running", steps: [] },
      effects: {},
    });

    client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });
    await expect(
      client.request(
        "run.resume",
        { runId },
        {
          expectedRevision: client.revision,
          idempotencyKey: "reconcile-recovered-run-materialization",
        },
      ),
    ).rejects.toMatchObject({ code: "run_git_recovery_pending", retryable: true });
    await waitFor(
      async () =>
        Object.keys((await restarted.store.getRun(runId)).pendingGitIntents ?? {}).length === 0,
    );
    await client.request("authority.ping");
    await client.request(
      "run.resume",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "resume-recovered-run-materialization",
      },
    );
    await waitFor(async () => {
      const current = await restarted.store.getRun(runId);
      const action = current.actionExecutions?.[compile.invocationId];
      return (
        action?.journal.status === "completed" &&
        action.settlement?.disposition === "completed" &&
        action.semanticResult?.kind === "approved_plan"
      );
    });
    const completed = await restarted.store.getRun(runId);
    expect(
      completed.gitReceipts?.filter((receipt) => receipt.kind === "run_materialize"),
    ).toHaveLength(1);
    expect(completed.actionExecutions?.[compile.invocationId]).toMatchObject({
      settlement: { disposition: "completed" },
      semanticResult: { kind: "approved_plan" },
    });
    expect(
      Object.values(completed.actionExecutions ?? {}).filter(
        (action) => action.boundary.kind === "approved_plan_compile",
      ),
    ).toHaveLength(1);
    client.close();
  }, 30_000);

  it("lets pause settle while run materialization is between its Git effect and journal settlement", async () => {
    const root = await repository();
    const entered = deferred<void>();
    const release = deferred<void>();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: directApprovalProgram(),
      supervisor: new ManagedSessionSupervisor(),
      lifecycleFault: async (point) => {
        if (point !== "before_run_materialization_settle") return;
        entered.resolve();
        await release.promise;
      },
    });
    engines.push(engine);
    await engine.start();
    let client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "pause-run-materialization");
    await entered.promise;

    const inFlight = await engine.store.getRun(runId);
    const compile = Object.values(inFlight.actionExecutions ?? {}).find(
      (action) => action.boundary.kind === "approved_plan_compile",
    )!;
    expect(Object.values(inFlight.pendingGitIntents ?? {})).toEqual([
      expect.objectContaining({ kind: "run_materialize" }),
    ]);
    expect(compile).toMatchObject({ journal: { status: "running", steps: [] }, effects: {} });

    await client.request("authority.ping");
    await client.request(
      "run.pause",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "pause-before-run-materialization-settlement",
      },
    );
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "pausing");
    const stopping = await engine.store.getRun(runId);
    try {
      expect(stopping.actionExecutions?.[compile.invocationId]).toMatchObject({
        journal: { status: "running", steps: [] },
        effects: {},
      });
      expect(stopping.actionExecutions?.[compile.invocationId]?.settlement).toBeUndefined();
    } finally {
      // A final paused label waits for the already-started nonpublication Git intent to reconcile.
      // Once it settles, pause closes the still-unexecuted compiler action in the same terminal CAS.
      release.resolve();
    }
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "paused");
    const paused = await engine.store.getRun(runId);
    const abandoned = paused.actionExecutions?.[compile.invocationId]!;
    expect(abandoned).toMatchObject({
      journal: { status: "running", steps: [] },
      effects: {},
      settlement: { disposition: "abandoned" },
    });
    expect(paused.graphHash).toBe(inFlight.graphHash);
    expect(paused.graphRevision).toBe(inFlight.graphRevision);
    expect(canonicalHash(paused.tickets)).toBe(canonicalHash(inFlight.tickets));
    expect(paused.pendingGitIntents).toEqual({});
    expect(paused.lifecycle.phase).toBe("paused");
    expect(paused.lifecycle.blocker).toBeUndefined();
    expect(paused.git).toMatchObject({ planning: { status: "retired" }, run: { status: "ready" } });
    expect(paused.actionExecutions?.[compile.invocationId]?.settlement).toEqual(
      abandoned.settlement,
    );
    expect(
      paused.activity.some((entry) =>
        /approval failed|configured action recovery failed/iu.test(entry.message),
      ),
    ).toBe(false);

    client.close();
    await engine.stop();
    const restarted = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: directApprovalProgram(),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(restarted);
    await restarted.start();
    client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });
    await client.request(
      "run.resume",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "resume-after-paused-run-materialization",
      },
    );
    await waitFor(async () => {
      const current = await restarted.store.getRun(runId);
      return Object.values(current.actionExecutions ?? {}).some(
        (action) =>
          action.boundary.kind === "approved_plan_compile" &&
          action.invocationId !== compile.invocationId &&
          action.settlement?.disposition === "completed",
      );
    });
    const resumed = await restarted.store.getRun(runId);
    expect(resumed.actionExecutions?.[compile.invocationId]?.settlement).toEqual(
      abandoned.settlement,
    );
    expect(
      Object.values(resumed.actionExecutions ?? {}).filter(
        (action) =>
          action.boundary.kind === "approved_plan_compile" &&
          action.invocationId !== compile.invocationId &&
          action.settlement?.disposition === "completed",
      ),
    ).toHaveLength(1);
    expect(
      resumed.gitReceipts?.filter((receipt) => receipt.kind === "run_materialize"),
    ).toHaveLength(1);
    client.close();
  }, 30_000);

  it("owns real catalog-driven configuration resource creation, duplication, and deletion", async () => {
    const root = await repository();
    await installProfile(root, codingProfile);
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: fakeProgram(),
      supervisor: new ManagedSessionSupervisor(),
      profilePackageRootLoader: async () => codingProfile,
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const catalog = parseConfigCatalog((await client.request("config.catalog")).result);
    const snapshot = parseConfigSnapshot((await client.request("config.get")).result);
    const section = catalog.sections.find((candidate) => candidate.title === "Run Types")!;
    const option = section.createOptions!.find(
      (candidate) => candidate.title === "Based on Small",
    )!;
    await client.request(
      "config.resource.create",
      {
        cas: snapshot.cas,
        sectionId: section.id,
        templateId: option.id,
        name: "Authority Flow",
      },
      { expectedRevision: client.revision, idempotencyKey: "config-create-authority-flow" },
    );
    expect(
      await readFile(path.join(root, ".koni", "run-types", "authority-flow.yaml"), "utf8"),
    ).toContain("id: authority-flow");

    let nextCatalog = parseConfigCatalog((await client.request("config.catalog")).result);
    let nextSnapshot = parseConfigSnapshot((await client.request("config.get")).result);
    const created = nextCatalog.sections
      .find((candidate) => candidate.title === "Run Types")!
      .resources.find((candidate) => candidate.title === "Authority Flow")!;
    await client.request(
      "config.resource.duplicate",
      {
        cas: nextSnapshot.cas,
        resourceId: created.id,
        name: "Authority Flow Copy",
      },
      { expectedRevision: client.revision, idempotencyKey: "config-duplicate-authority-flow" },
    );
    expect(
      await readFile(path.join(root, ".koni", "run-types", "authority-flow-copy.yaml"), "utf8"),
    ).toContain("id: authority-flow-copy");

    nextCatalog = parseConfigCatalog((await client.request("config.catalog")).result);
    nextSnapshot = parseConfigSnapshot((await client.request("config.get")).result);
    const copy = nextCatalog.sections
      .find((candidate) => candidate.title === "Run Types")!
      .resources.find((candidate) => candidate.title === "Authority Flow Copy")!;
    await client.request(
      "config.resource.delete",
      {
        cas: nextSnapshot.cas,
        resourceId: copy.id,
      },
      { expectedRevision: client.revision, idempotencyKey: "config-delete-authority-flow" },
    );
    await expect(
      readFile(path.join(root, ".koni", "run-types", "authority-flow-copy.yaml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    client.close();
  }, 120_000);

  it("exposes compiler-validated raw documents and the run-type wizard only through authority RPC", async () => {
    const root = await repository();
    await installProfile(root, codingProfile);
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: fakeProgram(),
      supervisor: new ManagedSessionSupervisor(),
      profilePackageRootLoader: async () => codingProfile,
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });

    const listed = (await client.request("config.documents.list", {})).result as {
      protocol: string;
      catalogToken: `sha256:${string}`;
      valid: boolean;
      documents: Array<{
        id: string;
        title: string;
        domain: string;
        kind: string;
        sourceToken: `sha256:${string}`;
      }>;
    };
    expect(listed).toMatchObject({ protocol: "koni.config-document-catalog.v1", valid: true });
    expect(listed.documents.some((document) => Object.hasOwn(document, "path"))).toBe(false);
    const small = listed.documents.find(
      (document) => document.title === "Small" && document.kind === "run_type",
    )!;
    const opened = (
      await client.request("config.documents.read", {
        documentId: small.id,
        catalogToken: listed.catalogToken,
      })
    ).result as { source: string };
    const updatedSource = opened.source.replace(
      "One bounded claim in a known domain",
      "One authority-edited bounded claim in a known domain",
    );
    expect(updatedSource).not.toBe(opened.source);
    const updated = (
      await client.request(
        "config.documents.update",
        {
          documentId: small.id,
          catalogToken: listed.catalogToken,
          sourceToken: small.sourceToken,
          source: updatedSource,
        },
        {
          expectedRevision: client.revision,
          idempotencyKey: "rpc-update-small-source",
        },
      )
    ).result as { catalog: typeof listed };
    expect(await readFile(path.join(root, ".koni", "run-types", "small.yaml"), "utf8")).toContain(
      "authority-edited bounded claim",
    );
    await expect(
      client.request(
        "config.documents.update",
        {
          documentId: small.id,
          catalogToken: listed.catalogToken,
          sourceToken: small.sourceToken,
          source: `${updatedSource}\n# another edit\n`,
        },
        {
          expectedRevision: client.revision,
          idempotencyKey: "rpc-reject-stale-small-source",
        },
      ),
    ).rejects.toMatchObject({ code: "config_source_changed", retryable: true });

    const templates = (await client.request("config.run-types.templates", {})).result as {
      catalogToken: `sha256:${string}`;
      templates: Array<{ id: string; title: string }>;
    };
    expect(templates.catalogToken).toBe(updated.catalog.catalogToken);
    const smallTemplate = templates.templates.find((template) => template.title === "Small")!;
    const withRunType = (
      await client.request(
        "config.run-types.create",
        {
          catalogToken: templates.catalogToken,
          templateId: smallTemplate.id,
          title: "Authority RPC Run",
          makeDefault: false,
        },
        {
          expectedRevision: client.revision,
          idempotencyKey: "rpc-create-run-type",
        },
      )
    ).result as { catalog: typeof listed };
    expect(withRunType.catalog.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Authority RPC Run", kind: "run_type" }),
      ]),
    );

    const created = (
      await client.request(
        "config.documents.create",
        {
          catalogToken: withRunType.catalog.catalogToken,
          domain: "advanced",
          kind: "raw_source",
          format: "markdown",
          title: "Authority Notes",
        },
        {
          expectedRevision: client.revision,
          idempotencyKey: "rpc-create-document",
        },
      )
    ).result as { catalog: typeof listed };
    const notes = created.catalog.documents.find(
      (document) => document.title === "Authority Notes",
    )!;
    const renamed = (
      await client.request(
        "config.documents.rename",
        {
          documentId: notes.id,
          catalogToken: created.catalog.catalogToken,
          sourceToken: notes.sourceToken,
          title: "Authority Journal",
        },
        {
          expectedRevision: client.revision,
          idempotencyKey: "rpc-rename-document",
        },
      )
    ).result as { catalog: typeof listed };
    const journal = renamed.catalog.documents.find(
      (document) => document.title === "Authority Journal",
    )!;
    const deleted = (
      await client.request(
        "config.documents.delete",
        {
          documentId: journal.id,
          catalogToken: renamed.catalog.catalogToken,
          sourceToken: journal.sourceToken,
        },
        {
          expectedRevision: client.revision,
          idempotencyKey: "rpc-delete-document",
        },
      )
    ).result as { catalog: typeof listed };
    expect(
      deleted.catalog.documents.some((document) => document.title === "Authority Journal"),
    ).toBe(false);
    await expect(
      readFile(path.join(root, ".koni", "custom", "authority-journal.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    client.close();
  }, 120_000);

  it("moves a run from provisional creation through approval to explicit publication", async () => {
    const root = await repository();
    let sequence = 0;
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: reviewingFakeProgram(),
      supervisor: new ManagedSessionSupervisor(),
      now: () => new Date(1_784_179_200_000 + sequence * 1_000),
      createId: (kind) => `${kind}-${++sequence}`,
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });

    const created = await client.request(
      "run.create",
      {
        objective: "Build the feature",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Build the feature" },
      },
      { expectedRevision: 0, idempotencyKey: "create-feature" },
    );
    const runId = (created.result as { runId: string }).runId;
    expect((await engine.store.getRun(runId)).lifecycle.phase).toMatch(
      /draft|planning|awaiting_approval/u,
    );

    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      if (current.lifecycle.phase === "blocked" || current.lifecycle.phase === "failed") {
        throw new Error(
          `run stopped before plan review: ${current.lifecycle.blocker ?? current.lifecycle.terminalReason}`,
        );
      }
      return current.lifecycle.phase === "awaiting_approval";
    });
    const planned = await engine.store.getRun(runId);
    expect(planned.planningSession).toMatchObject({
      attemptId: expect.any(String),
      sessionId: expect.any(String),
      currentRevision: 0,
    });
    expect(planned.plan?.concise.architecture).toEqual([
      {
        title: "Use existing seam",
        description: "Keep the change within the repository boundary.",
      },
    ]);
    const firstPlanner = Object.values(planned.attempts).find(
      (attempt) => attempt.kind === "planning",
    )!;
    const firstPlannerSpec = validateAgentLaunchSpec(
      JSON.parse(
        (
          await engine.store.readArtifact(
            `runs/${runId}/attempts/${firstPlanner.id}/launch-spec.json`,
            16 * 1024 * 1024,
          )
        ).toString("utf8"),
      ) as AgentLaunchSpec,
    );
    const firstPlannerSessionFile = firstPlanner.sessionFile!;
    const mappingId = "fixture-planner-mapping";
    const promptId = "fixture-planner-prompt";
    const responseId = "fixture-planner-response";
    await mkdir(path.dirname(firstPlannerSessionFile), { recursive: true, mode: 0o700 });
    await writeFile(
      firstPlannerSessionFile,
      `${[
        {
          type: "session",
          version: 3,
          id: firstPlanner.sessionId,
          timestamp: planned.updatedAt,
          cwd: firstPlannerSpec.workspace.cwd,
        },
        {
          type: "custom",
          id: mappingId,
          parentId: null,
          timestamp: planned.updatedAt,
          customType: "koni.attempt-session-map",
          data: {
            protocol: "koni.attempt-session-map.v1",
            specHash: firstPlannerSpec.specHash,
            runId: firstPlannerSpec.identity.runId,
            ticketId: firstPlannerSpec.identity.ticketId,
            stepId: firstPlannerSpec.identity.stepId,
            attemptId: firstPlannerSpec.identity.attemptId,
            sessionId: firstPlannerSpec.identity.sessionId,
            grantId: firstPlannerSpec.authority.grantId,
            grantHash: firstPlannerSpec.authority.grantHash,
            generation: firstPlannerSpec.authority.generation,
            epoch: firstPlannerSpec.authority.epoch,
            stateHash: firstPlannerSpec.authority.expectedStateHash,
            resourceSetHash: firstPlannerSpec.resources.setHash,
            model: firstPlannerSpec.model,
            lineage: firstPlannerSpec.lineage,
            sessionFile: firstPlannerSessionFile,
          },
        },
        {
          type: "message",
          id: promptId,
          parentId: mappingId,
          timestamp: planned.updatedAt,
          message: { role: "user", content: firstPlannerSpec.persona.initialPrompt },
        },
        {
          type: "message",
          id: responseId,
          parentId: promptId,
          timestamp: planned.updatedAt,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "The approved repository evidence and complete first plan." },
            ],
            usage: { input: 3, output: 5, cacheRead: 7, cacheWrite: 0 },
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
      { mode: 0o600 },
    );
    await client.request("authority.ping");
    const revisionRequest = await client.request(
      "plan.revise",
      {
        runId,
        instructions: "Keep the same architecture, but make the verification proof explicit.",
      },
      {
        expectedRevision: client.revision,
        idempotencyKey: "revise-feature-plan",
      },
    );
    expect(revisionRequest.result).toMatchObject({
      runId,
      status: "planning",
      planRevision: 1,
      planningSessionId: firstPlanner.sessionId,
      planningAttemptId: firstPlanner.id,
      revisionUsage: {
        cumulative: expect.objectContaining({ total: expect.any(Number) }),
        currentRevision: { new: 0, cache: 0, total: 0 },
      },
    });
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return (
        current.lifecycle.phase === "awaiting_approval" &&
        Object.values(current.attempts).filter((attempt) => attempt.kind === "planning").length ===
          1 &&
        current.planningSession?.currentRevision === 1
      );
    });
    const revised = await engine.store.getRun(runId);
    const planners = Object.values(revised.attempts).filter(
      (attempt) => attempt.kind === "planning",
    );
    expect(planners).toHaveLength(1);
    expect(planners[0]!.id).toBe(firstPlanner.id);
    expect(planners[0]!.sessionId).toBe(firstPlanner.sessionId);
    expect(planners[0]!.lineage?.conversationFork).toBeUndefined();
    expect(revised.planningSession?.revisions).toHaveLength(2);
    expect(revised.planningSession?.revisions[0]).toMatchObject({ status: "superseded" });
    expect(revised.planningSession?.revisions[1]).toMatchObject({
      revision: 1,
      status: "awaiting_review",
      steering: {
        instructionsSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    });
    expect(revised.plan?.steeringHistory.at(-1)?.instructions).toContain("verification proof");
    await client.request("authority.ping");
    await client.request(
      "plan.approve",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "approve-feature",
      },
    );

    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      if (current.lifecycle.phase === "blocked" || current.lifecycle.phase === "failed") {
        throw new Error(
          `run stopped before merge ready: ${current.lifecycle.blocker ?? current.lifecycle.terminalReason}`,
        );
      }
      return current.lifecycle.phase === "merge_ready";
    });
    const ready = await engine.store.getRun(runId);
    expect(ready.tickets["ticket-one"]?.steps[0]?.summary).toBe("Implemented feature");
    expect(ready.git.promotion?.candidateOid).toMatch(/^[0-9a-f]{40}$/u);
    const leadJudgments = Object.values(ready.attempts).filter(
      (attempt) => attempt.kind === "lead",
    );
    expect(leadJudgments).toHaveLength(1);
    expect(leadJudgments[0]).toMatchObject({
      personaId: "lead",
      ticketId: "run-orchestration",
      stepId: "lead-orchestration-entry",
      status: "completed",
    });
    expect(ready.leadJudgments).toEqual([
      expect.objectContaining({
        trigger: "orchestration_entry",
        attemptId: leadJudgments[0]!.id,
        disposition: "proceed",
        behaviorSha256: ready.behavior?.sha256,
        graphHash: ready.graphHash,
        runOid: ready.git.run.headOid,
      }),
    ]);
    const longRunningResearchHistory = structuredClone(ready);
    const firstLeadAttempt = leadJudgments[0]!;
    const firstLeadJudgment = longRunningResearchHistory.leadJudgments![0]!;
    for (let index = 1; index < 65; index += 1) {
      const attemptId = `attempt-lead-history-${index}`;
      const { launchActionInvocationId: _launchActionInvocationId, ...historicalAttempt } =
        structuredClone(firstLeadAttempt);
      longRunningResearchHistory.attempts[attemptId] = {
        ...historicalAttempt,
        id: attemptId,
        sessionId: `session-lead-history-${index}`,
      };
      longRunningResearchHistory.leadJudgments!.push({
        ...structuredClone(firstLeadJudgment),
        attemptId,
        graphHash: rawSha256(`lead-history-graph-${index}`),
      });
    }
    expect(() => assertRunRecord(longRunningResearchHistory)).not.toThrow();
    expect(
      Object.values(ready.attempts).filter((attempt) => attempt.personaId === "supervisor"),
    ).toEqual([]);
    const independentReview = Object.values(ready.attempts).find(
      (attempt) => attempt.kind === "verification",
    );
    expect(independentReview).toMatchObject({
      status: "completed",
      verificationAccepted: true,
      ticketId: "run-planning",
      stepId: "combined-plan",
      reviewedRunOid: ready.git.run.headOid,
      reviewedTargetOid: ready.git.targetSynchronization?.targetOid,
      reviewedGraphHash: ready.graphHash,
    });
    expect(ready.postOrchestration).toMatchObject({
      protocol: "koni.post-orchestration.v1",
      synchronization: {
        stageId: "target-sync",
        runOid: ready.git.run.headOid,
        targetOid: ready.git.targetSynchronization?.targetOid,
        graphHash: ready.graphHash,
      },
      checkpoint: {
        stageId: "verification",
        runOid: ready.git.run.headOid,
        targetOid: ready.git.targetSynchronization?.targetOid,
        graphHash: ready.graphHash,
        verificationSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
      review: {
        stageId: "independent-check",
        attemptId: independentReview?.id,
        runOid: ready.git.run.headOid,
        targetOid: ready.git.targetSynchronization?.targetOid,
        graphHash: ready.graphHash,
      },
      report: {
        stageId: "report",
        actionId: "report",
        actionSha256: ready.behavior?.actions.actions.report?.sha256,
        runOid: ready.git.run.headOid,
        targetOid: ready.git.targetSynchronization?.targetOid,
        graphHash: ready.graphHash,
      },
    });
    expect(ready.reports).toHaveLength(1);
    expect(ready.postOrchestration?.report?.reportId).toBe(ready.reports?.[0]?.reportId);

    await client.request("authority.ping");
    await authorizeMerge(client, runId, "merge-feature");
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "completed");
    const completed = await engine.store.getRun(runId);
    expect(completed.git.promotion).toMatchObject({ status: "published" });
    expect(completed.attempts).toEqual(
      expect.objectContaining({
        [Object.keys(completed.attempts)[0]!]: expect.objectContaining({ status: "completed" }),
      }),
    );
    const completedControls = (await client.request("run.controls", { runId })).result as {
      stages: Array<{ status: string; current: boolean }>;
    };
    expect(completedControls.stages.every((stage) => stage.status === "succeeded")).toBe(true);
    expect(completedControls.stages.some((stage) => stage.current)).toBe(false);
    client.close();
  }, 30_000);

  it("executes a legacy automatic report recipe with a redundant compiler lock prelude", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: directApprovalProgram({ legacyReportLock: true }),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "legacy-report-lock");

    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      if (current.lifecycle.phase === "blocked" || current.lifecycle.phase === "failed") {
        throw new Error(
          `legacy report stopped before merge ready: ${
            current.lifecycle.blocker ?? current.lifecycle.terminalReason
          }`,
        );
      }
      return current.lifecycle.phase === "merge_ready";
    });

    const ready = await engine.store.getRun(runId);
    const report = Object.values(ready.actionExecutions ?? {}).find(
      (action) => action.boundary.kind === "post_orchestration_report",
    );
    expect(
      ready.behavior?.actions.actions.report?.recipe.map(({ primitive }) => primitive),
    ).toEqual(["lock.acquire", "project.validate", "report.render"]);
    expect(report?.settlement?.disposition).toBe("completed");
    client.close();
  }, 30_000);

  it("blocks before ticket admission when the bounded entry Lead rejects orchestration", async () => {
    const root = await repository();
    const base = directApprovalProgram();
    const program: RunCompilerProgram = {
      ...base,
      async compileLeadJudgmentOutput() {
        return {
          protocol: "koni.lead-judgment-output.v1",
          disposition: "blocked",
          summary: "The approved plan still lacks a material product decision",
        };
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "lead-entry-block");
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "blocked");

    const blocked = await engine.store.getRun(runId);
    expect(blocked.leadJudgments).toEqual([
      expect.objectContaining({
        trigger: "orchestration_entry",
        disposition: "blocked",
        summary: "The approved plan still lacks a material product decision",
      }),
    ]);
    expect(Object.values(blocked.attempts).filter((attempt) => attempt.kind === "ticket")).toEqual(
      [],
    );
    expect(blocked.tickets["ticket-one"]?.steps.every((step) => step.status === "pending")).toBe(
      true,
    );
    client.close();
  });

  it("issues one deadlock Lead judgment and then blocks an unchanged deterministic projection", async () => {
    const root = await repository();
    const base = directApprovalProgram();
    const program: RunCompilerProgram = {
      ...base,
      async initializeApprovedPlan() {
        const stalled = ticket();
        // A malformed compiler projection with no executable step is the exact class of
        // post-validation scheduler deadlock this bounded qualitative boundary diagnoses.
        stalled.steps = [];
        return {
          graphHash: `sha256:${"d".repeat(64)}`,
          graphRevision: 1,
          tickets: { [stalled.id]: stalled },
        };
      },
      async compileLeadJudgmentOutput({ run, attemptId }) {
        const trigger =
          run.attempts[attemptId]?.stepId === "lead-compiler-deadlock"
            ? "compiler deadlock"
            : "orchestration entry";
        return {
          protocol: "koni.lead-judgment-output.v1",
          disposition: "proceed",
          summary: `Proceed after ${trigger}`,
        };
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "bounded-lead-deadlock");
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "blocked");

    const blocked = await engine.store.getRun(runId);
    expect(
      blocked.leadJudgments?.map(({ trigger, disposition }) => ({ trigger, disposition })),
    ).toEqual([
      { trigger: "orchestration_entry", disposition: "proceed" },
      { trigger: "compiler_deadlock", disposition: "proceed" },
    ]);
    expect(
      Object.values(blocked.attempts).filter((attempt) => attempt.kind === "lead"),
    ).toHaveLength(2);
    expect(Object.values(blocked.attempts).filter((attempt) => attempt.kind === "ticket")).toEqual(
      [],
    );
    expect(blocked.lifecycle.blocker).toContain("remains deadlocked after bounded Lead review");
    client.close();
  });

  it("rearms an exact never-started terminal resolver after source dependencies settle", () => {
    const source = ticket();
    source.id = "source-terminal";
    source.status = "blocked";
    source.dependencyIds = ["repair-terminal"];
    source.steps[0]!.status = "failed";

    const repair = ticket();
    repair.id = "repair-terminal";
    repair.status = "completed";

    const failureBindingSha256 = canonicalHash("source-terminal-failure");
    const resolver = ticket();
    resolver.id = "resolver-terminal";
    resolver.status = "cancelled";
    resolver.blocker = "Superseded before execution by newer compiler state";
    resolver.executionControl = {
      terminalRecovery: {
        sourceTicketId: source.id,
        failureBindingSha256s: [failureBindingSha256],
      },
    } as TicketExecutionControlRecord;
    for (const step of resolver.steps) {
      step.status = "skipped";
      step.attemptIds = [];
    }

    const run = {
      tickets: {
        [source.id]: source,
        [repair.id]: repair,
        [resolver.id]: resolver,
      },
    } as unknown as RunRecord;

    expect(shouldRearmCancelledTerminalResolver(run, source, resolver, failureBindingSha256)).toBe(
      true,
    );

    source.dependencyIds = [];
    expect(shouldRearmCancelledTerminalResolver(run, source, resolver, failureBindingSha256)).toBe(
      true,
    );
    source.dependencyIds = [repair.id];

    repair.status = "running";
    expect(shouldRearmCancelledTerminalResolver(run, source, resolver, failureBindingSha256)).toBe(
      false,
    );
    repair.status = "completed";

    resolver.steps[0]!.attemptIds = ["attempt-started"];
    expect(shouldRearmCancelledTerminalResolver(run, source, resolver, failureBindingSha256)).toBe(
      false,
    );
    resolver.steps[0]!.attemptIds = [];

    expect(
      shouldRearmCancelledTerminalResolver(run, source, resolver, canonicalHash("other-failure")),
    ).toBe(false);
  });

  it("advances to verification when the remaining ticket is terminally cancelled", async () => {
    const root = await repository();
    const base = directApprovalProgram();
    const program: RunCompilerProgram = {
      ...base,
      async initializeApprovedPlan() {
        const cancelled = ticket();
        cancelled.status = "cancelled";
        cancelled.blocker = "Superseded before execution by newer compiler state";
        for (const step of cancelled.steps) {
          step.status = "skipped";
          step.completedAt = cancelled.updatedAt;
        }
        return {
          graphHash: `sha256:${"e".repeat(64)}`,
          graphRevision: 1,
          tickets: { [cancelled.id]: cancelled },
        };
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "terminal-cancelled-board");
    await waitFor(async () => {
      const phase = (await engine.store.getRun(runId)).lifecycle.phase;
      return phase === "merge_ready" || phase === "blocked";
    });

    const resolved = await engine.store.getRun(runId);
    expect(resolved.lifecycle.phase).toBe("merge_ready");
    expect(resolved.tickets["ticket-one"]?.status).toBe("cancelled");
    expect(
      resolved.leadJudgments?.some((judgment) => judgment.trigger === "compiler_deadlock"),
    ).toBe(false);
    client.close();
  });

  it("drives arbitrary stage IDs only through their pinned semantic kinds across restart", async () => {
    const root = await repository();
    const observed: Array<{ boundary: string; stage: string | undefined }> = [];
    const base = fakeProgram();
    const semantic = semanticPipeline([
      ["enter", "action"],
      ["discover", "planning"],
      ["signoff", "approval"],
      ["prepare", "initialize"],
      ["build", "orchestration"],
      ["compose", "target_sync"],
      ["quality", "checkpoint"],
      ["summarize", "action"],
      ["ship", "promotion"],
    ]);
    const program: RunCompilerProgram = {
      ...base,
      async resolveRun(request) {
        const resolved = await base.resolveRun(request);
        const pipeline = resolved.behavior.runType.pipeline.map((stage, index) => ({
          ...stage,
          id: semantic[index]!.id,
          title: semantic[index]!.title,
        }));
        const behavior = behaviorSnapshotWithPipeline(resolved.behavior, pipeline);
        return {
          ...resolved,
          behavior,
          pipelineStageIds: semantic.map((stage) => stage.id),
          pipelineStages: semantic,
        };
      },
      async prepareAttempt(input) {
        observed.push({
          boundary: `prepare:${input.kind}`,
          stage: input.run.currentPipelineStageId,
        });
        return base.prepareAttempt(input);
      },
      async initializeApprovedPlan(run) {
        observed.push({ boundary: "initialize-approved", stage: run.currentPipelineStageId });
        return base.initializeApprovedPlan(run);
      },
      async verifyRun(run) {
        observed.push({ boundary: "verify", stage: run.currentPipelineStageId });
        return base.verifyRun(run);
      },
    };

    const first = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(first);
    await first.start();
    let client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const created = await client.request(
      "run.create",
      {
        objective: "Exercise semantic stage authority",
        runTypeId: "custom",
        targetRef: "refs/heads/main",
        intake: { goal: "Exercise semantic stage authority" },
      },
      { expectedRevision: client.revision, idempotencyKey: "create-semantic-stages" },
    );
    const runId = (created.result as { runId: string }).runId;
    await waitFor(
      async () => (await first.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
    );
    const planned = await first.store.getRun(runId);
    expect(planned.currentPipelineStageId).toBe("signoff");
    expect(planned.pipelineStages).toEqual(semantic);
    client.close();
    await first.stop();

    const restarted = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(restarted);
    await restarted.start();
    client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });
    await client.request(
      "plan.approve",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "approve-semantic-stages",
      },
    );
    await waitFor(async () => {
      const run = await restarted.store.getRun(runId);
      if (run.lifecycle.phase === "blocked" || run.lifecycle.phase === "failed") {
        throw new Error(
          run.lifecycle.blocker ?? run.lifecycle.terminalReason ?? "semantic run stopped",
        );
      }
      return run.lifecycle.phase === "merge_ready";
    });
    const ready = await restarted.store.getRun(runId);
    expect(ready.currentPipelineStageId).toBe("ship");
    expect(observed).toEqual(
      expect.arrayContaining([
        { boundary: "prepare:planning", stage: "discover" },
        { boundary: "initialize-approved", stage: "signoff" },
        { boundary: "prepare:ticket", stage: "build" },
        { boundary: "verify", stage: "quality" },
      ]),
    );
    client.close();
  }, 30_000);

  it("moves a direct-approval run to review without creating a planner attempt", async () => {
    const root = await repository();
    let sequence = 0;
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: directApprovalProgram(),
      supervisor: new ManagedSessionSupervisor(),
      now: () => new Date(1_784_179_200_000 + sequence * 1_000),
      createId: (kind) => `${kind}-${++sequence}`,
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });

    const created = await client.request(
      "run.create",
      {
        objective: "Measure a bounded retrieval effect",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Measure a bounded retrieval effect" },
      },
      { expectedRevision: 0, idempotencyKey: "create-direct-research" },
    );
    const runId = (created.result as { runId: string }).runId;
    await waitFor(
      async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
    );

    const reviewable = await engine.store.getRun(runId);
    expect(reviewable.planningMode).toBe("direct");
    expect(reviewable.attempts).toEqual({});
    expect(reviewable.plan).toMatchObject({
      status: "awaiting_approval",
      full: {},
      concise: {},
    });
    expect(reviewable.plan?.graphSeed).toBeUndefined();
    client.close();
  });

  it("derives stage controls from the pinned pipeline and rejects stale action invocations", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: capabilityDirectProgram(),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const created = await client.request(
      "run.create",
      {
        objective: "Exercise compiler-authored stage controls",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Exercise compiler-authored stage controls" },
      },
      { expectedRevision: 0, idempotencyKey: "create-stage-control-run" },
    );
    const runId = (created.result as { runId: string }).runId;
    await waitFor(
      async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
    );

    const controls = (await client.request("run.controls", { runId })).result as {
      protocol: string;
      binding: { runId: string; runRevision: number; generation: number; phase: string };
      stages: Array<{
        id: string;
        kind: string;
        current: boolean;
        interaction: { mode: string; primaryActionId?: string };
        actions: Array<{ id: string; intent: string; availability: { state: string } }>;
      }>;
      runActions: Array<{ id: string; intent: string }>;
    };
    expect(controls).toMatchObject({
      protocol: "koni.stage-capability-catalog.v1",
      binding: { runId, phase: "awaiting_approval" },
    });
    const approval = controls.stages.find((stage) => stage.kind === "approval")!;
    const approve = approval.actions.find((action) => action.intent === "approve_run")!;
    expect(approval).toMatchObject({ current: true, interaction: { mode: "operator" } });
    expect(approve.availability.state).toBe("available");
    expect(controls.runActions.map((action) => action.intent)).toEqual(
      expect.arrayContaining(["pause_run", "update_orchestration", "inspect_run_deletion"]),
    );

    const invocation = {
      protocol: "koni.stage-action-invocation.v1",
      runId,
      runRevision: controls.binding.runRevision,
      generation: controls.binding.generation,
      capabilityId: approve.id,
      confirmed: false,
      values: {},
    };
    await client.request("run.action.execute", invocation, {
      // The capability binding carries the strict run revision. Unrelated authority churn must
      // not make the operator action impossible to submit.
      expectedRevision: 0,
      idempotencyKey: "approve-through-stage-capability",
    });
    await expect(
      client.request("run.action.execute", invocation, {
        expectedRevision: client.revision,
        idempotencyKey: "reject-stale-stage-capability",
      }),
    ).rejects.toMatchObject({ code: "stale_revision" });
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "merge_ready");

    const readyControls = (await client.request("run.controls", { runId }))
      .result as typeof controls;
    expect(readyControls.stages.find((stage) => stage.kind === "promotion")).toMatchObject({
      current: true,
      interaction: { mode: "operator" },
      actions: [expect.objectContaining({ intent: "inspect_run_merge" })],
    });
    const orchestration = readyControls.runActions.find(
      (action) => action.intent === "update_orchestration",
    )!;
    await client.request(
      "run.action.execute",
      {
        protocol: "koni.stage-action-invocation.v1",
        runId,
        runRevision: readyControls.binding.runRevision,
        generation: readyControls.binding.generation,
        capabilityId: orchestration.id,
        confirmed: false,
        values: { maxParallel: 3 },
      },
      {
        expectedRevision: client.revision,
        idempotencyKey: "update-orchestration-through-stage-capability",
      },
    );
    expect((await engine.store.getRun(runId)).executionConfig!.maxParallel).toBe(3);
    client.close();
  });

  it("reopens a completed dependency when configured-check preflight rejects its contract", async () => {
    const root = await repository();
    const direct = directApprovalProgram();
    let repaired = false;
    const program: RunCompilerProgram = {
      ...direct,
      async initializeApprovedPlan() {
        const producer = reviewTicket();
        producer.id = "ticket-compile-run-plan";
        producer.operationId = "execution.node.compile-run-plan";
        producer.targetNodeIds = ["run-one"];
        producer.writeNodeIds = ["run-one"];

        const runner = ticket();
        runner.id = "ticket-run-experiment";
        runner.operationId = "execution.run.run-experiment";
        runner.targetNodeIds = ["run-one"];
        runner.readNodeIds = ["run-one"];
        runner.writeNodeIds = ["run-one"];
        runner.dependencyIds = [producer.id];

        return {
          graphHash: `sha256:${"c".repeat(64)}`,
          graphRevision: 1,
          tickets: { [producer.id]: producer, [runner.id]: runner },
        };
      },
      async prepareAttempt(input) {
        if (input.assignment?.ticketId === "ticket-run-experiment" && !repaired) {
          throw new NativeRunProgramError(
            "check_input_binding",
            "check scientific-result-integrity argv input source is not a permitted nonempty list",
          );
        }
        return direct.prepareAttempt(input);
      },
      async compileAssignmentOutput({ run, assignment }) {
        if (
          assignment.ticketId === "ticket-compile-run-plan" &&
          run.tickets[assignment.ticketId]?.reviewReworks?.some((rework) =>
            rework.blocker.includes("configured-check preflight"),
          )
        ) {
          repaired = true;
        }
        return { outcome: { status: "completed", summary: "Completed bounded assignment" } };
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(
      client,
      engine,
      "reopen-invalid-runtime-contract-producer",
    );

    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return current.tickets["ticket-compile-run-plan"]?.executionEpoch === 1;
    });
    const reopened = await engine.store.getRun(runId);
    expect(reopened.tickets["ticket-compile-run-plan"]?.reviewReworks).toEqual([
      expect.objectContaining({
        mode: "automatic",
        scope: "producer_and_review",
        blocker: expect.stringContaining("configured-check preflight"),
      }),
    ]);

    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      if (current.lifecycle.phase === "blocked") return true;
      return current.lifecycle.phase === "merge_ready";
    });
    const settled = await engine.store.getRun(runId);
    expect(settled.lifecycle.phase).toBe("merge_ready");
    expect(settled.tickets["ticket-compile-run-plan"]).toMatchObject({
      status: "completed",
      executionEpoch: 1,
    });
    expect(
      settled.activity.some((entry) =>
        entry.message.includes(
          "Reopened completed dependency after configured-check preflight rejected its contract",
        ),
      ),
    ).toBe(true);
    client.close();
  }, 30_000);

  it("reopens the reviewed producer with contract diagnostics after a configured result rejection", async () => {
    const root = await repository();
    const run = await recoveryDraftRun(
      root,
      "run-rejected-configured-result",
      "Repair a rejected configured result",
      directApprovalProgram(),
    );
    const producer = reviewTicket();
    producer.id = "ticket-compile-run-plan";
    producer.operationId = "execution.node.compile-run-plan";
    producer.status = "completed";
    producer.targetNodeIds = ["run-one"];
    producer.writeNodeIds = ["run-one"];
    for (const step of producer.steps) {
      step.status = "completed";
      step.attemptIds = [`attempt-${step.id}`];
    }
    const consumer = ticket();
    consumer.id = "ticket-run-experiment";
    consumer.targetNodeIds = ["run-one"];
    consumer.readNodeIds = ["run-one"];
    consumer.writeNodeIds = ["run-one"];
    consumer.dependencyIds = [producer.id];
    run.tickets = { [producer.id]: producer, [consumer.id]: consumer };

    consumer.dependencyIds = [];
    const producerIds = completedConfiguredCheckDependencyIds(run, consumer.id);
    const reopened = reopenCompletedConfiguredCheckDependencies(
      run,
      consumer.id,
      "configured check scientific-runtime rejected its result: protocol mismatch",
      "2026-08-03T00:00:00.000Z",
      producerIds,
    );

    expect(reopened).toEqual([producer.id]);
    expect(run.tickets[producer.id]).toMatchObject({
      status: "queued",
      executionEpoch: 1,
      reviewReworkCount: 1,
      reviewReworks: [
        expect.objectContaining({
          mode: "automatic",
          scope: "producer_and_review",
          blocker: expect.stringContaining("protocol mismatch"),
        }),
      ],
    });
  });

  it("does not reopen completed scientific dependencies for an infrastructure-only check failure", () => {
    expect(
      configuredCheckResultRequiresDependencyReopen({
        accepted: false,
        infrastructureFailure:
          "command infrastructure failed before producing an admissible expected result: the configured test graph could not load one of its modules",
      }),
    ).toBe(false);
    expect(
      configuredCheckResultRequiresDependencyReopen({
        accepted: false,
      }),
    ).toBe(true);
    expect(
      configuredCheckResultRequiresDependencyReopen({
        accepted: true,
      }),
    ).toBe(false);
  });

  it("also reopens a completed asset producer omitted from satisfied dependency edges", () => {
    const source = reviewTicket();
    source.id = "ticket-compile-run-plan";
    source.operationId = "execution.node.compile-run-plan";
    source.status = "completed";
    source.targetNodeIds = ["run-one"];
    source.writeNodeIds = ["run-one"];

    const asset = reviewTicket();
    asset.id = "ticket-implement-asset";
    asset.operationId = "asset-resolution.asset.implement-asset";
    asset.status = "completed";
    asset.targetNodeIds = ["asset-verifier"];
    asset.writeNodeIds = ["asset-verifier"];
    asset.writePaths = ["program/assets/verifier"];

    const consumer = ticket();
    consumer.id = "ticket-run-experiment";
    consumer.targetNodeIds = ["run-one"];
    consumer.readNodeIds = ["asset-verifier", "run-one"];
    consumer.writeNodeIds = ["run-one"];
    consumer.dependencyIds = [source.id];

    const run = {
      tickets: {
        [source.id]: source,
        [asset.id]: asset,
        [consumer.id]: consumer,
      },
    } as unknown as Pick<RunRecord, "tickets">;

    expect(completedConfiguredCheckDependencyIds(run, consumer.id)).toEqual([source.id, asset.id]);
  });

  it("does not restore a retired checkout onto a persisted queued recurring asset ticket", () => {
    const prior = reviewTicket();
    prior.id = "ticket-implement-asset";
    prior.operationId = "asset-resolution.asset.implement-asset";
    prior.status = "queued";
    prior.executionEpoch = 2;
    prior.gitCycleId = "cycle-retired";
    prior.worktreePath = "/tmp/retired-worktree";
    prior.branch = "refs/heads/retired-ticket-cycle";
    for (const step of prior.steps) step.status = "pending";

    const compiled = structuredClone(prior);
    compiled.status = "queued";
    compiled.executionEpoch = 3;
    delete compiled.gitCycleId;
    compiled.worktreePath = undefined;
    compiled.branch = undefined;
    for (const step of compiled.steps) step.status = "pending";

    const run = {
      tickets: { [prior.id]: prior },
      git: fixtureRunGit("/tmp/koni-recurring-asset", "run-recurring-asset"),
    } as unknown as Pick<RunRecord, "tickets" | "git">;
    run.git.ticketCycles[prior.gitCycleId] = {
      cycleId: prior.gitCycleId,
      ticketId: prior.id,
      ordinal: 3,
      status: "retired",
    } as RunRecord["git"]["ticketCycles"][string];
    const retained = retainTicketAuthorityFields(run, { [compiled.id]: compiled });

    expect(retained[compiled.id]).toMatchObject({
      status: "queued",
      executionEpoch: 3,
      worktreePath: undefined,
      branch: undefined,
    });
    expect(retained[compiled.id]!.gitCycleId).toBeUndefined();
  });

  it("advances the ticket epoch when checkout allocation replaces a retired cycle", () => {
    const ticket = reviewTicket();
    ticket.id = "ticket-recurring";
    ticket.status = "queued";
    ticket.executionEpoch = 4;
    ticket.gitCycleId = "cycle-retired";
    const run = {
      tickets: { [ticket.id]: ticket },
      git: fixtureRunGit("/tmp/koni-cycle-replacement", "run-cycle-replacement"),
    } as unknown as Pick<RunRecord, "tickets" | "git">;
    run.git.ticketCycles[ticket.gitCycleId] = {
      cycleId: ticket.gitCycleId,
      ticketId: ticket.id,
      ordinal: 5,
      status: "retired",
    } as RunRecord["git"]["ticketCycles"][string];

    expect(replacementTicketExecutionEpoch(run, ticket)).toBe(5);
    run.git.ticketCycles[ticket.gitCycleId]!.status = "active";
    expect(replacementTicketExecutionEpoch(run, ticket)).toBeUndefined();
  });

  it("refreshes an unused queued ticket cycle when the integration head advanced", () => {
    const ticket = reviewTicket();
    ticket.id = "ticket-consumer";
    ticket.status = "queued";
    ticket.executionEpoch = 0;
    ticket.gitCycleId = "cycle-stale";
    for (const step of ticket.steps) step.attemptIds = [];
    const run = {
      tickets: { [ticket.id]: ticket },
      attempts: {},
      git: fixtureRunGit("/tmp/koni-stale-consumer", "run-stale-consumer"),
    } as unknown as RunRecord;
    run.git.run.headOid = "b".repeat(40);
    const cycle = {
      cycleId: ticket.gitCycleId,
      ticketId: ticket.id,
      ordinal: 1,
      status: "active",
      baseRunOid: "a".repeat(40),
    } as RunRecord["git"]["ticketCycles"][string];
    run.git.ticketCycles[ticket.gitCycleId] = cycle;

    expect(shouldRefreshUnusedTicketCycle(run, ticket, cycle)).toBe(true);
    ticket.steps[0]!.attemptIds = ["attempt-existing"];
    run.attempts["attempt-existing"] = {
      id: "attempt-existing",
      ticketId: ticket.id,
      stepId: ticket.steps[0]!.id,
      ticketExecutionEpoch: 0,
    } as AgentAttemptRecord;
    expect(shouldRefreshUnusedTicketCycle(run, ticket, cycle)).toBe(true);
    ticket.steps[0]!.status = "completed";
    expect(shouldRefreshUnusedTicketCycle(run, ticket, cycle)).toBe(false);
  });

  it("refreshes a clean active ticket cycle between steps when the integration head advanced", () => {
    const ticket = reviewTicket();
    ticket.id = "ticket-stale-between-steps";
    ticket.status = "running";
    ticket.gitCycleId = "cycle-stale-between-steps";
    ticket.steps[0]!.status = "completed";
    ticket.steps[1]!.status = "running";
    const run = {
      tickets: { [ticket.id]: ticket },
      attempts: {},
      git: fixtureRunGit("/tmp/koni-stale-between-steps", "run-stale-between-steps"),
    } as unknown as RunRecord;
    run.git.run.headOid = "b".repeat(40);
    const cycle = {
      cycleId: ticket.gitCycleId,
      ticketId: ticket.id,
      ordinal: 1,
      status: "active",
      baseRunOid: "a".repeat(40),
      ticketHeadOid: "a".repeat(40),
    } as RunRecord["git"]["ticketCycles"][string];
    run.git.ticketCycles[ticket.gitCycleId] = cycle;

    expect(shouldRefreshUnusedTicketCycle(run, ticket, cycle)).toBe(true);
    cycle.ticketHeadOid = "c".repeat(40);
    expect(shouldRefreshUnusedTicketCycle(run, ticket, cycle)).toBe(false);
  });

  it("refreshes a consumed historical integration cycle that omitted its conflict candidate", () => {
    const ticket = reviewTicket();
    ticket.id = "ticket-integration";
    ticket.status = "queued";
    ticket.integrationForTicketId = "ticket-source";
    ticket.gitCycleId = "cycle-without-preview";
    ticket.steps[0]!.status = "completed";
    ticket.steps[0]!.attemptIds = ["attempt-invalid-inspection"];
    const cycle = {
      cycleId: ticket.gitCycleId,
      ticketId: ticket.id,
      ordinal: 1,
      status: "active",
      baseRunOid: "a".repeat(40),
      ticketHeadOid: "a".repeat(40),
    } as RunRecord["git"]["ticketCycles"][string];

    expect(shouldRefreshIntegrationCandidateCycle(ticket, cycle, "b".repeat(40))).toBe(true);
  });

  it("uses the current graph's latest Lead judgment when reporting a deterministic deadlock", () => {
    const run = {
      graphHash: `sha256:${"b".repeat(64)}`,
      git: { run: { headOid: "2".repeat(40) } },
      leadJudgments: [
        {
          trigger: "compiler_deadlock",
          graphHash: `sha256:${"a".repeat(64)}`,
          runOid: "1".repeat(40),
          disposition: "proceed",
          summary: "stale deadlock diagnosis",
        },
        {
          trigger: "compiler_deadlock",
          graphHash: `sha256:${"b".repeat(64)}`,
          runOid: "2".repeat(40),
          disposition: "proceed",
          summary: "current deadlock diagnosis",
        },
      ],
    } as unknown as RunRecord;

    expect(acceptedLeadJudgmentForRun(run, "compiler_deadlock")?.summary).toBe(
      "current deadlock diagnosis",
    );
  });

  it("invalidates a blocked entry Lead for an exactly approved queued proposal before it has a disposition", () => {
    const approvalSha256 = `sha256:${"a".repeat(64)}` as const;
    const run = {
      tickets: {
        "proposal-one": {
          status: "queued",
          executionControl: {
            proposalDecision: {
              decision: "approval",
              sha256: approvalSha256,
            },
            proposalApprovalSha256: approvalSha256,
          },
        },
      },
    } as unknown as RunRecord;

    expect(hasExactQueuedProposalApproval(run)).toBe(true);
    expect(run.tickets["proposal-one"]!.executionControl?.proposalDisposition).toBeUndefined();
    expect(shouldBypassEntryLeadForExactActiveProposal(run, "orchestration_entry", undefined)).toBe(
      true,
    );
    expect(shouldBypassEntryLeadForExactActiveProposal(run, "compiler_deadlock", undefined)).toBe(
      false,
    );
    run.tickets["proposal-one"]!.status = "running";
    expect(hasExactQueuedProposalApproval(run)).toBe(false);
    expect(hasExactActiveProposalApproval(run)).toBe(true);
    expect(shouldBypassEntryLeadForExactActiveProposal(run, "orchestration_entry", undefined)).toBe(
      true,
    );
    run.tickets["proposal-one"]!.status = "review";
    expect(hasExactActiveProposalApproval(run)).toBe(true);
    run.tickets["proposal-one"]!.executionControl!.proposalApprovalSha256 =
      `sha256:${"b".repeat(64)}`;
    expect(hasExactActiveProposalApproval(run)).toBe(false);
  });

  it("bypasses an entry Lead while an exact approved application is still settling", () => {
    const applicationSha256 = `sha256:${"c".repeat(64)}` as const;
    const run = {
      tickets: {
        "proposal-one": {
          id: "proposal-one",
          status: "completed",
          executionControl: {
            approvedApplicationSha256: applicationSha256,
            proposalDisposition: {
              kind: "application",
              applicationTicketId: "application-one",
              authoritySha256: applicationSha256,
            },
          },
        },
        "application-one": {
          id: "application-one",
          status: "queued",
          executionControl: {
            controlTicketAuthority: { role: "approved_application" },
            sourceProposalTicketId: "proposal-one",
            approvedApplicationSha256: applicationSha256,
          },
        },
      },
    } as unknown as RunRecord;

    expect(shouldBypassEntryLeadForExactActiveProposal(run, "orchestration_entry", undefined)).toBe(
      true,
    );
    expect(shouldBypassEntryLeadForExactActiveProposal(run, "compiler_deadlock", undefined)).toBe(
      false,
    );
    run.tickets["application-one"]!.executionControl!.approvedApplicationSha256 =
      `sha256:${"d".repeat(64)}`;
    expect(shouldBypassEntryLeadForExactActiveProposal(run, "orchestration_entry", undefined)).toBe(
      false,
    );
  });

  it("does not recover an assignment-validation action after its accepted attempt was interrupted", () => {
    const ticket = reviewTicket();
    ticket.id = "ticket-current";
    ticket.status = "queued";
    ticket.executionEpoch = 2;
    ticket.gitCycleId = "cycle-current";
    ticket.steps[0]!.status = "pending";
    const attempt = {
      id: "attempt-stale",
      kind: "ticket",
      ticketId: ticket.id,
      stepId: ticket.steps[0]!.id,
      ticketExecutionEpoch: 1,
      status: "interrupted",
    } as AgentAttemptRecord;
    const action = {
      boundary: {
        kind: "assignment_validation",
        ticketId: ticket.id,
        stepId: ticket.steps[0]!.id,
        attemptId: attempt.id,
        cycleId: "cycle-stale",
      },
    } as RunActionExecutionRecord;
    const run = {
      attempts: { [attempt.id]: attempt },
      tickets: { [ticket.id]: ticket },
    } as unknown as RunRecord;

    expect(isRecoverableAssignmentValidationAction(run, action)).toBe(false);
    attempt.status = "terminal_accepted";
    attempt.ticketExecutionEpoch = 2;
    action.boundary.cycleId = ticket.gitCycleId;
    ticket.status = "running";
    ticket.steps[0]!.status = "running";
    ticket.steps[0]!.attemptIds.push(attempt.id);
    expect(isRecoverableAssignmentValidationAction(run, action)).toBe(true);
  });

  it("treats malformed artifact envelopes as rejected results when the command has no effects", () => {
    const check = {
      commands: [
        {
          effect: "workspace_write",
          networkAccess: false,
          outputPaths: [],
        },
      ],
    };
    const command = {
      checkId: "scientific-runtime",
      outputArtifactSelector: {
        field: "artifacts",
        allowPathStrings: true,
        pathField: "path",
      },
    };

    expect(configuredCheckHasNoExternalEffects(check)).toBe(true);
    expect(
      configuredResultArtifactPaths(command, {
        protocol: "autoresearch.gate-result.v1",
        verdict: "inconclusive",
      }),
    ).toEqual([]);
  });

  it("retries a blocked continuous planning run in its stable attempt and session", async () => {
    const root = await repository();
    const base = fakeProgram();
    const prepareAttempt = base.prepareAttempt.bind(base);
    const preparePlanningRevision = base.preparePlanningRevision!.bind(base);
    let failFirstPlanner = true;
    let failFirstRevision = true;
    const program: RunCompilerProgram = {
      ...base,
      async initializeApprovedPlan() {
        throw new Error("blocked planning resume must not initialize an unapproved plan");
      },
      async prepareAttempt(input) {
        const prepared = await prepareAttempt(input);
        if (input.kind !== "planning" || !failFirstPlanner) return prepared;
        failFirstPlanner = false;
        return {
          ...prepared,
          factory: async () => {
            throw new Error("simulated contained session cold-start timeout");
          },
        };
      },
      async preparePlanningRevision(input) {
        const prepared = await preparePlanningRevision(input);
        if (!failFirstRevision) return prepared;
        failFirstRevision = false;
        return {
          ...prepared,
          factory: async () => {
            throw new Error("simulated planning revision host failure");
          },
        };
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });

    const created = await client.request(
      "run.create",
      {
        objective: "Retry a planner after a bounded cold-start failure",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Retry a planner after a bounded cold-start failure" },
      },
      { expectedRevision: 0, idempotencyKey: "create-retryable-planning-run" },
    );
    const runId = (created.result as { runId: string }).runId;
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "blocked");
    const blocked = await engine.store.getRun(runId);
    const first = Object.values(blocked.attempts).find((attempt) => attempt.kind === "planning")!;
    expect(blocked.lifecycle).toMatchObject({
      phase: "blocked",
      resumePhase: "planning",
      runningIntent: false,
    });
    expect(first).toMatchObject({ status: "failed", inputTokens: 0, outputTokens: 0 });

    await client.request("authority.ping");
    const resumed = await client.request(
      "run.resume",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "retry-blocked-planning-run",
      },
    );
    expect(resumed.result).toMatchObject({ runId, status: "planning" });
    try {
      await waitFor(async () => {
        const current = await engine.store.getRun(runId);
        return (
          current.lifecycle.phase === "awaiting_approval" &&
          Object.values(current.attempts).filter((attempt) => attempt.kind === "planning")
            .length === 1
        );
      });
    } catch (error) {
      const current = await engine.store.getRun(runId);
      throw new Error(
        `continuous planning retry did not settle: ${JSON.stringify({ lifecycle: current.lifecycle, attempts: current.attempts, planningSession: current.planningSession, activity: current.activity.slice(-6) })}`,
        { cause: error },
      );
    }
    const planned = await engine.store.getRun(runId);
    const attempts = Object.values(planned.attempts)
      .filter((attempt) => attempt.kind === "planning")
      .sort((left, right) => (left.lineage?.branchEpoch ?? 0) - (right.lineage?.branchEpoch ?? 0));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      id: first.id,
      sessionId: first.sessionId,
      status: "waiting_plan_review",
      lineage: { branchEpoch: 0, reason: "initial" },
    });
    expect(attempts[0]?.lineage?.conversationFork).toBeUndefined();
    expect(planned.planningSession).toMatchObject({
      attemptId: first.id,
      sessionId: first.sessionId,
      currentRevision: 0,
      status: "awaiting_review",
    });
    expect(planned.activity.at(-1)?.message).toContain("Retrying blocked run from planning");

    await client.request("authority.ping");
    await client.request(
      "plan.revise",
      { runId, instructions: "Clarify the bounded verification proof." },
      {
        expectedRevision: client.revision,
        idempotencyKey: "launch-failing-planning-revision",
      },
    );
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "blocked");
    const blockedRevision = await engine.store.getRun(runId);
    expect(blockedRevision).toMatchObject({
      lifecycle: { phase: "blocked", resumePhase: "planning" },
      planningSession: {
        attemptId: first.id,
        sessionId: first.sessionId,
        currentRevision: 1,
        status: "blocked",
      },
    });

    await client.request("authority.ping");
    await client.request(
      "run.resume",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "retry-blocked-planning-revision",
      },
    );
    try {
      await waitFor(async () => {
        const current = await engine.store.getRun(runId);
        return (
          current.lifecycle.phase === "awaiting_approval" &&
          current.planningSession?.currentRevision === 1
        );
      });
    } catch (error) {
      const current = await engine.store.getRun(runId);
      throw new Error(
        `continuous planning revision retry did not settle: ${JSON.stringify({ lifecycle: current.lifecycle, attempts: current.attempts, planningSession: current.planningSession, activity: current.activity.slice(-6) })}`,
        { cause: error },
      );
    }
    const revised = await engine.store.getRun(runId);
    expect(revised.planningSession).toMatchObject({
      attemptId: first.id,
      sessionId: first.sessionId,
      currentRevision: 1,
      status: "awaiting_review",
    });
    client.close();
  });

  it.each([
    {
      label: "typed",
      failureCode: "provider_admission",
      failureMessage: "input budget cannot reserve the prospective provider input",
    },
    {
      label: "legacy context-window wording",
      failureCode: undefined,
      failureMessage:
        "prospective provider input plus reserved output exceeds the authenticated model context window",
    },
    {
      label: "legacy authority shutdown",
      failureCode: undefined,
      failureMessage: "authority stopping",
    },
    {
      label: "legacy suspended run admission",
      failureCode: undefined,
      failureMessage: "run run-one is paused",
    },
    {
      label: "legacy unsafe-boundary recovery",
      failureCode: undefined,
      failureMessage: "Pi transcript does not end at a provably safe continuation boundary",
    },
  ])(
    "retries a $label runtime-failed ticket only after an explicit operator resume",
    async ({ label, failureCode, failureMessage }) => {
      const root = await repository();
      const base = directApprovalProgram();
      const prepareAttempt = base.prepareAttempt.bind(base);
      let failFirstTicket = true;
      const program: RunCompilerProgram = {
        ...base,
        async prepareAttempt(input) {
          const prepared = await prepareAttempt(input);
          if (input.kind !== "ticket" || !failFirstTicket) return prepared;
          failFirstTicket = false;
          return {
            ...prepared,
            factory: async () =>
              new InfrastructureFailingAdapter(prepared.spec, failureCode, failureMessage),
          };
        },
      };
      const engine = await RunAuthorityEngine.open({
        projectRoot: root,
        version: "1.0.0",
        program,
        supervisor: new ManagedSessionSupervisor(),
      });
      engines.push(engine);
      await engine.start();
      const client = await AuthorityClient.connect({
        projectRoot: root,
        client: "tui",
        version: "1.0.0",
      });
      const runId = await createAndApproveDirectRun(
        client,
        engine,
        `operator-confirmed-ticket-retry-${label}`,
      );
      await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "blocked");

      const blocked = await engine.store.getRun(runId);
      const first = Object.values(blocked.attempts).find((attempt) => attempt.kind === "ticket")!;
      expect(first.status).toBe("failed");
      expect(first.failureCode).toBe(failureCode);
      expect(first.terminalAcceptedAt).toBeUndefined();
      expect(first.terminalOutputSha256).toBeUndefined();
      expect(blocked.tickets["ticket-one"]).toMatchObject({
        status: "blocked",
        steps: [expect.objectContaining({ status: "failed", attemptIds: [first.id] })],
      });

      await client.request("authority.ping");
      await client.request(
        "run.resume",
        { runId },
        {
          expectedRevision: client.revision,
          idempotencyKey: `retry-runtime-failed-ticket-${label}`,
        },
      );
      await waitFor(async () => {
        const current = await engine.store.getRun(runId);
        return (
          current.lifecycle.phase === "merge_ready" &&
          Object.values(current.attempts).filter((attempt) => attempt.kind === "ticket").length ===
            2
        );
      });

      const ready = await engine.store.getRun(runId);
      const attempts = Object.values(ready.attempts)
        .filter((attempt) => attempt.kind === "ticket")
        .sort(
          (left, right) => (left.lineage?.branchEpoch ?? 0) - (right.lineage?.branchEpoch ?? 0),
        );
      expect(attempts[0]).toMatchObject({ id: first.id, status: "failed" });
      expect(attempts[0]?.failureCode).toBe(failureCode);
      expect(attempts[1]).toMatchObject({
        status: "completed",
        lineage: {
          branchEpoch: 1,
          reason: "retry",
          parentAttemptId: first.id,
          parentSessionId: first.sessionId,
        },
      });
      expect(
        ready.activity.some(
          (entry) =>
            entry.message ===
            "Retrying Implement feature after operator-confirmed runtime recovery",
        ),
      ).toBe(true);
      client.close();
    },
  );

  it("automatically retries a context-window admission failure from a fresh contained root", async () => {
    const root = await repository();
    const base = directApprovalProgram();
    const prepareAttempt = base.prepareAttempt.bind(base);
    let failFirstTicket = true;
    const program: RunCompilerProgram = {
      ...base,
      async prepareAttempt(input) {
        const prepared = await prepareAttempt(input);
        if (input.kind !== "ticket" || !failFirstTicket) return prepared;
        failFirstTicket = false;
        return {
          ...prepared,
          factory: async () =>
            new InfrastructureFailingAdapter(
              prepared.spec,
              "provider_input_exposure",
              "Koni provider admission rejected: request exceeds the context window. prospective provider input plus reserved output exceeds the authenticated model context window",
            ),
        };
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "automatic-context-recovery");

    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return (
        current.lifecycle.phase === "merge_ready" &&
        Object.values(current.attempts).filter((attempt) => attempt.kind === "ticket").length === 2
      );
    });

    const settled = await engine.store.getRun(runId);
    const attempts = Object.values(settled.attempts)
      .filter((attempt) => attempt.kind === "ticket")
      .sort((left, right) => (left.lineage?.branchEpoch ?? 0) - (right.lineage?.branchEpoch ?? 0));
    expect(attempts[0]).toMatchObject({
      status: "failed",
      failureCode: "provider_input_exposure",
    });
    expect(attempts[1]).toMatchObject({
      status: "completed",
      lineage: {
        branchEpoch: 1,
        reason: "retry",
        parentAttemptId: attempts[0]!.id,
      },
    });
    expect(attempts[1]?.lineage?.conversationFork).toBeUndefined();
    expect(
      settled.activity.some((entry) =>
        entry.message.includes("automatic provider-admission recovery"),
      ),
    ).toBe(true);
    client.close();
  });

  it("bounds provider-admission recovery cycles rather than raw failed admissions", async () => {
    const root = await repository();
    const base = directApprovalProgram();
    const prepareAttempt = base.prepareAttempt.bind(base);
    let remainingAdmissionFailures = 3;
    const program: RunCompilerProgram = {
      ...base,
      async prepareAttempt(input) {
        const prepared = await prepareAttempt(input);
        if (input.kind !== "ticket" || remainingAdmissionFailures === 0) return prepared;
        remainingAdmissionFailures -= 1;
        return {
          ...prepared,
          factory: async () =>
            new InfrastructureFailingAdapter(
              prepared.spec,
              "provider_input_exposure",
              "Koni provider admission rejected: request exceeds the context window. prospective provider input plus reserved output exceeds the authenticated model context window",
            ),
        };
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "bounded-admission-recovery");

    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return (
        current.lifecycle.phase === "merge_ready" &&
        Object.values(current.attempts).filter((attempt) => attempt.kind === "ticket").length === 4
      );
    });

    const settled = await engine.store.getRun(runId);
    expect(
      settled.activity.filter((entry) =>
        entry.message.includes("automatic provider-admission recovery"),
      ),
    ).toHaveLength(3);
    client.close();
  }, 30_000);

  it("automatically retries a terminal-contract failure without an operator resume", async () => {
    const root = await repository();
    const base = directApprovalProgram();
    const prepareAttempt = base.prepareAttempt.bind(base);
    let failFirstTicket = true;
    const program: RunCompilerProgram = {
      ...base,
      async prepareAttempt(input) {
        const prepared = await prepareAttempt(input);
        if (input.kind !== "ticket" || !failFirstTicket) return prepared;
        failFirstTicket = false;
        return {
          ...prepared,
          factory: async () =>
            new InfrastructureFailingAdapter(
              prepared.spec,
              "terminal_protocol",
              "agent settled without calling terminal tool koni_submit_output",
            ),
        };
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(
      client,
      engine,
      "automatic-terminal-contract-retry",
    );
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "merge_ready");

    const completed = await engine.store.getRun(runId);
    const attempts = Object.values(completed.attempts).filter(
      (attempt) => attempt.kind === "ticket",
    );
    expect(attempts).toHaveLength(2);
    expect(attempts.some((attempt) => attempt.failureCode === "terminal_protocol")).toBe(true);
    expect(
      completed.activity.some((entry) =>
        entry.message.includes("Auto-retrying an effect-free terminal-contract failure"),
      ),
    ).toBe(true);
    client.close();
  });

  it("automatically retries a planning terminal-contract failure in its stable session", async () => {
    const root = await repository();
    const base = fakeProgram();
    const prepareAttempt = base.prepareAttempt.bind(base);
    let failFirstPlanner = true;
    let failedIdentity: Readonly<{ attemptId: string; sessionId: string }> | undefined;
    const program: RunCompilerProgram = {
      ...base,
      async prepareAttempt(input) {
        const prepared = await prepareAttempt(input);
        if (input.kind !== "planning" || !failFirstPlanner) return prepared;
        failFirstPlanner = false;
        failedIdentity = {
          attemptId: prepared.spec.identity.attemptId,
          sessionId: prepared.spec.identity.sessionId,
        };
        return {
          ...prepared,
          factory: async () =>
            new InfrastructureFailingAdapter(
              prepared.spec,
              "terminal_protocol",
              "agent settled without calling terminal tool koni_submit_output",
              { input: 13, output: 5, cacheRead: 8, cacheWrite: 2 },
            ),
        };
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });

    const created = await client.request(
      "run.create",
      {
        objective: "Recover an effect-free planning terminal failure",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Recover an effect-free planning terminal failure" },
      },
      { expectedRevision: 0, idempotencyKey: "create-terminal-recovery-planning-run" },
    );
    const runId = (created.result as { runId: string }).runId;
    await waitFor(
      async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
    );

    const planned = await engine.store.getRun(runId);
    const planningAttempts = Object.values(planned.attempts).filter(
      (attempt) => attempt.kind === "planning",
    );
    expect(planningAttempts).toHaveLength(1);
    expect(planningAttempts[0]).toMatchObject({
      id: failedIdentity?.attemptId,
      sessionId: failedIdentity?.sessionId,
      status: "waiting_plan_review",
      inputTokens: 13,
      outputTokens: 5,
      cacheReadTokens: 8,
      cacheWriteTokens: 2,
    });
    expect(planned.planningSession).toMatchObject({
      attemptId: failedIdentity?.attemptId,
      sessionId: failedIdentity?.sessionId,
      currentRevision: 0,
      status: "awaiting_review",
    });
    expect(
      planned.activity.some((entry) =>
        entry.message.includes("Auto-retrying an effect-free terminal-contract failure"),
      ),
    ).toBe(true);
    client.close();
  }, 30_000);

  it("bounds automatic planning terminal-contract recovery per revision", async () => {
    const root = await repository();
    const base = fakeProgram();
    const prepareAttempt = base.prepareAttempt.bind(base);
    const recoverAttempt = base.recoverAttempt!.bind(base);
    let plannerLaunches = 0;
    const failingFactory = (spec: AgentLaunchSpec) => {
      plannerLaunches += 1;
      return new InfrastructureFailingAdapter(
        spec,
        "terminal_protocol",
        "agent settled without calling terminal tool koni_submit_output",
      );
    };
    const program: RunCompilerProgram = {
      ...base,
      async prepareAttempt(input) {
        const prepared = await prepareAttempt(input);
        if (input.kind !== "planning") return prepared;
        return { ...prepared, factory: async () => failingFactory(prepared.spec) };
      },
      async recoverAttempt(input) {
        const prepared = await recoverAttempt(input);
        return { ...prepared, factory: async () => failingFactory(prepared.spec) };
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });

    const created = await client.request(
      "run.create",
      {
        objective: "Bound repeated planning terminal failures",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Bound repeated planning terminal failures" },
      },
      { expectedRevision: 0, idempotencyKey: "create-bounded-terminal-planning-run" },
    );
    const runId = (created.result as { runId: string }).runId;
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return (
        current.lifecycle.phase === "blocked" &&
        current.activity.filter((entry) =>
          entry.message.includes("Auto-retrying an effect-free terminal-contract failure"),
        ).length === 3
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const blocked = await engine.store.getRun(runId);
    expect(plannerLaunches).toBe(4);
    expect(
      Object.values(blocked.attempts).filter((attempt) => attempt.kind === "planning"),
    ).toEqual([expect.objectContaining({ status: "failed", failureCode: "terminal_protocol" })]);
    expect(blocked.planningSession).toMatchObject({ currentRevision: 0, status: "blocked" });
    client.close();
  }, 30_000);

  it("scopes terminal-contract recovery to the failed lane and preserves active siblings", () => {
    const failedLead = {
      id: "attempt-lead-current",
      kind: "lead",
      ticketId: "run-orchestration",
      stepId: "lead-compiler-deadlock",
      status: "failed",
      failureCode: "terminal_protocol",
    } as AgentAttemptRecord;
    const activeSibling = {
      id: "attempt-ticket-active",
      kind: "ticket",
      ticketId: "ticket-active",
      stepId: "implement",
      status: "running",
    } as AgentAttemptRecord;
    const historicalFailures = Object.fromEntries(
      ["inspect", "implement", "review"].map((stepId, index) => {
        const attempt = {
          id: `attempt-historical-${index}`,
          kind: "ticket",
          ticketId: `ticket-historical-${index}`,
          stepId,
          status: "failed",
          failureCode: "terminal_protocol",
        } as AgentAttemptRecord;
        return [attempt.id, attempt];
      }),
    );
    const run = {
      attempts: {
        ...historicalFailures,
        [failedLead.id]: failedLead,
        [activeSibling.id]: activeSibling,
      },
      tickets: {},
    } as unknown as RunRecord;

    expect(terminalProtocolRecoveryCount(run, failedLead)).toBe(1);
    expect(hasProviderCapableSiblingAttempt(run, failedLead.id)).toBe(true);
    expect(shouldDeferBlockedLeadDisposition(run, failedLead.id, "blocked")).toBe(true);
    expect(shouldDeferBlockedLeadDisposition(run, failedLead.id, "proceed")).toBe(false);
    activeSibling.status = "completed";
    expect(hasProviderCapableSiblingAttempt(run, failedLead.id)).toBe(false);
    expect(shouldDeferBlockedLeadDisposition(run, failedLead.id, "blocked")).toBe(false);

    const failedPlanner = {
      id: "attempt-planning-stable",
      kind: "planning",
      ticketId: "run-planning",
      stepId: "combined-plan",
      status: "failed",
      failureCode: "terminal_protocol",
    } as AgentAttemptRecord;
    const revisionZeroRecovery =
      "Auto-retrying an effect-free terminal-contract failure in planning revision 0 with the same authenticated session";
    const revisionOneRecovery =
      "Auto-retrying an effect-free terminal-contract failure in planning revision 1 with the same authenticated session";
    const continuousPlanningRun = {
      attempts: { [failedPlanner.id]: failedPlanner },
      planningSession: { attemptId: failedPlanner.id, currentRevision: 1 },
      activity: [
        ...Array.from({ length: 3 }, () => ({ message: revisionZeroRecovery })),
        { message: revisionOneRecovery },
      ],
    } as unknown as RunRecord;
    expect(terminalProtocolRecoveryCount(continuousPlanningRun, failedPlanner)).toBe(2);
  });

  it("keeps independent ticket work executable while a sibling terminal failure recovers", async () => {
    const root = await repository();
    const base = directApprovalProgram();
    const prepareAttempt = base.prepareAttempt.bind(base);
    let failTicketOne = true;
    const program: RunCompilerProgram = {
      ...base,
      async resolveRun(request) {
        const resolved = await base.resolveRun(request);
        return {
          ...resolved,
          executionConfig: { ...resolved.executionConfig, maxParallel: 2 },
        };
      },
      async initializeApprovedPlan() {
        const first = ticket();
        const second = structuredClone(first);
        second.id = "ticket-two";
        second.title = "Implement independent feature";
        second.targetNodeIds = ["change-two"];
        second.writePaths = ["CHANGELOG.md"];
        return {
          graphHash: `sha256:${"c".repeat(64)}`,
          graphRevision: 1,
          tickets: { [first.id]: first, [second.id]: second },
        };
      },
      async prepareAttempt(input) {
        const prepared = await prepareAttempt(input);
        if (
          input.kind !== "ticket" ||
          input.assignment?.ticketId !== "ticket-one" ||
          !failTicketOne
        ) {
          return prepared;
        }
        failTicketOne = false;
        return {
          ...prepared,
          factory: async () =>
            new InfrastructureFailingAdapter(
              prepared.spec,
              "terminal_protocol",
              "agent settled without calling terminal tool koni_submit_output",
            ),
        };
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "independent-ticket-failure");

    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return current.lifecycle.phase === "merge_ready";
    });
    const current = await engine.store.getRun(runId);
    expect(current.tickets["ticket-one"]).toMatchObject({ status: "completed" });
    expect(current.tickets["ticket-two"]).toMatchObject({ status: "completed" });
    const firstTicketAttempts = Object.values(current.attempts).filter(
      (attempt) => attempt.ticketId === "ticket-one",
    );
    expect(firstTicketAttempts).toHaveLength(2);
    expect(firstTicketAttempts.some((attempt) => attempt.failureCode === "terminal_protocol")).toBe(
      true,
    );
    client.close();
  }, 30_000);

  it("live recovery closes a settled terminal cursor when its original finalizer is lost", async () => {
    const root = await repository();
    const base = configuredValidationDirectProgram();
    const prepareAttempt = base.prepareAttempt.bind(base);
    const finalizationReached = deferred<void>();
    const releaseOriginalFinalizer = deferred<void>();
    let failSiblingOnce = true;
    const program: RunCompilerProgram = {
      ...base,
      async resolveRun(request) {
        const resolved = await base.resolveRun(request);
        return {
          ...resolved,
          executionConfig: { ...resolved.executionConfig, maxParallel: 2 },
        };
      },
      async initializeApprovedPlan() {
        const first = ticket();
        first.steps[0]!.validationAction = "compile";
        first.readPaths = ["README.md"];
        const sibling = structuredClone(first);
        sibling.id = "ticket-two";
        sibling.title = "Recover independent feature";
        sibling.targetNodeIds = ["change-two"];
        sibling.readPaths = ["CHANGELOG.md"];
        sibling.writePaths = ["CHANGELOG.md"];
        return {
          graphHash: `sha256:${"c".repeat(64)}`,
          graphRevision: 1,
          tickets: { [first.id]: first, [sibling.id]: sibling },
        };
      },
      async prepareAttempt(input) {
        const prepared = await prepareAttempt(input);
        if (input.kind === "ticket" && input.assignment?.ticketId === "ticket-one") {
          return {
            ...prepared,
            factory: async () =>
              new UsageCompletingAdapter(prepared.spec, input.kind, {
                input: 17,
                output: 5,
                cacheRead: 11,
                cacheWrite: 3,
              }),
          };
        }
        if (
          input.kind !== "ticket" ||
          input.assignment?.ticketId !== "ticket-two" ||
          !failSiblingOnce
        ) {
          return prepared;
        }
        failSiblingOnce = false;
        return {
          ...prepared,
          factory: async () =>
            new GatedInfrastructureFailingAdapter(
              prepared.spec,
              finalizationReached.promise,
              "terminal_protocol",
              "agent settled without calling terminal tool koni_submit_output",
            ),
        };
      },
    };
    const supervisor = new ManagedSessionSupervisor();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor,
      actionFault: async (point, input) => {
        if (point !== "before_attempt_finalize" || input.ticketId !== "ticket-one") return;
        finalizationReached.resolve();
        await releaseOriginalFinalizer.promise;
      },
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    try {
      const runId = await createAndApproveDirectRun(
        client,
        engine,
        "live-settled-terminal-recovery",
      );
      await finalizationReached.promise;
      try {
        await waitFor(async () => {
          const current = await engine.store.getRun(runId);
          const first = Object.values(current.attempts).find(
            (attempt) => attempt.ticketId === "ticket-one",
          );
          const siblingAttempts = Object.values(current.attempts).filter(
            (attempt) => attempt.ticketId === "ticket-two",
          );
          return (
            first?.status === "completed" &&
            siblingAttempts.length === 2 &&
            siblingAttempts.some((attempt) => attempt.status === "completed")
          );
        });
      } catch (error) {
        const current = await engine.store.getRun(runId);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; ${JSON.stringify({
            phase: current.lifecycle.phase,
            blocker: current.lifecycle.blocker,
            attempts: Object.values(current.attempts).map((attempt) => ({
              id: attempt.id,
              ticketId: attempt.ticketId,
              status: attempt.status,
              failureCode: attempt.failureCode,
              terminalPolicy: attempt.terminalPolicy?.mode,
            })),
            actions: Object.values(current.actionExecutions ?? {}).map((action) => ({
              kind: action.boundary.kind,
              attemptId: action.boundary.attemptId,
              journal: action.journal.status,
              settlement: action.settlement?.disposition,
              settledAt: action.settledAt,
            })),
            supervisor: supervisor
              .list(runId)
              .map((handle) => handle.session.spec.identity.attemptId),
            activity: current.activity.slice(-8).map((entry) => entry.message),
          })}`,
        );
      }

      const recovered = await engine.store.getRun(runId);
      const recoveredFirst = Object.values(recovered.attempts).find(
        (attempt) => attempt.ticketId === "ticket-one",
      );
      expect(recoveredFirst).toMatchObject({
        inputTokens: 17,
        outputTokens: 5,
        cacheReadTokens: 11,
        cacheWriteTokens: 3,
      });
      expect(
        recovered.activity.some((entry) =>
          entry.message.includes("Auto-retrying an effect-free terminal-contract failure"),
        ),
      ).toBe(true);
      expect(recovered.tickets["ticket-one"]?.steps[0]).toMatchObject({ status: "completed" });
      expect(recovered.tickets["ticket-two"]?.steps[0]).toMatchObject({ status: "completed" });
    } finally {
      releaseOriginalFinalizer.resolve();
      client.close();
    }
  }, 30_000);

  it("live terminal recovery preserves the exhausted-review change-request boundary", async () => {
    const root = await repository();
    const base = configuredValidationDirectProgram();
    const prepareAttempt = base.prepareAttempt.bind(base);
    const finalizationReached = deferred<void>();
    const releaseOriginalFinalizer = deferred<void>();
    let exhaustedReviewAttemptId: string | undefined;
    let ticketOneFinalizations = 0;
    let failSiblingOnce = true;
    const program: RunCompilerProgram = {
      ...base,
      async resolveRun(request) {
        const resolved = await base.resolveRun(request);
        return {
          ...resolved,
          executionConfig: { ...resolved.executionConfig, maxParallel: 2 },
        };
      },
      async initializeApprovedPlan() {
        const reviewed = reviewTicket();
        reviewed.steps.forEach((step) => {
          step.validationAction = "compile";
        });
        reviewed.readPaths = ["README.md"];
        const sibling = ticket();
        sibling.id = "ticket-two";
        sibling.title = "Recover independent feature";
        sibling.targetNodeIds = ["change-two"];
        sibling.readPaths = ["CHANGELOG.md"];
        sibling.writePaths = ["CHANGELOG.md"];
        const dependent = ticket();
        dependent.id = "ticket-dependent";
        dependent.title = "Publish reviewed result";
        dependent.dependencyIds = [reviewed.id];
        dependent.targetNodeIds = ["change-dependent"];
        dependent.readPaths = ["README.md"];
        dependent.writePaths = ["REPORT.md"];
        return {
          graphHash: `sha256:${"c".repeat(64)}`,
          graphRevision: 1,
          tickets: {
            [reviewed.id]: reviewed,
            [sibling.id]: sibling,
            [dependent.id]: dependent,
          },
        };
      },
      async prepareAttempt(input) {
        const prepared = await prepareAttempt(input);
        if (
          input.kind !== "ticket" ||
          input.assignment?.ticketId !== "ticket-two" ||
          !failSiblingOnce
        ) {
          return prepared;
        }
        failSiblingOnce = false;
        return {
          ...prepared,
          factory: async () =>
            new GatedInfrastructureFailingAdapter(
              prepared.spec,
              finalizationReached.promise,
              "terminal_protocol",
              "agent settled without calling terminal tool koni_submit_output",
            ),
        };
      },
      async compileAssignmentOutput({ run, assignment }) {
        if (assignment.stepId === "review") {
          return {
            outcome: {
              status: "failed" as const,
              blocker:
                run.tickets[assignment.ticketId]?.reviewReworkCount === 0
                  ? "First independent review found a correctable route gap"
                  : "Second independent review still found a material route gap",
            },
          };
        }
        return { outcome: { status: "completed" as const, summary: "Implemented feature" } };
      },
    };
    const supervisor = new ManagedSessionSupervisor();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor,
      actionFault: async (point, input) => {
        if (point !== "before_attempt_finalize" || input.ticketId !== "ticket-one") return;
        ticketOneFinalizations += 1;
        if (ticketOneFinalizations !== 4) return;
        exhaustedReviewAttemptId = input.attemptId;
        finalizationReached.resolve();
        await releaseOriginalFinalizer.promise;
      },
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    try {
      const runId = await createAndApproveDirectRun(
        client,
        engine,
        "lost-exhausted-review-finalizer",
      );
      await finalizationReached.promise;
      await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "blocked");

      const blocked = await engine.store.getRun(runId);
      expect(blocked.lifecycle).toMatchObject({
        phase: "blocked",
        blocker: "Second independent review still found a material route gap",
        blockerRemedy: "change_request",
      });
      expect(blocked.attempts[exhaustedReviewAttemptId!]).toMatchObject({ status: "completed" });
      expect(
        blocked.activity.some((entry) =>
          entry.message.includes("Independent review exhausted automatic rework"),
        ),
      ).toBe(true);
      expect(
        Object.values(blocked.attempts).filter(
          (attempt) => attempt.ticketId === "ticket-dependent",
        ),
      ).toEqual([]);
    } finally {
      releaseOriginalFinalizer.resolve();
      client.close();
    }
  }, 30_000);

  it("automatically retries a token-budget-aborted ticket once without an operator resume", async () => {
    const root = await repository();
    const base = directApprovalProgram();
    const prepareAttempt = base.prepareAttempt.bind(base);
    let exhaustFirstTicket = true;
    const program: RunCompilerProgram = {
      ...base,
      async prepareAttempt(input) {
        const prepared = await prepareAttempt(input);
        if (input.kind !== "ticket" || !exhaustFirstTicket) return prepared;
        exhaustFirstTicket = false;
        return {
          ...prepared,
          factory: async () => new BudgetExhaustingAdapter(prepared.spec),
        };
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(
      client,
      engine,
      "operator-confirmed-budget-abort-retry",
    );
    await waitFor(async () =>
      Object.values((await engine.store.getRun(runId)).attempts).some(
        (attempt) => attempt.kind === "ticket" && attempt.status === "aborted",
      ),
    );

    const blocked = await engine.store.getRun(runId);
    const first = Object.values(blocked.attempts).find((attempt) => attempt.kind === "ticket")!;
    expect(first).toMatchObject({ status: "aborted", error: "input token budget exceeded" });
    expect(first.terminalAcceptedAt).toBeUndefined();
    expect(first.terminalOutputSha256).toBeUndefined();
    const firstSpec = validateAgentLaunchSpec(
      JSON.parse(
        (
          await engine.store.readArtifact(
            `runs/${runId}/attempts/${first.id}/launch-spec.json`,
            16 * 1024 * 1024,
          )
        ).toString("utf8"),
      ) as AgentLaunchSpec,
    );
    await expect(
      readAutonomousPiTranscriptPage(first.sessionFile!, {
        sessionId: first.sessionId,
        cwd: firstSpec.workspace.cwd,
      }),
    ).resolves.toMatchObject({ snapshot: { lastEntryId: "budget-anchor" } });

    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return (
        current.lifecycle.phase === "merge_ready" &&
        Object.values(current.attempts).filter((attempt) => attempt.kind === "ticket").length === 2
      );
    });

    const ready = await engine.store.getRun(runId);
    const attempts = Object.values(ready.attempts)
      .filter((attempt) => attempt.kind === "ticket")
      .sort((left, right) => (left.lineage?.branchEpoch ?? 0) - (right.lineage?.branchEpoch ?? 0));
    expect(attempts[0]).toMatchObject({ id: first.id, status: "aborted" });
    expect(attempts[1]).toMatchObject({
      status: "completed",
      lineage: {
        branchEpoch: 1,
        reason: "recovery",
        parentAttemptId: first.id,
        parentSessionId: first.sessionId,
      },
    });
    expect(attempts[1]!.lineage?.conversationFork).toMatchObject({
      parentLaunchSpecHash: first.launchSpecHash,
    });
    expect(attempts[0]!.tokenBudgetRecovery).toMatchObject({
      protocol: "koni.agent-token-budget-recovery.v1",
      failedAttemptId: attempts[0]!.id,
      ticketId: attempts[0]!.ticketId,
      stepId: attempts[0]!.stepId,
      ticketExecutionEpoch: 0,
    });
    expect(() => assertRunRecord(structuredClone(ready))).not.toThrow();
    const tamperedRecovery = structuredClone(ready);
    tamperedRecovery.attempts[attempts[0]!.id]!.tokenBudgetRecovery!.recoveredAt =
      "2026-08-12T00:00:00.000Z";
    expect(() => assertRunRecord(tamperedRecovery)).toThrow(/token-budget recovery/u);
    const unknownField = structuredClone(ready) as RunRecord & {
      attempts: Record<
        string,
        AgentAttemptRecord & { tokenBudgetRecovery?: Record<string, unknown> }
      >;
    };
    unknownField.attempts[attempts[0]!.id]!.tokenBudgetRecovery!.unexpected = true;
    expect(() => assertRunRecord(unknownField)).toThrow(/token-budget recovery/u);

    const deletedMarker = structuredClone(ready);
    delete deletedMarker.attempts[attempts[0]!.id]!.tokenBudgetRecovery;
    expect(() => assertRunExecutionControlMutation(ready, deletedMarker)).toThrow(
      /rewrote token-budget recovery authority/u,
    );
    const rewrittenMarker = structuredClone(ready);
    const rewritten = rewrittenMarker.attempts[attempts[0]!.id]!.tokenBudgetRecovery!;
    rewritten.recoveredAt = "2026-08-12T00:00:00.000Z";
    const { sha256: _priorSha256, ...rewrittenMaterial } = rewritten;
    rewritten.sha256 = canonicalHash(rewrittenMaterial);
    expect(() => assertRunExecutionControlMutation(ready, rewrittenMarker)).toThrow(
      /rewrote token-budget recovery authority/u,
    );
    const previousWithoutMarker = structuredClone(ready);
    delete previousWithoutMarker.attempts[attempts[0]!.id]!.tokenBudgetRecovery;
    expect(() => assertRunExecutionControlMutation(previousWithoutMarker, ready)).toThrow(
      /without exact failed assignment/u,
    );

    const commitRejectedMutation = async (
      mutate: (draft: RunRecord) => void,
      expected: RegExp,
    ): Promise<void> => {
      const state = await engine.store.state();
      const current = await engine.store.getRun(runId);
      const draft = structuredClone(current);
      draft.revision += 1;
      draft.updatedAt = "2026-08-12T00:00:00.000Z";
      mutate(draft);
      await expect(
        engine.store.commit({
          expectedRevision: state.revision,
          runWrites: [{ record: draft, expectedRevision: current.revision }],
        }),
      ).rejects.toThrow(expected);
    };
    await commitRejectedMutation((draft) => {
      delete draft.attempts[attempts[0]!.id]!.tokenBudgetRecovery;
    }, /rewrote token-budget recovery authority/u);
    await commitRejectedMutation((draft) => {
      const recovery = draft.attempts[attempts[0]!.id]!.tokenBudgetRecovery!;
      recovery.recoveredAt = draft.updatedAt;
      const { sha256: _sha256, ...material } = recovery;
      recovery.sha256 = canonicalHash(material);
    }, /rewrote token-budget recovery authority/u);
    await commitRejectedMutation((draft) => {
      const completed = draft.attempts[attempts[1]!.id]!;
      const material = {
        protocol: "koni.agent-token-budget-recovery.v1" as const,
        failedAttemptId: completed.id,
        ticketId: completed.ticketId,
        stepId: completed.stepId,
        ...(completed.ticketExecutionEpoch === undefined
          ? {}
          : { ticketExecutionEpoch: completed.ticketExecutionEpoch }),
        recoveredAt: draft.updatedAt,
      };
      completed.tokenBudgetRecovery = { ...material, sha256: canonicalHash(material) };
    }, /without exact failed assignment/u);
    expect(
      ready.activity.some(
        (entry) =>
          entry.message ===
          "Automatically retrying Implement feature step implement after bounded token-budget recovery",
      ),
    ).toBe(true);
    client.close();
  });

  it("rejects direct recovery authority after the current execution slice already spent it", async () => {
    const root = await repository();
    const base = directApprovalProgram();
    const prepareAttempt = base.prepareAttempt.bind(base);
    let exhausted = 0;
    const program: RunCompilerProgram = {
      ...base,
      async prepareAttempt(input) {
        const prepared = await prepareAttempt(input);
        if (input.kind !== "ticket" || exhausted >= 2) return prepared;
        exhausted += 1;
        return {
          ...prepared,
          factory: async () => new BudgetExhaustingAdapter(prepared.spec),
        };
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "same-slice-recovery-cap");
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return (
        current.tickets["ticket-one"]?.status === "blocked" &&
        Object.values(current.attempts).filter(
          (attempt) => attempt.kind === "ticket" && attempt.stepId === "implement",
        ).length === 2
      );
    });
    const current = await engine.store.getRun(runId);
    const state = await engine.store.state();
    const attempts = Object.values(current.attempts)
      .filter((attempt) => attempt.kind === "ticket" && attempt.stepId === "implement")
      .sort((left, right) => (left.startedAt ?? "").localeCompare(right.startedAt ?? ""));
    expect(attempts[0]!.tokenBudgetRecovery).toBeDefined();
    expect(attempts[1]!.tokenBudgetRecovery).toBeUndefined();
    const draft = structuredClone(current);
    draft.revision += 1;
    draft.updatedAt = "2026-08-12T12:00:00.000Z";
    const failed = draft.attempts[attempts[1]!.id]!;
    const material = {
      protocol: "koni.agent-token-budget-recovery.v1" as const,
      failedAttemptId: failed.id,
      ticketId: failed.ticketId,
      stepId: failed.stepId,
      ticketExecutionEpoch: failed.ticketExecutionEpoch!,
      recoveredAt: draft.updatedAt,
    };
    failed.tokenBudgetRecovery = { ...material, sha256: canonicalHash(material) };
    const ticket = draft.tickets[failed.ticketId]!;
    const step = ticket.steps.find((candidate) => candidate.id === failed.stepId)!;
    ticket.status = "queued";
    ticket.blocker = undefined;
    ticket.updatedAt = draft.updatedAt;
    step.status = "pending";
    step.startedAt = undefined;
    step.completedAt = undefined;
    step.summary = undefined;
    await expect(
      engine.store.commit({
        expectedRevision: state.revision,
        runWrites: [{ record: draft, expectedRevision: current.revision }],
      }),
    ).rejects.toThrow(/without exact failed assignment/u);

    const unsettled = structuredClone(current);
    const unsettledFailure = unsettled.attempts[attempts[1]!.id]!;
    const settledRequests = unsettledFailure.authorityProviderRequests ?? [];
    if (settledRequests.length === 0) {
      unsettledFailure.authorityProviderUsageBaseline = {
        inputTokens: unsettledFailure.inputTokens,
        outputTokens: unsettledFailure.outputTokens,
        cacheReadTokens: unsettledFailure.cacheReadTokens,
        cacheWriteTokens: unsettledFailure.cacheWriteTokens,
        recordedAt: "2026-08-12T11:58:00.000Z",
      };
    }
    unsettledFailure.authorityProviderRequests = [
      ...settledRequests,
      {
        sequence: settledRequests.length + 1,
        reservationId: "reservation-open",
        api: "openai-codex-responses",
        modelId: "gpt-5.6-luna",
        payloadSha256: rawSha256("open provider payload"),
        payloadSizeBytes: 64,
        baselineEntryId: "provider-baseline",
        prospectiveInputTokens: 128,
        reservedOutputTokens: 64,
        reservedAt: "2026-08-12T11:59:00.000Z",
      },
    ];
    const unsettledNext = structuredClone(draft);
    unsettledNext.attempts[attempts[1]!.id]!.authorityProviderRequests = structuredClone(
      unsettledFailure.authorityProviderRequests,
    );
    if (unsettledFailure.authorityProviderUsageBaseline !== undefined) {
      unsettledNext.attempts[attempts[1]!.id]!.authorityProviderUsageBaseline = structuredClone(
        unsettledFailure.authorityProviderUsageBaseline,
      );
    }
    expect(() => assertRunExecutionControlMutation(unsettled, unsettledNext)).toThrow(
      /without exact failed assignment/u,
    );
    client.close();
  }, 30_000);

  it("bounds automatic token-budget recovery per workflow step rather than per ticket", async () => {
    const root = await repository();
    const base = directApprovalProgram();
    const prepareAttempt = base.prepareAttempt.bind(base);
    const exhaustedSteps = new Set<string>();
    const program: RunCompilerProgram = {
      ...base,
      async initializeApprovedPlan() {
        const configured = ticket();
        configured.steps.unshift({
          id: "inspect",
          title: "Inspect",
          personaId: "inspector",
          kind: "production",
          status: "pending",
          attemptIds: [],
          summary: undefined,
          startedAt: undefined,
          completedAt: undefined,
        });
        configured.steps[1]!.dependsOn = ["inspect"];
        return {
          graphHash: `sha256:${"c".repeat(64)}`,
          graphRevision: 1,
          tickets: { [configured.id]: configured },
        };
      },
      async prepareAttempt(input) {
        const prepared = await prepareAttempt(input);
        const stepId = input.assignment?.stepId;
        if (input.kind !== "ticket" || stepId === undefined || exhaustedSteps.has(stepId)) {
          return prepared;
        }
        exhaustedSteps.add(stepId);
        return {
          ...prepared,
          factory: async () => new BudgetExhaustingAdapter(prepared.spec),
        };
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "per-step-budget-abort-retry");

    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "merge_ready");
    const ready = await engine.store.getRun(runId);
    for (const stepId of ["inspect", "implement"]) {
      const attempts = Object.values(ready.attempts)
        .filter((attempt) => attempt.kind === "ticket" && attempt.stepId === stepId)
        .sort(
          (left, right) => (left.lineage?.branchEpoch ?? 0) - (right.lineage?.branchEpoch ?? 0),
        );
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({
        status: "aborted",
        error: "input token budget exceeded",
      });
      expect(attempts[1]).toMatchObject({
        status: "completed",
        lineage: {
          reason: "recovery",
          parentAttemptId: attempts[0]!.id,
        },
      });
      expect(attempts[1]!.lineage?.conversationFork).toMatchObject({
        parentLaunchSpecHash: attempts[0]!.launchSpecHash,
      });
    }
    client.close();
  }, 30_000);

  it("renews bounded token-budget recovery when the compiler reissues a ticket in a new execution epoch", async () => {
    const root = await repository();
    const base = directApprovalProgram();
    const prepareAttempt = base.prepareAttempt.bind(base);
    const exhaustedEpochs = new Set<number>();
    let rediscoveries = 0;
    const program: RunCompilerProgram = {
      ...base,
      async prepareAttempt(input) {
        const prepared = await prepareAttempt(input);
        const ticketId = input.assignment?.ticketId;
        if (input.kind !== "ticket" || ticketId === undefined) return prepared;
        const epoch = input.run.tickets[ticketId]?.executionEpoch ?? 0;
        if (exhaustedEpochs.has(epoch)) return prepared;
        exhaustedEpochs.add(epoch);
        return {
          ...prepared,
          factory: async () => new BudgetExhaustingAdapter(prepared.spec),
        };
      },
      async verifyRun(run) {
        if (rediscoveries === 0 && run.tickets["ticket-one"]?.status === "completed") {
          rediscoveries += 1;
          return {
            ok: false,
            reason: "Verification found 1 still-applicable compiler ticket: Execute work",
            tickets: structuredClone(run.tickets),
            applicableTicketIds: ["ticket-one"],
          };
        }
        return base.verifyRun(run);
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(
      client,
      engine,
      "reissued-ticket-budget-abort-retry",
    );

    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "merge_ready");
    const ready = await engine.store.getRun(runId);
    const attempts = Object.values(ready.attempts).filter(
      (attempt) => attempt.kind === "ticket" && attempt.stepId === "implement",
    );
    expect(rediscoveries).toBe(1);
    expect(exhaustedEpochs).toEqual(new Set([0, 1]));
    expect(attempts).toHaveLength(4);
    for (const epoch of [0, 1]) {
      const epochAttempts = attempts.filter((attempt) => attempt.ticketExecutionEpoch === epoch);
      expect(epochAttempts).toHaveLength(2);
      expect(epochAttempts.some((attempt) => attempt.status === "aborted")).toBe(true);
      expect(epochAttempts.some((attempt) => attempt.status === "completed")).toBe(true);
    }
    client.close();
  }, 30_000);

  it("bounds token-budget recovery across repeated ticket execution epochs", async () => {
    const root = await repository();
    const base = directApprovalProgram();
    const prepareAttempt = base.prepareAttempt.bind(base);
    const exhaustedEpochs = new Set<number>();
    let rediscoveries = 0;
    const program: RunCompilerProgram = {
      ...base,
      async prepareAttempt(input) {
        const prepared = await prepareAttempt(input);
        const ticketId = input.assignment?.ticketId;
        if (input.kind !== "ticket" || ticketId === undefined) return prepared;
        const epoch = input.run.tickets[ticketId]?.executionEpoch ?? 0;
        if (exhaustedEpochs.has(epoch)) return prepared;
        exhaustedEpochs.add(epoch);
        return {
          ...prepared,
          factory: async () => new BudgetExhaustingAdapter(prepared.spec),
        };
      },
      async verifyRun(run) {
        if (rediscoveries < 3 && run.tickets["ticket-one"]?.status === "completed") {
          rediscoveries += 1;
          return {
            ok: false,
            reason: "Verification found a still-applicable compiler ticket",
            tickets: structuredClone(run.tickets),
            applicableTicketIds: ["ticket-one"],
          };
        }
        return base.verifyRun(run);
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(
      client,
      engine,
      "bounded-reissued-ticket-budget-abort-retry",
    );

    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return (
        current.tickets["ticket-one"]?.status === "blocked" &&
        Object.values(current.attempts).some(
          (attempt) =>
            attempt.ticketExecutionEpoch === 3 &&
            attempt.status === "aborted" &&
            attempt.error === "input token budget exceeded",
        )
      );
    });
    const blocked = await engine.store.getRun(runId);
    const attempts = Object.values(blocked.attempts).filter(
      (attempt) => attempt.kind === "ticket" && attempt.stepId === "implement",
    );
    expect(rediscoveries).toBe(3);
    expect(exhaustedEpochs).toEqual(new Set([0, 1, 2, 3]));
    expect(attempts).toHaveLength(7);
    expect(attempts.filter((attempt) => attempt.tokenBudgetRecovery !== undefined)).toHaveLength(3);
    expect(
      attempts.find((attempt) => attempt.ticketExecutionEpoch === 3 && attempt.status === "aborted")
        ?.tokenBudgetRecovery,
    ).toBeUndefined();
    const state = await engine.store.state();
    const draft = structuredClone(blocked);
    draft.revision += 1;
    draft.updatedAt = "2026-08-12T13:00:00.000Z";
    const failed = Object.values(draft.attempts).find(
      (attempt) => attempt.ticketExecutionEpoch === 3 && attempt.status === "aborted",
    )!;
    const material = {
      protocol: "koni.agent-token-budget-recovery.v1" as const,
      failedAttemptId: failed.id,
      ticketId: failed.ticketId,
      stepId: failed.stepId,
      ticketExecutionEpoch: 3,
      recoveredAt: draft.updatedAt,
    };
    failed.tokenBudgetRecovery = { ...material, sha256: canonicalHash(material) };
    const ticket = draft.tickets[failed.ticketId]!;
    const step = ticket.steps.find((candidate) => candidate.id === failed.stepId)!;
    ticket.status = "queued";
    ticket.blocker = undefined;
    ticket.updatedAt = draft.updatedAt;
    step.status = "pending";
    step.startedAt = undefined;
    step.completedAt = undefined;
    step.summary = undefined;
    await expect(
      engine.store.commit({
        expectedRevision: state.revision,
        runWrites: [{ record: draft, expectedRevision: blocked.revision }],
      }),
    ).rejects.toThrow(/without exact failed assignment/u);
    client.close();
  }, 30_000);

  it("renews bounded token-budget recovery for an explicitly reopened review-rework slice", async () => {
    const root = await repository();
    const base = reviewReworkProgram();
    const prepareAttempt = base.prepareAttempt.bind(base);
    let exhaustedInitialAuthor = false;
    let exhaustedReworkAuthor = false;
    const program: RunCompilerProgram = {
      ...base,
      async prepareAttempt(input) {
        const prepared = await prepareAttempt(input);
        if (input.kind !== "ticket" || input.assignment?.stepId !== "implement") return prepared;
        const inReviewRework =
          (input.run.tickets[input.assignment.ticketId]?.reviewReworks?.length ?? 0) > 0;
        if (
          (!inReviewRework && exhaustedInitialAuthor) ||
          (inReviewRework && exhaustedReworkAuthor)
        ) {
          return prepared;
        }
        if (inReviewRework) exhaustedReworkAuthor = true;
        else exhaustedInitialAuthor = true;
        return {
          ...prepared,
          factory: async () => new BudgetExhaustingAdapter(prepared.spec),
        };
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(
      client,
      engine,
      "review-rework-budget-abort-retry",
    );

    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "merge_ready");
    const ready = await engine.store.getRun(runId);
    const ticket = ready.tickets["ticket-one"]!;
    const implementation = ticket.steps.find((step) => step.id === "implement")!;
    const review = ticket.steps.find((step) => step.id === "review")!;
    expect(implementation.attemptIds).toHaveLength(4);
    expect(review.attemptIds).toHaveLength(2);
    expect(implementation.attemptIds.map((attemptId) => ready.attempts[attemptId]?.status)).toEqual(
      ["aborted", "completed", "aborted", "completed"],
    );
    expect(
      ready.attempts[implementation.attemptIds[2]!]!.lineage?.conversationFork,
    ).toBeUndefined();
    expect(ready.attempts[implementation.attemptIds[3]!]!.lineage?.conversationFork).toMatchObject({
      parentLaunchSpecHash: ready.attempts[implementation.attemptIds[2]!]!.launchSpecHash,
    });
    expect(ticket.reviewReworks?.map((record) => record.mode)).toEqual(["automatic"]);
    expect(
      ready.attempts[implementation.attemptIds[2]!]!.tokenBudgetRecovery?.reviewReworkOrdinal,
    ).toBe(1);

    const laterRework = structuredClone(ready);
    const laterTicket = laterRework.tickets["ticket-one"]!;
    laterTicket.reviewReworkLimit = 2;
    laterTicket.reviewReworkCount = 2;
    laterTicket.reviewReworks!.push({
      ordinal: 2,
      mode: "automatic",
      scope: "producer_and_review",
      failedReviewAttemptId: review.attemptIds.at(-1)!,
      reopenFromStepId: laterTicket.reviewFailureReopenFrom!,
      blocker: "A later review opened another bounded semantic slice",
      openedAt: "2026-08-12T11:00:00.000Z",
    });
    expect(() => assertRunRecord(laterRework)).not.toThrow();

    const freshEpoch = structuredClone(ready);
    const freshTicket = freshEpoch.tickets["ticket-one"]!;
    freshTicket.executionEpoch = (freshTicket.executionEpoch ?? 0) + 1;
    freshTicket.reviewReworkCount = 0;
    freshTicket.reviewReworks = [];
    expect(() => assertRunRecord(freshEpoch)).not.toThrow();
    client.close();
  }, 30_000);

  it("does not reinterpret compiler-reviewed semantic failure as retryable infrastructure", async () => {
    const root = await repository();
    const base = directApprovalProgram();
    const program: RunCompilerProgram = {
      ...base,
      async compileAssignmentOutput() {
        return {
          outcome: {
            status: "failed",
            blocker: "Implementation did not satisfy the compiled contract",
          },
        };
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "semantic-ticket-failure");
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "blocked");

    const blocked = await engine.store.getRun(runId);
    const originalTicketAttempts = Object.values(blocked.attempts)
      .filter((attempt) => attempt.kind === "ticket")
      .map((attempt) => attempt.id);
    expect(originalTicketAttempts).toHaveLength(1);
    expect(blocked.attempts[originalTicketAttempts[0]!]!.status).toBe("completed");

    await client.request("authority.ping");
    await client.request(
      "run.resume",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "do-not-retry-semantic-ticket-failure",
      },
    );
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return current.lifecycle.phase === "blocked" && current.revision > blocked.revision;
    });

    const stillBlocked = await engine.store.getRun(runId);
    expect(
      Object.values(stillBlocked.attempts)
        .filter((attempt) => attempt.kind === "ticket")
        .map((attempt) => attempt.id),
    ).toEqual(originalTicketAttempts);
    expect(stillBlocked.tickets["ticket-one"]).toMatchObject({
      status: "blocked",
      blocker: "Implementation did not satisfy the compiled contract",
    });
    expect(
      stillBlocked.activity.some((entry) =>
        entry.message.includes("operator-confirmed runtime recovery"),
      ),
    ).toBe(false);
    client.close();
  });

  it("archives and cancels failed work when the current compiler predicate becomes false", async () => {
    const root = await repository();
    const base = directApprovalProgram();
    let predicateApplies = true;
    const program: RunCompilerProgram = {
      ...base,
      async reconcileTicketBoard(run) {
        return {
          tickets: structuredClone(run.tickets),
          applicableTicketIds: predicateApplies ? ["ticket-one"] : [],
        };
      },
      async compileAssignmentOutput() {
        return {
          outcome: { status: "failed", blocker: "The old predicate no longer describes work" },
        };
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "retire-obsolete-failure");
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "blocked");
    const blocked = await engine.store.getRun(runId);
    const cycleId = blocked.tickets["ticket-one"]!.gitCycleId!;
    const attemptIds = Object.values(blocked.attempts)
      .filter((attempt) => attempt.ticketId === "ticket-one")
      .map((attempt) => attempt.id);
    expect(attemptIds).toHaveLength(1);

    predicateApplies = false;
    await client.request("authority.ping");
    await client.request(
      "run.resume",
      { runId },
      { expectedRevision: client.revision, idempotencyKey: "retire-obsolete-failure" },
    );
    await waitFor(async () => {
      const run = await engine.store.getRun(runId);
      return run.tickets["ticket-one"]?.status === "cancelled";
    });

    const retired = await engine.store.getRun(runId);
    expect(retired.tickets["ticket-one"]).toMatchObject({
      status: "cancelled",
      blocker: "Current compiler predicate no longer applies after prior execution",
    });
    expect(retired.tickets["ticket-one"]!.gitCycleId).toBeUndefined();
    expect(retired.git.ticketCycles[cycleId]).toMatchObject({
      status: "retired",
      archiveRef: expect.stringContaining("refs/koni/archive/"),
    });
    expect(
      Object.values(retired.attempts)
        .filter((attempt) => attempt.ticketId === "ticket-one")
        .map((attempt) => attempt.id),
    ).toEqual(attemptIds);
    expect(() => assertRunRecord(structuredClone(retired))).not.toThrow();
    client.close();
  });

  it("keeps a retried independent reviewer in the authenticated run lineage", async () => {
    const root = await repository();
    const base = directApprovalProgram();
    let reviewPass = 0;
    const program: RunCompilerProgram = {
      ...base,
      async resolveRun(request) {
        const resolved = await base.resolveRun(request);
        const pipeline = [...resolved.behavior.runType.pipeline];
        const reportIndex = pipeline.findIndex(
          (stage) =>
            stage.kind === "action" &&
            stage.config.kind === "action" &&
            stage.config.action === "report",
        );
        pipeline.splice(reportIndex, 0, {
          id: "independent-check",
          title: "Independent Check",
          kind: "agent_review",
          config: {
            kind: "agent",
            persona: "lead",
            prompt: "Review the exact checkpointed product.",
          },
        });
        const behavior = behaviorSnapshotWithPipeline(resolved.behavior, pipeline);
        return {
          ...resolved,
          behavior,
          pipelineStageIds: pipeline.map((stage) => stage.id),
          pipelineStages: projectedBehaviorPipeline(behavior),
        };
      },
      async compileVerificationOutput() {
        reviewPass += 1;
        return reviewPass === 1
          ? { outcome: { status: "failed", blocker: "Independent review requested one retry" } }
          : { outcome: { status: "completed", summary: "Independent review passed" } };
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "independent-review-lineage");

    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "blocked");
    const blocked = await engine.store.getRun(runId);
    const first = Object.values(blocked.attempts).find(
      (attempt) =>
        attempt.kind === "verification" && blocked.tickets[attempt.ticketId] === undefined,
    )!;

    await client.request("authority.ping");
    await client.request(
      "run.resume",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "retry-independent-review",
      },
    );
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "merge_ready");
    const ready = await engine.store.getRun(runId);
    const reviewers = Object.values(ready.attempts)
      .filter(
        (attempt) =>
          attempt.kind === "verification" && ready.tickets[attempt.ticketId] === undefined,
      )
      .sort((left, right) => (left.lineage?.branchEpoch ?? 0) - (right.lineage?.branchEpoch ?? 0));
    expect(reviewers).toHaveLength(2);
    expect(reviewers[1]).toMatchObject({
      status: "completed",
      lineage: {
        branchEpoch: 1,
        reason: "rework",
        parentAttemptId: first.id,
        parentSessionId: first.sessionId,
      },
    });
    client.close();
  });

  it("executes exactly one review rework before closing on a fresh passing review", async () => {
    const root = await repository();
    let sequence = 0;
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: reviewReworkProgram(),
      supervisor: new ManagedSessionSupervisor(),
      now: () => new Date(1_784_179_200_000 + sequence * 1_000),
      createId: (kind) => `${kind}-${++sequence}`,
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });

    const created = await client.request(
      "run.create",
      {
        objective: "Implement and independently review the feature",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Implement and independently review the feature" },
      },
      { expectedRevision: 0, idempotencyKey: "create-review-rework" },
    );
    const runId = (created.result as { runId: string }).runId;
    await waitFor(
      async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
    );

    await client.request("authority.ping");
    await client.request(
      "plan.approve",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "approve-review-rework",
      },
    );
    let lastReviewState: RunRecord | undefined;
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      lastReviewState = current;
      if (current.lifecycle.phase === "blocked") {
        throw new Error(
          `review-rework run blocked: ${current.lifecycle.blocker ?? "unknown blocker"}`,
        );
      }
      return current.lifecycle.phase === "merge_ready";
    }).catch((error: unknown) => {
      const state = lastReviewState;
      throw new Error(
        `review-rework did not settle: ${error instanceof Error ? error.message : String(error)}; ` +
          JSON.stringify({
            phase: state?.lifecycle.phase,
            blocker: state?.lifecycle.blocker,
            tickets:
              state === undefined
                ? undefined
                : Object.fromEntries(
                    Object.entries(state.tickets).map(([id, value]) => [
                      id,
                      {
                        status: value.status,
                        reviewReworkCount: value.reviewReworkCount,
                        steps: value.steps.map((step) => ({
                          id: step.id,
                          status: step.status,
                          attempts: step.attemptIds,
                        })),
                      },
                    ]),
                  ),
            attempts:
              state === undefined
                ? undefined
                : Object.fromEntries(
                    Object.entries(state.attempts).map(([id, value]) => [
                      id,
                      {
                        kind: value.kind,
                        status: value.status,
                        stepId: value.stepId,
                        error: value.error,
                      },
                    ]),
                  ),
          }),
      );
    });

    const ready = await engine.store.getRun(runId);
    const settled = ready.tickets["ticket-one"]!;
    expect(settled.reviewReworkCount).toBe(1);
    expect(settled.reviewReworks).toEqual([
      expect.objectContaining({
        ordinal: 1,
        reopenFromStepId: "implement",
        blocker: "Reviewer found one correctable defect",
      }),
    ]);
    const implementation = settled.steps.find((step) => step.id === "implement")!;
    const review = settled.steps.find((step) => step.id === "review")!;
    expect(implementation.attemptIds).toHaveLength(2);
    expect(review.attemptIds).toHaveLength(2);
    expect(new Set([...implementation.attemptIds, ...review.attemptIds]).size).toBe(4);
    expect(settled.reviewReworks?.[0]?.failedReviewAttemptId).toBe(review.attemptIds[0]);
    expect(review.summary).toBe("Fresh review passed");
    expect(settled.status).toBe("completed");
    expect(ready.git.ticketCycles[settled.gitCycleId!]?.status).toBe("retired");
    expect(ready.attempts[implementation.attemptIds[1]!]!.lineage).toMatchObject({
      reason: "rework",
      parentAttemptId: implementation.attemptIds[0],
    });
    expect(
      ready.attempts[implementation.attemptIds[1]!]!.lineage?.conversationFork,
    ).toBeUndefined();
    expect(ready.attempts[review.attemptIds[1]!]!.lineage).toMatchObject({
      reason: "rework",
      parentAttemptId: review.attemptIds[0],
    });
    expect(ready.attempts[review.attemptIds[1]!]!.lineage?.conversationFork).toBeUndefined();
    const lineage = (await client.request("run.lineage", { runId, ticketId: "ticket-one" }))
      .result as {
      protocol: string;
      attempts: Array<{
        attemptId: string;
        persona: string;
        ticket: string;
        step: string;
        reason: string;
        parentAttemptId?: string;
        childAttemptIds: string[];
      }>;
    };
    expect(lineage.protocol).toBe("koni.run-attempt-lineage.v1");
    expect(lineage.attempts).toHaveLength(4);
    const byAttempt = new Map(lineage.attempts.map((attempt) => [attempt.attemptId, attempt]));
    expect(byAttempt.get(implementation.attemptIds[1]!)).toMatchObject({
      persona: "Worker",
      ticket: "Implement feature",
      step: "Implement",
      reason: "rework",
      parentAttemptId: implementation.attemptIds[0],
    });
    expect(byAttempt.get(review.attemptIds[0]!)).toMatchObject({
      persona: "Worker",
      reason: "review",
      parentAttemptId: implementation.attemptIds[0],
    });
    expect(byAttempt.get(review.attemptIds[1]!)).toMatchObject({
      persona: "Worker",
      reason: "rework",
      parentAttemptId: review.attemptIds[0],
    });
    expect(byAttempt.get(implementation.attemptIds[0]!)?.childAttemptIds).toEqual(
      expect.arrayContaining([implementation.attemptIds[1], review.attemptIds[0]]),
    );
    expect(byAttempt.get(review.attemptIds[0]!)?.childAttemptIds).toContain(review.attemptIds[1]);
    client.close();
  });

  it("blocks after automatic review rework and exposes one exact supervised recovery", async () => {
    const root = await repository();
    let sequence = 0;
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: exhaustedReviewReworkProgram(),
      supervisor: new ManagedSessionSupervisor(),
      now: () => new Date(1_784_179_200_000 + sequence * 1_000),
      createId: (kind) => `${kind}-${++sequence}`,
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "exhausted-review-rework");

    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "blocked");
    const blocked = await engine.store.getRun(runId);
    const ticket = blocked.tickets["ticket-one"]!;
    expect(blocked.lifecycle.blocker).toBe(
      "Second independent review still found a material route gap",
    );
    expect(ticket.status).toBe("blocked");
    expect(ticket.reviewReworkCount).toBe(1);
    expect(ticket.reviewReworks?.map((record) => record.mode)).toEqual(["automatic"]);

    const controls = (await client.request("run.controls", { runId })).result as {
      binding: { runId: string; runRevision: number; generation: number };
      runActions: Array<{
        id: string;
        intent: string;
        availability: { state: string; reason: string };
        form?: { fields: Array<{ key: string; kind?: string; lockedValue?: string }> };
      }>;
    };
    const genericResume = controls.runActions.find((action) => action.intent === "retry_blocked")!;
    const exactRetry = controls.runActions.find(
      (action) => action.intent === "retry_supervised_stage",
    )!;
    expect(genericResume.availability.state).toBe("disabled");
    expect(exactRetry.availability.state).toBe("available");
    expect(exactRetry.form?.fields).toContainEqual(
      expect.objectContaining({
        key: "steering",
        kind: "multiline",
      }),
    );
    const values = Object.fromEntries(
      (exactRetry.form?.fields ?? [])
        .filter((field) => field.lockedValue !== undefined)
        .map((field) => [field.key, field.lockedValue as string]),
    );
    values.steering =
      "Preserve causal test output and stub unrelated parent leaves in one fixture pass.";
    await client.request(
      "run.action.execute",
      {
        protocol: "koni.stage-action-invocation.v1",
        runId,
        runRevision: controls.binding.runRevision,
        generation: controls.binding.generation,
        capabilityId: exactRetry.id,
        confirmed: true,
        values,
      },
      {
        expectedRevision: client.revision,
        idempotencyKey: "retry-exhausted-reviewed-blocker",
      },
    );

    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "merge_ready");
    const recovered = await engine.store.getRun(runId);
    const recoveredTicket = recovered.tickets["ticket-one"]!;
    expect(recoveredTicket.status).toBe("completed");
    expect(recoveredTicket.reviewReworkCount).toBe(1);
    expect(recoveredTicket.reviewReworks?.map((record) => record.mode)).toEqual([
      "automatic",
      "supervised",
    ]);
    expect(recoveredTicket.reviewReworks?.at(-1)?.operatorSteering).toBe(values.steering);
    expect(recoveredTicket.steps.find((step) => step.id === "implement")?.attemptIds).toHaveLength(
      3,
    );
    expect(recoveredTicket.steps.find((step) => step.id === "review")?.attemptIds).toHaveLength(3);
    client.close();
  }, 30_000);

  it("exposes the exact reviewed recovery when the automatic rework author blocks first", async () => {
    const root = await repository();
    let sequence = 0;
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: exhaustedReviewReworkProgram({ blockAutomaticAuthor: true }),
      supervisor: new ManagedSessionSupervisor(),
      now: () => new Date(1_784_179_300_000 + sequence * 1_000),
      createId: (kind) => `${kind}-${++sequence}`,
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(
      client,
      engine,
      "blocked-automatic-review-author",
    );

    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "blocked");
    const blocked = await engine.store.getRun(runId);
    const ticket = blocked.tickets["ticket-one"]!;
    expect(ticket.blocker).toBe("new-token token budget exceeded");
    expect(ticket.steps.map((step) => [step.id, step.status])).toEqual([
      ["implement", "failed"],
      ["review", "pending"],
    ]);
    expect(ticket.reviewReworks?.map((record) => record.mode)).toEqual(["automatic"]);

    const controls = (await client.request("run.controls", { runId })).result as {
      binding: { runId: string; runRevision: number; generation: number };
      runActions: Array<{
        id: string;
        intent: string;
        title: string;
        availability: { state: string; reason: string };
        form?: { fields: Array<{ key: string; lockedValue?: string }> };
      }>;
    };
    const genericResume = controls.runActions.find((action) => action.intent === "retry_blocked")!;
    const exactRetry = controls.runActions.find(
      (action) => action.intent === "retry_supervised_stage",
    )!;
    expect(genericResume.availability.state).toBe("disabled");
    expect(exactRetry).toMatchObject({
      title: "Retry reviewed blocker",
      availability: { state: "available" },
    });
    const values = Object.fromEntries(
      (exactRetry.form?.fields ?? [])
        .filter((field) => field.lockedValue !== undefined)
        .map((field) => [field.key, field.lockedValue as string]),
    );
    await client.request(
      "run.action.execute",
      {
        protocol: "koni.stage-action-invocation.v1",
        runId,
        runRevision: controls.binding.runRevision,
        generation: controls.binding.generation,
        capabilityId: exactRetry.id,
        confirmed: true,
        values,
      },
      {
        expectedRevision: client.revision,
        idempotencyKey: "retry-blocked-automatic-review-author",
      },
    );

    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "merge_ready");
    const recoveredTicket = (await engine.store.getRun(runId)).tickets["ticket-one"]!;
    expect(recoveredTicket.status).toBe("completed");
    expect(recoveredTicket.reviewReworks?.map((record) => record.mode)).toEqual([
      "automatic",
      "supervised",
    ]);
    expect(recoveredTicket.steps.find((step) => step.id === "implement")?.attemptIds).toHaveLength(
      3,
    );
    expect(recoveredTicket.steps.find((step) => step.id === "review")?.attemptIds).toHaveLength(2);
    client.close();
  }, 30_000);

  it("exposes review-only recovery for a workflow without producer rework", async () => {
    const root = await repository();
    let sequence = 0;
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: exhaustedReviewReworkProgram({ noProducerRework: true }),
      supervisor: new ManagedSessionSupervisor(),
      now: () => new Date(1_784_179_400_000 + sequence * 1_000),
      createId: (kind) => `${kind}-${++sequence}`,
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(
      client,
      engine,
      "review-only-without-producer-route",
    );

    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "blocked");
    const blocked = await engine.store.getRun(runId);
    const ticket = blocked.tickets["ticket-one"]!;
    expect(ticket.reviewFailureReopenFrom).toBeUndefined();
    expect(ticket.steps.map((step) => [step.id, step.status])).toEqual([
      ["implement", "completed"],
      ["review", "failed"],
    ]);

    const controls = (await client.request("run.controls", { runId })).result as {
      binding: { runRevision: number; generation: number };
      runActions: Array<{
        id: string;
        intent: string;
        title: string;
        availability: { state: string };
        form?: { fields: Array<{ key: string; lockedValue?: string }> };
      }>;
    };
    expect(
      controls.runActions.find((action) => action.title === "Retry reviewed blocker"),
    ).toBeUndefined();
    const rereview = controls.runActions.find(
      (action) => action.title === "Retry independent review",
    )!;
    expect(rereview).toMatchObject({
      intent: "retry_supervised_stage",
      availability: { state: "available" },
    });
    const values = Object.fromEntries(
      (rereview.form?.fields ?? [])
        .filter((field) => field.lockedValue !== undefined)
        .map((field) => [field.key, field.lockedValue as string]),
    );
    values.steering = "Use the compiler-authenticated historical preparation envelope.";
    await client.request(
      "run.action.execute",
      {
        protocol: "koni.stage-action-invocation.v1",
        runId,
        runRevision: controls.binding.runRevision,
        generation: controls.binding.generation,
        capabilityId: rereview.id,
        confirmed: true,
        values,
      },
      {
        expectedRevision: client.revision,
        idempotencyKey: "review-only-no-producer-route",
      },
    );

    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "merge_ready");
    const recoveredRun = await engine.store.getRun(runId);
    const recovered = recoveredRun.tickets["ticket-one"]!;
    expect(recovered.reviewReworks).toEqual([
      expect.objectContaining({
        mode: "supervised",
        scope: "review_only",
        reopenFromStepId: "review",
        operatorSteering: values.steering,
      }),
    ]);
    expect(recovered.steps.find((step) => step.id === "implement")?.attemptIds).toHaveLength(1);
    const reviewAttempts = recovered.steps.find((step) => step.id === "review")?.attemptIds ?? [];
    expect(reviewAttempts).toHaveLength(2);
    expect(recoveredRun.attempts[reviewAttempts[1]!]!.lineage).toEqual({
      branchEpoch: 0,
      reason: "initial",
    });
    client.close();
  }, 30_000);

  it("keeps paused usage at zero across restart and creates only one resume successor", async () => {
    const root = await repository();
    const harness = new LifecycleHarness();
    const program = lifecycleProgram(harness);
    let engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    let client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });

    const created = await client.request(
      "run.create",
      {
        objective: "Exercise durable pause and resume",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Exercise durable pause and resume" },
      },
      { expectedRevision: 0, idempotencyKey: "create-lifecycle-run" },
    );
    const runId = (created.result as { runId: string }).runId;
    await waitFor(
      async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
    );
    await client.request("authority.ping");
    await client.request(
      "plan.approve",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "approve-lifecycle-run",
      },
    );
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return (
        harness.adapters.length === 1 &&
        Object.values(current.attempts).some((attempt) => attempt.status === "running") &&
        totalUsage(current) > 0
      );
    });

    await client.request("authority.ping");
    await client.request(
      "run.pause",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "pause-lifecycle-run",
      },
    );
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "paused");
    const paused = await engine.store.getRun(runId);
    const pausedUsage = totalUsage(paused);
    const pausedPrompts = harness.promptCalls;
    harness.adapters[0]!.emitUsage(100, 50, 500, 25);
    await client.request("authority.ping");
    expect(totalUsage(await engine.store.getRun(runId))).toBe(pausedUsage);
    expect(harness.promptCalls).toBe(pausedPrompts);

    client.close();
    const stopping = engine.stop();
    expect(engine.stop()).toBe(stopping);
    await stopping;
    engines.splice(engines.indexOf(engine), 1);
    engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    expect((await engine.store.getRun(runId)).lifecycle.phase).toBe("paused");
    expect(harness.promptCalls).toBe(pausedPrompts);
    expect(totalUsage(await engine.store.getRun(runId))).toBe(pausedUsage);

    client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });
    await client.request(
      "run.resume",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "resume-lifecycle-run",
      },
    );
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return (
        harness.adapters.length === 2 &&
        Object.values(current.attempts).filter((attempt) => attempt.status === "running").length ===
          1
      );
    });
    await client.request("authority.ping");
    const resumed = await engine.store.getRun(runId);
    const ticketAttempts = Object.values(resumed.attempts).filter(
      (attempt) => attempt.ticketId === "ticket-one",
    );
    expect(ticketAttempts).toHaveLength(2);
    expect(new Set(ticketAttempts.map((attempt) => attempt.id)).size).toBe(2);
    expect(ticketAttempts.filter((attempt) => attempt.status === "running")).toHaveLength(1);
    expect(harness.promptCalls).toBe(pausedPrompts + 1);
    client.close();
  });

  it("keeps an active assignment durable when normal authority shutdown aborts its adapter", async () => {
    const root = await repository();
    const harness = new LifecycleHarness();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: lifecycleProgram(harness),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "durable normal shutdown");
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return (
        harness.adapters.length === 1 &&
        Object.values(current.attempts).some((attempt) => attempt.status === "running")
      );
    });
    client.close();

    await engine.stop();
    engines.splice(engines.indexOf(engine), 1);

    const stopped = await engine.store.getRun(runId);
    expect(stopped.lifecycle.phase).toBe("executing");
    expect(stopped.tickets["ticket-one"]?.status).toBe("running");
    expect(stopped.tickets["ticket-one"]?.blocker).toBeUndefined();
    const ticketAttempts = Object.values(stopped.attempts).filter(
      (attempt) => attempt.kind === "ticket",
    );
    expect(ticketAttempts).toHaveLength(1);
    expect(ticketAttempts[0]?.status).toBe("running");
    expect(ticketAttempts[0]?.error).toBeUndefined();

    const successorHarness = new LifecycleHarness();
    const successor = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.1",
      program: lifecycleProgram(successorHarness),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(successor);
    await successor.start();
    await waitFor(async () => {
      const recovered = await successor.store.getRun(runId);
      return (
        successorHarness.adapters.length === 1 &&
        recovered.tickets["ticket-one"]?.status === "running"
      );
    });
    const recovered = await successor.store.getRun(runId);
    const recoveredTicketAttempts = Object.values(recovered.attempts).filter(
      (attempt) => attempt.kind === "ticket",
    );
    expect(recoveredTicketAttempts).toEqual([
      expect.objectContaining({ id: ticketAttempts[0]!.id, status: "interrupted" }),
      expect.objectContaining({
        status: "running",
        lineage: expect.objectContaining({
          reason: "recovery",
          parentAttemptId: ticketAttempts[0]!.id,
        }),
      }),
    ]);
  });

  it("quiesces active sessions through the cross-build restart control before daemon exit", async () => {
    const root = await repository();
    const harness = new LifecycleHarness();
    const program = lifecycleProgram(harness);
    let shutdownRequested = false;
    let engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
      requestAuthorityShutdown: () => {
        shutdownRequested = true;
      },
    });
    engines.push(engine);
    await engine.start();
    let client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const created = await client.request(
      "run.create",
      {
        objective: "Preserve a live run across a Core refresh",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Preserve a live run across a Core refresh" },
      },
      { expectedRevision: 0, idempotencyKey: "create-refresh-run" },
    );
    const runId = (created.result as { runId: string }).runId;
    await waitFor(
      async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
    );
    await client.request("authority.ping");
    await client.request(
      "plan.approve",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "approve-refresh-run",
      },
    );
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return (
        harness.adapters.length === 1 &&
        Object.values(current.attempts).some((attempt) => attempt.status === "running")
      );
    });
    client.close();

    const control = await AuthorityClient.connect({
      projectRoot: root,
      client: "compat-control",
      version: "9.0.0",
      buildSha256: `sha256:${"d".repeat(64)}`,
      compatibilityControl: true,
    });
    const quiesced = await control.request("authority.quiesce", undefined, {
      expectedRevision: control.revision,
      // Caller-controlled text must never acquire startup-failure draft-blocking authority.
      idempotencyKey: "startup-failure:operator-spoof",
    });
    expect(quiesced.result).toMatchObject({ status: "quiescing", pausedRunIds: [runId] });
    await waitFor(
      async () =>
        shutdownRequested && (await engine.store.getRun(runId)).lifecycle.phase === "paused",
    );
    expect(shutdownRequested).toBe(true);
    const paused = await engine.store.getRun(runId);
    expect(paused.lifecycle.phase).toBe("paused");
    expect(
      Object.values(paused.attempts).filter((attempt) => attempt.status === "running"),
    ).toEqual([]);
    control.close();

    await engine.stop();
    engines.splice(engines.indexOf(engine), 1);
    let resumeBoardRefreshes = 0;
    const refreshedProgram: RunCompilerProgram = {
      ...program,
      async reconcileTicketBoard(run) {
        resumeBoardRefreshes += 1;
        return { tickets: structuredClone(run.tickets) };
      },
    };
    engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: refreshedProgram,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    expect((await engine.store.getRun(runId)).lifecycle.phase).toBe("paused");
    client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });
    await client.request(
      "run.resume",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "resume-after-refresh",
      },
    );
    expect(resumeBoardRefreshes).toBe(1);
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return (
        harness.adapters.length === 2 &&
        Object.values(current.attempts).filter((attempt) => attempt.status === "running").length ===
          1
      );
    });
    client.close();
  });

  it("resumes a crashed bounded quiesce from its durable tombstone without reopening admission", async () => {
    const root = await repository();
    const harness = new LifecycleHarness();
    const program = lifecycleProgram(harness);
    let firstShutdownRequested = false;
    const firstSupervisor = new ManagedSessionSupervisor();
    let engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: firstSupervisor,
      requestAuthorityShutdown: () => {
        firstShutdownRequested = true;
      },
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await client.request(
        "run.create",
        {
          objective: `Preserve quiesce batch ${index + 1}`,
          runTypeId: "small",
          targetRef: "refs/heads/main",
          intake: { goal: `Preserve quiesce batch ${index + 1}` },
        },
        { expectedRevision: client.revision, idempotencyKey: `create-crash-quiesce-${index + 1}` },
      );
      const runId = (created.result as { runId: string }).runId;
      runIds.push(runId);
      await waitFor(
        async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
      );
      await client.request("authority.ping");
    }
    client.close();

    const originalCommit = engine.store.commit.bind(engine.store);
    let pausingCommits = 0;
    let injected = false;
    const commitSpy = vi.spyOn(engine.store, "commit").mockImplementation(async (mutation) => {
      if (mutation.runWrites?.some((write) => write.record.lifecycle.phase === "pausing")) {
        pausingCommits += 1;
        if (pausingCommits === 2) {
          injected = true;
          throw new Error("injected quiesce publication crash");
        }
      }
      return originalCommit(mutation);
    });

    const control = await AuthorityClient.connect({
      projectRoot: root,
      client: "compat-control",
      version: "9.0.0",
      buildSha256: `sha256:${"e".repeat(64)}`,
      compatibilityControl: true,
    });
    const quiesced = await control.request("authority.quiesce", undefined, {
      expectedRevision: control.revision,
      idempotencyKey: "crash-bounded-quiesce",
    });
    expect(quiesced.result).toMatchObject({
      status: "quiescing",
      pausedRunCount: 3,
      pausedRunIdsTruncated: false,
    });
    await waitFor(
      async () =>
        injected &&
        firstShutdownRequested &&
        (await engine.store.state()).authorityQuiesce !== undefined,
    );
    expect(firstSupervisor.list()).toEqual([]);
    await expect(
      control.request("authority.quiesce", undefined, {
        expectedRevision: quiesced.revision,
        idempotencyKey: "crash-bounded-quiesce",
      }),
    ).resolves.toMatchObject({ result: quiesced.result });
    control.close();
    commitSpy.mockRestore();

    const beforeRestart = new Map<string, { phase: string; revision: number }>();
    for (const runId of runIds) {
      const run = await engine.store.getRun(runId);
      beforeRestart.set(runId, { phase: run.lifecycle.phase, revision: run.revision });
    }
    const alreadyPaused = [...beforeRestart].find(([, run]) => run.phase === "paused");
    expect(alreadyPaused).toBeDefined();

    await engine.stop();
    engines.splice(engines.indexOf(engine), 1);
    let recoveredShutdownRequested = false;
    const recoveredSupervisor = new ManagedSessionSupervisor();
    engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: recoveredSupervisor,
      requestAuthorityShutdown: () => {
        recoveredShutdownRequested = true;
      },
    });
    engines.push(engine);
    await engine.start();
    expect(recoveredShutdownRequested).toBe(false);
    expect(recoveredSupervisor.list()).toEqual([]);
    expect((await engine.store.state()).authorityQuiesce).toBeUndefined();
    for (const runId of runIds) {
      expect((await engine.store.getRun(runId)).lifecycle.phase).toBe("paused");
    }
    const stablePaused = await engine.store.getRun(alreadyPaused![0]);
    expect(stablePaused.revision).toBe(alreadyPaused![1].revision);
    const recoveredClient = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    await recoveredClient.request(
      "run.resume",
      { runId: runIds[0]! },
      {
        expectedRevision: recoveredClient.revision,
        idempotencyKey: "resume-after-crashed-quiesce",
      },
    );
    expect((await engine.store.getRun(runIds[0]!)).lifecycle.phase).toBe("awaiting_approval");
    expect(recoveredSupervisor.list()).toEqual([]);
    recoveredClient.close();
  }, 30_000);

  it("quiesces runs whose combined records cannot fit one transaction", async () => {
    const root = await repository();
    const program = lifecycleProgram(new LifecycleHarness());
    const seed = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(seed);
    const payloadBytes = 49 * 1024 * 1024;
    expect(payloadBytes * 2).toBeGreaterThan(MAX_TRANSACTION_BYTES);
    for (let index = 0; index < 2; index += 1) {
      const state = await seed.store.state();
      const run = largeAwaitingApprovalRun(root, `run-wide-${index + 1}`, payloadBytes);
      await seed.store.commit({
        expectedRevision: state.revision,
        runWrites: [{ record: run, expectedRevision: null }],
      });
    }
    await seed.stop();
    engines.splice(engines.indexOf(seed), 1);

    let shutdownRequested = false;
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
      requestAuthorityShutdown: () => {
        shutdownRequested = true;
      },
    });
    engines.push(engine);
    await engine.start();
    const control = await AuthorityClient.connect({
      projectRoot: root,
      client: "compat-control",
      version: "9.0.0",
      buildSha256: `sha256:${"f".repeat(64)}`,
      compatibilityControl: true,
    });
    const response = await control.request("authority.quiesce", undefined, {
      expectedRevision: control.revision,
      idempotencyKey: "quiesce-over-transaction-ceiling",
    });
    expect(response.result).toMatchObject({ status: "quiescing", pausedRunCount: 2 });
    await waitFor(
      async () =>
        shutdownRequested &&
        (await engine.store.getRun("run-wide-1")).lifecycle.phase === "paused" &&
        (await engine.store.getRun("run-wide-2")).lifecycle.phase === "paused",
    );
    expect((await engine.store.state()).authorityQuiesce).toBeUndefined();
    control.close();
  }, 120_000);

  it("returns an exact quiesce count with only a bounded identity sample", async () => {
    const root = await repository();
    const program = lifecycleProgram(new LifecycleHarness());
    const seed = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(seed);
    const records = Array.from({ length: 25 }, (_, index) =>
      largeAwaitingApprovalRun(root, `run-sample-${String(index).padStart(2, "0")}`, 32),
    );
    await seed.store.commit({
      expectedRevision: 0,
      runWrites: records.map((record) => ({ record, expectedRevision: null })),
    });
    await seed.stop();
    engines.splice(engines.indexOf(seed), 1);

    let shutdownRequested = false;
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
      requestAuthorityShutdown: () => {
        shutdownRequested = true;
      },
    });
    engines.push(engine);
    await engine.start();
    const control = await AuthorityClient.connect({
      projectRoot: root,
      client: "compat-control",
      version: "9.0.0",
      buildSha256: `sha256:${"1".repeat(64)}`,
      compatibilityControl: true,
    });
    const response = await control.request("authority.quiesce", undefined, {
      expectedRevision: control.revision,
      idempotencyKey: "quiesce-bounded-sample",
    });
    expect(response.result).toMatchObject({
      status: "quiescing",
      pausedRunCount: 25,
      pausedRunIdsTruncated: true,
      pausedRunIds: records.slice(0, 20).map((run) => run.id),
    });
    await waitFor(
      async () => shutdownRequested && (await engine.store.state()).authorityQuiesce === undefined,
    );
    control.close();
  }, 30_000);

  it("rejects every late effect and cached token after active deletion", async () => {
    const root = await repository();
    const harness = new DeletionHarness();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: deletionProgram(harness),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });

    const created = await client.request(
      "run.create",
      {
        objective: "Exercise terminal deletion authority",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Exercise terminal deletion authority" },
      },
      { expectedRevision: 0, idempotencyKey: "create-deletion-run" },
    );
    const runId = (created.result as { runId: string }).runId;
    await waitFor(
      async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
    );
    await client.request("authority.ping");
    await client.request(
      "plan.approve",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "approve-deletion-run",
      },
    );
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return (
        harness.adapter !== undefined &&
        harness.writeTool !== undefined &&
        Object.values(current.attempts).some((attempt) => attempt.status === "running") &&
        totalUsage(current) > 0
      );
    });

    await client.request("authority.ping");
    await authorizeDelete(client, runId, "delete-active-run");
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "deleted");
    const deleted = await engine.store.getRun(runId);
    const deletedUsage = totalUsage(deleted);
    const deletedTickets = canonicalHash(deleted.tickets);
    const deletedActivity = canonicalHash(deleted.activity);
    const deletedReceipts = Object.values(deleted.attempts).reduce(
      (total, attempt) => total + (attempt.authorityToolResults?.length ?? 0),
      0,
    );
    const deletedPrompts = harness.promptCalls;

    await expect(
      harness.writeTool!.execute("late-write", {
        path: "late.txt",
        content: "must not exist\n",
        expectedSha256: null,
      }),
    ).rejects.toMatchObject({ code: "tool_identity" });
    harness.adapter!.emitTerminal({ result: "late-result" });
    harness.adapter!.emitUsage(100, 50, 500, 25);
    await client.request("authority.ping");

    const afterLateEvents = await engine.store.getRun(runId);
    expect(afterLateEvents.lifecycle.phase).toBe("deleted");
    expect(totalUsage(afterLateEvents)).toBe(deletedUsage);
    expect(canonicalHash(afterLateEvents.tickets)).toBe(deletedTickets);
    expect(canonicalHash(afterLateEvents.activity)).toBe(deletedActivity);
    expect(
      Object.values(afterLateEvents.attempts).reduce(
        (total, attempt) => total + (attempt.authorityToolResults?.length ?? 0),
        0,
      ),
    ).toBe(deletedReceipts);
    expect(harness.promptCalls).toBe(deletedPrompts);
    await expect(readFile(path.join(root, "late.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    client.close();
  });

  it("preserves branches but retires clean owned worktrees when deletion chooses preservation", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: directApprovalProgram(),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });

    const created = await client.request(
      "run.create",
      {
        objective: "Preserve reviewed run branches without retaining worktrees",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Preserve reviewed run branches without retaining worktrees" },
      },
      { expectedRevision: 0, idempotencyKey: "create-preserve-delete" },
    );
    const runId = (created.result as { runId: string }).runId;
    await waitFor(
      async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
    );
    const before = await engine.store.getRun(runId);
    await git(before.git.planning.worktree, "status", "--porcelain");
    expect(await readFile(path.join(before.git.planning.worktree, "README.md"), "utf8")).toBe(
      "initial\n",
    );

    await client.request("authority.ping");
    await authorizeDelete(client, runId, "delete-and-preserve-owned-git", "preserve_branches");
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "deleted");

    const deleted = await engine.store.getRun(runId);
    expect(deleted.deletion).toMatchObject({ mode: "preserve_branches" });
    expect(deleted.git.planning.status).toBe("preserved");
    await expect(
      readFile(path.join(before.git.planning.worktree, "README.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      deleted.activity.some((entry) =>
        entry.message.includes("Retired clean Koni worktrees and preserved owned branches"),
      ),
    ).toBe(true);
    client.close();
  });

  it("invalidates a reviewed deletion token when an owned worktree becomes dirty", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: directApprovalProgram(),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });

    const created = await client.request(
      "run.create",
      {
        objective: "Bind deletion review to exact Git evidence",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Bind deletion review to exact Git evidence" },
      },
      { expectedRevision: 0, idempotencyKey: "create-delete-preview-cas" },
    );
    const runId = (created.result as { runId: string }).runId;
    await waitFor(
      async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
    );
    const reviewed = await client.request("run.deletion.inspect", { runId });
    const previewToken = (reviewed.result as { previewToken: `sha256:${string}` }).previewToken;
    const run = await engine.store.getRun(runId);
    await writeFile(
      path.join(run.git.planning.worktree, "operator-unreviewed.txt"),
      "dirty after review\n",
    );

    await expect(
      client.request(
        "run.delete",
        {
          runId,
          mode: "delete_owned_branches",
          previewToken,
        },
        {
          expectedRevision: client.revision,
          idempotencyKey: "reject-stale-delete-preview",
        },
      ),
    ).rejects.toMatchObject({ code: "preview_stale", retryable: true });
    expect((await engine.store.getRun(runId)).lifecycle.phase).toBe("awaiting_approval");
    const refreshed = (await client.request("run.deletion.inspect", { runId })).result as {
      previewToken: string;
      dirtyWorktreeWarnings: string[];
    };
    expect(refreshed.previewToken).not.toBe(previewToken);
    expect(refreshed.dirtyWorktreeWarnings.join(" ")).toContain("uncommitted changes");
    client.close();
  });

  it("invalidates a reviewed deletion token when an owned branch ref moves", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: directApprovalProgram(),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "delete-preview-ref-cas");
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "merge_ready");
    const run = await engine.store.getRun(runId);
    expect(run.git.run.headOid).toMatch(/^[0-9a-f]{40}$/u);
    const reviewed = await client.request("run.deletion.inspect", { runId });
    const previewToken = (reviewed.result as { previewToken: `sha256:${string}` }).previewToken;

    await writeFile(path.join(run.git.run.worktree, "unreviewed-run-ref.txt"), "move owned ref\n");
    await git(run.git.run.worktree, "add", "unreviewed-run-ref.txt");
    await git(run.git.run.worktree, "commit", "-m", "move owned run ref after deletion review");
    const movedOid = await gitOutput(run.git.run.worktree, "rev-parse", "HEAD");
    expect(movedOid).not.toBe(run.git.run.headOid);
    await expect(
      client.request(
        "run.delete",
        {
          runId,
          mode: "delete_owned_branches",
          previewToken,
        },
        {
          expectedRevision: client.revision,
          idempotencyKey: "reject-moved-ref-delete-preview",
        },
      ),
    ).rejects.toMatchObject({ code: "preview_stale", retryable: true });
    expect(await gitOutput(root, "show-ref", "--verify", "--hash", run.git.run.branchRef)).toBe(
      movedOid,
    );
    expect((await engine.store.getRun(runId)).lifecycle.phase).toBe("merge_ready");
    const refreshed = (await client.request("run.deletion.inspect", { runId })).result as {
      previewToken: string;
      dirtyWorktreeWarnings: string[];
    };
    expect(refreshed.previewToken).not.toBe(previewToken);
    expect(refreshed.dirtyWorktreeWarnings.join(" ")).toMatch(
      /moved|differs|uncommitted|no longer/u,
    );
    client.close();
  });

  it("invalidates a reviewed merge token when the target branch advances", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: directApprovalProgram(),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "merge-preview-target-cas");
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "merge_ready");
    const mergeReady = await engine.store.getRun(runId);
    expect(mergeReady.postOrchestration).toMatchObject({
      synchronization: {
        runOid: mergeReady.git.run.headOid,
        targetOid: mergeReady.git.targetSynchronization?.targetOid,
        graphHash: mergeReady.graphHash,
      },
      checkpoint: {
        runOid: mergeReady.git.run.headOid,
        targetOid: mergeReady.git.targetSynchronization?.targetOid,
        graphHash: mergeReady.graphHash,
      },
      report: {
        runOid: mergeReady.git.run.headOid,
        targetOid: mergeReady.git.targetSynchronization?.targetOid,
        graphHash: mergeReady.graphHash,
      },
    });
    expect(mergeReady.postOrchestration?.review).toBeUndefined();
    const reviewed = await client.request("run.merge.inspect", { runId });
    const previewToken = (reviewed.result as { previewToken: `sha256:${string}` }).previewToken;

    await writeFile(path.join(root, "target-after-review.txt"), "target advanced\n");
    await git(root, "add", "target-after-review.txt");
    await git(root, "commit", "-m", "advance target after merge review");

    await expect(
      client.request(
        "run.merge.authorize",
        { runId, previewToken },
        {
          expectedRevision: client.revision,
          idempotencyKey: "reject-stale-merge-preview",
        },
      ),
    ).rejects.toMatchObject({ code: "preview_stale", retryable: true });
    expect((await engine.store.getRun(runId)).lifecycle.phase).toBe("merge_ready");
    const refreshed = (await client.request("run.merge.inspect", { runId })).result as {
      previewToken: string;
      targetAdvanced: boolean;
      canAuthorize: boolean;
    };
    expect(refreshed.previewToken).not.toBe(previewToken);
    expect(refreshed.targetAdvanced).toBe(true);
    expect(refreshed.canAuthorize).toBe(false);
    client.close();
  });

  it("reopens target sync and invalidates checkpoint, review, and report proof before promotion", async () => {
    const root = await repository();
    const reportEntered = deferred<void>();
    const releaseReport = deferred<void>();
    let verificationCalls = 0;
    const direct = directApprovalProgram();
    const program: RunCompilerProgram = {
      ...direct,
      async verifyRun(run) {
        verificationCalls += 1;
        const compiled = await direct.verifyRun(run);
        if (verificationCalls === 2) {
          reportEntered.resolve();
          await releaseReport.promise;
        }
        return compiled;
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(
      client,
      engine,
      "target-advance-before-promotion",
    );
    await reportEntered.promise;

    const beforeAdvance = await engine.store.getRun(runId);
    expect(beforeAdvance.postOrchestration?.checkpoint?.targetOid).toBe(
      beforeAdvance.git.targetSynchronization?.targetOid,
    );
    expect(beforeAdvance.postOrchestration?.report).toBeUndefined();
    await writeFile(path.join(root, "advanced-target.txt"), "new target evidence\n");
    await git(root, "add", "advanced-target.txt");
    await git(root, "commit", "-m", "advance target during report compilation");
    const advancedTargetOid = await gitOutput(root, "rev-parse", "HEAD");
    releaseReport.resolve();

    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      if (current.lifecycle.phase === "blocked" || current.lifecycle.phase === "failed") {
        throw new Error(
          current.lifecycle.blocker ?? current.lifecycle.terminalReason ?? "run stopped",
        );
      }
      return current.lifecycle.phase === "merge_ready";
    });
    const ready = await engine.store.getRun(runId);
    expect(verificationCalls).toBe(4);
    expect(ready.git.targetSynchronization).toMatchObject({
      status: "synchronized",
      targetOid: advancedTargetOid,
      runOid: ready.git.run.headOid,
    });
    expect(ready.postOrchestration).toMatchObject({
      synchronization: { targetOid: advancedTargetOid, runOid: ready.git.run.headOid },
      checkpoint: { targetOid: advancedTargetOid, runOid: ready.git.run.headOid },
      report: { targetOid: advancedTargetOid, runOid: ready.git.run.headOid },
    });
    expect(ready.reports).toHaveLength(2);
    expect(ready.postOrchestration?.report?.reportId).toBe(ready.reports?.at(-1)?.reportId);
    expect(ready.git.promotion).toMatchObject({
      status: "ready",
      expectedTargetOid: advancedTargetOid,
      runOid: ready.git.run.headOid,
    });
    client.close();
  }, 30_000);

  it("creates one bounded integration ticket for a target conflict without resolver chains", async () => {
    const root = await repository();
    const harness = new GitConflictHarness();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: gitConflictProgram(harness),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });

    const created = await client.request(
      "run.create",
      {
        objective: "Exercise bounded target conflict integration",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Exercise bounded target conflict integration" },
      },
      { expectedRevision: 0, idempotencyKey: "create-conflict-run" },
    );
    const runId = (created.result as { runId: string }).runId;
    await waitFor(
      async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
    );
    await client.request("authority.ping");
    await client.request(
      "plan.approve",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "approve-conflict-run",
      },
    );
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "verifying");

    await writeFile(path.join(root, "README.md"), "target-side change\n");
    await git(root, "add", "README.md");
    await git(root, "commit", "-m", "target-side change");
    harness.releaseVerification();
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return current.tickets["integrate-target"] !== undefined && harness.integrationAttempts === 1;
    });

    const conflicted = await engine.store.getRun(runId);
    const integrationTickets = Object.values(conflicted.tickets).filter(
      (candidate) => candidate.operationId === "resolve-target-integration",
    );
    expect(integrationTickets).toHaveLength(1);
    expect(harness.integrationTicketCalls).toBe(1);
    expect(integrationTickets[0]).toMatchObject({
      id: "integrate-target",
      status: "running",
    });
    expect(integrationTickets[0]!.integrationForTicketId).toBeUndefined();
    expect(
      Object.values(conflicted.tickets).filter(
        (candidate) => candidate.integrationForTicketId === "integrate-target",
      ),
    ).toEqual([]);
    const integrationAttempt = Object.values(conflicted.attempts).find(
      (attempt) => attempt.ticketId === "integrate-target",
    )!;
    const integrationParent =
      conflicted.attempts[integrationAttempt.lineage?.parentAttemptId ?? ""];
    expect(integrationAttempt).toMatchObject({
      kind: "integration",
      lineage: {
        reason: "integration",
        parentAttemptId: expect.any(String),
        parentSessionId: expect.any(String),
      },
    });
    expect(integrationParent).toMatchObject({
      ticketId: "ticket-one",
      status: "completed",
      sessionId: integrationAttempt.lineage?.parentSessionId,
    });
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("target-side change\n");
    expect(await readFile(path.join(conflicted.git.run.worktree, "README.md"), "utf8")).toBe(
      "run-side change\n",
    );
    await client.request("authority.ping");
    expect(
      Object.values((await engine.store.getRun(runId)).tickets).filter(
        (candidate) => candidate.operationId === "resolve-target-integration",
      ),
    ).toHaveLength(1);
    client.close();
  });

  it("does not materialize or bind a ticket cycle after pause wins an in-flight tick", async () => {
    const root = await repository();
    const entered = deferred<void>();
    const release = deferred<void>();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: directApprovalProgram(),
      supervisor: new ManagedSessionSupervisor(),
      lifecycleFault: async (point) => {
        if (point !== "before_ticket_cycle_open") return;
        entered.resolve();
        await release.promise;
      },
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "pause-before-cycle");
    await entered.promise;

    await client.request("authority.ping");
    await client.request(
      "run.pause",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "pause-before-cycle-open",
      },
    );
    release.resolve();
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "paused");

    const paused = await engine.store.getRun(runId);
    expect(paused.tickets["ticket-one"]?.status).toBe("queued");
    expect("worktreePath" in paused.tickets["ticket-one"]!).toBe(false);
    expect("branch" in paused.tickets["ticket-one"]!).toBe(false);
    expect(paused.git.ticketCycles).toEqual({});
    expect(paused.pendingGitIntents).toEqual({});
    const attempts = Object.values(paused.attempts);
    expect(attempts.filter((attempt) => attempt.kind === "lead")).toEqual([
      expect.objectContaining({
        ticketId: "run-orchestration",
        stepId: "lead-orchestration-entry",
        status: "completed",
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.kind !== "lead")).toEqual([]);
    client.close();
  }, 30_000);

  it("authenticates direct semantic compilation receipts before terminal closure", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: semanticDirectReceiptProgram(),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(
      client,
      engine,
      "direct-semantic-terminal-receipts",
    );
    await waitFor(async () =>
      Object.values((await engine.store.getRun(runId)).attempts).some(
        (attempt) => attempt.ticketId === "ticket-one" && attempt.status === "completed",
      ),
    );

    const run = await engine.store.getRun(runId);
    const attempt = Object.values(run.attempts).find(
      (candidate) => candidate.ticketId === "ticket-one" && candidate.stepId === "implement",
    )!;
    expect(attempt.terminalPolicy).toMatchObject({ mode: "semantic" });
    expect(attempt.terminalOutputSha256).toMatch(/^sha256:/u);
    expect(
      Object.values(run.actionExecutions ?? {}).some(
        (action) =>
          action.boundary.kind === "assignment_validation" &&
          action.boundary.attemptId === attempt.id,
      ),
    ).toBe(false);

    const evidencePath = `runs/${run.id}/attempts/${attempt.id}/terminal-policy/${attempt.terminalPolicy!.sha256.slice(7)}.json`;
    // Completed run visibility is the publication boundary: the transaction must install exact
    // evidence artifacts before exposing the run record that points at them.
    const evidenceBytes = await engine.store.readArtifact(evidencePath, 1024 * 1024);
    const evidence = JSON.parse(evidenceBytes.toString("utf8")) as {
      receiptEvaluation: { missing: string[] };
      compilerReceipts: Array<{
        source: string;
        receipt: { receiptType: string; status: string; linkedToCurrentOutput: boolean };
        provenance: Record<string, unknown>;
      }>;
    };
    expect(evidence.receiptEvaluation.missing).toEqual([]);
    expect(
      evidence.compilerReceipts.map((receipt) => [receipt.source, receipt.receipt.receiptType]),
    ).toEqual(
      expect.arrayContaining([
        ["launch_context", "context-pack"],
        ["direct_compilation", "scoped-compile"],
      ]),
    );
    const direct = evidence.compilerReceipts.find(
      (receipt) => receipt.source === "direct_compilation",
    )!;
    expect(direct.receipt).toMatchObject({ status: "passed", linkedToCurrentOutput: true });
    expect(direct.provenance).toMatchObject({
      terminalOutputSha256: attempt.terminalOutputSha256,
      launchSpecSha256: attempt.launchSpecHash,
      compilerResult: {
        outcome: { status: "completed", summary: "Implemented feature" },
      },
    });
    client.close();
  }, 30_000);

  it("accepts an honest assignment blocker without replaying completion checks", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: semanticDirectReceiptProgram({ failedSubmission: true }),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(
      client,
      engine,
      "honest-failed-terminal-submission",
    );
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return current.tickets["ticket-one"]?.status === "blocked";
    });

    const run = await engine.store.getRun(runId);
    const attempt = Object.values(run.attempts).find(
      (candidate) => candidate.ticketId === "ticket-one" && candidate.stepId === "implement",
    )!;
    expect(attempt).toMatchObject({
      status: "completed",
      terminalSummary: "The configured check could not establish an honest result",
      terminalPolicy: { mode: "failed_submission" },
    });
    expect(run.tickets["ticket-one"]).toMatchObject({
      status: "blocked",
      blocker: "The configured check could not establish an honest result",
      steps: [expect.objectContaining({ status: "failed" })],
    });
    client.close();
  }, 30_000);

  it("accepts an honest configured assignment blocker without replaying completion checks", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: semanticDirectReceiptProgram({
        failedSubmission: true,
        configuredValidation: true,
      }),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(
      client,
      engine,
      "honest-configured-failed-terminal-submission",
    );
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return (
        Object.values(current.attempts).some(
          (attempt) => attempt.ticketId === "ticket-one" && attempt.status === "completed",
        ) || current.lifecycle.phase === "blocked"
      );
    });

    const run = await engine.store.getRun(runId);
    const attempt = Object.values(run.attempts).find(
      (candidate) => candidate.ticketId === "ticket-one" && candidate.stepId === "implement",
    )!;
    expect(attempt).toMatchObject({
      status: "completed",
      terminalSummary: "The configured check could not establish an honest result",
      terminalPolicy: { mode: "failed_submission" },
    });
    expect(run.lifecycle.phase).toBe("executing");
    expect(run.tickets["ticket-one"]).toMatchObject({
      status: "blocked",
      blocker: "The configured check could not establish an honest result",
      steps: [expect.objectContaining({ status: "failed" })],
    });
    client.close();
  }, 30_000);

  it("single-flights terminal-tool and provider settlement for one configured assignment", async () => {
    const root = await repository();
    const reached = deferred<void>();
    const release = deferred<void>();
    const providerCompleted = deferred<void>();
    let settlementEntries = 0;
    const supervisor = new ManagedSessionSupervisor();
    const unsubscribe = supervisor.subscribe((event) => {
      if (
        event.ticketId === "ticket-one" &&
        event.event.type === "status" &&
        event.event.status === "completed"
      )
        providerCompleted.resolve();
    });
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: configuredValidationDirectProgram(),
      supervisor,
      actionFault: async (point, input) => {
        if (point !== "before_assignment_settle" || input.ticketId !== "ticket-one") return;
        settlementEntries += 1;
        reached.resolve();
        await release.promise;
      },
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(
      client,
      engine,
      "single-flight-terminal-settlement",
    );
    await reached.promise;
    await providerCompleted.promise;
    // Let the provider outcome handler join the in-flight terminal-tool settlement. Before the
    // single-flight boundary it independently entered terminal-policy preparation and this hook.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const concurrentEntries = settlementEntries;
    release.resolve();

    await waitFor(async () => {
      const run = await engine.store.getRun(runId);
      const attempt = Object.values(run.attempts).find(
        (candidate) => candidate.ticketId === "ticket-one",
      );
      const action = Object.values(run.actionExecutions ?? {}).find(
        (candidate) =>
          candidate.boundary.kind === "assignment_validation" &&
          candidate.boundary.attemptId === attempt?.id,
      );
      return (
        attempt?.status === "completed" &&
        attempt.terminalPolicy !== undefined &&
        action?.settlement?.disposition === "completed"
      );
    });
    expect(concurrentEntries).toBe(1);
    expect(settlementEntries).toBe(1);
    unsubscribe();
    client.close();
  }, 30_000);

  it("retries finalization from a settled terminal artifact without replaying the agent", async () => {
    const root = await repository();
    let failFinalize = true;
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: configuredValidationDirectProgram(),
      supervisor: new ManagedSessionSupervisor(),
      actionFault: async (point, input) => {
        if (
          point !== "before_attempt_finalize" ||
          input.ticketId !== "ticket-one" ||
          !failFinalize
        ) {
          return;
        }
        failFinalize = false;
        throw new Error("simulated transient attempt finalization failure");
      },
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(
      client,
      engine,
      "recover-settled-terminal-finalization",
    );

    await waitFor(async () => {
      const run = await engine.store.getRun(runId);
      const attempts = Object.values(run.attempts).filter(
        (attempt) => attempt.ticketId === "ticket-one",
      );
      return (
        attempts.length === 1 &&
        attempts[0]?.status === "completed" &&
        run.lifecycle.phase === "merge_ready"
      );
    });
    const completed = await engine.store.getRun(runId);
    expect(
      completed.activity.some((entry) =>
        entry.message.includes("Retrying durable terminal finalization"),
      ),
    ).toBe(true);
    client.close();
  }, 30_000);

  it("replays a failed first-step compiler validation from accepted terminal bytes without another agent", async () => {
    const root = await repository();
    const base = configuredValidationDirectProgram();
    const compileAssignmentOutput = base.compileAssignmentOutput.bind(base);
    let compilationCount = 0;
    const program: RunCompilerProgram = {
      ...base,
      async compileAssignmentOutput(input) {
        compilationCount += 1;
        if (compilationCount === 1) {
          throw new Error("simulated compiler review-effect compatibility failure");
        }
        return compileAssignmentOutput(input);
      },
    };
    let engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    let client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(
      client,
      engine,
      "retry-accepted-compiler-validation",
    );
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return Object.values(current.actionExecutions ?? {}).some(
        (action) =>
          action.boundary.kind === "assignment_validation" && action.journal.status === "failed",
      );
    });
    const failedValidation = await engine.store.getRun(runId);
    const blockedDraft = structuredClone(failedValidation);
    blockedDraft.revision += 1;
    blockedDraft.updatedAt = "2026-07-19T13:05:00.000Z";
    blockedDraft.lifecycle = reduceRunLifecycle(blockedDraft.lifecycle, {
      type: "blocked",
      atMs: new Date(blockedDraft.updatedAt).getTime(),
      reason:
        "ticket validation action did not complete with its exact accepted assignment (failed)",
      remedy: "resume",
    }).state;
    const authorityState = await engine.store.state();
    await engine.store.commit({
      expectedRevision: authorityState.revision,
      runWrites: [{ record: blockedDraft, expectedRevision: failedValidation.revision }],
    });
    client.close();
    await engine.server.stop();
    engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.1",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.1" });

    const blocked = await engine.store.getRun(runId);
    const accepted = Object.values(blocked.attempts).find(
      (attempt) => attempt.ticketId === "ticket-one",
    )!;
    const failed = Object.values(blocked.actionExecutions ?? {}).find(
      (action) => action.boundary.kind === "assignment_validation",
    )!;
    expect(accepted).toMatchObject({
      status: "terminal_accepted",
      terminalOutputSha256: expect.stringMatching(/^sha256:/u),
    });
    expect(failed).toMatchObject({
      journal: { status: "failed", steps: [expect.objectContaining({ status: "failed" })] },
      effects: {},
    });
    expect(failed.settlement).toBeUndefined();

    await client.request("authority.ping");
    await client.request(
      "run.resume",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "retry-accepted-compiler-validation",
      },
    );
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return (
        current.actionExecutions?.[failed.invocationId]?.settlement?.disposition === "completed" &&
        current.attempts[accepted.id]?.status === "completed"
      );
    });

    const recovered = await engine.store.getRun(runId);
    const validations = Object.values(recovered.actionExecutions ?? {}).filter(
      (action) => action.boundary.kind === "assignment_validation",
    );
    expect(compilationCount).toBe(2);
    expect(
      Object.values(recovered.attempts).filter((attempt) => attempt.ticketId === "ticket-one"),
    ).toHaveLength(1);
    expect(recovered.attempts[accepted.id]?.status).toBe("completed");
    expect(validations).toHaveLength(1);
    expect(recovered.actionExecutions?.[failed.invocationId]).toMatchObject({
      settlement: { disposition: "completed" },
      compilerRetryHistory: [{ journal: { status: "failed" } }],
    });
    expect(
      validations.filter((action) => action.settlement?.disposition === "completed"),
    ).toHaveLength(1);
    expect(
      recovered.activity.some((entry) =>
        entry.message.includes("Retrying compiler validation from accepted output"),
      ),
    ).toBe(true);
    client.close();
  }, 30_000);

  it("charges a forked continuation for the discovery its inherited transcript already paid for", () => {
    // A recovery fork keeps the parent's results in its transcript, so it can reuse them. Counting
    // the budget per attempt handed each fork a fresh allowance anyway, which under a recovery loop
    // let one planning stage spend far past its configured ceiling.
    const attempt = (
      id: string,
      accepted: number,
      parent?: string,
      fork = true,
    ): AgentAttemptRecord =>
      ({
        id,
        authorityToolResults: Array.from({ length: accepted }, (_unused, index) => ({
          sequence: index,
          toolName: "koni_read_file",
          outcome: "accepted",
        })),
        ...(parent === undefined
          ? { lineage: { branchEpoch: 0, reason: "initial" } }
          : {
              lineage: {
                branchEpoch: 1,
                reason: "recovery",
                parentAttemptId: parent,
                ...(fork
                  ? {
                      conversationFork: {
                        parentLaunchSpecHash: "sha256:aa",
                        parentTranscriptSha256: "sha256:bb",
                      },
                    }
                  : {}),
              },
            }),
      }) as unknown as AgentAttemptRecord;

    const root = attempt("a", 10);
    const forked = attempt("b", 4, "a");
    const grandchild = attempt("c", 3, "b");
    const freshRoot = attempt("d", 2, "a", false);
    const run = {
      attempts: { a: root, b: forked, c: grandchild, d: freshRoot },
    } as unknown as RunRecord;

    expect(inheritedRepositoryDiscoveryCalls(run, root)).toBe(10);
    expect(inheritedRepositoryDiscoveryCalls(run, forked)).toBe(14);
    expect(inheritedRepositoryDiscoveryCalls(run, grandchild)).toBe(17);
    // No conversation fork means an empty session with nothing to reuse, so it legitimately restarts.
    expect(inheritedRepositoryDiscoveryCalls(run, freshRoot)).toBe(2);
  });

  it("reconciles a stalled attempt that no live process backs and re-drives the run", async () => {
    const root = await repository();
    const base = configuredValidationDirectProgram();
    const compileAssignmentOutput = base.compileAssignmentOutput.bind(base);
    let compilationCount = 0;
    const program: RunCompilerProgram = {
      ...base,
      async compileAssignmentOutput(input) {
        compilationCount += 1;
        if (compilationCount === 1) {
          throw new Error("simulated compiler review-effect compatibility failure");
        }
        return compileAssignmentOutput(input);
      },
    };
    let engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    let client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "reconcile-stalled-attempt");
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return Object.values(current.actionExecutions ?? {}).some(
        (action) =>
          action.boundary.kind === "assignment_validation" && action.journal.status === "failed",
      );
    });

    // The wedge observed in the field: the record still asserts an accepted attempt, the run is not
    // blocked, and nothing will dispatch again. Capture it before reconciliation can act on it.
    const wedged = await engine.store.getRun(runId);
    const accepted = Object.values(wedged.attempts).find(
      (attempt) => attempt.ticketId === "ticket-one",
    )!;
    expect(wedged.lifecycle.phase).not.toBe("blocked");
    expect(accepted.status).toBe("terminal_accepted");
    expect(accepted.terminalPolicy).toBeUndefined();

    client.close();
    await engine.server.stop();

    // A fresh supervisor owns no handle for that attempt, which is exactly the divergence between
    // record and reality that reconciliation exists to repair.
    engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.1",
      program,
      supervisor: new ManagedSessionSupervisor(),
      reconcileIntervalMs: 25,
      attemptStallMs: 50,
    });
    engines.push(engine);
    await engine.start();
    client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.1" });

    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return current.attempts[accepted.id]?.status === "interrupted";
    });

    const reconciled = await engine.store.getRun(runId);
    expect(reconciled.attempts[accepted.id]).toMatchObject({
      status: "interrupted",
      error: expect.stringContaining("no live process"),
    });
    expect(
      reconciled.activity.some((entry) => entry.message.includes("Reconciliation retired")),
    ).toBe(true);
    // An interrupted acceptance is only legal when its bound validation action is abandoned in the
    // same CAS, and the repair must leave the run dispatchable rather than merely tidy.
    expect(
      Object.values(reconciled.actionExecutions ?? {}).find(
        (action) => action.boundary.kind === "assignment_validation",
      )?.settlement?.disposition,
    ).toBe("abandoned");
    expect(reconciled.tickets["ticket-one"]?.steps.at(-1)?.status).toBe("pending");
    expect(reconciled.lifecycle.phase).toBe("executing");
    expect(reconciled.lifecycle.blocker).toBeUndefined();
    client.close();
  }, 30_000);

  it("retires a compensated assignment validation and reissues the step with a fresh attempt", async () => {
    const root = await repository();
    const base = configuredValidationDirectProgram("compile-with-compensation");
    const compileAssignmentOutput = base.compileAssignmentOutput.bind(base);
    let compilationCount = 0;
    const program: RunCompilerProgram = {
      ...base,
      async compileAssignmentOutput(input) {
        compilationCount += 1;
        if (compilationCount === 1) {
          throw new Error("agent graph delta targets a stale graph hash");
        }
        return compileAssignmentOutput(input);
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "reissue-compensated-validation");

    // The first attempt's validation compensates (stale graph CAS); the run must NOT block —
    // the engine retires the accepted attempt and a fresh attempt settles cleanly.
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return Object.values(current.actionExecutions ?? {}).some(
        (action) =>
          action.boundary.kind === "assignment_validation" &&
          action.settlement?.disposition === "completed",
      );
    });

    const recovered = await engine.store.getRun(runId);
    expect(recovered.lifecycle.phase).not.toBe("blocked");
    expect(recovered.lifecycle.blocker).toBeUndefined();
    expect(compilationCount).toBe(2);
    const attempts = Object.values(recovered.attempts).filter(
      (attempt) => attempt.ticketId === "ticket-one",
    );
    expect(attempts).toHaveLength(2);
    const retired = attempts.find((attempt) => attempt.status === "interrupted");
    expect(retired?.terminalSummary).toContain(
      "Retired accepted output after a compensated validation",
    );
    expect(retired?.terminalSummary).toContain("agent graph delta targets a stale graph hash");
    const validations = Object.values(recovered.actionExecutions ?? {}).filter(
      (action) => action.boundary.kind === "assignment_validation",
    );
    expect(
      validations.some(
        (action) =>
          action.settlement?.disposition === "abandoned" && action.journal.status === "compensated",
      ),
    ).toBe(true);
    expect(
      recovered.tickets["ticket-one"]?.steps.every(
        (step) => step.status === "completed" || step.status === "skipped",
      ),
    ).toBe(true);
    expect(
      recovered.activity.some((entry) => entry.message.includes("reissuing the step fresh")),
    ).toBe(true);
    client.close();
  }, 30_000);

  it("records a durable blocker when compensated validation reissues are exhausted", async () => {
    const root = await repository();
    const base = configuredValidationDirectProgram("compile-with-compensation");
    const prepareAttempt = base.prepareAttempt.bind(base);
    const program: RunCompilerProgram = {
      ...base,
      async resolveRun(request) {
        const resolved = await base.resolveRun(request);
        return {
          ...resolved,
          executionConfig: { ...resolved.executionConfig, maxParallel: 2 },
        };
      },
      async initializeApprovedPlan() {
        const first = ticket();
        first.steps[0]!.validationAction = "compile-with-compensation";
        first.readPaths = ["README.md"];
        const sibling = structuredClone(first);
        sibling.id = "ticket-two";
        sibling.title = "Keep independent work in flight";
        sibling.targetNodeIds = ["change-two"];
        sibling.readPaths = ["CHANGELOG.md"];
        sibling.writePaths = ["CHANGELOG.md"];
        return {
          graphHash: `sha256:${"c".repeat(64)}`,
          graphRevision: 1,
          tickets: { [first.id]: first, [sibling.id]: sibling },
        };
      },
      async prepareAttempt(input) {
        const prepared = await prepareAttempt(input);
        if (input.assignment?.ticketId !== "ticket-two") return prepared;
        return {
          ...prepared,
          factory: async () => new HangingAdapter(prepared.spec),
        };
      },
      async compileAssignmentOutput() {
        throw new Error("agent graph delta targets a stale graph hash");
      },
    };
    const supervisor = new ManagedSessionSupervisor();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor,
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "exhaust-compensated-validation");

    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "blocked");
    const blocked = await engine.store.getRun(runId);
    expect(blocked.lifecycle.blocker).toContain("ticket validation action did not complete");
    const attempts = Object.values(blocked.attempts).filter(
      (attempt) => attempt.ticketId === "ticket-one",
    );
    // The bounded budget is three *compensated recoveries*. The final accepted attempt is
    // therefore the fourth launch; unrelated prior failures/restarts must not consume it.
    expect(attempts).toHaveLength(4);
    expect(attempts.filter((attempt) => attempt.status === "interrupted")).toHaveLength(3);
    expect(attempts.at(-1)).toMatchObject({ status: "terminal_accepted" });
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return (
        supervisor.list(runId).length === 0 &&
        Object.values(current.attempts).find((attempt) => attempt.ticketId === "ticket-two")
          ?.status === "aborted"
      );
    });
    const settled = await engine.store.getRun(runId);
    expect(
      Object.values(settled.attempts).find((attempt) => attempt.ticketId === "ticket-two"),
    ).toMatchObject({ status: "aborted" });
    expect(settled.tickets["ticket-two"]).toMatchObject({
      status: "queued",
      steps: [expect.objectContaining({ status: "pending" })],
    });
    client.close();
  }, 30_000);

  it("closes terminal validation without publication when pause wins the final assignment CAS", async () => {
    const root = await repository();
    const reached = deferred<void>();
    const release = deferred<void>();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: configuredValidationDirectProgram(),
      supervisor: new ManagedSessionSupervisor(),
      actionFault: async (point, input) => {
        if (point !== "before_assignment_settle" || input.ticketId !== "ticket-one") return;
        reached.resolve();
        await release.promise;
      },
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "pause-terminal-settlement");
    await reached.promise;
    await client.request("authority.ping");
    await client.request(
      "run.pause",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "pause-terminal-settlement",
      },
    );
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "paused");

    const paused = await engine.store.getRun(runId);
    const attempt = Object.values(paused.attempts).find(
      (candidate) => candidate.ticketId === "ticket-one",
    )!;
    const validation = Object.values(paused.actionExecutions ?? {}).find(
      (candidate) => candidate.boundary.kind === "assignment_validation",
    )!;
    expect(attempt.status).toBe("interrupted");
    expect(attempt.terminalOutputSha256).toMatch(/^sha256:/u);
    expect(attempt.terminalPolicy).toBeUndefined();
    expect(validation.settledAt).toBeDefined();
    expect(validation.settlement?.disposition).toBe("abandoned");
    expect(
      Object.values(paused.terminalSuccessProofs ?? {}).some(
        (proof) => proof.attemptId === attempt.id,
      ),
    ).toBe(false);
    expect(
      Object.values(paused.terminalFailureProofs ?? {}).some(
        (proof) => proof.attemptId === attempt.id,
      ),
    ).toBe(false);
    expect(paused.tickets["ticket-one"]).toMatchObject({ status: "queued" });
    expect(paused.tickets["ticket-one"]?.steps[0]).toMatchObject({ status: "pending" });
    expect(Object.values(paused.tickets).filter((ticket) => ticket.status === "proposed")).toEqual(
      [],
    );
    const stoppedActivity = structuredClone(paused.activity);

    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const stillPaused = await engine.store.getRun(runId);
    expect(stillPaused.lifecycle.phase).toBe("paused");
    expect(stillPaused.lifecycle.blocker).toBeUndefined();
    expect(stillPaused.activity).toEqual(stoppedActivity);
    expect(
      Object.values(stillPaused.tickets).filter((ticket) => ticket.status === "proposed"),
    ).toEqual([]);

    await client.request("authority.ping");
    await client.request(
      "run.resume",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "resume-after-terminal-settlement-pause",
      },
    );
    await waitFor(async () =>
      Object.values((await engine.store.getRun(runId)).attempts).some(
        (candidate) => candidate.id !== attempt.id && candidate.ticketId === "ticket-one",
      ),
    );
    const resumed = await engine.store.getRun(runId);
    expect(resumed.attempts[attempt.id]?.status).toBe("interrupted");
    expect(resumed.actionExecutions?.[validation.invocationId]?.settlement?.disposition).toBe(
      "abandoned",
    );
    expect(
      Object.values(resumed.terminalSuccessProofs ?? {}).some(
        (proof) => proof.attemptId === attempt.id,
      ),
    ).toBe(false);
    expect(
      Object.values(resumed.terminalFailureProofs ?? {}).some(
        (proof) => proof.attemptId === attempt.id,
      ),
    ).toBe(false);
    client.close();
  }, 30_000);

  it("closes terminal validation without publication when deletion wins the final assignment CAS", async () => {
    const root = await repository();
    const reached = deferred<void>();
    const release = deferred<void>();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: configuredValidationDirectProgram(),
      supervisor: new ManagedSessionSupervisor(),
      actionFault: async (point, input) => {
        if (point !== "before_assignment_settle" || input.ticketId !== "ticket-one") return;
        reached.resolve();
        await release.promise;
      },
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "delete-terminal-settlement");
    await reached.promise;
    await client.request("authority.ping");
    await authorizeDelete(client, runId, "delete-terminal-settlement", "preserve_branches");
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "deleted");

    const deleted = await engine.store.getRun(runId);
    const attempt = Object.values(deleted.attempts).find(
      (candidate) => candidate.ticketId === "ticket-one",
    )!;
    const validation = Object.values(deleted.actionExecutions ?? {}).find(
      (candidate) => candidate.boundary.kind === "assignment_validation",
    )!;
    expect(attempt.status).toBe("interrupted");
    expect(attempt.terminalOutputSha256).toMatch(/^sha256:/u);
    expect(attempt.terminalPolicy).toBeUndefined();
    expect(validation.settledAt).toBeDefined();
    expect(validation.settlement?.disposition).toBe("abandoned");
    expect(
      Object.values(deleted.terminalSuccessProofs ?? {}).some(
        (proof) => proof.attemptId === attempt.id,
      ),
    ).toBe(false);
    expect(
      Object.values(deleted.terminalFailureProofs ?? {}).some(
        (proof) => proof.attemptId === attempt.id,
      ),
    ).toBe(false);
    expect(Object.values(deleted.tickets).filter((ticket) => ticket.status === "proposed")).toEqual(
      [],
    );
    const stoppedActivity = structuredClone(deleted.activity);

    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const stillDeleted = await engine.store.getRun(runId);
    expect(stillDeleted.lifecycle.phase).toBe("deleted");
    expect(stillDeleted.lifecycle.blocker).toBeUndefined();
    expect(stillDeleted.activity).toEqual(stoppedActivity);
    expect(
      Object.values(stillDeleted.tickets).filter((ticket) => ticket.status === "proposed"),
    ).toEqual([]);
    client.close();
  }, 30_000);

  it("recovers a completed validation action whose terminal policy was not yet attached", async () => {
    const root = await repository();
    const reached = deferred<void>();
    const release = deferred<void>();
    const program = configuredValidationDirectProgram();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
      actionFault: async (point, input) => {
        if (point !== "before_assignment_settle" || input.ticketId !== "ticket-one") return;
        reached.resolve();
        await release.promise;
      },
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(
      client,
      engine,
      "recover-terminal-policy-settlement",
    );
    await reached.promise;
    const admitted = await engine.store.getRun(runId);
    const admittedAttempt = Object.values(admitted.attempts).find(
      (candidate) => candidate.ticketId === "ticket-one",
    )!;
    const admittedAction = Object.values(admitted.actionExecutions ?? {}).find(
      (candidate) => candidate.boundary.kind === "assignment_validation",
    )!;
    expect(admittedAttempt.status).toBe("terminal_accepted");
    expect(admittedAttempt.terminalOutputSha256).toMatch(/^sha256:/u);
    expect(admittedAttempt.terminalPolicy).toBeUndefined();
    expect(admittedAction.journal.status).toBe("completed");
    expect(admittedAction.settledAt).toBeUndefined();

    // Stop only the authority listener, as an abrupt daemon exit would. The held old continuation
    // cannot mutate; startup recovery in the new authority instance owns the pending action.
    client.close();
    await engine.server.stop();
    const restarted = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(restarted);
    await restarted.start();
    await waitFor(async () => {
      const recovered = await restarted.store.getRun(runId);
      const action = recovered.actionExecutions?.[admittedAction.invocationId];
      return (
        action?.settledAt !== undefined &&
        recovered.attempts[admittedAttempt.id]?.terminalPolicy !== undefined
      );
    });
    const recovered = await restarted.store.getRun(runId);
    expect(recovered.actionExecutions?.[admittedAction.invocationId]?.settlement?.disposition).toBe(
      "completed",
    );
    expect(recovered.attempts[admittedAttempt.id]?.terminalPolicy).toBeDefined();
    release.resolve();
  }, 30_000);

  it("re-admits an abandoned approved-plan compile after pause and restart", async () => {
    const root = await repository();
    const reached = deferred<void>();
    const release = deferred<void>();
    let held = false;
    const program = directApprovalProgram();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
      actionFault: async (point, input) => {
        if (point !== "before_journal" || held || input.journal === undefined) return;
        held = true;
        reached.resolve();
        await release.promise;
      },
    });
    engines.push(engine);
    await engine.start();
    let client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const created = await client.request(
      "run.create",
      {
        objective: "Resume approval compilation",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Resume approval compilation" },
      },
      { expectedRevision: 0, idempotencyKey: "create-resume-approval-compile" },
    );
    const runId = (created.result as { runId: string }).runId;
    await waitFor(
      async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
    );
    await client.request("authority.ping");
    await client.request(
      "plan.approve",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "approve-resume-approval-compile",
      },
    );
    await reached.promise;
    await client.request("authority.ping");
    await client.request(
      "run.pause",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "pause-resume-approval-compile",
      },
    );
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "paused");
    const paused = await engine.store.getRun(runId);
    const abandoned = Object.values(paused.actionExecutions ?? {}).find(
      (action) => action.boundary.kind === "approved_plan_compile",
    )!;
    expect(paused.lifecycle.resumePhase).toBe("approving");
    expect(paused.plan?.status).toBe("approving");
    expect(abandoned.settlement?.disposition).toBe("abandoned");
    const stoppedActivity = structuredClone(paused.activity);

    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const stillPaused = await engine.store.getRun(runId);
    expect(stillPaused.lifecycle.blocker).toBeUndefined();
    expect(stillPaused.activity).toEqual(stoppedActivity);
    expect(stillPaused.actionExecutions?.[abandoned.invocationId]?.settlement).toEqual(
      abandoned.settlement,
    );
    client.close();
    await engine.stop();
    const restarted = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(restarted);
    await restarted.start();
    expect((await restarted.store.getRun(runId)).lifecycle.phase).toBe("paused");
    client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });
    await client.request(
      "run.resume",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "resume-approval-compile",
      },
    );
    await waitFor(
      async () =>
        Object.values((await restarted.store.getRun(runId)).actionExecutions ?? {}).filter(
          (action) => action.boundary.kind === "approved_plan_compile",
        ).length === 2,
    );
    await waitFor(async () =>
      Object.values((await restarted.store.getRun(runId)).actionExecutions ?? {}).some(
        (action) =>
          action.boundary.kind === "approved_plan_compile" &&
          action.invocationId !== abandoned.invocationId &&
          action.settlement?.disposition === "completed",
      ),
    );
    const resumed = await restarted.store.getRun(runId);
    const compiles = Object.values(resumed.actionExecutions ?? {}).filter(
      (action) => action.boundary.kind === "approved_plan_compile",
    );
    expect(compiles).toHaveLength(2);
    expect(
      compiles.find((action) => action.invocationId === abandoned.invocationId)?.settlement,
    ).toEqual(abandoned.settlement);
    expect(
      compiles.find((action) => action.invocationId !== abandoned.invocationId)?.settlement
        ?.disposition,
    ).toBe("completed");
    client.close();
  }, 30_000);

  it("abandons a pre-provider Lead launch and admits one fresh launch after restart", async () => {
    const root = await repository();
    const reached = deferred<void>();
    const release = deferred<void>();
    const base = directApprovalProgram();
    let preparedSessions = 0;
    const program: RunCompilerProgram = {
      ...base,
      async prepareAttempt(input) {
        preparedSessions += 1;
        return base.prepareAttempt(input);
      },
    };
    let held = false;
    let engine!: RunAuthorityEngine;
    engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
      actionFault: async (point, input) => {
        if (point !== "before_journal" || held || input.journal?.status !== "completed") return;
        const action = (await engine.store.getRun(input.runId)).actionExecutions?.[
          input.invocationId
        ];
        if (action?.boundary.kind !== "lead_launch") return;
        held = true;
        reached.resolve();
        await release.promise;
      },
    });
    engines.push(engine);
    await engine.start();
    let client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "pause-pre-provider-lead");
    await reached.promise;
    expect(preparedSessions).toBe(0);
    await client.request("authority.ping");
    await client.request(
      "run.pause",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "pause-pre-provider-lead",
      },
    );
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "paused");
    const paused = await engine.store.getRun(runId);
    const abandoned = Object.values(paused.actionExecutions ?? {}).find(
      (action) => action.boundary.kind === "lead_launch",
    )!;
    expect(abandoned.settlement?.disposition).toBe("abandoned");
    expect(Object.values(paused.attempts).filter((attempt) => attempt.kind === "lead")).toEqual([]);
    expect(preparedSessions).toBe(0);
    const activityCount = paused.activity.length;

    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const afterLateCompletion = await engine.store.getRun(runId);
    expect(afterLateCompletion.lifecycle.phase).toBe("paused");
    expect(afterLateCompletion.lifecycle.blocker).toBeUndefined();
    expect(afterLateCompletion.activity).toHaveLength(activityCount);
    expect(preparedSessions).toBe(0);
    client.close();
    await engine.stop();

    const restarted = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(restarted);
    await restarted.start();
    expect((await restarted.store.getRun(runId)).lifecycle.phase).toBe("paused");
    client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });
    await client.request(
      "run.resume",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "resume-pre-provider-lead",
      },
    );
    await waitFor(
      async () =>
        Object.values((await restarted.store.getRun(runId)).actionExecutions ?? {}).filter(
          (action) => action.boundary.kind === "lead_launch",
        ).length === 2,
    );
    await waitFor(async () =>
      Object.values((await restarted.store.getRun(runId)).attempts).some(
        (attempt) => attempt.kind === "lead" && attempt.status === "completed",
      ),
    );
    const resumed = await restarted.store.getRun(runId);
    const launches = Object.values(resumed.actionExecutions ?? {}).filter(
      (action) => action.boundary.kind === "lead_launch",
    );
    expect(
      launches.find((action) => action.invocationId === abandoned.invocationId)?.settlement,
    ).toEqual(abandoned.settlement);
    expect(
      launches.find((action) => action.invocationId !== abandoned.invocationId)?.settlement
        ?.disposition,
    ).toBe("completed");
    expect(preparedSessions).toBeGreaterThan(0);
    client.close();
  }, 30_000);

  it("recompiles a post-orchestration report abandoned by pause before final settlement", async () => {
    const root = await repository();
    const reached = deferred<void>();
    const release = deferred<void>();
    const base = directApprovalProgram();
    let preparedSessions = 0;
    const program: RunCompilerProgram = {
      ...base,
      async prepareAttempt(input) {
        preparedSessions += 1;
        return base.prepareAttempt(input);
      },
    };
    let held = false;
    let engine!: RunAuthorityEngine;
    engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
      actionFault: async (point, input) => {
        if (point !== "before_journal" || held || input.journal?.status !== "completed") return;
        const action = (await engine.store.getRun(input.runId)).actionExecutions?.[
          input.invocationId
        ];
        if (action?.boundary.kind !== "post_orchestration_report") return;
        held = true;
        reached.resolve();
        await release.promise;
      },
    });
    engines.push(engine);
    await engine.start();
    let client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "pause-report-final-cas");
    await reached.promise;
    const beforePause = await engine.store.getRun(runId);
    expect(beforePause.postOrchestration?.report).toBeDefined();
    const preparedBeforeStop = preparedSessions;
    await client.request("authority.ping");
    await client.request(
      "run.pause",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "pause-report-final-cas",
      },
    );
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "paused");
    const paused = await engine.store.getRun(runId);
    const abandoned = Object.values(paused.actionExecutions ?? {}).find(
      (action) => action.boundary.kind === "post_orchestration_report",
    )!;
    expect(abandoned.settlement?.disposition).toBe("abandoned");
    expect(paused.postOrchestration?.report).toBeUndefined();
    // The immutable report artifact/audit row remains, but it has no scheduler authority until
    // a fresh action binds the checkpointed product after resume.
    expect(paused.reports).toHaveLength(1);
    const activityCount = paused.activity.length;

    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const afterLateCompletion = await engine.store.getRun(runId);
    expect(afterLateCompletion.lifecycle.phase).toBe("paused");
    expect(afterLateCompletion.lifecycle.blocker).toBeUndefined();
    expect(afterLateCompletion.postOrchestration?.report).toBeUndefined();
    expect(afterLateCompletion.activity).toHaveLength(activityCount);
    expect(preparedSessions).toBe(preparedBeforeStop);
    client.close();
    await engine.stop();

    const restarted = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(restarted);
    await restarted.start();
    client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });
    await client.request(
      "run.resume",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "resume-report-final-cas",
      },
    );
    await waitFor(
      async () => (await restarted.store.getRun(runId)).lifecycle.phase === "merge_ready",
    );
    const resumed = await restarted.store.getRun(runId);
    const reports = Object.values(resumed.actionExecutions ?? {}).filter(
      (action) => action.boundary.kind === "post_orchestration_report",
    );
    expect(reports).toHaveLength(2);
    expect(
      reports.find((action) => action.invocationId === abandoned.invocationId)?.settlement,
    ).toEqual(abandoned.settlement);
    expect(
      reports.find((action) => action.invocationId !== abandoned.invocationId)?.settlement
        ?.disposition,
    ).toBe("completed");
    const replacement = reports.find((action) => action.invocationId !== abandoned.invocationId)!;
    expect(resumed.postOrchestration?.report?.reportId).toBe(
      replacement.semanticResult?.kind === "report"
        ? replacement.semanticResult.reportId
        : undefined,
    );
    expect(resumed.reports).toHaveLength(2);
    client.close();
  }, 30_000);

  it("requires a fresh operator action after a configured stage is abandoned by pause", async () => {
    const root = await repository();
    const program = configuredStageStopProgram();
    const bootstrap = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(bootstrap);
    await bootstrap.start();
    let client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const created = await client.request(
      "run.create",
      {
        objective: "Pause a configured operator stage",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Pause a configured operator stage" },
      },
      { expectedRevision: 0, idempotencyKey: "create-configured-stage-stop" },
    );
    const runId = (created.result as { runId: string }).runId;
    await waitFor(
      async () => (await bootstrap.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
    );
    client.close();
    await bootstrap.stop();
    await moveRunToConfiguredStage(bootstrap, runId);

    const reached = deferred<void>();
    const release = deferred<void>();
    let held = false;
    let engine!: RunAuthorityEngine;
    engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
      actionFault: async (point, input) => {
        if (point !== "before_journal" || held || input.journal?.status !== "completed") return;
        const action = (await engine.store.getRun(input.runId)).actionExecutions?.[
          input.invocationId
        ];
        if (action?.boundary.kind !== "configured_stage") return;
        held = true;
        reached.resolve();
        await release.promise;
      },
    });
    engines.push(engine);
    await engine.start();
    client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });
    const controls = await runControls(client, runId);
    await executeCurrentConfiguredStage(client, controls, "execute-configured-stage-before-pause");
    await reached.promise;
    await client.request("authority.ping");
    await client.request(
      "run.pause",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "pause-configured-stage",
      },
    );
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "paused");
    const paused = await engine.store.getRun(runId);
    const abandoned = Object.values(paused.actionExecutions ?? {}).find(
      (action) => action.boundary.kind === "configured_stage",
    )!;
    expect(abandoned.settlement?.disposition).toBe("abandoned");
    expect(Object.values(paused.attempts)).toEqual([]);
    const activityCount = paused.activity.length;

    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const afterLateCompletion = await engine.store.getRun(runId);
    expect(afterLateCompletion.lifecycle.phase).toBe("paused");
    expect(afterLateCompletion.lifecycle.blocker).toBeUndefined();
    expect(afterLateCompletion.activity).toHaveLength(activityCount);
    client.close();
    await engine.stop();

    const restarted = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(restarted);
    await restarted.start();
    client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });
    await client.request(
      "run.resume",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "resume-configured-stage",
      },
    );
    const resumedControls = await runControls(client, runId);
    await executeCurrentConfiguredStage(client, resumedControls, "execute-fresh-configured-stage");
    await waitFor(
      async () => (await restarted.store.getRun(runId)).currentPipelineStageId === "approval",
    );
    const resumed = await restarted.store.getRun(runId);
    const actions = Object.values(resumed.actionExecutions ?? {}).filter(
      (action) => action.boundary.kind === "configured_stage",
    );
    expect(actions).toHaveLength(2);
    expect(
      actions.find((action) => action.invocationId === abandoned.invocationId)?.settlement,
    ).toEqual(abandoned.settlement);
    expect(
      actions.find((action) => action.invocationId !== abandoned.invocationId)?.settlement
        ?.disposition,
    ).toBe("completed");
    expect(Object.values(resumed.attempts)).toEqual([]);
    client.close();
  }, 30_000);

  it("settles a recovery parent and child exactly once when pause or delete wins", async () => {
    for (const stopMode of ["pause", "delete"] as const) {
      const root = await repository();
      const program = configuredStageStopProgram(true);
      const bootstrap = await RunAuthorityEngine.open({
        projectRoot: root,
        version: "1.0.0",
        program,
        supervisor: new ManagedSessionSupervisor(),
      });
      engines.push(bootstrap);
      await bootstrap.start();
      let client = await AuthorityClient.connect({
        projectRoot: root,
        client: "tui",
        version: "1.0.0",
      });
      const created = await client.request(
        "run.create",
        {
          objective: `${stopMode} a configured recovery pair`,
          runTypeId: "small",
          targetRef: "refs/heads/main",
          intake: { goal: `${stopMode} a configured recovery pair` },
        },
        { expectedRevision: 0, idempotencyKey: `create-recovery-${stopMode}` },
      );
      const runId = (created.result as { runId: string }).runId;
      await waitFor(
        async () => (await bootstrap.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
      );
      client.close();
      await bootstrap.stop();
      await moveRunToConfiguredStage(bootstrap, runId);

      const reached = deferred<void>();
      const release = deferred<void>();
      let held = false;
      let engine!: RunAuthorityEngine;
      engine = await RunAuthorityEngine.open({
        projectRoot: root,
        version: "1.0.0",
        program,
        supervisor: new ManagedSessionSupervisor(),
        actionFault: async (point, input) => {
          if (point !== "before_journal" || held || input.journal?.status !== "completed") return;
          const action = (await engine.store.getRun(input.runId)).actionExecutions?.[
            input.invocationId
          ];
          if (action?.boundary.kind !== "recovery") return;
          held = true;
          reached.resolve();
          await release.promise;
        },
      });
      engines.push(engine);
      await engine.start();
      client = await AuthorityClient.connect({
        projectRoot: root,
        client: "tui",
        version: "1.0.0",
      });
      expect(
        Object.keys((await engine.store.getRun(runId)).behavior?.actions.actions ?? {}),
      ).toEqual(expect.arrayContaining(["recoverable-check", "recover-check"]));
      await executeCurrentConfiguredStage(
        client,
        await runControls(client, runId),
        `execute-recovery-before-${stopMode}`,
      );
      await reached.promise;
      const beforeStop = await engine.store.getRun(runId);
      const admittedParent = Object.values(beforeStop.actionExecutions ?? {}).find(
        (action) => action.boundary.kind === "configured_stage",
      )!;
      const admittedChild = Object.values(beforeStop.actionExecutions ?? {}).find(
        (action) => action.boundary.kind === "recovery",
      )!;
      expect(admittedParent.journal.status).toBe("recovery_required");
      expect(admittedParent.recoveryInvocationId).toBe(admittedChild.invocationId);
      expect(admittedParent.settlement).toBeUndefined();
      expect(admittedChild.settlement).toBeUndefined();
      expect(Object.values(beforeStop.attempts)).toEqual([]);

      await client.request("authority.ping");
      if (stopMode === "pause") {
        await client.request(
          "run.pause",
          { runId },
          {
            expectedRevision: client.revision,
            idempotencyKey: "pause-recovery-pair",
          },
        );
      } else {
        await authorizeDelete(client, runId, "delete-recovery-pair", "preserve_branches");
      }
      const terminalPhase = stopMode === "pause" ? "paused" : "deleted";
      await waitFor(
        async () => (await engine.store.getRun(runId)).lifecycle.phase === terminalPhase,
      );
      const stopped = await engine.store.getRun(runId);
      const parent = stopped.actionExecutions?.[admittedParent.invocationId]!;
      const child = stopped.actionExecutions?.[admittedChild.invocationId]!;
      expect(parent.settlement?.disposition).toBe("abandoned");
      expect(child.settlement?.disposition).toBe("abandoned");
      expect(parent.recoveryInvocationId).toBe(child.invocationId);
      expect(parent.recoverySettledAt).toBeDefined();
      expect(Object.values(stopped.attempts)).toEqual([]);
      const parentSettlement = structuredClone(parent.settlement);
      const childSettlement = structuredClone(child.settlement);
      const activityCount = stopped.activity.length;

      release.resolve();
      await new Promise((resolve) => setTimeout(resolve, 25));
      const afterLateCompletion = await engine.store.getRun(runId);
      expect(afterLateCompletion.lifecycle.phase).toBe(terminalPhase);
      expect(afterLateCompletion.lifecycle.blocker).toBeUndefined();
      expect(afterLateCompletion.activity).toHaveLength(activityCount);
      expect(afterLateCompletion.actionExecutions?.[parent.invocationId]?.settlement).toEqual(
        parentSettlement,
      );
      expect(afterLateCompletion.actionExecutions?.[child.invocationId]?.settlement).toEqual(
        childSettlement,
      );
      client.close();
      await engine.stop();

      const restarted = await RunAuthorityEngine.open({
        projectRoot: root,
        version: "1.0.0",
        program,
        supervisor: new ManagedSessionSupervisor(),
      });
      engines.push(restarted);
      await restarted.start();
      const recovered = await restarted.store.getRun(runId);
      expect(recovered.lifecycle.phase).toBe(terminalPhase);
      expect(recovered.actionExecutions?.[parent.invocationId]?.settlement).toEqual(
        parentSettlement,
      );
      expect(recovered.actionExecutions?.[child.invocationId]?.settlement).toEqual(childSettlement);
      expect(Object.values(recovered.attempts)).toEqual([]);
      if (stopMode === "pause") {
        client = await AuthorityClient.connect({
          projectRoot: root,
          client: "tui",
          version: "1.0.0",
        });
        await client.request(
          "run.resume",
          { runId },
          {
            expectedRevision: client.revision,
            idempotencyKey: "resume-after-recovery-pair",
          },
        );
        const resumed = await restarted.store.getRun(runId);
        expect(resumed.lifecycle.phase).toBe("awaiting_approval");
        expect(resumed.actionExecutions?.[parent.invocationId]?.settlement).toEqual(
          parentSettlement,
        );
        expect(resumed.actionExecutions?.[child.invocationId]?.settlement).toEqual(childSettlement);
        client.close();
      }
    }
  }, 30_000);

  it("keeps a checkpointed ticket in review when pause wins before run-ref publication", async () => {
    const root = await repository();
    const entered = deferred<void>();
    const release = deferred<void>();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: directApprovalProgram(),
      supervisor: new ManagedSessionSupervisor(),
      lifecycleFault: async (point) => {
        if (point !== "after_ticket_checkpoint") return;
        entered.resolve();
        await release.promise;
      },
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "pause-after-checkpoint");
    await entered.promise;

    await client.request("authority.ping");
    await client.request(
      "run.pause",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "pause-after-ticket-checkpoint",
      },
    );
    release.resolve();
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "paused");

    const paused = await engine.store.getRun(runId);
    const ticket = paused.tickets["ticket-one"]!;
    expect(ticket.status).toBe("review");
    expect(paused.git.ticketCycles[ticket.gitCycleId!]?.status).toBe("candidate");
    expect(paused.activity.some((entry) => entry.message.startsWith("Integrated ticket:"))).toBe(
      false,
    );
    expect(
      Object.values(paused.tickets).some((entry) => entry.integrationForTicketId === ticket.id),
    ).toBe(false);
    client.close();
  }, 30_000);

  it("CAS-compensates a run-ref publication when delete wins before intent settlement", async () => {
    const root = await repository();
    const harness = new GitConflictHarness();
    const entered = deferred<void>();
    const release = deferred<void>();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: gitConflictProgram(harness),
      supervisor: new ManagedSessionSupervisor(),
      lifecycleFault: async (point) => {
        if (point !== "before_publication_settle") return;
        entered.resolve();
        await release.promise;
      },
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "delete-during-publication");
    await entered.promise;

    await client.request("authority.ping");
    await authorizeDelete(client, runId, "delete-before-publication-settle");
    release.resolve();
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "deleted");

    const deleted = await engine.store.getRun(runId);
    expect(deleted.tickets["ticket-one"]?.status).toBe("review");
    expect(deleted.pendingGitIntents).toEqual({});
    expect(deleted.activity.some((entry) => entry.message.startsWith("Integrated ticket:"))).toBe(
      false,
    );
    expect(
      Object.values(deleted.tickets).some((entry) => entry.integrationForTicketId === "ticket-one"),
    ).toBe(false);
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("initial\n");
    client.close();
  }, 30_000);

  it("drops an in-flight verification result when pause wins before promotion", async () => {
    const root = await repository();
    const entered = deferred<void>();
    const release = deferred<void>();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: directApprovalProgram(),
      supervisor: new ManagedSessionSupervisor(),
      lifecycleFault: async (point) => {
        if (point !== "after_verification") return;
        entered.resolve();
        await release.promise;
      },
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "pause-after-verification");
    await entered.promise;

    await client.request("authority.ping");
    await client.request(
      "run.pause",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "pause-after-verification-result",
      },
    );
    release.resolve();
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "paused");

    const paused = await engine.store.getRun(runId);
    expect(paused.lifecycle.resumePhase).toBe("verifying");
    expect(paused.git.promotion).toBeUndefined();
    expect(paused.reports ?? []).toEqual([]);
    expect(paused.activity.some((entry) => entry.message === "Verification passed")).toBe(false);
    client.close();
  }, 30_000);

  it("admits newly applicable compiler tickets discovered at the verification fixpoint", async () => {
    const root = await repository();
    const direct = directApprovalProgram();
    let discoveryCalls = 0;
    const program: RunCompilerProgram = {
      ...direct,
      async verifyRun(run) {
        if (run.tickets["ticket-verification-followup"] === undefined) {
          discoveryCalls += 1;
          const followup = ticket();
          followup.id = "ticket-verification-followup";
          followup.title = "Complete compiler-discovered follow-up";
          followup.summary = "Verification authenticated one newly applicable bounded change";
          return {
            ok: false,
            reason:
              "Verification found 1 still-applicable compiler ticket: Complete compiler-discovered follow-up",
            tickets: {
              ...structuredClone(run.tickets),
              [followup.id]: followup,
            },
          };
        }
        return direct.verifyRun(run);
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "verification-fixpoint-followup");

    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      if (current.lifecycle.phase === "blocked" || current.lifecycle.phase === "failed") {
        throw new Error(
          current.lifecycle.blocker ?? current.lifecycle.terminalReason ?? "run stopped",
        );
      }
      return current.lifecycle.phase === "merge_ready";
    });

    const ready = await engine.store.getRun(runId);
    expect(discoveryCalls).toBe(1);
    expect(ready.tickets["ticket-one"]?.status).toBe("completed");
    expect(ready.tickets["ticket-verification-followup"]?.status).toBe("completed");
    expect(
      ready.activity.some((entry) => entry.message.includes("compiler-discovered follow-up")),
    ).toBe(true);
    client.close();
  }, 30_000);

  it("reissues a completed ticket once when its compiler predicate remains applicable", async () => {
    const root = await repository();
    const direct = directApprovalProgram();
    const lifecycleCatalog = reissuableLifecycleCatalog();
    let rediscoveries = 0;
    const program: RunCompilerProgram = {
      ...direct,
      async resolveRun(request) {
        return { ...(await direct.resolveRun(request)), lifecycleCatalog };
      },
      async verifyRun(run) {
        if (rediscoveries === 0 && run.tickets["ticket-one"]?.status === "completed") {
          rediscoveries += 1;
          return {
            ok: false,
            reason: "Verification found 1 still-applicable compiler ticket: Execute work",
            tickets: structuredClone(run.tickets),
            applicableTicketIds: ["ticket-one"],
          };
        }
        return direct.verifyRun(run);
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(
      client,
      engine,
      "verification-reissues-current-ticket",
    );

    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      if (current.lifecycle.phase === "blocked" || current.lifecycle.phase === "failed") {
        throw new Error(
          current.lifecycle.blocker ?? current.lifecycle.terminalReason ?? "run stopped",
        );
      }
      return current.lifecycle.phase === "merge_ready";
    });

    const ready = await engine.store.getRun(runId);
    expect(rediscoveries).toBe(1);
    expect(ready.tickets["ticket-one"]?.status).toBe("completed");
    expect(ready.tickets["ticket-one"]?.executionEpoch).toBe(1);
    const attemptIds = ready.tickets["ticket-one"]?.steps[0]?.attemptIds ?? [];
    expect(attemptIds).toHaveLength(2);
    expect(ready.attempts[attemptIds[0]!]!.ticketExecutionEpoch).toBe(0);
    expect(ready.attempts[attemptIds[1]!]!.ticketExecutionEpoch).toBe(1);
    expect(ready.attempts[attemptIds[1]!]!.lineage).toEqual({
      branchEpoch: 0,
      reason: "initial",
    });
    expect(
      ready.activity.some((entry) =>
        entry.message.includes(
          "Reissued completed ticket whose compiler predicate is still applicable",
        ),
      ),
    ).toBe(true);
    client.close();
  }, 30_000);

  it("revalidates a merge-ready run when an explicit resume discovers compiler work", async () => {
    const root = await repository();
    const direct = directApprovalProgram();
    let exposeFollowup = false;
    const program: RunCompilerProgram = {
      ...direct,
      async reconcileTicketBoard(run) {
        const tickets = structuredClone(run.tickets);
        if (exposeFollowup && tickets["ticket-merge-ready-followup"] === undefined) {
          const followup = ticket();
          followup.id = "ticket-merge-ready-followup";
          followup.title = "Execute merge-ready compiler follow-up";
          followup.summary = "Explicit revalidation discovered newly applicable bounded work";
          tickets[followup.id] = followup;
        }
        return { tickets };
      },
    };
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createAndApproveDirectRun(client, engine, "merge-ready-revalidation");
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "merge_ready");
    const before = await engine.store.getRun(runId);
    const priorReportId = before.postOrchestration?.report?.reportId;
    expect(priorReportId).toBeDefined();

    await client.request("authority.ping");
    await client.request(
      "run.pause",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "pause-before-merge-ready-revalidation",
      },
    );
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "paused");
    expect((await engine.store.getRun(runId)).lifecycle.resumePhase).toBe("merge_ready");

    exposeFollowup = true;
    await client.request("authority.ping");
    const resumed = await client.request(
      "run.resume",
      { runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: "revalidate-merge-ready-run",
      },
    );
    expect(resumed.result).toMatchObject({ runId, status: "executing" });

    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      if (current.lifecycle.phase === "blocked" || current.lifecycle.phase === "failed") {
        throw new Error(
          current.lifecycle.blocker ?? current.lifecycle.terminalReason ?? "run stopped",
        );
      }
      return (
        current.lifecycle.phase === "merge_ready" &&
        current.tickets["ticket-merge-ready-followup"]?.status === "completed"
      );
    });

    const ready = await engine.store.getRun(runId);
    expect(ready.postOrchestration?.report?.reportId).not.toBe(priorReportId);
    expect(ready.reports).toHaveLength((before.reports?.length ?? 0) + 1);
    expect(
      ready.activity.some((entry) =>
        entry.message.includes("Reopened merge-ready run after compiler revalidation"),
      ),
    ).toBe(true);
    client.close();
  }, 30_000);
});

async function createAndApproveDirectRun(
  client: AuthorityClient,
  engine: RunAuthorityEngine,
  label: string,
): Promise<string> {
  const created = await client.request(
    "run.create",
    {
      objective: `Exercise ${label}`,
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: `Exercise ${label}` },
    },
    { expectedRevision: client.revision, idempotencyKey: `create-${label}` },
  );
  const runId = (created.result as { runId: string }).runId;
  await waitFor(
    async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval",
  );
  await client.request("authority.ping");
  await client.request(
    "plan.approve",
    { runId },
    {
      expectedRevision: client.revision,
      idempotencyKey: `approve-${label}`,
    },
  );
  return runId;
}

interface FixtureRunControls {
  protocol: string;
  binding: { runId: string; runRevision: number; generation: number; phase: string };
  stages: Array<{
    id: string;
    current: boolean;
    actions: Array<{
      id: string;
      intent: string;
      availability: { state: string };
    }>;
  }>;
}

async function runControls(client: AuthorityClient, runId: string): Promise<FixtureRunControls> {
  return (await client.request("run.controls", { runId })).result as unknown as FixtureRunControls;
}

async function executeCurrentConfiguredStage(
  client: AuthorityClient,
  controls: FixtureRunControls,
  idempotencyKey: string,
): Promise<void> {
  const stage = controls.stages.find((candidate) => candidate.current);
  const action = stage?.actions.find(
    (candidate) =>
      candidate.intent === "execute_action" && candidate.availability.state === "available",
  );
  if (stage === undefined || action === undefined) {
    throw new Error("fixture configured stage has no available compiler action");
  }
  await client.request(
    "run.action.execute",
    {
      protocol: "koni.stage-action-invocation.v1",
      runId: controls.binding.runId,
      runRevision: controls.binding.runRevision,
      generation: controls.binding.generation,
      capabilityId: action.id,
      confirmed: false,
      values: {},
    },
    {
      expectedRevision: client.revision,
      idempotencyKey,
    },
  );
}

async function moveRunToConfiguredStage(engine: RunAuthorityEngine, runId: string): Promise<void> {
  const current = await engine.store.getRun(runId);
  const draft = structuredClone(current);
  draft.revision += 1;
  draft.updatedAt = new Date().toISOString();
  draft.currentPipelineStageId = "operator-check";
  const state = await engine.store.state();
  await engine.store.commit({
    expectedRevision: state.revision,
    runWrites: [{ record: draft, expectedRevision: current.revision }],
  });
}

async function addCanonicalProposalFixture(run: RunRecord): Promise<TicketRecord> {
  const catalog = proposalSemanticCatalog(run.compiledConfigHash);
  const at = run.updatedAt;
  const source = proposalSourceTicket(catalog, at);
  run.tickets[source.id] = source;

  const sourceOutputSha256 = rawSha256("proposal-source-output");
  const sourceBinding = source.steps[0]!.executionPolicyBinding!;
  const publication = deriveChangeControlPublication(catalog, {
    runId: run.id,
    sourceTicketId: source.id,
    sourceStepId: source.steps[0]!.id,
    sourceOutputSha256,
    sourceBinding,
    targetNodeIds: ["change-one"],
    summary: "Decide whether the upstream contract should change.",
    reason: "The completed source assignment requested one bounded upstream review.",
  });
  const sourceCompilation = {
    protocol: "koni.assignment-change-control.v1" as const,
    kind: "upstream_request" as const,
    sourceTicketId: source.id,
    sourceStepId: source.steps[0]!.id,
    sourceBindingSha256: sourceBinding.sha256,
    sourceOutputSha256: publication.sourceOutputSha256,
    targetNodeIds: publication.targetNodeIds,
    summary: publication.summary,
    reason: publication.reason,
    publication,
  };

  const attemptId = "attempt-proposal-source";
  const terminalPolicyMaterial = {
    protocol: "koni.agent-terminal-policy.v1" as const,
    mode: "legacy_pre_execution_policy" as const,
    acceptedAt: at,
  };
  const terminalPolicy = {
    ...terminalPolicyMaterial,
    sha256: canonicalHash(terminalPolicyMaterial),
  };
  const sourceSummary = "Published one bounded upstream request";
  const attempt: AgentAttemptRecord = {
    id: attemptId,
    sessionId: "session-proposal-source",
    sessionFile: undefined,
    ticketId: source.id,
    stepId: source.steps[0]!.id,
    personaId: source.steps[0]!.personaId,
    modelProvider: "fixture",
    modelId: "fixture-model",
    thinkingLevel: "off",
    status: "completed",
    launchSpecHash: rawSha256("proposal-source-launch"),
    startedAt: at,
    endedAt: at,
    terminalSummary: sourceSummary,
    terminalOutputSha256: sourceOutputSha256,
    terminalOutputSizeBytes: 32,
    terminalAcceptedAt: at,
    terminalPolicy,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    kind: "ticket",
  };
  run.attempts[attempt.id] = attempt;
  source.steps[0]!.status = "completed";
  source.steps[0]!.attemptIds = [attempt.id];
  source.steps[0]!.summary = sourceSummary;
  source.steps[0]!.startedAt = at;
  source.steps[0]!.completedAt = at;

  const prepared = prepareRunActionExecution(run, {
    kind: "assignment_validation",
    stageId: run.currentPipelineStageId ?? "approval",
    selector: "compile",
    checkout: "none",
    ticketId: source.id,
    ticketState: source.status,
    stepId: source.steps[0]!.id,
    attemptId: attempt.id,
    at,
  });
  const effects: RunActionExecutionRecord["effects"] = {};
  const journal = await executeActionPlan(prepared.plan, {
    execute: async (input) => {
      const output = { valid: true };
      effects[input.effectKey] = createRunActionEffectReceipt(input, output, at);
      return output;
    },
  });
  const action: RunActionExecutionRecord = {
    ...structuredClone(prepared),
    journal,
    effects,
    semanticResult: {
      kind: "assignment",
      status: "completed",
      summary: sourceSummary,
      changeControlSha256: canonicalHash(sourceCompilation),
    },
    updatedAt: at,
  };
  action.settlement = createRunActionSettlement(
    action,
    "completed",
    "proposal source assignment compiled",
    at,
  );
  action.settledAt = action.settlement.settledAt;
  run.actionExecutions ??= {};
  run.actionExecutions[action.invocationId] = action;
  const sourceTerminalProof = createTerminalSuccessSettlementProof(run, action);
  if (sourceTerminalProof === undefined) {
    throw new Error("proposal source fixture lacks terminal success proof");
  }
  run.terminalSuccessProofs ??= {};
  run.terminalSuccessProofs[sourceTerminalProof.sha256] = sourceTerminalProof;

  const sourceHold = {
    proposalTicketId: publication.proposalTicketId,
    requestSha256: publication.requestSha256,
  };
  source.executionControl = { sourceHold };
  const definition = proposalControlDefinition(catalog, publication.proposalTicketId);
  const proposalControl: TicketExecutionControlRecord = {
    changeControlScopeNodeIds: [...publication.controlScopeNodeIds],
    proposalRequest: {
      requestSha256: publication.requestSha256,
      sourceTicketId: publication.sourceTicketId,
      sourceStepId: publication.sourceStepId,
      sourceOutputSha256: publication.sourceOutputSha256,
    },
  };
  const proposal = proposalTicketFromDefinition(
    catalog,
    definition,
    `${publication.summary}\n\nReason: ${publication.reason}`,
    proposalControl,
    at,
  );
  const operation = catalog.operations[proposal.operationId]!;
  const workflow = catalog.workflows[operation.workflowId!]!;
  proposalControl.controlTicketAuthority = createCompilerControlTicketAuthority({
    runId: run.id,
    role: "proposal",
    ticket: proposal,
    operation,
    workflow,
    definition,
    causal: {
      role: "proposal",
      publication,
      sourceTicketProjection: ticketImmutableProjection(source),
      sourceTerminalProof,
      sourceHold,
    },
  });
  run.tickets[proposal.id] = proposal;
  return proposal;
}

function proposalSemanticCatalog(
  configurationSha256: Sha256Digest,
): CompiledExecutionSemanticCatalog {
  const registries = {
    operations: {
      ordinary: {
        id: "ordinary",
        operation: "ordinary-work",
        stage: "execution",
        workflow: "ordinary-flow",
        change_control: {
          role: "ordinary",
          allow_upstream_requests: true,
          proposal_operation: "propose-change",
        },
      },
      proposal: {
        id: "proposal",
        operation: "propose-change",
        stage: "change-control",
        workflow: "proposal-flow",
        change_control: {
          role: "proposal",
          proposal_step: "prepare",
          application_operations: ["apply-change"],
        },
      },
      application: {
        id: "application",
        operation: "apply-change",
        stage: "change-control",
        workflow: "application-flow",
        change_control: { role: "application" },
      },
    },
    workflows: {
      "ordinary-flow": proposalWorkflow("ordinary-flow", "ordinary-work", ["work"]),
      "proposal-flow": proposalWorkflow("proposal-flow", "propose-change", ["prepare", "review"]),
      "application-flow": proposalWorkflow("application-flow", "apply-change", [
        "prepare",
        "review",
      ]),
    },
    checks: {},
  };
  return compileExecutionSemanticCatalog({
    configuration_sha256: configurationSha256,
    registries: {
      ...Object.fromEntries(
        [
          "node_types",
          "queries",
          "graph_constraints",
          "gate_policies",
          "rules",
          "actions",
          "personas",
          "reports",
          "views",
          "state_machines",
          "agents",
        ].map((key) => [key, Object.create(null)]),
      ),
      ...registries,
    },
    edge_types: [],
  } as unknown as CompiledConfiguration);
}

function proposalWorkflow(id: string, operation: string, steps: string[]) {
  return {
    id,
    version: "1.0.0",
    applies_to: [operation],
    steps: steps.map((step) => ({ id: step, required: true })),
  };
}

function proposalBinding(
  catalog: CompiledExecutionSemanticCatalog,
  operationId: string,
  stepId?: string,
): ExecutionPolicyBinding {
  const operation = catalog.operations[operationId]!;
  return resolveExecutionPolicyBinding(catalog, {
    configurationSha256: catalog.configurationSha256,
    operationId,
    workflowId: operation.workflowId!,
    ...(stepId === undefined ? {} : { stepId }),
  });
}

function proposalSourceTicket(catalog: CompiledExecutionSemanticCatalog, at: string): TicketRecord {
  return {
    id: "ticket-one",
    operationId: "ordinary",
    title: "Review upstream source",
    summary: "Compile the exact upstream request source.",
    status: "blocked",
    executionPolicyBinding: proposalBinding(catalog, "ordinary"),
    executionControl: {},
    priority: 0,
    dependencyIds: [],
    targetNodeIds: ["change-one"],
    readNodeIds: ["change-one"],
    writeNodeIds: ["change-one"],
    readPaths: [],
    writePaths: [],
    steps: [
      {
        id: "work",
        title: "Work",
        personaId: "worker",
        kind: "production",
        dependsOn: [],
        readNodeIds: ["change-one"],
        writeNodeIds: ["change-one"],
        readPaths: [],
        writePaths: [],
        validationAction: "compile",
        executionPolicyBinding: proposalBinding(catalog, "ordinary", "work"),
        status: "pending",
        attemptIds: [],
        summary: undefined,
        startedAt: undefined,
        completedAt: undefined,
      },
    ],
    worktreePath: undefined,
    branch: undefined,
    blocker: "Awaiting proposal disposition",
    createdAt: at,
    updatedAt: at,
  };
}

function proposalControlDefinition(
  catalog: CompiledExecutionSemanticCatalog,
  id: string,
): DerivedTicketDefinition {
  const operation = catalog.operations.proposal!;
  const workflow = catalog.workflows[operation.workflowId!]!;
  const steps: DerivedWorkflowStep[] = workflow.steps.map((semantic, index) => ({
    id: semantic.id,
    kind: index === workflow.steps.length - 1 ? "review" : "production",
    persona_id: index === workflow.steps.length - 1 ? "reviewer" : "worker",
    depends_on: index === 0 ? [] : [workflow.steps[index - 1]!.id],
    required: true,
    read_node_ids: ["change-one"],
    write_node_ids: [],
    read_paths: [],
    write_paths: [],
    expected_outputs: [
      index === workflow.steps.length - 1 ? "Reviewed request" : "Prepared request",
    ],
    graph_mutation: "forbidden",
    validation_action: index === workflow.steps.length - 1 ? "review-result" : "validate-work",
    required_receipts: [...semantic.requiredReceipts],
    escalation_triggers: [...semantic.escalationTriggers],
    stop_conditions: [...semantic.stopConditions],
    validation_checks: [...semantic.validationChecks],
    context_sha256: rawSha256(`proposal-${semantic.id}-context`),
  }));
  const material = {
    protocol: "koni.derived-ticket.v1" as const,
    id,
    rule_id: "compiler.change-control.proposal",
    rule_phase: operation.stage,
    rule_priority: 0,
    anchor_node_id: "change-one",
    operation: operation.publicOperation,
    operation_registry_id: operation.id,
    operation_dispatch_priority: 0,
    ranking_hints: [] as string[],
    title: "Change request: Decide whether the upstream contract should change.",
    target_node_ids: ["change-one"],
    scope: {
      read_node_ids: ["change-one"],
      write_node_ids: [],
      read_paths: [],
      write_paths: [],
    },
    source_state_key: "proposal-source",
    target_state_key: "proposal-target",
    obligation_keys: [rawSha256("proposal-obligation")],
    workflow_id: workflow.id,
    review_failure_reopen_from: steps[0]!.id,
    workflow: steps,
    configuration_sha256: catalog.configurationSha256,
  };
  return { ...material, definition_sha256: canonicalHash(material) };
}

function proposalTicketFromDefinition(
  catalog: CompiledExecutionSemanticCatalog,
  definition: DerivedTicketDefinition,
  summary: string,
  executionControl: TicketExecutionControlRecord,
  at: string,
): TicketRecord {
  return {
    id: definition.id,
    operationId: definition.operation_registry_id,
    title: definition.title,
    summary,
    status: "proposed",
    executionPolicyBinding: proposalBinding(catalog, definition.operation_registry_id),
    executionControl,
    priority: -(definition.rule_priority * 1_000 + definition.operation_dispatch_priority),
    dependencyIds: [],
    targetNodeIds: [...definition.target_node_ids],
    readNodeIds: [...definition.scope.read_node_ids],
    writeNodeIds: [...definition.scope.write_node_ids],
    readPaths: [...definition.scope.read_paths],
    writePaths: [...definition.scope.write_paths],
    steps: definition.workflow.map((step) => ({
      id: step.id,
      title: step.id
        .split(/[-_]/u)
        .filter(Boolean)
        .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
        .join(" "),
      personaId: step.persona_id,
      kind: step.kind,
      dependsOn: [...step.depends_on],
      readNodeIds: [...(step.read_node_ids ?? [])],
      writeNodeIds: [...(step.write_node_ids ?? [])],
      readPaths: [...(step.read_paths ?? [])],
      writePaths: [...(step.write_paths ?? [])],
      ...(step.validation_action === undefined ? {} : { validationAction: step.validation_action }),
      executionPolicyBinding: proposalBinding(catalog, definition.operation_registry_id, step.id),
      status: "pending",
      attemptIds: [],
      summary: undefined,
      startedAt: undefined,
      completedAt: undefined,
    })),
    ...(definition.review_failure_reopen_from === undefined
      ? {}
      : {
          reviewFailureReopenFrom: definition.review_failure_reopen_from,
          reviewReworkLimit: 1,
          reviewReworkCount: 0,
          reviewReworks: [],
        }),
    worktreePath: undefined,
    branch: undefined,
    blocker: undefined,
    createdAt: at,
    updatedAt: at,
  };
}

function directApprovalProgram(
  overrides: Readonly<{ legacyReportLock?: boolean }> = {},
): RunCompilerProgram {
  const planned = fakeProgram(overrides);
  return {
    ...planned,
    async resolveRun(request) {
      const resolved = await planned.resolveRun(request);
      const pipeline = resolved.behavior.runType.pipeline.filter(
        (stage) => stage.kind !== "planning",
      );
      const behavior = behaviorSnapshotWithPipeline(resolved.behavior, pipeline);
      return {
        ...resolved,
        planningMode: "direct",
        behavior,
        pipelineStageIds: pipeline.map((stage) => stage.id),
        pipelineStages: projectedBehaviorPipeline(behavior),
      };
    },
    async initializeDirectApproval(run) {
      return {
        plan: {
          revision: 1,
          status: "planning",
          full: {},
          concise: {},
          graphSeed: undefined,
          steeringHistory: [],
        },
        graphHash: canonicalHash({ runId: run.id, root: run.objective }),
        graphRevision: 0,
      };
    },
  };
}

/** Enter the real configured assignment-validation boundary used by the stop-race tests. */
function configuredValidationDirectProgram(validationAction = "compile"): RunCompilerProgram {
  const direct = directApprovalProgram();
  return {
    ...direct,
    async initializeApprovedPlan() {
      const configured = ticket();
      configured.steps[0]!.validationAction = validationAction;
      return {
        graphHash: `sha256:${"c".repeat(64)}`,
        graphRevision: 1,
        tickets: { [configured.id]: configured },
      };
    },
  };
}

function semanticDirectReceiptProgram(
  options: { failedSubmission?: boolean; configuredValidation?: boolean } = {},
): RunCompilerProgram {
  const direct = directApprovalProgram();
  const catalog = semanticDirectCatalog();
  const operationId = "implement";
  const workflowId = "implement-flow";
  const stepId = "implement";
  const requiredReceiptTypes = ["context-pack", "structured-output", "scoped-compile"];
  const terminalSchema =
    options.failedSubmission === true
      ? Type.Union([
          Type.Object(
            {
              status: Type.Literal("completed"),
              summary: Type.String(),
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              status: Type.Literal("failed"),
              blocker: Type.String(),
            },
            { additionalProperties: false },
          ),
        ])
      : Type.Object({ result: Type.String() }, { additionalProperties: false });
  const contextContent = "Exact compiler-bound implementation context.";
  const operationBinding = resolveExecutionPolicyBinding(catalog, {
    configurationSha256: catalog.configurationSha256,
    operationId,
    workflowId,
  });
  const stepBinding = resolveExecutionPolicyBinding(catalog, {
    configurationSha256: catalog.configurationSha256,
    operationId,
    workflowId,
    stepId,
  });

  const prepare = async (
    input: Parameters<RunCompilerProgram["prepareAttempt"]>[0],
  ): Promise<PreparedManagedAttempt> => {
    const compatibility = await direct.prepareAttempt(input);
    if (input.kind === "lead" || input.assignment === undefined) return compatibility;
    const ticket = input.run.tickets[input.assignment.ticketId]!;
    const grant: AuthorityGrant = {
      protocol: "koni.authority-grant.v1",
      grantId: `grant-${input.attemptId}`,
      runId: input.run.id,
      ticketId: input.assignment.ticketId,
      stepId: input.assignment.stepId,
      attemptId: input.attemptId,
      sessionId: input.sessionId,
      epoch: input.run.lifecycle.revision + 1,
      generation: input.run.generation,
      allowedTools: [TERMINAL_TOOL_NAME],
      readPaths: [...ticket.readPaths],
      writePaths: [...ticket.writePaths],
      expectedRevision: input.nextAuthorityRevision,
      expectedStateHash: input.expectedAuthorityStateHash,
    };
    const systemPrompt = "Execute the exact compiler-issued assignment.";
    const initialPrompt = "Submit one schema-valid terminal result.";
    const spec = createAgentLaunchSpec({
      protocol: AGENT_LAUNCH_SPEC_PROTOCOL,
      issuedAt: "2026-07-18T00:00:00.000Z",
      identity: {
        runId: input.run.id,
        ticketId: input.assignment.ticketId,
        stepId: input.assignment.stepId,
        attemptId: input.attemptId,
        sessionId: input.sessionId,
      },
      lineage: input.lineage,
      authority: {
        grantId: grant.grantId,
        grantHash: canonicalHash(grant),
        generation: grant.generation,
        epoch: grant.epoch,
        expectedRevision: grant.expectedRevision,
        expectedStateHash: grant.expectedStateHash as Sha256Digest,
        authoritativeContextHash: rawSha256(contextContent),
      },
      workspace: structuredClone(compatibility.spec.workspace),
      persona: {
        id: input.run.tickets[input.assignment.ticketId]!.steps.find(
          (step) => step.id === input.assignment?.stepId,
        )!.personaId,
        systemPrompt,
        systemPromptHash: rawSha256(systemPrompt),
        initialPrompt,
        initialPromptHash: rawSha256(initialPrompt),
      },
      model: {
        provider: "openai-codex",
        id: "gpt-5.6-terra",
        api: "openai-codex-responses",
        catalogMaxTokens: 128_000,
        catalogSha256: rawSha256("semantic-direct-model-catalog"),
        thinkingLevel: "high",
      },
      tools: [
        {
          name: TERMINAL_TOOL_NAME,
          schemaHash: canonicalHash(terminalSchema),
          executionMode: "sequential",
          maxResultBytes: koniToolMaxResultBytes(TERMINAL_TOOL_NAME),
        },
      ],
      resources: { setHash: computeLaunchResourceSetHash([]), entries: [] },
      budgets: {
        tokens: {
          maxInput: 10_000,
          maxOutput: 10_000,
          maxCacheRead: 10_000,
          maxCacheWrite: 10_000,
          maxNew: 10_000,
          maxAll: 10_000,
          providerOutputHeadroom: 128_000,
        },
        retries: { maxProviderRetries: 0, baseDelayMs: 1 },
        transcript: { maxBytes: 64 * 1024 * 1024 },
      },
      terminal: {
        toolName: TERMINAL_TOOL_NAME,
        outputSchemaHash: canonicalHash(terminalSchema),
        maxOutputBytes: 64 * 1024,
      },
    });
    return {
      spec,
      tools: [terminalFixtureTool(terminalSchema)],
      authorityGrant: grant,
      toolNames: [TERMINAL_TOOL_NAME],
      terminalOutputSchema: terminalSchema,
      contextContent,
      contextProvider: contextProvider(spec),
      factory: (async () =>
        new CompletingAdapter(
          spec,
          input.kind,
          options.failedSubmission === true
            ? {
                status: "failed",
                blocker: "The configured check could not establish an honest result",
              }
            : undefined,
        )) satisfies ManagedPiSessionFactory,
    };
  };

  const projection = (): RuntimeAssignmentTerminalPolicyProjection => {
    const material = {
      protocol: "koni.assignment-terminal-policy.v1" as const,
      configurationSha256: catalog.configurationSha256,
      catalogSha256: catalog.sha256,
      catalog,
      executionPolicyBinding: stepBinding,
      validationCheckIds: [] as string[],
      requiredReceiptTypes,
      validationChecks: [],
      composedReplayCheckIds: [] as string[],
      retainedReceipts: [],
      sourceManifestPairs: [],
    };
    return { ...material, sha256: canonicalHash(material) };
  };

  return {
    ...direct,
    ...(options.failedSubmission === true
      ? {
          async compileAssignmentOutput(
            input: Parameters<NonNullable<RunCompilerProgram["compileAssignmentOutput"]>>[0],
          ) {
            const output = input.output as { status?: unknown; blocker?: unknown };
            if (output.status !== "failed" || typeof output.blocker !== "string") {
              throw new Error("fixture expected one failed assignment output");
            }
            return { outcome: { status: "failed" as const, blocker: output.blocker } };
          },
        }
      : {}),
    async resolveRun(request) {
      const resolved = await direct.resolveRun(request);
      return { ...resolved, compiledConfigHash: catalog.configurationSha256 };
    },
    async initializeApprovedPlan() {
      const configured = ticket();
      configured.operationId = operationId;
      configured.executionPolicyBinding = operationBinding;
      configured.steps[0]!.executionPolicyBinding = stepBinding;
      if (options.configuredValidation === true) {
        configured.steps[0]!.validationAction = "compile";
      }
      return {
        graphHash: `sha256:${"c".repeat(64)}`,
        graphRevision: 1,
        tickets: { [configured.id]: configured },
      };
    },
    prepareAttempt: prepare,
    async recoverAttempt({ run, attempt, spec }) {
      const ticket = run.tickets[attempt.ticketId]!;
      const grant: AuthorityGrant = {
        protocol: "koni.authority-grant.v1",
        grantId: spec.authority.grantId,
        runId: spec.identity.runId,
        ticketId: spec.identity.ticketId,
        stepId: spec.identity.stepId,
        attemptId: spec.identity.attemptId,
        sessionId: spec.identity.sessionId,
        epoch: spec.authority.epoch,
        generation: spec.authority.generation,
        allowedTools: [TERMINAL_TOOL_NAME],
        readPaths: [...ticket.readPaths],
        writePaths: [...ticket.writePaths],
        expectedRevision: spec.authority.expectedRevision,
        expectedStateHash: spec.authority.expectedStateHash,
      };
      return {
        spec,
        tools: [terminalFixtureTool(terminalSchema)],
        authorityGrant: grant,
        toolNames: [TERMINAL_TOOL_NAME],
        terminalOutputSchema: terminalSchema,
        contextContent,
        contextProvider: contextProvider(spec),
        factory: (async () =>
          new CompletingAdapter(spec, attempt.kind ?? "ticket")) satisfies ManagedPiSessionFactory,
      };
    },
    async projectExecutionSemanticCatalog() {
      return catalog;
    },
    async projectAssignmentTerminalPolicy() {
      return projection();
    },
    async compileAssignmentTerminalReplay(input) {
      if (options.failedSubmission === true && options.configuredValidation === true) {
        throw new Error("failed configured submissions must not replay completion checks");
      }
      const material = {
        protocol: "koni.assignment-terminal-replay.v1" as const,
        projectionSha256: input.projectionSha256,
        accepted: true,
        passed: true,
        checks: [],
        evidence: {},
      };
      return { ...material, sha256: canonicalHash(material) };
    },
  };
}

function semanticDirectCatalog(): CompiledExecutionSemanticCatalog {
  const registries = {
    operations: {
      implement: {
        id: "implement",
        operation: "implement-change",
        stage: "execution",
        workflow: "implement-flow",
      },
    },
    workflows: {
      "implement-flow": {
        id: "implement-flow",
        version: "1.0.0",
        applies_to: ["implement-change"],
        steps: [
          {
            id: "implement",
            required: true,
            required_receipts: ["context-pack", "structured-output", "scoped-compile"],
          },
        ],
      },
    },
    checks: {},
  };
  const configurationSha256 = canonicalHash(registries);
  return compileExecutionSemanticCatalog({
    configuration_sha256: configurationSha256,
    registries: {
      ...Object.fromEntries(
        [
          "node_types",
          "queries",
          "graph_constraints",
          "gate_policies",
          "rules",
          "actions",
          "personas",
          "reports",
          "views",
          "state_machines",
          "agents",
        ].map((key) => [key, Object.create(null)]),
      ),
      ...registries,
    },
    edge_types: [],
  } as unknown as CompiledConfiguration);
}

function configuredStageStopProgram(recoverable = false): RunCompilerProgram {
  const direct = directApprovalProgram();
  return {
    ...direct,
    async resolveRun(request) {
      const resolved = await direct.resolveRun(request);
      const approvalIndex = resolved.behavior.runType.pipeline.findIndex(
        (stage) => stage.kind === "approval",
      );
      if (approvalIndex < 0) throw new Error("fixture pipeline has no approval stage");
      const actions = recoverable
        ? actionCatalogWithRecovery(resolved.behavior.actions)
        : resolved.behavior.actions;
      const pipeline = [...resolved.behavior.runType.pipeline];
      pipeline.splice(approvalIndex, 0, {
        id: "operator-check",
        title: "Operator Check",
        kind: "action",
        config: {
          kind: "action",
          action: recoverable ? "recoverable-check" : "compile",
          compilerOwned: false,
          automatic: false,
        },
      });
      const behavior = behaviorSnapshotWithPipeline(resolved.behavior, pipeline, actions);
      return {
        ...resolved,
        behavior,
        pipelineStageIds: pipeline.map((stage) => stage.id),
        pipelineStages: projectedBehaviorPipeline(behavior),
      };
    },
  };
}

function actionCatalogWithRecovery(base: CompiledActionCatalog): CompiledActionCatalog {
  const recover = compiledActionDefinition({
    id: "recover-check",
    recipe: [{ id: "validate-project", primitive: "project.validate", arguments: {} }],
  });
  const primary = compiledActionDefinition({
    id: "recoverable-check",
    recipe: [{ id: "require-ticket", primitive: "ticket.validate", arguments: {} }],
    recovery: recover.id,
  });
  const material = {
    protocol: base.protocol,
    actions: { ...base.actions, [primary.id]: primary, [recover.id]: recover },
    aliases: { ...base.aliases, [primary.id]: primary.id, [recover.id]: recover.id },
  };
  return { ...material, sha256: canonicalHash(material) };
}

function compiledActionDefinition(
  input: Readonly<{
    id: string;
    recipe: CompiledActionDefinition["recipe"];
    recovery?: string;
  }>,
): CompiledActionDefinition {
  const material = {
    id: input.id,
    actor: "compiler" as const,
    aliases: [],
    parameters: [],
    allowedTicketStates: [],
    checkout: "none" as const,
    recipe: input.recipe,
    compensation: [],
    ...(input.recovery === undefined ? {} : { recovery: input.recovery }),
  };
  return { ...material, sha256: canonicalHash(material) };
}

function capabilityDirectProgram(): RunCompilerProgram {
  const direct = directApprovalProgram();
  const kinds: Record<string, string> = {
    intake: "action",
    approval: "approval",
    initialize: "initialize",
    orchestrate: "orchestration",
    verification: "checkpoint",
    promotion: "promotion",
  };
  return {
    ...direct,
    async projectPipeline(run) {
      return run.pipelineStageIds.map((id) => ({
        id,
        title: id
          .split("-")
          .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
          .join(" "),
        kind: kinds[id] ?? (id === "target-sync" ? "target_sync" : "unknown"),
        automatic: id !== "approval" && id !== "promotion",
      }));
    },
  };
}

function reviewReworkProgram(): RunCompilerProgram {
  const direct = directApprovalProgram();
  return {
    ...direct,
    async initializeApprovedPlan() {
      return {
        graphHash: `sha256:${"c".repeat(64)}`,
        graphRevision: 1,
        tickets: { "ticket-one": reviewTicket() },
      };
    },
    async compileAssignmentOutput({ run, assignment }) {
      if (
        assignment.stepId === "review" &&
        run.tickets[assignment.ticketId]?.reviewReworkCount === 0
      ) {
        return { outcome: { status: "failed", blocker: "Reviewer found one correctable defect" } };
      }
      return {
        outcome: {
          status: "completed",
          summary: assignment.stepId === "review" ? "Fresh review passed" : "Implemented feature",
        },
      };
    },
  };
}

function exhaustedReviewReworkProgram(
  options: {
    blockAutomaticAuthor?: boolean;
    noProducerRework?: boolean;
  } = {},
): RunCompilerProgram {
  const direct = directApprovalProgram();
  return {
    ...direct,
    async initializeApprovedPlan() {
      const preparedTicket = reviewTicket();
      if (options.noProducerRework === true) {
        delete preparedTicket.reviewFailureReopenFrom;
        delete preparedTicket.reviewReworkLimit;
        delete preparedTicket.reviewReworkCount;
        delete preparedTicket.reviewReworks;
      }
      return {
        graphHash: `sha256:${"d".repeat(64)}`,
        graphRevision: 1,
        tickets: { "ticket-one": preparedTicket },
      };
    },
    async compileAssignmentOutput({ run, assignment }) {
      const reviewReworks = run.tickets[assignment.ticketId]?.reviewReworks ?? [];
      const hasAutomaticRework = reviewReworks.some((record) => record.mode !== "supervised");
      const hasSupervisedRework = reviewReworks.some((record) => record.mode === "supervised");
      if (
        options.blockAutomaticAuthor === true &&
        assignment.stepId === "implement" &&
        hasAutomaticRework &&
        !hasSupervisedRework
      ) {
        return { outcome: { status: "failed", blocker: "new-token token budget exceeded" } };
      }
      if (assignment.stepId === "review" && !hasSupervisedRework) {
        const review = run.tickets[assignment.ticketId]?.steps.find((step) => step.id === "review");
        return {
          outcome: {
            status: "failed",
            blocker:
              review?.attemptIds.length === 1
                ? "First independent review found a correctable route gap"
                : "Second independent review still found a material route gap",
          },
        };
      }
      return {
        outcome: {
          status: "completed",
          summary:
            assignment.stepId === "review"
              ? "Recovered review passed"
              : "Implemented reviewed correction",
        },
      };
    },
  };
}

function lifecycleProgram(harness: LifecycleHarness): RunCompilerProgram {
  const direct = directApprovalProgram();
  const { recoverAttempt: _recoverAttempt, ...lifecycleBaseProgram } = direct;
  return {
    ...lifecycleBaseProgram,
    // This harness exercises the legacy runtime-without-session-recovery branch: shutdown keeps
    // the active cursor durable, then startup interrupts it and issues one fresh successor. The
    // shared fake program now supports authenticated planning recovery, so keep that unrelated
    // capability from silently changing this fixture's contract.
    async prepareAttempt(input) {
      if (input.kind === "lead") return direct.prepareAttempt(input);
      const ticketId = input.assignment?.ticketId ?? "run-planning";
      const stepId = input.assignment?.stepId ?? "combined-plan";
      let workspace: string;
      if (input.kind === "planning") {
        workspace = input.run.git.planning.worktree;
      } else if (input.kind === "verification") {
        workspace = input.run.git.run.worktree;
      } else {
        if (input.assignment === undefined) {
          throw new Error(`lifecycle fixture ${input.kind} attempt requires a ticket assignment`);
        }
        workspace = input.run.git.ticketCycles[input.run.tickets[ticketId]!.gitCycleId!]!.worktree;
      }
      const baseSpec = fixtureLaunchSpec({
        cwd: workspace,
        sessionDirectory: path.join(input.run.projectRoot, ".sessions", input.attemptId),
        runId: input.run.id,
        ticketId,
        stepId,
        attemptId: input.attemptId,
        sessionId: input.sessionId,
        lineage: input.lineage,
      }) as AgentLaunchSpec;
      const revision = input.run.planningSession?.revisions[0];
      const spec =
        input.kind !== "planning" || revision === undefined
          ? baseSpec
          : (() => {
              const { specHash: _hash, ...draft } = structuredClone(baseSpec);
              return createAgentLaunchSpec({
                ...draft,
                identity: { ...draft.identity, ticketId: "run-planning", stepId },
                planningRevision: {
                  revision: 0,
                  baseRevision: null,
                  priorCheckpointSha256: null,
                  steeringSha256: null,
                  budgetBaseline: structuredClone(revision.budgetBaseline),
                },
              });
            })();
      return {
        spec,
        tools: [fixtureTool()],
        contextProvider: contextProvider(spec),
        factory: (async () => harness.create(spec)) satisfies ManagedPiSessionFactory,
      };
    },
  };
}

function deletionProgram(harness: DeletionHarness): RunCompilerProgram {
  const direct = directApprovalProgram();
  const terminalSchema = Type.Object({ result: Type.String() }, { additionalProperties: false });
  const names: KoniToolName[] = ["koni_write_file", "koni_submit_output"];
  return {
    ...direct,
    async prepareAttempt(input) {
      if (input.kind === "lead") return direct.prepareAttempt(input);
      const ticketId = input.assignment?.ticketId ?? "run-planning";
      const stepId = input.assignment?.stepId ?? "implement";
      const workspace =
        input.run.git.ticketCycles[input.run.tickets[ticketId]!.gitCycleId!]!.worktree;
      const context = "Compiler-bound deletion context";
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
        allowedTools: names,
        readPaths: ["."],
        writePaths: ["late.txt"],
        expectedRevision: input.nextAuthorityRevision,
        expectedStateHash: input.expectedAuthorityStateHash,
      };
      expect(grant.expectedStateHash).toBe(
        authorityRevisionStateHash(input.run.projectRoot, input.nextAuthorityRevision),
      );
      const systemPrompt = "Wait for terminal authority.";
      const initialPrompt = "Begin bounded work.";
      const spec = createAgentLaunchSpec({
        protocol: AGENT_LAUNCH_SPEC_PROTOCOL,
        issuedAt: new Date().toISOString(),
        identity: {
          runId: input.run.id,
          ticketId,
          stepId,
          attemptId: input.attemptId,
          sessionId: input.sessionId,
        },
        lineage: input.lineage,
        authority: {
          grantId: grant.grantId,
          grantHash: canonicalHash(grant),
          generation: grant.generation,
          epoch: grant.epoch,
          expectedRevision: grant.expectedRevision,
          expectedStateHash: grant.expectedStateHash as `sha256:${string}`,
          authoritativeContextHash: rawSha256(context),
        },
        workspace: {
          cwd: workspace,
          sessionDirectory: path.join(input.run.projectRoot, ".sessions", input.attemptId),
        },
        persona: {
          id: "implementer",
          systemPrompt,
          systemPromptHash: rawSha256(systemPrompt),
          initialPrompt,
          initialPromptHash: rawSha256(initialPrompt),
        },
        model: {
          provider: "openai-codex",
          id: "test-model",
          api: "openai-codex-responses",
          catalogMaxTokens: 128_000,
          catalogSha256: rawSha256("test-model-catalog"),
          thinkingLevel: "high",
        },
        tools: names.map((name) => ({
          name,
          schemaHash: koniToolSchemaHash(name, terminalSchema),
          executionMode: "sequential" as const,
          maxResultBytes: koniToolMaxResultBytes(name),
        })),
        resources: { setHash: computeLaunchResourceSetHash([]), entries: [] },
        budgets: {
          tokens: {
            maxInput: 10_000,
            maxOutput: 10_000,
            maxCacheRead: 10_000,
            maxCacheWrite: 10_000,
            maxNew: 20_000,
            maxAll: 40_000,
            providerOutputHeadroom: 128_000,
          },
          transcript: { maxBytes: 64 * 1024 * 1024 },
          retries: { maxProviderRetries: 0, baseDelayMs: 0 },
        },
        terminal: {
          toolName: "koni_submit_output",
          outputSchemaHash: canonicalHash(terminalSchema),
          maxOutputBytes: 64 * 1024,
        },
      });
      return {
        spec,
        authorityGrant: grant,
        toolNames: names,
        terminalOutputSchema: terminalSchema,
        contextContent: context,
        compactionSnapshot: {
          objective: input.run.objective,
          plan: {
            architecture: "Approved",
            decisions: "Approved",
            risk: "Bounded",
            verification: "Pending",
          },
          graphRefs: [],
          touchedFiles: [],
          receiptIds: [],
          checkIds: [],
          unresolvedQuestions: [],
          nextAction: "Perform bounded work",
        },
        factory: (async (_spec, options) =>
          harness.create(spec, options.tools)) satisfies ManagedPiSessionFactory,
      };
    },
  };
}

function gitConflictProgram(harness: GitConflictHarness): RunCompilerProgram {
  const direct = directApprovalProgram();
  return {
    ...direct,
    async prepareAttempt(input) {
      if (input.kind === "lead") return direct.prepareAttempt(input);
      const ticketId = input.assignment?.ticketId ?? "run-planning";
      const stepId = input.assignment?.stepId ?? "implement";
      const workspace =
        input.run.git.ticketCycles[input.run.tickets[ticketId]!.gitCycleId!]!.worktree;
      const spec = fixtureLaunchSpec({
        cwd: workspace,
        sessionDirectory: path.join(input.run.projectRoot, ".sessions", input.attemptId),
        runId: input.run.id,
        ticketId,
        stepId,
        attemptId: input.attemptId,
        sessionId: input.sessionId,
        lineage: input.lineage,
      }) as AgentLaunchSpec;
      return {
        spec,
        tools: [fixtureTool()],
        contextProvider: contextProvider(spec),
        factory: (async () => harness.create(spec)) satisfies ManagedPiSessionFactory,
      };
    },
    async verifyRun(run) {
      await harness.verification;
      return { ok: true, report: fixtureRunReport(run) };
    },
    async createIntegrationTicket() {
      harness.integrationTicketCalls += 1;
      const value = ticket();
      value.id = "integrate-target";
      value.operationId = "resolve-target-integration";
      value.title = "Integrate target conflict";
      value.summary = "Preserve run and target changes in one bounded resolver";
      value.steps[0]!.id = "resolve-conflict";
      value.steps[0]!.title = "Resolve conflict";
      value.steps[0]!.personaId = "integrator";
      value.steps[0]!.kind = "integration";
      return value;
    },
  };
}

function fakeProgram(overrides: Readonly<{ legacyReportLock?: boolean }> = {}): RunCompilerProgram {
  return {
    async resolveRun(request) {
      const behavior = runBehaviorSnapshotFixture(request.runTypeId, "software", overrides);
      return {
        profile: {
          packageName: "@koni/coding-profile",
          packageVersion: "0.6.0",
          lineage: "koni.software",
          bundleHash: `sha256:${"a".repeat(64)}`,
        },
        compiledConfigHash: `sha256:${"b".repeat(64)}`,
        runTypeId: request.runTypeId,
        objective: request.objective,
        intake: request.intake,
        behavior,
        workingSpecOwnerId: "lead",
        planningMode: "agent",
        pipelineStageIds: behavior.runType.pipeline.map((stage) => stage.id),
        pipelineStages: projectedBehaviorPipeline(behavior),
        executionConfig: {
          maxParallel: 1,
          questionPolicy: "some",
          instructions: "Ask only material questions.",
          agents: {
            lead: { provider: "test", model: "test-model", thinkingLevel: "off" },
          },
        },
      };
    },
    async initializeDirectApproval() {
      throw new Error("not used");
    },
    async prepareAttempt(input) {
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
      const workspace =
        input.kind === "planning"
          ? input.run.git.planning.worktree
          : input.kind === "lead"
            ? input.run.projectRoot
            : input.kind === "verification"
              ? input.run.git.run.worktree
              : input.run.git.ticketCycles[input.run.tickets[ticketId]!.gitCycleId!]!.worktree;
      const baseSpec = fixtureLaunchSpec({
        cwd: workspace,
        sessionDirectory: path.join(input.run.projectRoot, ".sessions", input.attemptId),
        runId: input.run.id,
        ticketId,
        stepId,
        attemptId: input.attemptId,
        sessionId: input.sessionId,
        ...(input.kind === "lead" ? { personaId: "lead" } : {}),
        lineage: input.lineage,
      }) as AgentLaunchSpec;
      const initialRevision = input.run.planningSession?.revisions[0];
      const spec =
        input.kind !== "planning" || initialRevision === undefined
          ? baseSpec
          : (() => {
              const { specHash: _hash, ...draft } = structuredClone(baseSpec);
              return createAgentLaunchSpec({
                ...draft,
                planningRevision: {
                  revision: 0,
                  baseRevision: null,
                  priorCheckpointSha256: null,
                  steeringSha256: null,
                  budgetBaseline: structuredClone(initialRevision.budgetBaseline),
                },
              });
            })();
      const adapter = new CompletingAdapter(spec, input.kind);
      return {
        spec,
        tools: [fixtureTool()],
        contextProvider: contextProvider(spec),
        factory: (async () => adapter) satisfies ManagedPiSessionFactory,
      };
    },
    async preparePlanningRevision(input) {
      const session = input.run.planningSession!;
      const revision = session.revisions[session.currentRevision]!;
      const prior = session.revisions[session.currentRevision - 1]!;
      const baseSpec = fixtureLaunchSpec({
        cwd: input.run.git.planning.worktree,
        sessionDirectory: path.join(input.run.projectRoot, ".sessions", input.attemptId),
        runId: input.run.id,
        ticketId: "run-planning",
        stepId: "combined-plan",
        attemptId: input.attemptId,
        sessionId: input.sessionId,
        lineage: { branchEpoch: 0, reason: "initial" },
      }) as AgentLaunchSpec;
      const { specHash: _hash, ...draft } = structuredClone(baseSpec);
      const spec = createAgentLaunchSpec({
        ...draft,
        authority: {
          ...draft.authority,
          grantId: `grant-${input.attemptId}-planning-revision-${revision.revision}`,
          grantHash: revision.grantSha256,
          expectedRevision: input.nextAuthorityRevision,
          expectedStateHash: input.expectedAuthorityStateHash,
        },
        planningRevision: {
          revision: revision.revision,
          baseRevision: prior.revision,
          priorCheckpointSha256: prior.artifactSha256!,
          steeringSha256: revision.steering!.instructionsSha256,
          budgetBaseline: structuredClone(revision.budgetBaseline),
        },
      });
      return {
        spec,
        tools: [fixtureTool()],
        contextProvider: contextProvider(spec),
        factory: (async () =>
          new CompletingAdapter(spec, "planning")) satisfies ManagedPiSessionFactory,
      };
    },
    async recoverAttempt({ attempt, spec }) {
      return {
        spec,
        tools: [fixtureTool()],
        contextProvider: contextProvider(spec),
        factory: (async () =>
          new CompletingAdapter(
            spec,
            attempt.kind ?? "planning",
          )) satisfies ManagedPiSessionFactory,
      };
    },
    async compilePlanningOutput({ run }) {
      return {
        plan: {
          revision: run.planningSession?.currentRevision ?? 1,
          status: "planning",
          full: {
            architecture: "## Architecture\nUse the existing seam.",
            decisions: "## Decisions\nNo new platform.",
            risk: "## Risk\nRoutine and bounded.",
            verification: "## Verification\nRun the focused proof.",
          },
          concise: {
            architecture: [
              {
                title: "Use existing seam",
                description: "Keep the change within the repository boundary.",
              },
            ],
            decisions: [{ title: "No new platform", description: "Reuse established ownership." }],
            risk: [
              { title: "Routine scope", description: "No migration or external side effect." },
            ],
            verification: [
              { title: "Focused proof", description: "Exercise the observable outcome." },
            ],
          },
          graphSeed: { objective: "feature" },
          steeringHistory: [],
        },
      };
    },
    async compilePlanningRevision({ run, revision }) {
      return {
        plan: {
          revision,
          status: "planning",
          full: structuredClone(run.plan!.full),
          concise: structuredClone(run.plan!.concise),
          graphSeed: structuredClone(run.plan!.graphSeed),
          steeringHistory: structuredClone(run.plan!.steeringHistory),
        },
      };
    },
    async compileLeadJudgmentOutput({ output }) {
      if (
        output === null ||
        typeof output !== "object" ||
        (output as { result?: unknown }).result !== "lead"
      ) {
        throw new Error("fixture Lead judgment output is invalid");
      }
      return {
        protocol: "koni.lead-judgment-output.v1",
        disposition: "proceed",
        summary: "Approved work is ready for deterministic orchestration",
      };
    },
    async initializeApprovedPlan() {
      return {
        graphHash: `sha256:${"c".repeat(64)}`,
        graphRevision: 1,
        tickets: { "ticket-one": ticket() },
      };
    },
    async compileAssignmentOutput() {
      return { outcome: { status: "completed", summary: "Implemented feature" } };
    },
    async verifyRun(run) {
      return { ok: true, report: fixtureRunReport(run) };
    },
    async createIntegrationTicket() {
      return { ...ticket(), id: "integrate-target", operationId: "resolve-target-integration" };
    },
  };
}

function semanticPipeline(stages: readonly (readonly [string, string])[]) {
  return stages.map(([id, kind]) => ({
    id,
    title: id
      .split("-")
      .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
      .join(" "),
    kind,
    automatic: kind !== "approval" && kind !== "promotion",
  }));
}

function projectedBehaviorPipeline(behavior: RunBehaviorSnapshot) {
  return behavior.runType.pipeline.map((stage) => ({
    id: stage.id,
    title: stage.title,
    kind: stage.kind,
    automatic:
      stage.kind !== "approval" &&
      stage.kind !== "promotion" &&
      (stage.config.kind !== "action" || stage.config.automatic),
  }));
}

function behaviorSnapshotWithPipeline(
  snapshot: RunBehaviorSnapshot,
  pipeline: readonly CompiledRunStage[],
  actions = snapshot.actions,
): RunBehaviorSnapshot {
  const { sha256: _runTypeSha256, ...priorRunType } = snapshot.runType;
  const runTypeMaterial = { ...structuredClone(priorRunType), pipeline: structuredClone(pipeline) };
  const runType = { ...runTypeMaterial, sha256: canonicalHash(runTypeMaterial) };
  const compiledBehaviorSha256 = canonicalHash({
    profile: snapshot.profile,
    runTypeSha256: runType.sha256,
    actionCatalogSha256: actions.sha256,
  });
  const material = {
    protocol: "koni.run-behavior.v1" as const,
    compiledBehaviorSha256,
    profile: structuredClone(snapshot.profile),
    runType,
    actions: structuredClone(actions),
    gitPolicySha256: snapshot.gitPolicySha256,
  };
  return { ...material, sha256: canonicalHash(material) };
}

function fixtureRunReport(run: RunRecord): RunReportRecord {
  if (run.graphHash === undefined) throw new Error("fixture report requires a graph hash");
  const ticketBoardHash = canonicalHash(
    Object.values(run.tickets).map((ticket) => ({
      id: ticket.id,
      status: ticket.status,
      steps: ticket.steps.map((step) => ({ id: step.id, status: step.status })),
    })),
  );
  const runStateHash = canonicalHash({
    runId: run.id,
    revision: run.revision,
    phase: run.lifecycle.phase,
    graphHash: run.graphHash,
  });
  const bundleHash = canonicalHash({ graphHash: run.graphHash, ticketBoardHash, runStateHash });
  return {
    protocol: "koni.report-bundle.v1",
    reportId: `report-${run.id}-${run.revision}`,
    bundleKind: "fixture",
    bundleHash,
    graphHash: run.graphHash,
    ticketBoardHash,
    runStateHash,
    manifestArtifactPath: `runs/${run.id}/reports/${bundleHash.slice(7)}.json`,
    outputs: [],
    compiledAt: run.updatedAt,
  };
}

function autoStartProgram(autoStart: boolean): RunCompilerProgram {
  const base = fakeProgram();
  return {
    ...base,
    async resolveRun(request) {
      const resolved = await base.resolveRun(request);
      return {
        ...resolved,
        behavior: runBehaviorSnapshotFixture(request.runTypeId, "software", { autoStart }),
      };
    },
  };
}

function reviewingFakeProgram(): RunCompilerProgram {
  const base = fakeProgram();
  return {
    ...base,
    async resolveRun(request) {
      const resolved = await base.resolveRun(request);
      const pipeline = [...resolved.behavior.runType.pipeline];
      const reportIndex = pipeline.findIndex(
        (stage) =>
          stage.kind === "action" &&
          stage.config.kind === "action" &&
          stage.config.action === "report",
      );
      pipeline.splice(reportIndex, 0, {
        id: "independent-check",
        title: "Independent Check",
        kind: "agent_review",
        config: {
          kind: "agent",
          persona: "lead",
          prompt: "Independently review the exact synchronized run.",
        },
      });
      const behavior = behaviorSnapshotWithPipeline(resolved.behavior, pipeline);
      return {
        ...resolved,
        behavior,
        pipelineStageIds: pipeline.map((stage) => stage.id),
        pipelineStages: projectedBehaviorPipeline(behavior),
      };
    },
    async requiresVerificationAttempt() {
      return true;
    },
    async compileVerificationOutput(input) {
      return input.output !== null &&
        typeof input.output === "object" &&
        (input.output as { result?: unknown }).result === "verification"
        ? { outcome: { status: "completed", summary: "Independent review passed" } }
        : {
            outcome: {
              status: "failed",
              blocker: "Independent review returned an invalid boundary",
            },
          };
    },
  };
}

function terminalFixtureTool(schema: TSchema): AuthorityBackedTool {
  const fixture = fixtureTool();
  const schemaHash = canonicalHash(schema);
  return {
    ...fixture,
    schemaHash,
    terminalOutputSchema: schema,
    terminalOutputSchemaHash: schemaHash,
    definition: {
      ...fixture.definition,
      parameters: schema,
    },
  };
}

class CompletingAdapter implements PiSessionAdapter {
  public readonly sessionId: string;
  public readonly sessionFile: string;
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();

  public constructor(
    private readonly spec: AgentLaunchSpec,
    private readonly kind: string,
    private readonly terminalOutput?: unknown,
  ) {
    this.sessionId = spec.identity.sessionId;
    this.sessionFile = path.join(spec.workspace.sessionDirectory, `${this.sessionId}.jsonl`);
  }

  public getActiveToolNames(): readonly string[] {
    return [TERMINAL_TOOL_NAME];
  }
  public appendMapping(): void {}
  public subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  public async prompt(): Promise<void> {
    this.emit({
      type: "tool_execution_start",
      toolCallId: "terminal",
      toolName: TERMINAL_TOOL_NAME,
      args: this.terminalOutput ?? { result: this.kind },
    });
    this.emit({
      type: "tool_execution_end",
      toolCallId: "terminal",
      toolName: TERMINAL_TOOL_NAME,
      result: { content: [{ type: "text", text: "accepted" }], terminate: true },
      isError: false,
    });
  }
  public async continue(): Promise<void> {
    await this.prompt();
  }
  public async steer(): Promise<void> {}
  public async followUp(): Promise<void> {}
  public async abort(): Promise<void> {}
  public dispose(): void {}
  protected emit(event: AgentSessionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

class UsageCompletingAdapter extends CompletingAdapter {
  public constructor(
    spec: AgentLaunchSpec,
    kind: string,
    private readonly reportedUsage: Readonly<{
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }>,
  ) {
    super(spec, kind);
  }

  public override async prompt(): Promise<void> {
    const { input, output, cacheRead, cacheWrite } = this.reportedUsage;
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "completed bounded work" }],
        api: "openai-responses",
        provider: "openai-codex",
        model: "test-model",
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
    } as unknown as AgentSessionEvent);
    await super.prompt();
  }
}

class InfrastructureFailingAdapter implements PiSessionAdapter {
  public readonly sessionId: string;
  public readonly sessionFile: string;
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();

  public constructor(
    spec: AgentLaunchSpec,
    private readonly failureCode: string | undefined,
    private readonly failureMessage: string,
    private readonly usage?: Readonly<{
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }>,
  ) {
    this.sessionId = spec.identity.sessionId;
    this.sessionFile = path.join(spec.workspace.sessionDirectory, `${this.sessionId}.jsonl`);
  }

  public getActiveToolNames(): readonly string[] {
    return [TERMINAL_TOOL_NAME];
  }
  public appendMapping(): void {}
  public subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  public async prompt(): Promise<void> {
    if (this.usage !== undefined) {
      const { input, output, cacheRead, cacheWrite } = this.usage;
      const event = {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "planning" }],
          api: "openai-responses",
          provider: "openai-codex",
          model: "test-model",
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
      for (const listener of this.#listeners) listener(event);
    }
    if (this.failureCode === undefined) throw new Error(this.failureMessage);
    throw new ManagedSessionError(this.failureCode, this.failureMessage);
  }
  public async continue(): Promise<void> {
    await this.prompt();
  }
  public async steer(): Promise<void> {}
  public async followUp(): Promise<void> {}
  public async abort(): Promise<void> {}
  public dispose(): void {}
}

class GatedInfrastructureFailingAdapter extends InfrastructureFailingAdapter {
  public constructor(
    spec: AgentLaunchSpec,
    private readonly gate: Promise<void>,
    failureCode: string | undefined,
    failureMessage: string,
  ) {
    super(spec, failureCode, failureMessage);
  }

  public override async prompt(): Promise<void> {
    await this.gate;
    await super.prompt();
  }
}

class BudgetExhaustingAdapter implements PiSessionAdapter {
  public readonly sessionId: string;
  public readonly sessionFile: string;
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();
  #mapping: unknown;

  public constructor(private readonly spec: AgentLaunchSpec) {
    this.sessionId = spec.identity.sessionId;
    this.sessionFile = path.join(spec.workspace.sessionDirectory, `${this.sessionId}.jsonl`);
  }

  public getActiveToolNames(): readonly string[] {
    return [TERMINAL_TOOL_NAME];
  }
  public appendMapping(data: unknown): void {
    this.#mapping = data;
  }
  public subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  public async prompt(): Promise<void> {
    await mkdir(path.dirname(this.sessionFile), { recursive: true });
    const timestamp = new Date().toISOString();
    const input = this.spec.budgets.tokens.maxInput + 1;
    await writeFile(
      this.sessionFile,
      `${[
        {
          type: "session",
          version: 3,
          id: this.sessionId,
          timestamp,
          cwd: this.spec.workspace.cwd,
        },
        {
          type: "custom",
          id: "budget-mapping",
          parentId: null,
          timestamp,
          customType: "koni.attempt-session-map",
          data: this.#mapping,
        },
        {
          type: "message",
          id: "budget-anchor",
          parentId: "budget-mapping",
          timestamp,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "budget boundary" }],
            api: "openai-codex-responses",
            provider: "openai-codex",
            model: "test-model",
            usage: {
              input,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: input,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
      { mode: 0o600 },
    );
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "budget boundary" }],
        api: "openai-responses",
        provider: "openai-codex",
        model: "test-model",
        usage: {
          input,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: input,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    } as unknown as AgentSessionEvent;
    for (const listener of this.#listeners) listener(event);
    await Promise.resolve();
  }
  public async continue(): Promise<void> {
    await this.prompt();
  }
  public async steer(): Promise<void> {}
  public async followUp(): Promise<void> {}
  public async abort(): Promise<void> {}
  public dispose(): void {}
}

class LifecycleHarness {
  public readonly adapters: LifecycleAdapter[] = [];

  public get promptCalls(): number {
    return this.adapters.reduce((total, adapter) => total + adapter.promptCalls, 0);
  }

  public create(spec: AgentLaunchSpec): LifecycleAdapter {
    const adapter = new LifecycleAdapter(spec);
    this.adapters.push(adapter);
    return adapter;
  }
}

class LifecycleAdapter implements PiSessionAdapter {
  public readonly sessionId: string;
  public readonly sessionFile: string;
  public promptCalls = 0;
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();
  readonly #drain = deferred<void>();

  public constructor(private readonly spec: AgentLaunchSpec) {
    this.sessionId = spec.identity.sessionId;
    this.sessionFile = path.join(spec.workspace.sessionDirectory, `${this.sessionId}.jsonl`);
  }

  public getActiveToolNames(): readonly string[] {
    return [TERMINAL_TOOL_NAME];
  }
  public appendMapping(): void {}
  public subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  public async prompt(): Promise<void> {
    this.promptCalls += 1;
    this.emitUsage(3, 2, 5, 1);
    await this.#drain.promise;
  }
  public async continue(): Promise<void> {
    await this.prompt();
  }
  public async steer(): Promise<void> {}
  public async followUp(): Promise<void> {}
  public async abort(): Promise<void> {
    this.#drain.resolve();
  }
  public dispose(): void {}
  public emitUsage(input: number, output: number, cacheRead: number, cacheWrite: number): void {
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "working" }],
        api: "openai-responses",
        provider: "openai-codex",
        model: "test-model",
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
    for (const listener of this.#listeners) listener(event);
  }
}

class DeletionHarness {
  public adapter: DeletionAdapter | undefined;
  public writeTool: AuthorityBackedTool | undefined;

  public get promptCalls(): number {
    return this.adapter?.promptCalls ?? 0;
  }

  public create(spec: AgentLaunchSpec, tools: readonly AuthorityBackedTool[]): DeletionAdapter {
    this.writeTool = tools.find((tool) => tool.name === "koni_write_file");
    this.adapter = new DeletionAdapter(spec, tools);
    return this.adapter;
  }
}

class DeletionAdapter implements PiSessionAdapter {
  public readonly sessionId: string;
  public readonly sessionFile: string;
  public promptCalls = 0;
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();
  readonly #drain = deferred<void>();

  public constructor(
    private readonly spec: AgentLaunchSpec,
    private readonly tools: readonly AuthorityBackedTool[],
  ) {
    this.sessionId = spec.identity.sessionId;
    this.sessionFile = path.join(spec.workspace.sessionDirectory, `${this.sessionId}.jsonl`);
  }

  public getActiveToolNames(): readonly string[] {
    return this.tools.map((tool) => tool.name);
  }
  public appendMapping(): void {}
  public subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  public async prompt(): Promise<void> {
    this.promptCalls += 1;
    this.emitUsage(3, 2, 5, 1);
    await this.#drain.promise;
  }
  public async continue(): Promise<void> {
    await this.prompt();
  }
  public async steer(): Promise<void> {}
  public async followUp(): Promise<void> {}
  public async abort(): Promise<void> {
    this.#drain.resolve();
  }
  public dispose(): void {}
  public emitTerminal(output: unknown): void {
    for (const listener of this.#listeners) {
      listener({
        type: "tool_execution_start",
        toolCallId: "late-terminal",
        toolName: "koni_submit_output",
        args: output,
      });
      listener({
        type: "tool_execution_end",
        toolCallId: "late-terminal",
        toolName: "koni_submit_output",
        result: { content: [{ type: "text", text: "late" }], terminate: true },
        isError: false,
      });
    }
  }
  public emitUsage(input: number, output: number, cacheRead: number, cacheWrite: number): void {
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "working" }],
        api: "openai-responses",
        provider: "openai-codex",
        model: "test-model",
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
    for (const listener of this.#listeners) listener(event);
  }
}

class GitConflictHarness {
  public integrationAttempts = 0;
  public integrationTicketCalls = 0;
  readonly #verification = deferred<void>();

  public get verification(): Promise<void> {
    return this.#verification.promise;
  }
  public releaseVerification(): void {
    this.#verification.resolve();
  }

  public create(spec: AgentLaunchSpec): PiSessionAdapter {
    if (spec.identity.ticketId === "integrate-target") {
      this.integrationAttempts += 1;
      return new HangingAdapter(spec);
    }
    return new FileCompletingAdapter(spec, "run-side change\n");
  }
}

class FileCompletingAdapter implements PiSessionAdapter {
  public readonly sessionId: string;
  public readonly sessionFile: string;
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();

  public constructor(
    private readonly spec: AgentLaunchSpec,
    private readonly content: string,
  ) {
    this.sessionId = spec.identity.sessionId;
    this.sessionFile = path.join(spec.workspace.sessionDirectory, `${this.sessionId}.jsonl`);
  }

  public getActiveToolNames(): readonly string[] {
    return [TERMINAL_TOOL_NAME];
  }
  public appendMapping(): void {}
  public subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  public async prompt(): Promise<void> {
    await writeFile(path.join(this.spec.workspace.cwd, "README.md"), this.content);
    for (const listener of this.#listeners) {
      listener({
        type: "tool_execution_start",
        toolCallId: "terminal",
        toolName: TERMINAL_TOOL_NAME,
        args: { result: "completed" },
      });
      listener({
        type: "tool_execution_end",
        toolCallId: "terminal",
        toolName: TERMINAL_TOOL_NAME,
        result: { content: [{ type: "text", text: "accepted" }], terminate: true },
        isError: false,
      });
    }
  }
  public async continue(): Promise<void> {
    await this.prompt();
  }
  public async steer(): Promise<void> {}
  public async followUp(): Promise<void> {}
  public async abort(): Promise<void> {}
  public dispose(): void {}
}

class HangingAdapter implements PiSessionAdapter {
  public readonly sessionId: string;
  public readonly sessionFile: string;
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();
  readonly #drain = deferred<void>();

  public constructor(private readonly spec: AgentLaunchSpec) {
    this.sessionId = spec.identity.sessionId;
    this.sessionFile = path.join(spec.workspace.sessionDirectory, `${this.sessionId}.jsonl`);
  }

  public getActiveToolNames(): readonly string[] {
    return [TERMINAL_TOOL_NAME];
  }
  public appendMapping(): void {}
  public subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  public async prompt(): Promise<void> {
    await this.#drain.promise;
  }
  public async continue(): Promise<void> {
    await this.prompt();
  }
  public async steer(): Promise<void> {}
  public async followUp(): Promise<void> {}
  public async abort(): Promise<void> {
    this.#drain.resolve();
  }
  public dispose(): void {}
}

function contextProvider(spec: AgentLaunchSpec): KoniContextProvider {
  return {
    async loadBoundContext() {
      throw new Error("not used in the offline engine seam");
    },
    async loadCompactionSnapshot() {
      throw new Error("not used in the offline engine seam");
    },
    async authorizeCompaction() {
      return { authorizationId: "unused-compaction" };
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

function ticket(): TicketRecord {
  const now = "2026-07-16T00:00:00.000Z";
  return {
    id: "ticket-one",
    operationId: "implement-change",
    title: "Implement feature",
    summary: "Implement the approved feature",
    status: "queued",
    priority: 0,
    dependencyIds: [],
    targetNodeIds: ["change-one"],
    readPaths: ["."],
    writePaths: ["README.md"],
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

function configuredCheckInfrastructureRetryFixture(
  at: string,
  check: { infrastructureFailure?: string; summary?: string },
): RunRecord {
  const value = ticket();
  value.title = "Prepare proof";
  value.status = "blocked";
  value.blocker = "baseline-proof-set failed validation";
  value.steps[0] = {
    ...value.steps[0]!,
    id: "author-historical-baseline",
    status: "failed",
    attemptIds: ["attempt-proof"],
    startedAt: at,
    completedAt: at,
  };
  const terminalPolicyMaterial = {
    protocol: "koni.agent-terminal-policy.v1" as const,
    mode: "failed_submission" as const,
    acceptedAt: at,
  };
  return {
    tickets: { [value.id]: value },
    attempts: {
      "attempt-proof": {
        id: "attempt-proof",
        sessionId: "session-proof",
        sessionFile: undefined,
        ticketId: value.id,
        stepId: value.steps[0].id,
        personaId: value.steps[0].personaId,
        modelProvider: "anthropic",
        modelId: "claude-haiku-4-5",
        thinkingLevel: "medium",
        status: "completed",
        launchSpecHash: rawSha256("proof launch"),
        startedAt: at,
        endedAt: at,
        terminalOutputSha256: rawSha256("failed proof submission"),
        terminalOutputSizeBytes: 64,
        terminalAcceptedAt: at,
        terminalPolicy: {
          ...terminalPolicyMaterial,
          sha256: canonicalHash(terminalPolicyMaterial),
        },
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        kind: "ticket",
      },
    },
    checks: [
      {
        id: "check-proof",
        attemptId: "attempt-proof",
        callId: "call-proof",
        requestedCheckId: "baseline-proof-set",
        definitionHash: rawSha256("proof check"),
        kind: "command",
        accepted: false,
        passed: false,
        summary: check.summary ?? "baseline-proof-set failed its configured result contract",
        commands: [],
        evidenceSha256: rawSha256("proof evidence"),
        evidenceSizeBytes: 1,
        evidenceArtifactPath: "runs/run-one/checks/proof.json",
        recordedAt: at,
        ...(check.infrastructureFailure === undefined
          ? {}
          : { infrastructureFailure: check.infrastructureFailure }),
      },
    ],
  } as unknown as RunRecord;
}

function reissuableLifecycleCatalog(): CompiledStateMachineCatalog {
  const ticket = lifecycleMachine(
    "ticket",
    "queued",
    ["queued", "in_progress", "integrating", "blocked", "closed"],
    ["closed"],
    [
      lifecycleTransition("start", ["queued"], "in_progress", ["compiler"]),
      lifecycleTransition("request-review", ["in_progress"], "integrating", ["compiler"]),
      lifecycleTransition("rework", ["integrating"], "in_progress", ["compiler"]),
      lifecycleTransition("block", ["queued", "in_progress", "integrating"], "blocked", [
        "compiler",
      ]),
      lifecycleTransition("release", ["blocked"], "queued", ["compiler"]),
      lifecycleTransition("finish", ["in_progress", "integrating"], "closed", ["compiler"]),
      lifecycleTransition("reopen-stale-obligation", ["closed"], "queued", ["compiler"]),
    ],
  );
  const run = lifecycleMachine(
    "run",
    "active",
    ["active", "paused", "concluded", "stopped", "failed"],
    ["concluded", "stopped", "failed"],
    [
      lifecycleTransition("pause", ["active"], "paused", ["human"]),
      lifecycleTransition("resume", ["paused"], "active", ["human"]),
      lifecycleTransition("conclude", ["active", "paused"], "concluded", ["compiler"]),
      lifecycleTransition("stop", ["active", "paused"], "stopped", ["human"]),
      lifecycleTransition("fail", ["active", "paused"], "failed", ["compiler"]),
    ],
  );
  const material = {
    protocol: STATE_MACHINE_CATALOG_PROTOCOL,
    configuration_sha256: `sha256:${"b".repeat(64)}`,
    machines: { ticket, run },
  } as const;
  return { ...material, catalog_sha256: canonicalHash(material) };
}

function lifecycleTransition(
  id: string,
  from: readonly string[],
  to: string,
  actors: readonly string[],
): CompiledStateTransition {
  const material = { id, from: [...from], to, actors: [...actors] };
  return { ...material, transition_sha256: canonicalHash(material) };
}

function lifecycleMachine(
  id: string,
  initial: string,
  states: readonly string[],
  terminalStates: readonly string[],
  transitions: readonly CompiledStateTransition[],
): CompiledStateMachine {
  const material = {
    id,
    initial,
    states: [...states],
    terminal_states: [...terminalStates],
    transitions: [...transitions],
  };
  return { ...material, machine_sha256: canonicalHash(material) };
}

function reviewTicket(): TicketRecord {
  const value = ticket();
  value.steps.push({
    id: "review",
    title: "Review",
    personaId: "reviewer",
    kind: "review",
    status: "pending",
    attemptIds: [],
    summary: undefined,
    startedAt: undefined,
    completedAt: undefined,
  });
  value.reviewFailureReopenFrom = "implement";
  value.reviewReworkLimit = 1;
  value.reviewReworkCount = 0;
  value.reviewReworks = [];
  return value;
}

async function authorizeMerge(
  client: AuthorityClient,
  runId: string,
  idempotencyKey: string,
): Promise<void> {
  const inspected = await client.request("run.merge.inspect", { runId });
  const previewToken = (inspected.result as { previewToken: string }).previewToken;
  await client.request(
    "run.merge.authorize",
    { runId, previewToken },
    {
      expectedRevision: client.revision,
      idempotencyKey,
    },
  );
}

async function authorizeDelete(
  client: AuthorityClient,
  runId: string,
  idempotencyKey: string,
  mode: "preserve_branches" | "delete_owned_branches" = "delete_owned_branches",
): Promise<void> {
  const inspected = await client.request("run.deletion.inspect", { runId });
  const previewToken = (inspected.result as { previewToken: string }).previewToken;
  await client.request(
    "run.delete",
    { runId, mode, previewToken },
    {
      expectedRevision: client.revision,
      idempotencyKey,
    },
  );
}

function totalUsage(run: { attempts: RunRecord["attempts"] }): number {
  return Object.values(run.attempts).reduce(
    (total, attempt) =>
      total +
      attempt.inputTokens +
      attempt.outputTokens +
      attempt.cacheReadTokens +
      attempt.cacheWriteTokens,
    0,
  );
}

function largeAwaitingApprovalRun(root: string, runId: string, objectiveBytes: number): RunRecord {
  const createdAt = "2026-07-18T00:00:00.000Z";
  const lifecycle = newRunLifecycle(runId);
  lifecycle.phase = "awaiting_approval";
  lifecycle.runningIntent = false;
  lifecycle.activeSinceMs = undefined;
  return {
    protocol: "koni.run-record.v1",
    id: runId,
    revision: 0,
    generation: 0,
    projectRoot: root,
    profile: {
      packageName: "@koni/coding-profile",
      packageVersion: "1.0.0",
      lineage: "koni.software",
      bundleHash: rawSha256("wide-profile"),
    },
    compiledConfigHash: rawSha256("wide-config"),
    runTypeId: "large",
    objective: "x".repeat(objectiveBytes),
    intake: { goal: "Wide bounded quiesce fixture" },
    createdAt,
    updatedAt: createdAt,
    lifecycle,
    pipelineStageIds: [],
    currentPipelineStageId: undefined,
    plan: {
      revision: 1,
      status: "awaiting_approval",
      full: {},
      concise: {},
      graphSeed: undefined,
      steeringHistory: [],
    },
    graphRevision: 0,
    graphHash: undefined,
    tickets: {},
    attempts: {},
    questions: {},
    activity: [],
    git: fixtureRunGit(root, runId),
  };
}

async function recoveryDraftRun(
  root: string,
  runId: string,
  objective: string,
  program: RunCompilerProgram,
): Promise<RunRecord> {
  const definition = await program.resolveRun({
    runId,
    objective,
    runTypeId: "small",
    targetRef: "refs/heads/main",
    intake: { goal: objective },
  });
  const git = await new IsolatedGitLifecycle(root).planRun(runId, "refs/heads/main", {
    policy: definition.behavior.runType.git,
    run: createGitRunTemplateContext({
      id: runId,
      objective: definition.objective,
      profileHash: definition.compiledConfigHash,
    }),
  });
  const now = "2026-07-18T00:00:00.000Z";
  return {
    protocol: "koni.run-record.v1",
    id: runId,
    revision: 0,
    generation: 0,
    projectRoot: root,
    profile: structuredClone(definition.profile),
    compiledConfigHash: definition.compiledConfigHash,
    ...(definition.lifecycleCatalog === undefined
      ? {}
      : { lifecycleCatalog: structuredClone(definition.lifecycleCatalog) }),
    runTypeId: definition.runTypeId,
    behavior: structuredClone(definition.behavior),
    workingSpecOwnerId: definition.workingSpecOwnerId,
    objective: definition.objective,
    intake: structuredClone(definition.intake),
    executionConfig: structuredClone(definition.executionConfig),
    planningMode: definition.planningMode,
    createdAt: now,
    updatedAt: now,
    lifecycle: newRunLifecycle(runId),
    pipelineStageIds: [...definition.pipelineStageIds],
    pipelineStages: structuredClone(definition.pipelineStages),
    currentPipelineStageId: definition.pipelineStageIds[0],
    plan: undefined,
    graphRevision: 0,
    graphHash: undefined,
    tickets: {},
    attempts: {},
    checks: [],
    pendingEffects: {},
    pendingChecks: {},
    questions: {},
    activity: [],
    git,
    pendingGitIntents: {},
    gitReceipts: [],
  };
}

function legacyPurposeLessQuiesce(
  operation: DurableAuthorityQuiesceOperation,
): DurableAuthorityQuiesceOperation {
  const { purpose: _purpose, sha256: _sha256, ...material } = operation;
  return {
    ...material,
    sha256: canonicalHash(material),
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

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for authority state");
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-engine-"));
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

function gitOutput(cwd: string, ...argv: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(stdout).toString("utf8").trim())
        : reject(new Error(Buffer.concat(stderr).toString("utf8"))),
    );
  });
}
