import { describe, expect, it } from "vitest";
import {
  decideBoundCheckRetry,
  type CheckExecutionPolicyBinding,
  type ExecutionPolicyBinding,
} from "../src/authority/execution-policy.js";
import { canonicalHash, rawSha256, type Sha256Digest } from "../src/shared/canonical.js";
import { newRunLifecycle, reduceRunLifecycle } from "../src/state/run-lifecycle.js";
import {
  assertRunExecutionControlMutation,
  assertRunRecord,
  type RunCheckAttemptRecord,
  type RunRecord,
  type TicketRecord,
} from "../src/state/run-record.js";
import { attachCanonicalProposalFixture } from "./fixtures/canonical-control-ticket.js";
import { fixtureRunGit } from "./run-record-fixtures.js";

const AT = "2026-07-18T00:00:00.000Z";

describe("terminal policy durable runtime records", () => {
  it("authenticates proposal decision provenance and rejects impossible approval combinations", async () => {
    const run = fixtureRun();
    const ticket = await attachCanonicalProposalFixture(run, {
      targetNodeId: "claim-a",
      summary: "Adjust the bounded claim contract",
      reason: "The exact source result exposed a scoped mismatch.",
    });
    const request = ticket.executionControl!.proposalRequest!;
    const decisionMaterial = {
      protocol: "koni.proposal-decision-authority.v2" as const,
      runId: run.id,
      proposalTicketId: ticket.id,
      requestSha256: request.requestSha256,
      eventId: "decision-event",
      decision: "approval" as const,
      actor: "operator",
      message: "Approved exact proposal",
      recordedAt: AT,
    };
    const decision = { ...decisionMaterial, sha256: canonicalHash(decisionMaterial) };
    ticket.executionControl = {
      ...ticket.executionControl,
      proposalDisposition: {
        kind: "approved",
        authoritySha256: decision.sha256,
      },
      proposalDecision: decision,
      proposalDecisionHistory: [decision],
      proposalApprovalSha256: decision.sha256,
    };
    expect(() => assertRunRecord(run)).not.toThrow();

    const drifted = structuredClone(run);
    drifted.tickets[ticket.id]!.executionControl!.proposalDecision!.actor = "ambient-user";
    expect(() => assertRunRecord(drifted)).toThrow(/proposal decision/u);

    const rejectedWithApproval = structuredClone(run);
    const rejectedMaterial = {
      ...decisionMaterial,
      eventId: "rejection-event",
      decision: "rejection" as const,
      recordedAt: "2026-07-18T00:00:01.000Z",
    };
    rejectedWithApproval.tickets[ticket.id]!.executionControl!.proposalDecision = {
      ...rejectedMaterial,
      sha256: canonicalHash(rejectedMaterial),
    };
    rejectedWithApproval.tickets[ticket.id]!.executionControl!.proposalDecisionHistory!.push(
      rejectedWithApproval.tickets[ticket.id]!.executionControl!.proposalDecision!,
    );
    rejectedWithApproval.tickets[ticket.id]!.executionControl!.proposalDisposition = {
      kind: "rejected",
      authoritySha256: digest("rejection-authority"),
    };
    expect(() => assertRunRecord(rejectedWithApproval)).toThrow(/retains approval authority/u);
  });

  it("authenticates automatic approval only through the proposal's exact configured policy", async () => {
    const run = fixtureRun();
    const proposal = await attachCanonicalProposalFixture(run, {
      targetNodeId: "claim-auto",
      summary: "Repair a pre-authorized proof contract",
      reason: "The current proof source cannot satisfy its approved oracle.",
      decisionPolicy: "automatic",
    });
    const control = proposal.executionControl!;
    const authority = control.controlTicketAuthority!;
    const request = control.proposalRequest!;
    const prior = structuredClone(run);
    const decisionMaterial = {
      protocol: "koni.proposal-decision-authority.v3" as const,
      runId: run.id,
      proposalTicketId: proposal.id,
      requestSha256: request.requestSha256,
      eventId: "automatic-proposal-decision",
      decision: "approval" as const,
      actor: "profile_policy" as const,
      policyAuthoritySha256: authority.sha256,
      message: "Automatically approved by the authenticated profile policy",
      recordedAt: AT,
    };
    const decision = { ...decisionMaterial, sha256: canonicalHash(decisionMaterial) };
    control.proposalDecision = decision;
    control.proposalDecisionHistory = [decision];
    control.proposalApprovalSha256 = decision.sha256;
    control.proposalDisposition = { kind: "approved", authoritySha256: decision.sha256 };
    proposal.status = "queued";

    expect(() => assertRunRecord(run)).not.toThrow();
    expect(() => assertRunExecutionControlMutation(prior, run)).not.toThrow();

    const forged = structuredClone(run);
    forged.tickets[proposal.id]!.executionControl!.proposalDecision!.policyAuthoritySha256 =
      digest("foreign-policy");
    const material = {
      ...forged.tickets[proposal.id]!.executionControl!.proposalDecision!,
    } as Record<string, unknown>;
    delete material.sha256;
    forged.tickets[proposal.id]!.executionControl!.proposalDecision!.sha256 =
      canonicalHash(material);
    forged.tickets[proposal.id]!.executionControl!.proposalDecisionHistory = [
      forged.tickets[proposal.id]!.executionControl!.proposalDecision!,
    ];
    forged.tickets[proposal.id]!.executionControl!.proposalApprovalSha256 =
      forged.tickets[proposal.id]!.executionControl!.proposalDecision!.sha256;
    forged.tickets[proposal.id]!.executionControl!.proposalDisposition = {
      kind: "approved",
      authoritySha256: forged.tickets[proposal.id]!.executionControl!.proposalDecision!.sha256,
    };
    expect(() => assertRunRecord(forged)).not.toThrow();
    expect(() => assertRunExecutionControlMutation(prior, forged)).toThrow(
      /proposal decision|policy authority/u,
    );
  });

  it("accepts and fail-closes the optional plan title, pending pause, and activity tone", () => {
    const run = fixtureRun();
    run.plan = {
      revision: 1,
      status: "approved",
      title: "Bounded Contract Adjustment",
      full: {},
      concise: {},
      graphSeed: undefined,
      steeringHistory: [],
    };
    run.pendingPause = { requestedAt: AT };
    run.activity.push({
      id: "activity-toned",
      at: AT,
      kind: "compiler",
      message: "Integrated ticket",
      ticketId: undefined,
      nodeId: undefined,
      tone: "success",
    });
    expect(() => assertRunRecord(run)).not.toThrow();

    const blankTitle = structuredClone(run);
    blankTitle.plan!.title = "   ";
    expect(() => assertRunRecord(blankTitle)).toThrow(/plan title/u);

    const badPause = structuredClone(run);
    badPause.pendingPause = { requestedAt: "" };
    expect(() => assertRunRecord(badPause)).toThrow(/pending-pause/u);

    const badTone = structuredClone(run);
    (badTone.activity.at(-1) as { tone: string }).tone = "loud";
    expect(() => assertRunRecord(badTone)).toThrow(/activity tone/u);

    const legacy = structuredClone(run);
    delete legacy.plan!.title;
    delete legacy.pendingPause;
    delete (legacy.activity.at(-1) as { tone?: string }).tone;
    expect(() => assertRunRecord(legacy)).not.toThrow();
  });

  it("rejects impossible cross-ticket control graphs and rewritten durable decision history", async () => {
    const run = fixtureRun();
    const proposal = await attachCanonicalProposalFixture(run, {
      targetNodeId: "claim-a",
      summary: "Adjust one exact claim",
      reason: "The source result requires bounded operator review.",
    });
    const request = proposal.executionControl!.proposalRequest!;
    const source = run.tickets[request.sourceTicketId]!;
    expect(() => assertRunRecord(run)).not.toThrow();

    const missingHold = structuredClone(run);
    delete missingHold.tickets[source.id]!.executionControl!.sourceHold;
    expect(() => assertRunRecord(missingHold)).toThrow(/exact held or released source/u);

    const decisionMaterial = {
      protocol: "koni.proposal-decision-authority.v2" as const,
      runId: run.id,
      proposalTicketId: proposal.id,
      requestSha256: request.requestSha256,
      eventId: "decision-one",
      decision: "approval" as const,
      actor: "operator",
      message: "Approve bounded change",
      recordedAt: AT,
    };
    const decision = { ...decisionMaterial, sha256: canonicalHash(decisionMaterial) };
    const decided = structuredClone(run);
    decided.tickets[proposal.id]!.executionControl!.proposalDecision = decision;
    decided.tickets[proposal.id]!.executionControl!.proposalDecisionHistory = [decision];
    decided.tickets[proposal.id]!.executionControl!.proposalApprovalSha256 = decision.sha256;
    decided.tickets[proposal.id]!.executionControl!.proposalDisposition = {
      kind: "approved",
      authoritySha256: decision.sha256,
    };
    expect(() => assertRunRecord(decided)).not.toThrow();
    expect(() => assertRunExecutionControlMutation(run, decided)).not.toThrow();

    const rewritten = structuredClone(decided);
    const replacementMaterial = { ...decisionMaterial, eventId: "replacement-decision" };
    const replacement = { ...replacementMaterial, sha256: canonicalHash(replacementMaterial) };
    rewritten.tickets[proposal.id]!.executionControl!.proposalDecision = replacement;
    rewritten.tickets[proposal.id]!.executionControl!.proposalDecisionHistory = [replacement];
    rewritten.tickets[proposal.id]!.executionControl!.proposalApprovalSha256 = replacement.sha256;
    rewritten.tickets[proposal.id]!.executionControl!.proposalDisposition = {
      kind: "approved",
      authoritySha256: replacement.sha256,
    };
    expect(() => assertRunRecord(rewritten)).not.toThrow();
    expect(() => assertRunExecutionControlMutation(decided, rewritten)).toThrow(
      /approval authority|decision authority|append-only/u,
    );
  });

  it("binds retries and exact source bytes into a current check receipt", () => {
    const run = fixtureRun();
    const binding = executionBinding();
    const policy = checkPolicy(binding);
    const ticket = fixtureTicket(binding);
    ticket.status = "running";
    ticket.steps[0]!.status = "running";
    ticket.steps[0]!.attemptIds = ["attempt-one"];
    run.tickets[ticket.id] = ticket;
    run.attempts["attempt-one"] = fixtureAttempt("running");

    const firstDecision = decideBoundCheckRetry(policy, {
      attemptNumber: 1,
      exitCode: 75,
      aggregateElapsedSeconds: 1,
    });
    const first = checkAttempt(policy, 1, 75, firstDecision, "first");
    const second = checkAttempt(policy, 2, 0, undefined, "second");
    const sourceEntries = [
      {
        path: "src/main.ts",
        kind: "file" as const,
        mode: 0o644,
        sizeBytes: 5,
        sha256: rawSha256("exact"),
      },
    ];
    const containedMaterial = {
      protocol: "koni.contained-path-manifest.v1" as const,
      roots: ["src"],
      entries: sourceEntries,
    };
    const sourceMaterial = {
      protocol: "koni.run-check-source-manifest.v1" as const,
      configurationSha256: policy.configurationSha256,
      catalogSha256: policy.catalogSha256,
      bindingSha256: policy.bindingSha256,
      checkSha256: policy.checkSha256,
      commandBindingSha256: digest("command-binding"),
      stepId: "work",
      roots: ["src"],
      entries: sourceEntries,
      manifestSha256: canonicalHash(containedMaterial),
      capturedAt: AT,
    };
    const sourceManifest = { ...sourceMaterial, sha256: canonicalHash(sourceMaterial) };
    run.checks = [
      {
        id: "check-record",
        attemptId: "attempt-one",
        callId: "call-one",
        requestedCheckId: "check-main",
        definitionHash: policy.checkSha256,
        kind: "command",
        executionPolicy: policy,
        accepted: true,
        passed: true,
        summary: "passed after one bound retry",
        commands: [
          {
            checkId: "check-main",
            definitionHash: policy.checkSha256,
            executionPolicy: policy,
            attempts: [first, second],
            sourceManifest,
            startedAt: second.startedAt,
            completedAt: second.completedAt!,
            resolvedExecutable: "/usr/bin/true",
            argv: ["/usr/bin/true"],
            environmentSha256: digest("environment"),
            exitCode: 0,
            signal: null,
            stdoutSha256: second.stdoutSha256!,
            stdoutSizeBytes: second.stdoutSizeBytes!,
            stdoutArtifactPath: second.stdoutArtifactPath!,
            stderrSha256: second.stderrSha256!,
            stderrSizeBytes: second.stderrSizeBytes!,
            stderrArtifactPath: second.stderrArtifactPath!,
            preManifestSha256: second.preManifestSha256,
            postManifestSha256: second.postManifestSha256!,
            sandboxKind: "seatbelt",
            sandboxProfileSha256: digest("sandbox"),
            resultSource: { kind: "stdout", bytesSha256: second.stdoutSha256!, sizeBytes: 0 },
            outputFiles: [],
          },
        ],
        evidenceSha256: digest("evidence"),
        evidenceSizeBytes: 2,
        evidenceArtifactPath: "runs/run-one/evidence.json",
        recordedAt: AT,
      },
    ];
    expect(() => assertRunRecord(run)).not.toThrow();

    const retryDrift = structuredClone(run);
    const retryDecision = retryDrift.checks![0]!.commands[0]!.attempts![0]!.retryDecision!;
    retryDrift.checks![0]!.commands[0]!.attempts![0]!.retryDecision = {
      ...retryDecision,
      backoffSeconds: 1,
    };
    expect(() => assertRunRecord(retryDrift)).toThrow(/attempt hash|retry decision hash/u);

    const byteDrift = structuredClone(run);
    const manifest = byteDrift.checks![0]!.commands[0]!.sourceManifest!;
    manifest.entries[0]!.sha256 = rawSha256("other");
    const { sha256: _old, ...changed } = manifest;
    manifest.sha256 = canonicalHash(changed);
    expect(() => assertRunRecord(byteDrift)).toThrow(/source byte manifest hash/u);
  });

  it("requires a self-hashed terminal closure under the accepted terminal timestamp", () => {
    const run = fixtureRun();
    const ticket = fixtureTicket();
    ticket.status = "running";
    ticket.steps[0]!.status = "running";
    ticket.steps[0]!.attemptIds = ["attempt-one"];
    run.tickets[ticket.id] = ticket;
    const attempt = fixtureAttempt("terminal_accepted");
    attempt.terminalAcceptedAt = AT;
    attempt.terminalOutputSha256 = rawSha256("{}");
    attempt.terminalOutputSizeBytes = 2;
    const material = {
      protocol: "koni.agent-terminal-policy.v1" as const,
      mode: "semantic" as const,
      projectionSha256: digest("projection"),
      replayCompilationSha256: digest("replay"),
      receiptEvaluationSha256: digest("receipts"),
      sourcePreservationSha256s: [digest("source-a"), digest("source-b")].sort(),
      acceptedAt: AT,
    };
    attempt.terminalPolicy = { ...material, sha256: canonicalHash(material) };
    run.attempts[attempt.id] = attempt;
    expect(() => assertRunRecord(run)).not.toThrow();

    const drifted = structuredClone(run);
    drifted.attempts[attempt.id]!.terminalPolicy!.acceptedAt = "2026-07-18T00:00:01.000Z";
    expect(() => assertRunRecord(drifted)).toThrow(
      /terminal policy hash|terminal policy settlement/u,
    );
  });

  it("binds an honest failed submission without claiming successful validation", () => {
    const run = fixtureRun();
    const ticket = fixtureTicket();
    ticket.status = "blocked";
    ticket.steps[0]!.status = "failed";
    ticket.steps[0]!.attemptIds = ["attempt-one"];
    run.tickets[ticket.id] = ticket;
    const attempt = fixtureAttempt("terminal_accepted");
    attempt.terminalAcceptedAt = AT;
    attempt.terminalOutputSha256 = rawSha256('{"status":"failed","blocker":"check setup failed"}');
    attempt.terminalOutputSizeBytes = 51;
    const material = {
      protocol: "koni.agent-terminal-policy.v1" as const,
      mode: "failed_submission" as const,
      acceptedAt: AT,
    };
    attempt.terminalPolicy = { ...material, sha256: canonicalHash(material) };
    run.attempts[attempt.id] = attempt;
    expect(() => assertRunRecord(run)).not.toThrow();

    const mislabeled = structuredClone(run);
    mislabeled.attempts[attempt.id]!.terminalPolicy!.mode = "legacy_pre_execution_policy";
    expect(() => assertRunRecord(mislabeled)).toThrow(/terminal policy hash/u);
  });
});

function fixtureRun(): RunRecord {
  let lifecycle = newRunLifecycle("run-one");
  lifecycle = reduceRunLifecycle(lifecycle, { type: "planning_started", atMs: 1 }).state;
  lifecycle = reduceRunLifecycle(lifecycle, { type: "plan_submitted", atMs: 2 }).state;
  lifecycle = reduceRunLifecycle(lifecycle, { type: "plan_approval_requested", atMs: 3 }).state;
  lifecycle = reduceRunLifecycle(lifecycle, { type: "plan_approved", atMs: 4 }).state;
  const git = fixtureRunGit("/project", "run-one", "approved");
  git.namespace.planningWorktree = `${git.namespace.root}/planning`;
  git.namespace.runWorktree = `${git.namespace.root}/integration`;
  git.namespace.ticketRoot = `${git.namespace.root}/tickets`;
  git.planning.worktree = git.namespace.planningWorktree;
  git.run.worktree = git.namespace.runWorktree;
  return {
    protocol: "koni.run-record.v1",
    id: "run-one",
    revision: 0,
    generation: 0,
    projectRoot: "/project",
    profile: {
      packageName: "@koni/coding-profile",
      packageVersion: "0.6.0",
      lineage: "koni.software",
      bundleHash: digest("bundle"),
    },
    compiledConfigHash: digest("config"),
    runTypeId: "medium",
    objective: "Test terminal policy",
    intake: { goal: "Test terminal policy" },
    createdAt: AT,
    updatedAt: AT,
    lifecycle,
    pipelineStageIds: ["planning", "approval", "orchestrate", "promotion"],
    currentPipelineStageId: "orchestrate",
    plan: undefined,
    graphRevision: 0,
    graphHash: undefined,
    tickets: {},
    attempts: {},
    questions: {},
    activity: [],
    git,
  };
}

function fixtureTicket(binding?: ExecutionPolicyBinding): TicketRecord {
  return {
    id: "ticket-one",
    operationId: "operation-main",
    title: "Ticket",
    summary: "Ticket",
    status: "queued",
    ...(binding === undefined ? {} : { executionPolicyBinding: binding }),
    priority: 0,
    dependencyIds: [],
    targetNodeIds: [],
    readPaths: ["src"],
    writePaths: ["src"],
    steps: [
      {
        id: "work",
        title: "Work",
        personaId: "worker",
        ...(binding === undefined ? {} : { executionPolicyBinding: binding }),
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
}

function fixtureAttempt(status: "running" | "terminal_accepted"): RunRecord["attempts"][string] {
  return {
    id: "attempt-one",
    sessionId: "session-one",
    ticketId: "ticket-one",
    stepId: "work",
    personaId: "worker",
    modelProvider: "openai-codex",
    modelId: "gpt-test",
    thinkingLevel: "medium",
    status,
    launchSpecHash: digest("launch"),
    sessionFile: undefined,
    startedAt: AT,
    endedAt: undefined,
    terminalSummary: undefined,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    kind: "ticket",
  };
}

function executionBinding(): ExecutionPolicyBinding {
  const contextMaterial = {
    outputContract: {
      text: "output",
      sha256: canonicalHash({ kind: "output_contract", text: "output" }),
    },
    reviewContract: {
      text: "review",
      sha256: canonicalHash({ kind: "review_contract", text: "review" }),
    },
    escalationTriggers: {
      values: [],
      sha256: canonicalHash({ kind: "escalation_triggers", values: [] }),
    },
    stopConditions: { values: [], sha256: canonicalHash({ kind: "stop_conditions", values: [] }) },
  };
  const context = { ...contextMaterial, sha256: canonicalHash(contextMaterial) };
  const material = {
    protocol: "koni.execution-policy-binding.v1" as const,
    configurationSha256: digest("configuration"),
    catalogSha256: digest("catalog"),
    operationId: "operation-main",
    operationSha256: digest("operation"),
    publicOperation: "operate",
    workflowId: "workflow-main",
    workflowVersion: "1.0.0",
    workflowSha256: digest("workflow"),
    stepId: "work",
    stepSha256: digest("step"),
    context,
  };
  return { ...material, sha256: canonicalHash(material) };
}

function checkPolicy(binding: ExecutionPolicyBinding): CheckExecutionPolicyBinding {
  return {
    configurationSha256: binding.configurationSha256,
    catalogSha256: binding.catalogSha256,
    bindingSha256: binding.sha256,
    checkId: "check-main",
    checkSha256: digest("check-main"),
    effect: "read_only",
    receiptType: "test-receipt",
    receiptFreshness: "current",
    composedReplay: "required",
    retryPolicy: { maxAttempts: 2, transientExitCodes: [75], backoffSeconds: [0] },
    gatePolicyContexts: [],
  };
}

function checkAttempt(
  policy: CheckExecutionPolicyBinding,
  attemptNumber: number,
  exitCode: number,
  retryDecision: RunCheckAttemptRecord["retryDecision"],
  suffix: string,
): RunCheckAttemptRecord {
  const material = {
    protocol: "koni.run-check-attempt.v1" as const,
    commandIndex: 0,
    attemptNumber,
    checkId: "check-main",
    definitionHash: policy.checkSha256,
    executionPolicy: policy,
    status: "completed" as const,
    startedAt: AT,
    preManifestSha256: digest(`pre-${suffix}`),
    completedAt: AT,
    aggregateElapsedSeconds: attemptNumber,
    postManifestSha256: digest(`post-${suffix}`),
    exitCode,
    signal: null,
    stdoutSha256: rawSha256(""),
    stdoutSizeBytes: 0,
    stdoutArtifactPath: `runs/run-one/${suffix}-stdout.bin`,
    stderrSha256: rawSha256(""),
    stderrSizeBytes: 0,
    stderrArtifactPath: `runs/run-one/${suffix}-stderr.bin`,
    ...(retryDecision === undefined ? {} : { retryDecision }),
  };
  return { ...material, sha256: canonicalHash(material) };
}

function digest(label: string): Sha256Digest {
  return rawSha256(label);
}
