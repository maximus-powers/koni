import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { AuthorityClient } from "../src/authority/client.js";
import {
  RunAuthorityEngine,
  type PreparedManagedAttempt,
  type RunCompilerProgram,
  type RunAuthorityEngineOptions,
} from "../src/authority/run-engine.js";
import {
  NativeRunCompilerProgram,
} from "../src/compiler/run-program.js";
import type { VerifiedProfileBaseline } from "../src/compiler/profile-package.js";
import type { AgentLaunchSpec } from "../src/pi/launch-spec.js";
import type {
  AuthorityBackedTool,
  ManagedPiSessionFactory,
  PiSessionAdapter,
} from "../src/pi/managed-session.js";
import { ManagedSessionSupervisor } from "../src/pi/supervisor.js";
import { IsolatedGitLifecycle, type GitLifecycleIntent } from "../src/git/lifecycle.js";
import { canonicalHash, type Sha256Digest } from "../src/shared/canonical.js";
import { installProfile, loadProfilePackage } from "../src/profile/install.js";
import {
  assertRunRecord,
  ticketImmutableProjection,
  type RunRecord,
  type TerminalFailureSettlementProof,
  type TicketExecutionControlRecord,
} from "../src/state/run-record.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const researchProfile = path.join(repositoryRoot, "packages", "research-profile");
const roots: string[] = [];
const engines: RunAuthorityEngine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("composed change-control authority", () => {
  it("publishes one Research request and source hold in the same durable transaction", async () => {
    let approvalCompilerWorkspace: Pick<RunRecord["git"], "planning" | "run"> | undefined;
    let fixture!: Awaited<ReturnType<typeof researchAuthority>>;
    fixture = await researchAuthority(new ScriptHarness(), {
      actionFault: async (point, input) => {
        const last = input.journal?.steps.at(-1);
        if (point !== "before_journal" || last?.primitive !== "rules.evaluate" ||
            last.status !== "completed") return;
        const run = await fixture.engine.store.getRun(input.runId);
        if (run.actionExecutions?.[input.invocationId]?.boundary.kind !== "approved_plan_compile") return;
        approvalCompilerWorkspace = structuredClone({
          planning: run.git.planning,
          run: run.git.run,
        });
      },
    });
    const client = await AuthorityClient.connect({
      projectRoot: fixture.root,
      client: "tui",
      version: "1.0.0",
    });
    const created = await client.request("run.create", {
      objective: "Test whether retrieval improves bounded factual recall",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Test whether retrieval improves bounded factual recall" },
    }, { expectedRevision: 0, idempotencyKey: "create-research-change-control" });
    const runId = (created.result as { runId: string }).runId;
    await waitFor(async () => (await fixture.engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval");
    await client.request("authority.ping");
    await client.request("plan.approve", { runId }, {
      expectedRevision: client.revision,
      idempotencyKey: "approve-research-change-control",
    });

    let published: { run: RunRecord; proposal: RunRecord["tickets"][string] };
    try {
      published = await waitForValue(async () => {
        const run = await fixture.engine.store.getRun(runId);
        if (run.lifecycle.phase === "blocked" || run.lifecycle.phase === "failed") {
          throw new Error(`run stopped before proposal publication: ${run.lifecycle.blocker ?? run.lifecycle.terminalReason ?? run.lifecycle.phase}`);
        }
        const proposal = Object.values(run.tickets).find((ticket) =>
          ticket.executionControl?.proposalRequest !== undefined);
        return proposal === undefined ? undefined : { run, proposal };
      });
    } catch (error) {
      const run = await fixture.engine.store.getRun(runId);
      const failedAttempt = Object.values(run.attempts).find((attempt) =>
        attempt.kind === "ticket" && attempt.status === "failed");
      const failedTicket = failedAttempt === undefined ? undefined : run.tickets[failedAttempt.ticketId];
      const failedStep = failedTicket?.steps.find((step) => step.id === failedAttempt?.stepId);
      let terminalPolicy: unknown;
      try {
        if (failedAttempt === undefined || failedTicket === undefined || failedStep === undefined) {
          terminalPolicy = undefined;
        } else {
          const projection = await fixture.native.projectAssignmentTerminalPolicy({
            run,
            assignment: {
              runId,
              ticketId: failedTicket.id,
              stepId: failedStep.id,
              personaId: failedStep.personaId,
              priority: failedTicket.priority,
            },
            attemptId: failedAttempt.id,
          });
          terminalPolicy = {
            protocol: projection.protocol,
            operationId: projection.executionPolicyBinding.operationId,
            workflowId: projection.executionPolicyBinding.workflowId,
            stepId: projection.executionPolicyBinding.stepId,
            validationCheckIds: projection.validationCheckIds,
            validationChecks: projection.validationChecks.map((check) => check.checkId),
            composedReplayCheckIds: projection.composedReplayCheckIds,
          };
        }
      } catch (projectionError) {
        terminalPolicy = {
          projectionError: projectionError instanceof Error
            ? projectionError.message
            : String(projectionError),
        };
      }
      throw new Error(`proposal was not published: ${JSON.stringify({
        phase: run.lifecycle.phase,
        blocker: run.lifecycle.blocker,
        tickets: Object.values(run.tickets).map((ticket) => ({
          id: ticket.id,
          operation: ticket.operationId,
          status: ticket.status,
          blocker: ticket.blocker,
          steps: ticket.steps.map((step) => ({ id: step.id, status: step.status })),
        })),
        attempts: Object.values(run.attempts).map((attempt) => ({
          kind: attempt.kind,
          ticket: attempt.ticketId,
          step: attempt.stepId,
          status: attempt.status,
          summary: attempt.terminalSummary,
        })),
        actions: Object.values(run.actionExecutions ?? {})
          .filter((action) => action.settledAt === undefined || action.journal.status !== "completed")
          .map((action) => ({
          invocationId: action.invocationId,
          boundary: action.boundary,
          journal: action.journal,
          semanticResult: action.semanticResult,
          settlement: action.settlement,
          recoveryInvocationId: action.recoveryInvocationId,
          recoverySettledAt: action.recoverySettledAt,
        })),
        terminalPolicy,
        proposalProjectionTrace: fixture.harness.proposalProjectionTrace,
        script: fixture.harness.trace,
        activity: run.activity.slice(-12).map((entry) => entry.message),
      })}`, { cause: error });
    }
    const request = published.proposal.executionControl!.proposalRequest!;
    const source = published.run.tickets[request.sourceTicketId]!;
    const authority = published.proposal.executionControl!.controlTicketAuthority!;
    const causal = authority.causal;
    expect(causal.role).toBe("proposal");
    if (causal.role !== "proposal") throw new Error("Research proposal has non-proposal causal authority");
    expect(published.run.profile).toMatchObject({ lineage: "koni.research" });
    expect(approvalCompilerWorkspace).toMatchObject({
      planning: { status: "retired" },
      run: { status: "ready", headOid: expect.stringMatching(/^[0-9a-f]{40,64}$/u) },
    });
    expect(published.proposal).toMatchObject({
      operationId: "lifecycle.change-request",
      status: "proposed",
      executionControl: {
        changeControlScopeNodeIds: expect.any(Array),
        proposalRequest: {
          requestSha256: expect.stringMatching(/^sha256:/u),
          sourceTicketId: source.id,
          sourceStepId: "drill-claims",
          sourceOutputSha256: expect.stringMatching(/^sha256:/u),
        },
      },
    });
    expect(source.executionControl?.sourceHold).toEqual({
      proposalTicketId: published.proposal.id,
      requestSha256: request.requestSha256,
    });
    expect(authority).toMatchObject({
      protocol: "koni.compiler-control-ticket-authority.v1",
      runId,
      role: "proposal",
      ticketId: published.proposal.id,
      configurationSha256: published.run.compiledConfigHash,
      projectionSha256: expect.stringMatching(/^sha256:/u),
    });
    expect(authority.projection).toEqual(ticketImmutableProjection(published.proposal));
    expect(authority.projectionSha256).toBe(authority.projection.sha256);
    expect(causal.publication).toMatchObject({
      runId,
      proposalTicketId: published.proposal.id,
      sourceTicketId: source.id,
      sourceStepId: request.sourceStepId,
      sourceOutputSha256: request.sourceOutputSha256,
      requestSha256: request.requestSha256,
      configurationSha256: published.run.compiledConfigHash,
      catalogSha256: authority.catalogSha256,
    });
    expect(causal.sourceTicketProjection).toEqual(ticketImmutableProjection(source));
    expect(causal.sourceHold).toEqual(source.executionControl?.sourceHold);
    expect(published.run.terminalSuccessProofs?.[causal.sourceTerminalProof.sha256])
      .toEqual(causal.sourceTerminalProof);
    expect(published.run.actionExecutions?.[causal.sourceTerminalProof.actionInvocationId])
      .toMatchObject({
        boundary: {
          kind: "assignment_validation",
          ticketId: source.id,
          stepId: request.sourceStepId,
          attemptId: causal.sourceTerminalProof.attemptId,
        },
        semanticResult: {
          kind: "assignment",
          status: "completed",
          changeControlSha256: causal.sourceTerminalProof.semanticResult.changeControlSha256,
        },
        settlement: { disposition: "completed" },
      });
    expect(() => assertRunRecord(structuredClone(published.run))).not.toThrow();
    expect(source.executionPolicyBinding?.configurationSha256).toBe(published.run.compiledConfigHash);
    expect(published.proposal.executionPolicyBinding?.configurationSha256)
      .toBe(published.run.compiledConfigHash);
    expect(fixture.harness.promptCalls).toBeGreaterThanOrEqual(2);
    client.close();
  }, 60_000);

  it("releases and reissues one Research source across rejection, reviewed no-op, and application", async () => {
    const harness = new ScriptHarness(
      ["request", "request", "request"],
      ["no-op", "apply-change-request"],
    );
    const fixture = await researchAuthority(harness);
    const client = await AuthorityClient.connect({
      projectRoot: fixture.root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createApprovedRun(client, fixture.engine, "research-change-control-decisions");

    const first = await nextProposal(fixture.engine, runId, new Set(), harness);
    const sourceId = first.proposal.executionControl!.proposalRequest!.sourceTicketId;
    const firstSourceCycleId = first.run.tickets[sourceId]!.gitCycleId!;
    await decideProposal(client, runId, first.proposal.id, "rejection", "Reject the first bounded request");
    const second = await nextProposal(fixture.engine, runId, new Set([first.proposal.id]), harness);
    const afterRejection = second.run;
    expect(afterRejection.tickets[first.proposal.id]).toMatchObject({
      status: "completed",
      executionControl: {
        proposalDecision: {
          protocol: "koni.proposal-decision-authority.v2",
          runId,
          proposalTicketId: first.proposal.id,
          requestSha256: first.proposal.executionControl!.proposalRequest!.requestSha256,
          decision: "rejection",
          actor: "operator",
        },
        proposalDecisionHistory: [{
          protocol: "koni.proposal-decision-authority.v2",
          runId,
          proposalTicketId: first.proposal.id,
          requestSha256: first.proposal.executionControl!.proposalRequest!.requestSha256,
          decision: "rejection",
          actor: "operator",
        }],
        proposalDisposition: { kind: "rejected" },
      },
    });
    expect(afterRejection.git.ticketCycles[firstSourceCycleId]).toMatchObject({
      status: "retired",
      archiveRef: expect.stringContaining("refs/koni/archive/"),
      supersessionSha256: expect.stringMatching(/^sha256:/u),
    });
    expect(afterRejection.tickets[sourceId]!.gitCycleId).not.toBe(firstSourceCycleId);
    expect(afterRejection.tickets[sourceId]!.executionControl?.sourceHold?.proposalTicketId)
      .toBe(second.proposal.id);

    await decideProposal(client, runId, second.proposal.id, "approval", "Approve the reviewed no-op");
    const third = await nextProposal(
      fixture.engine,
      runId,
      new Set([first.proposal.id, second.proposal.id]),
      harness,
    );
    expect(third.run.tickets[second.proposal.id]).toMatchObject({
      status: "completed",
      executionControl: {
        proposalDisposition: { kind: "no_op" },
        approvedApplicationSha256: expect.stringMatching(/^sha256:/u),
        approvedMaterialization: {
          protocol: "koni.approved-change-materialization.v1",
          runId,
          proposalTicketId: second.proposal.id,
          kind: "no_op",
          disposition: "materialize_without_agent",
        },
      },
    });
    const noOp = third.run.tickets[second.proposal.id]!.executionControl!.approvedMaterialization!;
    expect(noOp.proposalTerminalProof.actionInvocationId)
      .not.toBe(noOp.reviewTerminalProof.actionInvocationId);
    expect(noOp.proposalTerminalProof.attemptId).not.toBe(noOp.reviewTerminalProof.attemptId);
    expect(third.run.terminalSuccessProofs?.[noOp.proposalTerminalProof.sha256])
      .toEqual(noOp.proposalTerminalProof);
    expect(third.run.terminalSuccessProofs?.[noOp.reviewTerminalProof.sha256])
      .toEqual(noOp.reviewTerminalProof);
    expect(() => assertRunRecord(forgeMaterializationWithOneProof(third.run, second.proposal.id)))
      .toThrow();
    expect(() => assertRunRecord(forgeMaterializationBindingIdentity(third.run, second.proposal.id)))
      .toThrow();
    expect(Object.values(third.run.tickets).some((ticket) =>
      ticket.executionControl?.sourceProposalTicketId === second.proposal.id)).toBe(false);
    expect(third.run.tickets[sourceId]!.executionControl?.sourceHold?.proposalTicketId)
      .toBe(third.proposal.id);
    const preApplicationSourceCycleId = third.run.tickets[sourceId]!.gitCycleId!;

    await decideProposal(client, runId, third.proposal.id, "approval", "Approve the bounded application");
    let applied: {
      run: RunRecord;
      proposal: RunRecord["tickets"][string];
      application: RunRecord["tickets"][string];
      source: RunRecord["tickets"][string];
    };
    try {
      applied = await waitForDurableProgressValue(async () => {
        const run = await fixture.engine.store.getRun(runId);
        if (run.lifecycle.phase === "blocked" || run.lifecycle.phase === "failed") {
          throw new Error(`run stopped before approved application publication: ${run.lifecycle.blocker ?? run.lifecycle.phase}`);
        }
        const proposal = run.tickets[third.proposal.id];
        const disposition = proposal?.executionControl?.proposalDisposition;
        if (disposition?.kind !== "application" || disposition.applicationTicketId === undefined) {
          return { progress: run.revision };
        }
        const application = run.tickets[disposition.applicationTicketId];
        const source = run.tickets[sourceId];
        if (proposal === undefined || application === undefined || source === undefined) {
          return { progress: run.revision };
        }
        const value = application.status === "completed" && source.executionControl?.sourceHold === undefined &&
          source.gitCycleId !== undefined && source.gitCycleId !== preApplicationSourceCycleId
          ? { run, proposal, application, source }
          : undefined;
        return value === undefined
          ? { progress: run.revision }
          : { progress: run.revision, value };
      });
    } catch (error) {
      const run = await fixture.engine.store.getRun(runId);
      const proposal = run.tickets[third.proposal.id];
      const applicationId = proposal?.executionControl?.proposalDisposition?.applicationTicketId;
      const application = applicationId === undefined ? undefined : run.tickets[applicationId];
      throw new Error(`approved application did not publish and release its source: ${JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        phase: run.lifecycle.phase,
        blocker: run.lifecycle.blocker,
        revision: run.revision,
        proposal: proposal === undefined ? undefined : {
          id: proposal.id,
          status: proposal.status,
          disposition: proposal.executionControl?.proposalDisposition,
        },
        application: application === undefined ? undefined : {
          id: application.id,
          status: application.status,
          blocker: application.blocker,
          gitCycleId: application.gitCycleId,
          steps: application.steps.map((step) => ({
            id: step.id,
            status: step.status,
            attemptIds: step.attemptIds,
          })),
        },
        source: run.tickets[sourceId] === undefined ? undefined : {
          status: run.tickets[sourceId]!.status,
          blocker: run.tickets[sourceId]!.blocker,
          gitCycleId: run.tickets[sourceId]!.gitCycleId,
          sourceHold: run.tickets[sourceId]!.executionControl?.sourceHold,
        },
        attempts: Object.values(run.attempts).map((attempt) => ({
          id: attempt.id,
          ticketId: attempt.ticketId,
          stepId: attempt.stepId,
          status: attempt.status,
          error: attempt.error,
        })),
        actions: Object.values(run.actionExecutions ?? {})
          .filter((action) => action.settledAt === undefined || action.journal.status !== "completed")
          .map((action) => ({
          invocationId: action.invocationId,
          ticketId: action.boundary.ticketId,
          stepId: action.boundary.stepId,
          attemptId: action.boundary.attemptId,
          journalStatus: action.journal.status,
          journalSteps: action.journal.steps.map((step) => ({
            id: step.stepId,
            primitive: step.primitive,
            status: step.status,
            ...(step.status === "failed" ? { error: step.error } : {}),
          })),
          semanticResult: action.semanticResult,
          settlement: action.settlement,
        })),
        gitCycles: Object.values(run.git.ticketCycles).map((cycle) => ({
          id: cycle.cycleId,
          ticketId: cycle.ticketId,
          status: cycle.status,
          blocker: cycle.blocker,
        })),
        compilationTrace: harness.compilationTrace.slice(-12).map((entry) => ({
          attemptId: entry.attemptId,
          assignment: entry.assignment,
          outcome: entry.outcome,
          changeControlSha256: entry.changeControlSha256,
          error: entry.error,
          pending: entry.outcome === undefined && entry.error === undefined,
        })),
        activity: run.activity.slice(-24).map((entry) => entry.message),
      })}`);
    }
    expect(applied.proposal.status).toBe("completed");
    expect(applied.application).toMatchObject({
      operationId: "lifecycle.apply-change-request",
      status: "completed",
      executionControl: {
        controlTicketAuthority: {
          protocol: "koni.compiler-control-ticket-authority.v1",
          runId,
          role: "approved_application",
          ticketId: applied.application.id,
        },
        sourceProposalTicketId: third.proposal.id,
        approvedApplicationSha256: applied.proposal.executionControl!.approvedApplicationSha256,
      },
    });
    const applicationAuthority = applied.application.executionControl!.controlTicketAuthority!;
    expect(applicationAuthority.projection).toEqual(ticketImmutableProjection(applied.application));
    expect(applicationAuthority.causal).toMatchObject({
      role: "approved_application",
      materialization: applied.proposal.executionControl!.approvedMaterialization,
      proposalTicketAuthoritySha256:
        applied.proposal.executionControl!.controlTicketAuthority!.sha256,
    });
    expect(applied.application.gitCycleId).toBeDefined();
    expect(applied.run.git.ticketCycles[applied.application.gitCycleId!]?.status).toBe("retired");
    expect(applied.source.gitCycleId).not.toBe(firstSourceCycleId);
    expect(applied.source.gitCycleId).not.toBe(preApplicationSourceCycleId);
    expect(applied.source.executionControl?.sourceHold).toBeUndefined();
    expect(() => assertRunRecord(structuredClone(applied.run))).not.toThrow();
    await pauseAtFreshRevision(client, fixture.engine, runId, "pause-after-change-control-decisions");
    client.close();
  }, 180_000);

  it("recovers a faulted resolver supersession, retries the exact failure, and never chains resolvers", async () => {
    const harness = new ScriptHarness(["fail"], [], 1);
    let supersessionFaulted = false;
    const fixture = await researchAuthority(harness, {
      git: (root) => new IsolatedGitLifecycle(root, {
        effectFault(point) {
          if (!supersessionFaulted && point === "after_ticket_supersession_archive") {
            supersessionFaulted = true;
            throw new Error("fixture crash after immutable supersession archive");
          }
        },
      }),
    });
    let client = await AuthorityClient.connect({
      projectRoot: fixture.root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createApprovedRun(client, fixture.engine, "terminal-resolver-recovery");
    const blocked = await waitForValue(async () => {
      const run = await fixture.engine.store.getRun(runId);
      const resolver = Object.values(run.tickets).find((ticket) =>
        ticket.executionControl?.terminalRecovery !== undefined);
      const attemptIds = resolver?.steps.flatMap((step) => step.attemptIds) ?? [];
      return run.lifecycle.phase === "blocked" && resolver?.status === "blocked" &&
        attemptIds.length === 1 && run.attempts[attemptIds[0]!]?.status === "completed"
        ? { run, resolver }
        : undefined;
    });
    const sourceId = blocked.resolver.executionControl!.terminalRecovery!.sourceTicketId;
    const resolverAuthority = blocked.resolver.executionControl!.controlTicketAuthority!;
    expect(resolverAuthority).toMatchObject({
      protocol: "koni.compiler-control-ticket-authority.v1",
      runId,
      role: "terminal_resolver",
      ticketId: blocked.resolver.id,
    });
    expect(resolverAuthority.projection).toEqual(ticketImmutableProjection(blocked.resolver));
    expect(resolverAuthority.causal).toMatchObject({
      role: "terminal_resolver",
      sourceFailureProof: blocked.resolver.executionControl!.terminalRecovery!.sourceFailureProof,
    });
    const failedResolverCycleId = blocked.resolver.gitCycleId!;
    const failedResolverAttempts = blocked.resolver.steps.flatMap((step) => step.attemptIds);
    expect(failedResolverAttempts).toHaveLength(1);
    expect(blocked.run.attempts[failedResolverAttempts[0]!]!.status).toBe("completed");
    const failedResolverAction = Object.values(blocked.run.actionExecutions ?? {}).find((action) =>
      action.boundary.kind === "assignment_validation" &&
      action.boundary.attemptId === failedResolverAttempts[0]);
    expect(failedResolverAction).toMatchObject({
      semanticResult: { kind: "assignment", status: "failed" },
      settlement: { disposition: "failed" },
    });
    const resolverFailureProof = blocked.resolver.executionControl!.terminalResolverRetryRequests?.[0]
      ?.failureProof;
    expect(blocked.run.terminalFailureProofs?.[
      blocked.resolver.executionControl!.terminalRecovery!.sourceFailureProof.sha256
    ]).toEqual(blocked.resolver.executionControl!.terminalRecovery!.sourceFailureProof);
    expect(resolverFailureProof).toBeUndefined();
    expect(Object.values(blocked.run.tickets).filter((ticket) =>
      ticket.executionControl?.terminalRecovery?.sourceTicketId === blocked.resolver.id)).toEqual([]);

    await client.request("authority.ping");
    const requested = await client.request("terminal-resolver.retry", {
      runId,
      resolverTicketId: blocked.resolver.id,
      message: "Retry only the exact reviewed resolver failure.",
    }, { expectedRevision: client.revision, idempotencyKey: "retry-exact-terminal-resolver" });
    expect(requested.result).toMatchObject({
      runId,
      resolverTicketId: blocked.resolver.id,
      sourceTicketId: sourceId,
      status: "requested",
      retryRequestSha256: expect.stringMatching(/^sha256:/u),
    });
    await waitFor(async () => supersessionFaulted);
    client.close();
    await stopEngine(fixture.engine);

    const restartedGit = new IsolatedGitLifecycle(fixture.root);
    const recoverIntent = vi.spyOn(restartedGit, "recoverIntent");
    const supersedeTicketCycle = vi.spyOn(restartedGit, "supersedeTicketCycle");
    const restarted = await openResearchEngine(
      fixture.root,
      fixture.baseline,
      harness,
      { git: restartedGit },
    );
    client = await AuthorityClient.connect({
      projectRoot: fixture.root,
      client: "tui",
      version: "1.0.0",
    });
    const inert = await restarted.engine.store.getRun(runId);
    const inertResolver = inert.tickets[blocked.resolver.id]!;
    expect(inert.lifecycle.phase).toBe("blocked");
    expect(inertResolver.steps[0]!.attemptIds).toEqual(failedResolverAttempts);
    expect(inertResolver.executionControl?.terminalResolverRetryRequests).toHaveLength(1);
    expect(Object.values(inert.pendingGitIntents ?? {})).toEqual([
      expect.objectContaining({
        kind: "ticket_supersede",
        cycleId: failedResolverCycleId,
        ticketId: blocked.resolver.id,
        supersessionSha256: (requested.result as { retryRequestSha256: string }).retryRequestSha256,
      }),
    ]);

    recoverIntent.mockClear();
    supersedeTicketCycle.mockClear();
    const runRecordArtifact = `runs/${runId}/run.json`;
    for (const variant of ["duplicate", "unrelated"] as const) {
      let injectedIntentId = "";
      await restarted.engine.server.mutateInternal(async ({ revision }) => {
        const current = await restarted.engine.store.getRun(runId);
        const exact = Object.values(current.pendingGitIntents ?? {})
          .find((intent) => intent.kind === "ticket_supersede");
        expect(exact).toBeDefined();
        const draft = nextFixtureRun(current);
        let extra = structuredClone(exact!) as GitLifecycleIntent;
        extra.id = `${extra.id}-${variant}`;
        if (variant === "unrelated") {
          extra = { ...extra, kind: "ticket_retire" } as GitLifecycleIntent;
        }
        injectedIntentId = extra.id;
        draft.pendingGitIntents ??= {};
        draft.pendingGitIntents[extra.id] = extra;
        const committed = await restarted.engine.store.commit({
          expectedRevision: revision,
          runWrites: [{ record: draft, expectedRevision: current.revision }],
        });
        return { revision: committed.state.revision };
      });
      await client.request("authority.ping");
      const beforeRejectedResume = await restarted.engine.store.readArtifact(runRecordArtifact);
      await expect(client.request("run.resume", { runId }, {
        expectedRevision: client.revision,
        idempotencyKey: `reject-${variant}-terminal-resolver-git`,
      })).rejects.toMatchObject({ code: "terminal_resolver_retry_git" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(await restarted.engine.store.readArtifact(runRecordArtifact)).toEqual(beforeRejectedResume);
      expect(recoverIntent).not.toHaveBeenCalled();
      expect(supersedeTicketCycle).not.toHaveBeenCalled();

      await restarted.engine.server.mutateInternal(async ({ revision }) => {
        const current = await restarted.engine.store.getRun(runId);
        const draft = nextFixtureRun(current);
        delete draft.pendingGitIntents?.[injectedIntentId];
        const committed = await restarted.engine.store.commit({
          expectedRevision: revision,
          runWrites: [{ record: draft, expectedRevision: current.revision }],
        });
        return { revision: committed.state.revision };
      });
      await client.request("authority.ping");
    }

    // Restart is deliberately inert. One fresh operator resume joins the exact pending retry; the
    // original durable receipt may be replayed concurrently, but every continuation converges on
    // the same resolver ID + retry hash and may create only one successor attempt.
    const resumed = await client.request("run.resume", { runId }, {
      expectedRevision: client.revision,
      idempotencyKey: "resume-faulted-terminal-resolver",
    });
    expect(resumed.result).toMatchObject({
      status: "retrying",
      resolverTicketId: blocked.resolver.id,
      retryRequestSha256: (requested.result as { retryRequestSha256: string }).retryRequestSha256,
    });
    await Promise.all(Array.from({ length: 4 }, () => client.request("terminal-resolver.retry", {
      runId,
      resolverTicketId: blocked.resolver.id,
      message: "Retry only the exact reviewed resolver failure.",
    }, {
      expectedRevision: client.revision,
      idempotencyKey: "retry-exact-terminal-resolver",
    })));
    let recovered: { run: RunRecord; resolver: RunRecord["tickets"][string]; source: RunRecord["tickets"][string] };
    try {
      recovered = await waitForValue(async () => {
        const run = await restarted.engine.store.getRun(runId);
        const resolver = run.tickets[blocked.resolver.id];
        const source = run.tickets[sourceId];
        return resolver?.status === "completed" &&
          source !== undefined && source.status !== "blocked" && source.status !== "failed"
          ? { run, resolver, source }
          : undefined;
      });
    } catch (error) {
      const run = await restarted.engine.store.getRun(runId);
      const resolver = run.tickets[blocked.resolver.id];
      throw new Error(`resolver did not recover after restart: ${JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        phase: run.lifecycle.phase,
        blocker: run.lifecycle.blocker,
        revision: run.revision,
        pendingGitIntents: run.pendingGitIntents,
        resolver: resolver === undefined ? undefined : {
          id: resolver.id,
          status: resolver.status,
          blocker: resolver.blocker,
          gitCycleId: resolver.gitCycleId,
          retryRequests: resolver.executionControl?.terminalResolverRetryRequests,
          terminalProof: resolver.executionControl?.terminalResolverTerminalProof,
          steps: resolver.steps.map((step) => ({
            id: step.id,
            status: step.status,
            attemptIds: step.attemptIds,
          })),
        },
        source: run.tickets[sourceId] === undefined ? undefined : {
          status: run.tickets[sourceId]!.status,
          blocker: run.tickets[sourceId]!.blocker,
        },
        attempts: Object.values(run.attempts).map((attempt) => ({
          id: attempt.id,
          ticketId: attempt.ticketId,
          stepId: attempt.stepId,
          status: attempt.status,
          error: attempt.error,
          terminalPolicySha256: attempt.terminalPolicy?.sha256,
        })),
        actions: Object.values(run.actionExecutions ?? {}).map((action) => ({
          invocationId: action.invocationId,
          ticketId: action.boundary.ticketId,
          attemptId: action.boundary.attemptId,
          journalStatus: action.journal.status,
          failedPrimitive: [...action.journal.steps].reverse().find((step) => step.status === "failed")?.primitive,
          semanticResult: action.semanticResult,
          settlement: action.settlement,
        })),
        gitCycles: Object.values(run.git.ticketCycles).map((cycle) => ({
          id: cycle.cycleId,
          ticketId: cycle.ticketId,
          status: cycle.status,
          archiveRef: cycle.archiveRef,
          supersessionSha256: cycle.supersessionSha256,
        })),
        activity: run.activity.slice(-24).map((entry) => entry.message),
      })}`);
    }
    expect(recovered.resolver.executionControl?.terminalResolverRetryRequests).toHaveLength(1);
    const retry = recovered.resolver.executionControl!.terminalResolverRetryRequests![0]!;
    expect(retry).toMatchObject({
      protocol: "koni.terminal-resolver-retry.v1",
      runId,
      resolverTicketId: recovered.resolver.id,
      sourceTicketId: sourceId,
      actor: "operator",
      failedAttemptId: failedResolverAttempts[0],
      failureSettlementSha256: retry.failureProof.sha256,
    });
    expect(recovered.run.terminalFailureProofs?.[retry.failureProof.sha256])
      .toEqual(retry.failureProof);
    expect(recovered.resolver.steps[0]!.attemptIds).toHaveLength(2);
    expect(recovered.resolver.steps[0]!.attemptIds.map((attemptId) =>
      recovered.run.attempts[attemptId]!.status)).toEqual(["completed", "completed"]);
    const liveResolverSettlements = Object.values(recovered.run.actionExecutions ?? {})
      .filter((action) => action.boundary.kind === "assignment_validation" &&
        action.boundary.ticketId === recovered.resolver.id)
      .map((action) => action.settlement?.disposition);
    const liveResolverFailure = recovered.run.actionExecutions?.[retry.failureProof.actionInvocationId];
    const archivedResolverFailure = (recovered.run.actionExecutionArchive ?? []).find((entry) =>
      entry.invocationId === retry.failureProof.actionInvocationId);
    expect(liveResolverSettlements).toContain("completed");
    expect(Number(liveResolverFailure !== undefined) + Number(archivedResolverFailure !== undefined)).toBe(1);
    if (liveResolverFailure !== undefined) {
      expect(liveResolverFailure).toMatchObject({
        invocationId: retry.failureProof.actionInvocationId,
        boundary: {
          kind: "assignment_validation",
          ticketId: recovered.resolver.id,
          attemptId: retry.failedAttemptId,
        },
        semanticResult: retry.failureProof.semanticResult,
        settlement: {
          disposition: "failed",
          sha256: retry.failureProof.actionSettlementSha256,
        },
      });
      expect(canonicalHash(liveResolverFailure.semanticResult))
        .toBe(retry.failureProof.semanticResultSha256);
    } else {
      expect(archivedResolverFailure).toMatchObject({
        protocol: "koni.run-action-archive.v2",
        terminalFailureProof: retry.failureProof,
        settlementDisposition: "failed",
        artifactPath: expect.stringMatching(/\.json$/u),
        artifactSha256: expect.stringMatching(/^sha256:/u),
      });
    }
    expect(recovered.resolver.executionControl?.terminalResolverTerminalProof).toBeDefined();
    expect(recovered.run.terminalSuccessProofs?.[
      recovered.resolver.executionControl!.terminalResolverTerminalProof!.sha256
    ]).toEqual(recovered.resolver.executionControl!.terminalResolverTerminalProof);
    expect(() => assertRunRecord(forgeRetryFromSuccessfulResolver(recovered.run, recovered.resolver.id)))
      .toThrow();
    expect(recovered.run.git.ticketCycles[failedResolverCycleId]).toMatchObject({
      status: "retired",
      archiveRef: expect.stringContaining("refs/koni/archive/"),
      supersessionSha256: recovered.resolver.executionControl!
        .terminalResolverRetryRequests![0]!.sha256,
    });
    expect(Object.values(recovered.run.tickets).filter((ticket) =>
      ticket.executionControl?.terminalRecovery?.sourceTicketId === recovered.resolver.id)).toEqual([]);
    expect(recovered.run.pendingGitIntents).toEqual({});
    expect(recovered.source.executionControl?.sourceHold).toBeUndefined();
    expect(() => assertRunRecord(structuredClone(recovered.run))).not.toThrow();

    const settledRevision = recovered.run.revision;
    const settledAttemptIds = [...recovered.resolver.steps[0]!.attemptIds];
    await Promise.all([
      ...Array.from({ length: 4 }, () => client.request("terminal-resolver.retry", {
        runId,
        resolverTicketId: blocked.resolver.id,
        message: "Retry only the exact reviewed resolver failure.",
      }, {
        expectedRevision: client.revision,
        idempotencyKey: "retry-exact-terminal-resolver",
      })),
      ...Array.from({ length: 4 }, () => client.request("run.resume", { runId }, {
        expectedRevision: client.revision,
        idempotencyKey: "resume-faulted-terminal-resolver",
      })),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const replayed = await restarted.engine.store.getRun(runId);
    expect(replayed.revision).toBe(settledRevision);
    expect(replayed.tickets[blocked.resolver.id]!.steps[0]!.attemptIds).toEqual(settledAttemptIds);
    expect(replayed.tickets[blocked.resolver.id]!.executionControl?.terminalResolverRetryRequests)
      .toHaveLength(1);
    await pauseAtFreshRevision(client, restarted.engine, runId, "pause-after-terminal-resolver-recovery");
    client.close();
  }, 120_000);

  it("lets pause win the final Research assignment CAS without a late proposal or restart spend", async () => {
    const reached = deferred<void>();
    const release = deferred<void>();
    const harness = new ScriptHarness(["request"]);
    const fixture = await researchAuthority(harness, {
      actionFault: async (point, input) => {
        if (point !== "before_assignment_settle" || input.ticketId === undefined) return;
        const run = await fixture.engine.store.getRun(input.runId);
        if (run.tickets[input.ticketId]?.operationId !== "formulation.hypothesis.drill-hypothesis") return;
        reached.resolve();
        await release.promise;
      },
    });
    let client = await AuthorityClient.connect({
      projectRoot: fixture.root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createApprovedRun(client, fixture.engine, "pause-final-change-control-cas");
    await reached.promise;
    await client.request("authority.ping");
    await client.request("run.pause", { runId }, {
      expectedRevision: client.revision,
      idempotencyKey: "pause-final-change-control-cas",
    });
    let sourceId = "";
    try {
      await waitFor(async () => (await fixture.engine.store.getRun(runId)).lifecycle.phase === "paused");
      const paused = await fixture.engine.store.getRun(runId);
      const source = Object.values(paused.tickets).find((ticket) =>
        ticket.operationId === "formulation.hypothesis.drill-hypothesis")!;
      sourceId = source.id;
      const validation = Object.values(paused.actionExecutions ?? {}).find((journal) =>
        journal.boundary.kind === "assignment_validation" && journal.boundary.ticketId === source.id)!;
      expect(Object.values(paused.tickets).filter((ticket) =>
        ticket.executionControl?.proposalRequest !== undefined)).toEqual([]);
      expect(source.executionControl?.sourceHold).toBeUndefined();
      expect(source.steps[0]).toMatchObject({ status: "pending" });
      expect(validation.settledAt).toBeDefined();
      expect(validation.settlement).toMatchObject({ disposition: "abandoned" });
      expect(paused.attempts[validation.boundary.attemptId!]).toMatchObject({
        status: "interrupted",
        terminalOutputSha256: expect.stringMatching(/^sha256:/u),
      });
      expect(paused.attempts[validation.boundary.attemptId!]?.terminalPolicy).toBeUndefined();
    } catch (error) {
      const current = await fixture.engine.store.getRun(runId);
      throw new Error(`pause did not settle while assignment validation was gated: ${JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        phase: current.lifecycle.phase,
        attempts: Object.values(current.attempts).map((attempt) => ({
          id: attempt.id,
          status: attempt.status,
        })),
        actions: Object.values(current.actionExecutions ?? {}).map((action) => ({
          invocationId: action.invocationId,
          kind: action.boundary.kind,
          status: action.journal.status,
          settledAt: action.settledAt,
          disposition: action.settlement?.disposition,
        })),
      })}`);
    } finally {
      // Never strand engine.stop() behind the injected finalizer gate when this regression fails.
      // Success reaches the durable paused boundary before releasing the stale continuation.
      release.resolve();
    }
    await waitFor(async () => {
      const current = await fixture.engine.store.getRun(runId);
      return current.lifecycle.phase === "paused" &&
        Object.values(current.tickets).every((ticket) => ticket.executionControl?.proposalRequest === undefined);
    });
    const promptsBeforeRestart = harness.promptCalls;
    client.close();
    await stopEngine(fixture.engine);
    const restarted = await openResearchEngine(fixture.root, fixture.baseline, harness);
    const afterRestart = await restarted.engine.store.getRun(runId);
    expect(afterRestart.lifecycle.phase).toBe("paused");
    expect(Object.values(afterRestart.tickets).filter((ticket) =>
      ticket.executionControl?.proposalRequest !== undefined)).toEqual([]);
    expect(harness.promptCalls).toBe(promptsBeforeRestart);
    client = await AuthorityClient.connect({ projectRoot: fixture.root, client: "tui", version: "1.0.0" });
    await client.request("authority.ping");
    try {
      await client.request("run.resume", { runId }, {
        expectedRevision: client.revision,
        idempotencyKey: "resume-final-change-control-cas",
      });
    } catch (error) {
      const current = await restarted.engine.store.getRun(runId);
      const currentValidation = Object.values(current.actionExecutions ?? {}).find((journal) =>
        journal.boundary.kind === "assignment_validation" && journal.boundary.ticketId === sourceId);
      const currentAttempt = currentValidation?.boundary.attemptId === undefined
        ? undefined
        : current.attempts[currentValidation.boundary.attemptId];
      throw new Error(`resume after abandoned terminal acceptance failed: ${JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        phase: current.lifecycle.phase,
        resumePhase: current.lifecycle.resumePhase,
        attemptStatus: currentAttempt?.status,
        terminalOutputSha256: currentAttempt?.terminalOutputSha256,
        terminalPolicySha256: currentAttempt?.terminalPolicy?.sha256,
        actionSettlement: currentValidation?.settlement,
        actionSettledAt: currentValidation?.settledAt,
        stepStatus: current.tickets[sourceId]?.steps[0]?.status,
        ticketStatus: current.tickets[sourceId]?.status,
      })}`);
    }
    await waitFor(async () => harness.promptCalls === promptsBeforeRestart + 1);
    const resumed = await restarted.engine.store.getRun(runId);
    expect(Object.values(resumed.tickets).filter((ticket) =>
      ticket.executionControl?.proposalRequest !== undefined)).toEqual([]);
    client.close();
  }, 120_000);

  it("lets deletion close an admitted Research validation with zero post-delete work", async () => {
    const reached = deferred<void>();
    const release = deferred<void>();
    const harness = new ScriptHarness(["request"]);
    const fixture = await researchAuthority(harness, {
      actionFault: async (point, input) => {
        if (point !== "before_assignment_settle" || input.ticketId === undefined) return;
        const run = await fixture.engine.store.getRun(input.runId);
        if (run.tickets[input.ticketId]?.operationId !== "formulation.hypothesis.drill-hypothesis") return;
        reached.resolve();
        await release.promise;
      },
    });
    let client = await AuthorityClient.connect({
      projectRoot: fixture.root,
      client: "tui",
      version: "1.0.0",
    });
    const runId = await createApprovedRun(client, fixture.engine, "delete-final-change-control-cas");
    await reached.promise;
    let durableControlHash = "";
    let promptsAtDelete = 0;
    try {
      await authorizeDelete(client, runId, "delete-final-change-control-cas");
      await waitFor(async () => (await fixture.engine.store.getRun(runId)).lifecycle.phase === "deleted");
      const deleted = await fixture.engine.store.getRun(runId);
      durableControlHash = canonicalHash({
        tickets: deleted.tickets,
        attempts: deleted.attempts,
        actions: deleted.actionExecutions,
      });
      promptsAtDelete = harness.promptCalls;
      expect(Object.values(deleted.tickets).filter((ticket) =>
        ticket.executionControl?.proposalRequest !== undefined)).toEqual([]);
      const abandonedValidation = Object.values(deleted.actionExecutions ?? {}).find((journal) =>
        journal.boundary.kind === "assignment_validation");
      expect(abandonedValidation?.settlement).toMatchObject({ disposition: "abandoned" });
      expect(deleted.attempts[abandonedValidation?.boundary.attemptId ?? ""]).toMatchObject({
        terminalOutputSha256: expect.stringMatching(/^sha256:/u),
      });
      expect(deleted.attempts[abandonedValidation?.boundary.attemptId ?? ""]?.terminalPolicy)
        .toBeUndefined();
      expect(Object.values(deleted.attempts).every((attempt) => attempt.status !== "running" &&
        attempt.status !== "terminal_accepted")).toBe(true);
    } catch (error) {
      const current = await fixture.engine.store.getRun(runId);
      throw new Error(`deletion did not settle while assignment validation was gated: ${JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        phase: current.lifecycle.phase,
        attempts: Object.values(current.attempts).map((attempt) => ({
          id: attempt.id,
          status: attempt.status,
        })),
        actions: Object.values(current.actionExecutions ?? {}).map((action) => ({
          invocationId: action.invocationId,
          kind: action.boundary.kind,
          status: action.journal.status,
          settledAt: action.settledAt,
          disposition: action.settlement?.disposition,
        })),
      })}`);
    } finally {
      // A failed assertion must not retain the injected finalizer and hang suite teardown.
      // On success the deleted lifecycle/action tombstone is already durable.
      release.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    const afterRelease = await fixture.engine.store.getRun(runId);
    expect(afterRelease.lifecycle.phase).toBe("deleted");
    expect(canonicalHash({
      tickets: afterRelease.tickets,
      attempts: afterRelease.attempts,
      actions: afterRelease.actionExecutions,
    })).toBe(durableControlHash);
    expect(harness.promptCalls).toBe(promptsAtDelete);

    client.close();
    await stopEngine(fixture.engine);
    const restarted = await openResearchEngine(fixture.root, fixture.baseline, harness);
    const recovered = await restarted.engine.store.getRun(runId);
    expect(recovered.lifecycle.phase).toBe("deleted");
    expect(canonicalHash({
      tickets: recovered.tickets,
      attempts: recovered.attempts,
      actions: recovered.actionExecutions,
    })).toBe(durableControlHash);
    expect(harness.promptCalls).toBe(promptsAtDelete);
  }, 120_000);
});

interface AttemptInput {
  kind: "planning" | "lead" | "ticket" | "verification" | "integration";
  run: RunRecord;
  assignment?: { ticketId: string; stepId: string };
}

class ScriptHarness {
  public promptCalls = 0;
  public readonly trace: Array<Record<string, unknown>> = [];
  public readonly proposalProjectionTrace: Array<Record<string, unknown>> = [];
  public readonly compilationTrace: Array<Record<string, unknown>> = [];
  public readonly materializationTrace: Array<Record<string, unknown>> = [];
  readonly #sourceAttempts = new Map<string, number>();
  readonly #proposalSelections = new Map<string, "no-op" | "apply-change-request">();
  readonly #resolverAttempts = new Map<string, number>();

  public constructor(
    private readonly sourcePlan: readonly ("request" | "fail" | "complete")[] = ["request"],
    private readonly proposalPlan: readonly ("no-op" | "apply-change-request")[] = [],
    private readonly resolverFailures = 0,
  ) {}

  public factory(
    input: AttemptInput,
    prepared: PreparedManagedAttempt,
  ): ManagedPiSessionFactory {
    return async (spec, options) => new ScriptedAdapter(spec, options.tools, () => {
      this.promptCalls += 1;
      const output = this.output(input, prepared);
      this.trace.push({
        kind: input.kind,
        ticketId: input.assignment?.ticketId,
        stepId: input.assignment?.stepId,
        operationId: input.assignment === undefined
          ? undefined
          : input.run.tickets[input.assignment.ticketId]?.operationId,
        workflowId: input.assignment === undefined
          ? undefined
          : input.run.tickets[input.assignment.ticketId]?.executionPolicyBinding?.workflowId,
        personaId: input.assignment === undefined
          ? undefined
          : input.run.tickets[input.assignment.ticketId]?.steps.find((step) =>
            step.id === input.assignment?.stepId)?.personaId,
        targetNodeIds: input.assignment === undefined
          ? undefined
          : input.run.tickets[input.assignment.ticketId]?.targetNodeIds,
        configuredChecks: prepared.authorityGrant?.configuredChecks ?? null,
        output,
        schemaAccepted: output === undefined || prepared.terminalOutputSchema === undefined
          ? undefined
          : Value.Check(prepared.terminalOutputSchema, output),
      });
      if (output !== undefined && prepared.terminalOutputSchema !== undefined &&
          !Value.Check(prepared.terminalOutputSchema, output)) {
        throw new Error(`script emitted output outside ${input.kind}/${input.assignment?.ticketId ?? "run"}/${input.assignment?.stepId ?? "run"} schema`);
      }
      return output;
    });
  }

  private output(input: AttemptInput, prepared: PreparedManagedAttempt): unknown | undefined {
    if (input.kind === "lead") {
      return {
        protocol: "koni.lead-judgment-output.v1",
        disposition: "proceed",
        summary: "The approved Research graph is ready for deterministic scheduling.",
      };
    }
    const ticketId = input.assignment?.ticketId;
    const stepId = input.assignment?.stepId;
    if (ticketId === undefined || stepId === undefined) return undefined;
    const ticket = input.run.tickets[ticketId];
    if (ticket?.operationId === "formulation.hypothesis.drill-hypothesis" && stepId === "drill-claims") {
      const ordinal = (this.#sourceAttempts.get(ticketId) ?? 0) + 1;
      this.#sourceAttempts.set(ticketId, ordinal);
      const action = this.sourcePlan[ordinal - 1];
      if (action === undefined) return undefined;
      if (action === "fail") {
        return { status: "failed", blocker: `Bounded source failure ${ordinal}` };
      }
      if (action === "request") {
        return {
          status: "completed",
          summary: `The hypothesis requires bounded upstream semantic correction ${ordinal}`,
          upstreamChangeRequest: {
            targetNodeIds: [ticket.targetNodeIds[0]],
            summary: `Correct bounded hypothesis contract ${ordinal}`,
            reason: `Verified constraint ${ordinal} is not represented by the current formulation`,
          },
        };
      }
      return this.validCompletedOutput(input, prepared, `Completed source cycle ${ordinal}`);
    }
    if (ticket?.operationId === "lifecycle.change-request" && stepId === "propose-graph-delta") {
      let selection = this.#proposalSelections.get(ticket.id);
      if (selection === undefined) {
        selection = this.proposalPlan[this.#proposalSelections.size];
        if (selection === undefined) return undefined;
        this.#proposalSelections.set(ticket.id, selection);
      }
      return {
        status: "completed",
        summary: `Selected reviewed ${selection} disposition`,
        changeApplication: {
          operation: selection,
          targetNodeIds: [...ticket.targetNodeIds],
          summary: `Apply only the exact reviewed ${selection} disposition`,
        },
      };
    }
    if (ticket?.operationId === "lifecycle.resolve-conflict") {
      const key = `${ticket.id}/${stepId}`;
      const ordinal = (this.#resolverAttempts.get(key) ?? 0) + 1;
      this.#resolverAttempts.set(key, ordinal);
      if (stepId === "diagnose" && ordinal <= this.resolverFailures) {
        return { status: "failed", blocker: `Resolver failure ${ordinal} requires operator retry` };
      }
    }
    return this.validCompletedOutput(input, prepared, `Completed ${ticket?.operationId ?? ticketId}/${stepId}`);
  }

  private validCompletedOutput(
    input: AttemptInput,
    prepared: PreparedManagedAttempt,
    summary: string,
  ): unknown | undefined {
    const candidates: unknown[] = [
      { status: "completed", summary },
      {
        status: "completed",
        summary,
        graphDelta: {
          protocol: "koni.graph-delta.v1",
          expectedGraphHash: input.run.graphHash,
          upsertNodes: [],
          deleteNodes: [],
          addEdges: [],
          removeEdges: [],
        },
      },
    ];
    return candidates.find((candidate) => prepared.terminalOutputSchema !== undefined &&
      Value.Check(prepared.terminalOutputSchema, candidate));
  }
}

class ScriptedAdapter implements PiSessionAdapter {
  public readonly sessionId: string;
  public readonly sessionFile: string;
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();
  readonly #drain = deferred<void>();
  readonly #abort = new AbortController();

  public constructor(
    private readonly spec: Readonly<AgentLaunchSpec>,
    private readonly tools: readonly AuthorityBackedTool[],
    private readonly nextOutput: () => unknown | undefined,
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
    const output = this.nextOutput();
    if (output === undefined) {
      await this.#drain.promise;
      return;
    }
    if (output === null || typeof output !== "object" || Array.isArray(output)) {
      throw new Error("scripted terminal output must be an object");
    }
    const terminal = this.tools.find((tool) => tool.name === this.spec.terminal.toolName);
    if (terminal === undefined) throw new Error(`missing terminal tool ${this.spec.terminal.toolName}`);
    const toolCallId = `terminal-${this.spec.identity.attemptId}`;
    this.emit({
      type: "tool_execution_start",
      toolCallId,
      toolName: this.spec.terminal.toolName,
      args: output,
    } as AgentSessionEvent);
    const result = await terminal.execute(
      toolCallId,
      output as Record<string, unknown>,
      this.#abort.signal,
    );
    this.emit({
      type: "tool_execution_end",
      toolCallId,
      toolName: this.spec.terminal.toolName,
      result,
      isError: false,
    } as AgentSessionEvent);
  }
  public async continue(): Promise<void> { await this.prompt(); }
  public async steer(): Promise<void> {}
  public async followUp(): Promise<void> {}
  public async abort(): Promise<void> {
    this.#abort.abort();
    this.#drain.resolve();
  }
  public dispose(): void {
    this.#abort.abort();
    this.#drain.resolve();
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

async function researchAuthority(
  harness = new ScriptHarness(),
  options: {
    git?: (root: string) => IsolatedGitLifecycle;
    actionFault?: RunAuthorityEngineOptions["actionFault"];
  } = {},
): Promise<{
  root: string;
  baseline: VerifiedProfileBaseline;
  native: NativeRunCompilerProgram;
  program: RunCompilerProgram;
  harness: ScriptHarness;
  engine: RunAuthorityEngine;
}> {
  const root = await repository();
  const baseline = await loadProfilePackage(researchProfile);
  await installProfile(root, researchProfile);
  return openResearchEngine(root, baseline, harness, {
    ...(options.git === undefined ? {} : { git: options.git(root) }),
    ...(options.actionFault === undefined ? {} : { actionFault: options.actionFault }),
  });
}

async function openResearchEngine(
  root: string,
  baseline: VerifiedProfileBaseline,
  harness: ScriptHarness,
  options: {
    git?: IsolatedGitLifecycle;
    actionFault?: RunAuthorityEngineOptions["actionFault"];
  } = {},
): Promise<{
  root: string;
  baseline: VerifiedProfileBaseline;
  native: NativeRunCompilerProgram;
  program: RunCompilerProgram;
  harness: ScriptHarness;
  engine: RunAuthorityEngine;
}> {
  const native = await NativeRunCompilerProgram.create({
    projectRoot: root,
    packageBaseline: baseline,
    installedPiPackagesLoader: async () => [],
    sealedModelBindingLoader: async (provider, modelId) => ({
      provider,
      id: modelId,
      api: "openai-codex-responses",
      catalogContextWindow: 372_000,
      catalogMaxTokens: 128_000,
      catalogSha256: canonicalHash({ provider, modelId, fixture: "provider-free" }),
    }),
  });
  const program = scriptNativeProgram(native, harness);
  const engine = await RunAuthorityEngine.open({
    projectRoot: root,
    version: "1.0.0",
    program,
    supervisor: new ManagedSessionSupervisor(),
    profilePackageRootLoader: async () => researchProfile,
    ...(options.git === undefined ? {} : { git: options.git }),
    ...(options.actionFault === undefined ? {} : { actionFault: options.actionFault }),
  });
  engines.push(engine);
  await engine.start();
  return { root, baseline, native, program, harness, engine };
}

async function stopEngine(engine: RunAuthorityEngine): Promise<void> {
  const index = engines.indexOf(engine);
  if (index >= 0) engines.splice(index, 1);
  await engine.stop();
}

function nextFixtureRun(run: Readonly<RunRecord>): RunRecord {
  const draft = structuredClone(run) as RunRecord;
  draft.revision += 1;
  draft.updatedAt = new Date(Date.parse(run.updatedAt) + 1).toISOString();
  return draft;
}

async function createApprovedRun(
  client: AuthorityClient,
  engine: RunAuthorityEngine,
  label: string,
): Promise<string> {
  const objective = `Test ${label} with bounded factual recall`;
  const created = await client.request("run.create", {
    objective,
    runTypeId: "small",
    targetRef: "refs/heads/main",
    intake: { goal: objective },
  }, { expectedRevision: client.revision, idempotencyKey: `create-${label}` });
  const runId = (created.result as { runId: string }).runId;
  await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval");
  await client.request("authority.ping");
  await client.request("plan.approve", { runId }, {
    expectedRevision: client.revision,
    idempotencyKey: `approve-${label}`,
  });
  return runId;
}

async function nextProposal(
  engine: RunAuthorityEngine,
  runId: string,
  excluded: ReadonlySet<string>,
  harness?: ScriptHarness,
): Promise<{ run: RunRecord; proposal: RunRecord["tickets"][string] }> {
  return waitForValue(async () => {
    const run = await engine.store.getRun(runId);
    if (run.lifecycle.phase === "blocked" || run.lifecycle.phase === "failed") {
      const terminalOutputs = Object.fromEntries(await Promise.all(
        Object.values(run.attempts)
          .filter((attempt) => attempt.terminalOutputSha256 !== undefined)
          .map(async (attempt) => {
            const bytes = await engine.store.readArtifact(
              `runs/${run.id}/attempts/${attempt.id}/terminal-output.json`,
              16 * 1024 * 1024,
            );
            return [attempt.id, JSON.parse(bytes.toString("utf8"))] as const;
          }),
      ));
      throw new Error(`run stopped before the next proposal: ${JSON.stringify({
        phase: run.lifecycle.phase,
        blocker: run.lifecycle.blocker,
        terminalReason: run.lifecycle.terminalReason,
        revision: run.revision,
        tickets: Object.values(run.tickets).map((ticket) => ({
          id: ticket.id,
          operationId: ticket.operationId,
          status: ticket.status,
          blocker: ticket.blocker,
          steps: ticket.steps.map((step) => ({ id: step.id, status: step.status })),
        })),
        attempts: Object.values(run.attempts).map((attempt) => ({
          id: attempt.id,
          kind: attempt.kind,
          ticketId: attempt.ticketId,
          stepId: attempt.stepId,
          status: attempt.status,
          terminalOutputSha256: attempt.terminalOutputSha256,
        })),
        actions: Object.values(run.actionExecutions ?? {}).map((action) => ({
          invocationId: action.invocationId,
          kind: action.boundary.kind,
          ticketId: action.boundary.ticketId,
          stepId: action.boundary.stepId,
          attemptId: action.boundary.attemptId,
          expectedRunRevision: action.expectedRunRevision,
          journalStatus: action.journal.status,
          journalSteps: action.journal.steps.map((step) => ({
            id: step.stepId,
            primitive: step.primitive,
            status: step.status,
            ...(step.status === "failed" ? { error: step.error } : {}),
          })),
          semanticResult: action.semanticResult,
          semanticResultSha256: action.semanticResult === undefined
            ? undefined
            : canonicalHash(action.semanticResult),
          settlement: action.settlement?.disposition,
        })),
        terminalOutputs,
        compilationTrace: harness?.compilationTrace,
        materializationTrace: harness?.materializationTrace,
        activity: run.activity.slice(-12).map((entry) => entry.message),
      })}`);
    }
    const proposal = Object.values(run.tickets)
      .filter((ticket) => ticket.executionControl?.proposalRequest !== undefined && !excluded.has(ticket.id))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];
    return proposal?.status === "proposed" ? { run, proposal } : undefined;
  });
}

async function decideProposal(
  client: AuthorityClient,
  runId: string,
  ticketId: string,
  decision: "approval" | "rejection",
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await client.request("authority.ping");
    try {
      await client.request("proposal.decide", { runId, ticketId, decision, message }, {
        expectedRevision: client.revision,
        idempotencyKey: `${decision}-${ticketId}`,
      });
      return;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "revision_conflict") throw error;
    }
  }
  throw new Error(`proposal decision never acquired a stable authority revision: ${ticketId}`);
}

async function pauseAtFreshRevision(
  client: AuthorityClient,
  engine: RunAuthorityEngine,
  runId: string,
  idempotencyKey: string,
): Promise<void> {
  if ((await engine.store.getRun(runId)).lifecycle.phase === "paused") return;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await client.request("authority.ping");
    try {
      await client.request("run.pause", { runId }, {
        expectedRevision: client.revision,
        idempotencyKey,
      });
      await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "paused");
      return;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "revision_conflict") throw error;
    }
  }
  throw new Error(`pause never acquired a stable authority revision: ${runId}`);
}

async function authorizeDelete(
  client: AuthorityClient,
  runId: string,
  idempotencyKey: string,
): Promise<void> {
  await client.request("authority.ping");
  const inspected = await client.request("run.deletion.inspect", { runId });
  const previewToken = (inspected.result as { previewToken: string }).previewToken;
  await client.request("run.delete", {
    runId,
    mode: "preserve_branches",
    previewToken,
  }, { expectedRevision: client.revision, idempotencyKey });
}

function scriptNativeProgram(
  native: NativeRunCompilerProgram,
  harness: ScriptHarness,
): RunCompilerProgram {
  return new Proxy(native, {
    get(target, property) {
      if (property === "prepareAttempt") {
        return async (input: AttemptInput) => {
          const prepared = await target.prepareAttempt(input as Parameters<NativeRunCompilerProgram["prepareAttempt"]>[0]);
          return { ...prepared, factory: harness.factory(input, prepared) };
        };
      }
      if (property === "recoverAttempt") {
        return async (input: Parameters<NativeRunCompilerProgram["recoverAttempt"]>[0]) => {
          const prepared = await target.recoverAttempt(input);
          const attemptInput: AttemptInput = {
            kind: input.attempt.kind ?? "ticket",
            run: input.run,
            ...(input.attempt.ticketId in input.run.tickets
              ? { assignment: { ticketId: input.attempt.ticketId, stepId: input.attempt.stepId } }
              : {}),
          };
          return { ...prepared, factory: harness.factory(attemptInput, prepared) };
        };
      }
      if (property === "projectChangeControlProposalTicket") {
        return async (input: Parameters<NativeRunCompilerProgram["projectChangeControlProposalTicket"]>[0]) => {
          const proposal = await target.projectChangeControlProposalTicket(input);
          const source = input.run.tickets[input.changeControl.sourceTicketId];
          const sourceStep = source?.steps.find((step) => step.id === input.changeControl.sourceStepId);
          const authority = proposal.executionControl?.controlTicketAuthority;
          const causal = authority?.causal;
          if (source !== undefined && authority?.role === "proposal" && causal?.role === "proposal") {
            const projection = ticketImmutableProjection(proposal);
            const sourceProjection = ticketImmutableProjection(source);
            const publication = causal.publication;
            const requestSha256 = canonicalHash({
              runId: publication.runId,
              sourceTicketId: publication.sourceTicketId,
              sourceStepId: publication.sourceStepId,
              sourceOutputSha256: publication.sourceOutputSha256,
              sourceBindingSha256: publication.sourceBinding.sha256,
              targetNodeIds: publication.targetNodeIds,
              summary: publication.summary,
              reason: publication.reason,
              configurationSha256: publication.configurationSha256,
              catalogSha256: publication.catalogSha256,
            });
            harness.proposalProjectionTrace.push({
              proposalId: proposal.id,
              sourceId: source.id,
              roles: [authority.role, causal.role, authority.operation.changeControl.role],
              sourceProjectionMatches: canonicalHash(sourceProjection) ===
                canonicalHash(causal.sourceTicketProjection),
              sourceStepBindingMatches: sourceStep?.executionPolicyBinding?.sha256 ===
                publication.sourceBinding.sha256,
              runMatches: publication.runId === input.run.id,
              proposalMatches: publication.proposalTicketId === proposal.id,
              configurationMatches: publication.configurationSha256 === authority.configurationSha256,
              catalogMatches: publication.catalogSha256 === authority.catalogSha256,
              requestMatches: publication.requestSha256 === requestSha256,
              operationMatches: publication.proposalOperationId === authority.operation.id,
              proposalBindingMatches: publication.proposalBinding.sha256 ===
                proposal.executionPolicyBinding?.sha256,
              sourceOperationMatches: publication.sourceOperation.sha256 ===
                publication.sourceBinding.operationSha256,
              sourceCompilationMatches: causal.sourceTerminalProof.semanticResult.changeControlSha256 ===
                input.changeControl.sha256,
              proofIndexed: canonicalHash(input.run.terminalSuccessProofs?.[causal.sourceTerminalProof.sha256] ?? null) ===
                canonicalHash(causal.sourceTerminalProof),
              proofAttemptStatus: input.run.attempts[causal.sourceTerminalProof.attemptId]?.status,
              proofAttemptPolicyMatches: input.run.attempts[causal.sourceTerminalProof.attemptId]
                ?.terminalPolicy?.sha256 === causal.sourceTerminalProof.terminalPolicySha256,
              proofAttemptOutputMatches: input.run.attempts[causal.sourceTerminalProof.attemptId]
                ?.terminalOutputSha256 === causal.sourceTerminalProof.terminalOutputSha256,
              holdMatches: causal.sourceHold.proposalTicketId === proposal.id &&
                causal.sourceHold.requestSha256 === publication.requestSha256,
              summaryMatches: projection.summary === `${publication.summary}\n\nReason: ${publication.reason}`,
              title: projection.title,
              expectedTitle: `Change request: ${publication.summary.trim().split(/\r?\n/u)[0] ?? publication.summary.trim()}`.slice(0, 240),
              targetMatches: canonicalHash(projection.targetNodeIds) === canonicalHash(publication.targetNodeIds),
              readMatches: canonicalHash(projection.readNodeIds) === canonicalHash(publication.targetNodeIds),
              writeNodeCount: projection.writeNodeIds.length,
              readPathCount: projection.readPaths.length,
              writePathCount: projection.writePaths.length,
              controlScopeMatches: canonicalHash(projection.control.role === "proposal"
                ? projection.control.changeControlScopeNodeIds
                : []) === canonicalHash(publication.controlScopeNodeIds),
              dependencyCount: projection.dependencyIds.length,
            });
          }
          return proposal;
        };
      }
      if (property === "projectApprovedApplicationTicket") {
        return async (input: Parameters<NativeRunCompilerProgram["projectApprovedApplicationTicket"]>[0]) => {
          const materialization = input.materialization;
          const selectionMaterial = {
            protocol: "koni.assignment-change-control.v1" as const,
            kind: "proposal_application" as const,
            configurationSha256: materialization.configurationSha256,
            catalogSha256: materialization.catalogSha256,
            proposalBindingSha256: materialization.proposalBinding.sha256,
            applicationBinding: materialization.applicationBinding,
            proposalOutputSha256: materialization.proposalOutputSha256,
            proposalTicketId: materialization.proposalTicketId,
            proposalStepId: materialization.proposalStepId,
            applicationPublicOperation: materialization.applicationPublicOperation,
            applicationOperationId: materialization.applicationOperation.id,
            targetNodeIds: materialization.targetNodeIds,
            summary: materialization.selectionSummary,
            scope: materialization.scope,
          };
          const reviewAttempt = input.run.attempts[materialization.reviewTerminalProof.attemptId];
          const expectedReviewSha256 = reviewAttempt?.terminalAcceptedAt === undefined ||
              reviewAttempt.terminalPolicy === undefined ||
              reviewAttempt.terminalOutputSha256 === undefined
            ? undefined
            : canonicalHash({
                protocol: "koni.proposal-review-authority.v1",
                attemptId: reviewAttempt.id,
                launchSpecHash: reviewAttempt.launchSpecHash,
                approvalSha256: materialization.approvalSha256,
                terminalPolicySha256: reviewAttempt.terminalPolicy.sha256,
                terminalOutputSha256: reviewAttempt.terminalOutputSha256,
                terminalAcceptedAt: reviewAttempt.terminalAcceptedAt,
              });
          harness.materializationTrace.push({
            proposalTicketId: materialization.proposalTicketId,
            selectionSha256: input.selection.sha256,
            reconstructedSelectionSha256: canonicalHash(selectionMaterial),
            selection: structuredClone(input.selection),
            reconstructedSelection: structuredClone(selectionMaterial),
            proposalProofChangeControlSha256:
              materialization.proposalTerminalProof.semanticResult.changeControlSha256,
            materializationReviewSha256: materialization.reviewSha256,
            expectedReviewSha256,
            reviewAttemptStatus: reviewAttempt?.status,
          });
          return target.projectApprovedApplicationTicket(input);
        };
      }
      if (property === "compileAssignmentOutput") {
        return async (input: Parameters<NativeRunCompilerProgram["compileAssignmentOutput"]>[0]) => {
          const trace: Record<string, unknown> = {
            attemptId: input.attemptId,
            assignment: structuredClone(input.assignment),
            output: structuredClone(input.output),
          };
          harness.compilationTrace.push(trace);
          try {
            const compiled = await target.compileAssignmentOutput(input);
            trace.outcome = structuredClone(compiled.outcome);
            trace.changeControlSha256 = compiled.changeControl?.sha256;
            return compiled;
          } catch (error) {
            trace.error = error instanceof Error ? error.message : String(error);
            throw error;
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as RunCompilerProgram;
}

type ApprovedMaterialization = NonNullable<TicketExecutionControlRecord["approvedMaterialization"]>;
type MutableApprovedMaterialization = Omit<ApprovedMaterialization,
  "reviewSha256" | "reviewTerminalProof" | "applicationBinding" | "authoritySha256" | "sha256"> & {
    reviewSha256: Sha256Digest;
    reviewTerminalProof: ApprovedMaterialization["reviewTerminalProof"];
    applicationBinding: ApprovedMaterialization["applicationBinding"];
    authoritySha256: Sha256Digest;
    sha256: Sha256Digest;
  };
type ResolverRetryRequest = NonNullable<
  TicketExecutionControlRecord["terminalResolverRetryRequests"]
>[number];

/** Attacker recomputes every local hash but reuses selection authority as review authority. */
function forgeMaterializationWithOneProof(run: Readonly<RunRecord>, proposalTicketId: string): RunRecord {
  const forged = structuredClone(run);
  const control = forged.tickets[proposalTicketId]?.executionControl;
  if (control?.approvedMaterialization === undefined) throw new Error("fixture has no reviewed materialization");
  const materialization = control.approvedMaterialization as unknown as MutableApprovedMaterialization;
  materialization.reviewTerminalProof = structuredClone(materialization.proposalTerminalProof);
  const attempt = forged.attempts[materialization.reviewTerminalProof.attemptId];
  if (attempt?.launchSpecHash === undefined || attempt.terminalPolicy === undefined ||
      attempt.terminalOutputSha256 === undefined || attempt.terminalAcceptedAt === undefined) {
    throw new Error("fixture proposal proof has no complete accepted attempt");
  }
  materialization.reviewSha256 = canonicalHash({
    protocol: "koni.proposal-review-authority.v1",
    attemptId: attempt.id,
    launchSpecHash: attempt.launchSpecHash,
    approvalSha256: materialization.approvalSha256,
    terminalPolicySha256: attempt.terminalPolicy.sha256,
    terminalOutputSha256: attempt.terminalOutputSha256,
    terminalAcceptedAt: attempt.terminalAcceptedAt,
  });
  rehashApprovedMaterialization(materialization);
  control.approvedApplicationSha256 = materialization.authoritySha256;
  if (control.proposalDisposition !== undefined) {
    control.proposalDisposition.authoritySha256 = materialization.authoritySha256;
  }
  return forged;
}

/** Attacker self-rehashes a Pi binding that no longer names the embedded application operation. */
function forgeMaterializationBindingIdentity(run: Readonly<RunRecord>, proposalTicketId: string): RunRecord {
  const forged = structuredClone(run);
  const control = forged.tickets[proposalTicketId]?.executionControl;
  if (control?.approvedMaterialization === undefined) throw new Error("fixture has no reviewed materialization");
  const materialization = control.approvedMaterialization as unknown as MutableApprovedMaterialization;
  const binding = materialization.applicationBinding as unknown as Record<string, unknown>;
  binding.operationId = materialization.proposalOperation.id;
  const { sha256: _ignored, ...bindingMaterial } = binding;
  binding.sha256 = canonicalHash(bindingMaterial);
  rehashApprovedMaterialization(materialization);
  return forged;
}

function rehashApprovedMaterialization(materialization: MutableApprovedMaterialization): void {
  materialization.authoritySha256 = canonicalHash({
    runId: materialization.runId,
    proposalTicketId: materialization.proposalTicketId,
    proposalBindingSha256: materialization.proposalBinding.sha256,
    requestSha256: materialization.requestSha256,
    approvalSha256: materialization.approvalSha256,
    proposalOutputSha256: materialization.proposalOutputSha256,
    proposalStepId: materialization.proposalStepId,
    proposalSelectionSha256: materialization.proposalSelectionSha256,
    selectionSummary: materialization.selectionSummary,
    reviewSha256: materialization.reviewSha256,
    proposalTerminalProofSha256: materialization.proposalTerminalProof.sha256,
    reviewTerminalProofSha256: materialization.reviewTerminalProof.sha256,
    applicationOperationId: materialization.applicationOperation.id,
    targetNodeIds: materialization.targetNodeIds,
    scope: materialization.scope,
    configurationSha256: materialization.configurationSha256,
    catalogSha256: materialization.catalogSha256,
  });
  const { sha256: _ignored, ...material } = materialization;
  materialization.sha256 = canonicalHash(material);
}

/**
 * Attacker deletes the live completed action, relabels its accepted attempt as semantic failure,
 * and appends a fully self-hashed retry after terminal resolver success.
 */
function forgeRetryFromSuccessfulResolver(run: Readonly<RunRecord>, resolverTicketId: string): RunRecord {
  const forged = structuredClone(run);
  const resolver = forged.tickets[resolverTicketId];
  const control = resolver?.executionControl;
  const recovery = control?.terminalRecovery;
  const success = control?.terminalResolverTerminalProof;
  if (resolver === undefined || control === undefined || recovery === undefined || success === undefined ||
      resolver.executionPolicyBinding === undefined) {
    throw new Error("fixture resolver has no complete terminal authority");
  }
  const step = resolver.steps.find((candidate) => candidate.id === success.stepId);
  const attempt = forged.attempts[success.attemptId];
  if (step?.executionPolicyBinding === undefined || attempt?.launchSpecHash === undefined ||
      attempt.terminalPolicy === undefined || attempt.terminalOutputSha256 === undefined) {
    throw new Error("fixture resolver success has no complete attempt binding");
  }
  const semanticResult = {
    kind: "assignment" as const,
    status: "failed" as const,
    blocker: "Attacker relabeled a successful resolver attempt as failure",
  };
  const failureMaterial = {
    protocol: "koni.terminal-failure-settlement.v1" as const,
    runId: success.runId,
    ticketId: success.ticketId,
    stepId: success.stepId,
    attemptId: success.attemptId,
    actionInvocationId: success.actionInvocationId,
    actionPlanSha256: success.actionPlanSha256,
    actionSettlementSha256: success.actionSettlementSha256,
    semanticResult,
    semanticResultSha256: canonicalHash(semanticResult),
    terminalPolicySha256: success.terminalPolicySha256,
    terminalOutputSha256: success.terminalOutputSha256,
  };
  const failureProof: TerminalFailureSettlementProof = {
    ...failureMaterial,
    sha256: canonicalHash(failureMaterial),
  };
  delete forged.actionExecutions?.[success.actionInvocationId];
  Object.assign(forged, {
    terminalFailureProofs: {
      ...(forged.terminalFailureProofs ?? {}),
      [failureProof.sha256]: failureProof,
    },
  });

  const failureBindingMaterial = {
    protocol: "koni.terminal-failure-binding.v1",
    runId: forged.id,
    ticketId: resolver.id,
    ticketBindingSha256: resolver.executionPolicyBinding.sha256,
    stepId: step.id,
    stepBindingSha256: step.executionPolicyBinding.sha256,
    attemptId: attempt.id,
    launchSpecHash: attempt.launchSpecHash,
    terminalPolicySha256: attempt.terminalPolicy.sha256,
    terminalOutputSha256: attempt.terminalOutputSha256,
  };
  const prior = control.terminalResolverRetryRequests ?? [];
  const retryMaterial = {
    protocol: "koni.terminal-resolver-retry.v1" as const,
    ordinal: prior.length + 1,
    eventId: `forged-retry-${prior.length + 1}`,
    actor: "operator" as const,
    message: "Attacker requested retry from a relabeled successful attempt",
    recordedAt: "2026-07-18T23:59:59.000Z",
    runId: forged.id,
    resolverTicketId: resolver.id,
    sourceTicketId: recovery.sourceTicketId,
    sourceFailureBindingSha256: recovery.failureBindingSha256s[0]!,
    resolverFailureBindingSha256: canonicalHash(failureBindingMaterial),
    failureSettlementSha256: failureProof.sha256,
    failureProof,
    failedAttemptId: attempt.id,
    launchSpecHash: attempt.launchSpecHash,
    terminalPolicySha256: attempt.terminalPolicy.sha256,
    terminalOutputSha256: attempt.terminalOutputSha256,
    configurationSha256: recovery.configurationSha256,
    catalogSha256: recovery.catalogSha256,
    resolverBindingSha256: resolver.executionPolicyBinding.sha256,
  };
  const retry: ResolverRetryRequest = { ...retryMaterial, sha256: canonicalHash(retryMaterial) };
  control.terminalResolverRetryRequests = [...prior, retry];
  return forged;
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-change-control-authority-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "koni@example.invalid");
  await git(root, "config", "user.name", "Koni Test");
  await writeFile(path.join(root, "README.md"), "# Research authority fixture\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "fixture");
  expect(await readFile(path.join(root, "README.md"), "utf8"))
    .toBe("# Research authority fixture\n");
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
  await waitForValue(async () => await predicate() ? true : undefined);
}

async function waitForValue<Value>(
  read: () => Promise<Value | undefined>,
  timeoutMs = 30_000,
): Promise<Value> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for composed authority state");
}

async function waitForDurableProgressValue<Value>(
  read: () => Promise<{ progress: number; value?: Value }>,
  options: {
    idleTimeoutMs?: number;
    hardTimeoutMs?: number;
    pollIntervalMs?: number;
  } = {},
): Promise<Value> {
  const idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
  const hardTimeoutMs = options.hardTimeoutMs ?? 90_000;
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  const hardDeadline = Date.now() + hardTimeoutMs;
  let idleDeadline = Date.now() + idleTimeoutMs;
  let lastProgress: number | undefined;
  while (Date.now() < hardDeadline) {
    const observed = await read();
    if (observed.value !== undefined) return observed.value;
    if (lastProgress === undefined || observed.progress !== lastProgress) {
      lastProgress = observed.progress;
      idleDeadline = Date.now() + idleTimeoutMs;
    }
    const now = Date.now();
    if (now >= idleDeadline) {
      throw new Error(`timed out after ${idleTimeoutMs}ms without durable composed-authority progress`);
    }
    await new Promise((resolve) => setTimeout(
      resolve,
      Math.min(pollIntervalMs, idleDeadline - now, hardDeadline - now),
    ));
  }
  throw new Error(`timed out after ${hardTimeoutMs}ms total composed-authority work`);
}
