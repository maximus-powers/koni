import { describe, expect, it } from "vitest";
import {
  resolveExecutionPolicyBinding,
  type ExecutionPolicyBinding,
} from "../src/authority/execution-policy.js";
import {
  compileExecutionSemanticCatalog,
  type CompiledExecutionSemanticCatalog,
} from "../src/compiler/execution-semantics.js";
import type { CompiledConfiguration } from "../src/contracts/configuration.js";
import { canonicalHash, type Sha256Digest } from "../src/shared/canonical.js";
import {
  ChangeControlAuthorityError,
  deriveApprovedChangeMaterialization,
  deriveChangeControlPublication,
  deriveProposalDecision,
  deriveSourceReleaseDecision,
  deriveTerminalResolverReconciliation,
  deriveTerminalResolverRetryRequest,
  MAX_TERMINAL_RESOLVER_RETRIES,
  type ExistingApplicationChild,
  type ExistingChangeControlProposal,
  type ExistingTerminalResolver,
} from "../src/state/change-control.js";
import { newRunLifecycle, reduceRunLifecycle } from "../src/state/run-lifecycle.js";
import type {
  RunRecord,
  TerminalSuccessSettlementProof,
  TicketRecord,
  TicketStatus,
} from "../src/state/run-record.js";
import {
  deriveReadyAssignments,
  SchedulerAuthorityError,
  ticketDependencySettled,
  type SchedulerExecutionAuthority,
  type SchedulerTicketExecutionAuthority,
} from "../src/state/scheduler.js";
import { fixtureRunGit } from "./run-record-fixtures.js";

describe("semantic scheduler admission", () => {
  it("treats compiler-routed cancellations as settled dependencies", () => {
    const run = runRecord(2);
    run.executionConfig!.disjointScopeParallelism = false;
    run.tickets.obsolete = ticket("obsolete", "ordinary-work", "cancelled", 0, ["claim-a"]);
    run.tickets.obsolete.blocker =
      "Current compiler predicate no longer applies after prior execution";
    run.tickets.consumer = ticket("consumer", "ordinary-work", "queued", 1, ["claim-b"]);
    run.tickets.consumer.dependencyIds = ["obsolete"];

    expect(deriveReadyAssignments(run, 2).ready.map((row) => row.ticketId)).toEqual(["consumer"]);
    expect(ticketDependencySettled(run.tickets.obsolete)).toBe(true);

    for (const blocker of [
      "Superseded before execution by newer compiler state",
      "Superseded by the existing planned asset implementation workflow",
      "Superseded by a current manifest-bound gate recheck",
    ]) {
      run.tickets.obsolete.blocker = blocker;
      expect(ticketDependencySettled(run.tickets.obsolete)).toBe(true);
    }

    run.tickets.obsolete.blocker = "Cancelled by operator";
    expect(deriveReadyAssignments(run, 2).ready).toEqual([]);
    expect(ticketDependencySettled(run.tickets.obsolete)).toBe(false);
  });

  it("never schedules proposed work and blocks only overlapping barrier operations", () => {
    const catalog = buildCatalog();
    const run = runRecord(3);
    run.executionConfig!.disjointScopeParallelism = false;
    run.tickets.proposal = ticket("proposal", "propose-change", "proposed", 0, ["claim-a"]);
    run.tickets.overlap = ticket("overlap", "ordinary-work", "queued", 1, ["claim-a"]);
    run.tickets.unrelated = ticket("unrelated", "ordinary-work", "queued", 2, ["claim-b"]);
    const authority = executionAuthority(catalog, {
      proposal: {
        binding: bind(catalog, "proposal"),
        changeControlScopeNodeIds: ["claim-a"],
      },
      overlap: { binding: bind(catalog, "ordinary") },
      unrelated: { binding: bind(catalog, "ordinary") },
    });

    const projection = deriveReadyAssignments(run, 3, authority);
    expect(projection.ready.map((row) => row.ticketId)).toEqual(["unrelated"]);
    expect(projection.policyConflicts).toMatchObject([
      {
        ticketId: "overlap",
        conflictsWithTicketId: "proposal",
        reason: "change_control_barrier",
        overlapNodeIds: ["claim-a"],
      },
    ]);
    expect(projection.ready.some((row) => row.ticketId === "proposal")).toBe(false);
  });

  it("does not let awaiting approval take a single-flight lease", () => {
    const catalog = buildCatalog();
    const run = runRecord(2);
    run.executionConfig!.disjointScopeParallelism = false;
    run.tickets.pending = ticket("pending", "propose-change", "proposed", 0, ["claim-a"]);
    run.tickets.approved = ticket("approved", "propose-change", "queued", 1, ["claim-b"]);
    const authority = executionAuthority(catalog, {
      pending: {
        binding: bind(catalog, "proposal"),
        changeControlScopeNodeIds: ["claim-a"],
      },
      approved: {
        binding: bind(catalog, "proposal"),
        changeControlScopeNodeIds: ["claim-b"],
        proposalApprovalSha256: digest("approval"),
      },
    });

    expect(deriveReadyAssignments(run, 2, authority).ready.map((row) => row.ticketId)).toEqual([
      "approved",
    ]);
  });

  it("reserves single-flight authority within one deterministic batch and across restart", () => {
    const catalog = buildCatalog();
    const run = runRecord(2);
    run.executionConfig!.disjointScopeParallelism = false;
    run.tickets.first = ticket("first", "ordinary-work", "queued", 0, ["claim-a"]);
    run.tickets.second = ticket("second", "ordinary-work", "queued", 1, ["claim-b"]);
    const authority = executionAuthority(catalog, {
      first: { binding: bind(catalog, "ordinary") },
      second: { binding: bind(catalog, "ordinary") },
    });

    const firstProjection = deriveReadyAssignments(run, 2, authority);
    expect(firstProjection.ready.map((row) => row.ticketId)).toEqual(["first"]);
    expect(firstProjection.policyConflicts[0]).toMatchObject({
      ticketId: "second",
      conflictsWithTicketId: "first",
      reason: "single_flight",
    });

    run.tickets.first.status = "queued";
    run.tickets.first.worktreePath = "/tmp/compiler-owned-first";
    run.tickets.first.gitCycleId = "cycle-first";
    const restarted = deriveReadyAssignments(run, 2, authority);
    expect(restarted.ready.map((row) => row.ticketId)).toEqual(["first"]);
    expect(
      restarted.policyConflicts.some(
        (row) => row.ticketId === "second" && row.conflictsWithTicketId === "first",
      ),
    ).toBe(true);
  });

  it("fails closed on missing proposal/application/resolver authority", () => {
    const catalog = buildCatalog();
    const proposed = runRecord(1);
    proposed.tickets.proposal = ticket("proposal", "propose-change", "queued", 0, ["claim-a"]);
    expectSchedulerError(
      () =>
        deriveReadyAssignments(
          proposed,
          1,
          executionAuthority(catalog, {
            proposal: {
              binding: bind(catalog, "proposal"),
              changeControlScopeNodeIds: ["claim-a"],
            },
          }),
        ),
      "scheduler.proposal_approval_missing",
    );

    const application = runRecord(1);
    application.tickets.application = ticket("application", "apply-change", "queued", 0, [
      "claim-a",
    ]);
    expectSchedulerError(
      () =>
        deriveReadyAssignments(
          application,
          1,
          executionAuthority(catalog, {
            application: {
              binding: bind(catalog, "application"),
              changeControlScopeNodeIds: ["claim-a"],
            },
          }),
        ),
      "scheduler.application_authority_missing",
    );

    const resolver = runRecord(1);
    resolver.tickets.resolver = ticket("resolver", "resolve-failure", "queued", -1000, ["claim-a"]);
    expectSchedulerError(
      () =>
        deriveReadyAssignments(
          resolver,
          1,
          executionAuthority(catalog, {
            resolver: { binding: bind(catalog, "resolver") },
          }),
        ),
      "scheduler.terminal_resolver_binding",
    );
  });

  it("admits an application only from its completed exact proposal authority", () => {
    const catalog = buildCatalog();
    const run = runRecord(1);
    run.executionConfig!.disjointScopeParallelism = false;
    run.tickets.proposal = ticket("proposal", "propose-change", "completed", 0, ["claim-a"]);
    run.tickets.application = ticket("application", "apply-change", "queued", 1, ["claim-a"]);
    const approved = digest("approved-application");
    const authority = executionAuthority(catalog, {
      proposal: {
        binding: bind(catalog, "proposal"),
        changeControlScopeNodeIds: ["claim-a"],
        approvedApplicationSha256: approved,
      },
      application: {
        binding: bind(catalog, "application"),
        changeControlScopeNodeIds: ["claim-a"],
        sourceProposalTicketId: "proposal",
        approvedApplicationSha256: approved,
      },
    });
    expect(deriveReadyAssignments(run, 1, authority).ready.map((row) => row.ticketId)).toEqual([
      "application",
    ]);

    expectSchedulerError(
      () =>
        deriveReadyAssignments(
          run,
          1,
          executionAuthority(catalog, {
            ...authority.tickets,
            application: {
              ...authority.tickets.application!,
              approvedApplicationSha256: digest("stale-approval"),
            },
          }),
        ),
      "scheduler.application_source_stale",
    );
  });

  it("admits at most one terminal resolver from its configured single-flight group", () => {
    const catalog = buildCatalog();
    const run = runRecord(3);
    run.executionConfig!.disjointScopeParallelism = false;
    run.tickets["resolver-a"] = ticket("resolver-a", "resolve-failure", "queued", -2_000, [
      "claim-a",
    ]);
    run.tickets["resolver-b"] = ticket("resolver-b", "resolve-failure", "queued", -1_999, [
      "claim-b",
    ]);
    run.tickets["source-a"] = ticket("source-a", "ordinary-work", "blocked", -100, ["claim-a"]);
    run.tickets["source-b"] = ticket("source-b", "ordinary-work", "blocked", -99, ["claim-b"]);
    run.tickets.ordinary = ticket("ordinary", "ordinary-work", "queued", 0, ["claim-c"]);
    const authority = executionAuthority(catalog, {
      "resolver-a": {
        binding: bind(catalog, "resolver"),
        terminalRecovery: {
          sourceTicketId: "source-a",
          failureBindingSha256s: [digest("failure-a")],
        },
      },
      "resolver-b": {
        binding: bind(catalog, "resolver"),
        terminalRecovery: {
          sourceTicketId: "source-b",
          failureBindingSha256s: [digest("failure-b")],
        },
      },
      "source-a": { binding: bind(catalog, "ordinary") },
      "source-b": { binding: bind(catalog, "ordinary") },
      ordinary: { binding: bind(catalog, "ordinary") },
    });
    const projection = deriveReadyAssignments(run, 3, authority);
    expect(projection.ready.map((row) => row.ticketId)).toEqual(["resolver-a", "ordinary"]);
    expect(projection.policyConflicts).toMatchObject([
      {
        ticketId: "resolver-b",
        conflictsWithTicketId: "resolver-a",
        reason: "single_flight",
      },
    ]);
  });
});

describe("deterministic change-control reconciliation", () => {
  it("creates proposal-first state, reuses exact replay, and rejects collisions", () => {
    const catalog = buildCatalog();
    const sourceBinding = bind(catalog, "ordinary", "work");
    const input = {
      runId: "run-change",
      sourceTicketId: "source",
      sourceStepId: "work",
      sourceOutputSha256: digest("source-output"),
      sourceBinding,
      targetNodeIds: ["claim-b", "claim-a"],
      summary: "Adjust the upstream contract",
      reason: "Execution exposed a mismatch",
    } as const;
    const created = deriveChangeControlPublication(catalog, input);
    expect(created).toMatchObject({
      disposition: "create",
      initialStatus: "proposed",
      controlScopeNodeIds: ["claim-a", "claim-b"],
      sourceHold: "apply_or_repair_after_proposal",
    });
    const existing: ExistingChangeControlProposal = {
      ticketId: created.proposalTicketId,
      requestSha256: created.requestSha256,
      proposalOperationId: created.proposalOperationId,
      sourceTicketId: input.sourceTicketId,
      sourceStepId: input.sourceStepId,
      sourceOutputSha256: input.sourceOutputSha256,
      controlScopeNodeIds: created.controlScopeNodeIds,
    };
    expect(
      deriveChangeControlPublication(catalog, { ...input, existingProposal: existing }).disposition,
    ).toBe("reuse");
    expectChangeControlError(
      () =>
        deriveChangeControlPublication(catalog, {
          ...input,
          existingProposal: { ...existing, sourceOutputSha256: digest("tampered") },
        }),
      "change_control.proposal_collision",
    );
  });

  it("binds approval transitions and preserves active authority on later steering", () => {
    const first = approval("approval-first");
    const accepted = deriveProposalDecision({
      runId: "run-change",
      proposalTicketId: "proposal",
      requestSha256: digest("request"),
      status: "proposed",
      decision: "approval",
      authority: first,
      ownsExecutionAuthority: false,
    });
    expect(accepted).toMatchObject({
      disposition: "approve",
      approvalSha256: first.sha256,
      transition: { from: "proposed", to: "queued" },
    });
    expectChangeControlError(
      () =>
        deriveProposalDecision({
          runId: "run-change",
          proposalTicketId: "proposal",
          requestSha256: digest("request"),
          status: "proposed",
          decision: "rejection",
          authority: first,
          ownsExecutionAuthority: false,
        }),
      "change_control.approval_decision",
    );
    const second = approval("approval-second");
    const preserved = deriveProposalDecision({
      runId: "run-change",
      proposalTicketId: "proposal",
      requestSha256: digest("request"),
      status: "running",
      decision: "approval",
      authority: second,
      currentApprovalSha256: first.sha256,
      ownsExecutionAuthority: true,
    });
    expect(preserved).toMatchObject({
      disposition: "preserve_active_approval",
      approvalSha256: first.sha256,
      invalidatePriorReview: false,
    });
    const rejected = deriveProposalDecision({
      runId: "run-change",
      proposalTicketId: "proposal-other",
      requestSha256: digest("request"),
      status: "proposed",
      decision: "rejection",
      authority: approval("rejection", "rejection", "proposal-other"),
      ownsExecutionAuthority: false,
    });
    expect(rejected).toMatchObject({
      disposition: "reject",
      transition: { from: "proposed", to: "completed" },
      terminalDisposition: "rejected",
    });
  });

  it("materializes one exact application child or an agent-free no-op", () => {
    const catalog = buildCatalog();
    const proposalSelectionSha256 = digest("proposal-selection");
    const base = {
      runId: "run-change",
      proposalTicketId: "proposal",
      proposalBinding: bind(catalog, "proposal"),
      requestSha256: digest("request"),
      approvalSha256: digest("approval"),
      proposalOutputSha256: digest("output"),
      proposalStepId: "work",
      proposalSelectionSha256,
      selectionSummary: "Apply the exact reviewed change",
      proposalTerminalProof: terminalSuccessProof({
        ticketId: "proposal",
        stepId: "work",
        attemptId: "proposal-attempt",
        actionInvocationId: "proposal-action",
        changeControlSha256: proposalSelectionSha256,
      }),
      reviewSha256: digest("review"),
      reviewTerminalProof: terminalSuccessProof({
        ticketId: "proposal",
        stepId: "review",
        attemptId: "review-attempt",
        actionInvocationId: "review-action",
      }),
      targetNodeIds: ["claim-a"],
      scope: {
        readNodeIds: ["claim-a"],
        writeNodeIds: ["claim-a"],
        readPaths: [],
        writePaths: [],
      },
    } as const;
    const created = deriveApprovedChangeMaterialization(catalog, {
      ...base,
      applicationPublicOperation: "apply-change",
    });
    expect(created.kind).toBe("application");
    if (created.kind !== "application") throw new Error("expected application");
    expect(created.disposition).toBe("create");
    const existing: ExistingApplicationChild = {
      ticketId: created.applicationTicketId,
      sourceProposalTicketId: base.proposalTicketId,
      applicationOperationId: created.applicationOperationId,
      authoritySha256: created.authoritySha256,
    };
    const replay = deriveApprovedChangeMaterialization(catalog, {
      ...base,
      applicationPublicOperation: "apply-change",
      existingApplication: existing,
    });
    expect(replay.kind === "application" && replay.disposition).toBe("reuse");

    const noOp = deriveApprovedChangeMaterialization(catalog, {
      ...base,
      applicationPublicOperation: "no-op",
      scope: { ...base.scope, writeNodeIds: [] },
    });
    expect(noOp).toMatchObject({ kind: "no_op", disposition: "materialize_without_agent" });
  });

  it("holds the source through application and releases only on terminal disposition", () => {
    expect(
      deriveSourceReleaseDecision({
        sourceTicketId: "source",
        heldByProposalTicketId: "proposal",
        proposalTerminal: true,
        proposalTerminalSha256: digest("proposal-terminal"),
        proposalDisposition: { kind: "cancelled" },
      }),
    ).toMatchObject({
      disposition: "release",
      reason: "cancelled",
      retirePriorExecutionAuthority: true,
    });
    expect(
      deriveSourceReleaseDecision({
        sourceTicketId: "source",
        heldByProposalTicketId: "proposal",
        proposalTerminal: true,
        proposalTerminalSha256: digest("proposal-terminal"),
        proposalDisposition: {
          kind: "application",
          authoritySha256: digest("application-authority"),
          applicationTicketId: "application",
          applicationApprovalSha256: digest("application-authority"),
          applicationTerminal: false,
        },
      }),
    ).toMatchObject({ disposition: "hold", reason: "application_pending" });
    expect(
      deriveSourceReleaseDecision({
        sourceTicketId: "source",
        heldByProposalTicketId: "proposal",
        proposalTerminal: true,
        proposalTerminalSha256: digest("proposal-terminal"),
        proposalDisposition: {
          kind: "application",
          authoritySha256: digest("application-authority"),
          applicationTicketId: "application",
          applicationApprovalSha256: digest("application-authority"),
          applicationTerminal: true,
          applicationTerminalSha256: digest("application-terminal"),
        },
      }),
    ).toMatchObject({
      disposition: "release",
      reason: "application_completed",
      retirePriorExecutionAuthority: true,
    });
    const exact = deriveSourceReleaseDecision({
      sourceTicketId: "source",
      heldByProposalTicketId: "proposal",
      proposalTerminal: true,
      proposalTerminalSha256: digest("proposal-terminal"),
      proposalDisposition: {
        kind: "application",
        authoritySha256: digest("application-authority"),
        applicationTicketId: "application",
        applicationApprovalSha256: digest("application-authority"),
        applicationTerminal: true,
        applicationTerminalSha256: digest("application-terminal"),
      },
    });
    const swappedChild = deriveSourceReleaseDecision({
      sourceTicketId: "source",
      heldByProposalTicketId: "proposal",
      proposalTerminal: true,
      proposalTerminalSha256: digest("proposal-terminal"),
      proposalDisposition: {
        kind: "application",
        authoritySha256: digest("application-authority"),
        applicationTicketId: "other-application",
        applicationApprovalSha256: digest("application-authority"),
        applicationTerminal: true,
        applicationTerminalSha256: digest("other-terminal"),
      },
    });
    expect(swappedChild.sha256).not.toBe(exact.sha256);
  });

  it("reuses an exact failure resolver, emits a new one for a later failure, and suppresses recursion", () => {
    const catalog = buildCatalog();
    const first = deriveTerminalResolverReconciliation(catalog, {
      runId: "run-change",
      sourceTicketId: "source",
      sourceBinding: bind(catalog, "ordinary"),
      failureBindingSha256: digest("failure-a"),
      existingResolvers: [],
    });
    expect(first).toMatchObject({ disposition: "create", chainSuppressed: false });
    if (first.chainSuppressed) throw new Error("expected emitted resolver");
    const existing: ExistingTerminalResolver = {
      ticketId: first.resolverTicketId,
      sourceTicketId: first.sourceTicketId,
      resolverOperationId: first.resolverOperationId,
      configurationSha256: first.configurationSha256,
      catalogSha256: first.catalogSha256,
      failureBindingSha256s: first.failureBindingSha256s,
      terminal: false,
    };
    const exactReplay = deriveTerminalResolverReconciliation(catalog, {
      runId: "run-change",
      sourceTicketId: "source",
      sourceBinding: bind(catalog, "ordinary"),
      failureBindingSha256: digest("failure-a"),
      existingResolvers: [existing],
    });
    expect(exactReplay).toMatchObject({
      disposition: "reuse",
      resolverTicketId: first.resolverTicketId,
      failureBindingSha256s: [digest("failure-a")],
    });
    expect(() =>
      deriveTerminalResolverReconciliation(catalog, {
        runId: "run-change",
        sourceTicketId: "source",
        sourceBinding: bind(catalog, "ordinary"),
        failureBindingSha256: digest("failure-b"),
        existingResolvers: [existing],
      }),
    ).toThrow(/noncanonical terminal resolver/u);
    const later = deriveTerminalResolverReconciliation(catalog, {
      runId: "run-change",
      sourceTicketId: "source",
      sourceBinding: bind(catalog, "ordinary"),
      failureBindingSha256: digest("failure-b"),
      existingResolvers: [{ ...existing, terminal: true }],
    });
    expect(later).toMatchObject({
      disposition: "create",
      failureBindingSha256s: [digest("failure-b")],
    });
    expect(later.chainSuppressed || later.resolverTicketId).not.toBe(first.resolverTicketId);
    const suppressed = deriveTerminalResolverReconciliation(catalog, {
      runId: "run-change",
      sourceTicketId: first.resolverTicketId,
      sourceBinding: bind(catalog, "resolver"),
      failureBindingSha256: digest("resolver-failed"),
      existingResolvers: [],
    });
    expect(suppressed).toMatchObject({
      disposition: "chain_suppressed",
      chainSuppressed: true,
      sourceLink: "operator_recovery_required",
    });
  });

  it("binds one bounded operator retry to the exact terminal resolver failure", () => {
    const catalog = buildCatalog();
    const resolverBinding = bind(catalog, "resolver");
    const resolverFailureProof = terminalFailureProof();
    const base = {
      runId: "run-change",
      resolverTicketId: "resolver-ticket",
      resolverBinding,
      sourceTicketId: "source-ticket",
      sourceFailureBindingSha256: digest("source-failure"),
      resolverFailure: {
        sha256: digest("resolver-failure"),
        attemptId: "resolver-attempt",
        launchSpecHash: digest("launch-spec"),
        terminalPolicySha256: digest("terminal-policy"),
        terminalOutputSha256: digest("terminal-output"),
        failureSettlementSha256: resolverFailureProof.sha256,
        failureProof: resolverFailureProof,
      },
      priorRetries: [],
      event: {
        eventId: "retry-event",
        actor: "operator" as const,
        message: "Retry after reviewing the exact resolver failure.",
        recordedAt: "2026-07-18T00:00:00.000Z",
      },
    };
    const first = deriveTerminalResolverRetryRequest(catalog, base);
    expect(first).toMatchObject({
      protocol: "koni.terminal-resolver-retry.v1",
      ordinal: 1,
      resolverFailureBindingSha256: digest("resolver-failure"),
      sourceFailureBindingSha256: digest("source-failure"),
      resolverBindingSha256: resolverBinding.sha256,
      catalogSha256: catalog.sha256,
    });
    expect(() =>
      deriveTerminalResolverRetryRequest(catalog, {
        ...base,
        priorRetries: [first],
        event: { ...base.event, eventId: "retry-replay" },
      }),
    ).toThrow(/already has an operator retry/u);
    expect(() =>
      deriveTerminalResolverRetryRequest(catalog, {
        ...base,
        resolverFailure: { ...base.resolverFailure, sha256: digest("later-failure") },
        priorRetries: Array.from({ length: MAX_TERMINAL_RESOLVER_RETRIES }, (_, index) => ({
          ordinal: index + 1,
          resolverFailureBindingSha256: digest(`prior-failure-${index}`),
          sha256: digest(`prior-retry-${index}`),
        })),
        event: { ...base.event, eventId: "retry-over-limit" },
      }),
    ).toThrow(/retry limit/u);
  });
});

type MutableRegistries = {
  operations: Record<string, Record<string, unknown>>;
  workflows: Record<string, Record<string, unknown>>;
  checks: Record<string, Record<string, unknown>>;
};

function buildCatalog(): CompiledExecutionSemanticCatalog {
  const registries: MutableRegistries = {
    operations: {
      ordinary: {
        id: "ordinary",
        operation: "ordinary-work",
        stage: "execution",
        workflow: "ordinary-flow",
        change_control_barrier: true,
        single_flight_group: "build",
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
        single_flight_group: "change-control",
        change_control: {
          role: "proposal",
          proposal_step: "propose",
          application_operations: ["apply-change", "no-op"],
        },
      },
      application: {
        id: "application",
        operation: "apply-change",
        stage: "change-control",
        workflow: "application-flow",
        single_flight_group: "change-control",
        change_control: { role: "application" },
      },
      disposition: {
        id: "disposition",
        operation: "no-op",
        stage: "change-control",
        change_control: { role: "disposition", outcome: "no_op" },
      },
      resolver: {
        id: "resolver",
        operation: "resolve-failure",
        stage: "recovery",
        workflow: "resolver-flow",
        gate_blocking_exempt: true,
        single_flight_group: "recovery",
        terminal_resolver: true,
        change_control: { role: "ordinary", allow_upstream_requests: false },
      },
    },
    workflows: {
      "ordinary-flow": {
        id: "ordinary-flow",
        version: "1.0.0",
        applies_to: ["ordinary"],
        steps: [{ id: "work", required: true }],
      },
      "proposal-flow": {
        id: "proposal-flow",
        version: "1.0.0",
        applies_to: ["proposal"],
        steps: [{ id: "propose", required: true }],
      },
      "application-flow": {
        id: "application-flow",
        version: "1.0.0",
        applies_to: ["application"],
        steps: [{ id: "apply", required: true }],
      },
      "resolver-flow": {
        id: "resolver-flow",
        version: "1.0.0",
        applies_to: ["resolver"],
        steps: [{ id: "resolve", required: true }],
      },
    },
    checks: {},
  };
  const material = { registries, edge_types: [] };
  return compileExecutionSemanticCatalog({
    configuration_sha256: canonicalHash(material),
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

function bind(
  catalog: CompiledExecutionSemanticCatalog,
  operationId: string,
  stepId?: string,
): ExecutionPolicyBinding {
  const operation = catalog.operations[operationId]!;
  return resolveExecutionPolicyBinding(catalog, {
    configurationSha256: catalog.configurationSha256,
    operationId,
    ...(operation.workflowId === undefined ? {} : { workflowId: operation.workflowId }),
    ...(stepId === undefined ? {} : { stepId }),
  });
}

function executionAuthority(
  catalog: CompiledExecutionSemanticCatalog,
  tickets: Record<string, SchedulerTicketExecutionAuthority>,
): SchedulerExecutionAuthority {
  return { catalog, tickets };
}

function runRecord(maxParallel: number): RunRecord {
  let lifecycle = newRunLifecycle("run-change");
  lifecycle = reduceRunLifecycle(lifecycle, { type: "planning_started", atMs: 1 }).state;
  lifecycle = reduceRunLifecycle(lifecycle, { type: "plan_submitted", atMs: 2 }).state;
  lifecycle = reduceRunLifecycle(lifecycle, { type: "plan_approval_requested", atMs: 3 }).state;
  lifecycle = reduceRunLifecycle(lifecycle, { type: "plan_approved", atMs: 4 }).state;
  const projectRoot = "/tmp/koni-scheduler-change-control";
  return {
    protocol: "koni.run-record.v1",
    id: "run-change",
    revision: 0,
    generation: 0,
    projectRoot,
    profile: {
      packageName: "@koni/research-profile",
      packageVersion: "1.0.0",
      lineage: "koni.research",
      bundleHash: digest("bundle"),
    },
    compiledConfigHash: digest("configuration"),
    runTypeId: "medium",
    objective: "Exercise deterministic change control",
    intake: { goal: "Exercise deterministic change control" },
    executionConfig: {
      maxParallel,
      disjointScopeParallelism: false,
      questionPolicy: "some",
      instructions: "",
      agents: {},
    },
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    lifecycle,
    pipelineStageIds: ["planning", "approval", "orchestrate"],
    currentPipelineStageId: "orchestrate",
    plan: undefined,
    graphRevision: 0,
    graphHash: undefined,
    tickets: {},
    attempts: {},
    questions: {},
    activity: [],
    git: fixtureRunGit(projectRoot, "run-change", "approved"),
  };
}

function ticket(
  id: string,
  operationId: string,
  status: TicketStatus,
  priority: number,
  nodeIds: string[],
): TicketRecord {
  return {
    id,
    operationId,
    title: id,
    summary: id,
    status,
    priority,
    dependencyIds: [],
    targetNodeIds: nodeIds,
    readNodeIds: nodeIds,
    writeNodeIds: nodeIds,
    readPaths: [],
    writePaths: [],
    steps: [
      {
        id: "work",
        title: "Work",
        personaId: "worker",
        kind: "production",
        dependsOn: [],
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
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  };
}

function approval(
  label: string,
  decision: "approval" | "rejection" = "approval",
  proposalTicketId = "proposal",
) {
  const material = {
    protocol: "koni.proposal-decision-authority.v2" as const,
    runId: "run-change",
    proposalTicketId,
    requestSha256: digest("request"),
    eventId: `event-${label}`,
    decision,
    actor: "operator" as const,
    recordedAt: "2026-07-18T00:00:00.000Z",
    message: label,
  };
  return { ...material, sha256: canonicalHash(material) };
}

function terminalFailureProof() {
  const semanticResult = {
    kind: "assignment" as const,
    status: "failed" as const,
    blocker: "Exact configured resolver failure",
  };
  const material = {
    protocol: "koni.terminal-failure-settlement.v1" as const,
    runId: "run-change",
    ticketId: "resolver-ticket",
    stepId: "resolve",
    attemptId: "resolver-attempt",
    actionInvocationId: "resolver-validation",
    actionPlanSha256: digest("action-plan"),
    actionSettlementSha256: digest("action-settlement"),
    semanticResult,
    semanticResultSha256: canonicalHash(semanticResult),
    terminalPolicySha256: digest("terminal-policy"),
    terminalOutputSha256: digest("terminal-output"),
  };
  return { ...material, sha256: canonicalHash(material) };
}

function terminalSuccessProof(
  input: Readonly<{
    ticketId: string;
    stepId: string;
    attemptId: string;
    actionInvocationId: string;
    changeControlSha256?: Sha256Digest;
  }>,
): TerminalSuccessSettlementProof {
  const semanticResult = {
    kind: "assignment" as const,
    status: "completed" as const,
    summary: "Completed exact compiler-authorized work",
    ...(input.changeControlSha256 === undefined
      ? {}
      : { changeControlSha256: input.changeControlSha256 }),
  };
  const material = {
    protocol: "koni.terminal-success-settlement.v1" as const,
    runId: "run-change",
    ticketId: input.ticketId,
    stepId: input.stepId,
    attemptId: input.attemptId,
    actionInvocationId: input.actionInvocationId,
    actionPlanSha256: digest(`${input.actionInvocationId}-plan`),
    actionSettlementSha256: digest(`${input.actionInvocationId}-settlement`),
    semanticResult,
    semanticResultSha256: canonicalHash(semanticResult),
    terminalPolicySha256: digest(`${input.attemptId}-terminal-policy`),
    terminalOutputSha256: digest(`${input.attemptId}-terminal-output`),
  };
  return { ...material, sha256: canonicalHash(material) };
}

function digest(label: string): Sha256Digest {
  return canonicalHash(label);
}

function expectSchedulerError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected scheduler authority rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(SchedulerAuthorityError);
    expect((error as SchedulerAuthorityError).code).toBe(code);
  }
}

function expectChangeControlError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected change-control authority rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ChangeControlAuthorityError);
    expect((error as ChangeControlAuthorityError).code).toBe(code);
  }
}
