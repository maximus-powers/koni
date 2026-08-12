import { describe, expect, it } from "vitest";
import {
  createRunActionEffectReceipt,
  prepareRunActionExecution,
} from "../src/authority/action-execution.js";
import {
  appendRecurringAssetGrantRefreshAuthorities,
  retainTicketAuthorityFields,
} from "../src/authority/run-engine.js";
import {
  resolveExecutionPolicyBinding,
  type ExecutionPolicyBinding,
} from "../src/authority/execution-policy.js";
import { executeActionPlan } from "../src/compiler/action-recipes.js";
import {
  compileExecutionSemanticCatalog,
  type CompiledExecutionSemanticCatalog,
} from "../src/compiler/execution-semantics.js";
import type { CompiledConfiguration } from "../src/contracts/configuration.js";
import type { DerivedTicketDefinition, DerivedWorkflowStep } from "../src/contracts/rules.js";
import { canonicalHash, type Sha256Digest } from "../src/shared/canonical.js";
import {
  deriveApprovedChangeMaterialization,
  deriveChangeControlPublication,
  deriveTerminalResolverReconciliation,
} from "../src/state/change-control.js";
import { newRunLifecycle } from "../src/state/run-lifecycle.js";
import {
  assertRunExecutionControlMutation,
  assertRunRecord,
  createCompilerControlTicketAuthority,
  createRunActionSettlement,
  createTerminalFailureSettlementProof,
  createTerminalSuccessSettlementProof,
  terminalFailureBindingFromProof,
  ticketImmutableProjection,
  type CompilerControlTicketAuthority,
  type ControlTicketCausalAuthority,
  type ControlTicketRole,
  type RunActionExecutionRecord,
  type RunRecord,
  type TerminalFailureSettlementProof,
  type TerminalSuccessSettlementProof,
  type TicketExecutionControlRecord,
  type TicketRecord,
  type TicketStatus,
} from "../src/state/run-record.js";
import { runBehaviorSnapshotFixture } from "./fixtures/compiled-behavior.js";
import { attachFixtureTicketCycle, fixtureRunGit } from "./run-record-fixtures.js";

const AT = "2026-07-18T05:00:00.000Z";
const ROLES: readonly ControlTicketRole[] = [
  "proposal",
  "approved_application",
  "terminal_resolver",
];

type AuthorityAttack = Readonly<{
  name: string;
  mutate: (run: RunRecord, ticket: TicketRecord, authority: CompilerControlTicketAuthority) => void;
  reproject?: boolean;
}>;

describe("canonical compiler control-ticket authority", () => {
  it("preserves a released proposal across an exact recurring-asset grant refresh", async () => {
    const catalog = buildCatalog();
    const run = baseRun(catalog);
    const proposal = await proposalFixture(run, catalog, true, "-historical");
    const application = await applicationFixture(run, catalog, proposal, "-historical");
    const proposalAuthority = proposal.executionControl!.controlTicketAuthority!;
    if (proposalAuthority.causal.role !== "proposal") {
      throw new Error("fixture proposal cause mismatch");
    }
    const source = run.tickets[proposalAuthority.causal.publication.sourceTicketId]!;
    source.executionControl = {};
    source.status = "completed";
    source.executionEpoch = 0;
    for (const step of source.steps) step.status = "completed";
    const sourceCycle = attachFixtureTicketCycle(run, source);
    sourceCycle.status = "retired";
    sourceCycle.integratedRunOid = run.git.run.headOid;
    sourceCycle.squashCommitOid = run.git.run.headOid;
    sourceCycle.integratedAt = AT;
    sourceCycle.retiredAt = AT;
    application.status = "completed";
    for (const step of application.steps) step.status = "completed";
    const applicationCycle = attachFixtureTicketCycle(run, application);
    applicationCycle.status = "retired";
    applicationCycle.integratedRunOid = run.git.run.headOid;
    applicationCycle.squashCommitOid = run.git.run.headOid;
    applicationCycle.integratedAt = AT;
    applicationCycle.retiredAt = AT;

    const currentProposal = await proposalFixture(run, catalog, false, "-refresh");
    const refresher = await applicationFixture(run, catalog, currentProposal, "-refresh", "report");
    refresher.status = "running";
    const refreshAttemptId = "attempt-source-refresh-trigger";
    const refreshStep = refresher.steps[0]!;
    run.attempts[refreshAttemptId] = attemptRecord(
      refresher,
      refreshStep.id,
      refreshAttemptId,
      terminalPolicyFor(refreshAttemptId),
      digest("source-refresh-trigger-output"),
    );
    run.attempts[refreshAttemptId].status = "terminal_accepted";
    run.attempts[refreshAttemptId].endedAt = undefined;
    refreshStep.status = "running";
    refreshStep.attemptIds = [refreshAttemptId];
    const prepared = prepareRunActionExecution(run, {
      kind: "assignment_validation",
      stageId: run.currentPipelineStageId!,
      selector: refreshStep.validationAction!,
      checkout: "main",
      ticketId: refresher.id,
      ticketState: refresher.status,
      stepId: refreshStep.id,
      attemptId: refreshAttemptId,
      at: AT,
    });
    run.actionExecutions ??= {};
    run.actionExecutions[prepared.invocationId] = structuredClone(prepared);
    run.graphHash = digest("graph-before-refresh");
    expect(() => assertRunRecord(run)).not.toThrow();

    const next = structuredClone(run);
    next.revision += 1;
    next.updatedAt = "2026-07-18T05:01:00.000Z";
    next.graphRevision += 1;
    next.graphHash = digest("graph-after-refresh");
    const refreshed = next.tickets[source.id]!;
    const priorProjectionSha256 = ticketImmutableProjection(source).sha256;
    refreshed.readPaths = ["evidence/current.json"];
    refreshed.steps[0]!.readPaths = ["evidence/current.json"];
    refreshed.status = "queued";
    refreshed.executionEpoch = 1;
    delete refreshed.gitCycleId;
    refreshed.worktreePath = undefined;
    refreshed.branch = undefined;
    for (const step of refreshed.steps) {
      step.status = "pending";
      step.summary = undefined;
      step.startedAt = undefined;
      step.completedAt = undefined;
    }
    authorizeRecurringAssetGrantRefresh(run, next, prepared.invocationId);
    expect(refreshed.executionControl?.recurringAssetGrantRefreshes).toHaveLength(1);
    expect(
      refreshed.executionControl?.recurringAssetGrantRefreshes?.[0]?.priorProjectionSha256,
    ).toBe(priorProjectionSha256);

    expect(() => assertRunRecord(next)).not.toThrow();
    expect(() => assertRunExecutionControlMutation(run, next)).not.toThrow();

    const laterProposalCheckpoint = structuredClone(next);
    const laterProposal = laterProposalCheckpoint.tickets[proposal.id]!;
    const laterProposalAuthority = laterProposal.executionControl!.controlTicketAuthority!;
    if (laterProposalAuthority.causal.role !== "proposal") {
      throw new Error("fixture later proposal cause mismatch");
    }
    (laterProposalAuthority.causal as unknown as Record<string, unknown>).sourceTicketProjection =
      ticketImmutableProjection(laterProposalCheckpoint.tickets[source.id]!);
    rehashAuthority(laterProposalAuthority);
    const laterApplication = laterProposalCheckpoint.tickets[application.id]!;
    const laterApplicationAuthority = laterApplication.executionControl!.controlTicketAuthority!;
    if (laterApplicationAuthority.causal.role !== "approved_application") {
      throw new Error("fixture later application cause mismatch");
    }
    (
      laterApplicationAuthority.causal as unknown as Record<string, unknown>
    ).proposalTicketAuthoritySha256 = laterProposalAuthority.sha256;
    rehashAuthority(laterApplicationAuthority);
    expect(() => assertRunRecord(laterProposalCheckpoint)).not.toThrow();

    const twiceRefreshed = structuredClone(laterProposalCheckpoint);
    const twiceSource = twiceRefreshed.tickets[source.id]!;
    const beforeSecondRefresh = ticketImmutableProjection(twiceSource);
    twiceSource.readPaths = ["evidence/current.json", "evidence/later.json"];
    twiceSource.steps[0]!.readPaths = ["evidence/current.json", "evidence/later.json"];
    twiceSource.executionEpoch = 2;
    twiceRefreshed.graphRevision += 1;
    twiceRefreshed.graphHash = digest("graph-after-second-refresh");
    twiceRefreshed.updatedAt = "2026-07-18T05:02:00.000Z";
    const afterSecondRefresh = ticketImmutableProjection(twiceSource);
    const priorRefresh = twiceSource.executionControl!.recurringAssetGrantRefreshes![0]!;
    const secondRefreshMaterial = {
      ...priorRefresh,
      priorGraphHash: next.graphHash,
      priorGraphRevision: next.graphRevision,
      nextGraphHash: twiceRefreshed.graphHash,
      nextGraphRevision: twiceRefreshed.graphRevision,
      priorProjection: beforeSecondRefresh,
      priorProjectionSha256: beforeSecondRefresh.sha256,
      refreshedProjection: afterSecondRefresh,
      nextProjectionSha256: afterSecondRefresh.sha256,
      priorExecutionEpoch: 1,
      nextExecutionEpoch: 2,
      recordedAt: twiceRefreshed.updatedAt,
    };
    const { sha256: _priorRefreshSha256, ...secondRefreshWithoutSha } = secondRefreshMaterial;
    twiceSource.executionControl!.recurringAssetGrantRefreshes!.push({
      ...secondRefreshWithoutSha,
      sha256: canonicalHash(secondRefreshWithoutSha),
    });
    expect(() => assertRunRecord(twiceRefreshed)).not.toThrow();

    const widened = structuredClone(next);
    widened.tickets[source.id]!.writePaths = ["unrelated/widened-root"];
    expect(() => assertRunExecutionControlMutation(run, widened)).toThrow();

    const retargeted = unauthorizeRecurringAssetGrantRefresh(
      next,
      source.id,
      prepared.invocationId,
    );
    retargeted.tickets[source.id]!.targetNodeIds = ["unrelated-node"];
    authorizeRecurringAssetGrantRefresh(run, retargeted, prepared.invocationId);
    expect(() => assertRunRecord(retargeted)).not.toThrow();
    expect(() => assertRunExecutionControlMutation(run, retargeted)).toThrow();

    const staleEpoch = structuredClone(next);
    staleEpoch.tickets[source.id]!.executionEpoch = 0;
    expect(() => assertRunExecutionControlMutation(run, staleEpoch)).toThrow();

    const operatorCancelled = structuredClone(run);
    const cancelledSource = operatorCancelled.tickets[source.id]!;
    cancelledSource.status = "cancelled";
    cancelledSource.blocker = "Operator cancelled this ticket";
    delete cancelledSource.gitCycleId;
    cancelledSource.worktreePath = undefined;
    cancelledSource.branch = undefined;
    for (const step of cancelledSource.steps) step.status = "skipped";
    const operatorCancelledRefresh = unauthorizeRecurringAssetGrantRefresh(
      next,
      source.id,
      prepared.invocationId,
    );
    authorizeRecurringAssetGrantRefresh(
      operatorCancelled,
      operatorCancelledRefresh,
      prepared.invocationId,
    );
    expect(() => assertRunRecord(operatorCancelledRefresh)).not.toThrow();
    expect(() =>
      assertRunExecutionControlMutation(operatorCancelled, operatorCancelledRefresh),
    ).toThrow();

    const wrongSemanticPrimitive = unauthorizeRecurringAssetGrantRefresh(
      next,
      source.id,
      prepared.invocationId,
    );
    authorizeRecurringAssetGrantRefresh(
      run,
      wrongSemanticPrimitive,
      prepared.invocationId,
      "nonpreferred",
    );
    expect(() => assertRunRecord(wrongSemanticPrimitive)).not.toThrow();
    expect(() => assertRunExecutionControlMutation(run, wrongSemanticPrimitive)).toThrow();

    const compilerRetired = structuredClone(run);
    const retiredSource = compilerRetired.tickets[source.id]!;
    retiredSource.status = "cancelled";
    retiredSource.blocker = "Current compiler predicate no longer applies after prior execution";
    delete retiredSource.gitCycleId;
    retiredSource.worktreePath = undefined;
    retiredSource.branch = undefined;
    for (const step of retiredSource.steps) step.status = "skipped";
    const compiledRetired = structuredClone(next.tickets);
    retainTicketAuthorityFields(compilerRetired, compiledRetired);
    expect(compiledRetired[source.id]).toMatchObject({ status: "queued", executionEpoch: 1 });
  });

  it("allows an actively held proposal source to receive later compiler dependencies", async () => {
    const fixture = await controlFixture("proposal");
    const proposal = fixture.run.tickets[fixture.controlTicketId]!;
    const proposalAuthority = proposal.executionControl!.controlTicketAuthority!;
    if (proposalAuthority.causal.role !== "proposal") {
      throw new Error("fixture proposal cause mismatch");
    }
    const source = fixture.run.tickets[proposalAuthority.causal.publication.sourceTicketId]!;
    expect(source.executionControl?.sourceHold?.proposalTicketId).toBe(proposal.id);
    expect(() => assertRunRecord(fixture.run)).not.toThrow();

    const next = structuredClone(fixture.run);
    next.revision += 1;
    next.updatedAt = "2026-07-18T05:01:00.000Z";
    next.tickets[source.id]!.dependencyIds = [proposal.id];

    expect(() => assertRunRecord(next)).not.toThrow();
    expect(() => assertRunExecutionControlMutation(fixture.run, next)).not.toThrow();
  });

  it("allows a released proposal source to receive later compiler dependencies", async () => {
    const fixture = await controlFixture("approved_application");
    const application = fixture.run.tickets[fixture.controlTicketId]!;
    const applicationAuthority = application.executionControl!.controlTicketAuthority!;
    if (applicationAuthority.causal.role !== "approved_application") {
      throw new Error("fixture application cause mismatch");
    }
    const proposal =
      fixture.run.tickets[applicationAuthority.causal.materialization.proposalTicketId]!;
    const proposalAuthority = proposal.executionControl!.controlTicketAuthority!;
    if (proposalAuthority.causal.role !== "proposal") {
      throw new Error("fixture proposal cause mismatch");
    }
    const source = fixture.run.tickets[proposalAuthority.causal.publication.sourceTicketId]!;
    delete source.executionControl;
    application.status = "completed";
    for (const step of application.steps) step.status = "completed";
    const cycle = attachFixtureTicketCycle(fixture.run, application);
    cycle.status = "retired";
    cycle.integratedRunOid = fixture.run.git.run.headOid;
    cycle.squashCommitOid = fixture.run.git.run.headOid;
    cycle.integratedAt = "2026-07-18T05:00:00.000Z";
    cycle.retiredAt = "2026-07-18T05:00:01.000Z";
    expect(() => assertRunRecord(fixture.run)).not.toThrow();

    const next = structuredClone(fixture.run);
    next.revision += 1;
    next.updatedAt = "2026-07-18T05:01:00.000Z";
    next.tickets[source.id]!.dependencyIds = [application.id];

    expect(() => assertRunRecord(next)).not.toThrow();
    expect(() => assertRunExecutionControlMutation(fixture.run, next)).not.toThrow();
  });

  it("allows a recovered terminal source to receive later compiler dependencies", async () => {
    const fixture = await controlFixture("terminal_resolver");
    const resolver = fixture.run.tickets[fixture.controlTicketId]!;
    const resolverAuthority = resolver.executionControl!.controlTicketAuthority!;
    if (resolverAuthority.causal.role !== "terminal_resolver") {
      throw new Error("fixture resolver cause mismatch");
    }
    const source = fixture.run.tickets[resolverAuthority.causal.reconciliation.sourceTicketId]!;
    const terminalProof = await addSuccessAttempt(
      fixture.run,
      resolver,
      resolver.steps.length - 1,
      "attempt-resolver-terminal",
      {},
    );
    resolver.executionControl!.terminalResolverTerminalProof = terminalProof;
    resolver.status = "completed";
    for (const step of resolver.steps) step.status = "completed";
    expect(() => assertRunRecord(fixture.run)).not.toThrow();

    const next = structuredClone(fixture.run);
    next.revision += 1;
    next.updatedAt = "2026-07-18T05:01:00.000Z";
    next.tickets[source.id]!.dependencyIds = [resolver.id];

    expect(() => assertRunRecord(next)).not.toThrow();
    expect(() => assertRunExecutionControlMutation(fixture.run, next)).not.toThrow();
  });

  it("allows an active terminal source to receive a compiler repair dependency", async () => {
    const fixture = await controlFixture("terminal_resolver");
    const resolver = fixture.run.tickets[fixture.controlTicketId]!;
    const resolverAuthority = resolver.executionControl!.controlTicketAuthority!;
    if (resolverAuthority.causal.role !== "terminal_resolver") {
      throw new Error("fixture resolver cause mismatch");
    }
    const source = fixture.run.tickets[resolverAuthority.causal.reconciliation.sourceTicketId]!;
    expect(resolver.status).toBe("queued");
    expect(resolver.executionControl?.terminalResolverTerminalProof).toBeUndefined();
    expect(() => assertRunRecord(fixture.run)).not.toThrow();

    const next = structuredClone(fixture.run);
    next.revision += 1;
    next.updatedAt = "2026-07-18T05:01:00.000Z";
    next.tickets[source.id]!.dependencyIds = ["TK-compiler-repair"];

    expect(() => assertRunRecord(next)).not.toThrow();
    expect(() => assertRunExecutionControlMutation(fixture.run, next)).not.toThrow();
  });

  it.each(ROLES)(
    "accepts an exact %s authority through JSON restart and lifecycle-only mutation",
    async (role) => {
      const fixture = await controlFixture(role);
      expect(() => assertRunRecord(fixture.run)).not.toThrow();
      const restarted = JSON.parse(JSON.stringify(fixture.run)) as RunRecord;
      expect(() => assertRunRecord(restarted)).not.toThrow();

      const next = structuredClone(restarted);
      next.revision += 1;
      next.updatedAt = "2026-07-18T05:01:00.000Z";
      const ticket = next.tickets[fixture.controlTicketId]!;
      ticket.status = ticket.status === "proposed" ? "queued" : "running";
      ticket.blocker = undefined;
      ticket.updatedAt = next.updatedAt;
      expect(() => assertRunRecord(next)).not.toThrow();
      expect(() => assertRunExecutionControlMutation(restarted, next)).not.toThrow();
    },
  );

  it.each(ROLES)("accepts exact same-CAS creation of a %s ticket", async (role) => {
    const fixture = await controlFixture(role);
    const { previous, next } = creationTransition(fixture, role);
    expect(() => assertRunExecutionControlMutation(previous, next)).not.toThrow();
  });

  const cases = ROLES.flatMap((role) => authorityAttacks().map((attack) => ({ role, attack })));
  it.each(cases)(
    "rejects self-rehashed $role $attack.name substitution on raw load",
    async ({ role, attack }) => {
      const fixture = await controlFixture(role);
      const attacked = structuredClone(fixture.run);
      const ticket = attacked.tickets[fixture.controlTicketId]!;
      const authority = ticket.executionControl!.controlTicketAuthority!;
      attack.mutate(attacked, ticket, authority);
      if (attack.reproject !== false) reprojectAttackerAuthority(ticket);
      else rehashAuthority(authority);
      expect(() => assertRunRecord(attacked)).toThrow();
    },
  );

  it.each(cases)(
    "rejects self-rehashed $role $attack.name substitution in one CAS",
    async ({ role, attack }) => {
      const fixture = await controlFixture(role);
      const { previous, next } = creationTransition(fixture, role);
      const ticket = next.tickets[fixture.controlTicketId]!;
      const authority = ticket.executionControl!.controlTicketAuthority!;
      attack.mutate(next, ticket, authority);
      if (attack.reproject !== false) reprojectAttackerAuthority(ticket);
      else rehashAuthority(authority);
      expect(() => assertRunExecutionControlMutation(previous, next)).toThrow();
    },
  );
});

function authorityAttacks(): readonly AuthorityAttack[] {
  return [
    {
      name: "ticket identity",
      mutate: (run, ticket, authority) => {
        const priorId = ticket.id;
        const replacementId = `${priorId}-attacker`;
        delete run.tickets[priorId];
        ticket.id = replacementId;
        run.tickets[replacementId] = ticket;
        (authority as unknown as Record<string, unknown>).ticketId = replacementId;
        const definition = authority.definition as unknown as Record<string, unknown>;
        definition.id = replacementId;
        rehashNested(definition, "definition_sha256");
      },
    },
    {
      name: "operation",
      reproject: false,
      mutate: (_run, _ticket, authority) => {
        const operation = authority.operation as unknown as Record<string, unknown>;
        operation.publicOperation = `${String(operation.publicOperation)}-attacker`;
        rehashNested(operation, "sha256");
      },
    },
    {
      name: "ticket operation identity",
      mutate: (_run, ticket, authority) => {
        const operation = authority.operation as unknown as Record<string, unknown>;
        const replacementId = `${String(operation.id)}-attacker`;
        operation.id = replacementId;
        rehashNested(operation, "sha256");
        ticket.operationId = replacementId;
        const definition = authority.definition as unknown as Record<string, unknown>;
        definition.operation_registry_id = replacementId;
        rehashNested(definition, "definition_sha256");
        const bindings = [
          ticket.executionPolicyBinding!,
          ...ticket.steps.map((step) => step.executionPolicyBinding!),
        ];
        for (const rawBinding of bindings) {
          const binding = rawBinding as unknown as Record<string, unknown>;
          binding.operationId = replacementId;
          binding.operationSha256 = operation.sha256;
          rehashNested(binding, "sha256");
        }
      },
    },
    {
      name: "workflow",
      reproject: false,
      mutate: (_run, _ticket, authority) => {
        const workflow = authority.workflow as unknown as Record<string, unknown>;
        workflow.version = "999.0.0";
        rehashNested(workflow, "sha256");
      },
    },
    {
      name: "ticket binding",
      mutate: (_run, ticket) => {
        const binding = ticket.executionPolicyBinding! as unknown as Record<string, unknown>;
        binding.publicOperation = `${String(binding.publicOperation)}-attacker`;
        rehashNested(binding, "sha256");
      },
    },
    {
      name: "title",
      mutate: (_run, ticket) => {
        ticket.title = `${ticket.title} attacker`;
      },
    },
    {
      name: "summary",
      mutate: (_run, ticket) => {
        ticket.summary = `${ticket.summary} attacker`;
      },
    },
    {
      name: "persona",
      mutate: (_run, ticket) => {
        ticket.steps[0]!.personaId = "attacker";
      },
    },
    {
      name: "step order",
      mutate: (_run, ticket) => {
        ticket.steps.reverse();
      },
    },
    {
      name: "step identity",
      mutate: (_run, ticket, authority) => {
        const priorId = ticket.steps[0]!.id;
        const replacementId = `${priorId}-attacker`;
        ticket.steps[0]!.id = replacementId;
        for (const step of ticket.steps) {
          step.dependsOn = (step.dependsOn ?? []).map((dependency) =>
            dependency === priorId ? replacementId : dependency,
          );
        }

        const definition = authority.definition as unknown as Record<string, unknown>;
        const definitionSteps = definition.workflow as Array<Record<string, unknown>>;
        definitionSteps[0]!.id = replacementId;
        for (const step of definitionSteps) {
          step.depends_on = (step.depends_on as string[]).map((dependency) =>
            dependency === priorId ? replacementId : dependency,
          );
        }
        rehashNested(definition, "definition_sha256");

        const workflow = authority.workflow as unknown as Record<string, unknown>;
        const semanticSteps = workflow.steps as Array<Record<string, unknown>>;
        semanticSteps[0]!.id = replacementId;
        rehashNested(semanticSteps[0]!, "sha256");
        rehashNested(workflow, "sha256");

        const ticketBinding = ticket.executionPolicyBinding! as unknown as Record<string, unknown>;
        ticketBinding.workflowSha256 = workflow.sha256;
        rehashNested(ticketBinding, "sha256");
        for (const [index, step] of ticket.steps.entries()) {
          const binding = step.executionPolicyBinding! as unknown as Record<string, unknown>;
          binding.workflowSha256 = workflow.sha256;
          if (index === 0) {
            binding.stepId = replacementId;
            binding.stepSha256 = semanticSteps[0]!.sha256;
          }
          rehashNested(binding, "sha256");
        }
      },
    },
    {
      name: "step dependency",
      mutate: (_run, ticket) => {
        ticket.steps[1]!.dependsOn = [];
      },
    },
    {
      name: "step binding",
      mutate: (_run, ticket) => {
        const binding = ticket.steps[0]!.executionPolicyBinding! as unknown as Record<
          string,
          unknown
        >;
        binding.stepId = ticket.steps[1]!.id;
        rehashNested(binding, "sha256");
      },
    },
    {
      name: "read node scope",
      mutate: (_run, ticket) => {
        ticket.readNodeIds = [...(ticket.readNodeIds ?? []), "claim-attacker"].sort();
      },
    },
    {
      name: "write node scope",
      mutate: (_run, ticket) => {
        ticket.writeNodeIds = [...(ticket.writeNodeIds ?? []), "claim-attacker"].sort();
      },
    },
    {
      name: "read path scope",
      mutate: (_run, ticket) => {
        ticket.readPaths = [...ticket.readPaths, "attacker/read.ts"].sort();
      },
    },
    {
      name: "write path scope",
      mutate: (_run, ticket) => {
        ticket.writePaths = [...ticket.writePaths, "attacker/write.ts"].sort();
      },
    },
    {
      name: "validation action",
      mutate: (_run, ticket) => {
        ticket.steps[0]!.validationAction = "attacker-check";
      },
    },
    {
      name: "priority",
      mutate: (_run, ticket) => {
        ticket.priority += 1;
      },
    },
    {
      name: "ticket dependency",
      mutate: (_run, ticket) => {
        ticket.dependencyIds = [...ticket.dependencyIds, "ticket-attacker"].sort();
      },
    },
    {
      name: "target",
      mutate: (_run, ticket) => {
        ticket.targetNodeIds = [...ticket.targetNodeIds, "claim-attacker"].sort();
      },
    },
    {
      name: "control link",
      mutate: (_run, ticket, authority) => {
        const control = ticket.executionControl!;
        if (authority.role === "proposal")
          control.proposalRequest!.sourceTicketId = "source-attacker";
        else if (authority.role === "approved_application")
          control.sourceProposalTicketId = "proposal-attacker";
        else control.terminalRecovery!.sourceTicketId = "source-attacker";
      },
    },
    {
      name: "control scope",
      mutate: (_run, ticket) => {
        ticket.executionControl!.changeControlScopeNodeIds = [
          ...(ticket.executionControl!.changeControlScopeNodeIds ?? []),
          "claim-attacker",
        ].sort();
      },
    },
    {
      name: "review configuration",
      mutate: (_run, ticket) => {
        ticket.reviewReworkLimit = (ticket.reviewReworkLimit ?? 1) + 1;
      },
    },
    {
      name: "causal preimage",
      reproject: false,
      mutate: (_run, _ticket, authority) => {
        const causal = authority.causal;
        if (causal.role === "proposal") {
          const publication = causal.publication as unknown as Record<string, unknown>;
          publication.summary = `${String(publication.summary)} attacker`;
          rehashNested(publication, "sha256");
        } else if (causal.role === "approved_application") {
          (causal as unknown as Record<string, unknown>).proposalTicketAuthoritySha256 =
            digest("attacker-proposal");
        } else {
          const reconciliation = causal.reconciliation as unknown as Record<string, unknown>;
          reconciliation.sourceTicketId = "source-attacker";
          rehashNested(reconciliation, "sha256");
        }
      },
    },
  ];
}

interface ControlFixture {
  run: RunRecord;
  catalog: CompiledExecutionSemanticCatalog;
  controlTicketId: string;
}

async function controlFixture(role: ControlTicketRole): Promise<ControlFixture> {
  const catalog = buildCatalog();
  const run = baseRun(catalog);
  if (role === "terminal_resolver") return resolverFixture(run, catalog);
  const proposal = await proposalFixture(run, catalog);
  if (role === "proposal") return { run, catalog, controlTicketId: proposal.id };
  const application = await applicationFixture(run, catalog, proposal);
  return { run, catalog, controlTicketId: application.id };
}

async function proposalFixture(
  run: RunRecord,
  catalog: CompiledExecutionSemanticCatalog,
  recurringAsset = false,
  suffix = "",
): Promise<TicketRecord> {
  const source = ordinaryTicket(
    catalog,
    `source-proposal${suffix}`,
    "blocked",
    ["claim-a"],
    [],
    [],
  );
  if (recurringAsset) {
    source.operationId = "asset-resolution.asset.implement-asset";
    source.executionPolicyBinding = bind(catalog, source.operationId);
    source.steps[0]!.executionPolicyBinding = bind(catalog, source.operationId, "work");
  }
  run.tickets[source.id] = source;
  const sourceBinding = source.steps[0]!.executionPolicyBinding!;
  const publication = deriveChangeControlPublication(catalog, {
    runId: run.id,
    sourceTicketId: source.id,
    sourceStepId: source.steps[0]!.id,
    sourceOutputSha256: digest(`source-proposal-output${suffix}`),
    sourceBinding,
    targetNodeIds: ["claim-a"],
    summary: "Adjust exact claim contract",
    reason: "The compiled work exposed a bounded mismatch",
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
  const sourceProof = await addSuccessAttempt(run, source, 0, `attempt-source-proposal${suffix}`, {
    changeControlSha256: canonicalHash(sourceCompilation),
  });
  const sourceHold = {
    proposalTicketId: publication.proposalTicketId,
    requestSha256: publication.requestSha256,
  };
  source.executionControl = { sourceHold };

  const definition = controlDefinition(catalog, {
    id: publication.proposalTicketId,
    operationId: "proposal",
    title: controlTitle("Change request", publication.summary),
    targetNodeIds: ["claim-a"],
    readNodeIds: ["claim-a"],
    writeNodeIds: [],
    readPaths: [],
    writePaths: [],
    ruleId: "compiler.change-control.proposal",
  });
  const control: TicketExecutionControlRecord = {
    changeControlScopeNodeIds: ["claim-a"],
    proposalRequest: {
      requestSha256: publication.requestSha256,
      sourceTicketId: source.id,
      sourceStepId: source.steps[0]!.id,
      sourceOutputSha256: publication.sourceOutputSha256,
    },
  };
  const ticket = ticketFromDefinition(
    catalog,
    definition,
    "proposed",
    `${publication.summary}\n\nReason: ${publication.reason}`,
    control,
  );
  attachAuthority(run, catalog, ticket, definition, "proposal", {
    role: "proposal",
    publication,
    sourceTicketProjection: ticketImmutableProjection(source),
    sourceTerminalProof: sourceProof,
    sourceHold,
  });
  run.tickets[ticket.id] = ticket;
  return ticket;
}

async function applicationFixture(
  run: RunRecord,
  catalog: CompiledExecutionSemanticCatalog,
  proposal: TicketRecord,
  suffix = "",
  validationAction = "compile",
): Promise<TicketRecord> {
  proposal.status = "completed";
  const request = proposal.executionControl!.proposalRequest!;
  const approvalMaterial = {
    protocol: "koni.proposal-decision-authority.v2" as const,
    runId: run.id,
    proposalTicketId: proposal.id,
    requestSha256: request.requestSha256,
    eventId: "decision-approve-proposal",
    decision: "approval" as const,
    actor: "operator" as const,
    message: "Approve exact application",
    recordedAt: AT,
  };
  const approval = { ...approvalMaterial, sha256: canonicalHash(approvalMaterial) };
  const applicationBinding = bind(catalog, "application");
  const proposalOutputSha256 = digest(`proposal-selection-output${suffix}`);
  const selectionSummary = `Apply the bounded claim change${suffix}`;
  const selectionMaterial = {
    protocol: "koni.assignment-change-control.v1" as const,
    kind: "proposal_application" as const,
    configurationSha256: catalog.configurationSha256,
    catalogSha256: catalog.sha256,
    proposalBindingSha256: proposal.executionPolicyBinding!.sha256,
    applicationBinding,
    proposalOutputSha256,
    proposalTicketId: proposal.id,
    proposalStepId: proposal.steps[0]!.id,
    applicationPublicOperation: catalog.operations.application!.publicOperation,
    applicationOperationId: "application",
    targetNodeIds: ["claim-a"],
    summary: selectionSummary,
    scope: { readNodeIds: ["claim-a"], writeNodeIds: ["claim-a"], readPaths: [], writePaths: [] },
  };
  const selectionSha256 = canonicalHash(selectionMaterial);
  const proposalProof = await addSuccessAttempt(
    run,
    proposal,
    0,
    `attempt-proposal-selection${suffix}`,
    {
      changeControlSha256: selectionSha256,
    },
  );
  const reviewProof = await addSuccessAttempt(
    run,
    proposal,
    1,
    `attempt-proposal-review${suffix}`,
    {},
  );
  const reviewAttempt = run.attempts[reviewProof.attemptId]!;
  const reviewSha256 = canonicalHash({
    protocol: "koni.proposal-review-authority.v1",
    attemptId: reviewAttempt.id,
    launchSpecHash: reviewAttempt.launchSpecHash,
    approvalSha256: approval.sha256,
    terminalPolicySha256: reviewAttempt.terminalPolicy!.sha256,
    terminalOutputSha256: reviewAttempt.terminalOutputSha256!,
    terminalAcceptedAt: reviewAttempt.terminalAcceptedAt,
  });
  const materialization = deriveApprovedChangeMaterialization(catalog, {
    runId: run.id,
    proposalTicketId: proposal.id,
    proposalBinding: proposal.executionPolicyBinding!,
    requestSha256: request.requestSha256,
    approvalSha256: approval.sha256,
    proposalOutputSha256,
    proposalStepId: proposal.steps[0]!.id,
    proposalSelectionSha256: selectionSha256,
    selectionSummary,
    proposalTerminalProof: proposalProof,
    reviewSha256,
    reviewTerminalProof: reviewProof,
    applicationPublicOperation: catalog.operations.application!.publicOperation,
    targetNodeIds: ["claim-a"],
    scope: selectionMaterial.scope,
  });
  if (materialization.kind !== "application")
    throw new Error("fixture expected application materialization");
  proposal.executionControl = {
    ...proposal.executionControl!,
    proposalDecision: approval,
    proposalDecisionHistory: [approval],
    proposalApprovalSha256: approval.sha256,
    proposalDisposition: {
      kind: "application",
      authoritySha256: materialization.authoritySha256,
      applicationTicketId: materialization.applicationTicketId,
    },
    approvedApplicationSha256: materialization.authoritySha256,
    approvedMaterialization: materialization,
  };
  const definition = controlDefinition(catalog, {
    id: materialization.applicationTicketId,
    operationId: "application",
    title: controlTitle("Apply change", selectionSummary),
    targetNodeIds: ["claim-a"],
    readNodeIds: ["claim-a"],
    writeNodeIds: ["claim-a"],
    readPaths: [],
    writePaths: [],
    ruleId: "compiler.change-control.application",
    validationAction,
  });
  const control: TicketExecutionControlRecord = {
    changeControlScopeNodeIds: ["claim-a"],
    sourceProposalTicketId: proposal.id,
    approvedApplicationSha256: materialization.authoritySha256,
  };
  const ticket = ticketFromDefinition(catalog, definition, "queued", selectionSummary, control, [
    proposal.id,
  ]);
  attachAuthority(run, catalog, ticket, definition, "approved_application", {
    role: "approved_application",
    materialization,
    proposalTicketAuthoritySha256: proposal.executionControl.controlTicketAuthority!.sha256,
    proposalTicketProjectionSha256:
      proposal.executionControl.controlTicketAuthority!.projectionSha256,
  });
  run.tickets[ticket.id] = ticket;
  return ticket;
}

async function resolverFixture(
  run: RunRecord,
  catalog: CompiledExecutionSemanticCatalog,
): Promise<ControlFixture> {
  const source = ordinaryTicket(
    catalog,
    "source-failure",
    "blocked",
    ["claim-a"],
    ["src/failure.ts"],
    ["src/failure.ts"],
  );
  run.tickets[source.id] = source;
  const failureProof = await addFailureAttempt(run, source, 0, "attempt-source-failure");
  const failure = terminalFailureBindingFromProof(run, source, failureProof);
  if (failure === undefined) throw new Error("fixture failed to derive terminal failure binding");
  const reconciliation = deriveTerminalResolverReconciliation(catalog, {
    runId: run.id,
    sourceTicketId: source.id,
    sourceBinding: source.executionPolicyBinding!,
    failureBindingSha256: failure.sha256,
    existingResolvers: [],
  });
  if (reconciliation.chainSuppressed) throw new Error("fixture unexpectedly suppressed resolver");
  const recoveryMaterial = {
    protocol: "koni.terminal-recovery-authority.v2" as const,
    configurationSha256: catalog.configurationSha256,
    catalogSha256: catalog.sha256,
    resolverOperationId: reconciliation.resolverOperationId,
    resolverTicketId: reconciliation.resolverTicketId,
    resolverBinding: reconciliation.resolverBinding,
    resolverOperation: catalog.operations.resolver!,
    sourceTicketId: source.id,
    failureBindingSha256s: [...reconciliation.failureBindingSha256s],
    sourceFailureProof: failureProof,
    reconciliationDisposition: reconciliation.disposition,
    sourceLink: reconciliation.sourceLink,
    chainSuppressed: false as const,
    reconciliationSha256: reconciliation.sha256,
  };
  const recovery = { ...recoveryMaterial, sha256: canonicalHash(recoveryMaterial) };
  const readNodes = [
    ...new Set([...(source.readNodeIds ?? []), ...(source.writeNodeIds ?? [])]),
  ].sort();
  const definition = controlDefinition(catalog, {
    id: reconciliation.resolverTicketId,
    operationId: "resolver",
    title: `Resolve terminal failure: ${source.title}`,
    targetNodeIds: source.targetNodeIds,
    readNodeIds: readNodes,
    writeNodeIds: source.writeNodeIds ?? [],
    readPaths: source.readPaths,
    writePaths: source.writePaths,
    ruleId: "compiler.change-control.terminal-resolver",
  });
  const control: TicketExecutionControlRecord = {
    changeControlScopeNodeIds: [...new Set([...readNodes, ...(source.writeNodeIds ?? [])])].sort(),
    terminalRecovery: recovery,
  };
  const ticket = ticketFromDefinition(
    catalog,
    definition,
    "queued",
    `Recover terminal ticket ${source.id} from 1 authenticated failure binding(s).`,
    control,
  );
  attachAuthority(run, catalog, ticket, definition, "terminal_resolver", {
    role: "terminal_resolver",
    reconciliation,
    sourceTicketProjection: ticketImmutableProjection(source),
    sourceFailureProof: failureProof,
  });
  run.tickets[ticket.id] = ticket;
  return { run, catalog, controlTicketId: ticket.id };
}

function attachAuthority(
  run: RunRecord,
  catalog: CompiledExecutionSemanticCatalog,
  ticket: TicketRecord,
  definition: DerivedTicketDefinition,
  role: ControlTicketRole,
  causal: ControlTicketCausalAuthority,
): void {
  const operation = catalog.operations[ticket.operationId]!;
  const workflow = catalog.workflows[operation.workflowId!]!;
  ticket.executionControl!.controlTicketAuthority = createCompilerControlTicketAuthority({
    runId: run.id,
    role,
    ticket,
    operation,
    workflow,
    definition,
    causal,
  });
}

function creationTransition(
  fixture: ControlFixture,
  role: ControlTicketRole,
): { previous: RunRecord; next: RunRecord } {
  const next = structuredClone(fixture.run);
  const previous = structuredClone(fixture.run);
  const ticket = next.tickets[fixture.controlTicketId]!;
  if (role === "proposal") {
    const causal = ticket.executionControl!.controlTicketAuthority!.causal;
    if (causal.role !== "proposal") throw new Error("fixture proposal cause mismatch");
    delete previous.tickets[ticket.id];
    delete previous.tickets[causal.publication.sourceTicketId]!.executionControl!.sourceHold;
    previous.terminalSuccessProofs = {};
    delete previous.actionExecutions![causal.sourceTerminalProof.actionInvocationId];
  } else if (role === "approved_application") {
    const causal = ticket.executionControl!.controlTicketAuthority!.causal;
    if (causal.role !== "approved_application")
      throw new Error("fixture application cause mismatch");
    delete previous.tickets[ticket.id];
    const proposal = previous.tickets[causal.materialization.proposalTicketId]!;
    proposal.executionControl!.proposalDisposition = {
      kind: "approved",
      authoritySha256: proposal.executionControl!.proposalApprovalSha256!,
    };
    delete proposal.executionControl!.approvedMaterialization;
    delete proposal.executionControl!.approvedApplicationSha256;
  } else {
    const causal = ticket.executionControl!.controlTicketAuthority!.causal;
    if (causal.role !== "terminal_resolver") throw new Error("fixture resolver cause mismatch");
    delete previous.tickets[ticket.id];
  }
  previous.revision = 0;
  next.revision = 1;
  return { previous, next };
}

function ticketFromDefinition(
  catalog: CompiledExecutionSemanticCatalog,
  definition: DerivedTicketDefinition,
  status: TicketStatus,
  summary: string,
  executionControl: TicketExecutionControlRecord,
  dependencyIds: string[] = [],
): TicketRecord {
  return {
    id: definition.id,
    operationId: definition.operation_registry_id,
    title: definition.title,
    summary,
    status,
    executionPolicyBinding: bind(catalog, definition.operation_registry_id),
    executionControl,
    priority: -(definition.rule_priority * 1_000 + definition.operation_dispatch_priority),
    dependencyIds,
    targetNodeIds: [...definition.target_node_ids],
    readNodeIds: [...definition.scope.read_node_ids],
    writeNodeIds: [...definition.scope.write_node_ids],
    readPaths: [...definition.scope.read_paths],
    writePaths: [...definition.scope.write_paths],
    steps: definition.workflow.map((step) => ({
      id: step.id,
      title: stepTitle(step.id),
      personaId: step.persona_id,
      kind: step.kind,
      dependsOn: [...step.depends_on],
      ...(step.read_node_ids === undefined ? {} : { readNodeIds: [...step.read_node_ids] }),
      ...(step.write_node_ids === undefined ? {} : { writeNodeIds: [...step.write_node_ids] }),
      ...(step.read_paths === undefined ? {} : { readPaths: [...step.read_paths] }),
      ...(step.write_paths === undefined ? {} : { writePaths: [...step.write_paths] }),
      ...(step.validation_action === undefined ? {} : { validationAction: step.validation_action }),
      executionPolicyBinding: bind(catalog, definition.operation_registry_id, step.id),
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
    createdAt: AT,
    updatedAt: AT,
  };
}

function ordinaryTicket(
  catalog: CompiledExecutionSemanticCatalog,
  id: string,
  status: TicketStatus,
  nodes: string[],
  readPaths: string[],
  writePaths: string[],
): TicketRecord {
  const ticket: TicketRecord = {
    id,
    operationId: "ordinary",
    title: id,
    summary: `Ordinary source ${id}`,
    status,
    executionPolicyBinding: bind(catalog, "ordinary"),
    executionControl: {},
    priority: 0,
    dependencyIds: [],
    targetNodeIds: [...nodes],
    readNodeIds: [...nodes],
    writeNodeIds: [...nodes],
    readPaths: [...readPaths],
    writePaths: [...writePaths],
    steps: [
      {
        id: "work",
        title: "Work",
        personaId: "worker",
        kind: "production",
        dependsOn: [],
        readNodeIds: [...nodes],
        writeNodeIds: [...nodes],
        readPaths: [...readPaths],
        writePaths: [...writePaths],
        validationAction: "compile",
        executionPolicyBinding: bind(catalog, "ordinary", "work"),
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
    createdAt: AT,
    updatedAt: AT,
  };
  return ticket;
}

function controlDefinition(
  catalog: CompiledExecutionSemanticCatalog,
  input: Readonly<{
    id: string;
    operationId: string;
    title: string;
    targetNodeIds: string[];
    readNodeIds: string[];
    writeNodeIds: string[];
    readPaths: string[];
    writePaths: string[];
    ruleId: string;
    validationAction?: string;
  }>,
): DerivedTicketDefinition {
  const operation = catalog.operations[input.operationId]!;
  const workflow = catalog.workflows[operation.workflowId!]!;
  const steps: DerivedWorkflowStep[] = workflow.steps.map((semantic, index) => ({
    id: semantic.id,
    kind: index === workflow.steps.length - 1 ? "review" : "production",
    persona_id: index === workflow.steps.length - 1 ? "reviewer" : "worker",
    depends_on: index === 0 ? [] : [workflow.steps[index - 1]!.id],
    required: true,
    read_node_ids: [...input.readNodeIds],
    write_node_ids: [...input.writeNodeIds],
    read_paths: [...input.readPaths],
    write_paths: [...input.writePaths],
    expected_outputs: [index === workflow.steps.length - 1 ? "Reviewed result" : "Prepared result"],
    graph_mutation: input.writeNodeIds.length === 0 ? "forbidden" : "allowed",
    validation_action: input.validationAction ?? "compile",
    required_receipts: [...semantic.requiredReceipts],
    escalation_triggers: [...semantic.escalationTriggers],
    stop_conditions: [...semantic.stopConditions],
    validation_checks: [...semantic.validationChecks],
    context_sha256: digest(`${input.id}-${semantic.id}-context`),
  }));
  const material = {
    protocol: "koni.derived-ticket.v1" as const,
    id: input.id,
    rule_id: input.ruleId,
    rule_phase: operation.stage,
    rule_priority: 0,
    anchor_node_id: input.targetNodeIds[0] ?? input.id,
    operation: operation.publicOperation,
    operation_registry_id: operation.id,
    operation_dispatch_priority: 0,
    ranking_hints: [] as string[],
    title: input.title,
    target_node_ids: [...input.targetNodeIds],
    scope: {
      read_node_ids: [...input.readNodeIds],
      write_node_ids: [...input.writeNodeIds],
      read_paths: [...input.readPaths],
      write_paths: [...input.writePaths],
    },
    source_state_key: "control-source",
    target_state_key: "control-target",
    obligation_keys: [digest(`${input.id}-obligation`)],
    workflow_id: workflow.id,
    review_failure_reopen_from: steps[0]!.id,
    workflow: steps,
    configuration_sha256: catalog.configurationSha256,
  };
  return { ...material, definition_sha256: canonicalHash(material) };
}

async function addSuccessAttempt(
  run: RunRecord,
  ticket: TicketRecord,
  stepIndex: number,
  attemptId: string,
  input: Readonly<{ changeControlSha256?: Sha256Digest }>,
): Promise<TerminalSuccessSettlementProof> {
  const step = ticket.steps[stepIndex]!;
  const terminalPolicy = terminalPolicyFor(attemptId);
  const terminalOutputSha256 = digest(`${attemptId}-output`);
  run.attempts[attemptId] = attemptRecord(
    ticket,
    step.id,
    attemptId,
    terminalPolicy,
    terminalOutputSha256,
  );
  step.status = "completed";
  step.attemptIds = [attemptId];
  step.summary = "Completed exact compiler-authorized work";
  step.startedAt = AT;
  step.completedAt = AT;
  const semanticResult = {
    kind: "assignment" as const,
    status: "completed" as const,
    summary: "Completed exact compiler-authorized work",
    ...(input.changeControlSha256 === undefined
      ? {}
      : { changeControlSha256: input.changeControlSha256 }),
  };
  const prepared = prepareRunActionExecution(run, {
    kind: "assignment_validation",
    stageId: run.currentPipelineStageId!,
    selector: step.validationAction!,
    checkout: "none",
    ticketId: ticket.id,
    ticketState: ticket.status,
    stepId: step.id,
    attemptId,
    at: AT,
  });
  const journal = await executeActionPlan(prepared.plan, { execute: async () => null });
  const action: RunActionExecutionRecord = {
    ...structuredClone(prepared),
    journal,
    semanticResult,
    updatedAt: AT,
  };
  action.settlement = createRunActionSettlement(
    action,
    "completed",
    "compiler accepted exact assignment",
    AT,
  );
  action.settledAt = action.settlement.settledAt;
  run.actionExecutions ??= {};
  run.actionExecutions[action.invocationId] = action;
  const proof = createTerminalSuccessSettlementProof(run, action);
  if (proof === undefined) throw new Error("fixture failed to derive terminal success proof");
  run.terminalSuccessProofs ??= {};
  run.terminalSuccessProofs[proof.sha256] = proof;
  return proof;
}

async function addFailureAttempt(
  run: RunRecord,
  ticket: TicketRecord,
  stepIndex: number,
  attemptId: string,
): Promise<TerminalFailureSettlementProof> {
  const step = ticket.steps[stepIndex]!;
  const terminalPolicy = terminalPolicyFor(attemptId);
  const terminalOutputSha256 = digest(`${attemptId}-output`);
  run.attempts[attemptId] = attemptRecord(
    ticket,
    step.id,
    attemptId,
    terminalPolicy,
    terminalOutputSha256,
  );
  step.status = "failed";
  step.attemptIds = [attemptId];
  step.summary = "Configured validation failed";
  step.startedAt = AT;
  step.completedAt = AT;
  const semanticResult = {
    kind: "assignment" as const,
    status: "failed" as const,
    blocker: "Configured validation failed",
  };
  const prepared = prepareRunActionExecution(run, {
    kind: "assignment_validation",
    stageId: run.currentPipelineStageId!,
    selector: step.validationAction!,
    checkout: "none",
    ticketId: ticket.id,
    ticketState: ticket.status,
    stepId: step.id,
    attemptId,
    at: AT,
  });
  const journal = await executeActionPlan(prepared.plan, { execute: async () => null });
  const action: RunActionExecutionRecord = {
    ...structuredClone(prepared),
    journal,
    semanticResult,
    updatedAt: AT,
  };
  action.settlement = createRunActionSettlement(
    action,
    "failed",
    "compiler rejected exact assignment",
    AT,
  );
  action.settledAt = action.settlement.settledAt;
  run.actionExecutions ??= {};
  run.actionExecutions[action.invocationId] = action;
  const proof = createTerminalFailureSettlementProof(run, action);
  if (proof === undefined) throw new Error("fixture failed to derive terminal failure proof");
  run.terminalFailureProofs ??= {};
  run.terminalFailureProofs[proof.sha256] = proof;
  return proof;
}

function attemptRecord(
  ticket: TicketRecord,
  stepId: string,
  attemptId: string,
  terminalPolicy: ReturnType<typeof terminalPolicyFor>,
  terminalOutputSha256: Sha256Digest,
) {
  return {
    id: attemptId,
    sessionId: `session-${attemptId}`,
    sessionFile: `/tmp/koni-control-ticket-authority/${attemptId}.jsonl`,
    ticketId: ticket.id,
    stepId,
    personaId: ticket.steps.find((step) => step.id === stepId)!.personaId,
    modelProvider: "fixture",
    modelId: "fixture-model",
    thinkingLevel: "off",
    status: "completed" as const,
    launchSpecHash: digest(`${attemptId}-launch`),
    startedAt: AT,
    endedAt: AT,
    terminalSummary: "Fixture terminal result",
    terminalOutputSha256,
    terminalOutputSizeBytes: 32,
    terminalAcceptedAt: terminalPolicy.acceptedAt,
    terminalPolicy,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    kind: "ticket" as const,
  };
}

function terminalPolicyFor(attemptId: string) {
  const material = {
    protocol: "koni.agent-terminal-policy.v1" as const,
    mode: "legacy_pre_execution_policy" as const,
    acceptedAt: AT,
  };
  void attemptId;
  return { ...material, sha256: canonicalHash(material) };
}

function baseRun(catalog: CompiledExecutionSemanticCatalog): RunRecord {
  const projectRoot = "/tmp/koni-control-ticket-authority";
  const behavior = runBehaviorSnapshotFixture("large", "control-ticket-authority");
  return {
    protocol: "koni.run-record.v1",
    id: "run-control-authority",
    revision: 0,
    generation: 0,
    projectRoot,
    profile: {
      packageName: "@koni/research-profile",
      packageVersion: "1.1.0",
      lineage: "koni.research",
      bundleHash: digest("bundle"),
    },
    compiledConfigHash: catalog.configurationSha256,
    runTypeId: "large",
    objective: "Prove canonical control-ticket authority",
    intake: { goal: "Prove canonical control-ticket authority" },
    createdAt: AT,
    updatedAt: AT,
    lifecycle: newRunLifecycle("run-control-authority"),
    behavior,
    pipelineStageIds: behavior.runType.pipeline.map((stage) => stage.id),
    currentPipelineStageId: "orchestrate",
    plan: undefined,
    graphRevision: 0,
    graphHash: undefined,
    tickets: {},
    attempts: {},
    terminalFailureProofs: {},
    terminalSuccessProofs: {},
    questions: {},
    activity: [],
    git: fixtureRunGit(projectRoot, "run-control-authority", "approved"),
  };
}

function buildCatalog(): CompiledExecutionSemanticCatalog {
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
      "asset-resolution.asset.implement-asset": {
        id: "asset-resolution.asset.implement-asset",
        operation: "implement-recurring-asset",
        stage: "execution",
        workflow: "recurring-asset-flow",
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
      "ordinary-flow": workflow("ordinary-flow", "ordinary-work", ["work"]),
      "recurring-asset-flow": workflow("recurring-asset-flow", "implement-recurring-asset", [
        "work",
      ]),
      "proposal-flow": workflow("proposal-flow", "propose-change", ["prepare", "review"]),
      "application-flow": workflow("application-flow", "apply-change", ["prepare", "review"]),
      "resolver-flow": workflow("resolver-flow", "resolve-failure", ["prepare", "review"]),
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

function workflow(id: string, operation: string, steps: string[]) {
  return {
    id,
    version: "1.0.0",
    applies_to: [operation],
    steps: steps.map((step) => ({ id: step, required: true })),
  };
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
    workflowId: operation.workflowId!,
    ...(stepId === undefined ? {} : { stepId }),
  });
}

function unauthorizeRecurringAssetGrantRefresh(
  run: Readonly<RunRecord>,
  sourceTicketId: string,
  actionInvocationId: string,
): RunRecord {
  const next = structuredClone(run);
  const source = next.tickets[sourceTicketId];
  const action = next.actionExecutions?.[actionInvocationId];
  if (source === undefined || action === undefined) {
    throw new Error("fixture recurring-asset refresh authority is incomplete");
  }
  delete source.executionControl?.recurringAssetGrantRefreshes;
  delete action.semanticResult;
  action.effects = {};
  return next;
}

function authorizeRecurringAssetGrantRefresh(
  previous: Readonly<RunRecord>,
  next: RunRecord,
  actionInvocationId: string,
  effect: "preferred" | "nonpreferred" = "preferred",
): void {
  const action = next.actionExecutions?.[actionInvocationId];
  const priorAction = previous.actionExecutions?.[actionInvocationId];
  if (action === undefined || priorAction === undefined || next.graphHash === undefined) {
    throw new Error("fixture recurring-asset refresh action is incomplete");
  }
  action.updatedAt = next.updatedAt;
  const refreshSha256s = appendRecurringAssetGrantRefreshAuthorities(
    previous,
    next.tickets,
    priorAction,
    next.graphHash,
    next.graphRevision,
    next.updatedAt,
  );
  action.semanticResult = {
    kind: "assignment",
    status: "completed",
    summary: "Applied the graph change that refreshed the recurring asset grant",
    recurringAssetGrantRefreshSha256s: refreshSha256s,
  };
  const preferredStep = ["check.run", "review.validate", "rules.evaluate", "project.validate"]
    .map((primitive) => action.plan.recipe.find((step) => step.primitive === primitive))
    .find((step) => step !== undefined);
  if (preferredStep === undefined) throw new Error("fixture action has no semantic step");
  const receiptStep =
    effect === "preferred"
      ? preferredStep
      : action.plan.recipe.find((step) => step.id !== preferredStep.id);
  if (receiptStep === undefined) throw new Error("fixture action has no nonpreferred step");
  const effectKey = `${action.invocationId}:recipe:${receiptStep.id}:${action.plan.sha256}`;
  action.effects[effectKey] = createRunActionEffectReceipt(
    {
      invocationId: action.invocationId,
      planSha256: action.plan.sha256,
      effectKey,
      actionId: action.plan.actionId,
      actor: action.plan.actor,
      phase: "recipe",
      step: receiptStep,
      context: action.plan.context,
    },
    { recurringAssetGrantRefreshSha256s: refreshSha256s },
    next.updatedAt,
  );
}

function reprojectAttackerAuthority(ticket: TicketRecord): void {
  const authority = ticket.executionControl!.controlTicketAuthority!;
  const projection = ticketImmutableProjection(ticket);
  (authority as unknown as Record<string, unknown>).projection = projection;
  (authority as unknown as Record<string, unknown>).projectionSha256 = projection.sha256;
  rehashAuthority(authority);
}

function rehashAuthority(authority: CompilerControlTicketAuthority): void {
  rehashNested(authority as unknown as Record<string, unknown>, "sha256");
}

function rehashNested(value: Record<string, unknown>, field: string): void {
  const material = { ...value };
  delete material[field];
  value[field] = canonicalHash(material);
}

function controlTitle(prefix: string, summary: string): string {
  return `${prefix}: ${summary.trim().split(/\r?\n/u)[0] ?? summary.trim()}`.slice(0, 240);
}

function stepTitle(value: string): string {
  return value
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function digest(label: string): Sha256Digest {
  return canonicalHash({ label });
}
