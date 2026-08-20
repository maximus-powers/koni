import {
  canonicalHash,
  compareUtf8,
  isSha256Digest,
  type Sha256Digest,
} from "../shared/canonical.js";

import {
  type AgentAttemptRecord,
  type AgentTerminalPolicyRecord,
  type PlanningSynthesisRecord,
  type RunActionTerminalArchiveAuthority,
  type RunQuestionRecord,
  type RunRecord,
  type TicketExecutionControlRecord,
  type TicketStepRecord,
} from "./run-record-contracts.js";
export * from "./run-record-contracts.js";

export function assertImmutableControlField(
  ticketId: string,
  label: string,
  previous: unknown,
  next: unknown,
): void {
  if (previous !== undefined && canonicalHash(previous) !== canonicalHash(next)) {
    throw new Error(`ticket changed immutable ${label}: ${ticketId}`);
  }
}

export function assertAppendOnlyControlEvents(
  ticketId: string,
  label: string,
  previous: readonly unknown[],
  next: readonly unknown[],
): void {
  if (
    next.length < previous.length ||
    previous.some((event, index) => canonicalHash(event) !== canonicalHash(next[index]))
  ) {
    throw new Error(`ticket rewrote append-only ${label}: ${ticketId}`);
  }
}

export function assertCanonicalIdArray(values: readonly string[], label: string): void {
  assertUniqueIds(values, label);
  if (values.some((value, index) => index > 0 && compareUtf8(values[index - 1]!, value) >= 0)) {
    throw new Error(`noncanonical ${label}`);
  }
}

export function assertProposalDecisionEvent(
  ticketId: string,
  value: unknown,
): NonNullable<TicketExecutionControlRecord["proposalDecision"]> {
  const commonFields = [
    "protocol",
    "runId",
    "proposalTicketId",
    "requestSha256",
    "eventId",
    "decision",
    "actor",
    "message",
    "recordedAt",
    "sha256",
  ];
  if (
    !isRecord(value) ||
    !isId(value.eventId) ||
    (value.decision !== "approval" && value.decision !== "rejection") ||
    typeof value.actor !== "string" ||
    value.actor.trim().length === 0 ||
    (value.message !== undefined && typeof value.message !== "string") ||
    typeof value.recordedAt !== "string" ||
    value.recordedAt.length === 0 ||
    !isSha256Digest(value.sha256)
  ) {
    throw new Error(`invalid ticket proposal decision: ${ticketId}`);
  }
  const operatorAuthority =
    value.protocol === "koni.proposal-decision-authority.v2" &&
    value.actor === "operator" &&
    Object.keys(value).every((field) => commonFields.includes(field));
  const profilePolicyAuthority =
    value.protocol === "koni.proposal-decision-authority.v3" &&
    value.actor === "profile_policy" &&
    value.decision === "approval" &&
    isSha256Digest(value.policyAuthoritySha256) &&
    Object.keys(value).every(
      (field) => commonFields.includes(field) || field === "policyAuthoritySha256",
    );
  if (
    !isId(value.runId) ||
    !isId(value.proposalTicketId) ||
    !isSha256Digest(value.requestSha256) ||
    (!operatorAuthority && !profilePolicyAuthority)
  ) {
    throw new Error(`invalid current ticket proposal decision authority: ${ticketId}`);
  }
  const { sha256, ...material } = value;
  if (canonicalHash(material) !== sha256) {
    throw new Error(`invalid ticket proposal decision hash: ${ticketId}`);
  }
  return value as unknown as NonNullable<TicketExecutionControlRecord["proposalDecision"]>;
}

export function assertCanonicalDigestArray(values: readonly Sha256Digest[], label: string): void {
  if (
    new Set(values).size !== values.length ||
    values.some((value, index) => index > 0 && compareUtf8(values[index - 1]!, value) >= 0)
  ) {
    throw new Error(`noncanonical ${label}`);
  }
}

export function assertTicketStepGraph(ticketId: string, steps: readonly TicketStepRecord[]): void {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) throw new Error(`duplicate ticket step: ${ticketId}/${step.id}`);
    ids.add(step.id);
    assertUniqueIds(step.dependsOn ?? [], `ticket step dependencies: ${ticketId}/${step.id}`);
    assertUniqueIds(step.readNodeIds ?? [], `ticket step read nodes: ${ticketId}/${step.id}`);
    assertUniqueIds(step.writeNodeIds ?? [], `ticket step write nodes: ${ticketId}/${step.id}`);
    assertUniquePaths(step.readPaths ?? [], `ticket step read paths: ${ticketId}/${step.id}`);
    assertUniquePaths(step.writePaths ?? [], `ticket step write paths: ${ticketId}/${step.id}`);
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (!ids.has(dependency) || dependency === step.id) {
        throw new Error(`invalid ticket step dependency: ${ticketId}/${step.id} -> ${dependency}`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visit = (id: string): void => {
    if (visiting.has(id))
      throw new Error(`ticket step dependency cycle includes ${ticketId}/${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...ids].sort()) visit(id);
}

export function assertUniqueIds(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length || values.some((value) => !isId(value))) {
    throw new Error(`invalid or duplicate ${label}`);
  }
}

export function assertUniquePaths(values: readonly string[], label: string): void {
  if (
    new Set(values).size !== values.length ||
    values.some((value) => !isProjectRelativePath(value))
  ) {
    throw new Error(`invalid or duplicate ${label}`);
  }
}

export function isProjectRelativePath(value: string): boolean {
  return (
    value === "." ||
    (value.length > 0 &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value
        .split("/")
        .every((segment) => segment.length > 0 && segment !== "." && segment !== ".."))
  );
}

export function assertAttemptRecord(
  id: string,
  value: unknown,
): asserts value is AgentAttemptRecord {
  if (
    !isId(id) ||
    !isRecord(value) ||
    value.id !== id ||
    !isId(value.sessionId) ||
    !isId(value.ticketId) ||
    !isId(value.stepId) ||
    !isId(value.personaId) ||
    typeof value.status !== "string" ||
    ![
      "queued",
      "running",
      "waiting_question",
      "waiting_plan_review",
      "terminal_accepted",
      "completed",
      "failed",
      "aborted",
      "interrupted",
    ].includes(value.status) ||
    !isSha256Digest(value.launchSpecHash) ||
    (value.launchActionInvocationId !== undefined && !isId(value.launchActionInvocationId)) ||
    !isNonnegativeSafeInteger(value.inputTokens) ||
    !isNonnegativeSafeInteger(value.outputTokens) ||
    !isNonnegativeSafeInteger(value.cacheReadTokens) ||
    !isNonnegativeSafeInteger(value.cacheWriteTokens) ||
    (value.ticketExecutionEpoch !== undefined &&
      !isNonnegativeSafeInteger(value.ticketExecutionEpoch)) ||
    (value.kind !== undefined &&
      !["planning", "lead", "ticket", "verification", "integration"].includes(
        String(value.kind),
      )) ||
    (value.failureCode !== undefined && !isBoundedRecordText(value.failureCode, 128))
  )
    throw new Error(`invalid attempt record: ${id}`);

  if (value.tokenBudgetRecovery !== undefined) {
    if (!isRecord(value.tokenBudgetRecovery)) {
      throw new Error(`invalid attempt token-budget recovery: ${id}`);
    }
    const recovery = value.tokenBudgetRecovery;
    const expectedKeys = [
      "failedAttemptId",
      "protocol",
      "recoveredAt",
      "sha256",
      "stepId",
      "ticketId",
      ...(recovery.ticketExecutionEpoch === undefined ? [] : ["ticketExecutionEpoch"]),
      ...(recovery.reviewReworkOrdinal === undefined ? [] : ["reviewReworkOrdinal"]),
    ].sort();
    const material = {
      protocol: recovery.protocol,
      failedAttemptId: recovery.failedAttemptId,
      ticketId: recovery.ticketId,
      stepId: recovery.stepId,
      ...(recovery.ticketExecutionEpoch === undefined
        ? {}
        : { ticketExecutionEpoch: recovery.ticketExecutionEpoch }),
      ...(recovery.reviewReworkOrdinal === undefined
        ? {}
        : { reviewReworkOrdinal: recovery.reviewReworkOrdinal }),
      recoveredAt: recovery.recoveredAt,
    };
    if (
      recovery.protocol !== "koni.agent-token-budget-recovery.v1" ||
      recovery.failedAttemptId !== id ||
      recovery.ticketId !== value.ticketId ||
      recovery.stepId !== value.stepId ||
      Object.keys(recovery).sort().join("\0") !== expectedKeys.join("\0") ||
      (recovery.ticketExecutionEpoch !== undefined &&
        !isNonnegativeSafeInteger(recovery.ticketExecutionEpoch)) ||
      (recovery.reviewReworkOrdinal !== undefined &&
        (!isNonnegativeSafeInteger(recovery.reviewReworkOrdinal) ||
          recovery.reviewReworkOrdinal < 1)) ||
      typeof recovery.recoveredAt !== "string" ||
      recovery.recoveredAt.length === 0 ||
      !isSha256Digest(recovery.sha256) ||
      recovery.sha256 !== canonicalHash(material)
    ) {
      throw new Error(`invalid attempt token-budget recovery: ${id}`);
    }
  }

  if (
    (value.reviewedRunOid !== undefined &&
      (typeof value.reviewedRunOid !== "string" ||
        !/^[0-9a-f]{40,64}$/u.test(value.reviewedRunOid))) ||
    (value.reviewedTargetOid !== undefined &&
      (typeof value.reviewedTargetOid !== "string" ||
        !/^[0-9a-f]{40,64}$/u.test(value.reviewedTargetOid))) ||
    (value.reviewedGraphHash !== undefined && !isSha256Digest(value.reviewedGraphHash)) ||
    (value.verificationAccepted !== undefined &&
      (typeof value.verificationAccepted !== "boolean" || value.kind !== "verification"))
  )
    throw new Error(`invalid attempt review binding: ${id}`);

  if (value.terminalPolicy !== undefined) {
    assertAgentTerminalPolicyRecord(id, value.terminalPolicy);
    if (
      value.terminalAcceptedAt !== value.terminalPolicy.acceptedAt ||
      !["terminal_accepted", "completed", "interrupted"].includes(String(value.status))
    ) {
      throw new Error(`invalid attempt terminal policy settlement: ${id}`);
    }
  }

  if (value.lineage !== undefined) {
    if (
      !isRecord(value.lineage) ||
      !isNonnegativeSafeInteger(value.lineage.branchEpoch) ||
      !["initial", "retry", "rework", "review", "recovery", "integration"].includes(
        String(value.lineage.reason),
      ) ||
      (value.lineage.parentAttemptId !== undefined && !isId(value.lineage.parentAttemptId)) ||
      (value.lineage.parentSessionId !== undefined && !isId(value.lineage.parentSessionId)) ||
      (value.lineage.parentEntryId !== undefined &&
        !isBoundedRecordText(value.lineage.parentEntryId, 128)) ||
      (value.lineage.conversationFork !== undefined &&
        (!isRecord(value.lineage.conversationFork) ||
          !isSha256Digest(value.lineage.conversationFork.parentLaunchSpecHash) ||
          !isSha256Digest(value.lineage.conversationFork.parentTranscriptSha256) ||
          value.lineage.parentEntryId === undefined ||
          !["retry", "rework", "recovery"].includes(String(value.lineage.reason)))) ||
      (value.lineage.parentAttemptId === undefined) !==
        (value.lineage.parentSessionId === undefined)
    )
      throw new Error(`invalid attempt lineage: ${id}`);
  }
  assertOrderedAuthorityRecords(
    value.authorityMessages,
    (entry) =>
      isRecord(entry) &&
      (entry.mode === "steer" || entry.mode === "follow_up") &&
      isSha256Digest(entry.sha256) &&
      isNonnegativeSafeInteger(entry.sizeBytes) &&
      entry.sizeBytes > 0 &&
      typeof entry.artifactPath === "string" &&
      typeof entry.recordedAt === "string",
    `attempt authority messages: ${id}`,
  );
  if (value.planningSynthesis !== undefined) {
    const synthesis = value.planningSynthesis;
    if (value.kind !== "planning" || !isPlanningSynthesisRecord(synthesis))
      throw new Error(`invalid planning synthesis transition: ${id}`);
  }
  assertOrderedAuthorityRecords(
    value.authorityToolResults,
    (entry) =>
      isRecord(entry) &&
      typeof entry.callId === "string" &&
      entry.callId.length > 0 &&
      typeof entry.toolName === "string" &&
      entry.toolName.length > 0 &&
      (entry.outcome === "accepted" || entry.outcome === "rejected") &&
      isSha256Digest(entry.argumentsSha256) &&
      isNonnegativeSafeInteger(entry.argumentsSizeBytes) &&
      entry.argumentsSizeBytes > 0 &&
      isSha256Digest(entry.receiptSha256) &&
      isNonnegativeSafeInteger(entry.receiptSizeBytes) &&
      entry.receiptSizeBytes > 0 &&
      typeof entry.artifactPath === "string" &&
      typeof entry.recordedAt === "string",
    `attempt authority tool results: ${id}`,
  );
  assertOrderedAuthorityRecords(
    value.authorityCompactions,
    (entry) =>
      isRecord(entry) &&
      typeof entry.authorizationId === "string" &&
      entry.authorizationId.length > 0 &&
      isSha256Digest(entry.summaryHash) &&
      isNonnegativeSafeInteger(entry.summaryBytes) &&
      entry.summaryBytes > 0 &&
      typeof entry.firstKeptEntryId === "string" &&
      entry.firstKeptEntryId.length > 0 &&
      isNonnegativeSafeInteger(entry.tokensBefore) &&
      (entry.toolResultSequence === undefined ||
        isNonnegativeSafeInteger(entry.toolResultSequence)) &&
      typeof entry.recordedAt === "string",
    `attempt authority compactions: ${id}`,
  );
  assertProviderRequestRecords(id, value as unknown as AgentAttemptRecord);
  const hasTerminalDigest = value.terminalOutputSha256 !== undefined;
  const hasTerminalSize = value.terminalOutputSizeBytes !== undefined;
  const hasTerminalTime = value.terminalAcceptedAt !== undefined;
  if (
    hasTerminalDigest !== hasTerminalSize ||
    hasTerminalDigest !== hasTerminalTime ||
    (hasTerminalDigest &&
      (!isSha256Digest(value.terminalOutputSha256) ||
        !isNonnegativeSafeInteger(value.terminalOutputSizeBytes) ||
        value.terminalOutputSizeBytes === 0 ||
        typeof value.terminalAcceptedAt !== "string")) ||
    (value.status === "terminal_accepted" && !hasTerminalDigest)
  )
    throw new Error(`invalid attempt terminal acceptance: ${id}`);
}

/**
 * The terminal-output digest proves durable provider-output admission. `terminalPolicy` separately
 * proves compiler-authenticated semantic closure; configured validation deliberately has a durable
 * interval where the former exists and the latter does not. Every such assignment remains bound to
 * exactly one validation action. An admitted-then-interrupted attempt is legal only when a stop
 * CAS abandoned that exact action. The interrupted attempt and abandoned action are immutable
 * history, so they remain legal after a later resume; they can never be reopened as current work.
 */
export function assertInterruptedTerminalAcceptanceSettlement(run: Readonly<RunRecord>): void {
  const archivedAuthorities = terminalArchiveAuthorities(run);
  const archivedByAttempt = new Map(
    archivedAuthorities.map((authority) => [authority.attemptId, authority] as const),
  );
  for (const attempt of Object.values(run.attempts)) {
    if (attempt.terminalOutputSha256 === undefined) continue;
    const step = run.tickets[attempt.ticketId]?.steps.find(
      (candidate) => candidate.id === attempt.stepId,
    );
    if (step?.validationAction === undefined) continue;
    const actions = Object.values(run.actionExecutions ?? {}).filter(
      (action) =>
        action.boundary.kind === "assignment_validation" &&
        action.boundary.attemptId === attempt.id &&
        action.boundary.ticketId === attempt.ticketId &&
        action.boundary.stepId === attempt.stepId,
    );
    const archivedCandidate = archivedByAttempt.get(attempt.id);
    const archived =
      archivedCandidate?.ticketId === attempt.ticketId &&
      archivedCandidate.stepId === attempt.stepId
        ? [archivedCandidate]
        : [];
    if (actions.length + archived.length !== 1) {
      const unprojectedLegacyArchive =
        (run.actionExecutionArchive ?? []).some(
          (row) =>
            row.protocol === "koni.run-action-archive.v1" && row.terminalAuthority === undefined,
        ) ||
        (run.actionExecutionArchiveSegments ?? []).some(
          (segment) =>
            segment.protocol === "koni.run-action-archive-segment.v1" &&
            segment.terminalAuthorities === undefined,
        );
      if (actions.length === 0 && archived.length === 0 && unprojectedLegacyArchive) {
        throw new Error(
          `legacy terminal action archive requires authenticated projection migration: ${attempt.id}`,
        );
      }
      throw new Error(`terminal acceptance lacks exact validation action: ${attempt.id}`);
    }
    const action = actions[0];
    const archive = archived[0];
    if (
      archive !== undefined &&
      (archive.terminalOutputSha256 !== attempt.terminalOutputSha256 ||
        archive.terminalPolicySha256 !== attempt.terminalPolicy?.sha256)
    ) {
      throw new Error(`archived validation action differs from terminal attempt: ${attempt.id}`);
    }
    if (
      attempt.status === "terminal_accepted" &&
      attempt.terminalPolicy === undefined &&
      (action?.settledAt !== undefined || archive !== undefined)
    ) {
      throw new Error(
        `pending terminal policy has an already-settled validation action: ${attempt.id}`,
      );
    }
    const successProofs = Object.values(run.terminalSuccessProofs ?? {}).filter(
      (proof) => proof.attemptId === attempt.id,
    );
    const failureProofs = Object.values(run.terminalFailureProofs ?? {}).filter(
      (proof) => proof.attemptId === attempt.id,
    );
    if (attempt.status === "interrupted") {
      if (
        action !== undefined &&
        (action.settledAt === undefined || action.settlement?.disposition !== "abandoned")
      ) {
        throw new Error(
          `interrupted terminal acceptance lacks exact abandoned action: ${attempt.id}`,
        );
      }
      if (archive !== undefined && archive.settlementDisposition !== "abandoned") {
        throw new Error(
          `interrupted terminal acceptance lacks exact archived abandonment: ${attempt.id}`,
        );
      }
      if (
        step !== undefined &&
        step.attemptIds.at(-1) === attempt.id &&
        step.status !== "pending" &&
        step.status !== "skipped"
      ) {
        throw new Error(`interrupted terminal acceptance remains current work: ${attempt.id}`);
      }
      if (successProofs.length !== 0 || failureProofs.length !== 0) {
        throw new Error(`abandoned terminal acceptance retains a terminal proof: ${attempt.id}`);
      }
      continue;
    }
    if (attempt.status === "terminal_accepted") continue;
    if (successProofs.length + failureProofs.length !== 1) {
      throw new Error(`settled terminal acceptance lacks one exact semantic proof: ${attempt.id}`);
    }
    const proof = successProofs[0] ?? failureProofs[0]!;
    const disposition = proof.semanticResult.status === "completed" ? "completed" : "failed";
    if (
      action !== undefined &&
      (action.settledAt === undefined ||
        action.settlement?.disposition !== disposition ||
        action.invocationId !== proof.actionInvocationId ||
        action.plan.sha256 !== proof.actionPlanSha256 ||
        action.settlement.sha256 !== proof.actionSettlementSha256)
    ) {
      throw new Error(`settled terminal acceptance differs from validation action: ${attempt.id}`);
    }
    if (
      archive !== undefined &&
      (archive.settlementDisposition !== disposition ||
        archive.invocationId !== proof.actionInvocationId ||
        archive.actionPlanSha256 !== proof.actionPlanSha256 ||
        archive.actionSettlementSha256 !== proof.actionSettlementSha256 ||
        archive.terminalProofSha256 !== proof.sha256)
    ) {
      throw new Error(
        `settled terminal acceptance differs from archived validation action: ${attempt.id}`,
      );
    }
  }
}

export function terminalArchiveAuthorities(
  run: Readonly<RunRecord>,
): RunActionTerminalArchiveAuthority[] {
  const authorities = [
    ...(run.actionExecutionArchive ?? []).flatMap((row) =>
      row.terminalAuthority === undefined ? [] : [row.terminalAuthority],
    ),
    ...(run.actionExecutionArchiveSegments ?? []).flatMap(
      (segment) => segment.terminalAuthorities ?? [],
    ),
  ];
  const attempts = new Set<string>();
  const invocations = new Set<string>();
  for (const authority of authorities) {
    if (
      authority.runId !== run.id ||
      attempts.has(authority.attemptId) ||
      invocations.has(authority.invocationId)
    ) {
      throw new Error("run action archive repeats or misbinds terminal authority");
    }
    attempts.add(authority.attemptId);
    invocations.add(authority.invocationId);
  }
  return authorities;
}

export function assertAgentTerminalPolicyRecord(
  attemptId: string,
  value: unknown,
): asserts value is AgentTerminalPolicyRecord {
  if (
    !isRecord(value) ||
    value.protocol !== "koni.agent-terminal-policy.v1" ||
    (value.mode !== "legacy_pre_execution_policy" &&
      value.mode !== "failed_submission" &&
      value.mode !== "semantic" &&
      value.mode !== "semantic_upstream_change_control") ||
    typeof value.acceptedAt !== "string" ||
    value.acceptedAt.length === 0 ||
    !isSha256Digest(value.sha256)
  ) {
    throw new Error(`invalid attempt terminal policy: ${attemptId}`);
  }
  const semantic = value.mode === "semantic" || value.mode === "semantic_upstream_change_control";
  const allowed = semantic
    ? new Set([
        "protocol",
        "mode",
        ...(value.mode === "semantic_upstream_change_control" ? ["changeControlSha256"] : []),
        "projectionSha256",
        "replayCompilationSha256",
        "receiptEvaluationSha256",
        "sourcePreservationSha256s",
        "acceptedAt",
        "sha256",
      ])
    : new Set(["protocol", "mode", "acceptedAt", "sha256"]);
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    throw new Error(`invalid attempt terminal policy field: ${attemptId}`);
  }
  if (semantic) {
    if (
      (value.mode === "semantic_upstream_change_control" &&
        !isSha256Digest(value.changeControlSha256)) ||
      !isSha256Digest(value.projectionSha256) ||
      !isSha256Digest(value.replayCompilationSha256) ||
      !isSha256Digest(value.receiptEvaluationSha256) ||
      !Array.isArray(value.sourcePreservationSha256s) ||
      value.sourcePreservationSha256s.some((digest) => !isSha256Digest(digest))
    ) {
      throw new Error(`invalid semantic terminal policy: ${attemptId}`);
    }
    assertCanonicalDigestArray(
      value.sourcePreservationSha256s as Sha256Digest[],
      `attempt source-preservation receipts: ${attemptId}`,
    );
  }
  const { sha256, ...material } = value;
  if (canonicalHash(material) !== sha256) {
    throw new Error(`invalid attempt terminal policy hash: ${attemptId}`);
  }
}

export function assertQuestionRecord(
  id: string,
  value: unknown,
  attempts: Readonly<Record<string, AgentAttemptRecord>>,
): asserts value is RunQuestionRecord {
  if (
    !isId(id) ||
    !isRecord(value) ||
    value.id !== id ||
    !isId(value.attemptId) ||
    attempts[value.attemptId] === undefined ||
    typeof value.prompt !== "string" ||
    value.prompt.length === 0 ||
    value.prompt.includes("\0") ||
    Buffer.byteLength(value.prompt, "utf8") > 1024 * 1024 ||
    // Pre-Pi-native imported records may contain one-option acknowledgements. New questions are
    // still compiler-validated to require two to eight meaningful choices.
    !Array.isArray(value.options) ||
    value.options.length < 1 ||
    value.options.length > 8 ||
    typeof value.allowsNotes !== "boolean" ||
    typeof value.askedAt !== "string" ||
    value.askedAt.length === 0 ||
    (value.answeredAt !== undefined && typeof value.answeredAt !== "string") ||
    (value.selectedOptionId !== undefined && typeof value.selectedOptionId !== "string") ||
    (value.batchId !== undefined && !isId(value.batchId)) ||
    (value.scope !== undefined && value.scope !== "run" && value.scope !== "ticket") ||
    (value.scope === undefined && value.ticketId !== undefined) ||
    (value.scope === "run" && value.ticketId !== undefined) ||
    (value.scope === "ticket" &&
      (!isId(value.ticketId) || value.ticketId !== attempts[value.attemptId]!.ticketId)) ||
    (value.batchPosition !== undefined &&
      (!isNonnegativeSafeInteger(value.batchPosition) || value.batchPosition < 1)) ||
    (value.batchSize !== undefined &&
      (!isNonnegativeSafeInteger(value.batchSize) || value.batchSize < 1 || value.batchSize > 8)) ||
    (value.batchPosition === undefined) !== (value.batchSize === undefined) ||
    (value.batchPosition !== undefined &&
      value.batchSize !== undefined &&
      value.batchPosition > value.batchSize) ||
    (value.recommendationOptionId !== undefined &&
      typeof value.recommendationOptionId !== "string") ||
    (value.impact !== undefined && value.impact !== "routine" && value.impact !== "high_impact") ||
    (value.answerSource !== undefined &&
      value.answerSource !== "operator" &&
      value.answerSource !== "configured_recommendation") ||
    (value.answerRevision !== undefined &&
      (!isNonnegativeSafeInteger(value.answerRevision) || value.answerRevision < 1)) ||
    (value.notes !== undefined &&
      (typeof value.notes !== "string" ||
        value.notes.includes("\0") ||
        Buffer.byteLength(value.notes, "utf8") > 64 * 1024))
  )
    throw new Error(`invalid run question: ${id}`);
  const optionIds = new Set<string>();
  for (const option of value.options) {
    if (
      !isRecord(option) ||
      !isId(option.id) ||
      optionIds.has(option.id) ||
      typeof option.label !== "string" ||
      option.label.length === 0 ||
      option.label.includes("\0") ||
      Buffer.byteLength(option.label, "utf8") > 16 * 1024 ||
      typeof option.description !== "string" ||
      option.description.length === 0 ||
      option.description.includes("\0") ||
      Buffer.byteLength(option.description, "utf8") > 64 * 1024
    )
      throw new Error(`invalid run question option: ${id}`);
    optionIds.add(option.id);
  }
  if (value.selectedOptionId !== undefined && !optionIds.has(value.selectedOptionId)) {
    throw new Error(`run question selected option does not exist: ${id}`);
  }
  if (value.recommendationOptionId !== undefined && !optionIds.has(value.recommendationOptionId)) {
    throw new Error(`run question recommendation does not exist: ${id}`);
  }
  if (
    value.answerSource === "configured_recommendation" &&
    (value.recommendationOptionId === undefined ||
      value.selectedOptionId !== value.recommendationOptionId ||
      value.notes !== undefined)
  )
    throw new Error(`run question automatic answer differs from its recommendation: ${id}`);
  if (
    value.answeredAt !== undefined &&
    value.selectedOptionId === undefined &&
    (value.notes === undefined || value.notes.trim().length === 0)
  ) {
    throw new Error(`answered run question has no answer: ${id}`);
  }
}

export function assertAttemptLineageForest(
  attempts: Readonly<Record<string, AgentAttemptRecord>>,
): void {
  const sessionIds = new Set<string>();
  for (const attempt of Object.values(attempts)) {
    if (sessionIds.has(attempt.sessionId)) {
      throw new Error(`attempt Pi session identity is reused: ${attempt.sessionId}`);
    }
    sessionIds.add(attempt.sessionId);
  }
  for (const attempt of Object.values(attempts)) {
    const lineage = attempt.lineage;
    if (lineage === undefined) continue;
    const parentId = lineage.parentAttemptId;
    if (parentId === undefined) {
      if (
        lineage.branchEpoch !== 0 ||
        (lineage.reason !== "initial" && lineage.reason !== "recovery")
      ) {
        throw new Error(`root attempt lineage is invalid: ${attempt.id}`);
      }
      continue;
    }
    const parent = attempts[parentId];
    if (parent === undefined || parent.sessionId !== lineage.parentSessionId) {
      throw new Error(`attempt lineage parent is missing or mismatched: ${attempt.id}`);
    }
    const parentEpoch = parent.lineage?.branchEpoch ?? 0;
    if (lineage.branchEpoch !== parentEpoch + 1) {
      throw new Error(`attempt lineage epoch is not sequential: ${attempt.id}`);
    }
    if (lineage.reason === "review" && attempt.ticketId !== parent.ticketId) {
      throw new Error(`review attempt lineage crosses ticket scope: ${attempt.id}`);
    }
    if (
      new Set(["retry", "rework", "recovery"]).has(lineage.reason) &&
      (attempt.ticketId !== parent.ticketId || attempt.stepId !== parent.stepId)
    )
      throw new Error(`replacement attempt lineage crosses step scope: ${attempt.id}`);
  }
}

export function assertProviderRequestRecords(id: string, attempt: AgentAttemptRecord): void {
  const records = attempt.authorityProviderRequests;
  const baseline = attempt.authorityProviderUsageBaseline;
  if (records === undefined) {
    if (baseline !== undefined) throw new Error(`orphaned attempt provider baseline: ${id}`);
    return;
  }
  if (!Array.isArray(records) || records.length > 100_000) {
    throw new Error(`invalid attempt provider requests: ${id}`);
  }
  if (
    baseline !== undefined &&
    (!isRecord(baseline) ||
      !isNonnegativeSafeInteger(baseline.inputTokens) ||
      !isNonnegativeSafeInteger(baseline.outputTokens) ||
      !isNonnegativeSafeInteger(baseline.cacheReadTokens) ||
      !isNonnegativeSafeInteger(baseline.cacheWriteTokens) ||
      typeof baseline.recordedAt !== "string")
  )
    throw new Error(`invalid attempt provider baseline: ${id}`);
  let input = baseline?.inputTokens ?? 0;
  let output = baseline?.outputTokens ?? 0;
  let cacheRead = baseline?.cacheReadTokens ?? 0;
  let cacheWrite = baseline?.cacheWriteTokens ?? 0;
  let unresolved = false;
  for (const [index, entry] of records.entries()) {
    if (
      !isRecord(entry) ||
      entry.sequence !== index + 1 ||
      !isId(entry.reservationId) ||
      !isBoundedRecordText(entry.api, 256) ||
      !isBoundedRecordText(entry.modelId, 512) ||
      !isSha256Digest(entry.payloadSha256) ||
      !isNonnegativeSafeInteger(entry.payloadSizeBytes) ||
      entry.payloadSizeBytes === 0 ||
      !isBoundedRecordText(entry.baselineEntryId, 128) ||
      !isNonnegativeSafeInteger(entry.prospectiveInputTokens) ||
      entry.prospectiveInputTokens === 0 ||
      !isNonnegativeSafeInteger(entry.reservedOutputTokens) ||
      entry.reservedOutputTokens === 0 ||
      typeof entry.reservedAt !== "string" ||
      (entry.serializedOutputCap !== undefined &&
        (!isRecord(entry.serializedOutputCap) ||
          !isBoundedRecordText(entry.serializedOutputCap.path, 256) ||
          !entry.serializedOutputCap.path.startsWith("/") ||
          !isNonnegativeSafeInteger(entry.serializedOutputCap.value) ||
          entry.serializedOutputCap.value === 0 ||
          entry.serializedOutputCap.value !== entry.reservedOutputTokens))
    )
      throw new Error(`invalid attempt provider request: ${id}`);
    const settlement = [
      entry.assistantEntryId,
      entry.assistantEntrySha256,
      entry.inputTokens,
      entry.outputTokens,
      entry.cacheReadTokens,
      entry.cacheWriteTokens,
      entry.settledAt,
    ];
    const settled = settlement.every((field) => field !== undefined);
    if (!settled && settlement.some((field) => field !== undefined)) {
      throw new Error(`partial attempt provider settlement: ${id}`);
    }
    if (entry.retirement !== undefined) {
      const retirement = entry.retirement;
      if (
        settled ||
        !isRecord(retirement) ||
        retirement.protocol !== "koni.provider-exposure-retirement.v1" ||
        !new Set([
          "operator_acknowledged_canonical_abort",
          "operator_acknowledged_provider_error",
          "operator_acknowledged_authority_pause",
          "operator_acknowledged_unreconciled_request",
        ]).has(String(retirement.disposition)) ||
        !isSha256Digest(retirement.authorizationSha256) ||
        typeof retirement.retiredAt !== "string" ||
        !isSha256Digest(retirement.sha256)
      )
        throw new Error(`invalid attempt provider exposure retirement: ${id}`);
      if (
        retirement.disposition === "operator_acknowledged_authority_pause"
          ? !isSha256Digest(retirement.pauseReasonSha256)
          : retirement.disposition === "operator_acknowledged_unreconciled_request"
            ? !isSha256Digest(retirement.failureReasonSha256)
            : !isBoundedRecordText(retirement.assistantEntryId, 128) ||
              !isSha256Digest(retirement.assistantEntrySha256) ||
              !isBoundedRecordText(retirement.responseId, 512) ||
              (retirement.disposition === "operator_acknowledged_provider_error"
                ? !isSha256Digest(retirement.errorMessageSha256)
                : retirement.errorMessageSha256 !== undefined)
      )
        throw new Error(`invalid attempt provider exposure retirement fields: ${id}`);
      const { sha256, ...material } = retirement;
      if (canonicalHash(material) !== sha256) {
        throw new Error(`invalid attempt provider exposure retirement identity: ${id}`);
      }
      continue;
    }
    if (!settled) {
      if (unresolved || index !== records.length - 1) {
        throw new Error(`invalid unresolved attempt provider request: ${id}`);
      }
      unresolved = true;
      continue;
    }
    if (
      !isBoundedRecordText(entry.assistantEntryId, 128) ||
      !isSha256Digest(entry.assistantEntrySha256) ||
      !isNonnegativeSafeInteger(entry.inputTokens) ||
      !isNonnegativeSafeInteger(entry.outputTokens) ||
      !isNonnegativeSafeInteger(entry.cacheReadTokens) ||
      !isNonnegativeSafeInteger(entry.cacheWriteTokens) ||
      typeof entry.settledAt !== "string" ||
      entry.outputTokens > entry.reservedOutputTokens
    )
      throw new Error(`invalid settled attempt provider request: ${id}`);
    if (
      checkedRecordSum(entry.inputTokens, entry.cacheReadTokens, entry.cacheWriteTokens) >
      entry.prospectiveInputTokens
    )
      throw new Error(`settled attempt provider prompt usage exceeds reservation: ${id}`);
    input = checkedRecordSum(input, entry.inputTokens);
    output = checkedRecordSum(output, entry.outputTokens);
    cacheRead = checkedRecordSum(cacheRead, entry.cacheReadTokens);
    cacheWrite = checkedRecordSum(cacheWrite, entry.cacheWriteTokens);
  }
  if (
    input !== attempt.inputTokens ||
    output !== attempt.outputTokens ||
    cacheRead !== attempt.cacheReadTokens ||
    cacheWrite !== attempt.cacheWriteTokens
  )
    throw new Error(`attempt provider usage does not match durable totals: ${id}`);
}

export function checkedRecordSum(...values: number[]): number {
  const value = values.reduce((sum, next) => sum + next, 0);
  if (!Number.isSafeInteger(value)) throw new Error("attempt provider usage exceeds safe range");
  return value;
}

export function isBoundedRecordText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export function assertOrderedAuthorityRecords(
  value: unknown,
  validate: (entry: unknown) => boolean,
  label: string,
): void {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.length > 100_000 ||
    value.some(
      (entry, index) => !validate(entry) || !isRecord(entry) || entry.sequence !== index + 1,
    )
  )
    throw new Error(`invalid ${label}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

export function isPlanningSynthesisRecord(value: unknown): value is PlanningSynthesisRecord {
  return (
    isRecord(value) &&
    value.protocol === "koni.planning-synthesis.v1" &&
    isNonnegativeSafeInteger(value.thresholdNewTokens) &&
    value.thresholdNewTokens > 0 &&
    isNonnegativeSafeInteger(value.limitNewTokens) &&
    value.limitNewTokens > value.thresholdNewTokens &&
    isNonnegativeSafeInteger(value.reserveNewTokens) &&
    value.reserveNewTokens === value.limitNewTokens - value.thresholdNewTokens &&
    (value.triggerReason === undefined) === (value.triggeredNewTokens === undefined) &&
    (value.triggerReason === undefined ||
      value.triggerReason === "token_threshold" ||
      value.triggerReason === "provider_input_pressure") &&
    (value.triggeredNewTokens === undefined ||
      isNonnegativeSafeInteger(value.triggeredNewTokens)) &&
    isSha256Digest(value.instructionSha256) &&
    isNonnegativeSafeInteger(value.instructionSizeBytes) &&
    value.instructionSizeBytes > 0 &&
    typeof value.instructionArtifactPath === "string" &&
    value.instructionArtifactPath.length > 0 &&
    typeof value.triggeredAt === "string" &&
    value.triggeredAt.length > 0
  );
}
