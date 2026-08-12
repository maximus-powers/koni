import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { discoverAuthorityEndpoint } from "../src/authority/endpoint.js";
import { snapshotContainedPaths } from "../src/authority/process-runner.js";
import type { TransactionWrite } from "../src/authority/file-journal.js";
import { decideBoundCheckRetry } from "../src/authority/execution-policy.js";
import {
  assetImplementationFilesMaterialized,
  approvedProposalAuditSteering,
  approvedApplicationAuditSteering,
  approvedProposalAttemptInstructions,
  approvedApplicationGraphOnlyReviewInstruction,
  approvedChangeObligationInstructions,
  approvedChangeObligationsForTargets,
  approvedChangeObligationsForAttempt,
  assetImplementationFallbackEligible,
  assertApprovedChangeRuntimeObligations,
  assertFailedReviewDoesNotContradictApprovedChangeRuntimeObligations,
  assertAssetImplementationObligationsPreserved,
  assertAssetGateContractsBoundToGraph,
  assertRunPlanObligationsPreserved,
  assertRunPlanUsesRepositoryOwnedArgv,
  assertTicketDefinitionStable,
  commandInfrastructureFailure,
  currentNonpassingGateRepairEvidenceRequests,
  effectiveAssignmentWriteScope,
  experimentBoundaryBlockedGateProviderNodeIds,
  existingStandaloneSupportRunForUpstreamRequest,
  gateProviderRepairScopeFallback,
  gatePolicyCommandSubjectIds,
  gateRepairEvidenceTargetNodeIds,
  gateRepairInstruction,
  graphDeltaReviewCandidateNodeIds,
  generatedAssetImplementationReadPaths,
  hasExistingAssetImplementationTicket,
  hasManifestScopedDirectGateRecheck,
  manifestScopedDirectGateRechecks,
  implementAssetReviewManifestInstruction,
  implementationWriteGrantInstructions,
  loadedSkillResourceFromReceipt,
  NativeRunCompilerProgram,
  NativeRunProgramError,
  orderedReviewPredecessorStepIds,
  plannedAssetRepairProposalTargetNodeIds,
  plannedAssetRepairHistoryForAttempt,
  plannedAssetRepairRequestForNode,
  routablePlannedAssetRepairProposalIds,
  routePlannedAssetRepairProposals,
  routeSupersededGateRunProposals,
  refreshSettledRecurringAssetTicketGrant,
  reopenCompletedRecurringAssetTicket,
  recurringAssetHasUnaddressedGateFailure,
  recurringAssetHasUnaddressedStandaloneRunFailure,
  recurringAssetReviewReworkPending,
  recurringAssetRequiresReissue,
  rejectedSourceProposalInstructions,
  restoreSettledRecurringAssetTicket,
  shouldAttachCurrentGateRepairEvidence,
  shouldAttachPredecessorExecution,
  shouldAssertApprovedChangeRuntimeObligations,
  scientificRunTicketDefinitions,
  standaloneSupportRunAssetNodeIds,
  standaloneSupportRunAssetRepairInstruction,
  standaloneSupportRunAssetRepairScopeFallback,
  ticketBoardApplicableTicketDefinitions,
  upstreamChangeRequestInstructions,
  verificationActionableTicketDefinitions,
  reconcileNeverStartedTicketNodeScope,
  remapPlanningSeedGateContractKeys,
  rebindRuleEvidenceAcrossNonInterferingGraphChange,
  repairedProviderDirectGateReadNodeIds,
  repairedProviderBlockedDirectGateNodeIds,
  repairedProviderGateRecheckInstruction,
  replaceGateRunDefinitionsWithManifestRechecks,
  researchRunContractScopeFallback,
  resolveConfiguredOperationReference,
  resolvePinnedGateAutoEvaluationContexts,
} from "../src/compiler/run-program.js";
import {
  type HistoricalBehaviorCompatibilityError,
  assertHistoricalBehaviorMatchesRun,
  projectHistoricalCompiledBehavior,
} from "../src/compiler/historical-behavior.js";
import { compileProjectDirectory } from "../src/compiler/project-directory.js";
import type { PiResolvedInventory } from "../src/pi/agent-configuration.js";
import {
  projectGatePolicyDefinitions,
  projectGraphSchemaDefinition,
} from "../src/compiler/graph-schema.js";
import {
  RULE_AUTHORITY_EVIDENCE_PROTOCOL,
  createRuleAuthorityEvidence,
  ruleInputGraphSha256,
  rulePredicateEvidenceKey,
} from "../src/compiler/domain-adapter.js";
import {
  computeProfileBundleSha256,
  type VerifiedProfileBaseline,
} from "../src/compiler/profile-package.js";
import type {
  ProfileBaselineFile,
  ProfilePackageManifest,
} from "../src/contracts/profile-package.js";
import type { CompiledConfiguration, ConfigurationObject } from "../src/contracts/configuration.js";
import type {
  CompiledChangeControl,
  CompiledExecutionSemanticCatalog,
} from "../src/compiler/execution-semantics.js";
import { GraphSchema, TypedGraph, type GraphNode } from "../src/graph/model.js";
import type { AgentLaunchSpec } from "../src/pi/launch-spec.js";
import { fixtureLaunchSpec, fixtureResource } from "./pi-managed-fixtures.js";
import type { JsonValue } from "../src/authority/protocol.js";
import {
  canonicalEncode,
  canonicalHash,
  rawSha256,
  type Sha256Digest,
} from "../src/shared/canonical.js";
import { installProfile, loadProfilePackage } from "../src/profile/install.js";
import { newRunLifecycle, reduceRunLifecycle } from "../src/state/run-lifecycle.js";
import {
  deriveApprovedChangeMaterialization,
  deriveTerminalResolverReconciliation,
} from "../src/state/change-control.js";
import {
  assertRunRecord,
  terminalFailureBindingFromProof,
  type AgentAttemptRecord,
  type RunQuestionRecord,
  type RunRecord,
  type TicketRecord,
  type TerminalFailureSettlementProof,
  type TerminalSuccessSettlementProof,
} from "../src/state/run-record.js";
import type { CompiledRuleEvaluation, DerivedTicketDefinition } from "../src/contracts/rules.js";
import type { ReadyAssignment } from "../src/state/scheduler.js";
import { attachFixtureTicketCycle, fixtureRunGit } from "./run-record-fixtures.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const temporaryRoots: string[] = [];
const FIXED_NOW = new Date("2026-07-16T19:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("native compiler-authoritative run program", () => {
  it("retains only complete accepted skill reads in the compaction ledger", () => {
    const content = "---\nname: durable-skill\ndescription: Durable procedure\n---\nApply it.";
    const skill = fixtureResource(
      "skill",
      "skill-durable",
      "skills/durable-skill/SKILL.md",
      content,
    );
    const prompt = fixtureResource("prompt", "prompt-durable", "prompts/durable.md", content);
    const spec = fixtureLaunchSpec({
      cwd: "/tmp/koni-loaded-skill",
      sessionDirectory: "/tmp/koni-loaded-skill/sessions",
      resources: [skill, prompt],
    });
    const accepted = {
      protocol: "koni.tool-receipt.v1" as const,
      receiptId: "receipt-durable-skill",
      outcome: "accepted" as const,
      summary: "Read resource skill-durable",
      value: {
        resourceId: skill.id,
        relativePath: skill.relativePath,
        sha256: skill.sha256,
        offsetChars: 0,
        nextOffsetChars: Array.from(content).length,
        totalChars: Array.from(content).length,
        eof: true,
        content,
      },
    };
    const record = { toolName: "koni_read_resource", outcome: "accepted" };

    expect(loadedSkillResourceFromReceipt(record, accepted, spec)).toBe(
      `${skill.relativePath} (${skill.sha256})`,
    );
    const rejectedReceipt = {
      protocol: "koni.tool-receipt.v1" as const,
      receiptId: "receipt-rejected-skill",
      outcome: "rejected" as const,
      code: "resource_scope",
      summary: "Rejected resource read",
    };
    const excluded: Array<[string, { toolName: string; outcome: string }, unknown]> = [
      ["rejected authority result", { ...record, outcome: "rejected" }, accepted],
      ["rejected receipt", record, rejectedReceipt],
      [
        "partial skill read",
        record,
        {
          ...accepted,
          value: {
            ...accepted.value,
            eof: false,
            nextOffsetChars: 10,
            content: content.slice(0, 10),
          },
        },
      ],
      [
        "prompt resource",
        record,
        {
          ...accepted,
          value: {
            ...accepted.value,
            resourceId: prompt.id,
            relativePath: prompt.relativePath,
            sha256: prompt.sha256,
          },
        },
      ],
      [
        "mismatched identity",
        record,
        { ...accepted, value: { ...accepted.value, relativePath: "skills/other/SKILL.md" } },
      ],
      ["different tool", { toolName: "koni_read_file", outcome: "accepted" }, accepted],
    ];
    for (const [label, candidateRecord, receipt] of excluded) {
      expect(loadedSkillResourceFromReceipt(candidateRecord, receipt, spec), label).toBeUndefined();
    }
  });

  it("carries source-proposal audit steering into its approved application", () => {
    const approvalSha256 = digest("approved-proposal");
    const requestSha256 = digest("proposal-request");
    const run = {
      tickets: {
        "TK-change": {
          id: "TK-change",
          executionControl: {
            proposalApprovalSha256: approvalSha256,
            proposalDecisionHistory: [
              {
                protocol: "koni.proposal-decision-authority.v2",
                runId: "run-one",
                proposalTicketId: "TK-change",
                requestSha256,
                eventId: "proposal-approval",
                decision: "approval",
                actor: "operator",
                recordedAt: "2026-07-16T19:00:00.000Z",
                sha256: approvalSha256,
              },
              {
                protocol: "koni.proposal-decision-authority.v2",
                runId: "run-one",
                proposalTicketId: "TK-change",
                requestSha256,
                eventId: "proposal-steering",
                decision: "rejection",
                actor: "operator",
                message: "Do not create a semantic gate node.",
                recordedAt: "2026-07-16T19:01:00.000Z",
                sha256: digest("proposal-steering"),
              },
            ],
          },
        },
        "TK-application": {
          id: "TK-application",
          executionControl: { sourceProposalTicketId: "TK-change" },
        },
      },
    } as unknown as Pick<RunRecord, "tickets">;

    expect(approvedApplicationAuditSteering(run, run.tickets["TK-application"]!)).toEqual([
      "Operator audit-only steering after approval (does not revoke approval): Do not create a semantic gate node.",
    ]);
  });

  it("projects later proposal audit messages as non-revoking operator steering", () => {
    const approvalSha256 = digest("approved-proposal");
    const requestSha256 = digest("proposal-request");
    const history = [
      {
        protocol: "koni.proposal-decision-authority.v2" as const,
        runId: "run-one",
        proposalTicketId: "TK-change-one",
        requestSha256,
        eventId: "proposal-approval",
        decision: "approval" as const,
        actor: "operator",
        message: "Approve the bounded repair.",
        recordedAt: "2026-07-16T19:00:00.000Z",
        sha256: approvalSha256,
      },
      {
        protocol: "koni.proposal-decision-authority.v2" as const,
        runId: "run-one",
        proposalTicketId: "TK-change-one",
        requestSha256,
        eventId: "proposal-steering",
        decision: "rejection" as const,
        actor: "operator",
        message: "Create no semantic gate node; edit the existing asset contract only.",
        recordedAt: "2026-07-16T19:01:00.000Z",
        sha256: digest("proposal-steering"),
      },
    ];

    expect(approvedProposalAuditSteering(history, approvalSha256)).toEqual([
      "Operator audit-only steering after approval (does not revoke approval): Create no semantic gate node; edit the existing asset contract only.",
    ]);
  });

  it("keeps approved proposal selection and pre-application review instructions stage-bound", () => {
    const selectionInstructions = approvedProposalAttemptInstructions({
      approved: true,
      proposalStepId: "propose-graph-delta",
      stepId: "propose-graph-delta",
      stepKind: "integration",
      applicationOperations: ["apply-change-request", "no-op"],
    });
    expect(selectionInstructions.join(" ")).toContain(
      "submit the exact authorized changeApplication",
    );
    expect(selectionInstructions.join(" ")).toContain(
      'Use changeApplication.operation "apply-change-request" or "no-op"',
    );
    expect(selectionInstructions.join(" ")).toContain(
      "This proposal-selection step is intentionally read-only",
    );
    expect(selectionInstructions.join(" ")).toContain(
      "the separately materialized application ticket",
    );

    const reviewInstructions = approvedProposalAttemptInstructions({
      approved: true,
      proposalStepId: "propose-graph-delta",
      stepId: "risk-review",
      stepKind: "review",
      applicationOperations: ["apply-change-request", "no-op"],
    });
    expect(reviewInstructions.join(" ")).toContain("pre-application review");
    expect(reviewInstructions.join(" ")).toContain(
      "Do not reject the selection merely because the requested state is still unsatisfied",
    );
    expect(reviewInstructions.join(" ")).not.toContain(
      "submit the exact authorized changeApplication",
    );
    expect(
      approvedProposalAttemptInstructions({
        approved: true,
        proposalStepId: "propose-graph-delta",
        stepId: "scope-change",
        stepKind: "integration",
        applicationOperations: ["apply-change-request", "no-op"],
      }),
    ).toEqual([]);
  });

  it("does not impose settled application postconditions on proposal-control attempts", () => {
    const run = {
      tickets: {
        "TK-application": {
          id: "TK-application",
          status: "completed",
          summary: "Author the requested artifact before the gate runs again.",
          targetNodeIds: ["gate-target"],
          executionControl: {
            approvedApplicationSha256: digest("approved-application"),
            controlTicketAuthority: { role: "approved_application" },
          },
        },
      },
    } as unknown as RunRecord;

    expect(approvedChangeObligationsForAttempt(run, ["gate-target"], "proposal")).toEqual([]);
    expect(approvedChangeObligationsForAttempt(run, ["gate-target"], "application")).toHaveLength(
      1,
    );
    expect(approvedChangeObligationsForAttempt(run, ["gate-target"], "ordinary")).toHaveLength(1);
  });

  it("carries an in-flight approved request into the source-owning repair attempt", () => {
    const exactRequest =
      "Add verify_development_split.py for model_zoo/classification_training/data_loader.py; create no semantic gate node.";
    const run = {
      tickets: {
        "TK-change": {
          id: "TK-change",
          status: "completed",
          summary: exactRequest,
          targetNodeIds: ["asset-signature"],
          executionControl: {
            proposalApprovalSha256: digest("source-approval"),
            proposalDecisionHistory: [
              {
                protocol: "koni.proposal-decision-authority.v2",
                runId: "run-one",
                proposalTicketId: "TK-change",
                requestSha256: digest("source-request"),
                eventId: "approve-source",
                decision: "approval",
                actor: "operator",
                recordedAt: "2026-07-16T19:00:00.000Z",
                sha256: digest("source-approval"),
              },
              {
                protocol: "koni.proposal-decision-authority.v2",
                runId: "run-one",
                proposalTicketId: "TK-change",
                requestSha256: digest("source-request"),
                eventId: "steer-source",
                decision: "rejection",
                actor: "operator",
                message: "Do not create a semantic gate node.",
                recordedAt: "2026-07-16T19:01:00.000Z",
                sha256: digest("source-steering"),
              },
            ],
          },
        },
        "TK-application": {
          id: "TK-application",
          status: "queued",
          summary: "Apply the approved asset metadata repair.",
          targetNodeIds: ["asset-signature"],
          steps: [
            { id: "inspect-approved-change", status: "completed" },
            { id: "apply-approved-delta", status: "pending" },
            { id: "verify", status: "pending" },
          ],
          executionControl: {
            sourceProposalTicketId: "TK-change",
            approvedApplicationSha256: digest("in-flight-application"),
            controlTicketAuthority: { role: "approved_application" },
          },
        },
      },
    } as unknown as RunRecord;

    expect(approvedChangeObligationsForTargets(run, ["asset-signature"])).toEqual([]);
    const obligations = approvedChangeObligationsForAttempt(run, ["asset-signature"], "ordinary");
    expect(obligations).toEqual([
      expect.objectContaining({
        ticketId: "TK-application",
        summary: exactRequest,
        inFlight: true,
      }),
    ]);
    expect(approvedChangeObligationInstructions(obligations[0]!).join(" ")).toContain(
      "currently applying",
    );
    expect(approvedChangeObligationInstructions(obligations[0]!).join(" ")).toContain(
      "classification_training/data_loader.py",
    );
    expect(approvedChangeObligationInstructions(obligations[0]!).join(" ")).toContain(
      "Do not create a semantic gate node.",
    );
  });

  it("keeps independent review authority read-only even when the ticket scope is writable", () => {
    expect(
      effectiveAssignmentWriteScope({
        stepKind: "review",
        graphMutation: "allowed",
        writePaths: ["program/assets/signature_analysis"],
        writeNodeIds: ["asset-signature"],
      }),
    ).toEqual({ graphMutation: "forbidden", writePaths: [], writeNodeIds: [] });

    expect(
      effectiveAssignmentWriteScope({
        stepKind: "production",
        graphMutation: "allowed",
        writePaths: ["program/assets/signature_analysis"],
        writeNodeIds: ["asset-signature"],
      }),
    ).toEqual({
      graphMutation: "allowed",
      writePaths: ["program/assets/signature_analysis"],
      writeNodeIds: ["asset-signature"],
    });
  });

  it("tells reviewers to reject unsatisfied approved obligations instead of repairing them", () => {
    const durable = approvedChangeObligationInstructions(
      {
        ticketId: "TK-application",
        approvedApplicationSha256: digest("approved-application"),
        targetNodeIds: ["asset-signature"],
        summary: "Implement the exact approved verifier.",
      },
      "review",
    ).join(" ");
    expect(durable).toContain("reject it with a precise repair blocker");
    expect(durable).toContain("Do not edit files or graph nodes during independent review");
    expect(durable).not.toContain("repair them within this ticket's grant");

    const inFlight = approvedChangeObligationInstructions(
      {
        ticketId: "TK-application",
        approvedApplicationSha256: digest("in-flight-application"),
        targetNodeIds: ["asset-signature"],
        summary: "Implement the exact approved verifier.",
        inFlight: true,
      },
      "review",
    ).join(" ");
    expect(inFlight).toContain("binding review criteria");
    expect(inFlight).toContain("Do not edit files or graph nodes during independent review");
  });

  it("keeps graph-only application review focused on the semantic delta", () => {
    const instruction = approvedApplicationGraphOnlyReviewInstruction({
      operationRole: "application",
      stepKind: "review",
      readPaths: [],
    });

    expect(instruction).toContain("graph-only application review");
    expect(instruction).toContain("Past diagnostic prose");
    expect(instruction).toContain("source-owning filesystem workflow");
    expect(instruction).toContain("Do not reject");
    expect(
      approvedApplicationGraphOnlyReviewInstruction({
        operationRole: "ordinary",
        stepKind: "review",
        readPaths: [],
      }),
    ).toBeUndefined();
    expect(
      approvedApplicationGraphOnlyReviewInstruction({
        operationRole: "application",
        stepKind: "review",
        readPaths: ["program/assets/signature_analysis"],
      }),
    ).toBeUndefined();
  });

  it("tells asset reviewers that approval atomically refreshes a stale predecessor manifest", () => {
    const instruction = implementAssetReviewManifestInstruction("implement-asset", "review");

    expect(instruction).toContain("current scoped filesystem bytes");
    expect(instruction).toContain("do not reject solely");
    expect(instruction).toContain("compiler atomically derives and publishes the current manifest");
    expect(
      implementAssetReviewManifestInstruction("implement-asset", "production"),
    ).toBeUndefined();
    expect(implementAssetReviewManifestInstruction("compile-run-plan", "review")).toBeUndefined();
  });

  it("does not let a recurring gate provider relabel an unchanged blocker as a repair", () => {
    const instruction = gateRepairInstruction(1);

    expect(instruction).toContain("Changing diagnostic wording, labels, or cause categories");
    expect(instruction).toContain("does not repair an unchanged nonpassing condition");
    expect(instruction).toContain("raise the smallest upstream change request in this attempt");
    expect(instruction).toContain("application write scope is exactly its targetNodeIds");
    expect(instruction).toContain("target the existing source-owning asset node");
    expect(instruction).toContain(
      "commands[].result measurements are authenticated causal outputs",
    );
    expect(instruction).toContain("use those exact values instead of demanding another execution");
    expect(instruction).toContain(
      'An upstream change request is a successful handoff: submit it with status "completed", never status "failed"',
    );
    expect(gateRepairInstruction(0)).toBeUndefined();
  });

  it("keeps implementation write instructions consistent with the compiled tool grant", () => {
    const withoutChecks = implementationWriteGrantInstructions(true, 0).join(" ");
    expect(withoutChecks).not.toContain("Run the configured proof");
    expect(withoutChecks).toContain("koni_run_check is intentionally absent");
    expect(withoutChecks).toContain("No configured command proof is available");

    const withChecks = implementationWriteGrantInstructions(true, 1).join(" ");
    expect(withChecks).toContain("koni_run_check");
    expect(withChecks).toContain("configured proof");
  });

  it("makes a standalone runtime repair supersede stale no-op obligations", () => {
    const instruction = standaloneSupportRunAssetRepairInstruction(
      "compiler.compatibility.standalone-support-run-asset-repair-scope",
    );

    expect(instruction).toContain("supersedes older statements");
    expect(instruction).toContain("Preserve the authored thresholds");
    expect(instruction).toContain("improve the source implementation");
    expect(instruction).toContain("downstream standalone runtime rerun supplies validation");
    expect(
      standaloneSupportRunAssetRepairInstruction("configured.asset-implementation"),
    ).toBeUndefined();
  });

  it("routes a still-nonpassing repaired-provider gate recheck to causal repair", () => {
    const instruction = repairedProviderGateRecheckInstruction(
      "gates.gate.run-gate",
      "direct-scientific-gate-blocked-after-provider-repair",
      "analyze",
    );

    expect(instruction).toContain("Do not stop at receipt interpretation or another observation");
    expect(instruction).toContain("raise the smallest upstream change request in this attempt");
    expect(
      repairedProviderGateRecheckInstruction(
        "gates.gate.run-gate",
        "gate-missing-current-terminal-verdict",
        "analyze",
      ),
    ).toBeUndefined();
    expect(
      repairedProviderGateRecheckInstruction(
        "gates.gate.run-gate",
        "direct-scientific-gate-blocked-after-provider-repair",
        "run",
      ),
    ).toBeUndefined();
  });

  it("resolves a configured public operation reference to its pinned registry identity", () => {
    const catalog = {
      operations: {
        "integration.target.resolve-conflict": {
          id: "integration.target.resolve-conflict",
          publicOperation: "resolve-target-integration",
        },
      },
    } as unknown as CompiledExecutionSemanticCatalog;

    expect(resolveConfiguredOperationReference(catalog, "resolve-target-integration")).toBe(
      "integration.target.resolve-conflict",
    );
    expect(
      resolveConfiguredOperationReference(catalog, "integration.target.resolve-conflict"),
    ).toBe("integration.target.resolve-conflict");

    const ambiguous = {
      operations: {
        "integration.target.first": {
          id: "integration.target.first",
          publicOperation: "resolve-target-integration",
        },
        "integration.target.second": {
          id: "integration.target.second",
          publicOperation: "resolve-target-integration",
        },
      },
    } as unknown as CompiledExecutionSemanticCatalog;
    expect(() =>
      resolveConfiguredOperationReference(ambiguous, "resolve-target-integration"),
    ).toThrow(/does not uniquely resolve/u);
  });

  it("binds policy-backed check commands to pinned gates instead of the ticket asset", () => {
    expect(
      gatePolicyCommandSubjectIds(
        "gate-verifier",
        ["asset-verifier"],
        [
          { checkId: "gate-verifier", gateNodeId: "gate-b" },
          { checkId: "other-check", gateNodeId: "gate-ignored" },
          { checkId: "gate-verifier", gateNodeId: "gate-a" },
          { checkId: "gate-verifier", gateNodeId: "gate-b" },
        ],
      ),
    ).toEqual(["gate-a", "gate-b"]);
    expect(gatePolicyCommandSubjectIds("gate-verifier", ["gate-direct"], [])).toEqual([
      "gate-direct",
    ]);
  });

  it("refreshes queued ticket node scope before issuance while preserving issued scope", () => {
    const ticket = {
      status: "queued",
      targetNodeIds: ["metric-old"],
      readNodeIds: ["asset-existing", "metric-old"],
      writeNodeIds: ["metric-old"],
      worktreePath: undefined,
      branch: undefined,
      gitCycleId: undefined,
      steps: [
        {
          id: "write-contracts",
          status: "pending",
          attemptIds: [],
          readNodeIds: ["asset-existing", "metric-old"],
          writeNodeIds: ["metric-old"],
          startedAt: undefined,
          completedAt: undefined,
        },
      ],
    } as unknown as TicketRecord;
    const definition = {
      target_node_ids: ["metric-old"],
      scope: {
        read_node_ids: ["asset-existing", "gate-new", "metric-old"],
        write_node_ids: ["metric-old"],
      },
      workflow: [
        {
          id: "write-contracts",
          read_node_ids: ["asset-existing", "gate-new", "metric-old"],
          write_node_ids: ["metric-old"],
        },
      ],
    } as unknown as DerivedTicketDefinition;

    expect(reconcileNeverStartedTicketNodeScope(ticket, definition)).toBe(true);
    expect(ticket.readNodeIds).toEqual(["asset-existing", "gate-new", "metric-old"]);
    expect(ticket.steps[0]!.readNodeIds).toEqual(["asset-existing", "gate-new", "metric-old"]);

    ticket.status = "running";
    const laterDefinition = {
      ...definition,
      scope: {
        ...definition.scope,
        read_node_ids: [...definition.scope.read_node_ids, "gate-later"],
      },
      workflow: [
        {
          ...definition.workflow[0],
          read_node_ids: [...definition.workflow[0]!.read_node_ids!, "gate-later"],
        },
      ],
    } as unknown as DerivedTicketDefinition;
    expect(reconcileNeverStartedTicketNodeScope(ticket, laterDefinition)).toBe(false);
    expect(ticket.readNodeIds).not.toContain("gate-later");
    expect(ticket.steps[0]!.readNodeIds).not.toContain("gate-later");
  });

  it("does not reject a derived ticket when only its display title changes", () => {
    const ticket = {
      id: "TK-run",
      operationId: "execution.run.run-experiment",
      title: "run-experiment: Old run title",
      status: "running",
      targetNodeIds: ["run-one"],
      readNodeIds: ["run-one"],
      writeNodeIds: ["run-one"],
      readPaths: [],
      writePaths: [],
      steps: [
        {
          id: "run",
          personaId: "run-operator",
          kind: "production",
          dependsOn: [],
          status: "running",
          attemptIds: ["attempt-one"],
        },
      ],
    } as unknown as TicketRecord;
    const definition = {
      id: ticket.id,
      operation_registry_id: ticket.operationId,
      title: "run-experiment: Corrected run title",
      target_node_ids: ["run-one"],
      scope: {
        read_node_ids: ["run-one"],
        write_node_ids: ["run-one"],
        read_paths: [],
        write_paths: [],
      },
      workflow: [
        {
          id: "run",
          persona_id: "run-operator",
          kind: "production",
          depends_on: [],
        },
      ],
    } as unknown as DerivedTicketDefinition;

    expect(() => assertTicketDefinitionStable(ticket, definition)).not.toThrow();
  });

  it("materializes planning gate-contract aliases to their final gate ids", () => {
    const finalGateId = "gate-9d9a514b2b3b0d0a3d38";
    const nodes = remapPlanningSeedGateContractKeys(
      [
        {
          key: "asset.scope_verifier",
          type: "asset",
          title: "Scope verifier",
          spec: {
            gate_contracts: {
              "gate.decode_readiness": {
                protocol: "autoresearch.gate-result.v1",
                argv: ["python3", "program/assets/verify.py", "--gate-id", "gate.decode_readiness"],
              },
              "unrelated-key": { argv: ["false"] },
            },
          },
        },
      ],
      new Map([["gate.decode_readiness", finalGateId]]),
    );

    expect(nodes[0]!.spec.gate_contracts).toEqual({
      [finalGateId]: {
        protocol: "autoresearch.gate-result.v1",
        argv: ["python3", "program/assets/verify.py", "--gate-id", finalGateId],
      },
      "unrelated-key": { argv: ["false"] },
    });
  });

  it("does not reissue the generated-asset compatibility ticket after implementation settled", () => {
    const run = {
      tickets: {
        "TK-implemented": {
          operationId: "asset-resolution.asset.implement-asset",
          targetNodeIds: ["asset-verifier"],
          status: "completed",
        },
        "TK-cancelled": {
          operationId: "asset-resolution.asset.implement-asset",
          targetNodeIds: ["asset-cancelled"],
          status: "cancelled",
        },
      },
    } as unknown as Pick<RunRecord, "tickets">;

    expect(
      hasExistingAssetImplementationTicket(
        run,
        "asset-resolution.asset.implement-asset",
        "asset-verifier",
      ),
    ).toBe(true);
    expect(
      hasExistingAssetImplementationTicket(
        run,
        "asset-resolution.asset.implement-asset",
        "asset-cancelled",
      ),
    ).toBe(false);
  });

  it("does not treat a completed asset ticket as materializing newly declared files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "koni-asset-materialization-"));
    temporaryRoots.push(root);
    const assetRoot = path.join(root, "program", "assets", "review-verifier");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(path.join(assetRoot, "verify_review.py"), "print('ok')\n");

    const files = [
      "program/assets/review-verifier/verify_review.py",
      "program/assets/review-verifier/adapt_result.py",
    ];
    await expect(assetImplementationFilesMaterialized(root, files)).resolves.toBe(false);

    await writeFile(path.join(assetRoot, "adapt_result.py"), "");
    await expect(assetImplementationFilesMaterialized(root, files)).resolves.toBe(false);

    await writeFile(path.join(assetRoot, "adapt_result.py"), "print('adapted')\n");
    await expect(assetImplementationFilesMaterialized(root, files)).resolves.toBe(true);
  });

  it("grants generated asset repairs read-only access to declared support paths", () => {
    const node = {
      id: "asset-repair",
      spec: {
        support_paths: [
          "program/assets/prerequisite/build.py",
          "model_zoo/hypernet/paired_contrast.py",
          "program/assets/prerequisite/build.py",
        ],
      },
    } as unknown as GraphNode;

    expect(generatedAssetImplementationReadPaths(node, "program/assets/repair")).toEqual([
      "model_zoo/__init__.py",
      "model_zoo/hypernet/__init__.py",
      "model_zoo/hypernet/paired_contrast.py",
      "program/__init__.py",
      "program/assets/__init__.py",
      "program/assets/prerequisite/__init__.py",
      "program/assets/prerequisite/build.py",
      "program/assets/repair",
    ]);
  });

  it("does not let asset implementation erase declared file obligations", () => {
    const existing = {
      id: "asset-review-verifier",
      spec: {
        implementation_plan: {
          files: ["program/assets/review/verify.py", "program/assets/review/adapt.py"],
        },
        implementation: {
          entrypoints: ["program/assets/review/verify.py", "program/assets/review/adapt.py"],
        },
        gate_contracts: { "gate-review": { argv: ["python3", "verify.py"] } },
      },
    } as unknown as GraphNode;
    const narrowed = structuredClone(existing);
    narrowed.spec.implementation_plan = {
      files: ["program/assets/review/verify.py"],
    };
    narrowed.spec.implementation = {
      entrypoints: ["program/assets/review/verify.py"],
    };

    expect(() => assertAssetImplementationObligationsPreserved(existing, narrowed)).toThrow(
      /cannot remove declared implementation file program\/assets\/review\/adapt\.py/u,
    );
  });

  it("lets source repair remove only compiler-proven unbound gate contracts", () => {
    const existing = {
      id: "asset-development-split",
      spec: {
        capabilities: [],
        implementation_plan: { files: ["program/assets/verify.py"] },
        implementation: { entrypoints: ["program/assets/verify.py"] },
        gate_contracts: {
          "gate-real": { argv: ["python3", "program/assets/verify.py"] },
          "gate-orphan": { argv: ["python3", "program/assets/verify.py"] },
        },
      },
    } as unknown as GraphNode;
    const repaired = structuredClone(existing);
    repaired.spec.gate_contracts = {
      "gate-real": { argv: ["python3", "program/assets/verify.py"] },
    };

    expect(() => assertAssetImplementationObligationsPreserved(existing, repaired)).toThrow(
      /cannot remove declared gate contract gate-orphan/u,
    );
    expect(() =>
      assertAssetImplementationObligationsPreserved(existing, repaired, {
        removableGateContractIds: ["gate-orphan"],
      }),
    ).not.toThrow();
  });

  it("requires every asset gate contract to bind an exact typed gate and validates edge", () => {
    const asset = {
      id: "asset-development-split",
      type: "asset",
      spec: {
        gate_contracts: {
          "gate-development-split-verify": {
            protocol: "autoresearch.gate-result.v1",
            argv: ["python3", "program/assets/verify_development_split.py"],
          },
        },
      },
      edges: {},
    } as unknown as GraphNode;
    const graph = {
      nodes: () => [
        asset,
        { id: "gate-real", type: "gate", spec: {}, edges: {} } as unknown as GraphNode,
      ],
    } as unknown as TypedGraph;

    expect(() => assertAssetGateContractsBoundToGraph(graph, ["gate"])).toThrow(
      /gate-development-split-verify.*exact typed gate/u,
    );
    expect(() => assertAssetGateContractsBoundToGraph(graph, ["gate"], [])).not.toThrow();

    asset.spec.gate_contracts = {
      "gate-real": {
        protocol: "autoresearch.gate-result.v1",
        argv: ["python3", "program/assets/verify_development_split.py"],
      },
    };
    expect(() => assertAssetGateContractsBoundToGraph(graph, ["gate"])).toThrow(
      /gate-real.*validates relationship/u,
    );

    asset.edges = { validates: ["gate-real"] };
    expect(() => assertAssetGateContractsBoundToGraph(graph, ["gate"])).not.toThrow();
  });

  it("does not let asset implementation expand its planned capability authority", () => {
    const existing = {
      id: "asset-subject-models",
      spec: {
        capabilities: [
          {
            name: "subject_models_v1",
            protocol_version: "1.0.0",
            entrypoints: ["program/assets/subjects/models.pt"],
          },
        ],
      },
    } as unknown as GraphNode;
    const expanded = structuredClone(existing);
    expanded.spec.capabilities = [
      ...(expanded.spec.capabilities as JsonValue[]),
      {
        name: "signature_extraction_v1",
        protocol_version: "1.0.0",
        entrypoints: ["program/assets/subjects/metadata.json"],
      },
    ];

    expect(() => assertAssetImplementationObligationsPreserved(existing, expanded)).toThrow(
      /cannot change its planned capability declarations/u,
    );
  });

  it("rejects inline interpreter payloads in repository-owned run plans", () => {
    const node = {
      id: "run-review",
      type: "run",
      spec: {
        runtime_contract: {
          command: ["python3", "-c", "print('not repository owned')", "verify.py"],
          composed_verification_command: ["sha256sum", "verify.py"],
        },
      },
    } as unknown as GraphNode;

    expect(() => assertRunPlanUsesRepositoryOwnedArgv(node)).toThrow(
      /cannot embed an inline interpreter payload/u,
    );

    node.spec.runtime_contract = {
      command: ["python3", "program/assets/review/adapt_result.py", "verify.py"],
      composed_verification_command: [
        "sha256sum",
        "program/assets/review/adapt_result.py",
        "verify.py",
      ],
    };
    expect(() => assertRunPlanUsesRepositoryOwnedArgv(node)).not.toThrow();
  });

  it("rejects recovery updates that delete an established run-plan obligation", () => {
    const existing = {
      id: "run-review",
      type: "run",
      spec: {
        runtime_contract: {
          command: ["python3", "program/assets/review/run.py"],
          composed_verification_command: ["python3", "program/assets/review/verify_result.py"],
          result_protocol: "research.result.v1",
          required_measurements: ["accuracy"],
          asset_entrypoints: ["program/assets/review/run.py"],
          scientific_inputs: ["data/dev.json"],
        },
      },
    } as unknown as GraphNode;
    const weakened = structuredClone(existing);
    delete (weakened.spec.runtime_contract as Record<string, unknown>)[
      "composed_verification_command"
    ];

    expect(() => assertRunPlanObligationsPreserved(existing, weakened)).toThrow(
      /cannot remove established runtime obligation composed_verification_command/u,
    );
  });

  it("reopens a completed asset ticket when its materialization rule becomes applicable again", () => {
    const ticket = {
      id: "TK-asset",
      operationId: "asset-resolution.asset.implement-asset",
      status: "completed",
      executionEpoch: 2,
      gitCycleId: "cycle-old",
      worktreePath: "/tmp/old-worktree",
      branch: "refs/heads/old-ticket-cycle",
      blocker: "stale blocker",
      updatedAt: "2026-07-16T18:00:00.000Z",
      steps: [
        {
          id: "implement",
          status: "completed",
          attemptIds: ["attempt-old"],
          summary: "Materialized the prior one-file plan.",
          startedAt: "2026-07-16T18:00:00.000Z",
          completedAt: "2026-07-16T18:30:00.000Z",
        },
      ],
      reviewReworkCount: 1,
      reviewReworks: [{ ordinal: 1 }],
    } as unknown as TicketRecord;
    const definition = {
      operation_registry_id: "asset-resolution.asset.implement-asset",
    } as unknown as DerivedTicketDefinition;

    expect(
      reopenCompletedRecurringAssetTicket(ticket, definition, FIXED_NOW.toISOString(), 2),
    ).toBe(true);
    expect(ticket).toMatchObject({
      status: "queued",
      executionEpoch: 3,
      blocker: undefined,
      worktreePath: undefined,
      branch: undefined,
      updatedAt: FIXED_NOW.toISOString(),
      reviewReworkCount: 0,
      reviewReworks: [],
      steps: [
        {
          id: "implement",
          status: "pending",
          attemptIds: ["attempt-old"],
          summary: undefined,
          startedAt: undefined,
          completedAt: undefined,
        },
      ],
    });
    expect(ticket.gitCycleId).toBeUndefined();
  });

  it("refreshes a settled recurring asset grant before reissuing a changed approved contract", () => {
    const ticket = {
      id: "TK-asset-scope-refresh",
      operationId: "asset-resolution.asset.implement-asset",
      status: "completed",
      executionEpoch: 2,
      readNodeIds: ["asset-one", "gate-old"],
      writeNodeIds: ["asset-one"],
      targetNodeIds: ["asset-one"],
      readPaths: ["program/assets/one", "evidence/old.json"],
      writePaths: ["program/assets/one"],
      steps: [
        {
          id: "implement",
          personaId: "asset-builder",
          kind: "production",
          dependsOn: [],
          readNodeIds: ["asset-one", "gate-old"],
          writeNodeIds: ["asset-one"],
          readPaths: ["program/assets/one", "evidence/old.json"],
          writePaths: ["program/assets/one"],
          status: "completed",
          attemptIds: ["attempt-old"],
        },
      ],
    } as unknown as TicketRecord;
    const definition = {
      id: ticket.id,
      operation_registry_id: ticket.operationId,
      target_node_ids: ["asset-one"],
      scope: {
        read_node_ids: ["asset-one", "gate-current"],
        write_node_ids: ["asset-one"],
        read_paths: ["program/assets/one", "evidence/current.json"],
        write_paths: ["program/assets/one"],
      },
      workflow: [
        {
          id: "implement",
          persona_id: "asset-builder",
          kind: "production",
          depends_on: [],
          read_node_ids: ["asset-one", "gate-current"],
          write_node_ids: ["asset-one"],
          read_paths: ["program/assets/one", "evidence/current.json"],
          write_paths: ["program/assets/one"],
        },
      ],
    } as unknown as DerivedTicketDefinition;

    expect(() => assertTicketDefinitionStable(ticket, definition)).toThrow(
      /changed under the same deterministic identity/u,
    );
    expect(refreshSettledRecurringAssetTicketGrant(ticket, definition, true)).toBe(true);
    expect(() => assertTicketDefinitionStable(ticket, definition)).not.toThrow();
    expect(
      reopenCompletedRecurringAssetTicket(ticket, definition, FIXED_NOW.toISOString(), 2),
    ).toBe(true);
    expect(ticket).toMatchObject({
      status: "queued",
      executionEpoch: 3,
      readNodeIds: ["asset-one", "gate-current"],
      readPaths: ["program/assets/one", "evidence/current.json"],
      steps: [
        {
          id: "implement",
          status: "pending",
          attemptIds: ["attempt-old"],
          readNodeIds: ["asset-one", "gate-current"],
          readPaths: ["program/assets/one", "evidence/current.json"],
        },
      ],
    });
  });

  it("does not refresh grant authority while a recurring asset attempt is in flight", () => {
    const ticket = {
      id: "TK-asset-running",
      operationId: "asset-resolution.asset.implement-asset",
      status: "running",
      executionEpoch: 2,
      targetNodeIds: ["asset-one"],
      readPaths: ["evidence/old.json"],
      writePaths: ["program/assets/one"],
      steps: [
        {
          id: "implement",
          personaId: "asset-builder",
          kind: "production",
          dependsOn: [],
          readPaths: ["evidence/old.json"],
          writePaths: ["program/assets/one"],
          status: "running",
          attemptIds: ["attempt-live"],
        },
      ],
    } as unknown as TicketRecord;
    const definition = {
      id: ticket.id,
      operation_registry_id: ticket.operationId,
      target_node_ids: ["asset-one"],
      scope: {
        read_node_ids: ["asset-one"],
        write_node_ids: ["asset-one"],
        read_paths: ["evidence/current.json"],
        write_paths: ["program/assets/one"],
      },
      workflow: [
        {
          id: "implement",
          persona_id: "asset-builder",
          kind: "production",
          depends_on: [],
          read_paths: ["evidence/current.json"],
          write_paths: ["program/assets/one"],
        },
      ],
    } as unknown as DerivedTicketDefinition;

    expect(refreshSettledRecurringAssetTicketGrant(ticket, definition, true)).toBe(false);
    expect(ticket.readPaths).toEqual(["evidence/old.json"]);
    expect(() => assertTicketDefinitionStable(ticket, definition)).toThrow(
      /changed under the same deterministic identity/u,
    );
  });

  it("reopens a retired recurring asset when a later approved repair becomes actionable", () => {
    const ticket = {
      id: "TK-asset-retired",
      operationId: "asset-resolution.asset.implement-asset",
      status: "cancelled",
      executionEpoch: 1,
      blocker: "Current compiler predicate no longer applies after prior execution",
      updatedAt: "2026-07-16T18:00:00.000Z",
      steps: [
        {
          id: "implement",
          status: "skipped",
          attemptIds: ["attempt-retired-implement"],
          summary: "Historical repair was independently rejected.",
          startedAt: "2026-07-16T18:00:00.000Z",
          completedAt: "2026-07-16T18:30:00.000Z",
        },
      ],
    } as unknown as TicketRecord;
    const definition = {
      operation_registry_id: "asset-resolution.asset.implement-asset",
    } as unknown as DerivedTicketDefinition;

    expect(
      reopenCompletedRecurringAssetTicket(ticket, definition, FIXED_NOW.toISOString(), 1),
    ).toBe(true);
    expect(ticket).toMatchObject({
      status: "queued",
      executionEpoch: 2,
      blocker: undefined,
      updatedAt: FIXED_NOW.toISOString(),
      steps: [
        {
          id: "implement",
          status: "pending",
          attemptIds: ["attempt-retired-implement"],
          summary: undefined,
          startedAt: undefined,
          completedAt: undefined,
        },
      ],
    });
  });

  it("keeps a completed recurring asset settled when its current obligations are materialized", () => {
    const ticket = {
      id: "TK-asset-current",
      operationId: "asset-resolution.asset.implement-asset",
      status: "completed",
      executionEpoch: 1,
      steps: [{ id: "implement", status: "completed", attemptIds: ["attempt-old"] }],
    } as unknown as TicketRecord;
    const definition = {
      operation_registry_id: "asset-resolution.asset.implement-asset",
    } as unknown as DerivedTicketDefinition;

    expect(
      reopenCompletedRecurringAssetTicket(ticket, definition, FIXED_NOW.toISOString(), 1, false),
    ).toBe(false);
    expect(ticket).toMatchObject({
      status: "completed",
      executionEpoch: 1,
      steps: [{ id: "implement", status: "completed", attemptIds: ["attempt-old"] }],
    });
  });

  it("routes an unapproved existing-asset request through its planned implementation ticket", () => {
    const proposal = {
      id: "TK-change-asset",
      title: "Change request: add explicit prerequisite paths and a read-only result verifier",
      status: "proposed",
      targetNodeIds: ["asset-existing"],
      steps: [
        { id: "scope-change", status: "pending", attemptIds: [] },
        { id: "risk-review", status: "pending", attemptIds: [] },
      ],
      executionControl: {
        proposalRequest: {
          requestSha256: digest("asset-repair-request"),
          sourceTicketId: "TK-source",
          sourceStepId: "bind-assets",
          sourceOutputSha256: digest("source-output"),
          fulfillment: "planned_asset_repair",
        },
      },
    } as unknown as TicketRecord;
    const source = {
      id: "TK-source",
      executionControl: {
        sourceHold: {
          proposalTicketId: proposal.id,
          requestSha256: proposal.executionControl!.proposalRequest!.requestSha256,
        },
      },
    } as unknown as TicketRecord;
    const definitions = [
      {
        id: "TK-asset",
        operation_registry_id: "asset-resolution.asset.implement-asset",
        target_node_ids: ["asset-existing"],
      },
    ] as unknown as DerivedTicketDefinition[];

    const tickets = { [source.id]: source, [proposal.id]: proposal };
    expect(plannedAssetRepairProposalTargetNodeIds({ tickets })).toEqual(
      new Set(["asset-existing"]),
    );
    const routed = routablePlannedAssetRepairProposalIds({ tickets }, definitions);
    expect(routed).toEqual(new Set([proposal.id]));
    routePlannedAssetRepairProposals(tickets, routed, FIXED_NOW.toISOString());
    expect(proposal).toMatchObject({
      status: "cancelled",
      blocker: "Superseded by the existing planned asset implementation workflow",
      updatedAt: FIXED_NOW.toISOString(),
      steps: [{ status: "skipped" }, { status: "skipped" }],
    });
    expect(plannedAssetRepairRequestForNode({ tickets }, "asset-existing")).toEqual({
      proposalTicketId: proposal.id,
      requestSha256: proposal.executionControl!.proposalRequest!.requestSha256,
      title: proposal.title,
    });

    proposal.status = "proposed";
    proposal.blocker = undefined;
    for (const step of proposal.steps) step.status = "pending";

    proposal.executionControl!.proposalDecisionHistory = [
      {
        protocol: "koni.proposal-decision-authority.v2",
        runId: "run-one",
        proposalTicketId: proposal.id,
        requestSha256: proposal.executionControl!.proposalRequest!.requestSha256,
        eventId: "proposal-decision-one",
        decision: "approval",
        actor: "operator",
        recordedAt: FIXED_NOW.toISOString(),
        sha256: digest("decision"),
      },
    ];
    expect(
      routablePlannedAssetRepairProposalIds(
        { tickets: { [source.id]: source, [proposal.id]: proposal } },
        definitions,
      ),
    ).toEqual(new Set());

    proposal.executionControl!.proposalDecisionHistory = [];
    proposal.executionControl!.proposalRequest!.fulfillment = "dynamic_scope_change";
    expect(
      routablePlannedAssetRepairProposalIds(
        { tickets: { [source.id]: source, [proposal.id]: proposal } },
        definitions,
      ),
    ).toEqual(new Set());
  });

  it("reprojects a completed internal asset workflow for an authenticated planned repair", () => {
    const proposal = {
      id: "TK-change-internal-asset",
      title: "Change request: correct the authenticated support-path contract",
      status: "proposed",
      targetNodeIds: ["asset-internal"],
      steps: [{ id: "scope-change", status: "pending", attemptIds: [] }],
      executionControl: {
        proposalRequest: {
          requestSha256: digest("internal-asset-repair-request"),
          sourceTicketId: "TK-source-review",
          sourceStepId: "review",
          sourceOutputSha256: digest("internal-asset-review-output"),
          fulfillment: "planned_asset_repair",
        },
      },
    } as unknown as TicketRecord;
    const source = {
      id: "TK-source-review",
      executionControl: {
        sourceHold: {
          proposalTicketId: proposal.id,
          requestSha256: proposal.executionControl!.proposalRequest!.requestSha256,
        },
      },
    } as unknown as TicketRecord;
    const completedAsset = {
      id: "TK-asset-completed",
      operationId: "asset-resolution.asset.implement-asset",
      status: "completed",
      targetNodeIds: ["asset-internal"],
    } as unknown as TicketRecord;
    const run = {
      tickets: {
        [source.id]: source,
        [proposal.id]: proposal,
        [completedAsset.id]: completedAsset,
      },
    } as Pick<RunRecord, "tickets">;
    const internalAsset = {
      id: "asset-internal",
      type: "asset",
      spec: {
        source_strategy: "internal",
        implementation_plan: {
          root: "program/assets/internal",
          files: ["program/assets/internal/run.py"],
        },
      },
    } as unknown as GraphNode;

    expect(assetImplementationFallbackEligible(run, internalAsset)).toBe(true);
    expect(
      assetImplementationFallbackEligible(
        { tickets: { [source.id]: source, [proposal.id]: proposal } },
        internalAsset,
      ),
    ).toBe(false);
  });

  it("projects cumulative authenticated planned-asset repair findings to the affected asset", () => {
    const runId = "run-planned-repair-history";
    const sourceTicketId = "TK-source-review";
    const sourceStepId = "review";
    const assetId = "asset-verifier";
    const gateId = "gate-readiness";
    const proposal = (
      id: string,
      requestSeed: string,
      summary: string,
      reason: string,
      targetNodeIds: string[],
      updatedAt: string,
    ) => {
      const requestSha256 = digest(requestSeed);
      const sourceOutputSha256 = digest(`${requestSeed}-output`);
      const sourceTerminalProof = fixtureTerminalSuccessProof({
        runId,
        ticketId: sourceTicketId,
        stepId: sourceStepId,
        attemptId: `attempt-${requestSeed}`,
        actionInvocationId: `action-${requestSeed}`,
      });
      return {
        id,
        title: `Change request: ${summary}`,
        summary: `${summary}\n\nReason: ${reason}`,
        status: "cancelled",
        blocker: "Superseded by the existing planned asset implementation workflow",
        targetNodeIds,
        updatedAt,
        executionControl: {
          proposalRequest: {
            requestSha256,
            sourceTicketId,
            sourceStepId,
            sourceOutputSha256,
            fulfillment: "planned_asset_repair",
          },
          controlTicketAuthority: {
            runId,
            role: "proposal",
            ticketId: id,
            causal: {
              role: "proposal",
              publication: {
                proposalTicketId: id,
                requestSha256,
                sourceTicketId,
                sourceStepId,
                sourceOutputSha256,
                targetNodeIds,
                summary,
                reason,
              },
              sourceTicketProjection: {
                id: sourceTicketId,
                operationId: "gates.gate.run-gate",
                targetNodeIds: [gateId],
              },
              sourceTerminalProof,
            },
          },
        },
      } as unknown as TicketRecord;
    };
    const earlier = proposal(
      "TK-change-earlier",
      "earlier-repair",
      "Preserve the verified result protocol",
      "The prior integration omitted the established result protocol.",
      [assetId],
      "2026-07-16T18:00:00.000Z",
    );
    const later = proposal(
      "TK-change-later",
      "later-repair",
      "Correct the remaining verifier contract",
      "The current verifier contract has the wrong structured shape.",
      [gateId],
      "2026-07-16T18:30:00.000Z",
    );
    const malformed = structuredClone(later);
    malformed.id = "TK-change-malformed";
    (
      malformed.executionControl!.controlTicketAuthority as unknown as { ticketId: string }
    ).ticketId = "TK-other";

    const history = plannedAssetRepairHistoryForAttempt(
      {
        id: runId,
        tickets: {
          [earlier.id]: earlier,
          [later.id]: later,
          [malformed.id]: malformed,
        },
      },
      [
        {
          id: assetId,
          type: "asset",
          edges: { validates: [gateId] },
        },
      ],
    );

    expect(history).toEqual([
      expect.objectContaining({
        proposalTicketId: earlier.id,
        requestSha256: earlier.executionControl!.proposalRequest!.requestSha256,
        summary: "Preserve the verified result protocol",
        reason: "The prior integration omitted the established result protocol.",
      }),
      expect.objectContaining({
        proposalTicketId: later.id,
        requestSha256: later.executionControl!.proposalRequest!.requestSha256,
        summary: "Correct the remaining verifier contract",
        reason: "The current verifier contract has the wrong structured shape.",
      }),
    ]);
  });

  it("routes a pristine gate-targeted request through its exact source-owned asset ticket", () => {
    const proposal = {
      id: "TK-change-gates",
      title: "Change request: repair three nonpassing gates",
      status: "proposed",
      targetNodeIds: ["gate-a", "gate-b", "gate-c"],
      steps: [
        { id: "scope-change", status: "pending", attemptIds: [] },
        { id: "risk-review", status: "pending", attemptIds: [] },
      ],
      executionControl: {
        proposalRequest: {
          requestSha256: digest("gate-repair-request"),
          sourceTicketId: "TK-source-asset",
          sourceStepId: "integrate",
          sourceOutputSha256: digest("source-output"),
          fulfillment: "planned_asset_repair",
        },
      },
    } as unknown as TicketRecord;
    const source = {
      id: "TK-source-asset",
      operationId: "asset-resolution.asset.implement-asset",
      targetNodeIds: ["asset-gate-verifier"],
      readNodeIds: ["asset-gate-verifier", "gate-a", "gate-b", "gate-c"],
      writeNodeIds: ["asset-gate-verifier"],
      executionControl: {
        sourceHold: {
          proposalTicketId: proposal.id,
          requestSha256: proposal.executionControl!.proposalRequest!.requestSha256,
        },
      },
    } as unknown as TicketRecord;
    const definitions = [
      {
        id: "TK-current-asset",
        operation_registry_id: "asset-resolution.asset.implement-asset",
        target_node_ids: ["asset-gate-verifier"],
      },
    ] as unknown as DerivedTicketDefinition[];
    const tickets = { [source.id]: source, [proposal.id]: proposal };

    expect(routablePlannedAssetRepairProposalIds({ tickets }, definitions)).toEqual(
      new Set([proposal.id]),
    );
    routePlannedAssetRepairProposals(tickets, new Set([proposal.id]), FIXED_NOW.toISOString());
    expect(plannedAssetRepairRequestForNode({ tickets }, "asset-gate-verifier")).toEqual({
      proposalTicketId: proposal.id,
      requestSha256: proposal.executionControl!.proposalRequest!.requestSha256,
      title: proposal.title,
    });
    expect(plannedAssetRepairRequestForNode({ tickets }, "asset-unrelated")).toBeUndefined();
  });

  it("restores a spuriously reissued recurring asset from its last completed epoch", () => {
    const ticket = {
      id: "TK-asset-current",
      operationId: "asset-resolution.asset.implement-asset",
      status: "queued",
      executionEpoch: 4,
      steps: [
        { id: "implement", status: "pending", attemptIds: ["attempt-implement"] },
        { id: "review", status: "pending", attemptIds: ["attempt-review"] },
      ],
    } as unknown as TicketRecord;
    const definition = {
      operation_registry_id: "asset-resolution.asset.implement-asset",
    } as unknown as DerivedTicketDefinition;
    const attempts = {
      "attempt-implement": {
        id: "attempt-implement",
        ticketId: ticket.id,
        stepId: "implement",
        status: "completed",
        ticketExecutionEpoch: 3,
        startedAt: "2026-07-16T18:00:00.000Z",
        endedAt: "2026-07-16T18:10:00.000Z",
        terminalSummary: "Implemented current asset files.",
      },
      "attempt-review": {
        id: "attempt-review",
        ticketId: ticket.id,
        stepId: "review",
        status: "completed",
        ticketExecutionEpoch: 3,
        startedAt: "2026-07-16T18:10:00.000Z",
        terminalAcceptedAt: "2026-07-16T18:20:00.000Z",
        endedAt: "2026-07-16T18:21:00.000Z",
        terminalSummary: "Approved current asset files.",
      },
    } as unknown as Record<string, AgentAttemptRecord>;

    expect(
      restoreSettledRecurringAssetTicket(
        ticket,
        definition,
        attempts,
        FIXED_NOW.toISOString(),
        false,
      ),
    ).toBe(true);
    expect(ticket).toMatchObject({
      status: "completed",
      executionEpoch: 3,
      steps: [
        {
          id: "implement",
          status: "completed",
          summary: "Implemented current asset files.",
          startedAt: "2026-07-16T18:00:00.000Z",
          completedAt: "2026-07-16T18:10:00.000Z",
        },
        {
          id: "review",
          status: "completed",
          summary: "Approved current asset files.",
          startedAt: "2026-07-16T18:10:00.000Z",
          completedAt: "2026-07-16T18:21:00.000Z",
        },
      ],
    });
  });

  it("excludes a recurring asset whose current manifest is already settled at verification", () => {
    const definitions = [
      {
        id: "ticket-current-asset",
        operation_registry_id: "asset-resolution.asset.implement-asset",
        target_node_ids: ["asset-current"],
      },
      {
        id: "ticket-stale-asset",
        operation_registry_id: "asset-resolution.asset.implement-asset",
        target_node_ids: ["asset-stale"],
      },
      {
        id: "ticket-gate",
        operation_registry_id: "gates.gate.run-gate",
        target_node_ids: ["gate-one"],
      },
    ] as unknown as DerivedTicketDefinition[];

    expect(
      verificationActionableTicketDefinitions(definitions, new Set(["asset-stale"])).map(
        (definition) => definition.id,
      ),
    ).toEqual(["ticket-stale-asset", "ticket-gate"]);
    expect(
      ticketBoardApplicableTicketDefinitions(definitions, new Set(["asset-stale"])).map(
        (definition) => definition.id,
      ),
    ).toEqual(["ticket-stale-asset", "ticket-gate"]);
  });

  it("excludes only completed manifest-bound compatibility gate rechecks at verification", () => {
    const definitions = [
      {
        id: "ticket-current-manifest",
        rule_id: "compiler.compatibility.repaired-provider-gate-recheck",
        operation_registry_id: "gates.gate.run-gate",
        target_node_ids: ["gate-current"],
      },
      {
        id: "ticket-new-manifest",
        rule_id: "compiler.compatibility.repaired-provider-gate-recheck",
        operation_registry_id: "gates.gate.run-gate",
        target_node_ids: ["gate-current"],
      },
      {
        id: "ticket-incomplete-manifest",
        rule_id: "compiler.compatibility.repaired-provider-gate-recheck",
        operation_registry_id: "gates.gate.run-gate",
        target_node_ids: ["gate-incomplete"],
      },
      {
        id: "ticket-ordinary-gate",
        rule_id: "research.gate.run",
        operation_registry_id: "gates.gate.run-gate",
        target_node_ids: ["gate-ordinary"],
      },
    ] as unknown as DerivedTicketDefinition[];
    const durableTickets = [
      { id: "ticket-current-manifest", status: "completed" },
      { id: "ticket-incomplete-manifest", status: "running" },
      { id: "ticket-ordinary-gate", status: "completed" },
    ] as const;

    expect(
      verificationActionableTicketDefinitions(definitions, new Set(), durableTickets).map(
        (definition) => definition.id,
      ),
    ).toEqual(["ticket-new-manifest", "ticket-incomplete-manifest", "ticket-ordinary-gate"]);
  });

  it("identifies the selected provider when its experiment-boundary gate remains blocked", () => {
    const nodes = new Map([
      ["experiment-a", { type: "experiment" }],
      ["hypothesis-root", { type: "hypothesis" }],
      ["asset-experiment", { type: "asset" }],
      ["asset-root", { type: "asset" }],
    ]);
    const graph = { node: (id: string) => nodes.get(id) };
    const evaluation = {
      gate_policy_contexts: [
        {
          gate_node_id: "gate-experiment",
          winner_node_id: "asset-experiment",
          evaluation_target_node_ids: ["experiment-a"],
        },
        {
          gate_node_id: "gate-root",
          winner_node_id: "asset-root",
          evaluation_target_node_ids: ["hypothesis-root"],
        },
      ],
      facts: [
        {
          anchor_node_id: "gate-experiment",
          kind: "readiness",
          value: "blocked",
          args: {
            blocking_gate_ids: ["gate-experiment"],
            current_terminal_gate_ids: ["gate-experiment"],
          },
        },
        {
          anchor_node_id: "gate-root",
          kind: "readiness",
          value: "blocked",
          args: { blocking_gate_ids: ["gate-root"] },
        },
      ],
    } as unknown as CompiledRuleEvaluation;

    expect(experimentBoundaryBlockedGateProviderNodeIds(graph, evaluation)).toEqual(
      new Set(["asset-experiment"]),
    );
    expect(
      recurringAssetRequiresReissue({
        implementationCurrent: true,
        selectedGateContractsCurrent: true,
        selectedGateBlocked: true,
      }),
    ).toBe(true);
  });

  it("reissues recurring assets only for incomplete implementation, selected contract drift, gate failure, or standalone runtime failure", () => {
    expect(
      recurringAssetRequiresReissue({
        implementationCurrent: true,
        selectedGateContractsCurrent: true,
        selectedGateBlocked: false,
      }),
    ).toBe(false);
    expect(
      recurringAssetRequiresReissue({
        implementationCurrent: true,
        selectedGateContractsCurrent: true,
        selectedGateBlocked: false,
        standaloneSupportRunFailed: true,
      }),
    ).toBe(true);
    expect(
      recurringAssetRequiresReissue({
        implementationCurrent: true,
        selectedGateContractsCurrent: true,
        selectedGateBlocked: false,
        reviewReworkPending: true,
      }),
    ).toBe(true);
  });

  it("keeps a recurring asset actionable until its rejected review rework settles", () => {
    const ticket = {
      id: "TK-asset-review-rework",
      operationId: "asset-resolution.asset.implement-asset",
      targetNodeIds: ["asset-verifier"],
      status: "queued",
      reviewReworks: [{ ordinal: 1 }],
      steps: [
        { id: "implement", status: "pending", attemptIds: [] },
        { id: "review", status: "pending", attemptIds: ["attempt-rejected-review"] },
      ],
    } as unknown as TicketRecord;

    expect(recurringAssetReviewReworkPending({ [ticket.id]: ticket }, "asset-verifier")).toBe(true);
    ticket.status = "completed";
    expect(recurringAssetReviewReworkPending({ [ticket.id]: ticket }, "asset-verifier")).toBe(
      false,
    );
  });

  it("grants a blocked gate provider read access to causal prerequisite assets", () => {
    const nodes = new Map([
      [
        "asset-verifier",
        {
          id: "asset-verifier",
          type: "asset",
          spec: { implementation_plan: { root: "program/assets/verifier" } },
        },
      ],
      [
        "asset-probe-basis",
        {
          id: "asset-probe-basis",
          type: "asset",
          spec: { implementation_plan: { root: "program/assets/probe_basis" } },
        },
      ],
      [
        "asset-unrelated",
        {
          id: "asset-unrelated",
          type: "asset",
          spec: { implementation_plan: { root: "program/assets/unrelated" } },
        },
      ],
      ["gate-probe-basis", { id: "gate-probe-basis", type: "gate", spec: {} }],
      [
        "prerequisite-probe-basis",
        { id: "prerequisite-probe-basis", type: "prerequisite", spec: {} },
      ],
    ]);
    const graph = {
      node: (id: string) => nodes.get(id),
      edges: () => [
        {
          source: "gate-probe-basis",
          relation: "applies_to",
          target: "prerequisite-probe-basis",
        },
        {
          source: "prerequisite-probe-basis",
          relation: "satisfied_by",
          target: "asset-probe-basis",
        },
      ],
    };
    const definition = {
      protocol: "koni.derived-ticket.v1",
      id: "ticket-verifier",
      rule_id: "ticket.implement-asset",
      operation_registry_id: "asset-resolution.asset.implement-asset",
      target_node_ids: ["asset-verifier"],
      configuration_sha256: digest("configuration"),
      scope: {
        read_node_ids: ["asset-verifier", "gate-probe-basis"],
        write_node_ids: ["asset-verifier"],
        read_paths: ["program/assets/verifier"],
        write_paths: ["program/assets/verifier"],
      },
      workflow: [],
      definition_sha256: digest("old-definition"),
    } as unknown as DerivedTicketDefinition;
    const evaluation = {
      tickets: [definition],
      facts: [
        {
          anchor_node_id: "gate-probe-basis",
          kind: "readiness",
          value: "blocked",
          args: {
            blocking_gate_ids: ["gate-probe-basis"],
            current_terminal_gate_ids: ["gate-probe-basis"],
          },
        },
      ],
      gate_policy_contexts: [
        {
          gate_node_id: "gate-probe-basis",
          winner_node_id: "asset-verifier",
          evaluation_target_node_ids: ["prerequisite-probe-basis"],
        },
      ],
      configuration_sha256: digest("configuration"),
      evaluation_sha256: digest("old-evaluation"),
    } as unknown as CompiledRuleEvaluation;

    const repaired = researchRunContractScopeFallback(graph, evaluation);

    expect(repaired.tickets).toHaveLength(1);
    expect(repaired.tickets.map((ticket) => ticket.id)).not.toContain(definition.id);
    const scoped = repaired.tickets[0]!;
    expect(scoped.scope.read_node_ids).toEqual([
      "asset-probe-basis",
      "asset-verifier",
      "gate-probe-basis",
      "prerequisite-probe-basis",
    ]);
    expect(scoped.scope.read_node_ids).not.toContain("asset-unrelated");
    expect(scoped.scope.write_node_ids).toEqual(["asset-verifier"]);
    expect(scoped.scope.read_paths).toEqual([
      "program/assets/probe_basis",
      "program/assets/verifier",
    ]);
    const { definition_sha256: _definitionSha256, ...material } = scoped;
    expect(scoped.definition_sha256).toBe(canonicalHash(material));
    expect(repaired.evaluation_sha256).not.toBe(evaluation.evaluation_sha256);

    nodes.set("run-support", { id: "run-support", type: "run", spec: {} });
    const delegatedGraph = {
      ...graph,
      edges: () => [
        ...graph.edges(),
        { source: "run-support", relation: "evaluates", target: "gate-probe-basis" },
      ],
    };
    const supportDefinition = {
      ...definition,
      id: "ticket-support-run",
      rule_id: "compiler.compatibility.research-standalone-support-run",
      operation_registry_id: "execution.run.run-experiment",
      target_node_ids: ["run-support"],
    } as unknown as DerivedTicketDefinition;
    const delegated = gateProviderRepairScopeFallback(delegatedGraph, {
      ...evaluation,
      tickets: [definition, supportDefinition],
    });

    expect(delegated.tickets.map(({ id }) => id)).toContain(definition.id);
  });

  it("scopes standalone support-run repair to exact executable assets", () => {
    const nodes = new Map([
      [
        "asset-generator",
        {
          id: "asset-generator",
          type: "asset",
          spec: {
            source_strategy: "generated",
            implementation_plan: { root: "program/assets/generator" },
          },
        },
      ],
      [
        "asset-read-only",
        {
          id: "asset-read-only",
          type: "asset",
          spec: {
            source_strategy: "generated",
            implementation_plan: { root: "program/assets/read_only" },
          },
        },
      ],
      [
        "run-support",
        {
          id: "run-support",
          type: "run",
          spec: {
            runtime_contract: {
              asset_entrypoints: [
                {
                  asset_id: "asset-generator",
                  path: "program/assets/generator/run.py",
                },
              ],
              output_root: "runs/support",
            },
          },
        },
      ],
      ["gate-support", { id: "gate-support", type: "gate", spec: {} }],
    ]);
    const graph = {
      node: (id: string) => nodes.get(id),
      edges: () => [
        { source: "run-support", relation: "uses", target: "asset-generator" },
        { source: "run-support", relation: "uses", target: "asset-read-only" },
        { source: "run-support", relation: "evaluates", target: "gate-support" },
      ],
    };
    const definition = (id: string, assetId: string, root: string) =>
      ({
        protocol: "koni.derived-ticket.v1",
        id,
        rule_id: "ticket.implement-asset",
        operation_registry_id: "asset-resolution.asset.implement-asset",
        target_node_ids: [assetId],
        configuration_sha256: digest("configuration"),
        scope: {
          read_node_ids: [assetId],
          write_node_ids: [assetId],
          read_paths: [root],
          write_paths: [root],
        },
        workflow: [],
        definition_sha256: digest(id),
      }) as unknown as DerivedTicketDefinition;
    const originalGenerator = definition(
      "ticket-generator",
      "asset-generator",
      "program/assets/generator",
    );
    const originalReadOnly = definition(
      "ticket-read-only",
      "asset-read-only",
      "program/assets/read_only",
    );
    const supportRun = {
      ...definition("ticket-support-run", "run-support", "runs/support"),
      rule_id: "compiler.compatibility.research-standalone-support-run",
      operation_registry_id: "execution.run.run-experiment",
      target_node_ids: ["run-support"],
      scope: {
        read_node_ids: ["asset-generator", "asset-read-only", "gate-support", "run-support"],
        write_node_ids: ["run-support"],
        read_paths: ["program/assets/generator", "program/assets/read_only", "runs/support"],
        write_paths: ["runs/support"],
      },
    } as unknown as DerivedTicketDefinition;
    const evaluation = {
      tickets: [originalGenerator, originalReadOnly, supportRun],
      facts: [],
      gate_policy_contexts: [],
      configuration_sha256: digest("configuration"),
      evaluation_sha256: digest("evaluation"),
    } as unknown as CompiledRuleEvaluation;

    const bindings = standaloneSupportRunAssetNodeIds(graph, evaluation);
    expect([...bindings.get("asset-generator")!]).toEqual(["run-support"]);
    expect(bindings.has("asset-read-only")).toBe(false);

    const scoped = standaloneSupportRunAssetRepairScopeFallback(graph, evaluation);
    const generator = scoped.tickets.find((ticket) =>
      ticket.target_node_ids.includes("asset-generator"),
    )!;
    expect(generator.id).not.toBe(originalGenerator.id);
    expect(generator.scope.read_node_ids).toEqual([
      "asset-generator",
      "gate-support",
      "run-support",
    ]);
    expect(generator.scope.read_paths).toEqual(["program/assets/generator", "runs/support"]);
    expect(generator.scope.write_node_ids).toEqual(["asset-generator"]);
    expect(generator.scope.write_paths).toEqual(["program/assets/generator"]);
    expect(
      scoped.tickets.find((ticket) => ticket.target_node_ids.includes("asset-read-only"))!.id,
    ).toBe(originalReadOnly.id);
  });

  it("does not reopen a recurring provider for a gate failure its completed repair already addressed", () => {
    const tickets = {
      "ticket-provider": {
        operationId: "asset-resolution.asset.implement-asset",
        targetNodeIds: ["asset-verifier"],
        status: "completed",
        updatedAt: "2026-07-16T18:20:00.000Z",
        steps: [
          {
            status: "completed",
            completedAt: "2026-07-16T18:20:00.000Z",
          },
        ],
      },
    } as unknown as RunRecord["tickets"];
    const check = {
      accepted: true,
      passed: false,
      recordedAt: "2026-07-16T18:10:00.000Z",
      executionPolicy: {
        gatePolicyContexts: [{ gateNodeId: "gate-a" }],
      },
    } as unknown as NonNullable<RunRecord["checks"]>[number];

    expect(
      recurringAssetHasUnaddressedGateFailure({
        tickets,
        checks: [check],
        providerNodeId: "asset-verifier",
        gateNodeIds: new Set(["gate-a"]),
      }),
    ).toBe(false);
    expect(
      recurringAssetHasUnaddressedGateFailure({
        tickets,
        checks: [{ ...check, recordedAt: "2026-07-16T18:30:00.000Z" }],
        providerNodeId: "asset-verifier",
        gateNodeIds: new Set(["gate-a"]),
      }),
    ).toBe(true);
    const delegatedFailure = {
      tickets,
      checks: [{ ...check, recordedAt: "2026-07-16T18:30:00.000Z" }],
      providerNodeId: "asset-verifier",
      gateNodeIds: new Set(["gate-a"]),
      delegatedGateNodeIds: new Set(["gate-a"]),
    };
    expect(recurringAssetHasUnaddressedGateFailure(delegatedFailure)).toBe(false);
  });

  it("reopens a generated asset only for its latest unaddressed standalone runtime failure", () => {
    const assetTicket = {
      id: "ticket-asset",
      operationId: "asset-resolution.asset.implement-asset",
      targetNodeIds: ["asset-generator"],
      status: "cancelled",
      steps: [
        { id: "implement", attemptIds: ["asset-implement"] },
        { id: "review", attemptIds: ["asset-review"] },
      ],
    } as unknown as TicketRecord;
    const runTicket = {
      id: "ticket-support-run",
      operationId: "execution.run.run-experiment",
      targetNodeIds: ["run-support"],
    } as unknown as TicketRecord;
    const attempts = {
      "asset-implement": {
        id: "asset-implement",
        ticketId: assetTicket.id,
        stepId: "implement",
        status: "completed",
        ticketExecutionEpoch: 2,
        endedAt: "2026-08-09T01:00:00.000Z",
        terminalSummary: "implemented",
      },
      "asset-review": {
        id: "asset-review",
        ticketId: assetTicket.id,
        stepId: "review",
        status: "completed",
        ticketExecutionEpoch: 2,
        endedAt: "2026-08-09T01:05:00.000Z",
        terminalSummary: "approved",
      },
      "run-attempt": {
        id: "run-attempt",
        ticketId: runTicket.id,
        stepId: "run",
        status: "failed",
      },
    } as unknown as RunRecord["attempts"];
    const rejected = {
      attemptId: "run-attempt",
      requestedCheckId: "scientific-runtime",
      accepted: false,
      passed: false,
      recordedAt: "2026-08-09T02:00:00.000Z",
    } as unknown as NonNullable<RunRecord["checks"]>[number];

    const input = {
      tickets: { [assetTicket.id]: assetTicket, [runTicket.id]: runTicket },
      attempts,
      checks: [rejected],
      ticketCycles: {
        "cycle-asset": {
          ticketId: assetTicket.id,
          ordinal: 3,
          status: "retired",
          baseRunOid: "unchanged-oid",
          ticketHeadOid: "unchanged-oid",
        },
      } as unknown as RunRecord["git"]["ticketCycles"],
      assetNodeId: "asset-generator",
      runNodeIds: new Set(["run-support"]),
    };
    expect(recurringAssetHasUnaddressedStandaloneRunFailure(input)).toBe(true);
    expect(
      recurringAssetHasUnaddressedStandaloneRunFailure({
        ...input,
        checks: [
          rejected,
          {
            ...rejected,
            accepted: true,
            passed: true,
            recordedAt: "2026-08-09T02:10:00.000Z",
          },
        ],
      }),
    ).toBe(false);
    expect(
      recurringAssetHasUnaddressedStandaloneRunFailure({
        ...input,
        checks: [{ ...rejected, recordedAt: "2026-08-09T00:30:00.000Z" }],
      }),
    ).toBe(true);
    expect(
      recurringAssetHasUnaddressedStandaloneRunFailure({
        ...input,
        checks: [{ ...rejected, recordedAt: "2026-08-09T00:30:00.000Z" }],
        ticketCycles: {
          "cycle-asset": {
            ...input.ticketCycles["cycle-asset"],
            ticketHeadOid: "material-repair-oid",
          },
        } as RunRecord["git"]["ticketCycles"],
      }),
    ).toBe(false);
  });

  it("retains a completed recurring provider epoch after a later empty reissue reset", () => {
    const ticket = {
      id: "ticket-provider",
      operationId: "asset-resolution.asset.implement-asset",
      targetNodeIds: ["asset-verifier"],
      status: "queued",
      executionEpoch: 8,
      steps: [
        { id: "implement", status: "pending", attemptIds: ["attempt-implement"] },
        { id: "review", status: "pending", attemptIds: ["attempt-review"] },
      ],
    } as unknown as TicketRecord;
    const attempts = {
      "attempt-implement": {
        id: "attempt-implement",
        ticketId: ticket.id,
        stepId: "implement",
        status: "completed",
        ticketExecutionEpoch: 7,
        endedAt: "2026-07-16T18:20:00.000Z",
        terminalSummary: "Implemented the current provider.",
      },
      "attempt-review": {
        id: "attempt-review",
        ticketId: ticket.id,
        stepId: "review",
        status: "completed",
        ticketExecutionEpoch: 7,
        endedAt: "2026-07-16T18:25:00.000Z",
        terminalSummary: "Approved the current provider.",
      },
    } as unknown as RunRecord["attempts"];
    const check = {
      accepted: true,
      passed: false,
      recordedAt: "2026-07-16T18:10:00.000Z",
      executionPolicy: {
        gatePolicyContexts: [{ gateNodeId: "gate-a" }],
      },
    } as unknown as NonNullable<RunRecord["checks"]>[number];

    expect(
      recurringAssetHasUnaddressedGateFailure({
        tickets: { [ticket.id]: ticket },
        attempts,
        checks: [check],
        providerNodeId: "asset-verifier",
        gateNodeIds: new Set(["gate-a"]),
      }),
    ).toBe(false);
  });

  it("binds a reopened gate provider to its exact current nonpassing receipt", async () => {
    const nodes = new Map([
      ["experiment-a", { type: "experiment" }],
      ["asset-verifier", { type: "asset" }],
    ]);
    const graph = { node: (id: string) => nodes.get(id) };
    const evaluation = {
      gate_policy_contexts: [
        {
          gate_node_id: "gate-a",
          winner_node_id: "asset-verifier",
          evaluation_target_node_ids: ["experiment-a"],
        },
      ],
      facts: [
        {
          anchor_node_id: "gate-a",
          kind: "readiness",
          value: "blocked",
          args: {
            blocking_gate_ids: ["gate-a"],
            current_terminal_gate_ids: ["gate-a"],
          },
        },
      ],
    } as unknown as CompiledRuleEvaluation;
    const receiptLeaf = {
      op: "current_receipt",
      receipt_type: "gate.receipt",
    } as const;
    const evidence = createRuleAuthorityEvidence({
      protocol: RULE_AUTHORITY_EVIDENCE_PROTOCOL,
      configurationSha256: digest("configuration"),
      inputGraphSha256: digest("graph"),
      predicates: {
        [digest("predicate")]: {
          key: digest("predicate"),
          result: true,
          recordedAt: FIXED_NOW.toISOString(),
          sourceReceiptIds: ["check-evidence-current"],
          leaf: receiptLeaf,
          subjectNodeId: "gate-a",
          bindings: {},
        },
      },
    });
    const currentCheck = {
      id: "check-current",
      accepted: true,
      passed: false,
      recordedAt: new Date(FIXED_NOW.getTime() + 500).toISOString(),
      evidenceArtifactPath: "runs/run-one/current/evidence.json",
      evidenceSha256: digest("current-evidence"),
      evidenceSizeBytes: 10,
      executionPolicy: {
        gatePolicyContexts: [{ gateNodeId: "gate-a" }],
      },
    };
    const staleCheck = {
      ...currentCheck,
      id: "check-stale",
      recordedAt: "2026-07-01T00:00:00.000Z",
      evidenceArtifactPath: "runs/run-one/stale/evidence.json",
    };

    const requests = await currentNonpassingGateRepairEvidenceRequests({
      graph,
      evaluation,
      evidence,
      checks: [staleCheck, currentCheck] as unknown as RunRecord["checks"],
      targetNodeIds: ["asset-verifier"],
      readEvidence: async (check) => ({
        id: check.id === "check-current" ? "check-evidence-current" : "check-evidence-stale",
      }),
    });
    expect(requests.map(({ artifact: _artifact, ...request }) => request)).toEqual([
      {
        gateNodeId: "gate-a",
        providerNodeId: "asset-verifier",
        receiptIds: ["check-evidence-current"],
        check: currentCheck,
      },
    ]);

    const sourceGraphNodes = new Map([
      ...nodes,
      ["gate-a", { type: "gate" }],
      ["asset-source", { type: "asset" }],
    ]);
    const sourceTargets = gateRepairEvidenceTargetNodeIds(
      {
        tickets: {
          "TK-proposal": {
            id: "TK-proposal",
            status: "completed",
            targetNodeIds: ["asset-source", "gate-a"],
          },
          "TK-application": {
            id: "TK-application",
            status: "queued",
            targetNodeIds: ["asset-source"],
            executionControl: {
              sourceProposalTicketId: "TK-proposal",
              approvedApplicationSha256: digest("approved-application"),
            },
          },
        },
      } as unknown as RunRecord,
      { node: (id: string) => sourceGraphNodes.get(id) },
      ["asset-source"],
    );
    expect(sourceTargets).toEqual(["asset-source", "gate-a"]);

    const sourceRequests = await currentNonpassingGateRepairEvidenceRequests({
      graph,
      evaluation,
      evidence,
      checks: [staleCheck, currentCheck] as unknown as RunRecord["checks"],
      targetNodeIds: sourceTargets,
      readEvidence: async (check) => ({
        id: check.id === "check-current" ? "check-evidence-current" : "check-evidence-stale",
      }),
    });
    expect(sourceRequests).toHaveLength(1);
  });

  it("stops presenting predecessor gate failures as active after the current repair step", () => {
    const definition = {
      id: "TK-provider-repair",
      workflow: [
        { id: "implement", kind: "production" },
        { id: "verify", kind: "production" },
        { id: "integrate", kind: "integration" },
        { id: "review", kind: "review" },
      ],
    } as unknown as Parameters<typeof shouldAttachCurrentGateRepairEvidence>[1];
    const run = {
      tickets: {
        "TK-provider-repair": {
          id: "TK-provider-repair",
          executionEpoch: 3,
          steps: [
            {
              id: "implement",
              status: "completed",
              attemptIds: ["attempt-old", "attempt-current"],
            },
            { id: "verify", status: "running", attemptIds: ["attempt-verify"] },
            { id: "integrate", status: "pending", attemptIds: [] },
            { id: "review", status: "pending", attemptIds: [] },
          ],
        },
      },
      attempts: {
        "attempt-old": {
          id: "attempt-old",
          ticketId: "TK-provider-repair",
          stepId: "implement",
          status: "completed",
          ticketExecutionEpoch: 2,
        },
        "attempt-current": {
          id: "attempt-current",
          ticketId: "TK-provider-repair",
          stepId: "implement",
          status: "completed",
          ticketExecutionEpoch: 3,
        },
      },
    } as unknown as Parameters<typeof shouldAttachCurrentGateRepairEvidence>[0];

    expect(shouldAttachCurrentGateRepairEvidence(run, definition, definition.workflow[0]!)).toBe(
      true,
    );
    expect(shouldAttachCurrentGateRepairEvidence(run, definition, definition.workflow[1]!)).toBe(
      false,
    );
    expect(shouldAttachCurrentGateRepairEvidence(run, definition, definition.workflow[2]!)).toBe(
      false,
    );
    expect(shouldAttachCurrentGateRepairEvidence(run, definition, definition.workflow[3]!)).toBe(
      false,
    );

    const resolver = {
      id: "TK-terminal-resolver",
      workflow: [
        { id: "diagnose", kind: "integration" },
        { id: "resolve", kind: "integration" },
        { id: "review", kind: "review" },
      ],
    } as unknown as Parameters<typeof shouldAttachCurrentGateRepairEvidence>[1];
    const resolverRun = {
      tickets: {
        "TK-terminal-resolver": {
          id: "TK-terminal-resolver",
          executionEpoch: 1,
          steps: [
            {
              id: "diagnose",
              status: "completed",
              attemptIds: ["attempt-diagnose"],
            },
            { id: "resolve", status: "running", attemptIds: [] },
            { id: "review", status: "pending", attemptIds: [] },
          ],
        },
      },
      attempts: {
        "attempt-diagnose": {
          id: "attempt-diagnose",
          ticketId: "TK-terminal-resolver",
          stepId: "diagnose",
          status: "completed",
          ticketExecutionEpoch: 1,
        },
      },
    } as unknown as Parameters<typeof shouldAttachCurrentGateRepairEvidence>[0];

    expect(
      shouldAttachCurrentGateRepairEvidence(resolverRun, resolver, resolver.workflow[1]!),
    ).toBe(true);

    const directGateRecheck = {
      id: "TK-run-gate",
      operation_registry_id: "gates.gate.run-gate",
      workflow: [{ id: "run", kind: "production" }],
    } as unknown as Parameters<typeof shouldAttachCurrentGateRepairEvidence>[1];
    expect(
      shouldAttachCurrentGateRepairEvidence(
        { tickets: {}, attempts: {} },
        directGateRecheck,
        directGateRecheck.workflow[0]!,
      ),
    ).toBe(false);
  });

  it("carries an operator rejection into the reissued source attempt", () => {
    const instructions = rejectedSourceProposalInstructions(
      {
        tickets: {
          "TK-source": { id: "TK-source" },
          "TK-proposal": {
            id: "TK-proposal",
            title: "Change request: replace upstream package",
            executionControl: {
              proposalRequest: {
                requestSha256: digest("request"),
                sourceTicketId: "TK-source",
              },
              proposalDecision: {
                decision: "rejection",
                message: "The current verifier passes; preserve it and continue.",
                recordedAt: "2026-08-11T07:15:00.000Z",
                sha256: digest("rejection"),
              },
              proposalDisposition: {
                kind: "rejected",
                authoritySha256: digest("rejection"),
              },
            },
          },
        },
      } as unknown as RunRecord,
      "TK-source",
    );

    expect(instructions).toEqual([
      `Operator rejection ${digest("rejection")} for prior upstream request TK-proposal (${digest("request")}): The current verifier passes; preserve it and continue.`,
      "Treat that rejection as binding corrective evidence. Do not repeat the rejected upstream request from older diagnostics unless new compiler-authenticated evidence recorded after the rejection contradicts it; continue the source workflow under the operator's correction.",
    ]);
  });

  it("rechecks repaired providers at direct scientific gate boundaries despite an older terminal receipt", () => {
    const nodes = new Map([
      ["experiment-a", { type: "experiment" }],
      ["prerequisite-a", { type: "prerequisite" }],
      ["hypothesis-root", { type: "hypothesis" }],
      ["gate-experiment", { type: "gate" }],
      ["gate-prerequisite", { type: "gate" }],
      ["gate-terminal", { type: "gate" }],
      ["asset-repaired", { type: "asset", asset_manifest: { hash: digest("repaired-manifest") } }],
      ["asset-unsettled", { type: "asset" }],
    ]);
    const graph = { node: (id: string) => nodes.get(id) };
    const evaluation = {
      gate_policy_contexts: [
        {
          gate_node_id: "gate-experiment",
          winner_node_id: "asset-repaired",
          evaluation_target_node_ids: ["experiment-a"],
        },
        {
          gate_node_id: "gate-prerequisite",
          winner_node_id: "asset-repaired",
          evaluation_target_node_ids: ["prerequisite-a"],
        },
        {
          gate_node_id: "gate-terminal",
          winner_node_id: "asset-repaired",
          evaluation_target_node_ids: ["experiment-a"],
        },
        {
          gate_node_id: "gate-root",
          winner_node_id: "asset-repaired",
          evaluation_target_node_ids: ["hypothesis-root"],
        },
        {
          gate_node_id: "gate-unsettled",
          winner_node_id: "asset-unsettled",
          evaluation_target_node_ids: ["experiment-a"],
        },
      ],
      facts: [
        ...[
          "gate-experiment",
          "gate-prerequisite",
          "gate-terminal",
          "gate-root",
          "gate-unsettled",
        ].map((gateId) => ({
          anchor_node_id: gateId,
          kind: "readiness",
          value: "blocked",
          args: {
            blocking_gate_ids: [gateId],
            current_terminal_gate_ids: gateId === "gate-terminal" ? [gateId] : [],
          },
        })),
      ],
    } as unknown as CompiledRuleEvaluation;

    expect(repairedProviderBlockedDirectGateNodeIds(graph, evaluation)).toEqual(
      new Set(["gate-experiment", "gate-prerequisite", "gate-terminal"]),
    );
    expect(
      repairedProviderDirectGateReadNodeIds(graph, {
        gate_node_id: "gate-experiment",
        winner_node_id: "asset-repaired",
        evaluation_target_node_ids: ["experiment-a"],
        context_node_ids: ["unrelated-run-contract", "gate-prerequisite"],
      }),
    ).toEqual(["asset-repaired", "experiment-a", "gate-experiment"]);
  });

  it("does not let an older provider manifest's gate ticket suppress a fresh recheck", () => {
    const definitions = [
      {
        id: "TK-compat-run-gate-old-manifest",
        operation_registry_id: "gates.gate.run-gate",
        target_node_ids: ["gate-experiment"],
      },
    ] as unknown as DerivedTicketDefinition[];

    expect(
      hasManifestScopedDirectGateRecheck(definitions, "TK-compat-run-gate-current-manifest"),
    ).toBe(false);
    expect(hasManifestScopedDirectGateRecheck(definitions, "TK-compat-run-gate-old-manifest")).toBe(
      true,
    );
  });

  it("replaces stale same-gate run definitions with the current manifest-bound recheck", () => {
    const stale = {
      id: "TK-stale-gate-run",
      operation_registry_id: "gates.gate.run-gate",
      target_node_ids: ["gate-experiment"],
    } as unknown as DerivedTicketDefinition;
    const unrelated = {
      id: "TK-unrelated-gate-run",
      operation_registry_id: "gates.gate.run-gate",
      target_node_ids: ["gate-unrelated"],
    } as unknown as DerivedTicketDefinition;
    const current = {
      id: "TK-compat-run-gate-current-manifest",
      operation_registry_id: "gates.gate.run-gate",
      target_node_ids: ["gate-experiment"],
    } as unknown as DerivedTicketDefinition;

    expect(replaceGateRunDefinitionsWithManifestRechecks([stale, unrelated], [current])).toEqual([
      unrelated,
      current,
    ]);
  });

  it("selects an already-present current manifest recheck for stale-definition replacement", () => {
    const stale = {
      id: "TK-stale-gate-run",
      operation_registry_id: "gates.gate.run-gate",
      target_node_ids: ["gate-experiment"],
    } as unknown as DerivedTicketDefinition;
    const current = {
      id: "TK-compat-run-gate-current-manifest",
      operation_registry_id: "gates.gate.run-gate",
      target_node_ids: ["gate-experiment"],
    } as unknown as DerivedTicketDefinition;

    expect(
      manifestScopedDirectGateRechecks(
        [stale, current],
        new Set(["TK-compat-run-gate-current-manifest"]),
      ),
    ).toEqual([current]);
  });

  it("routes a pristine held gate rerun proposal through the current manifest recheck", () => {
    const proposal = {
      id: "TK-change-rerun-gate",
      title: "Change request: rerun the repaired gate verifier",
      status: "proposed",
      targetNodeIds: ["gate-experiment"],
      steps: [{ id: "scope-change", status: "pending", attemptIds: [] }],
      executionControl: {
        proposalRequest: {
          requestSha256: digest("rerun-gate-request"),
          sourceTicketId: "TK-stale-gate-run",
          sourceStepId: "analyze",
          sourceOutputSha256: digest("stale-gate-analysis"),
          fulfillment: "dynamic_scope_change",
        },
      },
    } as unknown as TicketRecord;
    const source = {
      id: "TK-stale-gate-run",
      operationId: "gates.gate.run-gate",
      status: "blocked",
      targetNodeIds: ["gate-experiment"],
      steps: [
        { id: "run", status: "completed", attemptIds: ["attempt-stale-run"] },
        { id: "analyze", status: "completed", attemptIds: ["attempt-stale-analysis"] },
        { id: "integrate", status: "pending", attemptIds: [] },
      ],
      executionControl: {
        sourceHold: {
          proposalTicketId: proposal.id,
          requestSha256: proposal.executionControl!.proposalRequest!.requestSha256,
        },
      },
    } as unknown as TicketRecord;
    const current = {
      id: "TK-compat-run-gate-current-manifest",
      rule_id: "compiler.compatibility.repaired-provider-gate-recheck",
      operation_registry_id: "gates.gate.run-gate",
      target_node_ids: ["gate-experiment"],
    } as unknown as DerivedTicketDefinition;
    const tickets = { [source.id]: source, [proposal.id]: proposal };

    expect(routeSupersededGateRunProposals(tickets, [current], FIXED_NOW.toISOString())).toEqual([
      proposal.id,
    ]);
    expect(proposal).toMatchObject({
      status: "cancelled",
      blocker: "Superseded by a current manifest-bound gate recheck",
      steps: [{ status: "skipped", attemptIds: [] }],
    });
    expect(source).toMatchObject({
      status: "blocked",
      steps: [
        { status: "completed", attemptIds: ["attempt-stale-run"] },
        { status: "completed", attemptIds: ["attempt-stale-analysis"] },
        { status: "pending", attemptIds: [] },
      ],
      executionControl: { sourceHold: { proposalTicketId: proposal.id } },
    });
  });

  it("keeps standalone scientific support runs while excluding gate-check run records", () => {
    const nodes = new Map([
      ["experiment-one", { type: "experiment" }],
      ["asset-support", { type: "asset" }],
      ["gate-support", { type: "gate" }],
      ["run-scientific", { type: "run" }],
      [
        "run-support",
        {
          type: "run",
          spec: {
            runtime_contract: {
              result_protocol: "autoresearch.research-result.v1",
              output_root: "runs/support",
            },
          },
        },
      ],
      [
        "run-gate-check",
        {
          type: "run",
          spec: { runtime_contract: { result_protocol: "autoresearch.gate-result.v1" } },
        },
      ],
    ]);
    const graph = {
      node: (id: string) => nodes.get(id),
      edges: () => [
        { source: "experiment-one", relation: "runs", target: "run-scientific" },
        { source: "run-support", relation: "uses", target: "asset-support" },
        { source: "run-support", relation: "evaluates", target: "gate-support" },
        { source: "run-gate-check", relation: "evaluates", target: "gate-one" },
      ],
    };
    const definitions = [
      {
        id: "ticket-gate-check-contract",
        operation_registry_id: "execution.node.compile-run-plan",
        target_node_ids: ["run-gate-check"],
      },
      {
        id: "ticket-scientific-contract",
        operation_registry_id: "execution.node.compile-run-plan",
        target_node_ids: ["run-scientific"],
      },
      {
        id: "ticket-support-contract",
        operation_registry_id: "execution.node.compile-run-plan",
        target_node_ids: ["run-support"],
      },
      {
        id: "ticket-plan-experiment",
        operation_registry_id: "execution.node.compile-run-plan",
        target_node_ids: ["experiment-one"],
      },
      {
        id: "ticket-gate-analysis",
        operation_registry_id: "gates.gate.run-gate",
        target_node_ids: ["gate-one"],
      },
    ] as unknown as DerivedTicketDefinition[];

    expect(
      scientificRunTicketDefinitions(graph, definitions).map((definition) => definition.id),
    ).toEqual([
      "ticket-scientific-contract",
      "ticket-support-contract",
      "ticket-plan-experiment",
      "ticket-gate-analysis",
    ]);
    expect(
      existingStandaloneSupportRunForUpstreamRequest(graph, ["asset-support", "gate-support"]),
    ).toBe("run-support");
    expect(
      existingStandaloneSupportRunForUpstreamRequest(graph, ["asset-support"], ["gate-support"]),
    ).toBe("run-support");
    expect(
      existingStandaloneSupportRunForUpstreamRequest(graph, ["asset-support"]),
    ).toBeUndefined();
    expect(
      existingStandaloneSupportRunForUpstreamRequest(graph, ["asset-support"], ["gate-one"]),
    ).toBeUndefined();
    expect(
      existingStandaloneSupportRunForUpstreamRequest(graph, ["asset-support", "gate-one"]),
    ).toBeUndefined();
  });

  it("expands a scientific run-contract repair ticket to its concrete research assets", () => {
    const nodes = new Map([
      ["run-ablation", { id: "run-ablation", type: "run", spec: {} }],
      ["ablation-one", { id: "ablation-one", type: "ablation", spec: {} }],
      ["experiment-one", { id: "experiment-one", type: "experiment", spec: {} }],
      ["method-one", { id: "method-one", type: "method", spec: {} }],
      ["prerequisite-pool", { id: "prerequisite-pool", type: "prerequisite", spec: {} }],
      ["prerequisite-basis", { id: "prerequisite-basis", type: "prerequisite", spec: {} }],
      [
        "asset-harness",
        {
          id: "asset-harness",
          type: "asset",
          spec: { implementation_plan: { root: "program/assets/harness" } },
        },
      ],
      [
        "asset-pool",
        {
          id: "asset-pool",
          type: "asset",
          spec: { implementation_plan: { root: "program/assets/pool" } },
        },
      ],
      [
        "asset-basis",
        {
          id: "asset-basis",
          type: "asset",
          spec: { implementation_plan: { root: "program/assets/basis" } },
        },
      ],
      [
        "asset-unrelated",
        {
          id: "asset-unrelated",
          type: "asset",
          spec: { implementation_plan: { root: "program/assets/unrelated" } },
        },
      ],
    ]);
    const graph = {
      node: (id: string) => nodes.get(id),
      edges: () => [
        { source: "run-ablation", relation: "evaluates", target: "ablation-one" },
        { source: "experiment-one", relation: "ablations", target: "ablation-one" },
        { source: "experiment-one", relation: "runs", target: "run-ablation" },
        { source: "ablation-one", relation: "baseline", target: "method-one" },
        { source: "ablation-one", relation: "variant", target: "method-one" },
        { source: "ablation-one", relation: "requires", target: "prerequisite-pool" },
        { source: "ablation-one", relation: "requires", target: "prerequisite-basis" },
        { source: "method-one", relation: "implements", target: "asset-harness" },
        { source: "prerequisite-pool", relation: "satisfied_by", target: "asset-pool" },
        { source: "prerequisite-basis", relation: "satisfied_by", target: "asset-basis" },
      ],
    };
    const definition = {
      protocol: "koni.derived-ticket.v1",
      id: "ticket-contract",
      rule_id: "ticket.repair-run-contract",
      operation_registry_id: "execution.node.compile-run-plan",
      target_node_ids: ["run-ablation"],
      source_state_key: "run-missing-executable-contract",
      configuration_sha256: digest("configuration"),
      scope: {
        read_node_ids: ["ablation-one", "run-ablation"],
        write_node_ids: ["run-ablation"],
        read_paths: [],
        write_paths: [],
      },
      definition_sha256: digest("old-definition"),
    } as unknown as DerivedTicketDefinition;
    const evaluation = {
      tickets: [definition],
      facts: [],
      gate_policy_contexts: [],
      configuration_sha256: digest("configuration"),
      evaluation_sha256: digest("old-evaluation"),
    } as unknown as CompiledRuleEvaluation;

    const repaired = researchRunContractScopeFallback(graph, evaluation);

    expect(repaired.tickets).toHaveLength(1);
    expect(repaired.tickets.map((ticket) => ticket.id)).not.toContain(definition.id);
    const scoped = repaired.tickets[0]!;
    expect(scoped.id).toMatch(/^TK-compat-run-contract-scope-/u);
    expect(scoped.scope.read_node_ids).toEqual([
      "ablation-one",
      "asset-basis",
      "asset-harness",
      "asset-pool",
      "experiment-one",
      "method-one",
      "prerequisite-basis",
      "prerequisite-pool",
      "run-ablation",
    ]);
    expect(scoped.scope.read_paths).toEqual([
      "program/assets/basis",
      "program/assets/harness",
      "program/assets/pool",
    ]);
    expect(scoped.scope.read_node_ids).not.toContain("asset-unrelated");
    expect(scoped.definition_sha256).not.toBe(definition.definition_sha256);
    expect(repaired.evaluation_sha256).not.toBe(evaluation.evaluation_sha256);
  });

  it("carries completed approved-change obligations into later tickets for the same target", () => {
    const run = {
      tickets: {
        "TK-application": {
          id: "TK-application",
          status: "completed",
          summary: "Use runpy.run_path and the exact five-element repository argv.",
          targetNodeIds: ["asset-adapter", "run-audit"],
          executionControl: {
            approvedApplicationSha256: digest("approved-application"),
            controlTicketAuthority: { role: "approved_application" },
          },
        },
        "TK-ordinary": {
          id: "TK-ordinary",
          status: "completed",
          summary: "Unrelated ordinary work.",
          targetNodeIds: ["asset-adapter"],
        },
      },
    } as unknown as RunRecord;

    expect(approvedChangeObligationsForTargets(run, ["run-audit"])).toEqual([
      {
        ticketId: "TK-application",
        approvedApplicationSha256: digest("approved-application"),
        targetNodeIds: ["asset-adapter", "run-audit"],
        summary: "Use runpy.run_path and the exact five-element repository argv.",
      },
    ]);
    expect(approvedChangeObligationsForTargets(run, ["unrelated"])).toEqual([]);
  });

  it("rejects a stale run contract that contradicts a completed approved-change argv", () => {
    const run = {
      tickets: {
        "TK-application": {
          id: "TK-application",
          status: "completed",
          summary:
            "Authorize the sibling protocol adapter on run-audit (command=['python3','.../adapt_result.py','.../verify_review.py','--gate-id','gate-review']). No change to scientific_inputs roles.",
          targetNodeIds: ["asset-review", "run-audit"],
          executionControl: {
            approvedApplicationSha256: digest("approved-application"),
            controlTicketAuthority: { role: "approved_application" },
          },
        },
      },
    } as unknown as RunRecord;
    const asset = {
      id: "asset-review",
      type: "asset",
      spec: {
        implementation: {
          entrypoints: [
            "program/assets/review/verify_review.py",
            "program/assets/review/adapt_result.py",
          ],
        },
        gate_contracts: {
          "gate-review": {
            argv: ["python3", "program/assets/review/verify_review.py", "--gate-id", "gate-review"],
          },
        },
      },
    } as unknown as GraphNode;
    const contract = {
      command: ["python3", "program/assets/review/adapt_result.py", "--gate-id", "gate-review"],
      scientific_inputs: [
        {
          asset_id: "asset-review",
          path: "program/assets/review/adapt_result.py",
          role: "protocol_adapter",
        },
      ],
    };
    const runNode = {
      id: "run-audit",
      type: "run",
      spec: { runtime_contract: contract },
    } as unknown as GraphNode;
    const nodes = new Map([
      [asset.id, asset],
      [runNode.id, runNode],
    ]);
    const graph = { node: (id: string) => nodes.get(id) };

    expect(() => assertApprovedChangeRuntimeObligations(run, graph, ["run-audit"])).toThrow(
      /approved command/,
    );

    contract.command = [
      "python3",
      "program/assets/review/adapt_result.py",
      "program/assets/review/verify_review.py",
      "--gate-id",
      "gate-review",
    ];
    expect(() => assertApprovedChangeRuntimeObligations(run, graph, ["run-audit"])).toThrow(
      /scientific input/,
    );

    contract.scientific_inputs.push({
      asset_id: "asset-review",
      path: "program/assets/review/verify_review.py",
      role: "verifier_implementation",
    });
    expect(() => assertApprovedChangeRuntimeObligations(run, graph, ["run-audit"])).toThrow(
      /scientific input role/,
    );
    contract.scientific_inputs[1]!.role = "verifier_contract";
    expect(() => assertApprovedChangeRuntimeObligations(run, graph, ["run-audit"])).not.toThrow();
    expect(() =>
      assertFailedReviewDoesNotContradictApprovedChangeRuntimeObligations(
        run,
        graph,
        ["run-audit"],
        `The durable approved-change obligation ${digest("approved-application")} requires repair.`,
      ),
    ).toThrow(/contradicts satisfied approved change/);
    expect(() =>
      assertFailedReviewDoesNotContradictApprovedChangeRuntimeObligations(
        run,
        graph,
        ["run-audit"],
        "A separate runtime measurement is missing.",
      ),
    ).not.toThrow();
    expect(() => assertApprovedChangeRuntimeObligations(run, graph, ["unrelated"])).not.toThrow();
  });

  it("allows diagnosis-only recovery steps to report a stale approved-change contract", () => {
    expect(
      shouldAssertApprovedChangeRuntimeObligations({
        id: "diagnose",
        graph_mutation: "allowed",
      }),
    ).toBe(false);
    expect(
      shouldAssertApprovedChangeRuntimeObligations({
        id: "resolve",
        graph_mutation: "allowed",
      }),
    ).toBe(true);
    expect(
      shouldAssertApprovedChangeRuntimeObligations({
        id: "review",
        graph_mutation: "allowed",
      }),
    ).toBe(true);
  });

  it("gives review the ordered transitive execution evidence, not only its immediate parent", () => {
    const workflow = [
      { id: "establish-baseline", depends_on: [] },
      { id: "implement", depends_on: ["establish-baseline"] },
      { id: "review", depends_on: ["implement"] },
    ];

    expect(orderedReviewPredecessorStepIds(workflow, workflow[2]!)).toEqual([
      "establish-baseline",
      "implement",
    ]);
  });

  it("attaches compiler-authenticated predecessor evidence to dependent non-review steps", () => {
    expect(shouldAttachPredecessorExecution({ kind: "agent", depends_on: ["run"] })).toBe(true);
    expect(shouldAttachPredecessorExecution({ kind: "integration", depends_on: ["analyze"] })).toBe(
      true,
    );
    expect(shouldAttachPredecessorExecution({ kind: "production", depends_on: [] })).toBe(false);
  });

  it("rejects obvious setup failures without rejecting an ordinary expected-red assertion", () => {
    expect(
      commandInfrastructureFailure(
        "FAIL feature.test.ts > renders General\nAssertionError: expected 'Sales Notes' to be 'General'",
        "",
      ),
    ).toBeUndefined();
    expect(commandInfrastructureFailure("", "Error: Cannot find module 'framer-motion'")).toContain(
      "could not load one of its modules",
    );
    expect(
      commandInfrastructureFailure(
        "",
        [
          "Traceback (most recent call last):",
          '  File "program/assets/dev_pool/generate_dev_pool.py", line 52, in <module>',
          "    import torch",
          "ModuleNotFoundError: No module named 'torch'",
        ].join("\n"),
      ),
    ).toContain("could not load one of its modules");
    expect(commandInfrastructureFailure("", "ReferenceError: React is not defined")).toContain(
      "test harness failed before its focused assertions ran",
    );
    expect(
      commandInfrastructureFailure("", "Error: Objects are not valid as a React child"),
    ).toContain("test harness failed before its focused assertions ran");
    expect(commandInfrastructureFailure("No test files found, exiting with code 1", "")).toContain(
      "did not execute a test",
    );
    expect(
      commandInfrastructureFailure(
        "[WARN] Local package.json exists, but node_modules missing, did you mean to install?",
        "sh: vitest: command not found",
      ),
    ).toContain("check runner failed to launch");
    expect(commandInfrastructureFailure("", "sh: pytest: command not found")).toContain(
      "check runner failed to launch",
    );
  });

  it("admits an expected-red missing local module only when it is an exact declared input", () => {
    const localFailure = [
      "Error: Cannot find module './SalesNotesFields' imported from",
      "'/tmp/worktree/apps/books/src/components/SalesNotesFields.test.tsx'",
    ].join(" ");
    const declaredInputs = [
      "apps/books/src/components/SalesNotesFields.test.tsx",
      "apps/books/src/components/SalesNotesFields.tsx",
    ];

    expect(commandInfrastructureFailure("", localFailure, declaredInputs)).toBeUndefined();
    expect(
      commandInfrastructureFailure(
        "",
        [
          localFailure,
          "Serialized Error: { code: 'ERR_MODULE_NOT_FOUND' }",
          "Caused by: Error: Failed to load url ./SalesNotesFields (resolved id: ./SalesNotesFields). Does the file exist?",
        ].join("\n"),
        declaredInputs,
      ),
    ).toBeUndefined();
    expect(commandInfrastructureFailure("", localFailure, declaredInputs.slice(0, 1))).toContain(
      "could not load one of its modules",
    );
    expect(
      commandInfrastructureFailure(
        "",
        `${localFailure}\nError: Cannot find module 'framer-motion'`,
        declaredInputs,
      ),
    ).toContain("could not load one of its modules");
    expect(
      commandInfrastructureFailure(
        "",
        `${localFailure}\nReferenceError: React is not defined`,
        declaredInputs,
      ),
    ).toContain("test harness failed before its focused assertions ran");
  });

  it("does not let a package-manager child-exit wrapper mask an exact declared expected red", () => {
    const declaredInputs = [
      "apps/books/src/pages/analysis/index.test.tsx",
      "apps/books/src/pages/analysis/components/AnalysisGuideContent.tsx",
    ];
    const stderr = [
      "FAIL src/pages/analysis/index.test.tsx > Customer Analysis guide",
      "AssertionError: promise rejected \"Error: Cannot find module './components/A… { code: '…' }\" instead of resolving",
      "Error: Cannot find module './components/AnalysisGuideContent' imported from",
      "'/tmp/worktree/apps/books/src/pages/analysis/index.test.tsx'",
      "Caused by: Error: Failed to load url ./components/AnalysisGuideContent (resolved id: ./components/AnalysisGuideContent). Does the file exist?",
      "[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command failed with exit code 1: vitest --run src/pages/analysis/index.test.tsx",
    ].join("\n");

    expect(
      commandInfrastructureFailure("Tests 1 failed | 426 passed", stderr, declaredInputs),
    ).toBe(undefined);
  });

  it("rebinds current check evidence across only non-interfering graph changes", async () => {
    const project = await installedProject("coding-profile");
    await mkdir(path.join(project.projectRoot, "src"), { recursive: true });
    await mkdir(path.join(project.projectRoot, "tests"), { recursive: true });
    await mkdir(path.join(project.projectRoot, "test-support"), { recursive: true });
    await writeFile(
      path.join(project.projectRoot, "src/feature.ts"),
      "export const label = 'legacy';\n",
    );
    await writeFile(
      path.join(project.projectRoot, "tests/feature.test.mjs"),
      "process.exitCode = 1;\n",
    );
    await writeFile(
      path.join(project.projectRoot, "test-support/vitest.config.ts"),
      "export default {};\n",
    );
    const compiled = await compileProjectDirectory(project.projectRoot, project.baseline);
    if (!compiled.ok) throw new Error("coding fixture configuration did not compile");
    const projected = projectGraphSchemaDefinition(compiled.value);
    if (!projected.ok) throw new Error("coding fixture graph schema did not compile");
    const schema = new GraphSchema(projected.value);
    const program = await compilerProgram(project);
    const runId = "run-review-evidence-successor";
    const resolved = await program.resolveRun({
      runId,
      objective: "Preserve current promotion evidence across review status effects",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Preserve current promotion evidence across review status effects" },
    });
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
    const run = runRecord(
      project.projectRoot,
      runId,
      "Preserve current promotion evidence",
      resolved,
    );
    const planning = await program.compilePlanningOutput({
      run,
      attemptId: "attempt-review-evidence-plan",
      output: proofPreparationPlanningOutput(),
    });
    run.plan = { ...planning.plan, status: "approved" };
    run.graphHash = planning.graphHash;
    run.graphRevision = planning.graphRevision ?? 0;
    materializeApprovedFixtureRun(run);
    const initialized = await program.initializeApprovedPlan(run);
    const graphWrite = initialized.artifactWrites?.find((write) =>
      write.path.endsWith("/program/graph.json"),
    );
    const graphArtifact = JSON.parse(Buffer.from(graphWrite!.bytes).toString("utf8")) as {
      nodes: Record<string, GraphNode>;
    };
    const nodes = Object.values(graphArtifact.nodes);
    const proof = nodes.find((node) => node.type === "proof")!;
    const prepared = { ...structuredClone(proof), status: "prepared" };
    const passing = { ...structuredClone(proof), status: "passing" };
    const beforeNodes = nodes.map((node) => (node.id === proof.id ? prepared : node));
    const afterNodes = nodes.map((node) => (node.id === proof.id ? passing : node));
    const before = new TypedGraph(schema, beforeNodes, { projectRoot: project.projectRoot });
    const after = new TypedGraph(schema, afterNodes, { projectRoot: project.projectRoot });
    const leaf = { op: "check_passed", subject: "$target", check: "promotion-proof-set" };
    const beforeSha256 = ruleInputGraphSha256(compiled.value, before);
    const key = rulePredicateEvidenceKey({
      configurationSha256: compiled.value.configuration_sha256,
      inputGraphSha256: beforeSha256,
      leaf,
      subjectNodeId: proof.id,
      bindings: { target: [proof.id] },
    });
    const evidence = createRuleAuthorityEvidence({
      protocol: RULE_AUTHORITY_EVIDENCE_PROTOCOL,
      configurationSha256: compiled.value.configuration_sha256,
      inputGraphSha256: beforeSha256,
      predicates: {
        [key]: {
          key,
          result: true,
          recordedAt: FIXED_NOW.toISOString(),
          sourceReceiptIds: ["check-evidence-current-promotion"],
          leaf,
          subjectNodeId: proof.id,
          bindings: { target: [proof.id] },
        },
      },
    });
    const rebound = rebindRuleEvidenceAcrossNonInterferingGraphChange({
      configuration: compiled.value,
      before,
      after,
      evidence,
    });
    expect(rebound).toMatchObject({
      inputGraphSha256: ruleInputGraphSha256(compiled.value, after),
      predicates: expect.objectContaining({
        [rulePredicateEvidenceKey({
          configurationSha256: compiled.value.configuration_sha256,
          inputGraphSha256: ruleInputGraphSha256(compiled.value, after),
          leaf,
          subjectNodeId: proof.id,
          bindings: { target: [proof.id] },
        })]: expect.objectContaining({ result: true }),
      }),
    });
    const objective = nodes.find((node) => node.type === "objective")!;
    const unrelatedAfter = new TypedGraph(
      schema,
      afterNodes.map((node) =>
        node.id === objective.id
          ? { ...structuredClone(node), title: "Unrelated delivery metadata changed" }
          : node,
      ),
      { projectRoot: project.projectRoot },
    );
    const unrelatedRebound = rebindRuleEvidenceAcrossNonInterferingGraphChange({
      configuration: compiled.value,
      before,
      after: unrelatedAfter,
      evidence,
    });
    expect(unrelatedRebound?.inputGraphSha256).toBe(
      ruleInputGraphSha256(compiled.value, unrelatedAfter),
    );
    expect(Object.values(unrelatedRebound?.predicates ?? {})).toEqual([
      expect.objectContaining({ result: true, subjectNodeId: proof.id }),
    ]);
    expect(
      rebindRuleEvidenceAcrossNonInterferingGraphChange({
        configuration: compiled.value,
        before,
        after: new TypedGraph(
          schema,
          afterNodes.map((node) =>
            node.id === proof.id
              ? { ...structuredClone(passing), title: "Changed semantic title" }
              : node,
          ),
          { projectRoot: project.projectRoot },
        ),
        evidence,
      }),
    ).toBeUndefined();
    expect(
      rebindRuleEvidenceAcrossNonInterferingGraphChange({
        configuration: compiled.value,
        before,
        after: new TypedGraph(
          schema,
          beforeNodes.map((node) =>
            node.id === proof.id ? { ...structuredClone(prepared), status: "superseded" } : node,
          ),
          { projectRoot: project.projectRoot },
        ),
        evidence,
      }),
    ).toBeUndefined();
  }, 30_000);

  it("projects the compiler-validated project default into the operator catalog", async () => {
    const project = await installedProject("coding-profile");
    const program = await compilerProgram(project);

    expect(await program.controlCatalog()).toMatchObject({
      protocol: "koni.control-catalog.v1",
      defaultRunTypeId: "medium",
      runTypes: expect.arrayContaining([expect.objectContaining({ id: "medium" })]),
    });
  }, 30_000);

  it("reconstructs only the durable active behavior for authenticated software 0.7 runs", async () => {
    const project = await installedProject("coding-profile");
    const compiled = await compileProjectDirectory(project.projectRoot, project.baseline);
    if (!compiled.ok) throw new Error("coding fixture configuration did not compile");
    const legacy = legacySoftwareConfigurationFixture(compiled.value, "medium");
    const before = canonicalHash(legacy);
    const behavior = projectHistoricalCompiledBehavior(legacy, "medium");
    if (behavior === undefined) throw new Error("historical behavior was not projected");

    const program = await compilerProgram(project);
    const objective = "Resume one immutable pre-behavior run";
    const resolved = await program.resolveRun({
      runId: "run-historical-behavior",
      objective,
      runTypeId: "medium",
      targetRef: "refs/heads/main",
      intake: { goal: objective },
    });
    const run = runRecord(project.projectRoot, "run-historical-behavior", objective, resolved);
    delete run.behavior;
    assertHistoricalBehaviorMatchesRun(run, behavior, legacy);

    expect(canonicalHash(legacy)).toBe(before);
    expect(Object.keys(behavior.runTypes)).toEqual(["medium"]);
    expect(behavior.runTypes.medium?.pipeline.map((stage) => stage.id)).toEqual(
      run.pipelineStageIds,
    );

    const customizedGit = structuredClone(legacy) as unknown as MutableConfigurationFixture;
    const medium = requiredMutableFixtureRecord(
      requiredMutableFixtureRecord(customizedGit.run_types, "run types").medium,
      "medium run type",
    );
    const document = requiredMutableFixtureRecord(medium.document, "medium run type document");
    requiredMutableFixtureRecord(document.git, "medium Git policy").branch_template =
      "custom/runs/{{ run.id }}";
    expect(() =>
      projectHistoricalCompiledBehavior(
        customizedGit as unknown as CompiledConfiguration,
        "medium",
      ),
    ).toThrow(
      expect.objectContaining<Partial<HistoricalBehaviorCompatibilityError>>({
        code: "historical_behavior_git",
      }),
    );

    const driftedRun = structuredClone(run);
    if (driftedRun.executionConfig === undefined)
      throw new Error("fixture run has no execution config");
    driftedRun.executionConfig.agents.lead!.model = "gpt-drift";
    expect(() => assertHistoricalBehaviorMatchesRun(driftedRun, behavior, legacy)).toThrow(
      expect.objectContaining<Partial<HistoricalBehaviorCompatibilityError>>({
        code: "historical_behavior_drift",
      }),
    );
  }, 30_000);

  it("prepares and strictly compiles one read-only run-level Lead judgment", async () => {
    // The bundled Coding presets intentionally skip automatic Lead gates; Research retains them,
    // proving that the bounded qualitative boundary remains a supported configured primitive.
    const project = await installedProject("research-profile");
    const program = await compilerProgram(project);
    const objective = "Prepare a bounded ticket orchestration run";
    const hypothesis =
      "A bounded ticket orchestration preserves compiler authority while completing its scoped work.";
    const resolved = await program.resolveRun({
      runId: "run-lead-judgment",
      objective,
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: objective, hypothesis },
    });
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
    const run = runRecord(project.projectRoot, "run-lead-judgment", objective, resolved);
    run.tickets.obsolete = {
      id: "obsolete",
      operationId: "fixture.obsolete",
      title: "Obsolete compiler work",
      summary: "No longer applies",
      status: "cancelled",
      blocker: "Current compiler predicate no longer applies after prior execution",
      priority: 0,
      dependencyIds: [],
      targetNodeIds: [],
      readNodeIds: [],
      writeNodeIds: [],
      readPaths: [],
      writePaths: [],
      steps: [],
      createdAt: FIXED_NOW.toISOString(),
      updatedAt: FIXED_NOW.toISOString(),
    } as unknown as TicketRecord;
    run.tickets.consumer = {
      id: "consumer",
      operationId: "fixture.consumer",
      title: "Current consumer",
      summary: "Advance after obsolete work settles",
      status: "queued",
      priority: 1,
      dependencyIds: ["obsolete"],
      targetNodeIds: [],
      readNodeIds: [],
      writeNodeIds: [],
      readPaths: [],
      writePaths: [],
      steps: [],
      createdAt: FIXED_NOW.toISOString(),
      updatedAt: FIXED_NOW.toISOString(),
    } as unknown as TicketRecord;
    const prepared = await program.prepareAttempt({
      kind: "lead",
      leadTrigger: "orchestration_entry",
      run,
      attemptId: "attempt-lead-entry",
      sessionId: "session-lead-entry",
      nextAuthorityRevision: 2,
      expectedAuthorityStateHash: digest("lead-entry"),
      lineage: { branchEpoch: 0, reason: "initial" },
    });

    expect(prepared.spec.identity).toMatchObject({
      runId: run.id,
      ticketId: "run-orchestration",
      stepId: "lead-orchestration-entry",
    });
    expect(prepared.spec.workspace.cwd).toBe(project.projectRoot);
    if (prepared.authorityGrant === undefined)
      throw new Error("prepared Lead attempt has no authority grant");
    expect(prepared.authorityGrant.readPaths).toEqual([]);
    expect(prepared.authorityGrant.writePaths).toEqual([]);
    expect(prepared.toolNames).toEqual(["koni_submit_output"]);
    expect(prepared.contextContent).toContain('"kind": "lead_judgment"');
    expect(prepared.contextContent).toContain('"trigger": "orchestration_entry"');
    expect(prepared.contextContent).toContain('"settledDependencyIds": [\n        "obsolete"');
    expect(prepared.contextContent).toContain('"waitingOnDependencyIds": []');
    expect(prepared.spec.persona.initialPrompt).toContain(
      "only waitingOnDependencyIds establishes a current dependency wait",
    );
    expect(prepared.spec.persona.initialPrompt).toContain(
      "settledDependencyIds remains causal history and does not require a completed ticket status",
    );
    expect(prepared.spec.persona.initialPrompt).toContain(
      "Treat each nonterminal ticket in the current ticketBoard as a compiler-derived current obligation",
    );
    expect(prepared.spec.persona.initialPrompt).toContain(
      "Do not infer that it is stale or redundant merely because a completed or cancelled ticket overlaps its target or scope",
    );
    expect(
      Value.Check(prepared.terminalOutputSchema!, {
        protocol: "koni.lead-judgment-output.v1",
        disposition: "proceed",
        summary: "The approved run is ready for deterministic scheduling.",
      }),
    ).toBe(true);
    expect(
      Value.Check(prepared.terminalOutputSchema!, {
        protocol: "koni.lead-judgment-output.v1",
        disposition: "proceed",
        summary: "ready",
        ticketsToStart: ["TK-1"],
      }),
    ).toBe(false);

    const attempt = attemptRecord(prepared.spec, "lead", "running");
    run.attempts[attempt.id] = attempt;
    await persistWrites(project.projectRoot, prepared.artifactWrites ?? []);
    const recovered = await (
      await compilerProgram(project)
    ).recoverAttempt({
      run,
      attempt,
      spec: prepared.spec,
    });
    expect(recovered.toolNames).toEqual(prepared.toolNames);
    expect(recovered.contextContent).toBe(prepared.contextContent);
    await expect(
      program.compileLeadJudgmentOutput({
        run,
        attemptId: attempt.id,
        output: {
          protocol: "koni.lead-judgment-output.v1",
          disposition: "proceed",
          summary: "The approved run is ready for deterministic scheduling.",
        },
      }),
    ).resolves.toEqual({
      protocol: "koni.lead-judgment-output.v1",
      disposition: "proceed",
      summary: "The approved run is ready for deterministic scheduling.",
    });
    await expect(
      program.compileLeadJudgmentOutput({
        run,
        attemptId: attempt.id,
        output: {
          protocol: "koni.lead-judgment-output.v1",
          disposition: "proceed",
          summary: "ready",
          schedule: ["TK-1"],
        },
      }),
    ).rejects.toMatchObject({ code: "lead_output" });
  }, 30_000);

  it("requires and compiles the configured independent run review instead of skipping agent_review", async () => {
    const project = await installedProject("coding-profile");
    const program = await compilerProgram(project);
    const large = await program.resolveRun({
      runId: "run-large-review",
      objective: "Exercise the independent review stage",
      runTypeId: "large",
      targetRef: "refs/heads/main",
      intake: { goal: "Exercise the independent review stage" },
    });
    const small = await program.resolveRun({
      runId: "run-small-no-review",
      objective: "Keep a focused run proportional",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Keep a focused run proportional" },
    });
    await persistWrites(project.projectRoot, [
      ...(large.artifactWrites ?? []),
      ...(small.artifactWrites ?? []),
    ]);
    const largeRun = runRecord(
      project.projectRoot,
      "run-large-review",
      "Exercise the independent review stage",
      large,
    );
    const smallRun = runRecord(
      project.projectRoot,
      "run-small-no-review",
      "Keep a focused run proportional",
      small,
    );
    expect(await program.requiresVerificationAttempt(largeRun)).toBe(true);
    expect(await program.requiresVerificationAttempt(smallRun)).toBe(false);

    largeRun.attempts["attempt-independent-review"] = {
      id: "attempt-independent-review",
      sessionId: "session-independent-review",
      ticketId: "run-verification",
      stepId: "independent-review",
      personaId: "reviewer",
      modelProvider: "openai-codex",
      modelId: "review-model",
      thinkingLevel: "max",
      status: "running",
      launchSpecHash: digest("independent-review-launch"),
      sessionFile: undefined,
      startedAt: FIXED_NOW.toISOString(),
      endedAt: undefined,
      terminalSummary: undefined,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      lineage: { branchEpoch: 0, reason: "initial" },
      authorityMessages: [],
      authorityToolResults: [],
      authorityCompactions: [],
      kind: "verification",
    };
    await expect(
      program.compileVerificationOutput({
        run: largeRun,
        attemptId: "attempt-independent-review",
        output: { status: "completed", summary: "No evidence-backed blockers remain" },
      }),
    ).resolves.toEqual({
      outcome: { status: "completed", summary: "No evidence-backed blockers remain" },
    });
    await expect(
      program.compileVerificationOutput({
        run: largeRun,
        attemptId: "attempt-independent-review",
        output: { status: "failed", blocker: "The acceptance proof is stale" },
      }),
    ).resolves.toEqual({ outcome: { status: "failed", blocker: "The acceptance proof is stale" } });
  }, 30_000);

  it("requires a typed rejection verdict for ticket reviews", async () => {
    const project = await installedProject("coding-profile");
    const program = await compilerProgram(project);
    const runId = "run-typed-ticket-review";
    const resolved = await program.resolveRun({
      runId,
      objective: "Reject defective work without closing its producer ticket",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Reject defective work without closing its producer ticket" },
    });
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
    const run = runRecord(
      project.projectRoot,
      runId,
      "Reject defective work without closing its producer ticket",
      resolved,
    );
    const planning = await program.compilePlanningOutput({
      run,
      attemptId: "attempt-typed-review-plan",
      output: planningOutput({ work_kind: "general" }),
    });
    run.plan = { ...planning.plan, status: "approved" };
    run.graphHash = planning.graphHash;
    run.graphRevision = planning.graphRevision ?? 0;
    materializeApprovedFixtureRun(run);
    const initialized = await program.initializeApprovedPlan(run);
    await persistWrites(project.projectRoot, initialized.artifactWrites ?? []);
    run.graphHash = initialized.graphHash;
    run.graphRevision = initialized.graphRevision;
    run.tickets = initialized.tickets;

    const ticket = Object.values(run.tickets).find((candidate) =>
      candidate.steps.some((step) => step.kind === "review"),
    );
    if (ticket === undefined) throw new Error("fixture did not compile a reviewed ticket");
    const review = ticket.steps.find((step) => step.kind === "review")!;
    const assignment: ReadyAssignment = {
      runId,
      ticketId: ticket.id,
      stepId: review.id,
      personaId: review.personaId,
      priority: ticket.priority,
    };
    const attempt: AgentAttemptRecord = {
      id: "attempt-typed-ticket-review",
      sessionId: "session-typed-ticket-review",
      ticketId: ticket.id,
      stepId: review.id,
      personaId: review.personaId,
      modelProvider: "openai-codex",
      modelId: "review-model",
      thinkingLevel: "xhigh",
      status: "running",
      launchSpecHash: digest("typed-ticket-review-launch"),
      sessionFile: undefined,
      startedAt: FIXED_NOW.toISOString(),
      endedAt: undefined,
      terminalSummary: undefined,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      lineage: { branchEpoch: 0, reason: "review" },
      authorityMessages: [],
      authorityToolResults: [],
      authorityCompactions: [],
      kind: "verification",
    };
    run.attempts[attempt.id] = attempt;
    review.status = "running";
    review.attemptIds = [attempt.id];
    review.startedAt = FIXED_NOW.toISOString();

    await expect(
      program.compileAssignmentOutput({
        run,
        assignment,
        attemptId: attempt.id,
        output: {
          status: "completed",
          summary: "Review rejected: the implementation is unsafe.",
        },
      }),
    ).rejects.toMatchObject({ code: "review_verdict" });
    const rejection = {
      status: "failed",
      reviewVerdict: "rejected",
      blocker: "The implementation is unsafe.",
    };
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment,
        attemptId: attempt.id,
        output: rejection,
      }),
    ).resolves.toEqual({
      outcome: { status: "failed", blocker: "The implementation is unsafe." },
    });
  }, 30_000);

  it("reloads the authenticated package baseline for each future run while preserving pinned runs", async () => {
    const project = await installedProject("coding-profile");
    let loaderCalls = 0;
    const program = await NativeRunCompilerProgram.create({
      projectRoot: project.projectRoot,
      packageBaseline: project.baseline,
      packageBaselineLoader: async () => {
        loaderCalls += 1;
        return project.baseline;
      },
      piInventoryLoader: async () => project.piInventory,
      sealedModelBindingLoader: fixtureSealedModelBinding,
      now: () => new Date(FIXED_NOW),
    });

    const first = await program.resolveRun({
      runId: "run-before-profile-reload",
      objective: "Pin the first effective configuration",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Pin the first effective configuration" },
    });
    await persistWrites(project.projectRoot, first.artifactWrites ?? []);
    const firstRun = runRecord(
      project.projectRoot,
      "run-before-profile-reload",
      "Pin the first effective configuration",
      first,
    );

    const projectYaml = path.join(project.projectRoot, ".koni", "project.yaml");
    await writeFile(
      projectYaml,
      (await readFile(projectYaml, "utf8")).replace(
        "title: Software project",
        "title: Future-run configuration",
      ),
    );
    const second = await program.resolveRun({
      runId: "run-after-profile-reload",
      objective: "Compile the newly edited configuration",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Compile the newly edited configuration" },
    });

    expect(loaderCalls).toBe(2);
    expect(second.compiledConfigHash).not.toBe(first.compiledConfigHash);
    await expect(
      program.prepareAttempt({
        kind: "planning",
        run: firstRun,
        attemptId: "attempt-from-pinned-first-run",
        sessionId: "session-from-pinned-first-run",
        nextAuthorityRevision: 2,
        expectedAuthorityStateHash: digest("pinned-first-run"),
        lineage: { branchEpoch: 0, reason: "initial" },
      }),
    ).resolves.toMatchObject({
      spec: {
        identity: { runId: firstRun.id },
      },
    });
    expect(loaderCalls).toBe(2);
  });

  it("pins Pi-resolved Superpowers and Koni skills into default planning attempts", async () => {
    const expectedSkillEntrypoints = [
      "skills/brainstorming/SKILL.md",
      "skills/configure-koni/SKILL.md",
      "skills/dispatching-parallel-agents/SKILL.md",
      "skills/executing-plans/SKILL.md",
      "skills/finishing-a-development-branch/SKILL.md",
      "skills/model-koni-work/SKILL.md",
      "skills/operate-koni/SKILL.md",
      "skills/receiving-code-review/SKILL.md",
      "skills/requesting-code-review/SKILL.md",
      "skills/subagent-driven-development/SKILL.md",
      "skills/systematic-debugging/SKILL.md",
      "skills/test-driven-development/SKILL.md",
      "skills/using-git-worktrees/SKILL.md",
      "skills/using-superpowers/SKILL.md",
      "skills/verification-before-completion/SKILL.md",
      "skills/writing-plans/SKILL.md",
      "skills/writing-skills/SKILL.md",
    ];

    for (const packageDirectory of ["coding-profile", "research-profile"] as const) {
      const project = await installedProject(packageDirectory);
      const program = await compilerProgram(project);
      const runId = `run-superpowers-${packageDirectory}`;
      const objective = "Plan one bounded change";
      const intake = { goal: objective };
      const resolved = await program.resolveRun({
        runId,
        objective,
        runTypeId: packageDirectory === "research-profile" ? "medium" : "small",
        targetRef: "refs/heads/main",
        intake,
      });
      await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
      const run = runRecord(project.projectRoot, runId, objective, resolved, intake);
      const prepared = await program.prepareAttempt({
        kind: "planning",
        run,
        attemptId: `attempt-superpowers-${packageDirectory}`,
        sessionId: `session-superpowers-${packageDirectory}`,
        nextAuthorityRevision: 2,
        expectedAuthorityStateHash: digest(`superpowers-${packageDirectory}`),
        lineage: { branchEpoch: 0, reason: "initial" },
      });
      const entries = prepared.spec.resources.entries;

      expect(
        entries
          .filter(
            ({ kind, relativePath }) => kind === "skill" && relativePath.endsWith("/SKILL.md"),
          )
          .map(({ relativePath }) => relativePath),
      ).toEqual(expectedSkillEntrypoints);
      expect(entries.some(({ id }) => id === "superpowers-using-bootstrap")).toBe(false);
    }
  });

  it("pins coding resolution, injects answered questions once, and recovers the immutable Pi attempt", async () => {
    const project = await installedProject("coding-profile");
    const program = await compilerProgram(project);
    const runId = "run-native-planning";
    const resolved = await program.resolveRun({
      runId,
      objective: "Add a compact notes workflow",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Add a compact notes workflow" },
      overrides: {
        maxParallel: 2,
        roles: {
          ticket_worker: { model: "gpt-role-worker", thinkingLevel: "low" },
        },
        agents: {
          lead: { thinkingLevel: "max" },
          implementer: { model: "gpt-persona-worker" },
        },
      },
    });
    expect(resolved.executionConfig.maxParallel).toBe(2);
    expect(resolved.executionConfig.agents["run-planner"]).toMatchObject({
      model: "gpt-5.6-terra",
      thinkingLevel: "xhigh",
    });
    expect(resolved.executionConfig.agents.implementer).toMatchObject({
      model: "gpt-persona-worker",
      thinkingLevel: "low",
    });
    expect(resolved.executionConfig.agents["architecture-mapper"]).toMatchObject({
      model: "gpt-role-worker",
      thinkingLevel: "low",
    });
    expect(resolved.executionConfig.agents.lead?.thinkingLevel).toBe("max");
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);

    const run = runRecord(project.projectRoot, runId, "Add a compact notes workflow", resolved);
    run.questions["question-product"] = answeredQuestion();
    const prepared = await program.prepareAttempt({
      kind: "planning",
      run,
      attemptId: "attempt-planning-one",
      sessionId: "session-planning-one",
      nextAuthorityRevision: 4,
      expectedAuthorityStateHash: digest("authority-four"),
      lineage: { branchEpoch: 0, reason: "initial" },
    });
    expect(prepared.spec.lineage).toEqual({ branchEpoch: 0, reason: "initial" });
    expect(prepared.spec.resources.entries.some((entry) => entry.kind === "context")).toBe(false);
    expect(prepared.spec.resources.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "skills/configure-koni/SKILL.md" }),
        expect.objectContaining({
          relativePath: "skills/configure-koni/references/agents-and-skills.md",
        }),
      ]),
    );
    expect(prepared.spec.persona.systemPrompt).toContain(
      "reissues your exact bound context before every provider request",
    );
    expect(prepared.spec.persona.initialPrompt).toContain("literal $root");
    expect(prepared.spec.persona.initialPrompt).toContain("never invent a root alias");
    expect(prepared.spec.persona.initialPrompt).toContain(
      '"concise":{"architecture":[{"title":"...","description":"..."}]',
    );
    expect(prepared.spec.persona.initialPrompt).toContain(
      '"graphSeed":{"rootSpec":{...},"nodes":[...],"edges":[...]}',
    );
    expect(prepared.spec.persona.initialPrompt).toContain(
      "The koni_submit_output arguments must contain four complete Markdown plans",
    );
    expect(prepared.spec.persona.initialPrompt).not.toContain("The final output must contain");
    expect(prepared.spec.persona.initialPrompt).toContain(
      "After any validation error, correct every named field before retrying; never resubmit the same incomplete shape.",
    );
    expect(prepared.spec.persona.initialPrompt).toContain(
      "Submit the required planning payload through koni_submit_output in the same turn",
    );
    expect(prepared.spec.persona.initialPrompt).toContain(
      "Plain assistant text is not a planning submission",
    );
    expect(prepared.contextContent).toContain("allowedNodeTypes");
    expect(prepared.contextContent).toContain("canonicalEdges");
    expect(
      Value.Check(prepared.terminalOutputSchema!, planningOutput({ work_kind: "general" })),
    ).toBe(true);
    expect(prepared.spec.persona.initialPrompt).toContain("a concise 3-4 word name for this run");
    // The operator run name is schema-optional (frozen personas may omit it) but bounded.
    expect(
      Value.Check(prepared.terminalOutputSchema!, {
        ...(planningOutput({ work_kind: "general" }) as Record<string, unknown>),
        title: "Compact Notes Workflow",
      }),
    ).toBe(true);
    expect(
      Value.Check(prepared.terminalOutputSchema!, {
        ...(planningOutput({ work_kind: "general" }) as Record<string, unknown>),
        title: "ab",
      }),
    ).toBe(false);
    expect(
      Value.Check(prepared.terminalOutputSchema!, {
        ...(planningOutput({ work_kind: "general" }) as Record<string, unknown>),
        graphSeed: { rootSpec: { work_kind: "general", invented: true }, nodes: [], edges: [] },
      }),
    ).toBe(false);
    expect(
      Value.Check(prepared.terminalOutputSchema!, {
        ...(planningOutput({ work_kind: "general" }) as Record<string, unknown>),
        graphSeed: {
          rootSpec: { work_kind: "general" },
          nodes: [
            { key: "fake-slice", type: "implementation_slice", title: "Fake slice", spec: {} },
          ],
          edges: [{ source: "$root", relation: "implemented_by", target: "fake-slice" }],
        },
      }),
    ).toBe(false);
    expect(prepared.contextContent).toContain("Use local-first storage");
    expect(prepared.contextContent).toContain("Keep export reversible");
    expect(prepared.contextContent?.match(/Use local-first storage/gu)).toHaveLength(1);
    expect(prepared.toolNames).not.toContain("koni_context");
    expect(prepared.toolNames).toContain("koni_read_resource");
    expect(
      prepared.spec.tools.find((tool) => tool.name === "koni_read_resource")?.executionMode,
    ).toBe("parallel");
    expect(prepared.spec.budgets.transcript).toEqual({ maxBytes: 64 * 1024 * 1024 });
    expect(prepared.spec.budgets.repositoryCalls).toEqual({ max: 16 });
    expect(prepared.spec.budgets.tokens).toMatchObject({
      maxNew: 120_000,
      providerOutputHeadroom: 128_000,
    });
    expect(prepared.compactionSnapshot).toMatchObject({
      plan: {
        architecture: "See the authenticated context reissued after this checkpoint.",
        decisions: "See the authenticated context reissued after this checkpoint.",
        risk: "See the authenticated context reissued after this checkpoint.",
        verification: "See the authenticated context reissued after this checkpoint.",
      },
      nextAction: prepared.spec.persona.initialPrompt,
    });
    expect(prepared.contextContent).toContain('"requiredOutput"');
    expect(JSON.stringify(prepared.compactionSnapshot?.plan)).not.toContain(
      "Planning is still in progress.",
    );

    const exhaustedParent = attemptRecord(prepared.spec, "planning", "aborted");
    exhaustedParent.error = "input token budget exceeded";
    run.attempts[exhaustedParent.id] = exhaustedParent;
    const retried = await program.prepareAttempt({
      kind: "planning",
      run,
      attemptId: "attempt-planning-retry",
      sessionId: "session-planning-retry",
      nextAuthorityRevision: 5,
      expectedAuthorityStateHash: digest("authority-five-retry"),
      lineage: {
        branchEpoch: 1,
        reason: "retry",
        parentAttemptId: "attempt-planning-one",
        parentSessionId: "session-planning-one",
        parentEntryId: "entry-planning-one",
        conversationFork: {
          parentLaunchSpecHash: prepared.spec.specHash,
          parentTranscriptSha256: digest("planning-parent-transcript"),
        },
      },
    });
    expect(retried.spec.persona.initialPrompt).toContain(
      "The inherited Pi conversation is the repository and execution ledger",
    );
    expect(retried.spec.persona.initialPrompt).toContain(
      "Discard any speculative reasoning from that failed turn",
    );
    expect(retried.spec.persona.initialPrompt).toContain(
      "A terminal-tool receipt visible in inherited history belongs to the parent attempt",
    );
    expect(retried.spec.persona.initialPrompt).toContain(
      "Do not reissue an exact repository discovery call that already succeeded or was rejected as a duplicate",
    );
    expect(retried.spec.persona.initialPrompt).toContain(
      "An accepted inherited koni_read_resource receipt already satisfies skill loading",
    );
    expect(retried.spec.persona.initialPrompt).toContain(
      "do not reload the same immutable resource",
    );
    expect(retried.spec.lineage.conversationFork).toEqual({
      parentLaunchSpecHash: prepared.spec.specHash,
      parentTranscriptSha256: digest("planning-parent-transcript"),
    });

    const revisionSteering =
      "Keep the existing Sales Notes record unchanged and store optional fields in sibling records.";
    run.plan = {
      revision: 1,
      status: "planning",
      ...(planningOutput({ work_kind: "new_feature" }) as Pick<
        NonNullable<RunRecord["plan"]>,
        "full" | "concise" | "graphSeed"
      >),
      steeringHistory: [{ at: FIXED_NOW.toISOString(), instructions: revisionSteering }],
    };
    const revised = await program.prepareAttempt({
      kind: "planning",
      run,
      attemptId: "attempt-planning-revision",
      sessionId: "session-planning-revision",
      nextAuthorityRevision: 5,
      expectedAuthorityStateHash: digest("authority-five"),
      lineage: {
        branchEpoch: 1,
        reason: "rework",
        parentAttemptId: "attempt-planning-one",
        parentSessionId: "session-planning-one",
        parentEntryId: "entry-planning-one",
      },
    });
    expect(revised.spec.persona.initialPrompt).toContain("Revise the prior small plan");
    expect(revised.spec.persona.initialPrompt).toContain(revisionSteering);
    expect(revised.spec.persona.initialPrompt).toContain("do not repeat repository discovery");
    expect(
      revised.spec.persona.initialPrompt.match(new RegExp(revisionSteering, "gu")),
    ).toHaveLength(1);
    expect(prepared.spec.budgets.retries).toEqual({
      maxProviderRetries: 0,
      baseDelayMs: 0,
    });
    expect(prepared.spec.model).toMatchObject({
      api: "openai-codex-responses",
      catalogMaxTokens: 128_000,
      catalogSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(prepared.spec.persona.systemPrompt).toContain("bounded to 16 total");
    expect(prepared.spec.persona.systemPrompt).toContain("narrowest objective-derived source root");
    expect(prepared.spec.persona.systemPrompt).toContain(
      "After compaction, use the checkpoint's exact repair findings as causal authority",
    );
    expect(prepared.spec.persona.systemPrompt).toContain(
      "Do not reread immutable evidence inputs merely to reconstruct the finding's rationale",
    );
    await persistWrites(project.projectRoot, prepared.artifactWrites ?? []);

    const attempt = attemptRecord(prepared.spec, "planning", "running");
    run.attempts[attempt.id] = attempt;
    const projectYaml = path.join(project.projectRoot, ".koni", "project.yaml");
    await writeFile(
      projectYaml,
      (await readFile(projectYaml, "utf8")).replace(
        "title: Software project",
        "title: Changed after this run was pinned",
      ),
    );
    const restarted = await compilerProgram(project);
    const recovered = await restarted.recoverAttempt({ run, attempt, spec: prepared.spec });
    expect(recovered.spec).toBe(prepared.spec);
    expect(recovered.contextContent).toBe(prepared.contextContent);
    expect(canonicalHash(recovered.authorityGrant!)).toBe(prepared.spec.authority.grantHash);
    expect(recovered.toolNames).toEqual(prepared.spec.tools.map((tool) => tool.name));
    expect(
      await restarted.refreshCompactionSnapshot({ run, attempt, spec: prepared.spec }),
    ).toMatchObject({
      touchedFiles: [],
      receiptIds: [],
      unresolvedQuestions: [],
    });
    const receiptPath = `runs/${run.id}/attempts/${attempt.id}/tool-receipts/write.json`;
    const receipt = {
      receiptId: "receipt-write-notes",
      summary: "Wrote src/notes.ts",
      value: { path: "src/notes.ts", sha256: digest("notes-bytes") },
    };
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
    const canonicalReceipt = canonicalEncode(receipt);
    await persistWrites(project.projectRoot, [
      {
        path: receiptPath,
        bytes: receiptBytes,
        expectedSha256: null,
      },
    ]);
    attempt.authorityToolResults = [
      {
        sequence: 1,
        callId: "call-write-notes",
        toolName: "koni_write_file",
        outcome: "accepted",
        argumentsSha256: rawSha256("{}"),
        argumentsSizeBytes: 2,
        receiptSha256: rawSha256(canonicalReceipt),
        receiptSizeBytes: Buffer.byteLength(canonicalReceipt, "utf8"),
        artifactPath: receiptPath,
        recordedAt: FIXED_NOW.toISOString(),
      },
    ];
    expect(
      await restarted.refreshCompactionSnapshot({ run, attempt, spec: prepared.spec }),
    ).toMatchObject({
      touchedFiles: ["src/notes.ts"],
      loadedResources: [],
      receiptIds: ["receipt-write-notes"],
    });

    const resourceReceiptPath = `runs/${run.id}/attempts/${attempt.id}/tool-receipts/resource.json`;
    const issuedSkill = prepared.spec.resources.entries.find(
      (entry) => entry.relativePath === "skills/using-superpowers/SKILL.md",
    );
    if (issuedSkill === undefined) throw new Error("fixture has no using-superpowers skill");
    const resourceReceipt = {
      protocol: "koni.tool-receipt.v1" as const,
      receiptId: "receipt-read-skill",
      outcome: "accepted" as const,
      summary: "Read resource skill-using-superpowers",
      value: {
        resourceId: issuedSkill.id,
        relativePath: issuedSkill.relativePath,
        sha256: issuedSkill.sha256,
        offsetChars: 0,
        nextOffsetChars: Array.from(issuedSkill.content).length,
        totalChars: Array.from(issuedSkill.content).length,
        eof: true,
        content: issuedSkill.content,
      },
    };
    const canonicalResourceReceipt = canonicalEncode(resourceReceipt);
    await persistWrites(project.projectRoot, [
      {
        path: resourceReceiptPath,
        bytes: Buffer.from(`${JSON.stringify(resourceReceipt)}\n`, "utf8"),
        expectedSha256: null,
      },
    ]);
    attempt.authorityToolResults.push({
      sequence: 2,
      callId: "call-read-skill",
      toolName: "koni_read_resource",
      outcome: "accepted",
      argumentsSha256: rawSha256("{}"),
      argumentsSizeBytes: 2,
      receiptSha256: rawSha256(canonicalResourceReceipt),
      receiptSizeBytes: Buffer.byteLength(canonicalResourceReceipt, "utf8"),
      artifactPath: resourceReceiptPath,
      recordedAt: FIXED_NOW.toISOString(),
    });
    expect(
      await restarted.refreshCompactionSnapshot({ run, attempt, spec: prepared.spec }),
    ).toMatchObject({
      loadedResources: [`skills/using-superpowers/SKILL.md (${issuedSkill.sha256})`],
      receiptIds: ["receipt-read-skill", "receipt-write-notes"],
    });

    await persistWrites(project.projectRoot, [
      ...(retried.artifactWrites ?? []),
      {
        path: `runs/${run.id}/attempts/${attempt.id}/launch-spec.json`,
        bytes: Buffer.from(JSON.stringify(prepared.spec), "utf8"),
        expectedSha256: null,
      },
      {
        path: `runs/${run.id}/attempts/${retried.spec.identity.attemptId}/launch-spec.json`,
        bytes: Buffer.from(JSON.stringify(retried.spec), "utf8"),
        expectedSha256: null,
      },
    ]);
    const recoveryAttempt = attemptRecord(retried.spec, "planning", "running");
    run.attempts[recoveryAttempt.id] = recoveryAttempt;
    const coldRestart = await compilerProgram(project);
    expect(
      await coldRestart.refreshCompactionSnapshot({
        run,
        attempt: recoveryAttempt,
        spec: retried.spec,
      }),
    ).toMatchObject({
      loadedResources: [`skills/using-superpowers/SKILL.md (${issuedSkill.sha256})`],
    });

    const nonFork = await program.prepareAttempt({
      kind: "planning",
      run,
      attemptId: "attempt-planning-rework-no-fork",
      sessionId: "session-planning-rework-no-fork",
      nextAuthorityRevision: 6,
      expectedAuthorityStateHash: digest("authority-six-no-fork"),
      lineage: {
        branchEpoch: 1,
        reason: "rework",
        parentAttemptId: attempt.id,
        parentSessionId: attempt.sessionId,
        parentEntryId: "entry-planning-one",
      },
    });
    const nonForkAttempt = attemptRecord(nonFork.spec, "planning", "running");
    run.attempts[nonForkAttempt.id] = nonForkAttempt;
    expect(
      await program.refreshCompactionSnapshot({
        run,
        attempt: nonForkAttempt,
        spec: nonFork.spec,
      }),
    ).toMatchObject({ loadedResources: [] });

    const listReceiptPath = `runs/${run.id}/attempts/${attempt.id}/tool-receipts/list.json`;
    const listReceipt = {
      receiptId: "receipt-list-tree",
      summary: "Listed src recursively",
      value: {
        entries: [
          { path: "src/one.ts", kind: "file", sizeBytes: 10 },
          { path: "src/generated", kind: "directory", sizeBytes: 0 },
          { path: "src/generated/two.ts", kind: "file", sizeBytes: 20 },
        ],
      },
    };
    const canonicalListReceipt = canonicalEncode(listReceipt);
    await persistWrites(project.projectRoot, [
      {
        path: listReceiptPath,
        bytes: Buffer.from(`${JSON.stringify(listReceipt)}\n`, "utf8"),
        expectedSha256: null,
      },
    ]);
    attempt.authorityToolResults.push({
      sequence: 3,
      callId: "call-list-tree",
      toolName: "koni_list_files",
      outcome: "accepted",
      argumentsSha256: rawSha256("{}"),
      argumentsSizeBytes: 2,
      receiptSha256: rawSha256(canonicalListReceipt),
      receiptSizeBytes: Buffer.byteLength(canonicalListReceipt, "utf8"),
      artifactPath: listReceiptPath,
      recordedAt: FIXED_NOW.toISOString(),
    });
    expect(
      await restarted.refreshCompactionSnapshot({ run, attempt, spec: prepared.spec }),
    ).toMatchObject({
      touchedFiles: ["src/notes.ts"],
      receiptIds: ["receipt-list-tree", "receipt-read-skill", "receipt-write-notes"],
    });

    await expect(
      program.resolveRun({
        runId: "run-invalid-thinking",
        objective: "Reject a legacy level",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Reject a legacy level" },
        overrides: { agents: { lead: { thinkingLevel: "ultra" } } },
      }),
    ).rejects.toBeInstanceOf(NativeRunProgramError);
  });

  it("uses the pinned compiled behavior as the sole launch and initialization policy", async () => {
    const project = await installedProject("coding-profile");
    const original = await compilerProgram(project);
    const runId = "run-compiled-behavior-only";
    const objective = "Prove compiled behavior authority";
    const resolved = await original.resolveRun({
      runId,
      objective,
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: objective },
    });
    const expectedPlanning = resolved.behavior.runType.planning!;
    const compiledWrite = resolved.artifactWrites?.find(
      (write) => write.path === `runs/${runId}/configuration/compiled.json`,
    );
    expect(compiledWrite).toBeDefined();
    const artifact = JSON.parse(Buffer.from(compiledWrite!.bytes).toString("utf8")) as Record<
      string,
      unknown
    >;
    const configuration = artifact.configuration as Record<string, unknown>;
    const profile = configuration.profile as Record<string, unknown>;
    const initialization = profile.initialization as Record<string, unknown>;
    initialization.root_node_type = "raw-config-must-not-be-read";
    initialization.goal_field = "spec.raw_goal_must_not_be_read";
    initialization.planning_context_field = "spec.raw_context_must_not_be_read";
    initialization.planning_seed_operation = "raw-operation-must-not-be-read";
    initialization.root_status = "raw-status-must-not-be-read";
    const runTypes = configuration.run_types as Record<string, unknown>;
    const small = runTypes.small as Record<string, unknown>;
    const document = small.document as Record<string, unknown>;
    const planning = document.planning as Record<string, unknown>;
    planning.max_repository_tool_calls = 1;
    const rawTokenBudget = planning.token_budget as Record<string, unknown>;
    rawTokenBudget.limit = 2;
    rawTokenBudget.synthesis_reserve = 1;
    delete configuration.configuration_sha256;
    const configurationSha256 = canonicalHash(configuration);
    configuration.configuration_sha256 = configurationSha256;
    delete artifact.artifactSha256;
    artifact.artifactSha256 = canonicalHash(artifact);
    const mutatedWrites = resolved.artifactWrites!.map((write) =>
      write === compiledWrite
        ? { ...write, bytes: Buffer.from(`${JSON.stringify(artifact)}\n`, "utf8") }
        : write,
    );
    const mutatedResolved = {
      ...resolved,
      compiledConfigHash: configurationSha256,
      artifactWrites: mutatedWrites,
    };
    await persistWrites(project.projectRoot, mutatedWrites);
    const run = runRecord(project.projectRoot, runId, objective, mutatedResolved);
    const restarted = await compilerProgram(project);
    const prepared = await restarted.prepareAttempt({
      kind: "planning",
      run,
      attemptId: "attempt-compiled-behavior-only",
      sessionId: "session-compiled-behavior-only",
      nextAuthorityRevision: 7,
      expectedAuthorityStateHash: digest("compiled-behavior-authority"),
      lineage: { branchEpoch: 0, reason: "initial" },
    });
    expect(prepared.spec.budgets.repositoryCalls).toEqual({
      max: expectedPlanning.maxRepositoryToolCalls,
    });
    expect(prepared.spec.budgets.tokens.maxNew).toBe(expectedPlanning.tokenPolicy.limit);
    const compiled = await restarted.compilePlanningOutput({
      run,
      attemptId: prepared.spec.identity.attemptId,
      output: {
        ...(planningOutput({ work_kind: "general" }) as Record<string, unknown>),
        title: "  Compact   Notes Workflow  ",
      },
    });
    expect(compiled.graphHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // The planner-authored operator name is normalized and carried on the durable plan.
    expect(compiled.plan.title).toBe("Compact Notes Workflow");

    const untitled = await restarted.compilePlanningOutput({
      run,
      attemptId: prepared.spec.identity.attemptId,
      output: planningOutput({ work_kind: "general" }),
    });
    expect(untitled.plan.title).toBeUndefined();
  });

  it("compiles a planning patch from the exact validated checkpoint", async () => {
    const project = await installedProject("coding-profile");
    const program = await compilerProgram(project);
    const runId = "run-continuous-planning-patch";
    const objective = "Compile one bounded continuous planning revision";
    const resolved = await program.resolveRun({
      runId,
      objective,
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: objective },
    });
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
    const run = runRecord(project.projectRoot, runId, objective, resolved);
    const tokenPolicy = {
      metric: "new_tokens" as const,
      limit: 120_000,
      synthesisReserve: 20_000,
      synthesisThreshold: 100_000,
      onExhausted: "force_synthesis" as const,
    };
    run.attempts["attempt-plan"] = {
      id: "attempt-plan",
      sessionId: "session-plan",
      ticketId: "run-planning",
      stepId: "planning",
      personaId: "planner",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-5",
      thinkingLevel: "high",
      status: "running",
      launchSpecHash: digest("continuous-planning-initial-launch"),
      sessionFile: `runs/${runId}/sessions/attempt-plan/session-plan.jsonl`,
      startedAt: FIXED_NOW.toISOString(),
      endedAt: undefined,
      terminalSummary: undefined,
      inputTokens: 4_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      kind: "planning",
    };
    run.planningSession = {
      protocol: "koni.planning-session.v1",
      attemptId: "attempt-plan",
      sessionId: "session-plan",
      status: "running",
      currentRevision: 0,
      revisions: [
        {
          protocol: "koni.planning-revision.v1",
          revision: 0,
          status: "running",
          launchSpecSha256: digest("continuous-planning-launch-0"),
          grantSha256: digest("continuous-planning-grant-0"),
          budgetBaseline: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          budgetPolicy: tokenPolicy,
          startedAt: FIXED_NOW.toISOString(),
        },
      ],
    };

    const initial = await program.compilePlanningOutput({
      run,
      attemptId: "attempt-plan",
      output: planningOutput({ work_kind: "general" }),
    });
    expect(initial.plan.revision).toBe(0);
    const baseArtifact = {
      ...(initial.plan.title === undefined ? {} : { title: initial.plan.title }),
      full: initial.plan.full,
      concise: initial.plan.concise,
      graphSeed: initial.plan.graphSeed,
    };
    const baseArtifactSha256 = canonicalHash(baseArtifact);
    const checkpointPath = `runs/${runId}/attempts/attempt-plan/planning/revisions/0/artifact.json`;
    await persistWrites(project.projectRoot, [
      {
        path: checkpointPath,
        bytes: Buffer.from(`${JSON.stringify(baseArtifact)}\n`, "utf8"),
        expectedSha256: null,
      },
    ]);
    run.plan = { ...initial.plan, status: "awaiting_approval" };
    run.planningSession.revisions[0] = {
      ...run.planningSession.revisions[0]!,
      status: "superseded",
      artifactSha256: baseArtifactSha256,
      graphSha256: initial.graphHash!,
      transcriptSha256: digest("continuous-planning-transcript-0"),
      checkpointPath,
      completedAt: FIXED_NOW.toISOString(),
    };
    run.planningSession.currentRevision = 1;
    run.planningSession.revisions.push({
      protocol: "koni.planning-revision.v1",
      revision: 1,
      status: "running",
      launchSpecSha256: digest("continuous-planning-launch-1"),
      grantSha256: digest("continuous-planning-grant-1"),
      budgetBaseline: {
        inputTokens: 4_000,
        outputTokens: 1_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      budgetPolicy: tokenPolicy,
      startedAt: new Date(FIXED_NOW.getTime() + 1_000).toISOString(),
      steering: {
        sequence: 1,
        instructionsSha256: digest("continuous-planning-steering-1"),
        instructionsSizeBytes: 48,
        artifactPath: `runs/${runId}/attempts/attempt-plan/planning/revisions/1/steering.txt`,
        recordedAt: new Date(FIXED_NOW.getTime() + 1_000).toISOString(),
      },
    });

    const revised = await program.compilePlanningRevision({
      run,
      attemptId: "attempt-plan",
      revision: 1,
      patch: {
        baseRevision: 0,
        baseArtifactSha256,
        full: { verification: "Verify one stable attempt and Pi session across steering." },
      },
    });

    expect(revised.plan.revision).toBe(1);
    expect(revised.plan.full.architecture).toBe(initial.plan.full.architecture);
    expect(revised.plan.full.verification).toContain("stable attempt");
    expect(revised.artifactWrites?.map((write) => write.path)).toEqual(
      expect.arrayContaining([
        `runs/${runId}/attempts/attempt-plan/planning/revisions/1/patch.json`,
        `runs/${runId}/attempts/attempt-plan/planning/revisions/1/artifact.json`,
        `runs/${runId}/attempts/attempt-plan/planning/revisions/1/graph.json`,
        `runs/${runId}/attempts/attempt-plan/planning/revisions/1/checkpoint.json`,
      ]),
    );

    const priorPlanSha256 = canonicalHash(run.plan);
    await expect(
      program.compilePlanningRevision({
        run,
        attemptId: "attempt-plan",
        revision: 1,
        patch: {
          baseRevision: 0,
          baseArtifactSha256,
          graphSeed: {
            upsertNodes: [
              {
                key: "disconnected-proof",
                type: "change",
                title: "Disconnected proof",
                spec: {},
              },
            ],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "graph_seed_disconnected" });
    expect(canonicalHash(run.plan)).toBe(priorPlanSha256);

    await persistWrites(project.projectRoot, revised.artifactWrites ?? []);
    const revisionCheckpoint = JSON.parse(
      Buffer.from(
        revised.artifactWrites!.find((write) => write.path.endsWith("/checkpoint.json"))!.bytes,
      ).toString("utf8"),
    ) as {
      artifactPath: string;
      artifactSha256: Sha256Digest;
      graphSha256: Sha256Digest;
      patchSha256: Sha256Digest;
    };
    run.planningSession.status = "approving";
    run.planningSession.revisions[1] = {
      ...run.planningSession.revisions[1]!,
      status: "awaiting_review",
      artifactSha256: revisionCheckpoint.artifactSha256,
      graphSha256: revisionCheckpoint.graphSha256,
      transcriptSha256: digest("continuous-planning-transcript-1"),
      checkpointPath: revisionCheckpoint.artifactPath,
      patchSha256: revisionCheckpoint.patchSha256,
      completedAt: new Date(FIXED_NOW.getTime() + 2_000).toISOString(),
    };
    run.plan = { ...revised.plan, status: "approving" };
    run.graphHash = revised.graphHash;
    run.graphRevision = revised.graphRevision ?? 0;
    run.workingSpecOwnerId = resolved.workingSpecOwnerId!;
    run.attempts["attempt-plan"].status = "waiting_plan_review";
    delete run.attempts["attempt-plan"].terminalAcceptedAt;
    materializeApprovedFixtureRun(run);

    const approved = await program.initializeApprovedPlan(run);
    const approvedGraph = JSON.parse(
      Buffer.from(
        approved.artifactWrites!.find((write) => write.path.endsWith("/program/graph.json"))!.bytes,
      ).toString("utf8"),
    ) as {
      contextual: {
        canonicalWorkingSpecId: string;
        records: Record<
          string,
          {
            baseline: {
              source: {
                kind: string;
                artifactPath: string;
                artifactSha256: Sha256Digest;
                planRevision: number;
                attemptId?: string;
              };
            };
          }
        >;
      };
    };
    expect(
      approvedGraph.contextual.records[approvedGraph.contextual.canonicalWorkingSpecId]!.baseline
        .source,
    ).toEqual({
      kind: "approved_plan",
      artifactPath: revisionCheckpoint.artifactPath,
      artifactSha256: revisionCheckpoint.artifactSha256,
      planRevision: 1,
      attemptId: "attempt-plan",
    });
  });

  it("prepares a later planning revision under the stable attempt and Pi session", async () => {
    const project = await installedProject("coding-profile");
    const program = await compilerProgram(project);
    const runId = "run-continuous-planning-launch";
    const objective = "Continue one authenticated planning session across steering";
    const resolved = await program.resolveRun({
      runId,
      objective,
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: objective },
    });
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
    const run = runRecord(project.projectRoot, runId, objective, resolved);
    const artifact = planningOutput({ work_kind: "general" }) as Record<string, unknown>;
    const artifactSha256 = canonicalHash(artifact);
    const checkpointPath = `runs/${runId}/attempts/attempt-plan/planning/revisions/0/artifact.json`;
    const steeringPath = `runs/${runId}/attempts/attempt-plan/planning/revisions/1/steering.txt`;
    const steering = "Keep the architecture; strengthen only the verification plan.";
    await persistWrites(project.projectRoot, [
      {
        path: checkpointPath,
        bytes: Buffer.from(`${JSON.stringify(artifact)}\n`, "utf8"),
        expectedSha256: null,
      },
      {
        path: steeringPath,
        bytes: Buffer.from(steering, "utf8"),
        expectedSha256: null,
      },
    ]);
    run.plan = {
      revision: 0,
      status: "awaiting_approval",
      full: structuredClone(artifact.full as NonNullable<RunRecord["plan"]>["full"]),
      concise: structuredClone(artifact.concise as NonNullable<RunRecord["plan"]>["concise"]),
      graphSeed: structuredClone(artifact.graphSeed as NonNullable<RunRecord["plan"]>["graphSeed"]),
      steeringHistory: [
        {
          at: FIXED_NOW.toISOString(),
          instructions: steering,
        },
      ],
    };
    run.attempts["attempt-plan"] = {
      id: "attempt-plan",
      sessionId: "session-plan",
      ticketId: "run-planning",
      stepId: "focused-plan",
      personaId: "run-planner",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-5",
      thinkingLevel: "high",
      status: "running",
      launchSpecHash: digest("continuous-planning-launch-0"),
      sessionFile: `runs/${runId}/sessions/attempt-plan/session-plan.jsonl`,
      startedAt: FIXED_NOW.toISOString(),
      endedAt: undefined,
      terminalSummary: undefined,
      inputTokens: 4_000,
      outputTokens: 1_000,
      cacheReadTokens: 300,
      cacheWriteTokens: 200,
      kind: "planning",
    };
    run.planningSession = {
      protocol: "koni.planning-session.v1",
      attemptId: "attempt-plan",
      sessionId: "session-plan",
      status: "running",
      currentRevision: 1,
      revisions: [
        {
          protocol: "koni.planning-revision.v1",
          revision: 0,
          status: "superseded",
          launchSpecSha256: digest("continuous-planning-launch-0"),
          grantSha256: digest("continuous-planning-grant-0"),
          budgetBaseline: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          budgetPolicy: {
            metric: "new_tokens",
            limit: 120_000,
            synthesisReserve: 20_000,
            synthesisThreshold: 100_000,
            onExhausted: "force_synthesis",
          },
          startedAt: FIXED_NOW.toISOString(),
          artifactSha256,
          graphSha256: digest("continuous-planning-graph-0"),
          transcriptSha256: digest("continuous-planning-transcript-0"),
          checkpointPath,
          completedAt: FIXED_NOW.toISOString(),
        },
        {
          protocol: "koni.planning-revision.v1",
          revision: 1,
          status: "running",
          launchSpecSha256: digest("continuous-planning-launch-1"),
          grantSha256: digest("continuous-planning-grant-1"),
          budgetBaseline: {
            inputTokens: 4_000,
            outputTokens: 1_000,
            cacheReadTokens: 300,
            cacheWriteTokens: 200,
          },
          budgetPolicy: {
            metric: "new_tokens",
            limit: 120_000,
            synthesisReserve: 20_000,
            synthesisThreshold: 100_000,
            onExhausted: "force_synthesis",
          },
          startedAt: new Date(FIXED_NOW.getTime() + 1_000).toISOString(),
          steering: {
            sequence: 1,
            instructionsSha256: rawSha256(steering),
            instructionsSizeBytes: Buffer.byteLength(steering),
            artifactPath: steeringPath,
            recordedAt: new Date(FIXED_NOW.getTime() + 1_000).toISOString(),
          },
        },
      ],
    };

    const prepared = await program.preparePlanningRevision({
      run,
      attemptId: "attempt-plan",
      sessionId: "session-plan",
      nextAuthorityRevision: 7,
      expectedAuthorityStateHash: digest("continuous-planning-authority-1"),
    });

    expect(prepared.spec.identity).toMatchObject({
      attemptId: "attempt-plan",
      sessionId: "session-plan",
      ticketId: "run-planning",
    });
    expect(prepared.spec.lineage).toEqual({ branchEpoch: 0, reason: "initial" });
    expect(prepared.spec.planningRevision).toEqual({
      revision: 1,
      baseRevision: 0,
      priorCheckpointSha256: artifactSha256,
      steeringSha256: rawSha256(steering),
      budgetBaseline: run.planningSession.revisions[1]!.budgetBaseline,
    });
    expect(prepared.authorityGrant?.grantId).toBe("grant-attempt-plan-planning-revision-1");
    expect(prepared.spec.persona.initialPrompt).toContain(
      "Continue this planning session. Apply the operator steering to the current compiler-valid plan.",
    );
    expect(prepared.spec.persona.initialPrompt).toContain(
      "Submit the required planning payload through koni_submit_output in the same turn",
    );
    expect(prepared.spec.persona.initialPrompt).toContain(
      "Plain assistant text is not a planning submission",
    );
    expect(prepared.spec.persona.initialPrompt).toContain(
      "Preserve unchanged domains and graph elements. Submit only the bounded patch against the named base revision and artifact hash.",
    );
    expect(prepared.spec.persona.initialPrompt).toContain(
      "graphSeed may contain only setRootSpec, removeRootSpecFields, upsertNodes, removeNodeKeys, addEdges, and removeEdges",
    );
    expect(prepared.spec.persona.initialPrompt).toContain("Never add an unchanged edge again");
    expect(prepared.spec.persona.initialPrompt).toContain(
      "Every newly upserted node key must either already exist or connect through addEdges",
    );
    expect(prepared.spec.persona.initialPrompt).not.toContain("Submit the complete artifact");
    expect(prepared.spec.persona.initialPrompt).toContain(artifactSha256);
    expect(prepared.spec.persona.initialPrompt).toContain(steering);
    expect(prepared.spec.persona.initialPrompt).toContain(JSON.stringify(artifact));
    expect(prepared.artifactWrites?.map((write) => write.path)).toContain(
      `runs/${runId}/attempts/attempt-plan/planning/revisions/1/compiler-input.json`,
    );
    expect(
      Value.Check(prepared.terminalOutputSchema!, {
        baseRevision: 0,
        baseArtifactSha256: artifactSha256,
        full: { verification: "Verify the continued authenticated session." },
      }),
    ).toBe(true);
    expect(Value.Check(prepared.terminalOutputSchema!, artifact)).toBe(false);

    run.planningSession.revisions[1]!.launchSpecSha256 = prepared.spec.specHash;
    run.planningSession.revisions[1]!.grantSha256 = prepared.spec.authority.grantHash;
    await persistWrites(project.projectRoot, prepared.artifactWrites ?? []);
    expect({
      launchSpecHash: run.planningSession.revisions[1]!.launchSpecSha256,
      runId: run.id,
      attemptId: run.attempts["attempt-plan"].id,
      sessionId: run.attempts["attempt-plan"].sessionId,
      ticketId: run.attempts["attempt-plan"].ticketId,
      stepId: run.attempts["attempt-plan"].stepId,
      personaId: run.attempts["attempt-plan"].personaId,
      generation: run.generation,
    }).toEqual({
      launchSpecHash: prepared.spec.specHash,
      runId: prepared.spec.identity.runId,
      attemptId: prepared.spec.identity.attemptId,
      sessionId: prepared.spec.identity.sessionId,
      ticketId: prepared.spec.identity.ticketId,
      stepId: prepared.spec.identity.stepId,
      personaId: prepared.spec.persona.id,
      generation: prepared.spec.authority.generation,
    });
    const recovered = await program.recoverAttempt({
      run,
      attempt: run.attempts["attempt-plan"],
      spec: prepared.spec,
    });
    expect(recovered.spec.specHash).toBe(prepared.spec.specHash);
    expect(recovered.spec.identity).toMatchObject({
      attemptId: "attempt-plan",
      sessionId: "session-plan",
    });

    await expect(
      program.preparePlanningRevision({
        run,
        attemptId: "attempt-other",
        sessionId: "session-plan",
        nextAuthorityRevision: 7,
        expectedAuthorityStateHash: digest("continuous-planning-authority-1"),
      }),
    ).rejects.toMatchObject({ code: "planning_revision_identity" });

    run.planningSession.revisions[1]!.budgetBaseline.inputTokens = 4_001;
    await expect(
      program.preparePlanningRevision({
        run,
        attemptId: "attempt-plan",
        sessionId: "session-plan",
        nextAuthorityRevision: 7,
        expectedAuthorityStateHash: digest("continuous-planning-authority-1"),
      }),
    ).rejects.toMatchObject({ code: "planning_revision_budget" });
  });

  it("uses the approved run workspace for a plan revision after detached planning retires", async () => {
    const project = await installedProject("coding-profile");
    const program = await compilerProgram(project);
    const runId = "run-relocated-legacy-planning";
    const objective = "Resume a planning attempt after legacy Git relocation";
    const resolved = await program.resolveRun({
      runId,
      objective,
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: objective },
    });
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);

    const run = runRecord(project.projectRoot, runId, objective, resolved);
    run.git = fixtureRunGit(project.projectRoot, runId, "approved");
    const namespace = run.git.namespace;
    namespace.planningWorktree = path.join(namespace.root, "planning");
    namespace.runWorktree = path.join(namespace.root, "integration");
    namespace.ticketRoot = path.join(namespace.root, "tickets");
    run.git.planning.worktree = namespace.planningWorktree;
    run.git.run.worktree = namespace.runWorktree;

    await expect(
      program.prepareAttempt({
        kind: "planning",
        run,
        attemptId: "attempt-native-missing-planner",
        sessionId: "session-native-missing-planner",
        nextAuthorityRevision: 2,
        expectedAuthorityStateHash: digest("native-missing-planner"),
        lineage: { branchEpoch: 0, reason: "initial" },
      }),
    ).resolves.toMatchObject({
      spec: { workspace: { cwd: path.resolve(namespace.runWorktree) } },
    });

    const source = {
      targetRef: run.git.target.ref,
      targetBaseOid: run.git.target.selectedOid,
      runBranch: run.git.namespace.runRef.slice("refs/heads/".length),
      runWorktree: namespace.root,
      namespaceStatus: "ready" as const,
      materializedAt: FIXED_NOW.toISOString(),
    };
    const stagingWorktree = path.join(
      run.git.commonDirectory,
      "koni",
      "worktrees",
      "migrations",
      runId,
      "integration",
    );
    run.legacyGitMigration = {
      protocol: "koni.legacy-run-git-migration.v1",
      status: "relocated",
      sourceGitSha256: canonicalHash(source),
      source,
      migratedAt: FIXED_NOW.toISOString(),
      reason: undefined,
      relocation: {
        protocol: "koni.legacy-run-relocation.v1",
        runId,
        sourceGitSha256: canonicalHash(source),
        projectRoot: run.projectRoot,
        commonDirectory: run.git.commonDirectory,
        target: {
          ref: run.git.target.ref,
          selectedOid: run.git.target.selectedOid,
          observedOid: run.git.target.selectedOid,
        },
        source: {
          branchRef: run.git.namespace.runRef,
          worktree: namespace.root,
          expectedHeadOid: run.git.run.headOid!,
          registered: true,
          clean: true,
        },
        destination: {
          namespaceRoot: namespace.root,
          stagingWorktree,
          planningWorktree: namespace.planningWorktree,
          runWorktree: namespace.runWorktree,
          ticketRoot: namespace.ticketRoot,
        },
        expectedAbsentPaths: [
          namespace.planningWorktree,
          namespace.runWorktree,
          namespace.ticketRoot,
          stagingWorktree,
        ].sort(),
        ticketProjectionIds: [],
        priorPhase: "planning",
        plannedAt: FIXED_NOW.toISOString(),
      },
      relocationIntentId: "legacy-relocate-run-relocated-legacy-planning",
      relocatedAt: FIXED_NOW.toISOString(),
      retirementIntentId: undefined,
      retiredAt: undefined,
    };
    expect(() => assertRunRecord(run)).not.toThrow();

    await expect(
      program.prepareAttempt({
        kind: "planning",
        run,
        attemptId: "attempt-relocated-legacy-planner",
        sessionId: "session-relocated-legacy-planner",
        nextAuthorityRevision: 3,
        expectedAuthorityStateHash: digest("relocated-legacy-planner"),
        lineage: { branchEpoch: 0, reason: "initial" },
      }),
    ).resolves.toMatchObject({
      spec: { workspace: { cwd: path.resolve(namespace.runWorktree) } },
    });
  });

  it("compiles a coding plan into deterministic tickets and validates a scoped graph mutation", async () => {
    const project = await installedProject("coding-profile");
    const program = await compilerProgram(project);
    const runId = "run-native-coding";
    const resolved = await program.resolveRun({
      runId,
      objective: "Add note pinning",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Add note pinning" },
    });
    expect(resolved.lifecycleCatalog).toMatchObject({
      protocol: "koni.state-machine-catalog.v1",
      configuration_sha256: resolved.compiledConfigHash,
      machines: { ticket: expect.any(Object), run: expect.any(Object) },
    });
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
    const run = runRecord(project.projectRoot, runId, "Add note pinning", resolved);
    const planning = await program.compilePlanningOutput({
      run,
      attemptId: "attempt-plan",
      output: planningOutput({ work_kind: "general" }),
    });
    expect(Object.keys(planning.plan.full).sort()).toEqual([
      "architecture",
      "decisions",
      "risk",
      "verification",
    ]);
    expect(Object.keys(planning.plan.concise).sort()).toEqual([
      "architecture",
      "decisions",
      "risk",
      "verification",
    ]);
    for (const domain of ["architecture", "decisions", "risk", "verification"] as const) {
      expect(planning.plan.full[domain]).toMatch(/^## /u);
      expect(planning.plan.concise[domain]).toEqual([
        expect.objectContaining({ title: expect.any(String), description: expect.any(String) }),
      ]);
    }
    expect(planning.plan.concise.architecture?.[0]?.title).toBe("Notes ownership seam");
    const incompleteFull = fullPlans();
    delete incompleteFull.verification;
    await expect(
      program.compilePlanningOutput({
        run,
        attemptId: "attempt-incomplete-plan",
        output: {
          ...(planningOutput({ work_kind: "general" }) as Record<string, unknown>),
          full: incompleteFull,
        },
      }),
    ).rejects.toBeInstanceOf(NativeRunProgramError);
    await expect(
      program.compilePlanningOutput({
        run,
        attemptId: "attempt-malformed-plan",
        output: {
          full: fullPlans(),
          concise: { architecture: ["Truncated prose is not a structured mini-plan"] },
          graphSeed: { rootSpec: { work_kind: "general" }, nodes: [], edges: [] },
        },
      }),
    ).rejects.toBeInstanceOf(NativeRunProgramError);
    await expect(
      program.compilePlanningOutput({
        run,
        attemptId: "attempt-invented-root-alias",
        output: {
          ...(planningOutput({ work_kind: "general" }) as Record<string, unknown>),
          graphSeed: {
            rootSpec: { work_kind: "general" },
            nodes: [
              {
                key: "notes-change",
                type: "change",
                title: "Add note pinning",
                spec: {},
              },
            ],
            edges: [
              {
                source: "notes-pinning-plan",
                relation: "requires",
                target: "notes-change",
              },
            ],
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "graph_seed_edge_key",
      message: expect.stringContaining(
        "notes-pinning-plan; use $root for the existing run objective",
      ),
    });

    const developmentOnlyRun = structuredClone(run);
    developmentOnlyRun.objective = "Development-only research; never access sealed final holdouts.";
    await expect(
      program.compilePlanningOutput({
        run: developmentOnlyRun,
        attemptId: "attempt-prohibited-holdout-seed",
        output: planningOutput(
          { work_kind: "general" },
          [
            {
              key: "development-boundary",
              type: "change",
              title: "Final holdouts remain excluded",
              spec: {},
            },
          ],
          [{ source: "$root", relation: "requires", target: "development-boundary" }],
        ),
      }),
    ).rejects.toMatchObject({ code: "graph_seed_sealed_holdout" });

    run.plan = { ...planning.plan, status: "awaiting_approval" };
    run.graphHash = planning.graphHash;
    run.graphRevision = planning.graphRevision ?? 0;
    run.lifecycle = reduceRunLifecycle(run.lifecycle, {
      type: "plan_submitted",
      atMs: FIXED_NOW.getTime(),
    }).state;
    const reviewedProjection = await program.projectGraph(run);
    expect(reviewedProjection.nodes).toHaveLength(1);
    expect(reviewedProjection.nodes[0]).toMatchObject({
      type: "objective",
      spec: expect.objectContaining({ work_kind: "general" }),
    });
    run.lifecycle = reduceRunLifecycle(run.lifecycle, {
      type: "pause_requested",
      atMs: FIXED_NOW.getTime() + 1,
    }).state;
    expect((await program.projectGraph(run)).nodes).toEqual(reviewedProjection.nodes);
    run.lifecycle = reduceRunLifecycle(run.lifecycle, {
      type: "pause_settled",
      atMs: FIXED_NOW.getTime() + 2,
    }).state;
    expect((await program.projectGraph(run)).nodes).toEqual(reviewedProjection.nodes);
    run.lifecycle = reduceRunLifecycle(run.lifecycle, {
      type: "resume_requested",
      atMs: FIXED_NOW.getTime() + 3,
    }).state;
    run.lifecycle = reduceRunLifecycle(run.lifecycle, {
      type: "plan_revision_requested",
      atMs: FIXED_NOW.getTime() + 4,
    }).state;
    run.plan = { ...run.plan, status: "planning" };
    expect((await program.projectGraph(run)).nodes).toEqual(reviewedProjection.nodes);
    run.lifecycle = reduceRunLifecycle(run.lifecycle, {
      type: "plan_submitted",
      atMs: FIXED_NOW.getTime() + 5,
    }).state;
    run.plan = { ...run.plan, status: "awaiting_approval" };
    run.lifecycle = reduceRunLifecycle(run.lifecycle, {
      type: "plan_approval_requested",
      atMs: FIXED_NOW.getTime() + 6,
    }).state;
    run.plan = { ...run.plan, status: "approving" };
    expect((await program.projectGraph(run)).nodes).toEqual(reviewedProjection.nodes);
    run.plan = { ...run.plan, status: "approved" };
    materializeApprovedFixtureRun(run);
    const approved = await program.initializeApprovedPlan(run);
    expect(Object.values(approved.tickets)).toHaveLength(1);
    const architectureTicket = Object.values(approved.tickets)[0]!;
    expect(architectureTicket.operationId).toBe("architecture.objective.map");
    expect(architectureTicket.executionPolicyBinding).toMatchObject({
      protocol: "koni.execution-policy-binding.v1",
      configurationSha256: resolved.compiledConfigHash,
      operationId: "architecture.objective.map",
      workflowId: "architecture-map",
      workflowVersion: "2.0.0",
      context: {
        outputContract: { text: expect.stringContaining("Add at least one system") },
        reviewContract: {
          text: expect.stringContaining("smallest affected repository-native boundary"),
        },
      },
    });
    expect(
      architectureTicket.steps.every(
        (step) =>
          step.executionPolicyBinding?.stepId === step.id &&
          step.executionPolicyBinding.configurationSha256 === resolved.compiledConfigHash,
      ),
    ).toBe(true);
    expect(architectureTicket.readNodeIds).toBeDefined();
    expect(architectureTicket.writeNodeIds).toBeDefined();
    expect(architectureTicket.steps.every((step) => step.dependsOn !== undefined)).toBe(true);
    await persistWrites(project.projectRoot, approved.artifactWrites ?? []);
    run.graphHash = approved.graphHash;
    run.graphRevision = approved.graphRevision;
    run.tickets = approved.tickets;
    architectureTicket.reviewReworks ??= [];
    architectureTicket.reviewReworks.push({
      ordinal: 1,
      mode: "supervised",
      failedReviewAttemptId: "attempt-prior-review",
      reopenFromStepId: architectureTicket.reviewFailureReopenFrom!,
      blocker: "The prior review found a material parent-consumer route gap.",
      operatorSteering: "Keep the real parent boundary and stub only unrelated leaf components.",
      openedAt: FIXED_NOW.toISOString(),
    });

    const initialProjection = await program.projectGraph(run, architectureTicket.id);
    expect(initialProjection.nodes).toHaveLength(1);
    expect(initialProjection.nodes[0]?.type).toBe("objective");
    const assignment = assignmentFor(run, architectureTicket.id);
    const prepared = await program.prepareAttempt({
      kind: "ticket",
      run,
      assignment,
      attemptId: "attempt-architecture",
      sessionId: "session-architecture",
      nextAuthorityRevision: 9,
      expectedAuthorityStateHash: digest("authority-nine"),
      lineage: {
        branchEpoch: 1,
        reason: "rework",
        parentAttemptId: "attempt-plan",
        parentSessionId: "session-plan",
      },
    });
    expect(prepared.spec.lineage).toEqual({
      branchEpoch: 1,
      reason: "rework",
      parentAttemptId: "attempt-plan",
      parentSessionId: "session-plan",
    });
    expect(prepared.spec.persona.id).toBe("architecture-mapper");
    expect(prepared.spec.model).toMatchObject({ id: "gpt-5.6-luna", thinkingLevel: "medium" });
    expect(prepared.toolNames).toContain("koni_graph_context");
    expect(prepared.toolNames).toContain("koni_record_note");
    expect(prepared.toolNames).not.toContain("koni_write_file");
    expect(prepared.contextContent).toContain('"executionPolicy"');
    expect(prepared.contextContent).toContain('"operationId": "architecture.objective.map"');
    expect(prepared.contextContent).toContain('"ref": "refs/heads/main"');
    expect(prepared.contextContent).toContain('"mutationContract"');
    expect(prepared.contextContent).toContain('"allowedForNew": true');
    expect(prepared.spec.persona.initialPrompt).toContain("Operation output contract:");
    expect(prepared.spec.persona.initialPrompt).toContain(
      "Graph write-authority nodes for this exact step:",
    );
    expect(prepared.spec.persona.initialPrompt).toContain(
      "Every other graph node in context is read-only",
    );
    expect(prepared.spec.persona.initialPrompt).toContain(
      "The operator explicitly authorized reviewed-blocker recovery 1",
    );
    expect(prepared.spec.persona.initialPrompt).toContain(
      "Operator steering for this exact recovery: Keep the real parent boundary",
    );
    expect(prepared.spec.persona.initialPrompt).toContain(
      "Any koni_submit_output call or accepted terminal result in the inherited parent transcript",
    );

    const repairRun = structuredClone(run);
    const repairTargetNodeId = architectureTicket.targetNodeIds[0]!;
    const repairProposal = plannedAssetRepairProposalFixture({
      runId: repairRun.id,
      proposalId: "TK-change-cumulative-repair-context",
      sourceTicketId: architectureTicket.id,
      sourceStepId: "review",
      targetNodeIds: [repairTargetNodeId],
      summary: "Preserve the established repository boundary",
      reason:
        "A prior review proved that replacing the established boundary loses required behavior.",
      updatedAt: "2026-07-16T18:45:00.000Z",
    });
    repairRun.tickets[repairProposal.id] = repairProposal;
    const repairPrepared = await program.prepareAttempt({
      kind: "ticket",
      run: repairRun,
      assignment: assignmentFor(repairRun, architectureTicket.id),
      attemptId: "attempt-architecture-cumulative-repair",
      sessionId: "session-architecture-cumulative-repair",
      nextAuthorityRevision: 10,
      expectedAuthorityStateHash: digest("authority-cumulative-repair"),
      lineage: { branchEpoch: 0, reason: "initial" },
    });
    const repairContext = JSON.parse(repairPrepared.contextContent!) as {
      plannedAssetRepairHistory?: Array<{ summary: string; reason: string }>;
    };
    expect(repairContext.plannedAssetRepairHistory).toEqual([
      expect.objectContaining({
        summary: "Preserve the established repository boundary",
        reason:
          "A prior review proved that replacing the established boundary loses required behavior.",
      }),
    ]);
    expect(repairPrepared.spec.persona.initialPrompt).toContain(
      "compiler-authenticated planned asset repair history is cumulative",
    );
    expect(repairPrepared.spec.persona.initialPrompt).toContain(
      "A later repair request does not erase an earlier finding",
    );
    expect(repairPrepared.spec.persona.initialPrompt).toContain(
      "Preserve the established repository boundary",
    );
    expect(repairPrepared.spec.persona.initialPrompt).toContain(
      "replacing the established boundary loses required behavior",
    );

    const recoveryRun = structuredClone(run);
    const recoveryStep = recoveryRun.tickets[architectureTicket.id]!.steps.find(
      (step) => step.id === assignment.stepId,
    )!;
    const missingContractFailure =
      "Retired accepted output after a compensated validation (spec.runtime_contract.command is required); reissuing the step fresh";
    const relationshipFailure =
      "Retired accepted output after a compensated validation (new node relationships and annotations must use dedicated authority tools/edge mutations); reissuing the step fresh";
    const missingContractAttempt = attemptRecord(prepared.spec, "ticket", "interrupted");
    missingContractAttempt.id = "attempt-runtime-contract-missing";
    missingContractAttempt.error = missingContractFailure;
    missingContractAttempt.terminalSummary = missingContractFailure;
    const relationshipAttempt = attemptRecord(prepared.spec, "ticket", "interrupted");
    relationshipAttempt.id = "attempt-runtime-contract-relationships";
    relationshipAttempt.error = relationshipFailure;
    relationshipAttempt.terminalSummary = relationshipFailure;
    recoveryRun.attempts[missingContractAttempt.id] = missingContractAttempt;
    recoveryRun.attempts[relationshipAttempt.id] = relationshipAttempt;
    recoveryStep.attemptIds.push(missingContractAttempt.id, relationshipAttempt.id);

    const freshCompilerRecovery = await program.prepareAttempt({
      kind: "ticket",
      run: recoveryRun,
      assignment,
      attemptId: "attempt-architecture-fresh-compiler-recovery",
      sessionId: "session-architecture-fresh-compiler-recovery",
      nextAuthorityRevision: 10,
      expectedAuthorityStateHash: digest("authority-ten"),
      // A ticket-cycle refresh can deliberately make the next execution root fresh even though
      // this same step is still inside its bounded compensated-validation recovery chain.
      lineage: { branchEpoch: 0, reason: "initial" },
    });
    expect(freshCompilerRecovery.spec.persona.initialPrompt).toContain(
      "fresh same-scope compiler-recovery root",
    );
    expect(freshCompilerRecovery.spec.persona.initialPrompt).toContain(
      "spec.runtime_contract.command is required",
    );
    expect(freshCompilerRecovery.spec.persona.initialPrompt).toContain(
      "new node relationships and annotations must use dedicated authority tools/edge mutations",
    );
    expect(freshCompilerRecovery.spec.persona.initialPrompt).not.toContain(
      "The inherited Pi conversation is the repository and execution ledger",
    );

    const reviewWorktree = path.join(project.projectRoot, ".ticket-review-worktree");
    await mkdir(reviewWorktree, { recursive: true });
    architectureTicket.worktreePath = reviewWorktree;
    run.git.ticketCycles[architectureTicket.gitCycleId!]!.worktree = reviewWorktree;
    const reviewStep = architectureTicket.steps.find((step) => step.kind === "review")!;
    const reviewRun = structuredClone(run);
    const reviewTicket = reviewRun.tickets[architectureTicket.id]!;
    reviewTicket.reviewReworks!.at(-1)!.scope = "review_only";
    const predecessor = attemptRecord(prepared.spec, "ticket", "completed");
    predecessor.endedAt = FIXED_NOW.toISOString();
    predecessor.terminalSummary = "Expected-red proof command completed.";
    reviewRun.attempts[predecessor.id] = predecessor;
    const predecessorStep = reviewTicket.steps.find((step) => step.id === assignment.stepId)!;
    predecessorStep.status = "completed";
    predecessorStep.attemptIds = [predecessor.id];
    predecessorStep.startedAt = FIXED_NOW.toISOString();
    predecessorStep.completedAt = FIXED_NOW.toISOString();
    predecessorStep.summary = predecessor.terminalSummary;
    const interrupted = {
      ...structuredClone(predecessor),
      id: "attempt-architecture-interrupted-change-request",
      sessionId: "session-architecture-interrupted-change-request",
      status: "interrupted" as const,
      ticketExecutionEpoch: 0,
      terminalAcceptedAt: FIXED_NOW.toISOString(),
    };
    const interruptedOutput = Buffer.from(
      `${JSON.stringify({
        status: "completed",
        summary: "Requested superseding work before this attempt was interrupted.",
        upstreamChangeRequest: {
          targetNodeIds: ["development-boundary"],
          summary: "Supersede this stale attempt.",
          reason: "The interrupted output must not contribute review-effect provenance.",
        },
        graphDelta: null,
      })}\n`,
      "utf8",
    );
    interrupted.terminalOutputSha256 = rawSha256(interruptedOutput);
    interrupted.terminalOutputSizeBytes = interruptedOutput.byteLength;
    reviewRun.attempts[interrupted.id] = interrupted;
    const interruptedDirectory = path.join(
      (await discoverAuthorityEndpoint(project.projectRoot)).stateRoot,
      `runs/${reviewRun.id}/attempts/${interrupted.id}`,
    );
    await mkdir(interruptedDirectory, { recursive: true });
    await writeFile(path.join(interruptedDirectory, "terminal-output.json"), interruptedOutput);
    const graphOnlyReviewPrepared = await program.prepareAttempt({
      kind: "verification",
      run: reviewRun,
      assignment: {
        runId: run.id,
        ticketId: architectureTicket.id,
        stepId: reviewStep.id,
        personaId: reviewStep.personaId,
        priority: architectureTicket.priority,
      },
      attemptId: "attempt-architecture-review-graph-only",
      sessionId: "session-architecture-review-graph-only",
      nextAuthorityRevision: 10,
      expectedAuthorityStateHash: digest("authority-ten-graph-only"),
      lineage: {
        branchEpoch: 1,
        reason: "review",
        parentAttemptId: "attempt-architecture",
        parentSessionId: "session-architecture",
      },
    });
    expect(graphOnlyReviewPrepared.spec.persona.initialPrompt).toContain(
      "preceding step is graph-only",
    );
    expect(graphOnlyReviewPrepared.spec.persona.initialPrompt).not.toContain(
      "Inspect every command in the compiler-authenticated predecessorExecution evidence",
    );
    expect(graphOnlyReviewPrepared.spec.persona.initialPrompt).toContain(
      "independent rereview of the unchanged compiler-accepted predecessor",
    );
    expect(graphOnlyReviewPrepared.spec.persona.initialPrompt).toContain(
      "historical context, not a required conclusion",
    );
    expect(graphOnlyReviewPrepared.spec.persona.initialPrompt).not.toContain(
      "Materially address every finding",
    );
    const endpoint = await discoverAuthorityEndpoint(project.projectRoot);
    const stdout = Buffer.from(
      "FAIL questionnaire oracle: expected Sales Notes to be General\n",
      "utf8",
    );
    const stderr = Buffer.from("Error: Objects are not valid as a React child\n", "utf8");
    const checkRoot = `runs/${reviewRun.id}/attempts/${predecessor.id}/checks/review-fixture`;
    await mkdir(path.join(endpoint.stateRoot, checkRoot), { recursive: true });
    await writeFile(path.join(endpoint.stateRoot, checkRoot, "stdout.bin"), stdout);
    await writeFile(path.join(endpoint.stateRoot, checkRoot, "stderr.bin"), stderr);
    reviewRun.checks = [
      {
        id: "check-review-fixture",
        attemptId: predecessor.id,
        callId: "call-review-fixture",
        requestedCheckId: "expected-red",
        definitionHash: digest("expected-red-definition"),
        kind: "command",
        accepted: true,
        passed: true,
        summary: "Configured nonzero exit accepted",
        commands: [
          {
            checkId: "expected-red",
            definitionHash: digest("expected-red-definition"),
            startedAt: FIXED_NOW.toISOString(),
            completedAt: FIXED_NOW.toISOString(),
            resolvedExecutable: "/usr/bin/test",
            argv: ["/usr/bin/test", "focused-oracle"],
            environmentSha256: digest("review-environment"),
            exitCode: 1,
            signal: null,
            stdoutSha256: rawSha256(stdout),
            stdoutSizeBytes: stdout.byteLength,
            stdoutArtifactPath: `${checkRoot}/stdout.bin`,
            stderrSha256: rawSha256(stderr),
            stderrSizeBytes: stderr.byteLength,
            stderrArtifactPath: `${checkRoot}/stderr.bin`,
            preManifestSha256: digest("review-manifest"),
            postManifestSha256: digest("review-manifest"),
            sandboxKind: "fixture",
            sandboxProfileSha256: digest("review-sandbox"),
            resultSource: {
              kind: "stdout",
              bytesSha256: rawSha256(stdout),
              sizeBytes: stdout.byteLength,
            },
            outputFiles: [],
          },
        ],
        evidenceSha256: digest("review-evidence"),
        evidenceSizeBytes: 1,
        evidenceArtifactPath: `${checkRoot}/evidence.json`,
        recordedAt: FIXED_NOW.toISOString(),
      },
    ];
    const reviewPrepared = await program.prepareAttempt({
      kind: "verification",
      run: reviewRun,
      assignment: {
        runId: run.id,
        ticketId: architectureTicket.id,
        stepId: reviewStep.id,
        personaId: reviewStep.personaId,
        priority: architectureTicket.priority,
      },
      attemptId: "attempt-architecture-review",
      sessionId: "session-architecture-review",
      nextAuthorityRevision: 10,
      expectedAuthorityStateHash: digest("authority-ten"),
      lineage: {
        branchEpoch: 1,
        reason: "review",
        parentAttemptId: "attempt-architecture",
        parentSessionId: "session-architecture",
      },
    });
    expect(reviewPrepared.spec.identity).toMatchObject({
      ticketId: architectureTicket.id,
      stepId: reviewStep.id,
    });
    expect(reviewPrepared.spec.persona.id).toBe("reviewer");
    expect(reviewPrepared.spec.workspace.cwd).toBe(architectureTicket.worktreePath);
    expect(reviewPrepared.spec.workspace.cwd).not.toBe(run.git.run.worktree);
    expect(reviewPrepared.spec.tools.map((tool) => tool.name)).not.toContain("koni_write_file");
    expect(reviewPrepared.spec.persona.initialPrompt).toContain("Independent review contract:");
    expect(reviewPrepared.spec.persona.initialPrompt).toContain(
      "compiler-authenticated predecessorExecution",
    );
    expect(reviewPrepared.contextContent).toContain('"predecessorExecution"');
    expect(reviewPrepared.contextContent).toContain("expected Sales Notes to be General");
    expect(reviewPrepared.contextContent).toContain("Objects are not valid as a React child");

    const pinnedCockpit = await program.projectCockpitCatalog(run);
    const pinnedLifecycle = await program.projectStateMachineCatalog(run);
    const pinnedExecution = await program.projectExecutionSemanticCatalog(run);
    expect(pinnedCockpit.configurationSha256).toBe(resolved.compiledConfigHash);
    expect(pinnedLifecycle.catalog_sha256).toBe(resolved.lifecycleCatalog?.catalog_sha256);
    expect(pinnedExecution.operations[architectureTicket.operationId]?.sha256).toBe(
      architectureTicket.executionPolicyBinding?.operationSha256,
    );

    await persistWrites(project.projectRoot, prepared.artifactWrites ?? []);
    const architectureAttempt = attemptRecord(prepared.spec, "ticket", "running");
    run.attempts[architectureAttempt.id] = architectureAttempt;
    const graphContext = await program.executeAgentTool({
      run,
      attempt: architectureAttempt,
      grant: prepared.authorityGrant!,
      call: {
        callId: "call-graph-context",
        name: "koni_graph_context",
        arguments: { anchors: [initialProjection.nodes[0]!.id], maxDepth: 1, direction: "both" },
      },
    });
    expect(graphContext.value).toMatchObject({
      protocol: "koni.graph-context.v1",
      graphSha256: run.graphHash,
      nodes: [expect.objectContaining({ id: initialProjection.nodes[0]!.id })],
    });
    const note = await program.executeAgentTool({
      run,
      attempt: architectureAttempt,
      grant: prepared.authorityGrant!,
      call: {
        callId: "call-record-note",
        name: "koni_record_note",
        arguments: {
          nodeId: initialProjection.nodes[0]!.id,
          kind: "rationale",
          body: "Keep the note boundary local to the application system.",
        },
      },
    });
    expect(note.value).toMatchObject({
      nodeId: initialProjection.nodes[0]!.id,
      kind: "rationale",
      status: "working",
    });
    expect(note.activity).toEqual([
      expect.objectContaining({
        kind: "agent",
        nodeId: initialProjection.nodes[0]!.id,
        ticketId: architectureTicket.id,
      }),
    ]);
    expect(note.artifactWrites).toHaveLength(1);

    const root = initialProjection.nodes[0]!;
    const forbiddenCodingHandoff = {
      status: "completed",
      summary: "Attempted to escape the coding ticket through Research change control",
      upstreamChangeRequest: {
        targetNodeIds: [root.id],
        summary: "Broaden architecture",
        reason: "This operation must not own the Research handoff protocol",
      },
    };
    expect(Value.Check(prepared.terminalOutputSchema!, forbiddenCodingHandoff)).toBe(false);
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment,
        attemptId: "attempt-architecture",
        output: forbiddenCodingHandoff,
      }),
    ).rejects.toMatchObject({ code: "change_control_route_forbidden" });
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment,
        attemptId: "attempt-architecture",
        output: {
          status: "completed",
          summary: "Tried to rename the existing objective while mapping architecture",
          graphDelta: {
            protocol: "koni.graph-delta.v1",
            expectedGraphHash: run.graphHash,
            upsertNodes: [
              {
                expectedNodeHash: canonicalHash(root),
                node: { ...root, title: "Renamed objective" },
              },
            ],
            deleteNodes: [],
            addEdges: [],
            removeEdges: [],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "execution_policy.edge_only_non_edge_change" });
    const obsolete = structuredClone(architectureTicket);
    obsolete.id = "TK-never-started-obsolete";
    obsolete.title = "Obsolete queued follow-up";
    obsolete.status = "queued";
    obsolete.worktreePath = undefined;
    obsolete.branch = undefined;
    delete obsolete.gitCycleId;
    for (const step of obsolete.steps) {
      step.status = "pending";
      step.attemptIds = [];
      step.startedAt = undefined;
      step.completedAt = undefined;
      step.summary = undefined;
    }
    run.tickets[obsolete.id] = obsolete;
    const embeddedRelationshipCompiled = await program.compileAssignmentOutput({
      run,
      assignment,
      attemptId: "attempt-architecture",
      output: {
        status: "completed",
        summary: "Mapped the notes application boundary through the node relationship view",
        graphDelta: {
          protocol: "koni.graph-delta.v1",
          expectedGraphHash: run.graphHash,
          upsertNodes: [
            {
              expectedNodeHash: canonicalHash(root),
              node: {
                ...root,
                edges: {
                  ...root.edges,
                  systems: ["system-notes-app"],
                },
              },
            },
            {
              expectedNodeHash: null,
              node: {
                schema_version: "1.0",
                id: "system-notes-app",
                type: "system",
                title: "Notes application",
                status: "active",
                spec: {
                  kind: "app",
                  responsibility: "Own note creation and pinning",
                  contract_required: false,
                  contract_reason: "Repository-local behavior is sufficient",
                  owned_paths: ["src"],
                },
                edges: {},
                annotations: {},
              },
            },
          ],
          deleteNodes: [],
          addEdges: [],
          removeEdges: [],
        },
      },
    });
    expect(embeddedRelationshipCompiled.outcome).toEqual({
      status: "completed",
      summary: "Mapped the notes application boundary through the node relationship view",
    });
    expect(embeddedRelationshipCompiled.graphRevision).toBe(2);
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment,
        attemptId: "attempt-architecture",
        output: {
          status: "completed",
          summary: "Tried to smuggle an annotation through the node snapshot",
          graphDelta: {
            protocol: "koni.graph-delta.v1",
            expectedGraphHash: run.graphHash,
            upsertNodes: [
              {
                expectedNodeHash: canonicalHash(root),
                node: {
                  ...root,
                  annotations: { unauthorized: "annotation" },
                },
              },
            ],
            deleteNodes: [],
            addEdges: [],
            removeEdges: [],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "graph_delta_embedded_state" });
    const compiled = await program.compileAssignmentOutput({
      run,
      assignment,
      attemptId: "attempt-architecture",
      output: {
        status: "completed",
        summary: "Mapped the notes application boundary",
        graphDelta: {
          protocol: "koni.graph-delta.v1",
          expectedGraphHash: run.graphHash,
          upsertNodes: [
            {
              expectedNodeHash: null,
              node: {
                schema_version: "1.0",
                id: "system-notes-app",
                type: "system",
                title: "Notes application",
                status: "active",
                spec: {
                  kind: "app",
                  responsibility: "Own note creation and pinning",
                  contract_required: false,
                  contract_reason: "Repository-local behavior is sufficient",
                  owned_paths: ["src"],
                },
                edges: {},
                annotations: {},
              },
            },
          ],
          deleteNodes: [],
          addEdges: [{ source: root.id, relation: "systems", target: "system-notes-app" }],
          removeEdges: [],
        },
      },
    });
    expect(compiled.outcome).toEqual({
      status: "completed",
      summary: "Mapped the notes application boundary",
    });
    expect(compiled.graphRevision).toBe(2);
    expect(compiled.activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "graph_added", nodeId: "system-notes-app" }),
      ]),
    );
    expect(
      Object.values(compiled.tickets ?? {}).some(
        (ticket) => ticket.operationId === "design.objective.plan-change",
      ),
    ).toBe(true);
    expect(compiled.tickets?.[obsolete.id]).toMatchObject({
      status: "cancelled",
      blocker: "Superseded before execution by newer compiler state",
      steps: expect.arrayContaining([
        expect.objectContaining({ status: "skipped", attemptIds: [] }),
      ]),
    });
    await persistWrites(project.projectRoot, compiled.artifactWrites ?? []);
    run.graphHash = compiled.graphHash;
    run.graphRevision = compiled.graphRevision!;
    run.tickets = compiled.tickets!;
    run.activity.push(...(compiled.activity ?? []));
    const projected = await program.projectGraph(run, architectureTicket.id);
    expect(projected.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([root.id, "system-notes-app"]),
    );
    expect(projected.edges).toContainEqual({
      source: root.id,
      relation: "systems",
      target: "system-notes-app",
    });

    const continuationRun = structuredClone(run);
    const continuationTicket = continuationRun.tickets[architectureTicket.id]!;
    continuationTicket.reviewReworks = [];
    const authoredStep = continuationTicket.steps.find((step) => step.id === assignment.stepId)!;
    authoredStep.status = "completed";
    authoredStep.startedAt = FIXED_NOW.toISOString();
    authoredStep.completedAt = FIXED_NOW.toISOString();
    authoredStep.summary = "Mapped the notes application boundary";
    authoredStep.attemptIds = [architectureAttempt.id];
    const continuationPredecessor = continuationRun.attempts[architectureAttempt.id]!;
    continuationPredecessor.status = "completed";
    continuationPredecessor.endedAt = FIXED_NOW.toISOString();
    continuationPredecessor.terminalSummary = authoredStep.summary;
    const continuationStep = continuationTicket.steps[1]!;
    const continuationAssignment: ReadyAssignment = {
      runId: continuationRun.id,
      ticketId: continuationTicket.id,
      stepId: continuationStep.id,
      personaId: continuationStep.personaId,
      priority: continuationTicket.priority,
    };
    const continuationPrepared = await program.prepareAttempt({
      kind: "ticket",
      run: continuationRun,
      assignment: continuationAssignment,
      attemptId: "attempt-architecture-continuation",
      sessionId: "session-architecture-continuation",
      nextAuthorityRevision: 11,
      expectedAuthorityStateHash: digest("authority-created-node-continuation"),
      lineage: {
        branchEpoch: 2,
        reason: "retry",
        parentAttemptId: architectureAttempt.id,
        parentSessionId: architectureAttempt.sessionId,
      },
    });
    expect(continuationPrepared.contextContent).toContain('"id": "system-notes-app"');
    if (run.graphHash === undefined) throw new Error("fixture run has no graph hash");
    expect(
      graphDeltaReviewCandidateNodeIds({
        protocol: "koni.graph-delta.v1",
        expectedGraphHash: run.graphHash,
        upsertNodes: [],
        deleteNodes: [],
        addEdges: [{ source: root.id, relation: "systems", target: "system-notes-app" }],
        removeEdges: [],
      }),
    ).toEqual([root.id, "system-notes-app"].sort());
    expect(continuationPrepared.spec.persona.initialPrompt).toContain(
      "Graph write-authority nodes for this exact step: none.",
    );
    expect(continuationPrepared.spec.persona.initialPrompt).not.toContain(
      "Graph write-authority nodes for this exact step: root-d7d843ce58bec8100965, system-notes-app",
    );

    const reworkTicket = run.tickets[architectureTicket.id]!;
    reworkTicket.reviewReworks = structuredClone(architectureTicket.reviewReworks);
    const reworkPrepared = await program.prepareAttempt({
      kind: "ticket",
      run,
      assignment,
      attemptId: "attempt-architecture-created-node-rework",
      sessionId: "session-architecture-created-node-rework",
      nextAuthorityRevision: 11,
      expectedAuthorityStateHash: digest("authority-created-node-rework"),
      lineage: {
        branchEpoch: 2,
        reason: "rework",
        parentAttemptId: architectureAttempt.id,
        parentSessionId: architectureAttempt.sessionId,
      },
    });
    expect(reworkPrepared.contextContent).toContain('"id": "system-notes-app"');
    expect(reworkPrepared.contextContent).toContain(
      `"nodeHash": "${canonicalHash(projected.nodes.find((node) => node.id === "system-notes-app")!)}"`,
    );
    await persistWrites(project.projectRoot, reworkPrepared.artifactWrites ?? []);
    const reworkAttempt = attemptRecord(reworkPrepared.spec, "ticket", "running");
    run.attempts[reworkAttempt.id] = reworkAttempt;
    const reworkDynamic = await program.selectDynamicGraphContext({
      run,
      attempt: reworkAttempt,
      spec: reworkPrepared.spec,
    });
    expect(reworkDynamic.envelope.selection.selected).toContainEqual({
      id: "semantic_node:system-notes-app",
      reason: "exact_active_step_target",
    });
    const createdSystem = projected.nodes.find((node) => node.id === "system-notes-app")!;
    const currentRoot = projected.nodes.find((node) => node.id === root.id)!;
    const reworkCompiled = await program.compileAssignmentOutput({
      run,
      assignment,
      attemptId: reworkAttempt.id,
      output: {
        status: "completed",
        summary: "Retained the ticket-created system after reviewed correction",
        graphDelta: {
          protocol: "koni.graph-delta.v1",
          expectedGraphHash: run.graphHash,
          upsertNodes: [
            {
              expectedNodeHash: canonicalHash(currentRoot),
              node: { ...currentRoot, edges: {} },
            },
            {
              expectedNodeHash: null,
              node: createdSystem,
            },
          ],
          deleteNodes: [],
          addEdges: [{ source: root.id, relation: "systems", target: createdSystem.id }],
          removeEdges: [],
        },
      },
    });
    expect(reworkCompiled.outcome).toEqual({
      status: "completed",
      summary: "Retained the ticket-created system after reviewed correction",
    });
    delete run.attempts[reworkAttempt.id];

    // Current compilers retain the originating definition after its rule stops applying. Runs
    // admitted before that retention existed must still be able to recover the definition from
    // the exact compiler input of an already-issued attempt, without re-evaluating future YAML.
    const endpointAfterGraphChange = await discoverAuthorityEndpoint(project.projectRoot);
    const definitionPath = path.join(
      endpointAfterGraphChange.stateRoot,
      `runs/${run.id}/program/ticket-definitions.json`,
    );
    const definitionArtifact = JSON.parse(await readFile(definitionPath, "utf8")) as {
      retainedDefinitions?: Array<{ id: string }>;
    };
    expect(definitionArtifact.retainedDefinitions?.map((definition) => definition.id)).toContain(
      architectureTicket.id,
    );
    delete definitionArtifact.retainedDefinitions;
    await writeFile(definitionPath, `${JSON.stringify(definitionArtifact)}\n`);
    const issuedAttemptDirectory = path.join(
      endpointAfterGraphChange.stateRoot,
      `runs/${run.id}/attempts/${architectureAttempt.id}`,
    );
    await writeFile(
      path.join(issuedAttemptDirectory, "launch-spec.json"),
      `${JSON.stringify(prepared.spec)}\n`,
    );
    const recoveredDefinitionAttempt = await program.prepareAttempt({
      kind: "ticket",
      run,
      assignment,
      attemptId: "attempt-architecture-compat-retry",
      sessionId: "session-architecture-compat-retry",
      nextAuthorityRevision: 11,
      expectedAuthorityStateHash: digest("authority-eleven"),
      lineage: {
        branchEpoch: 2,
        reason: "retry",
        parentAttemptId: architectureAttempt.id,
        parentSessionId: architectureAttempt.sessionId,
      },
    });
    expect(recoveredDefinitionAttempt.spec.identity).toMatchObject({
      ticketId: architectureTicket.id,
      stepId: assignment.stepId,
    });
  });

  it("advances an exact reviewed proof preparation without reissuing the preparation ticket", async () => {
    const project = await installedProject("coding-profile");
    await mkdir(path.join(project.projectRoot, "src"), { recursive: true });
    await mkdir(path.join(project.projectRoot, "tests"), { recursive: true });
    await mkdir(path.join(project.projectRoot, "test-support"), { recursive: true });
    await writeFile(
      path.join(project.projectRoot, "src/feature.ts"),
      "export const label = 'legacy';\n",
    );
    await writeFile(
      path.join(project.projectRoot, "tests/feature.test.mjs"),
      "process.exitCode = 1;\n",
    );
    await writeFile(
      path.join(project.projectRoot, "test-support/vitest.config.ts"),
      "export default { test: { environment: 'node' } };\n",
    );
    git(project.projectRoot, ["add", "src", "tests", "test-support"]);
    git(project.projectRoot, ["commit", "-m", "fixture proof seam"]);

    const program = await compilerProgram(project);
    const runId = "run-proof-preparation-current";
    const objective = "Add one backward-compatible field";
    const resolved = await program.resolveRun({
      runId,
      objective,
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: objective },
    });
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
    const run = runRecord(project.projectRoot, runId, objective, resolved);
    const planning = await program.compilePlanningOutput({
      run,
      attemptId: "attempt-proof-plan",
      output: proofPreparationPlanningOutput(),
    });
    run.plan = { ...planning.plan, status: "approved" };
    run.graphHash = planning.graphHash;
    run.graphRevision = planning.graphRevision ?? 0;
    materializeApprovedFixtureRun(run);
    const initialized = await program.initializeApprovedPlan(run);
    await persistWrites(project.projectRoot, initialized.artifactWrites ?? []);
    run.graphHash = initialized.graphHash;
    run.graphRevision = initialized.graphRevision;
    run.tickets = initialized.tickets;
    const preparation = Object.values(run.tickets).find(
      (ticket) => ticket.operationId === "assurance.proof.prepare",
    );
    expect(preparation).toBeDefined();
    if (preparation === undefined) throw new Error("fixture did not derive proof preparation");

    const authorAssignment = assignmentFor(run, preparation.id);
    const authorPrepared = await program.prepareAttempt({
      kind: "ticket",
      run,
      assignment: authorAssignment,
      attemptId: "attempt-proof-author",
      sessionId: "session-proof-author",
      nextAuthorityRevision: 5,
      expectedAuthorityStateHash: digest("proof-authority-five"),
      lineage: { branchEpoch: 0, reason: "initial" },
    });
    expect(authorPrepared.authorityGrant?.readPaths).toEqual(
      expect.arrayContaining([
        "src/feature.ts",
        "tests/feature.test.mjs",
        "test-support/vitest.config.ts",
      ]),
    );
    expect(authorPrepared.authorityGrant?.writePaths).toEqual(["tests/feature.test.mjs"]);
    await persistWrites(project.projectRoot, authorPrepared.artifactWrites ?? []);
    const author = attemptRecord(authorPrepared.spec, "ticket", "running");
    run.attempts[author.id] = author;
    const baseline = await program.resolveAgentCheck({
      run,
      attempt: author,
      checkId: "baseline-proof-set",
    });
    expect(baseline.commands).toEqual([
      expect.objectContaining({
        inputPaths: expect.arrayContaining([
          "src/feature.ts",
          "tests/feature.test.mjs",
          "test-support/vitest.config.ts",
        ]),
        memberSourcePaths: ["test-support/vitest.config.ts", "tests/feature.test.mjs"],
      }),
    ]);
    author.status = "completed";
    author.endedAt = FIXED_NOW.toISOString();
    author.terminalSummary = "Recorded the honest historical baseline.";
    author.terminalPolicy = semanticTerminalPolicy("proof-author");
    const authorOutput = Buffer.from(
      `${JSON.stringify({
        status: "completed",
        summary: author.terminalSummary,
      })}\n`,
      "utf8",
    );
    author.terminalOutputSha256 = rawSha256(authorOutput);
    author.terminalOutputSizeBytes = authorOutput.byteLength;
    author.terminalAcceptedAt = FIXED_NOW.toISOString();
    const authorStep = preparation.steps.find((step) => step.id === authorAssignment.stepId)!;
    authorStep.status = "completed";
    authorStep.attemptIds = [author.id];
    authorStep.startedAt = FIXED_NOW.toISOString();
    authorStep.completedAt = FIXED_NOW.toISOString();
    authorStep.summary = author.terminalSummary;
    const endpoint = await discoverAuthorityEndpoint(project.projectRoot);
    const authorDirectory = path.join(endpoint.stateRoot, `runs/${run.id}/attempts/${author.id}`);
    await mkdir(authorDirectory, { recursive: true });
    await writeFile(path.join(authorDirectory, "terminal-output.json"), authorOutput);

    const manifest = await snapshotContainedPaths(preparation.worktreePath!, [
      "test-support/vitest.config.ts",
      "tests/feature.test.mjs",
    ]);
    const manifestMaterial = {
      protocol: "koni.run-check-source-manifest.v1" as const,
      configurationSha256: run.compiledConfigHash,
      catalogSha256: preparation.executionPolicyBinding!.catalogSha256,
      bindingSha256: authorStep.executionPolicyBinding!.sha256,
      checkSha256: digest("proof-expected-red-check"),
      commandBindingSha256: digest("proof-expected-red-command"),
      stepId: authorStep.id,
      roots: [...manifest.roots],
      entries: manifest.entries.map((entry) => ({ ...entry })),
      manifestSha256: manifest.manifestSha256,
      capturedAt: FIXED_NOW.toISOString(),
    };
    const sourceManifest = { ...manifestMaterial, sha256: canonicalHash(manifestMaterial) };
    const stdout = Buffer.from("expected legacy assertion failure\n", "utf8");
    const stderr = Buffer.alloc(0);
    const checkDirectory = `runs/${run.id}/attempts/${author.id}/checks/baseline`;
    await mkdir(path.join(endpoint.stateRoot, checkDirectory), { recursive: true });
    await writeFile(path.join(endpoint.stateRoot, checkDirectory, "stdout.bin"), stdout);
    await writeFile(path.join(endpoint.stateRoot, checkDirectory, "stderr.bin"), stderr);
    run.checks = [
      {
        id: "check-proof-baseline",
        attemptId: author.id,
        callId: "call-proof-baseline",
        requestedCheckId: "baseline-proof-set",
        definitionHash: digest("baseline-proof-set-definition"),
        kind: "composite",
        accepted: true,
        passed: true,
        summary: "baseline-proof-set passed",
        commands: [
          {
            checkId: "proof-expected-red",
            definitionHash: digest("proof-expected-red-check"),
            sourceManifest,
            startedAt: FIXED_NOW.toISOString(),
            completedAt: FIXED_NOW.toISOString(),
            resolvedExecutable: "/usr/bin/node",
            argv: ["/usr/bin/node", "tests/feature.test.mjs"],
            environmentSha256: digest("proof-environment"),
            exitCode: 1,
            signal: null,
            stdoutSha256: rawSha256(stdout),
            stdoutSizeBytes: stdout.byteLength,
            stdoutArtifactPath: `${checkDirectory}/stdout.bin`,
            stderrSha256: rawSha256(stderr),
            stderrSizeBytes: stderr.byteLength,
            stderrArtifactPath: `${checkDirectory}/stderr.bin`,
            preManifestSha256: digest("proof-workspace-manifest"),
            postManifestSha256: digest("proof-workspace-manifest"),
            sandboxKind: "fixture",
            sandboxProfileSha256: digest("proof-sandbox"),
            resultSource: {
              kind: "stdout",
              bytesSha256: rawSha256(stdout),
              sizeBytes: stdout.byteLength,
            },
            outputFiles: [],
          },
        ],
        evidenceSha256: digest("proof-baseline-evidence"),
        evidenceSizeBytes: 1,
        evidenceArtifactPath: `${checkDirectory}/evidence.json`,
        recordedAt: FIXED_NOW.toISOString(),
      },
    ];

    const reviewStep = preparation.steps.find((step) => step.kind === "review")!;
    const reviewAssignment: ReadyAssignment = {
      runId: run.id,
      ticketId: preparation.id,
      stepId: reviewStep.id,
      personaId: reviewStep.personaId,
      priority: preparation.priority,
    };
    const reviewPrepared = await program.prepareAttempt({
      kind: "verification",
      run,
      assignment: reviewAssignment,
      attemptId: "attempt-proof-review",
      sessionId: "session-proof-review",
      nextAuthorityRevision: 6,
      expectedAuthorityStateHash: digest("proof-authority-six"),
      lineage: {
        branchEpoch: 1,
        reason: "review",
        parentAttemptId: author.id,
        parentSessionId: author.sessionId,
      },
    });
    await persistWrites(project.projectRoot, reviewPrepared.artifactWrites ?? []);
    const review = attemptRecord(reviewPrepared.spec, "verification", "terminal_accepted");
    review.reviewedGraphHash = run.graphHash;
    review.terminalAcceptedAt = FIXED_NOW.toISOString();
    const reviewOutput = Buffer.from(
      `${JSON.stringify({
        status: "completed",
        reviewVerdict: "approved",
        summary: "The historical proof is independently reviewed and complete.",
      })}\n`,
      "utf8",
    );
    review.terminalOutputSha256 = rawSha256(reviewOutput);
    review.terminalOutputSizeBytes = reviewOutput.byteLength;
    run.attempts[review.id] = review;
    reviewStep.status = "running";
    reviewStep.attemptIds = [review.id];
    reviewStep.startedAt = FIXED_NOW.toISOString();
    const reviewDirectory = path.join(endpoint.stateRoot, `runs/${run.id}/attempts/${review.id}`);
    await mkdir(reviewDirectory, { recursive: true });
    await writeFile(
      path.join(reviewDirectory, "launch-spec.json"),
      `${JSON.stringify(reviewPrepared.spec)}\n`,
    );
    await writeFile(path.join(reviewDirectory, "terminal-output.json"), reviewOutput);

    const compiled = await program.compileAssignmentOutput({
      run,
      assignment: reviewAssignment,
      attemptId: review.id,
      output: JSON.parse(reviewOutput.toString("utf8")),
    });
    expect(
      Object.values(compiled.tickets ?? {}).some(
        (ticket) => ticket.operationId === "implementation.change.red-green",
      ),
    ).toBe(true);
    await persistWrites(project.projectRoot, compiled.artifactWrites ?? []);
    run.graphHash = compiled.graphHash;
    run.graphRevision = compiled.graphRevision!;
    run.tickets = compiled.tickets!;
    const durablePreparation = run.tickets[preparation.id]!;
    durablePreparation.status = "completed";
    durablePreparation.blocker = undefined;
    for (const step of durablePreparation.steps) {
      step.status = "completed";
      step.completedAt ??= FIXED_NOW.toISOString();
    }
    review.status = "completed";
    review.endedAt = FIXED_NOW.toISOString();
    review.terminalPolicy = semanticTerminalPolicy("proof-review");
    await cp(
      path.join(preparation.worktreePath!, "tests/feature.test.mjs"),
      path.join(run.git.run.worktree, "tests/feature.test.mjs"),
    );
    const current = await program.verifyRun(run);
    expect(current).toMatchObject({
      ok: false,
      reason: expect.stringContaining("implement-change"),
    });
    expect(current.reason).not.toContain("Prepare the historical proof oracle");
    expect(
      Object.values(current.tickets ?? {}).some(
        (ticket) => ticket.operationId === "implementation.change.red-green",
      ),
    ).toBe(true);
    expect(
      current.artifactWrites?.some((write) => write.path.endsWith("ticket-definitions.json")),
    ).toBe(true);

    await writeFile(
      path.join(run.git.run.worktree, "test-support/vitest.config.ts"),
      "export default { test: { environment: 'jsdom' } };\n",
    );
    const supportDrifted = await program.verifyRun(run);
    expect(supportDrifted).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Prepare the historical proof oracle"),
    });
    await writeFile(
      path.join(run.git.run.worktree, "test-support/vitest.config.ts"),
      "export default { test: { environment: 'node' } };\n",
    );

    await writeFile(
      path.join(run.git.run.worktree, "tests/feature.test.mjs"),
      "process.exitCode = 2;\n",
    );
    const drifted = await program.verifyRun(run);
    expect(drifted).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Prepare the historical proof oracle"),
    });

    await writeFile(
      path.join(run.git.run.worktree, "tests/feature.test.mjs"),
      "process.exitCode = 1;\n",
    );
    const failedReview: AgentAttemptRecord = {
      ...structuredClone(review),
      id: "attempt-proof-review-newer-failed",
      sessionId: "session-proof-review-newer-failed",
      status: "failed" as const,
      launchSpecHash: digest("newer-failed-review-spec"),
      terminalSummary: "The newer independent review failed.",
      endedAt: new Date(FIXED_NOW.getTime() + 1_000).toISOString(),
    };
    delete failedReview.terminalPolicy;
    delete failedReview.terminalOutputSha256;
    delete failedReview.terminalOutputSizeBytes;
    delete failedReview.terminalAcceptedAt;
    run.attempts[failedReview.id] = failedReview;
    const preparationReviewStep = durablePreparation.steps.find((step) => step.kind === "review")!;
    preparationReviewStep.attemptIds.push(failedReview.id);
    const superseded = await program.verifyRun(run);
    expect(superseded).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Prepare the historical proof oracle"),
    });
    delete run.attempts[failedReview.id];
    preparationReviewStep.attemptIds = preparationReviewStep.attemptIds.filter(
      (id) => id !== failedReview.id,
    );

    const implementation = Object.values(run.tickets).find(
      (ticket) => ticket.operationId === "implementation.change.red-green",
    );
    expect(implementation).toBeDefined();
    if (implementation === undefined)
      throw new Error("fixture did not derive red-green implementation");
    const implementationAuthorAssignment = assignmentFor(run, implementation.id);
    const implementationAuthor: AgentAttemptRecord = {
      id: "attempt-implementation-author",
      sessionId: "session-implementation-author",
      ticketId: implementation.id,
      stepId: implementationAuthorAssignment.stepId,
      personaId: implementationAuthorAssignment.personaId,
      modelProvider: "openai-codex",
      modelId: "gpt-5.6-terra",
      thinkingLevel: "high",
      status: "completed",
      launchSpecHash: digest("implementation-author-spec"),
      sessionFile: undefined,
      startedAt: FIXED_NOW.toISOString(),
      endedAt: FIXED_NOW.toISOString(),
      terminalSummary: "Confirmed the current historical baseline before product mutation.",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      lineage: { branchEpoch: 0, reason: "initial" },
      authorityMessages: [],
      authorityToolResults: [],
      authorityCompactions: [],
      kind: "ticket",
      terminalPolicy: semanticTerminalPolicy("implementation-author"),
    };
    run.attempts[implementationAuthor.id] = implementationAuthor;
    const implementationAuthorStep = implementation.steps.find(
      (step) => step.id === implementationAuthorAssignment.stepId,
    )!;
    implementationAuthorStep.status = "completed";
    implementationAuthorStep.attemptIds = [implementationAuthor.id];
    implementationAuthorStep.startedAt = FIXED_NOW.toISOString();
    implementationAuthorStep.completedAt = FIXED_NOW.toISOString();
    implementationAuthorStep.summary = implementationAuthor.terminalSummary;
    const implementationStep = implementation.steps.find((step) => step.id === "implement")!;
    const implementationExecution: AgentAttemptRecord = {
      ...structuredClone(implementationAuthor),
      id: "attempt-implementation-execution",
      sessionId: "session-implementation-execution",
      stepId: implementationStep.id,
      launchSpecHash: digest("implementation-execution-spec"),
      terminalSummary: "Implemented the change and ran the exact promotion member.",
      lineage: { branchEpoch: 0, reason: "initial" },
      terminalPolicy: semanticTerminalPolicy("implementation-execution"),
    };
    run.attempts[implementationExecution.id] = implementationExecution;
    implementationStep.status = "completed";
    implementationStep.attemptIds = [implementationExecution.id];
    implementationStep.startedAt = FIXED_NOW.toISOString();
    implementationStep.completedAt = FIXED_NOW.toISOString();
    implementationStep.summary = implementationExecution.terminalSummary;
    const promotionStdout = Buffer.from("all focused promotion assertions passed\n", "utf8");
    const promotionStderr = Buffer.alloc(0);
    const promotionDirectory = `runs/${run.id}/attempts/${implementationExecution.id}/checks/promotion`;
    await mkdir(path.join(endpoint.stateRoot, promotionDirectory), { recursive: true });
    await writeFile(
      path.join(endpoint.stateRoot, promotionDirectory, "stdout.bin"),
      promotionStdout,
    );
    await writeFile(
      path.join(endpoint.stateRoot, promotionDirectory, "stderr.bin"),
      promotionStderr,
    );
    run.checks.push({
      id: "check-proof-promotion",
      attemptId: implementationExecution.id,
      callId: "call-proof-promotion",
      requestedCheckId: "promotion-proof-set",
      definitionHash: digest("promotion-proof-set-definition"),
      kind: "composite",
      accepted: true,
      passed: true,
      summary: "promotion-proof-set passed",
      commands: [
        {
          checkId: "proof-promotion",
          definitionHash: digest("proof-promotion-check"),
          startedAt: FIXED_NOW.toISOString(),
          completedAt: FIXED_NOW.toISOString(),
          resolvedExecutable: "/usr/bin/node",
          argv: ["/usr/bin/node", "tests/feature.test.mjs"],
          environmentSha256: digest("promotion-environment"),
          exitCode: 0,
          signal: null,
          stdoutSha256: rawSha256(promotionStdout),
          stdoutSizeBytes: promotionStdout.byteLength,
          stdoutArtifactPath: `${promotionDirectory}/stdout.bin`,
          stderrSha256: rawSha256(promotionStderr),
          stderrSizeBytes: promotionStderr.byteLength,
          stderrArtifactPath: `${promotionDirectory}/stderr.bin`,
          preManifestSha256: digest("promotion-workspace-manifest"),
          postManifestSha256: digest("promotion-workspace-manifest"),
          sandboxKind: "fixture",
          sandboxProfileSha256: digest("promotion-sandbox"),
          resultSource: {
            kind: "stdout",
            bytesSha256: rawSha256(promotionStdout),
            sizeBytes: promotionStdout.byteLength,
          },
          outputFiles: [],
        },
      ],
      evidenceSha256: digest("proof-promotion-evidence"),
      evidenceSizeBytes: 1,
      evidenceArtifactPath: `${promotionDirectory}/evidence.json`,
      recordedAt: FIXED_NOW.toISOString(),
    });
    const implementationReviewStep = implementation.steps.find((step) => step.kind === "review")!;
    const implementationReviewPrepared = await program.prepareAttempt({
      kind: "verification",
      run,
      assignment: {
        runId: run.id,
        ticketId: implementation.id,
        stepId: implementationReviewStep.id,
        personaId: implementationReviewStep.personaId,
        priority: implementation.priority,
      },
      attemptId: "attempt-implementation-review",
      sessionId: "session-implementation-review",
      nextAuthorityRevision: 8,
      expectedAuthorityStateHash: digest("proof-authority-eight"),
      lineage: {
        branchEpoch: 1,
        reason: "review",
        parentAttemptId: implementationExecution.id,
        parentSessionId: implementationExecution.sessionId,
      },
    });
    const implementationReviewContext = JSON.parse(
      implementationReviewPrepared.contextContent!,
    ) as {
      historicalPreparation?: {
        protocol?: string;
        entries?: Array<{
          subjectNodeId?: string;
          baseline?: { check?: { sourceEvidenceSha256?: string; commands?: unknown[] } };
          sourceContinuity?: { current?: boolean; currentVia?: string };
        }>;
      };
    };
    expect(implementationReviewPrepared.spec.persona.initialPrompt).toContain(
      "immutable cross-ticket preparation authority",
    );
    expect(implementationReviewPrepared.spec.persona.initialPrompt).toContain(
      "conversational lineage does not",
    );
    expect(implementationReviewContext.historicalPreparation).toMatchObject({
      protocol: "koni.review-historical-preparation.v1",
      entries: [
        {
          subjectNodeId: expect.any(String),
          baseline: {
            check: {
              sourceEvidenceSha256: expect.stringMatching(/^sha256:/),
              commands: [expect.objectContaining({ exitCode: 1 })],
            },
          },
          sourceContinuity: {
            current: true,
            currentVia: "preparation_review",
          },
        },
      ],
    });
    expect(implementationReviewPrepared.contextContent).toContain(
      "expected legacy assertion failure",
    );
    expect(implementationReviewPrepared.contextContent).toContain(
      "all focused promotion assertions passed",
    );

    await persistWrites(project.projectRoot, implementationReviewPrepared.artifactWrites ?? []);
    const implementationReview = attemptRecord(
      implementationReviewPrepared.spec,
      "verification",
      "terminal_accepted",
    );
    implementationReview.reviewedGraphHash = run.graphHash!;
    implementationReview.terminalAcceptedAt = FIXED_NOW.toISOString();
    const implementationReviewOutput = Buffer.from(
      `${JSON.stringify({
        status: "completed",
        reviewVerdict: "approved",
        summary: "The implementation and exact focused proof are independently accepted.",
      })}\n`,
      "utf8",
    );
    implementationReview.terminalOutputSha256 = rawSha256(implementationReviewOutput);
    implementationReview.terminalOutputSizeBytes = implementationReviewOutput.byteLength;
    run.attempts[implementationReview.id] = implementationReview;
    implementationReviewStep.status = "running";
    implementationReviewStep.attemptIds = [implementationReview.id];
    implementationReviewStep.startedAt = FIXED_NOW.toISOString();
    const implementationReviewDirectory = path.join(
      endpoint.stateRoot,
      `runs/${run.id}/attempts/${implementationReview.id}`,
    );
    await mkdir(implementationReviewDirectory, { recursive: true });
    await writeFile(
      path.join(implementationReviewDirectory, "launch-spec.json"),
      `${JSON.stringify(implementationReviewPrepared.spec)}\n`,
    );
    await writeFile(
      path.join(implementationReviewDirectory, "terminal-output.json"),
      implementationReviewOutput,
    );
    const implementationCompiled = await program.compileAssignmentOutput({
      run,
      assignment: {
        runId: run.id,
        ticketId: implementation.id,
        stepId: implementationReviewStep.id,
        personaId: implementationReviewStep.personaId,
        priority: implementation.priority,
      },
      attemptId: implementationReview.id,
      output: JSON.parse(implementationReviewOutput.toString("utf8")),
    });
    await persistWrites(project.projectRoot, implementationCompiled.artifactWrites ?? []);
    run.graphHash = implementationCompiled.graphHash;
    run.graphRevision = implementationCompiled.graphRevision!;
    run.tickets = implementationCompiled.tickets!;
    implementationReview.status = "completed";
    implementationReview.endedAt = FIXED_NOW.toISOString();
    implementationReview.terminalPolicy = semanticTerminalPolicy("implementation-review");
    const durableImplementation = run.tickets[implementation.id]!;
    durableImplementation.status = "completed";
    for (const step of durableImplementation.steps) {
      step.status = "completed";
      step.completedAt ??= FIXED_NOW.toISOString();
    }

    const establish = Object.values(run.tickets).find(
      (ticket) => ticket.operationId === "assurance.proof.establish",
    );
    expect(establish).toBeDefined();
    if (establish === undefined)
      throw new Error("fixture did not retain pre-effect proof establishment");
    const establishExecutionAssignment = assignmentFor(run, establish.id);
    const establishExecution: AgentAttemptRecord = {
      ...structuredClone(implementationExecution),
      id: "attempt-establish-execution",
      sessionId: "session-establish-execution",
      ticketId: establish.id,
      stepId: establishExecutionAssignment.stepId,
      personaId: establishExecutionAssignment.personaId,
      launchSpecHash: digest("establish-execution-spec"),
      terminalSummary: "Replayed the current exact promotion member.",
      lineage: { branchEpoch: 0, reason: "initial" },
      terminalPolicy: semanticTerminalPolicy("establish-execution"),
    };
    run.attempts[establishExecution.id] = establishExecution;
    const establishExecutionStep = establish.steps.find(
      (step) => step.id === establishExecutionAssignment.stepId,
    )!;
    establishExecutionStep.status = "completed";
    establishExecutionStep.attemptIds = [establishExecution.id];
    establishExecutionStep.startedAt = FIXED_NOW.toISOString();
    establishExecutionStep.completedAt = FIXED_NOW.toISOString();
    establishExecutionStep.summary = establishExecution.terminalSummary;
    const establishStdout = Buffer.from("all focused promotion assertions still pass\n", "utf8");
    const establishStderr = Buffer.alloc(0);
    const establishCheckDirectory = `runs/${run.id}/attempts/${establishExecution.id}/checks/promotion`;
    await mkdir(path.join(endpoint.stateRoot, establishCheckDirectory), { recursive: true });
    await writeFile(
      path.join(endpoint.stateRoot, establishCheckDirectory, "stdout.bin"),
      establishStdout,
    );
    await writeFile(
      path.join(endpoint.stateRoot, establishCheckDirectory, "stderr.bin"),
      establishStderr,
    );
    run.checks.push({
      ...structuredClone(run.checks.find((check) => check.id === "check-proof-promotion")!),
      id: "check-establish-promotion",
      attemptId: establishExecution.id,
      callId: "call-establish-promotion",
      commands: [
        {
          ...structuredClone(
            run.checks.find((check) => check.id === "check-proof-promotion")!.commands[0]!,
          ),
          stdoutSha256: rawSha256(establishStdout),
          stdoutSizeBytes: establishStdout.byteLength,
          stdoutArtifactPath: `${establishCheckDirectory}/stdout.bin`,
          stderrSha256: rawSha256(establishStderr),
          stderrSizeBytes: establishStderr.byteLength,
          stderrArtifactPath: `${establishCheckDirectory}/stderr.bin`,
          resultSource: {
            kind: "stdout",
            bytesSha256: rawSha256(establishStdout),
            sizeBytes: establishStdout.byteLength,
          },
        },
      ],
    });
    const establishReviewStep = establish.steps.find((step) => step.kind === "review")!;
    const establishReviewPrepared = await program.prepareAttempt({
      kind: "verification",
      run,
      assignment: {
        runId: run.id,
        ticketId: establish.id,
        stepId: establishReviewStep.id,
        personaId: establishReviewStep.personaId,
        priority: establish.priority,
      },
      attemptId: "attempt-establish-review",
      sessionId: "session-establish-review",
      nextAuthorityRevision: 9,
      expectedAuthorityStateHash: digest("proof-authority-nine"),
      lineage: {
        branchEpoch: 1,
        reason: "review",
        parentAttemptId: establishExecution.id,
        parentSessionId: establishExecution.sessionId,
      },
    });
    const establishReviewContext = JSON.parse(establishReviewPrepared.contextContent!) as {
      historicalPreparation?: {
        entries?: Array<{ sourceContinuity?: { current?: boolean; currentVia?: string } }>;
      };
    };
    expect(establishReviewContext.historicalPreparation?.entries).toEqual([
      expect.objectContaining({
        sourceContinuity: expect.objectContaining({
          current: true,
          currentVia: "review_effect_successor",
        }),
      }),
    ]);
    expect(establishReviewPrepared.contextContent).toContain("expected legacy assertion failure");
    expect(establishReviewPrepared.contextContent).toContain(
      "all focused promotion assertions still pass",
    );
  }, 30_000);

  it("uses the same native compiler program for the research profile", async () => {
    const project = await installedProject("research-profile");
    const nodesPath = path.join(project.projectRoot, ".koni", "graph", "nodes.yaml");
    await writeFile(
      nodesPath,
      (await readFile(nodesPath, "utf8")).replace(
        [
          "    objective:",
          "      type: string",
          "      description: The bounded empirical research objective used to clarify and test the proposition.",
        ].join("\n"),
        [
          "    objective:",
          "      type: string",
          "      description: The bounded empirical research objective used to clarify and test the proposition.",
          "    fixture_command:",
          "      type: json",
          "      description: Exact provider-free verifier argv for this executable fixture.",
          "    scientific_inputs:",
          "      type: json",
          "      description: Exact project-file prerequisites bound into the verifier argv.",
        ].join("\n"),
      ),
    );
    const rulesPath = path.join(project.projectRoot, ".koni", "rules", "research.yaml");
    await writeFile(
      rulesPath,
      (await readFile(rulesPath, "utf8")).replace(
        [
          "    target_nodes: $target",
          "    read_scope: $target",
          "    write_scope: $target",
          "- id: ticket.experiment-portfolio",
        ].join("\n"),
        [
          "    target_nodes: $target",
          "    read_scope: $target",
          "    write_scope: $target",
          "    read_paths: [fixtures]",
          "- id: ticket.experiment-portfolio",
        ].join("\n"),
      ),
    );
    const workflowsPath = path.join(project.projectRoot, ".koni", "workflows", "research.yaml");
    const workflows = await readFile(workflowsPath, "utf8");
    const drillClaimStep = [
      "  - id: drill-claims",
      "    agent: hypothesis-planner",
      "    depends_on: []",
      "    expected_output: claim graph delta within formulation scope",
      "    validation_action: compile-ticket",
    ].join("\n");
    expect(workflows).toContain(drillClaimStep);
    await writeFile(
      workflowsPath,
      workflows.replace(
        drillClaimStep,
        `${drillClaimStep}\n    checks:\n    - scoped-probe-set\n    - exact-prerequisite-set`,
      ),
    );
    const checksPath = path.join(project.projectRoot, ".koni", "checks", "research.yaml");
    await writeFile(
      checksPath,
      (await readFile(checksPath, "utf8")).replace(
        "  receipt_type: compiler.scoped-probe\n  effect: read_only",
        "  receipt_type: compiler.scoped-probe\n  composed_replay: never\n  effect: read_only",
      ),
    );
    await writeFile(
      checksPath,
      `${await readFile(checksPath, "utf8")}\n` +
        [
          "- id: scoped-probe-set",
          "  kind: composite",
          "  applies_to: [drill-hypothesis]",
          "  receipt_type: compiler.scoped-probe-set",
          "  graph_set:",
          "    members: $target",
          "    member_node_types: [hypothesis]",
          "    member_check: scoped-operational-probe",
          "    min_members: 1",
          "",
        ].join("\n"),
    );
    await writeFile(
      checksPath,
      `${await readFile(checksPath, "utf8")}` +
        [
          "- id: exact-prerequisite-set",
          "  kind: command",
          "  applies_to: [drill-hypothesis]",
          "  command_source:",
          "    kind: ticket",
          "    role: ticket",
          "    field: fixture_command",
          "  cwd: .",
          "  timeout_seconds: 60",
          "  result_protocol: koni.fixture-result.v1",
          "  required_result_fields: [protocol, status]",
          "  result_schema:",
          "    type: object",
          "    required: [protocol, status]",
          "    properties:",
          "      protocol: {type: string, const: koni.fixture-result.v1}",
          "      status: {type: string, const: passed}",
          "  argv_input_bindings:",
          "    from: scientific_inputs",
          "    path_field: path",
          "    required_fields: [asset_id, role, path]",
          "    require_nonempty: true",
          "    require_project_file: true",
          "    require_exact_argument: true",
          "  receipt_type: runtime.fixture-receipt",
          "  effect: read_only",
          "  environment:",
          "    inherit: [PATH]",
          "    set: {}",
          "  retry_policy:",
          "    max_attempts: 1",
          "    transient_exit_codes: []",
          "    backoff_seconds: []",
          "",
        ].join("\n"),
    );
    await mkdir(path.join(project.projectRoot, "fixtures"), { recursive: true });
    await writeFile(path.join(project.projectRoot, "fixtures", "research-input.json"), "{}\n");
    const program = await compilerProgram(project);
    const compiledConfiguration = await compileProjectDirectory(
      project.projectRoot,
      project.baseline,
    );
    if (!compiledConfiguration.ok)
      throw new Error("research fixture configuration did not compile");
    const gatePolicies = projectGatePolicyDefinitions(compiledConfiguration.value);
    if (!gatePolicies.ok) throw new Error("research fixture gate policy did not compile");
    const gatePolicy = gatePolicies.value.find(
      (candidate) => candidate.id === "research-capability-gates",
    )!;
    const gateContextMaterial = {
      protocol: "koni.gate-policy-context.v1" as const,
      policy_id: gatePolicy.id,
      policy_contract_sha256: gatePolicy.contractSha256,
      gate_node_id: "gate-fixture",
      winner_node_id: "asset-fixture",
      evaluation_target_node_ids: ["hypothesis-fixture"],
      ancestor_node_ids: [],
      direct_gate_node_ids: ["gate-fixture"],
      inherited_gate_node_ids: [],
      applicable_gate_node_ids: ["gate-fixture"],
      context_node_ids: ["gate-fixture", "asset-fixture", "hypothesis-fixture"],
      read_paths: ["fixtures/research-input.json"],
    };
    const gateContext = {
      ...gateContextMaterial,
      context_sha256: canonicalHash(gateContextMaterial),
    };
    expect(
      resolvePinnedGateAutoEvaluationContexts({
        configuration: compiledConfiguration.value,
        descriptorBoundary: "scoped",
        subjectNodeIds: ["hypothesis-fixture"],
        contexts: [gateContext],
      }),
    ).toEqual([
      expect.objectContaining({
        policyId: gatePolicy.id,
        checkId: "gate-verifier",
        boundary: "scoped",
        gateNodeId: "gate-fixture",
        contextSha256: gateContext.context_sha256,
        readPaths: ["fixtures/research-input.json"],
        sha256: expect.stringMatching(/^sha256:/u),
      }),
    ]);
    expect(
      resolvePinnedGateAutoEvaluationContexts({
        configuration: compiledConfiguration.value,
        descriptorBoundary: "scoped",
        subjectNodeIds: ["unrelated-node"],
        contexts: [gateContext],
      }),
    ).toEqual([]);
    // Gate auto-evaluation is an obligation of the operations its check applies to: a ticket
    // that merely links the gate node (e.g. experiment design) compiles without it, while an
    // applicable operation still binds it.
    expect(
      resolvePinnedGateAutoEvaluationContexts({
        configuration: compiledConfiguration.value,
        descriptorBoundary: "scoped",
        operation: "design-experiment",
        subjectNodeIds: ["hypothesis-fixture"],
        contexts: [gateContext],
      }),
    ).toEqual([]);
    expect(
      resolvePinnedGateAutoEvaluationContexts({
        configuration: compiledConfiguration.value,
        descriptorBoundary: "scoped",
        operation: "run-gate",
        subjectNodeIds: ["hypothesis-fixture"],
        contexts: [gateContext],
      }),
    ).toHaveLength(1);
    expect(() =>
      resolvePinnedGateAutoEvaluationContexts({
        configuration: compiledConfiguration.value,
        descriptorBoundary: "scoped",
        subjectNodeIds: ["hypothesis-fixture"],
        contexts: [{ ...gateContext, read_paths: ["ambient-secret"] }],
      }),
    ).toThrow(expect.objectContaining({ code: "gate_policy_context_hash" }));
    const runId = "run-native-research";
    const resolved = await program.resolveRun({
      runId,
      objective: "Test whether retrieval improves bounded factual recall",
      runTypeId: "medium",
      targetRef: "refs/heads/main",
      intake: { goal: "Test whether retrieval improves bounded factual recall" },
    });
    expect(resolved.profile.lineage).toBe("koni.research");
    expect(resolved.executionConfig.maxParallel).toBe(3);
    expect(resolved.executionConfig.disjointScopeParallelism).toBe(true);
    expect(resolved.executionConfig.agents["run-planner"]).toMatchObject({
      model: "gpt-5.6-terra",
      thinkingLevel: "high",
    });
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
    const run = runRecord(
      project.projectRoot,
      runId,
      "Test whether retrieval improves bounded factual recall",
      resolved,
    );
    const preparedPlanning = await program.prepareAttempt({
      kind: "planning",
      run,
      attemptId: "attempt-research-planning-schema",
      sessionId: "session-research-planning-schema",
      nextAuthorityRevision: 2,
      expectedAuthorityStateHash: digest("research-planning-schema"),
      lineage: { branchEpoch: 0, reason: "initial" },
    });
    expect(
      Value.Check(
        preparedPlanning.terminalOutputSchema!,
        planningOutput(
          {
            hypothesis:
              "Retrieval improves bounded factual recall under the fixed evaluation protocol.",
            fixture_command: [
              "node",
              "scripts/verify-research.mjs",
              "fixtures/research-input.json",
            ],
            scientific_inputs: [
              { asset_id: "fixture-input", role: "dataset", path: "fixtures/research-input.json" },
            ],
          },
          [
            {
              key: "related-literature",
              type: "literature",
              title: "Fixture related work",
              spec: { summary: "Existing context for this bounded research plan." },
            },
          ],
          [{ source: "$root", target: "related-literature", relation: "literature" }],
        ),
      ),
    ).toBe(true);
    const planningOutputWithCapabilityRange = (protocolRange: string) =>
      planningOutput(
        {
          hypothesis:
            "Retrieval improves bounded factual recall under the fixed evaluation protocol.",
          fixture_command: ["node", "scripts/verify-research.mjs", "fixtures/research-input.json"],
          scientific_inputs: [
            { asset_id: "fixture-input", role: "dataset", path: "fixtures/research-input.json" },
          ],
        },
        [
          {
            key: "fixture-gate",
            type: "gate",
            title: "Fixture gate",
            spec: {
              applicability: "Before the bounded evaluation starts.",
              assertion: "The fixture verifier is compatible.",
              capability: { name: "fixture.verifier", protocol_range: protocolRange },
              command_result_contract: { verdict: "passed|failed|inconclusive" },
              oracle_semantics: {
                pass: "The fixture is ready.",
                fail: "The fixture is not ready.",
                inconclusive: "Readiness is unknown.",
                contract_error: "The verifier result is malformed.",
              },
              failure_meaning: "The evaluation must not start.",
              expected_red: true,
            },
          },
        ],
        [{ source: "fixture-gate", target: "$root", relation: "applies_to" }],
      );
    expect(
      Value.Check(
        preparedPlanning.terminalOutputSchema!,
        planningOutputWithCapabilityRange(">=1.0.0 <2.0.0"),
      ),
    ).toBe(true);
    expect(
      Value.Check(
        preparedPlanning.terminalOutputSchema!,
        planningOutputWithCapabilityRange(">=1.0.0,<2.0.0"),
      ),
    ).toBe(false);
    const planningOutputWithSupportPath = (supportPath: string) =>
      planningOutput(
        {
          hypothesis:
            "Retrieval improves bounded factual recall under the fixed evaluation protocol.",
          fixture_command: ["node", "scripts/verify-research.mjs", "fixtures/research-input.json"],
          scientific_inputs: [
            { asset_id: "fixture-input", role: "dataset", path: "fixtures/research-input.json" },
          ],
        },
        [
          {
            key: "fixture-experiment",
            type: "experiment",
            title: "Fixture experiment",
            spec: {
              objective: "Execute one bounded fixture observation.",
              target_claim_summary: "Distinguish the bounded fixture outcomes.",
              empirical_mode: "observation",
              ablation_requirement: "not_applicable",
              execution_protocol: "Run the planned fixture asset once.",
              observable_outcome: "A typed fixture observation is recorded.",
            },
          },
          {
            key: "fixture-asset",
            type: "asset",
            title: "Fixture observer",
            spec: {
              capabilities: [
                {
                  name: "fixture.observer",
                  protocol_version: "1.0.0",
                  entrypoints: ["program/assets/fixture-observer/run.mjs"],
                },
              ],
              implementation_plan: {
                root: "program/assets/fixture-observer",
                files: ["program/assets/fixture-observer/run.mjs"],
              },
              source_strategy: "internal",
              support_paths: [supportPath],
            },
          },
          {
            key: "fixture-gate",
            type: "gate",
            title: "Fixture readiness gate",
            spec: {
              applicability: "Before the fixture experiment runs.",
              assertion: "The fixture observer is executable.",
              capability: { name: "fixture.observer", protocol_range: ">=1.0.0 <2.0.0" },
              command_result_contract: { verdict: "passed|failed|inconclusive" },
              oracle_semantics: {
                pass: "The fixture observer is executable.",
                fail: "The fixture observer is not executable.",
                inconclusive: "Fixture readiness is unknown.",
                contract_error: "The fixture result is malformed.",
              },
              failure_meaning: "The fixture experiment must not start.",
              expected_red: true,
            },
          },
        ],
        [
          { source: "$root", target: "fixture-experiment", relation: "experiments" },
          { source: "fixture-experiment", target: "fixture-asset", relation: "assets" },
          { source: "fixture-gate", target: "fixture-experiment", relation: "applies_to" },
        ],
      );
    await expect(
      program.compilePlanningOutput({
        run,
        attemptId: "attempt-research-missing-support-path",
        output: planningOutputWithSupportPath("fixtures/copied-path-that-does-not-exist.json"),
      }),
    ).rejects.toMatchObject({
      code: "planning_repository_path",
      details: [expect.stringContaining("fixtures/copied-path-that-does-not-exist.json")],
    });
    await writeFile(path.join(project.projectRoot, "fixtures", "main-checkout-only.json"), "{}\n");
    await expect(
      program.compilePlanningOutput({
        run,
        attemptId: "attempt-research-main-checkout-only",
        output: planningOutputWithSupportPath("fixtures/main-checkout-only.json"),
      }),
    ).rejects.toMatchObject({
      code: "planning_repository_path",
      details: [expect.stringContaining("fixtures/main-checkout-only.json")],
    });
    await writeFile(
      path.join(run.git.planning.worktree, "fixtures", "planning-checkout-only.json"),
      "{}\n",
    );
    await expect(
      program.compilePlanningOutput({
        run,
        attemptId: "attempt-research-planning-checkout-only",
        output: planningOutputWithSupportPath("fixtures/planning-checkout-only.json"),
      }),
    ).resolves.toMatchObject({ graphHash: expect.stringMatching(/^sha256:/u) });
    const groundedPlanning = await program.compilePlanningOutput({
      run,
      attemptId: "attempt-research-grounded-support-path",
      output: planningOutputWithSupportPath("fixtures/research-input.json"),
    });
    expect(groundedPlanning.graphHash).toMatch(/^sha256:/u);

    const revisionRun = structuredClone(run);
    const baseArtifact = {
      full: groundedPlanning.plan.full,
      concise: groundedPlanning.plan.concise,
      graphSeed: groundedPlanning.plan.graphSeed,
    };
    const baseArtifactSha256 = canonicalHash(baseArtifact);
    const checkpointPath = `runs/${runId}/attempts/attempt-research-revision/planning/revisions/0/artifact.json`;
    await persistWrites(project.projectRoot, [
      {
        path: checkpointPath,
        bytes: Buffer.from(`${JSON.stringify(baseArtifact)}\n`, "utf8"),
        expectedSha256: null,
      },
    ]);
    revisionRun.plan = { ...groundedPlanning.plan, status: "awaiting_approval" };
    revisionRun.attempts["attempt-research-revision"] = {
      id: "attempt-research-revision",
      sessionId: "session-research-revision",
      ticketId: "run-planning",
      stepId: "planning",
      personaId: "run-planner",
      modelProvider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "high",
      status: "running",
      launchSpecHash: digest("research-revision-launch"),
      sessionFile: `runs/${runId}/sessions/attempt-research-revision/session-research-revision.jsonl`,
      startedAt: FIXED_NOW.toISOString(),
      endedAt: undefined,
      terminalSummary: undefined,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      kind: "planning",
    };
    revisionRun.planningSession = {
      protocol: "koni.planning-session.v1",
      attemptId: "attempt-research-revision",
      sessionId: "session-research-revision",
      status: "running",
      currentRevision: 1,
      revisions: [
        {
          protocol: "koni.planning-revision.v1",
          revision: 0,
          status: "superseded",
          launchSpecSha256: digest("research-revision-launch-zero"),
          grantSha256: digest("research-revision-grant-zero"),
          budgetBaseline: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          budgetPolicy: {
            metric: "new_tokens",
            limit: 120_000,
            synthesisReserve: 20_000,
            synthesisThreshold: 100_000,
            onExhausted: "force_synthesis",
          },
          startedAt: FIXED_NOW.toISOString(),
          completedAt: FIXED_NOW.toISOString(),
          artifactSha256: baseArtifactSha256,
          graphSha256: groundedPlanning.graphHash!,
          transcriptSha256: digest("research-revision-transcript-zero"),
          checkpointPath,
        },
        {
          protocol: "koni.planning-revision.v1",
          revision: 1,
          status: "running",
          launchSpecSha256: digest("research-revision-launch-one"),
          grantSha256: digest("research-revision-grant-one"),
          budgetBaseline: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          budgetPolicy: {
            metric: "new_tokens",
            limit: 120_000,
            synthesisReserve: 20_000,
            synthesisThreshold: 100_000,
            onExhausted: "force_synthesis",
          },
          startedAt: FIXED_NOW.toISOString(),
        },
      ],
    };
    const revisedAsset = (
      baseArtifact.graphSeed as { nodes: Array<Record<string, unknown>> }
    ).nodes.find((node) => node.key === "fixture-asset")!;
    await expect(
      program.compilePlanningRevision({
        run: revisionRun,
        attemptId: "attempt-research-revision",
        revision: 1,
        patch: {
          baseRevision: 0,
          baseArtifactSha256,
          graphSeed: {
            upsertNodes: [
              {
                ...structuredClone(revisedAsset),
                spec: {
                  ...(structuredClone(revisedAsset.spec) as Record<string, unknown>),
                  support_paths: ["fixtures/copied-path-that-does-not-exist.json"],
                },
              },
            ],
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "planning_repository_path",
      details: [expect.stringContaining("fixtures/copied-path-that-does-not-exist.json")],
    });
    const planning = await program.compilePlanningOutput({
      run,
      attemptId: "attempt-research-plan",
      output: planningOutput(
        {
          hypothesis:
            "Retrieval improves bounded factual recall under the fixed evaluation protocol.",
          fixture_command: ["node", "scripts/verify-research.mjs", "fixtures/research-input.json"],
          scientific_inputs: [
            { asset_id: "fixture-input", role: "dataset", path: "fixtures/research-input.json" },
          ],
        },
        [
          {
            key: "related-literature",
            type: "literature",
            title: "Fixture related work",
            spec: { summary: "Existing context that may need a bounded change-control repair." },
          },
        ],
        [{ source: "$root", target: "related-literature", relation: "literature" }],
      ),
    });
    run.plan = { ...planning.plan, status: "approved" };
    run.graphHash = planning.graphHash;
    materializeApprovedFixtureRun(run);
    const approved = await program.initializeApprovedPlan(run);
    expect(Object.values(approved.tickets)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operationId: "formulation.hypothesis.drill-hypothesis" }),
      ]),
    );
    await persistWrites(project.projectRoot, approved.artifactWrites ?? []);
    run.graphHash = approved.graphHash;
    run.graphRevision = approved.graphRevision;
    run.tickets = approved.tickets;
    const ticket = Object.values(run.tickets).find(
      (candidate) => candidate.operationId === "formulation.hypothesis.drill-hypothesis",
    )!;
    const assignment = assignmentFor(run, ticket.id);
    const prepared = await program.prepareAttempt({
      kind: "ticket",
      run,
      assignment,
      attemptId: "attempt-scoped-check",
      sessionId: "session-scoped-check",
      nextAuthorityRevision: 13,
      expectedAuthorityStateHash: digest("authority-thirteen"),
      lineage: {
        branchEpoch: 1,
        reason: "rework",
        parentAttemptId: "attempt-research-plan",
        parentSessionId: "session-research-plan",
      },
    });
    expect(prepared.toolNames).toContain("koni_run_check");
    expect(prepared.spec.persona.initialPrompt).toContain(
      'Do not submit status "completed" after any required check returns accepted: false',
    );
    expect(prepared.spec.persona.initialPrompt).toContain("upstreamChangeRequest");
    expect(prepared.spec.persona.initialPrompt).toContain('"planned_asset_repair"');
    expect(prepared.spec.persona.initialPrompt).toContain("omit graphDelta");
    expect(prepared.spec.persona.initialPrompt).toContain(
      "Graph write authority does not make fields that derive this ticket's repository grant mutable during the active attempt",
    );
    expect(prepared.spec.persona.initialPrompt).toContain(
      'use fulfillment "dynamic_scope_change" for the correction',
    );
    expect(
      upstreamChangeRequestInstructions({
        role: "ordinary",
        allowUpstreamRequests: false,
      } satisfies CompiledChangeControl),
    ).toEqual([]);
    expect(prepared.authorityGrant?.configuredChecks).toEqual({
      ids: ["exact-prerequisite-set", "scoped-probe-set"],
      networkAccess: false,
      maxTimeoutMs: 900_000,
    });
    expect(
      prepared.spec.tools.find((tool) => tool.name === "koni_run_check")?.maxResultBytes,
    ).toBeGreaterThanOrEqual(1024 * 1024);
    await persistWrites(project.projectRoot, prepared.artifactWrites ?? []);
    const attempt = attemptRecord(prepared.spec, "ticket", "running");
    run.attempts[attempt.id] = attempt;
    const prerequisitePath = path.join(ticket.worktreePath!, "fixtures", "research-input.json");
    await unlink(prerequisitePath);
    await expect(
      program.resolveAgentCheck({
        run,
        attempt,
        checkId: "exact-prerequisite-set",
      }),
    ).rejects.toMatchObject({ code: "check_input_binding" });
    await writeFile(prerequisitePath, "{}\n");
    const exactCheck = await program.resolveAgentCheck({
      run,
      attempt,
      checkId: "exact-prerequisite-set",
    });
    expect(exactCheck).toMatchObject({
      kind: "command",
      executionPolicy: {
        checkId: "exact-prerequisite-set",
        effect: "read_only",
        receiptFreshness: "current",
        composedReplay: "required",
      },
      commands: [
        expect.objectContaining({
          argv: ["node", "scripts/verify-research.mjs", "fixtures/research-input.json"],
          inputPaths: ["fixtures/research-input.json"],
          resultProtocol: "koni.fixture-result.v1",
          executionPolicy: expect.objectContaining({
            checkId: "exact-prerequisite-set",
            effect: "read_only",
          }),
        }),
      ],
    });
    const exactCommand = exactCheck.commands[0]!;
    if (exactCheck.executionPolicy === undefined || exactCommand.executionPolicy === undefined) {
      throw new Error("compiler omitted exact prerequisite execution policy");
    }
    const exactCheckPolicy = exactCheck.executionPolicy;
    const exactCommandPolicy = exactCommand.executionPolicy;
    expect(exactCheck.definitionHash).toBe(exactCheckPolicy.checkSha256);
    expect(exactCommand.definitionHash).toBe(exactCommandPolicy.checkSha256);
    expect(
      decideBoundCheckRetry(exactCommandPolicy, {
        attemptNumber: 1,
        exitCode: 1,
        aggregateElapsedSeconds: 1,
      }),
    ).toMatchObject({
      checkId: "exact-prerequisite-set",
      disposition: "terminal_failure",
      backoffSeconds: 0,
    });
    const exactResult = { protocol: "koni.fixture-result.v1", status: "passed" };
    const exactStdout = `${JSON.stringify(exactResult)}\n`;
    const exactManifest = digest("exact-prerequisite-manifest");
    const exactExecution = {
      checkId: exactCommand.checkId,
      definitionHash: exactCommand.definitionHash,
      attemptNumber: 1,
      retryAuditSha256: digest("exact-check-retry-audit"),
      startedAt: "2026-07-16T18:59:56.000Z",
      completedAt: "2026-07-16T18:59:57.000Z",
      resolvedExecutable: "/usr/bin/node",
      argv: ["/usr/bin/node", ...exactCommand.argv.slice(1)],
      environmentSha256: digest("exact-check-environment"),
      exitCode: 0,
      signal: null,
      stdout: exactStdout,
      stderr: "",
      stdoutSha256: rawSha256(exactStdout),
      stdoutSizeBytes: Buffer.byteLength(exactStdout, "utf8"),
      stderrSha256: rawSha256(""),
      stderrSizeBytes: 0,
      preManifestSha256: exactManifest,
      postManifestSha256: exactManifest,
      sandboxKind: "macos-seatbelt.v1",
      sandboxProfileSha256: digest("exact-sandbox-profile"),
      resultSource: {
        kind: "stdout" as const,
        bytesSha256: rawSha256(exactStdout),
        sizeBytes: Buffer.byteLength(exactStdout, "utf8"),
        value: exactResult,
      },
      outputFiles: [],
    };
    const { retryAuditSha256: _retryAuditSha256, ...missingRetryAuditExecution } = exactExecution;
    await expect(
      program.compileAgentCheckResult({
        run,
        attempt,
        check: exactCheck,
        executions: [missingRetryAuditExecution],
      }),
    ).rejects.toMatchObject({ code: "check_execution_retry" });
    const compiledExactCheck = await program.compileAgentCheckResult({
      run,
      attempt,
      check: exactCheck,
      executions: [exactExecution],
    });
    expect(compiledExactCheck).toMatchObject({
      accepted: true,
      passed: true,
      tickets: expect.any(Object),
      evidence: {
        commands: [
          expect.objectContaining({
            attemptNumber: 1,
            retryAuditSha256: exactExecution.retryAuditSha256,
          }),
        ],
      },
      ruleAuthorityEvidence: { protocol: "koni.rule-authority-evidence.v1" },
    });
    const malformedResult = { protocol: "koni.fixture-result.v1" };
    const malformedStdout = `${JSON.stringify(malformedResult)}\n`;
    const malformedExecution = {
      ...exactExecution,
      stdout: malformedStdout,
      stdoutSha256: rawSha256(malformedStdout),
      stdoutSizeBytes: Buffer.byteLength(malformedStdout, "utf8"),
      resultSource: {
        kind: "stdout" as const,
        bytesSha256: rawSha256(malformedStdout),
        sizeBytes: Buffer.byteLength(malformedStdout, "utf8"),
        value: malformedResult,
      },
    };
    const compiledMalformedCheck = await program.compileAgentCheckResult({
      run,
      attempt,
      check: exactCheck,
      executions: [malformedExecution],
    });
    expect(compiledMalformedCheck).toMatchObject({
      accepted: false,
      passed: false,
      summary: expect.stringContaining("result is missing status"),
    });
    const wrongStatusResult = {
      protocol: "koni.fixture-result.v1",
      status: "failed",
    };
    const wrongStatusStdout = `${JSON.stringify(wrongStatusResult)}\n`;
    const compiledWrongStatusCheck = await program.compileAgentCheckResult({
      run,
      attempt,
      check: exactCheck,
      executions: [
        {
          ...exactExecution,
          stdout: wrongStatusStdout,
          stdoutSha256: rawSha256(wrongStatusStdout),
          stdoutSizeBytes: Buffer.byteLength(wrongStatusStdout, "utf8"),
          resultSource: {
            kind: "stdout" as const,
            bytesSha256: rawSha256(wrongStatusStdout),
            sizeBytes: Buffer.byteLength(wrongStatusStdout, "utf8"),
            value: wrongStatusResult,
          },
        },
      ],
    });
    expect(compiledWrongStatusCheck).toMatchObject({
      accepted: false,
      passed: false,
      summary: expect.stringContaining('result schema mismatch at /status: expected "passed"'),
    });
    const missingPythonDependencyStderr = [
      "Traceback (most recent call last):",
      '  File "scripts/verify-research.py", line 4, in <module>',
      "    import torch",
      "ModuleNotFoundError: No module named 'torch'",
    ].join("\n");
    const missingPythonDependencyExecution = {
      ...exactExecution,
      exitCode: 1,
      stdout: "",
      stdoutSha256: rawSha256(""),
      stdoutSizeBytes: 0,
      stderr: missingPythonDependencyStderr,
      stderrSha256: rawSha256(missingPythonDependencyStderr),
      stderrSizeBytes: Buffer.byteLength(missingPythonDependencyStderr, "utf8"),
      resultSource: {
        kind: "stdout" as const,
        bytesSha256: rawSha256(""),
        sizeBytes: 0,
        value: null,
      },
    };
    const compiledMissingPythonDependency = await program.compileAgentCheckResult({
      run,
      attempt,
      check: exactCheck,
      executions: [missingPythonDependencyExecution],
    });
    expect(compiledMissingPythonDependency).toMatchObject({
      accepted: false,
      passed: false,
      summary: expect.stringContaining(
        "command infrastructure failed before producing an admissible expected result",
      ),
    });
    const checkedAncestor: AgentAttemptRecord = {
      ...structuredClone(attempt),
      id: "attempt-scoped-check-ancestor",
      sessionId: "session-scoped-check-ancestor",
      status: "interrupted",
      error: "Run paused",
      endedAt: "2026-07-16T19:00:00.000Z",
      lineage: { branchEpoch: 0, reason: "initial" },
    };
    run.attempts[checkedAncestor.id] = checkedAncestor;
    const interruptedParent: AgentAttemptRecord = {
      ...structuredClone(checkedAncestor),
      id: "attempt-scoped-check-parent",
      sessionId: "session-scoped-check-parent",
      lineage: {
        branchEpoch: 1,
        reason: "recovery",
        parentAttemptId: checkedAncestor.id,
        parentSessionId: checkedAncestor.sessionId,
        parentEntryId: "entry-scoped-check-ancestor",
        conversationFork: {
          parentLaunchSpecHash: checkedAncestor.launchSpecHash,
          parentTranscriptSha256: digest("scoped-check-ancestor-transcript"),
        },
      },
    };
    run.attempts[interruptedParent.id] = interruptedParent;
    attempt.lineage = {
      branchEpoch: 1,
      reason: "recovery",
      parentAttemptId: interruptedParent.id,
      parentSessionId: interruptedParent.sessionId,
      parentEntryId: "entry-scoped-check-parent",
      conversationFork: {
        parentLaunchSpecHash: interruptedParent.launchSpecHash,
        parentTranscriptSha256: digest("scoped-check-parent-transcript"),
      },
    };
    const failedParentCheck: NonNullable<RunRecord["checks"]>[number] = {
      id: "check-parent-exact-prerequisite",
      attemptId: checkedAncestor.id,
      callId: "call-parent-exact-prerequisite",
      requestedCheckId: exactCheck.requestedCheckId,
      definitionHash: exactCheck.definitionHash,
      kind: exactCheck.kind,
      executionPolicy: exactCheckPolicy,
      accepted: compiledMissingPythonDependency.accepted,
      passed: compiledMissingPythonDependency.passed,
      summary: compiledMissingPythonDependency.summary,
      commands: [
        {
          checkId: missingPythonDependencyExecution.checkId,
          definitionHash: missingPythonDependencyExecution.definitionHash,
          executionPolicy: exactCommandPolicy,
          startedAt: missingPythonDependencyExecution.startedAt,
          completedAt: missingPythonDependencyExecution.completedAt,
          resolvedExecutable: missingPythonDependencyExecution.resolvedExecutable,
          argv: missingPythonDependencyExecution.argv,
          environmentSha256: missingPythonDependencyExecution.environmentSha256,
          exitCode: missingPythonDependencyExecution.exitCode,
          signal: missingPythonDependencyExecution.signal,
          stdoutSha256: missingPythonDependencyExecution.stdoutSha256,
          stdoutSizeBytes: missingPythonDependencyExecution.stdoutSizeBytes,
          stdoutArtifactPath: "runs/run-native-research/checks/parent/stdout.txt",
          stderrSha256: missingPythonDependencyExecution.stderrSha256,
          stderrSizeBytes: missingPythonDependencyExecution.stderrSizeBytes,
          stderrArtifactPath: "runs/run-native-research/checks/parent/stderr.txt",
          preManifestSha256: missingPythonDependencyExecution.preManifestSha256,
          postManifestSha256: missingPythonDependencyExecution.postManifestSha256,
          sandboxKind: missingPythonDependencyExecution.sandboxKind,
          sandboxProfileSha256: missingPythonDependencyExecution.sandboxProfileSha256,
          resultSource: {
            kind: missingPythonDependencyExecution.resultSource.kind,
            bytesSha256: missingPythonDependencyExecution.resultSource.bytesSha256,
            sizeBytes: missingPythonDependencyExecution.resultSource.sizeBytes,
          },
          outputFiles: [],
        },
      ],
      evidenceSha256: canonicalHash(compiledMissingPythonDependency.evidence),
      evidenceSizeBytes: Buffer.byteLength(
        JSON.stringify(compiledMissingPythonDependency.evidence),
        "utf8",
      ),
      evidenceArtifactPath: "runs/run-native-research/checks/parent/evidence.json",
      recordedAt: "2026-07-16T19:00:00.000Z",
    };
    run.checks = [failedParentCheck];
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment,
        attemptId: attempt.id,
        output: {
          status: "failed",
          blocker: "The inherited exact prerequisite check still reports a missing dependency",
        },
      }),
    ).rejects.toMatchObject({ code: "assignment_check_provenance" });
    run.checks.push({
      ...structuredClone(failedParentCheck),
      id: "check-current-failed-exact-prerequisite",
      attemptId: attempt.id,
      callId: "call-current-failed-exact-prerequisite",
      recordedAt: "2026-07-16T19:01:00.000Z",
    });
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment,
        attemptId: attempt.id,
        output: {
          status: "failed",
          blocker: "The freshly rerun exact prerequisite check still reports a missing dependency",
        },
      }),
    ).resolves.toEqual({
      outcome: {
        status: "failed",
        blocker: "The freshly rerun exact prerequisite check still reports a missing dependency",
        failureKind: "infrastructure",
      },
    });
    delete run.checks;
    attempt.lineage = { branchEpoch: 1, reason: "rework" };
    const check = await program.resolveAgentCheck({
      run,
      attempt,
      checkId: "scoped-probe-set",
    });
    expect(check).toMatchObject({
      kind: "composite",
      executionPolicy: {
        checkId: "scoped-probe-set",
        effect: "read_only",
      },
      commands: [
        expect.objectContaining({
          checkId: "scoped-operational-probe",
          effect: "read_only",
          expectedExitCodes: [0],
          resultProtocol: "process-exit.v1",
          executionPolicy: expect.objectContaining({
            checkId: "scoped-operational-probe",
            composedReplay: "never",
          }),
        }),
      ],
    });
    const command = check.commands[0]!;
    if (check.executionPolicy === undefined || command.executionPolicy === undefined) {
      throw new Error("compiler omitted scoped probe execution policy");
    }
    const scopedCheckPolicy = check.executionPolicy;
    const scopedCommandPolicy = command.executionPolicy;
    expect(check.definitionHash).toBe(scopedCheckPolicy.checkSha256);
    expect(command.definitionHash).toBe(scopedCommandPolicy.checkSha256);
    const stdout = `${JSON.stringify({ protocol: "process-exit.v1", status: "passed" })}\n`;
    const manifest = digest("unchanged-worktree");
    const execution = {
      checkId: command.checkId,
      definitionHash: command.definitionHash,
      startedAt: "2026-07-16T18:59:58.000Z",
      completedAt: "2026-07-16T18:59:59.000Z",
      resolvedExecutable: "/usr/bin/python3",
      argv: ["/usr/bin/python3", ...command.argv.slice(1)],
      environmentSha256: digest("check-environment"),
      exitCode: 0,
      signal: null,
      stdout,
      stderr: "",
      stdoutSha256: rawSha256(stdout),
      stdoutSizeBytes: Buffer.byteLength(stdout, "utf8"),
      stderrSha256: rawSha256(""),
      stderrSizeBytes: 0,
      preManifestSha256: manifest,
      postManifestSha256: manifest,
      sandboxKind: "macos-seatbelt.v1",
      sandboxProfileSha256: digest("sandbox-profile"),
      resultSource: {
        kind: "stdout" as const,
        bytesSha256: rawSha256(stdout),
        sizeBytes: Buffer.byteLength(stdout, "utf8"),
        value: { protocol: "process-exit.v1", status: "passed" },
      },
      outputFiles: [],
    };
    const compiledCheck = await program.compileAgentCheckResult({
      run,
      attempt,
      check,
      executions: [execution],
    });
    expect(compiledCheck).toMatchObject({
      accepted: true,
      passed: true,
      value: { accepted: true, passed: true },
      evidence: {
        protocol: "koni.agent-check-execution-evidence.v1",
        requestedCheckId: "scoped-probe-set",
      },
      ruleAuthorityEvidence: { protocol: "koni.rule-authority-evidence.v1" },
    });
    const completedOutput = {
      status: "completed",
      summary: "Compiled the hypothesis drill after its current scoped check",
    };
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment,
        attemptId: attempt.id,
        output: completedOutput,
      }),
    ).rejects.toMatchObject({ code: "assignment_checks_incomplete" });
    const recordedChecks: NonNullable<RunRecord["checks"]> = [
      {
        id: "check-current-scoped-probe",
        attemptId: attempt.id,
        callId: "call-current-scoped-probe",
        requestedCheckId: check.requestedCheckId,
        definitionHash: check.definitionHash,
        kind: check.kind,
        executionPolicy: scopedCheckPolicy,
        accepted: compiledCheck.accepted,
        passed: compiledCheck.passed,
        summary: compiledCheck.summary,
        commands: [
          {
            checkId: execution.checkId,
            definitionHash: execution.definitionHash,
            executionPolicy: scopedCommandPolicy,
            startedAt: execution.startedAt,
            completedAt: execution.completedAt,
            resolvedExecutable: execution.resolvedExecutable,
            argv: execution.argv,
            environmentSha256: execution.environmentSha256,
            exitCode: execution.exitCode,
            signal: execution.signal,
            stdoutSha256: execution.stdoutSha256,
            stdoutSizeBytes: execution.stdoutSizeBytes,
            stdoutArtifactPath: "runs/run-native-research/checks/current/stdout.txt",
            stderrSha256: execution.stderrSha256,
            stderrSizeBytes: execution.stderrSizeBytes,
            stderrArtifactPath: "runs/run-native-research/checks/current/stderr.txt",
            preManifestSha256: execution.preManifestSha256,
            postManifestSha256: execution.postManifestSha256,
            sandboxKind: execution.sandboxKind,
            sandboxProfileSha256: execution.sandboxProfileSha256,
            resultSource: {
              kind: execution.resultSource.kind,
              bytesSha256: execution.resultSource.bytesSha256,
              sizeBytes: execution.resultSource.sizeBytes,
            },
            outputFiles: [],
          },
        ],
        evidenceSha256: canonicalHash(compiledCheck.evidence),
        evidenceSizeBytes: Buffer.byteLength(JSON.stringify(compiledCheck.evidence), "utf8"),
        evidenceArtifactPath: "runs/run-native-research/checks/current/evidence.json",
        recordedAt: "2026-07-16T19:00:00.000Z",
      },
    ];
    recordedChecks.push({
      id: "check-current-exact-prerequisite",
      attemptId: attempt.id,
      callId: "call-current-exact-prerequisite",
      requestedCheckId: exactCheck.requestedCheckId,
      definitionHash: exactCheck.definitionHash,
      kind: exactCheck.kind,
      executionPolicy: exactCheckPolicy,
      accepted: compiledExactCheck.accepted,
      passed: compiledExactCheck.passed,
      summary: compiledExactCheck.summary,
      commands: [
        {
          checkId: exactExecution.checkId,
          definitionHash: exactExecution.definitionHash,
          executionPolicy: exactCommandPolicy,
          startedAt: exactExecution.startedAt,
          completedAt: exactExecution.completedAt,
          resolvedExecutable: exactExecution.resolvedExecutable,
          argv: exactExecution.argv,
          environmentSha256: exactExecution.environmentSha256,
          exitCode: exactExecution.exitCode,
          signal: exactExecution.signal,
          stdoutSha256: exactExecution.stdoutSha256,
          stdoutSizeBytes: exactExecution.stdoutSizeBytes,
          stdoutArtifactPath: "runs/run-native-research/checks/exact/stdout.txt",
          stderrSha256: exactExecution.stderrSha256,
          stderrSizeBytes: exactExecution.stderrSizeBytes,
          stderrArtifactPath: "runs/run-native-research/checks/exact/stderr.txt",
          preManifestSha256: exactExecution.preManifestSha256,
          postManifestSha256: exactExecution.postManifestSha256,
          sandboxKind: exactExecution.sandboxKind,
          sandboxProfileSha256: exactExecution.sandboxProfileSha256,
          resultSource: {
            kind: exactExecution.resultSource.kind,
            bytesSha256: exactExecution.resultSource.bytesSha256,
            sizeBytes: exactExecution.resultSource.sizeBytes,
          },
          outputFiles: [],
        },
      ],
      evidenceSha256: canonicalHash(compiledExactCheck.evidence),
      evidenceSizeBytes: Buffer.byteLength(JSON.stringify(compiledExactCheck.evidence), "utf8"),
      evidenceArtifactPath: "runs/run-native-research/checks/exact/evidence.json",
      recordedAt: "2026-07-16T19:00:00.000Z",
    });
    recordedChecks.unshift({
      ...structuredClone(recordedChecks[0]!),
      id: "check-older-scoped-probe",
      callId: "call-older-scoped-probe",
      recordedAt: "2026-07-16T18:00:00.000Z",
    });
    run.checks = recordedChecks;
    const terminalPolicy = await program.projectAssignmentTerminalPolicy({
      run,
      assignment,
      attemptId: attempt.id,
    });
    expect(terminalPolicy).toMatchObject({
      protocol: "koni.assignment-terminal-policy.v1",
      configurationSha256: run.compiledConfigHash,
      executionPolicyBinding: { stepId: assignment.stepId },
      validationCheckIds: ["exact-prerequisite-set", "scoped-probe-set"],
      composedReplayCheckIds: ["exact-prerequisite-set"],
      retainedReceipts: [
        expect.objectContaining({
          runCheckId: "check-current-scoped-probe",
          checkId: "scoped-operational-probe",
        }),
      ],
      sourceManifestPairs: [],
    });
    expect(terminalPolicy.retainedReceipts).toEqual([
      expect.objectContaining({
        runCheckId: "check-current-scoped-probe",
        checkId: "scoped-operational-probe",
      }),
    ]);
    expect(
      terminalPolicy.validationChecks.find((candidate) => candidate.checkId === "scoped-probe-set"),
    ).toMatchObject({
      causalCommands: [expect.objectContaining({ checkId: "scoped-operational-probe" })],
      resolvedCheck: { commands: [] },
      retainedLeafPolicies: [expect.objectContaining({ checkId: "scoped-operational-probe" })],
      replaySelection: {
        replayCheckIds: [],
        skipped: [{ checkId: "scoped-operational-probe", reason: "opted_out" }],
      },
    });
    await expect(
      program.compileAssignmentTerminalReplay({
        run,
        assignment,
        attemptId: attempt.id,
        projectionSha256: terminalPolicy.sha256,
        executions: [
          { checkId: "scoped-probe-set", executions: [] },
          { checkId: "exact-prerequisite-set", executions: [exactExecution] },
        ],
        retainedReceipts: terminalPolicy.retainedReceipts,
      }),
    ).resolves.toMatchObject({
      protocol: "koni.assignment-terminal-replay.v1",
      accepted: true,
      passed: true,
      checks: expect.arrayContaining([
        expect.objectContaining({
          checkId: "scoped-probe-set",
          replayedLeafCheckIds: [],
          retainedLeafCheckIds: ["scoped-operational-probe"],
        }),
        expect.objectContaining({
          checkId: "exact-prerequisite-set",
          replayedLeafCheckIds: ["exact-prerequisite-set"],
          retainedLeafCheckIds: [],
        }),
      ]),
    });
    const noGraphChange = await program.compileAssignmentOutput({
      run,
      assignment,
      attemptId: attempt.id,
      output: completedOutput,
    });
    expect(noGraphChange).toMatchObject({
      outcome: { status: "completed", summary: completedOutput.summary },
      tickets: expect.any(Object),
      artifactWrites: [
        expect.objectContaining({ path: expect.stringMatching(/ticket-definitions\.json$/u) }),
      ],
    });

    const controlTarget = ticket.targetNodeIds[0]!;
    const externalTarget = (await program.projectGraph(run)).nodes.find(
      (node) => node.type === "literature",
    )!.id;
    const upstreamOutput = {
      status: "completed",
      summary: "The hypothesis requires a bounded upstream semantic correction",
      upstreamChangeRequest: {
        targetNodeIds: [externalTarget, controlTarget],
        fulfillment: "dynamic_scope_change",
        summary: "Correct the bounded hypothesis contract",
        reason: "The current formulation cannot represent the verified constraint",
      },
    };
    expect(Value.Check(prepared.terminalOutputSchema!, upstreamOutput)).toBe(true);
    const transportNullUpstreamOutput = {
      ...upstreamOutput,
      graphDelta: null,
    };
    expect(Value.Check(prepared.terminalOutputSchema!, transportNullUpstreamOutput)).toBe(false);
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment,
        attemptId: attempt.id,
        output: transportNullUpstreamOutput,
      }),
    ).resolves.toMatchObject({
      outcome: { status: "completed", summary: upstreamOutput.summary },
      changeControl: {
        kind: "upstream_request",
        fulfillment: "dynamic_scope_change",
        targetNodeIds: upstreamOutput.upstreamChangeRequest.targetNodeIds,
      },
    });
    const legacyUpstreamOutput = {
      ...upstreamOutput,
      upstreamChangeRequest: {
        targetNodeIds: upstreamOutput.upstreamChangeRequest.targetNodeIds,
        summary: upstreamOutput.upstreamChangeRequest.summary,
        reason: upstreamOutput.upstreamChangeRequest.reason,
      },
    };
    expect(Value.Check(prepared.terminalOutputSchema!, legacyUpstreamOutput)).toBe(false);
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment,
        attemptId: attempt.id,
        output: legacyUpstreamOutput,
      }),
    ).resolves.toMatchObject({
      outcome: { status: "completed", summary: upstreamOutput.summary },
      changeControl: {
        kind: "upstream_request",
        fulfillment: "dynamic_scope_change",
        targetNodeIds: upstreamOutput.upstreamChangeRequest.targetNodeIds,
      },
    });
    const collidingUpstreamOutput = {
      ...upstreamOutput,
      graphDelta: {
        protocol: "koni.graph-delta.v1",
        expectedGraphHash: run.graphHash,
        upsertNodes: [],
        deleteNodes: [],
        addEdges: [],
        removeEdges: [],
      },
    };
    expect(Value.Check(prepared.terminalOutputSchema!, collidingUpstreamOutput)).toBe(false);
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment,
        attemptId: attempt.id,
        output: collidingUpstreamOutput,
      }),
    ).rejects.toMatchObject({ code: "change_control_graph_collision" });
    expect(
      Value.Check(prepared.terminalOutputSchema!, {
        ...upstreamOutput,
        upstreamChangeRequest: {
          ...upstreamOutput.upstreamChangeRequest,
          ambientAuthority: true,
        },
      }),
    ).toBe(false);
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment,
        attemptId: attempt.id,
        output: {
          ...upstreamOutput,
          upstreamChangeRequest: {
            ...upstreamOutput.upstreamChangeRequest,
            targetNodeIds: ["missing-research-node"],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "change_control_target_missing" });
    const upstream = await program.compileAssignmentOutput({
      run,
      assignment,
      attemptId: attempt.id,
      output: upstreamOutput,
    });
    expect(upstream).toMatchObject({
      outcome: { status: "completed", summary: upstreamOutput.summary },
      changeControl: {
        protocol: "koni.assignment-change-control.v1",
        kind: "upstream_request",
        sourceTicketId: ticket.id,
        sourceStepId: assignment.stepId,
        sourceBindingSha256: ticket.steps[0]!.executionPolicyBinding!.sha256,
        targetNodeIds: [externalTarget, controlTarget],
        publication: {
          protocol: "koni.change-control-publication.v1",
          initialStatus: "proposed",
          disposition: "create",
        },
      },
    });
    expect(upstream).not.toHaveProperty("graphHash");
    expect(upstream).not.toHaveProperty("graphRevision");
    const upstreamControl = upstream.changeControl!;
    if (upstreamControl.kind !== "upstream_request")
      throw new Error("compiler omitted upstream request metadata");
    const sourceTerminalProof = fixtureTerminalSuccessProof({
      runId: run.id,
      ticketId: ticket.id,
      stepId: assignment.stepId,
      attemptId: attempt.id,
      actionInvocationId: "source-change-request-action",
      changeControlSha256: upstreamControl.sha256,
    });
    const proposal = await program.projectChangeControlProposalTicket({
      run,
      changeControl: upstreamControl,
      sourceTerminalProof,
    });
    if (proposal === undefined) throw new Error("compiler omitted the required proposal");
    expect(proposal).toMatchObject({
      id: upstreamControl.publication.proposalTicketId,
      operationId: "lifecycle.change-request",
      status: "proposed",
      targetNodeIds: [externalTarget, controlTarget],
      readNodeIds: [externalTarget, controlTarget],
      writeNodeIds: [],
      readPaths: [],
      writePaths: [],
      executionControl: {
        changeControlScopeNodeIds: [externalTarget, controlTarget],
        proposalRequest: {
          requestSha256: upstreamControl.publication.requestSha256,
          sourceTicketId: ticket.id,
          sourceStepId: assignment.stepId,
          fulfillment: "dynamic_scope_change",
        },
      },
      steps: [
        expect.objectContaining({ id: "scope-change", kind: "integration" }),
        expect.objectContaining({ id: "propose-graph-delta", kind: "integration" }),
        expect.objectContaining({ id: "risk-review", kind: "review" }),
      ],
    });
    expect(proposal.steps).toHaveLength(3);
    expect(
      proposal.steps.every(
        (step) => (step.writeNodeIds ?? proposal.writeNodeIds ?? []).length === 0,
      ),
    ).toBe(true);
    expect(proposal.steps.every((step) => step.executionPolicyBinding?.stepId === step.id)).toBe(
      true,
    );
    run.tickets[proposal.id] = proposal;

    const reuseCompilation = await program.compileAssignmentOutput({
      run,
      assignment,
      attemptId: attempt.id,
      output: upstreamOutput,
    });
    if (reuseCompilation.changeControl?.kind !== "upstream_request") {
      throw new Error("compiler omitted replayed upstream request metadata");
    }
    expect(reuseCompilation.changeControl.publication.disposition).toBe("reuse");
    await expect(
      program.projectChangeControlProposalTicket({
        run,
        changeControl: reuseCompilation.changeControl,
        sourceTerminalProof,
      }),
    ).resolves.toEqual(proposal);

    proposal.status = "queued";
    const proposalApprovalMaterial = {
      protocol: "koni.proposal-decision-authority.v2" as const,
      runId: run.id,
      proposalTicketId: proposal.id,
      requestSha256: proposal.executionControl!.proposalRequest!.requestSha256,
      eventId: "proposal-approval-event",
      decision: "approval" as const,
      actor: "operator",
      message: "Approve the exact bounded research change",
      recordedAt: FIXED_NOW.toISOString(),
    };
    const proposalApproval = {
      ...proposalApprovalMaterial,
      sha256: canonicalHash(proposalApprovalMaterial),
    };
    proposal.executionControl!.proposalDecision = proposalApproval;
    proposal.executionControl!.proposalDecisionHistory = [proposalApproval];
    proposal.executionControl!.proposalApprovalSha256 = proposalApproval.sha256;
    proposal.executionControl!.proposalDisposition = {
      kind: "approved",
      authoritySha256: proposalApproval.sha256,
    };
    proposal.steps[0]!.status = "completed";
    proposal.steps[0]!.summary = "Bounded the source control scope without mutation";
    proposal.steps[0]!.completedAt = FIXED_NOW.toISOString();
    const proposalCycle = attachFixtureTicketCycle(run, proposal);
    materializeFixtureCheckout(run.git.run.worktree, proposalCycle.worktree);
    const proposalStep = proposal.steps.find((step) => step.id === "propose-graph-delta")!;
    const proposalAssignment: ReadyAssignment = {
      runId: run.id,
      ticketId: proposal.id,
      stepId: proposalStep.id,
      personaId: proposalStep.personaId,
      priority: proposal.priority,
    };
    const proposalPrepared = await program.prepareAttempt({
      kind: "ticket",
      run,
      assignment: proposalAssignment,
      attemptId: "attempt-change-proposal",
      sessionId: "session-change-proposal",
      nextAuthorityRevision: 14,
      expectedAuthorityStateHash: digest("authority-fourteen"),
      lineage: {
        branchEpoch: 0,
        reason: "initial",
      },
    });
    expect(proposalPrepared.spec.persona.initialPrompt).toContain(
      "Do not select no-op while the approved request remains unsatisfied",
    );
    expect(proposalPrepared.spec.persona.initialPrompt).toContain(
      'Use changeApplication.operation "apply-change-request"',
    );
    await persistWrites(project.projectRoot, proposalPrepared.artifactWrites ?? []);
    run.attempts[proposalPrepared.spec.identity.attemptId] = attemptRecord(
      proposalPrepared.spec,
      "ticket",
      "running",
    );
    const applicationReferencePath = "program/assets/unlinked_reference/resolve.py";
    const applicationOutput = {
      status: "completed",
      summary: "Selected the exact bounded semantic application",
      changeApplication: {
        operation: "apply-change-request",
        targetNodeIds: [controlTarget],
        summary: `Apply only the reviewed hypothesis contract correction using ${applicationReferencePath}`,
      },
    };
    expect(Value.Check(proposalPrepared.terminalOutputSchema!, applicationOutput)).toBe(true);
    expect(
      Value.Check(proposalPrepared.terminalOutputSchema!, {
        status: "completed",
        summary: "Missing the required typed application",
      }),
    ).toBe(false);
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment: proposalAssignment,
        attemptId: proposalPrepared.spec.identity.attemptId,
        output: {
          status: "completed",
          summary: "Missing the required typed application",
        },
      }),
    ).rejects.toMatchObject({ code: "change_control_application_required" });
    expect(
      Value.Check(proposalPrepared.terminalOutputSchema!, {
        ...applicationOutput,
        graphDelta: {
          protocol: "koni.graph-delta.v1",
          expectedGraphHash: run.graphHash,
          upsertNodes: [],
          deleteNodes: [],
          addEdges: [],
          removeEdges: [],
        },
      }),
    ).toBe(false);
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment: proposalAssignment,
        attemptId: proposalPrepared.spec.identity.attemptId,
        output: {
          ...applicationOutput,
          changeApplication: {
            ...applicationOutput.changeApplication,
            operation: "change-request",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "change_control_application_route" });
    const exactProposalScope = [...proposal.executionControl!.changeControlScopeNodeIds!];
    proposal.executionControl!.changeControlScopeNodeIds = [];
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment: proposalAssignment,
        attemptId: proposalPrepared.spec.identity.attemptId,
        output: applicationOutput,
      }),
    ).rejects.toMatchObject({ code: "control_ticket_projection" });
    proposal.executionControl!.changeControlScopeNodeIds = exactProposalScope;
    const applicationSelection = await program.compileAssignmentOutput({
      run,
      assignment: proposalAssignment,
      attemptId: proposalPrepared.spec.identity.attemptId,
      output: applicationOutput,
    });
    expect(applicationSelection).toMatchObject({
      outcome: { status: "completed", summary: applicationOutput.summary },
      changeControl: {
        kind: "proposal_application",
        proposalTicketId: proposal.id,
        proposalStepId: "propose-graph-delta",
        proposalBindingSha256: proposal.executionPolicyBinding!.sha256,
        applicationPublicOperation: "apply-change-request",
        applicationOperationId: "lifecycle.apply-change-request",
        targetNodeIds: [controlTarget],
        scope: {
          readNodeIds: [controlTarget],
          writeNodeIds: [controlTarget],
          readPaths: [],
          writePaths: [],
        },
      },
    });
    if (applicationSelection.changeControl?.kind !== "proposal_application") {
      throw new Error("compiler omitted proposal application metadata");
    }
    const executionCatalog = await program.projectExecutionSemanticCatalog(run);
    const proposalTerminalProof = fixtureTerminalSuccessProof({
      runId: run.id,
      ticketId: proposal.id,
      stepId: proposalStep.id,
      attemptId: proposalPrepared.spec.identity.attemptId,
      actionInvocationId: "proposal-terminal-action",
      changeControlSha256: applicationSelection.changeControl.sha256,
    });
    const proposalReviewTerminalProof = fixtureTerminalSuccessProof({
      runId: run.id,
      ticketId: proposal.id,
      stepId: "risk-review",
      attemptId: "attempt-change-proposal-review",
      actionInvocationId: "proposal-review-terminal-action",
    });
    const applicationMaterialization = deriveApprovedChangeMaterialization(executionCatalog, {
      runId: run.id,
      proposalTicketId: proposal.id,
      proposalBinding: proposal.executionPolicyBinding!,
      requestSha256: proposal.executionControl!.proposalRequest!.requestSha256,
      approvalSha256: digest("proposal-approval"),
      proposalOutputSha256: applicationSelection.changeControl.proposalOutputSha256,
      proposalStepId: applicationSelection.changeControl.proposalStepId,
      proposalSelectionSha256: applicationSelection.changeControl.sha256,
      selectionSummary: applicationSelection.changeControl.summary,
      proposalTerminalProof,
      reviewSha256: digest("proposal-review"),
      reviewTerminalProof: proposalReviewTerminalProof,
      applicationPublicOperation: applicationSelection.changeControl.applicationPublicOperation,
      targetNodeIds: applicationSelection.changeControl.targetNodeIds,
      scope: applicationSelection.changeControl.scope,
    });
    proposal.executionControl!.approvedMaterialization = applicationMaterialization;
    const applicationTicket = await program.projectApprovedApplicationTicket({
      run,
      materialization: applicationMaterialization,
      selection: applicationSelection.changeControl,
    });
    expect(applicationTicket).toMatchObject({
      id:
        applicationMaterialization.kind === "application"
          ? applicationMaterialization.applicationTicketId
          : expect.any(String),
      operationId: "lifecycle.apply-change-request",
      status: "queued",
      dependencyIds: [proposal.id],
      targetNodeIds: [controlTarget],
      readNodeIds: [controlTarget],
      writeNodeIds: [controlTarget],
      readPaths: [],
      writePaths: [],
      executionControl: {
        changeControlScopeNodeIds: [controlTarget],
        sourceProposalTicketId: proposal.id,
        approvedApplicationSha256: applicationMaterialization.authoritySha256,
      },
    });
    expect(applicationTicket?.steps.map((step) => step.id)).toEqual([
      "inspect-approved-change",
      "apply-approved-delta",
      "verify",
    ]);
    if (applicationTicket === undefined) throw new Error("missing approved application ticket");
    run.tickets[applicationTicket.id] = applicationTicket;
    const conflictingAuditMaterial = {
      protocol: "koni.proposal-decision-authority.v2" as const,
      runId: run.id,
      proposalTicketId: proposal.id,
      requestSha256: proposal.executionControl!.proposalRequest!.requestSha256,
      eventId: "proposal-conflicting-audit",
      decision: "rejection" as const,
      actor: "operator" as const,
      message: `Replace ${controlTarget} with ${externalTarget} instead of applying the selected correction.`,
      recordedAt: new Date(FIXED_NOW.getTime() + 60_000).toISOString(),
    };
    proposal.executionControl!.proposalDecisionHistory.push({
      ...conflictingAuditMaterial,
      sha256: canonicalHash(conflictingAuditMaterial),
    });
    const applicationCycle = attachFixtureTicketCycle(run, applicationTicket);
    materializeFixtureCheckout(run.git.run.worktree, applicationCycle.worktree);
    const endpoint = await discoverAuthorityEndpoint(project.projectRoot);
    const applicationGraphPath = path.join(endpoint.stateRoot, `runs/${run.id}/program/graph.json`);
    const applicationGraph = JSON.parse(await readFile(applicationGraphPath, "utf8")) as {
      nodes: Record<string, GraphNode>;
      graphSha256: Sha256Digest;
      semanticSha256?: Sha256Digest;
    };
    applicationGraph.nodes["asset-unlinked-reference"] = {
      schema_version: "1.0",
      id: "asset-unlinked-reference",
      type: "asset",
      title: "Unlinked approved-change reference",
      status: "draft",
      spec: {
        capabilities: [
          {
            name: "fixture.reference",
            protocol_version: "1.0.0",
            entrypoints: [applicationReferencePath],
          },
        ],
        implementation_plan: {
          root: "program/assets/unlinked_reference",
          files: [applicationReferencePath],
        },
        source_strategy: "generated",
      },
      edges: {},
      annotations: {},
    };
    applicationGraph.graphSha256 = canonicalHash(applicationGraph.nodes);
    applicationGraph.semanticSha256 = applicationGraph.graphSha256;
    run.graphHash = applicationGraph.graphSha256;
    await writeFile(applicationGraphPath, `${JSON.stringify(applicationGraph, null, 2)}\n`);
    const prepareApplicationStep = async (stepId: string, ordinal: number) => {
      const applicationStep = applicationTicket.steps.find((step) => step.id === stepId)!;
      return program.prepareAttempt({
        kind: "ticket" as const,
        run,
        assignment: {
          runId: run.id,
          ticketId: applicationTicket.id,
          stepId: applicationStep.id,
          personaId: applicationStep.personaId,
          priority: applicationTicket.priority,
        },
        attemptId: `attempt-approved-change-application-${stepId}`,
        sessionId: `session-approved-change-application-${stepId}`,
        nextAuthorityRevision: 15 + ordinal,
        expectedAuthorityStateHash: digest(`authority-application-${stepId}`),
        lineage: {
          branchEpoch: 0,
          reason: "initial" as const,
        },
      });
    };
    const inspectApplicationPrepared = await prepareApplicationStep("inspect-approved-change", 0);
    const applicationPrepared = await prepareApplicationStep("apply-approved-delta", 1);
    const inspectPredecessor = attemptRecord(
      inspectApplicationPrepared.spec,
      "ticket",
      "completed",
    );
    inspectPredecessor.endedAt = FIXED_NOW.toISOString();
    run.attempts[inspectPredecessor.id] = inspectPredecessor;
    const inspectStep = applicationTicket.steps.find(
      (step) => step.id === "inspect-approved-change",
    )!;
    inspectStep.status = "completed";
    inspectStep.attemptIds.push(inspectPredecessor.id);
    const applicationPredecessor = attemptRecord(applicationPrepared.spec, "ticket", "completed");
    applicationPredecessor.endedAt = FIXED_NOW.toISOString();
    run.attempts[applicationPredecessor.id] = applicationPredecessor;
    const applicationStep = applicationTicket.steps.find(
      (step) => step.id === "apply-approved-delta",
    )!;
    applicationStep.status = "completed";
    applicationStep.attemptIds.push(applicationPredecessor.id);
    const reviewStep = applicationTicket.steps.find((step) => step.id === "verify")!;
    const reviewApplicationPrepared = await program.prepareAttempt({
      kind: "verification",
      run,
      assignment: {
        runId: run.id,
        ticketId: applicationTicket.id,
        stepId: reviewStep.id,
        personaId: reviewStep.personaId,
        priority: applicationTicket.priority,
      },
      attemptId: "attempt-approved-change-application-verify",
      sessionId: "session-approved-change-application-verify",
      nextAuthorityRevision: 17,
      expectedAuthorityStateHash: digest("authority-application-verify"),
      lineage: {
        branchEpoch: 1,
        reason: "review",
        parentAttemptId: applicationPredecessor.id,
        parentSessionId: applicationPredecessor.sessionId,
      },
    });
    delete run.attempts[inspectPredecessor.id];
    inspectStep.status = "pending";
    inspectStep.attemptIds.pop();
    delete run.attempts[applicationPredecessor.id];
    applicationStep.status = "pending";
    applicationStep.attemptIds.pop();
    for (const prepared of [
      inspectApplicationPrepared,
      applicationPrepared,
      reviewApplicationPrepared,
    ]) {
      expect(prepared.spec.persona.initialPrompt).toContain(
        `Exact approved application selection (${applicationMaterialization.authoritySha256}): ${applicationMaterialization.selectionSummary}`,
      );
      expect(prepared.spec.persona.initialPrompt).toContain(
        "Compatible later audit steering clarifies this selection but does not replace it",
      );
      expect(prepared.spec.persona.initialPrompt).toContain(
        "materially conflicts with or would replace the exact selection",
      );
      expect(prepared.spec.persona.initialPrompt).toContain(
        `Operator audit-only steering after approval (does not revoke approval): ${conflictingAuditMaterial.message}`,
      );
      expect(prepared.spec.persona.initialPrompt).toContain(
        "requires a focused question or new change-control decision instead of silent precedence",
      );
    }
    expect(inspectApplicationPrepared.spec.persona.initialPrompt).toContain(
      "Inspect and authenticate the exact approved selection",
    );
    expect(inspectApplicationPrepared.spec.persona.initialPrompt).toContain(
      "without mutating the graph",
    );
    expect(inspectApplicationPrepared.spec.persona.initialPrompt).not.toContain(
      "Apply a non-empty scoped semantic graph delta",
    );
    expect(reviewApplicationPrepared.spec.persona.initialPrompt).toContain(
      "Review the predecessor candidate against the exact approved selection",
    );
    expect(reviewApplicationPrepared.spec.persona.initialPrompt).not.toContain(
      "Apply a non-empty scoped semantic graph delta",
    );
    expect(applicationPrepared.spec.persona.initialPrompt).toContain(
      "Apply a non-empty scoped semantic graph delta",
    );
    expect(applicationPrepared.spec.persona.initialPrompt).toContain(
      "The approved change request defines the required state for this application",
    );
    expect(applicationPrepared.spec.persona.initialPrompt).toContain(
      "The exact approved application selection is already the authoritative resolution",
    );
    expect(applicationPrepared.spec.persona.initialPrompt).toContain(
      "The approved request together with its cumulative operator steering is the complete obligation for this application",
    );
    expect(applicationPrepared.spec.persona.initialPrompt).toContain(
      "Historical durable obligations are additive constraints",
    );
    expect(applicationPrepared.spec.persona.initialPrompt).toContain(
      `Application graph write-authority nodes: ${controlTarget}.`,
    );
    expect(applicationPrepared.spec.persona.initialPrompt).not.toContain(
      `Authorized target nodes: ${externalTarget}, ${controlTarget}`,
    );
    expect(applicationPrepared.spec.persona.initialPrompt).toContain(
      "Request context may name causal nodes outside this application authority",
    );
    expect(applicationPrepared.spec.persona.initialPrompt).toContain(
      "An approved request can explicitly authorize a bounded new node",
    );
    expect(applicationPrepared.spec.persona.initialPrompt).toContain(
      "unapproved-new-node-creation forbids only a new node that the approved request does not require",
    );
    expect(applicationPrepared.spec.persona.initialPrompt).toContain(
      "Correct the bounded hypothesis contract",
    );
    expect(applicationPrepared.spec.persona.initialPrompt).toContain(
      "that does not make an unsatisfied application a no-op",
    );
    expect(applicationPrepared.spec.persona.initialPrompt).toContain(
      "update the asset's authored implementation_plan.files",
    );
    expect(applicationPrepared.spec.persona.initialPrompt).not.toContain("asset-payload-mutation");
    const applicationAttempt = attemptRecord(applicationPrepared.spec, "ticket", "running");
    run.attempts[applicationAttempt.id] = applicationAttempt;
    // Dynamic application context must be self-contained in the immutable control-ticket cause.
    // The proposal-side projection can be absent from an in-memory authority view while an
    // already-issued application attempt is being settled or recovered.
    delete proposal.executionControl!.approvedMaterialization;
    const approvedReferenceContext = await program.selectDynamicGraphContext({
      run,
      attempt: applicationAttempt,
      spec: applicationPrepared.spec,
      request: {
        anchors: [controlTarget],
        nodeTypes: ["asset"],
        direction: "both",
        maxDepth: 0,
      },
    });
    expect(approvedReferenceContext.envelope.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "semantic_node", id: "asset-unlinked-reference" }),
      ]),
    );
    delete run.tickets[applicationTicket.id];

    const noOpOutput = {
      status: "completed",
      summary: "The reviewed desired state is already satisfied",
      changeApplication: {
        operation: "no-op",
        targetNodeIds: [controlTarget],
        summary: "Record the reviewed no-op without launching another agent",
      },
    };
    const noOpSelection = await program.compileAssignmentOutput({
      run,
      assignment: proposalAssignment,
      attemptId: proposalPrepared.spec.identity.attemptId,
      output: noOpOutput,
    });
    if (noOpSelection.changeControl?.kind !== "proposal_application") {
      throw new Error("compiler omitted no-op selection metadata");
    }
    expect(noOpSelection.changeControl.scope).toEqual({
      readNodeIds: [],
      writeNodeIds: [],
      readPaths: [],
      writePaths: [],
    });
    const noOpMaterialization = deriveApprovedChangeMaterialization(executionCatalog, {
      runId: run.id,
      proposalTicketId: proposal.id,
      proposalBinding: proposal.executionPolicyBinding!,
      requestSha256: proposal.executionControl!.proposalRequest!.requestSha256,
      approvalSha256: digest("proposal-no-op-approval"),
      proposalOutputSha256: noOpSelection.changeControl.proposalOutputSha256,
      proposalStepId: noOpSelection.changeControl.proposalStepId,
      proposalSelectionSha256: noOpSelection.changeControl.sha256,
      selectionSummary: noOpSelection.changeControl.summary,
      proposalTerminalProof: fixtureTerminalSuccessProof({
        runId: run.id,
        ticketId: proposal.id,
        stepId: proposalStep.id,
        attemptId: proposalPrepared.spec.identity.attemptId,
        actionInvocationId: "proposal-no-op-terminal-action",
        changeControlSha256: noOpSelection.changeControl.sha256,
      }),
      reviewSha256: digest("proposal-no-op-review"),
      reviewTerminalProof: proposalReviewTerminalProof,
      applicationPublicOperation: noOpSelection.changeControl.applicationPublicOperation,
      targetNodeIds: noOpSelection.changeControl.targetNodeIds,
      scope: noOpSelection.changeControl.scope,
    });
    expect(noOpMaterialization.kind).toBe("no_op");
    await expect(
      program.projectApprovedApplicationTicket({
        run,
        materialization: noOpMaterialization,
        selection: noOpSelection.changeControl,
      }),
    ).resolves.toBeUndefined();

    const sourceFailureAttemptId = "attempt-source-terminal-failure";
    const sourceTerminalPolicyMaterial = {
      protocol: "koni.agent-terminal-policy.v1" as const,
      mode: "semantic" as const,
      projectionSha256: terminalPolicy.sha256,
      replayCompilationSha256: digest("source-terminal-replay"),
      receiptEvaluationSha256: digest("source-terminal-receipts"),
      sourcePreservationSha256s: [] as Sha256Digest[],
      acceptedAt: FIXED_NOW.toISOString(),
    };
    const sourceTerminalPolicy = {
      ...sourceTerminalPolicyMaterial,
      sha256: canonicalHash(sourceTerminalPolicyMaterial),
    };
    const sourceTerminalOutputSha256 = digest("source-terminal-failure-output");
    const sourceFailureAttempt: AgentAttemptRecord = {
      ...structuredClone(attempt),
      id: sourceFailureAttemptId,
      sessionId: "session-source-terminal-failure",
      status: "failed",
      terminalPolicy: sourceTerminalPolicy,
      terminalOutputSha256: sourceTerminalOutputSha256,
      endedAt: FIXED_NOW.toISOString(),
      terminalSummary: "Exact configured source validation failed",
    };
    run.attempts[sourceFailureAttemptId] = sourceFailureAttempt;
    const sourceFailureStep = ticket.steps.find((step) => step.id === assignment.stepId)!;
    sourceFailureStep.attemptIds.push(sourceFailureAttemptId);
    const sourceFailureProof = fixtureTerminalFailureProof({
      runId: run.id,
      ticketId: ticket.id,
      stepId: sourceFailureStep.id,
      attemptId: sourceFailureAttemptId,
      actionInvocationId: "source-terminal-failure-action",
      terminalPolicySha256: sourceTerminalPolicy.sha256,
      terminalOutputSha256: sourceTerminalOutputSha256,
    });
    run.terminalFailureProofs = { [sourceFailureProof.sha256]: sourceFailureProof };
    const failureBindingSha256 = terminalFailureBindingFromProof(
      run,
      ticket,
      sourceFailureProof,
    )?.sha256;
    if (failureBindingSha256 === undefined) throw new Error("fixture source failure did not bind");
    const resolverReconciliation = deriveTerminalResolverReconciliation(executionCatalog, {
      runId: run.id,
      sourceTicketId: ticket.id,
      sourceBinding: ticket.executionPolicyBinding!,
      failureBindingSha256,
      existingResolvers: [],
    });
    if (resolverReconciliation.chainSuppressed)
      throw new Error("ordinary source unexpectedly suppressed resolver");
    const resolver = await program.projectTerminalResolverTicket({
      run,
      reconciliation: resolverReconciliation,
      sourceFailureProof,
    });
    expect(resolver).toMatchObject({
      id: resolverReconciliation.resolverTicketId,
      operationId: "lifecycle.resolve-conflict",
      status: "queued",
      dependencyIds: [],
      executionControl: {
        terminalRecovery: {
          sourceTicketId: ticket.id,
          failureBindingSha256s: [failureBindingSha256],
        },
      },
    });
    expect(resolver?.steps.map((step) => step.id)).toEqual(["diagnose", "resolve", "review"]);

    const cancelledRun = structuredClone(run);
    const cancelledResolver = structuredClone(resolver!);
    cancelledResolver.status = "cancelled";
    cancelledResolver.blocker = "Superseded before execution by newer compiler state";
    for (const step of cancelledResolver.steps) {
      step.status = "skipped";
      step.attemptIds = [];
    }
    cancelledRun.tickets[cancelledResolver.id] = cancelledResolver;
    const cancelledReuse = deriveTerminalResolverReconciliation(executionCatalog, {
      runId: cancelledRun.id,
      sourceTicketId: ticket.id,
      sourceBinding: ticket.executionPolicyBinding!,
      failureBindingSha256,
      existingResolvers: [
        {
          ticketId: cancelledResolver.id,
          sourceTicketId: ticket.id,
          resolverOperationId: cancelledResolver.operationId,
          configurationSha256: cancelledRun.compiledConfigHash,
          catalogSha256: executionCatalog.sha256,
          failureBindingSha256s: [failureBindingSha256],
          terminal: true,
        },
      ],
    });
    await expect(
      program.projectTerminalResolverTicket({
        run: cancelledRun,
        reconciliation: cancelledReuse,
        sourceFailureProof,
      }),
    ).resolves.toEqual(cancelledResolver);

    run.tickets[resolver!.id] = resolver!;
    const resolverCycle = attachFixtureTicketCycle(run, resolver!);
    materializeFixtureCheckout(run.git.run.worktree, resolverCycle.worktree);
    const resolverStep = resolver!.steps[0]!;
    const resolverAssignment: ReadyAssignment = {
      runId: run.id,
      ticketId: resolver!.id,
      stepId: resolverStep.id,
      personaId: resolverStep.personaId,
      priority: resolver!.priority,
    };
    const resolverPrepared = await program.prepareAttempt({
      kind: "ticket",
      run,
      assignment: resolverAssignment,
      attemptId: "attempt-terminal-resolver",
      sessionId: "session-terminal-resolver",
      nextAuthorityRevision: 15,
      expectedAuthorityStateHash: digest("authority-fifteen"),
      lineage: { branchEpoch: 0, reason: "initial" },
    });
    const resolverContext = JSON.parse(resolverPrepared.contextContent!) as {
      terminalRecovery?: {
        sourceTicketId: string;
        failureBindingSha256s: Sha256Digest[];
        sourceFailureProof: TerminalFailureSettlementProof;
      };
    };
    expect(resolverContext.terminalRecovery).toEqual({
      sourceTicketId: ticket.id,
      failureBindingSha256s: [failureBindingSha256],
      sourceFailureProof,
    });
    expect(resolverPrepared.spec.persona.initialPrompt).toContain(
      "compiler-authenticated terminal recovery proof",
    );
    expect(resolverPrepared.spec.persona.initialPrompt).toContain(
      sourceFailureProof.semanticResult.blocker,
    );
    await persistWrites(project.projectRoot, resolverPrepared.artifactWrites ?? []);
    run.attempts[resolverPrepared.spec.identity.attemptId] = attemptRecord(
      resolverPrepared.spec,
      "ticket",
      "running",
    );
    const resolverFailureOutput = {
      status: "failed" as const,
      summary: "The resolver preserved the accepted diagnosis but cannot complete the repair.",
      blocker: "The bounded resolver requires explicit operator recovery",
    };
    expect(Value.Check(resolverPrepared.terminalOutputSchema!, resolverFailureOutput)).toBe(true);
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment: resolverAssignment,
        attemptId: resolverPrepared.spec.identity.attemptId,
        output: resolverFailureOutput,
      }),
    ).resolves.toEqual({ outcome: resolverFailureOutput });
    const resolverReuse = deriveTerminalResolverReconciliation(executionCatalog, {
      runId: run.id,
      sourceTicketId: ticket.id,
      sourceBinding: ticket.executionPolicyBinding!,
      failureBindingSha256,
      existingResolvers: [
        {
          ticketId: resolver!.id,
          sourceTicketId: ticket.id,
          resolverOperationId: resolver!.operationId,
          configurationSha256: run.compiledConfigHash,
          catalogSha256: executionCatalog.sha256,
          failureBindingSha256s: [failureBindingSha256],
          terminal: false,
        },
      ],
    });
    await expect(
      program.projectTerminalResolverTicket({
        run,
        reconciliation: resolverReuse,
        sourceFailureProof,
      }),
    ).resolves.toEqual(resolver);
    const suppressed = deriveTerminalResolverReconciliation(executionCatalog, {
      runId: run.id,
      sourceTicketId: resolver!.id,
      sourceBinding: resolver!.executionPolicyBinding!,
      failureBindingSha256: digest("resolver-terminal-failure-binding"),
      existingResolvers: [],
    });
    expect(suppressed.chainSuppressed).toBe(true);
    await expect(
      program.projectTerminalResolverTicket({
        run,
        reconciliation: suppressed,
        sourceFailureProof,
      }),
    ).resolves.toBeUndefined();
  });

  it("prepares a research small run for direct approval without launching a planner", async () => {
    const project = await installedProject("research-profile");
    const program = await compilerProgram(project);
    const runId = "run-native-research-direct";
    const objective = "Measure whether retrieval improves bounded factual recall";
    const hypothesis =
      "Matched retrieval contexts improve bounded factual recall relative to matched non-retrieval controls.";
    const resolved = await program.resolveRun({
      runId,
      objective,
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: objective, hypothesis },
    });
    expect(resolved.planningMode).toBe("direct");
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
    const run = runRecord(project.projectRoot, runId, objective, resolved, {
      goal: objective,
      hypothesis,
    });
    run.workingSpecOwnerId = resolved.workingSpecOwnerId!;
    const reviewable = await program.initializeDirectApproval(run);
    expect(reviewable.plan).toMatchObject({
      revision: 1,
      full: {},
      concise: {},
      graphSeed: undefined,
    });
    expect(reviewable.graphHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const directGraphWrite = reviewable.artifactWrites?.find((write) =>
      write.path.endsWith("/direct-approval-graph.json"),
    );
    const initialDirectGraph = JSON.parse(
      Buffer.from(directGraphWrite!.bytes).toString("utf8"),
    ) as {
      nodes: Record<string, unknown>;
    };
    expect(Object.values(initialDirectGraph.nodes)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "hypothesis",
          spec: expect.objectContaining({ objective, hypothesis }),
        }),
      ]),
    );
    expect(reviewable.artifactWrites?.map((write) => write.path)).toEqual([
      `runs/${runId}/direct-approval.json`,
      `runs/${runId}/direct-approval-graph.json`,
    ]);
    await persistWrites(project.projectRoot, reviewable.artifactWrites ?? []);
    run.plan = { ...reviewable.plan, status: "approved" };
    run.graphHash = reviewable.graphHash;
    materializeApprovedFixtureRun(run);
    const approved = await program.initializeApprovedPlan(run);
    expect(Object.values(approved.tickets)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operationId: "formulation.hypothesis.drill-hypothesis" }),
      ]),
    );
    const graphWrite = approved.artifactWrites?.find((write) =>
      write.path.endsWith("/program/graph.json"),
    );
    const directGraph = JSON.parse(Buffer.from(graphWrite!.bytes).toString("utf8")) as {
      contextual: {
        ownerPersonaId: string;
        revision: number;
        canonicalWorkingSpecId: string;
        records: Record<string, { baseline: { acceptedPlan: unknown; source: { kind: string } } }>;
      };
    };
    expect(directGraph.contextual).toMatchObject({
      ownerPersonaId: resolved.workingSpecOwnerId,
      revision: 1,
    });
    expect(
      directGraph.contextual.records[directGraph.contextual.canonicalWorkingSpecId],
    ).toMatchObject({
      baseline: { acceptedPlan: null, source: { kind: "direct_approval" } },
    });
    await persistWrites(project.projectRoot, approved.artifactWrites ?? []);
    run.graphHash = approved.graphHash;
    run.graphRevision = approved.graphRevision;
    run.tickets = approved.tickets;

    const integration = await program.createIntegrationTicket({
      run,
      conflictReport: "The run branch and target branch both published the same asset.",
      targetOid: run.git.target.selectedOid,
    });
    expect(integration.operationId).toBe("integration.target.resolve-conflict");
    expect(integration.executionPolicyBinding).toMatchObject({
      operationId: "integration.target.resolve-conflict",
      publicOperation: "resolve-target-integration",
      workflowId: "target-integration-conflict",
    });
    expect(integration.steps.map((step) => [step.id, step.dependsOn])).toEqual([
      ["inspect-conflict", []],
      ["resolve-conflicts", ["inspect-conflict"]],
      ["verify-composed-tree", ["resolve-conflicts"]],
      ["review", ["verify-composed-tree"]],
    ]);
    expect(integration.steps.every((step) => step.executionPolicyBinding?.stepId === step.id)).toBe(
      true,
    );
    run.tickets[integration.id] = integration;
    const reconciled = await program.reconcileTicketBoard(run);
    expect(reconciled.tickets[integration.id]).toMatchObject({
      status: "queued",
      operationId: "integration.target.resolve-conflict",
    });
    expect(
      reconciled.tickets[integration.id]!.steps.every((step) => step.status === "pending"),
    ).toBe(true);
    run.tickets[integration.id] = structuredClone(integration);
    run.tickets[integration.id]!.status = "cancelled";
    run.tickets[integration.id]!.blocker = "Superseded before execution by newer compiler state";
    for (const [index, step] of run.tickets[integration.id]!.steps.entries()) {
      step.status = "skipped";
      if (index < 2) step.attemptIds.push(`attempt-historical-integration-${index}`);
    }
    const repaired = await program.reconcileTicketBoard(run);
    expect(repaired.tickets[integration.id]).toMatchObject({
      status: "queued",
      blocker: undefined,
    });
    expect(repaired.tickets[integration.id]!.steps.every((step) => step.status === "pending")).toBe(
      true,
    );
    run.tickets[integration.id] = structuredClone(repaired.tickets[integration.id]!);
    run.tickets[integration.id]!.status = "cancelled";
    run.tickets[integration.id]!.blocker =
      "Current compiler predicate no longer applies after prior execution";
    for (const step of run.tickets[integration.id]!.steps) step.status = "skipped";
    const repairedInapplicable = await program.reconcileTicketBoard(run);
    expect(repairedInapplicable.tickets[integration.id]).toMatchObject({
      status: "queued",
      blocker: undefined,
    });
  });

  it("resolves exactly one working-spec owner before producing any run artifacts", async () => {
    const unique = await installedProject("coding-profile");
    const uniqueProgram = await compilerProgram(unique);
    const fallback = await uniqueProgram.resolveRun({
      runId: "run-owner-fallback",
      objective: "Resolve the unique lead",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Resolve the unique lead" },
    });
    expect(fallback.workingSpecOwnerId).toBe("lead");

    await expect(
      uniqueProgram.resolveRun({
        runId: "run-owner-invalid",
        objective: "Reject an unknown explicit owner",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Reject an unknown explicit owner" },
        overrides: { workingSpecOwner: "missing-agent" },
      }),
    ).rejects.toMatchObject({ code: "working_spec_owner_invalid" });
    const uniqueEndpoint = await discoverAuthorityEndpoint(unique.projectRoot);
    await expect(
      readFile(path.join(uniqueEndpoint.stateRoot, "runs/run-owner-invalid/program/graph.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const zero = await installedProject("coding-profile");
    const zeroPersonas = path.join(zero.projectRoot, ".koni", "agents", "lead.yaml");
    await writeFile(
      zeroPersonas,
      (await readFile(zeroPersonas, "utf8")).replace("  role: lead\n", "  role: ticket_worker\n"),
    );
    await expect(
      (await compilerProgram(zero)).resolveRun({
        runId: "run-owner-zero",
        objective: "Reject zero leads",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Reject zero leads" },
      }),
    ).rejects.toMatchObject({
      code: "configuration_invalid",
      details: expect.arrayContaining([expect.stringContaining("configuration.role_provider")]),
    });

    const multiple = await installedProject("coding-profile");
    const multiplePersonas = path.join(multiple.projectRoot, ".koni", "agents", "implementer.yaml");
    await writeFile(
      multiplePersonas,
      (await readFile(multiplePersonas, "utf8")).replace(
        "  role: ticket_worker\n",
        "  role: lead\n",
      ),
    );
    await expect(
      (await compilerProgram(multiple)).resolveRun({
        runId: "run-owner-multiple",
        objective: "Reject multiple leads",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Reject multiple leads" },
      }),
    ).rejects.toMatchObject({ code: "working_spec_owner_resolution" });
  }, 20_000);

  it("pins an explicit owner, persists the approved baseline, and isolates note/spec CAS from semantic state", async () => {
    const project = await installedProject("coding-profile");
    const program = await compilerProgram(project);
    const runId = "run-contextual-graph";
    const objective = "Persist bounded graph-native working context";
    const resolved = await program.resolveRun({
      runId,
      objective,
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: objective },
      overrides: { workingSpecOwner: "architecture-mapper" },
    });
    expect(resolved.workingSpecOwnerId).toBe("architecture-mapper");
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
    const run = runRecord(project.projectRoot, runId, objective, resolved);
    run.workingSpecOwnerId = resolved.workingSpecOwnerId!;

    const planning = await program.prepareAttempt({
      kind: "planning",
      run,
      attemptId: "attempt-context-plan",
      sessionId: "session-context-plan",
      nextAuthorityRevision: 2,
      expectedAuthorityStateHash: digest("context-plan-state"),
      lineage: { branchEpoch: 0, reason: "initial" },
    });
    await persistWrites(project.projectRoot, planning.artifactWrites ?? []);
    const planningAttempt = attemptRecord(planning.spec, "planning", "running");
    run.attempts[planningAttempt.id] = planningAttempt;
    const endpoint = await discoverAuthorityEndpoint(project.projectRoot);
    const graphPath = path.join(endpoint.stateRoot, `runs/${runId}/program/graph.json`);
    const shell = JSON.parse(await readFile(graphPath, "utf8")) as {
      graphSha256: Sha256Digest;
      revision: number;
      contextual: {
        runRootId: string;
        revision: number;
        hash: Sha256Digest;
        records: Record<string, unknown>;
      };
    };
    const semanticBefore = { hash: shell.graphSha256, revision: shell.revision };
    const planningNote = await program.executeAgentTool({
      run,
      attempt: planningAttempt,
      grant: planning.authorityGrant!,
      spec: planning.spec,
      call: {
        callId: "call-planning-root-note",
        name: "koni_record_note",
        arguments: {
          nodeId: shell.contextual.runRootId,
          kind: "observation",
          body: "Planning evidence belongs to the stable run root.",
          paths: ["README.md"],
        },
      },
    });
    await persistWrites(project.projectRoot, planningNote.artifactWrites ?? []);
    const noted = JSON.parse(await readFile(graphPath, "utf8")) as typeof shell;
    expect({ hash: noted.graphSha256, revision: noted.revision }).toEqual(semanticBefore);
    expect(noted.contextual.revision).toBe(1);

    const compiledPlan = await program.compilePlanningOutput({
      run,
      attemptId: planningAttempt.id,
      output: planningOutput({ work_kind: "general" }),
    });
    await persistWrites(project.projectRoot, compiledPlan.artifactWrites ?? []);
    run.plan = { ...compiledPlan.plan, status: "awaiting_approval" };
    run.graphHash = compiledPlan.graphHash;
    run.graphRevision = compiledPlan.graphRevision ?? 0;
    planningAttempt.terminalAcceptedAt = FIXED_NOW.toISOString();
    materializeApprovedFixtureRun(run);
    const approved = await program.initializeApprovedPlan(run);
    await persistWrites(project.projectRoot, approved.artifactWrites ?? []);
    run.plan = { ...run.plan, status: "approved" };
    run.graphHash = approved.graphHash;
    run.graphRevision = approved.graphRevision;
    run.tickets = approved.tickets;

    const approvedArtifact = JSON.parse(await readFile(graphPath, "utf8")) as {
      graphSha256: Sha256Digest;
      semanticSha256: Sha256Digest;
      revision: number;
      nodes: Record<string, GraphNode>;
      contextual: {
        revision: number;
        hash: Sha256Digest;
        canonicalWorkingSpecId: string;
        ownerPersonaId: string;
        records: Record<
          string,
          {
            protocol: string;
            version?: number;
            digest?: Sha256Digest;
            supersedes?: string;
            baseline?: { source: { artifactPath: string; artifactSha256: Sha256Digest } };
            provenance: Record<string, unknown>;
          }
        >;
      };
    };
    expect(approvedArtifact.contextual.ownerPersonaId).toBe("architecture-mapper");
    expect(approvedArtifact.contextual.revision).toBe(2);
    const baselineId = approvedArtifact.contextual.canonicalWorkingSpecId;
    const baseline = approvedArtifact.contextual.records[baselineId]!;
    expect(baseline).toMatchObject({ protocol: "koni.working-spec.v1", version: 1 });
    expect(baseline.baseline?.source.artifactPath).toContain("planning-output.json");
    const nativeNote = Object.values(approvedArtifact.contextual.records).find(
      (record) => record.protocol === "koni.graph-note.v2",
    )!;
    expect(nativeNote.provenance).toMatchObject({
      runId,
      generation: run.generation,
      ticketId: "run-planning",
      attemptId: planningAttempt.id,
      sessionId: planningAttempt.sessionId,
      personaId: planningAttempt.personaId,
      semanticRevision: 0,
      contextualRevision: 0,
      authorityGrantHash: planning.spec.authority.grantHash,
      launchSpecHash: planning.spec.specHash,
      lineage: planning.spec.lineage,
    });

    await expect(
      program.executeAgentTool({
        run,
        attempt: planningAttempt,
        grant: planning.authorityGrant!,
        spec: planning.spec,
        call: {
          callId: "call-non-owner-update",
          name: "koni_update_working_spec",
          arguments: {
            expectedContextualRevision: approvedArtifact.contextual.revision,
            expectedCanonicalDigest: baseline.digest,
            guidance: "A non-owner must never advance canonical guidance.",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "working_spec_owner" });

    const ownerTicket = Object.values(run.tickets).find((ticket) =>
      ticket.steps.some((step) => step.personaId === "architecture-mapper"),
    );
    expect(ownerTicket).toBeDefined();
    const assignment = assignmentFor(run, ownerTicket!.id);
    const ownerPrepared = await program.prepareAttempt({
      kind: "ticket",
      run,
      assignment,
      attemptId: "attempt-context-owner",
      sessionId: "session-context-owner",
      nextAuthorityRevision: 3,
      expectedAuthorityStateHash: digest("context-owner-state"),
      lineage: { branchEpoch: 0, reason: "initial" },
    });
    expect(ownerPrepared.toolNames).toContain("koni_update_working_spec");
    await persistWrites(project.projectRoot, ownerPrepared.artifactWrites ?? []);
    const ownerAttempt = attemptRecord(ownerPrepared.spec, "ticket", "running");
    run.attempts[ownerAttempt.id] = ownerAttempt;
    const firstDynamic = await program.selectDynamicGraphContext({
      run,
      attempt: ownerAttempt,
      spec: ownerPrepared.spec,
    });
    const secondDynamic = await program.selectDynamicGraphContext({
      run,
      attempt: ownerAttempt,
      spec: ownerPrepared.spec,
    });
    expect(firstDynamic.envelopeHash).toBe(secondDynamic.envelopeHash);
    expect(program.dynamicContextCacheStats()).toMatchObject({ selections: 2, indexBuilds: 1 });

    const systemNode = (id: string, repositoryPath: string): GraphNode => ({
      schema_version: "1.0",
      id,
      type: "system",
      title: id,
      status: "active",
      spec: {
        kind: "app",
        responsibility: `Own ${id}`,
        contract_required: false,
        contract_reason: "Repository-local behavior is sufficient",
        owned_paths: [repositoryPath],
      },
      edges: {},
      annotations: {},
    });
    approvedArtifact.nodes["system-a-other"] = systemNode("system-a-other", "src/other.ts");
    approvedArtifact.nodes["system-z-touched"] = systemNode("system-z-touched", "src/touched.ts");
    approvedArtifact.graphSha256 = canonicalHash(approvedArtifact.nodes);
    approvedArtifact.semanticSha256 = approvedArtifact.graphSha256;
    run.graphHash = approvedArtifact.graphSha256;
    await writeFile(graphPath, `${JSON.stringify(approvedArtifact, null, 2)}\n`);

    const beforeTouch = await program.selectDynamicGraphContext({
      run,
      attempt: ownerAttempt,
      spec: ownerPrepared.spec,
    });
    const beforeTouchIds = beforeTouch.envelope.selection.selected.map((entry) => entry.id);
    expect(beforeTouchIds.indexOf("semantic_node:system-a-other")).toBeLessThan(
      beforeTouchIds.indexOf("semantic_node:system-z-touched"),
    );

    const receiptPath = `runs/${run.id}/attempts/${ownerAttempt.id}/tool-receipts/write-touched.json`;
    const receipt = {
      receiptId: "receipt-write-touched",
      summary: "Wrote src/touched.ts",
      value: { path: "src/touched.ts", sha256: digest("touched-bytes") },
    };
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
    const canonicalReceipt = canonicalEncode(receipt);
    await persistWrites(project.projectRoot, [
      { path: receiptPath, bytes: receiptBytes, expectedSha256: null },
    ]);
    ownerAttempt.authorityToolResults = [
      {
        sequence: 1,
        callId: "call-write-touched",
        toolName: "koni_write_file",
        outcome: "accepted",
        argumentsSha256: rawSha256("{}"),
        argumentsSizeBytes: 2,
        receiptSha256: rawSha256(canonicalReceipt),
        receiptSizeBytes: Buffer.byteLength(canonicalReceipt, "utf8"),
        artifactPath: receiptPath,
        recordedAt: FIXED_NOW.toISOString(),
      },
    ];
    const afterTouch = await program.selectDynamicGraphContext({
      run,
      attempt: ownerAttempt,
      spec: ownerPrepared.spec,
    });
    const afterTouchIds = afterTouch.envelope.selection.selected.map((entry) => entry.id);
    expect(afterTouchIds.indexOf("semantic_node:system-z-touched")).toBeLessThan(
      afterTouchIds.indexOf("semantic_node:system-a-other"),
    );
    expect(afterTouch.envelopeHash).not.toBe(beforeTouch.envelopeHash);
    expect(program.dynamicContextCacheStats()).toMatchObject({ selections: 4, indexBuilds: 2 });

    await expect(
      program.executeAgentTool({
        run,
        attempt: ownerAttempt,
        grant: ownerPrepared.authorityGrant!,
        spec: ownerPrepared.spec,
        call: {
          callId: "call-working-spec-scope-expansion",
          name: "koni_update_working_spec",
          arguments: {
            expectedContextualRevision: approvedArtifact.contextual.revision,
            expectedCanonicalDigest: baseline.digest,
            guidance: "Attempt an unauthorized semantic expansion.",
            affectedNodeIds: ["missing-node"],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "working_spec_scope" });

    const update = await program.executeAgentTool({
      run,
      attempt: ownerAttempt,
      grant: ownerPrepared.authorityGrant!,
      spec: ownerPrepared.spec,
      call: {
        callId: "call-working-spec-update",
        name: "koni_update_working_spec",
        arguments: {
          expectedContextualRevision: approvedArtifact.contextual.revision,
          expectedCanonicalDigest: baseline.digest,
          guidance:
            "Implement only the compiler-selected architecture boundary and verify its existing contract.",
        },
      },
    });
    await persistWrites(project.projectRoot, update.artifactWrites ?? []);
    const updated = JSON.parse(await readFile(graphPath, "utf8")) as typeof approvedArtifact;
    expect({ hash: updated.graphSha256, revision: updated.revision }).toEqual({
      hash: approvedArtifact.graphSha256,
      revision: approvedArtifact.revision,
    });
    expect(updated.contextual.revision).toBe(approvedArtifact.contextual.revision + 1);
    const current = updated.contextual.records[updated.contextual.canonicalWorkingSpecId]!;
    expect(current).toMatchObject({ version: 2, supersedes: baselineId });
    expect(current.baseline?.source).toEqual(baseline.baseline?.source);
    expect(updated.contextual.records[baselineId]).toBeDefined();
    const postUpdateDynamic = await program.selectDynamicGraphContext({
      run,
      attempt: ownerAttempt,
      spec: ownerPrepared.spec,
    });
    expect(postUpdateDynamic.envelope.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "working_spec",
          value: expect.objectContaining({
            version: 2,
            guidance: expect.stringContaining("compiler-selected"),
          }),
        }),
      ]),
    );
    expect(program.dynamicContextCacheStats()).toMatchObject({ selections: 5, indexBuilds: 3 });

    await expect(
      program.executeAgentTool({
        run,
        attempt: ownerAttempt,
        grant: ownerPrepared.authorityGrant!,
        spec: ownerPrepared.spec,
        call: {
          callId: "call-working-spec-stale",
          name: "koni_update_working_spec",
          arguments: {
            expectedContextualRevision: approvedArtifact.contextual.revision,
            expectedCanonicalDigest: baseline.digest,
            guidance: "This stale request must not commit.",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "working_spec_cas" });
    expect(JSON.parse(await readFile(graphPath, "utf8"))).toEqual(updated);
  });
});

type MutableConfigurationFixture = Record<string, unknown>;

function legacySoftwareConfigurationFixture(
  configuration: CompiledConfiguration,
  runTypeId: string,
): CompiledConfiguration {
  const legacy = structuredClone(configuration) as unknown as MutableConfigurationFixture;
  delete legacy.behavior;

  const packageIdentity = requiredMutableFixtureRecord(legacy.package, "package identity");
  packageIdentity.version = "0.7.0";
  packageIdentity.profile_version = "0.7.0";

  const profile = requiredMutableFixtureRecord(legacy.profile, "profile");
  profile.git = {
    enabled: true,
    backend: "libgit2",
    integration_branch: "current",
    ticket_branch_template: "koni/{{ run.id }}/{{ ticket.id }}",
    worktree_root: ".worktrees",
    integration_strategy: "squash",
    commit_template: "{{ ticket.operation }}: {{ ticket.title }}",
    ticket_worktree_setup_check: "ticket-worktree-setup",
  };
  profile.storage = {
    backend: "git_common_dir",
    graph_dir: "program/graph",
    tickets_dir: "program/tickets",
    state_path: "program/state.yaml",
    work_dir: "program/work",
    receipts_dir: "program/receipts",
    reports_dir: "program/reports",
    semantic_hash_excludes: [
      "annotations",
      "readiness",
      "obligations",
      "tickets",
      "receipts",
      "compiler",
    ],
    filesystem_scope_excludes: ["node_modules", "target", ".next", "coverage"],
  };
  const orchestration = requiredMutableFixtureRecord(profile.orchestration, "orchestration");
  orchestration.running = true;
  orchestration.lease_stale_seconds = 1_800;
  orchestration.max_fixpoint_passes = 8;

  const runTypes = requiredMutableFixtureRecord(legacy.run_types, "run types");
  const runType = requiredMutableFixtureRecord(runTypes[runTypeId], `run type ${runTypeId}`);
  const document = requiredMutableFixtureRecord(runType.document, `run type ${runTypeId} document`);
  const planning = requiredMutableFixtureRecord(document.planning, "planning");
  planning.session_scope = "run";
  planning.graph_seed_stage =
    runTypeId === "small"
      ? "focused-plan"
      : runTypeId === "large"
        ? "verification-plan"
        : "combined-plan";
  const intake = requiredMutableFixtureRecord(document.intake, "intake");
  delete intake.objective_field;
  document.git = {
    branch_template: "koni/runs/{{ run.slug }}-{{ run.short_id }}",
    ticket_branch_template: "koni/runs/{{ run.id }}/tickets/{{ ticket.id }}",
  };

  const registries = requiredMutableFixtureRecord(legacy.registries, "registries");
  const actions = requiredMutableFixtureRecord(registries.actions, "actions");
  const spawnLead = requiredMutableFixtureRecord(actions["spawn-lead"], "spawn-lead");
  if (!Array.isArray(spawnLead.recipe)) throw new Error("spawn-lead recipe is missing");
  const leadStep = spawnLead.recipe.find((candidate) => {
    const record =
      candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
        ? (candidate as MutableConfigurationFixture)
        : undefined;
    return record?.id === "lead";
  });
  requiredMutableFixtureRecord(leadStep, "Lead recipe step").prompt =
    "Operate the configured software Lead pull loop until compiler-verifiable terminal state.";

  delete legacy.configuration_sha256;
  legacy.configuration_sha256 = canonicalHash(legacy);
  return legacy as unknown as CompiledConfiguration;
}

function requiredMutableFixtureRecord(value: unknown, label: string): MutableConfigurationFixture {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as MutableConfigurationFixture;
}

async function installedProject(packageDirectory: "coding-profile" | "research-profile"): Promise<{
  root: string;
  projectRoot: string;
  baseline: VerifiedProfileBaseline;
  piInventory: PiResolvedInventory;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-native-program-"));
  temporaryRoots.push(root);
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot);
  git(projectRoot, ["init", "--initial-branch=main"]);
  git(projectRoot, ["config", "user.name", "Koni Test"]);
  git(projectRoot, ["config", "user.email", "koni@example.invalid"]);
  await writeFile(path.join(projectRoot, "README.md"), "# Fixture\n");
  git(projectRoot, ["add", "README.md"]);
  git(projectRoot, ["commit", "-m", "fixture"]);
  const sourcePackageRoot = path.resolve(repositoryRoot, "packages", packageDirectory);
  const packageRoot = path.join(root, "profile-package");
  await cp(sourcePackageRoot, packageRoot, { recursive: true });
  await refreshFixtureProfileManifest(packageRoot);
  const baseline = await loadProfilePackage(packageRoot);
  await installProfile(projectRoot, packageRoot);
  const piInventory = await fixturePiInventory(root);
  return { root, projectRoot, baseline, piInventory };
}

const FIXTURE_SUPERPOWERS_SKILLS = [
  "brainstorming",
  "dispatching-parallel-agents",
  "executing-plans",
  "finishing-a-development-branch",
  "receiving-code-review",
  "requesting-code-review",
  "subagent-driven-development",
  "systematic-debugging",
  "test-driven-development",
  "using-git-worktrees",
  "using-superpowers",
  "verification-before-completion",
  "writing-plans",
  "writing-skills",
] as const;

async function fixturePiInventory(root: string): Promise<PiResolvedInventory> {
  const fixtureRoot = path.join(root, "pi-inventory");
  const resources: PiResolvedInventory["resources"]["skills"][number][] = [];
  const addSkill = async (id: string, source: string, sourceRoot?: string): Promise<void> => {
    const target = path.join(fixtureRoot, id);
    if (sourceRoot === undefined) {
      await mkdir(target, { recursive: true });
      await writeFile(
        path.join(target, "SKILL.md"),
        `---\nname: ${id}\ndescription: Use when exercising the native run fixture.\n---\n# ${id}\n`,
      );
    } else {
      await cp(sourceRoot, target, { recursive: true });
    }
    const entrypoint = path.join(target, "SKILL.md");
    resources.push({
      kind: "skill",
      id,
      relativePath:
        source === "npm:@koni/core" ? `dist/skills/${id}/SKILL.md` : `skills/${id}/SKILL.md`,
      absolutePath: entrypoint,
      content: await readFile(entrypoint, "utf8"),
      source,
      scope: "project",
    });
  };
  for (const id of FIXTURE_SUPERPOWERS_SKILLS) {
    await addSkill(id, "git:github.com/obra/superpowers");
  }
  for (const id of ["configure-koni", "model-koni-work", "operate-koni"] as const) {
    await addSkill(id, "npm:@koni/core", path.resolve(repositoryRoot, "packages/core/skills", id));
  }
  resources.sort((left, right) => left.id.localeCompare(right.id));
  return {
    settings: {
      packages: ["git:github.com/obra/superpowers", "npm:@koni/core"],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    },
    resources: { skills: resources, extensions: [], prompts: [], themes: [], context: [] },
  };
}

async function refreshFixtureProfileManifest(packageRoot: string): Promise<void> {
  const manifestPath = path.join(packageRoot, "koni", "profile-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ProfilePackageManifest;
  const baselineRoot = path.join(packageRoot, "koni", "baseline");
  const files: ProfileBaselineFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
    )) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile())
        throw new Error(`fixture profile contains a non-regular entry: ${absolute}`);
      const relative = path.relative(baselineRoot, absolute).split(path.sep).join("/");
      const bytes = await readFile(absolute);
      files.push({
        path: relative,
        sha256: rawSha256(bytes),
        size_bytes: bytes.byteLength,
        kind: relative.startsWith("agents/")
          ? "agent"
          : relative.startsWith("resources/skills/")
            ? "skill"
            : /\.ya?ml$/u.test(relative)
              ? "config"
              : "other",
      });
    }
  };
  await visit(baselineRoot);
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  manifest.baseline.files = files;
  manifest.bundle_sha256 = computeProfileBundleSha256(files, manifest.migrations ?? []);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function compilerProgram(project: {
  projectRoot: string;
  baseline: VerifiedProfileBaseline;
  piInventory: PiResolvedInventory;
}): Promise<NativeRunCompilerProgram> {
  return NativeRunCompilerProgram.create({
    projectRoot: project.projectRoot,
    packageBaseline: project.baseline,
    piInventoryLoader: async () => project.piInventory,
    sealedModelBindingLoader: fixtureSealedModelBinding,
    now: () => new Date(FIXED_NOW),
  });
}

async function fixtureSealedModelBinding(provider: string, modelId: string) {
  return {
    provider,
    id: modelId,
    api: "openai-codex-responses",
    catalogContextWindow: 372_000,
    catalogMaxTokens: 128_000,
    catalogSha256: canonicalHash({ provider, modelId, fixture: "offline-model-catalog" }),
  } as const;
}

function runRecord(
  projectRoot: string,
  id: string,
  objective: string,
  resolved: Awaited<ReturnType<NativeRunCompilerProgram["resolveRun"]>>,
  intake: ConfigurationObject = { goal: objective },
): RunRecord {
  const lifecycle = reduceRunLifecycle(newRunLifecycle(id), {
    type: "planning_started",
    atMs: FIXED_NOW.getTime(),
  }).state;
  const run: RunRecord = {
    protocol: "koni.run-record.v1",
    id,
    revision: 1,
    generation: lifecycle.generation,
    projectRoot,
    profile: resolved.profile,
    compiledConfigHash: resolved.compiledConfigHash,
    runTypeId: resolved.runTypeId,
    planningMode: resolved.planningMode,
    behavior: resolved.behavior,
    objective,
    intake,
    executionConfig: resolved.executionConfig,
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    lifecycle,
    ...(resolved.lifecycleCatalog === undefined
      ? {}
      : { lifecycleCatalog: resolved.lifecycleCatalog }),
    pipelineStageIds: resolved.pipelineStageIds,
    currentPipelineStageId: resolved.pipelineStageIds.find((id) => id.includes("plan")),
    plan: undefined,
    graphRevision: 0,
    graphHash: undefined,
    tickets: {},
    attempts: {},
    questions: {},
    activity: [],
    git: fixtureRunGit(projectRoot, id),
  };
  materializeFixtureCheckout(projectRoot, run.git.planning.worktree);
  return run;
}

function answeredQuestion(): RunQuestionRecord {
  return {
    id: "question-product",
    attemptId: "attempt-before-disconnect",
    prompt: "Which storage boundary should the notes workflow use?",
    options: [
      {
        id: "local",
        label: "Use local-first storage",
        description: "Keep the first slice within the repository and browser.",
      },
    ],
    allowsNotes: true,
    askedAt: "2026-07-16T18:58:00.000Z",
    answeredAt: "2026-07-16T18:59:00.000Z",
    selectedOptionId: "local",
    notes: "Keep export reversible",
  };
}

function attemptRecord(
  spec: AgentLaunchSpec,
  kind: NonNullable<AgentAttemptRecord["kind"]>,
  status: AgentAttemptRecord["status"],
): AgentAttemptRecord {
  return {
    id: spec.identity.attemptId,
    sessionId: spec.identity.sessionId,
    ticketId: spec.identity.ticketId,
    stepId: spec.identity.stepId,
    personaId: spec.persona.id,
    modelProvider: spec.model.provider,
    modelId: spec.model.id,
    thinkingLevel: spec.model.thinkingLevel,
    status,
    launchSpecHash: spec.specHash,
    sessionFile: undefined,
    startedAt: FIXED_NOW.toISOString(),
    endedAt: undefined,
    terminalSummary: undefined,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    lineage: structuredClone(spec.lineage),
    authorityMessages: [],
    authorityToolResults: [],
    authorityCompactions: [],
    kind,
  };
}

function fixtureTerminalSuccessProof(
  input: Readonly<{
    runId: string;
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
    runId: input.runId,
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

function plannedAssetRepairProposalFixture(
  input: Readonly<{
    runId: string;
    proposalId: string;
    sourceTicketId: string;
    sourceStepId: string;
    targetNodeIds: string[];
    summary: string;
    reason: string;
    updatedAt: string;
  }>,
): TicketRecord {
  const requestSha256 = digest(`${input.proposalId}-request`);
  const sourceOutputSha256 = digest(`${input.proposalId}-output`);
  return {
    id: input.proposalId,
    title: `Change request: ${input.summary}`,
    summary: `${input.summary}\n\nReason: ${input.reason}`,
    status: "cancelled",
    blocker: "Superseded by the existing planned asset implementation workflow",
    targetNodeIds: input.targetNodeIds,
    updatedAt: input.updatedAt,
    steps: [],
    executionControl: {
      proposalRequest: {
        requestSha256,
        sourceTicketId: input.sourceTicketId,
        sourceStepId: input.sourceStepId,
        sourceOutputSha256,
        fulfillment: "planned_asset_repair",
      },
      controlTicketAuthority: {
        runId: input.runId,
        role: "proposal",
        ticketId: input.proposalId,
        causal: {
          role: "proposal",
          publication: {
            proposalTicketId: input.proposalId,
            requestSha256,
            sourceTicketId: input.sourceTicketId,
            sourceStepId: input.sourceStepId,
            sourceOutputSha256,
            targetNodeIds: input.targetNodeIds,
            summary: input.summary,
            reason: input.reason,
          },
          sourceTicketProjection: {
            id: input.sourceTicketId,
            operationId: "asset-resolution.asset.implement-asset",
            targetNodeIds: input.targetNodeIds,
          },
          sourceTerminalProof: fixtureTerminalSuccessProof({
            runId: input.runId,
            ticketId: input.sourceTicketId,
            stepId: input.sourceStepId,
            attemptId: `attempt-${input.proposalId}`,
            actionInvocationId: `action-${input.proposalId}`,
          }),
        },
      },
    },
  } as unknown as TicketRecord;
}

function fixtureTerminalFailureProof(
  input: Readonly<{
    runId: string;
    ticketId: string;
    stepId: string;
    attemptId: string;
    actionInvocationId: string;
    terminalPolicySha256: Sha256Digest;
    terminalOutputSha256: Sha256Digest;
  }>,
): TerminalFailureSettlementProof {
  const semanticResult = {
    kind: "assignment" as const,
    status: "failed" as const,
    blocker: "Exact configured source validation failed",
  };
  const material = {
    protocol: "koni.terminal-failure-settlement.v1" as const,
    runId: input.runId,
    ticketId: input.ticketId,
    stepId: input.stepId,
    attemptId: input.attemptId,
    actionInvocationId: input.actionInvocationId,
    actionPlanSha256: digest(`${input.actionInvocationId}-plan`),
    actionSettlementSha256: digest(`${input.actionInvocationId}-settlement`),
    semanticResult,
    semanticResultSha256: canonicalHash(semanticResult),
    terminalPolicySha256: input.terminalPolicySha256,
    terminalOutputSha256: input.terminalOutputSha256,
  };
  return { ...material, sha256: canonicalHash(material) };
}

function assignmentFor(run: RunRecord, ticketId: string): ReadyAssignment {
  const ticket = run.tickets[ticketId]!;
  const cycle = attachFixtureTicketCycle(run, ticket);
  materializeFixtureCheckout(run.git.run.worktree, cycle.worktree);
  const step = ticket.steps[0]!;
  return {
    runId: run.id,
    ticketId,
    stepId: step.id,
    personaId: step.personaId,
    priority: ticket.priority,
  };
}

function materializeApprovedFixtureRun(run: RunRecord): void {
  materializeFixtureCheckout(run.projectRoot, run.git.run.worktree);
  run.git.planning.status = "retired";
  run.git.planning.retiredAt ??= FIXED_NOW.toISOString();
  run.git.run.status = "ready";
  run.git.run.headOid = run.git.target.selectedOid;
  run.git.run.materializedAt ??= FIXED_NOW.toISOString();
}

function materializeFixtureCheckout(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    cpSync(path.join(source, entry.name), path.join(destination, entry.name), {
      recursive: true,
      force: true,
    });
  }
}

function planningOutput(
  rootSpec: Record<string, unknown>,
  nodes: unknown[] = [],
  edges: unknown[] = [],
): unknown {
  return {
    full: fullPlans(),
    concise: {
      architecture: [
        {
          title: "Notes ownership seam",
          description: "Ground the work in the smallest repository-native boundary.",
        },
      ],
      decisions: [
        {
          title: "Preserve compatibility",
          description: "Reuse the established contracts unless evidence requires a change.",
        },
      ],
      risk: [
        {
          title: "Bound the blast radius",
          description: "Keep mutation and recovery within the selected run scope.",
        },
      ],
      verification: [
        {
          title: "Prove the observable outcome",
          description: "Use the cheapest trustworthy repository-native verification seam.",
        },
      ],
    },
    graphSeed: { rootSpec, nodes, edges },
  };
}

function proofPreparationPlanningOutput(): unknown {
  return {
    ...(planningOutput({ work_kind: "new_feature" }) as Record<string, unknown>),
    graphSeed: {
      rootSpec: {
        work_kind: "new_feature",
        motivation: "Preserve an existing field while extending its behavior.",
        scope_boundaries: ["Only the fixture feature seam is in scope."],
        success_signals: ["The focused source proof turns from red to green."],
      },
      nodes: [
        {
          key: "fixture-system",
          type: "system",
          title: "Fixture system",
          spec: {
            kind: "app",
            responsibility: "Own the focused compatibility feature.",
            contract_required: true,
            contract_reason: "The existing field identity must remain stable.",
            owned_paths: ["src"],
            owned_packages: [],
          },
        },
        {
          key: "fixture-contract",
          type: "contract",
          title: "Backward-compatible field contract",
          spec: {
            invariant:
              "The legacy field identity remains available while the new behavior is added.",
            enforcement_point: "The exported fixture feature.",
            observability: "A focused source test exercises the production export.",
            failure_meaning: "Existing data would become unavailable.",
          },
        },
        {
          key: "fixture-change",
          type: "change",
          title: "Add the compatible field behavior",
          spec: {
            current_state: "Only the legacy behavior exists.",
            target_state: "The legacy identity and new behavior coexist.",
            owned_paths: ["src/feature.ts"],
            blast_radius: "One focused source module.",
            risk_factors: ["The legacy identity could be replaced."],
            proof_strategy: "red_green",
            risk_tier: "routine",
            approval_claim: "The focused behavior preserves compatibility.",
            commit_type: "feat(fixture)",
          },
        },
        {
          key: "fixture-proof",
          type: "proof",
          title: "Verify the compatible field behavior",
          spec: {
            purpose: "focused",
            layer: "unit",
            claim: "The production export preserves the legacy identity and adds the new behavior.",
            method: "Execute the focused repository-native source test.",
            command: ["node", "tests/feature.test.mjs"],
            working_directory: ".",
            baseline_check_id: "proof-expected-red",
            source_paths: ["tests/feature.test.mjs"],
            covered_paths: ["src/feature.ts"],
            support_paths: ["test-support/vitest.config.ts"],
            oracle_cases: [
              {
                id: "compatible_field",
                condition: "The legacy field exists before implementation.",
                claim: "The same production seam exposes both compatible behaviors.",
                production_seam: "The exported fixture feature",
                seam_paths: ["src/feature.ts"],
                action: "Import and exercise the production export.",
                assertions: [
                  "The legacy identity remains unchanged.",
                  "The new behavior is optional.",
                ],
              },
            ],
            conditions: ["The legacy behavior is present."],
            expected_signal: "The proof is red before implementation and green afterward.",
            not_proven: ["Unrelated repository behavior."],
            why: "This is the smallest trustworthy production seam.",
          },
        },
      ],
      edges: [
        { source: "$root", relation: "systems", target: "fixture-system" },
        { source: "$root", relation: "contracts", target: "fixture-contract" },
        { source: "fixture-change", relation: "realizes", target: "$root" },
        { source: "fixture-change", relation: "affects", target: "fixture-system" },
        { source: "fixture-change", relation: "affects", target: "fixture-contract" },
        { source: "fixture-contract", relation: "applies_to", target: "fixture-system" },
        { source: "fixture-proof", relation: "verifies", target: "fixture-change" },
        { source: "fixture-proof", relation: "verifies", target: "fixture-contract" },
        { source: "fixture-proof", relation: "uses", target: "fixture-system" },
      ],
    },
  };
}

function semanticTerminalPolicy(seed: string): NonNullable<AgentAttemptRecord["terminalPolicy"]> {
  const material = {
    protocol: "koni.agent-terminal-policy.v1" as const,
    mode: "semantic" as const,
    projectionSha256: digest(`${seed}-projection`),
    replayCompilationSha256: digest(`${seed}-replay`),
    receiptEvaluationSha256: digest(`${seed}-receipt`),
    sourcePreservationSha256s: [],
    acceptedAt: FIXED_NOW.toISOString(),
  };
  return { ...material, sha256: canonicalHash(material) };
}

function fullPlans(): Record<string, string> {
  return {
    architecture: "## Architecture\nGround the smallest repository-native boundary.",
    decisions: "## Decisions\nPreserve compatibility and reversible choices.",
    risk: "## Risk\nBound the blast radius and keep recovery explicit.",
    verification: "## Verification\nProve the observable outcome at its production seam.",
  };
}

async function persistWrites(
  projectRoot: string,
  writes: readonly TransactionWrite[],
): Promise<void> {
  const endpoint = await discoverAuthorityEndpoint(projectRoot);
  for (const write of writes) {
    const destination = path.join(endpoint.stateRoot, write.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, write.bytes);
  }
}

function digest(value: string): Sha256Digest {
  return canonicalHash(value);
}

function git(cwd: string, argv: string[]): string {
  const result = spawnSync("git", argv, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${argv.join(" ")} failed`);
  return result.stdout.trim();
}
