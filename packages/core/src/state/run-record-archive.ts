import { validateActionExecutionJournal } from "../compiler/action-recipes.js";
import type { ActionExecutionJournal, ActionExecutionPlan } from "../contracts/behavior.js";
import { canonicalHash, isSha256Digest, rawSha256 } from "../shared/canonical.js";

import {
  createTerminalFailureSettlementProof,
  createTerminalSuccessSettlementProof,
  deriveRunActionExecutionArchive,
  deriveRunActionExecutionArchiveSegment,
  deriveRunActionTerminalArchiveAuthority,
  encodeRunActionArchiveArtifact,
  type RunActionExecutionArchiveRecord,
  type RunActionExecutionArchiveSegment,
  type RunActionExecutionRecord,
  type RunActionSettlementRecord,
  type RunActionTerminalArchiveAuthority,
  type RunBehaviorSnapshot,
  type RunRecord,
  type TerminalFailureSettlementProof,
  type TerminalSuccessSettlementProof,
} from "./run-record-contracts.js";
import {
  isId,
  isNonnegativeSafeInteger,
  isProjectRelativePath,
  isRecord,
  terminalArchiveAuthorities,
} from "./run-record-validation.js";
export * from "./run-record-contracts.js";

export function assertRunActionExecutions(value: unknown, run: Readonly<RunRecord>): void {
  if (value === undefined) return;
  if (!isRecord(value) || Object.keys(value).length > 2_048 || run.behavior === undefined) {
    throw new Error("run action executions are invalid");
  }
  for (const [invocationId, raw] of Object.entries(value)) {
    if (
      !isRecord(raw) ||
      raw.protocol !== "koni.run-action-execution.v1" ||
      raw.invocationId !== invocationId ||
      !isId(invocationId) ||
      !isRecord(raw.boundary) ||
      !isRecord(raw.plan) ||
      !isRecord(raw.journal) ||
      !isRecord(raw.effects) ||
      !isNonnegativeSafeInteger(raw.expectedRunRevision) ||
      typeof raw.createdAt !== "string" ||
      raw.createdAt.length === 0 ||
      typeof raw.updatedAt !== "string" ||
      raw.updatedAt.length === 0 ||
      (raw.settledAt !== undefined &&
        (typeof raw.settledAt !== "string" || raw.settledAt.length === 0)) ||
      (raw.settlement !== undefined && !isRecord(raw.settlement)) ||
      (raw.recoveryInvocationId !== undefined && !isId(raw.recoveryInvocationId)) ||
      (raw.recoverySettledAt !== undefined &&
        (typeof raw.recoverySettledAt !== "string" || raw.recoverySettledAt.length === 0)) ||
      (raw.compilerRetryHistory !== undefined &&
        (!Array.isArray(raw.compilerRetryHistory) || raw.compilerRetryHistory.length > 16))
    ) {
      throw new Error(`invalid run action execution: ${invocationId}`);
    }
    assertRunActionBoundary(raw.boundary, run, invocationId);
    const plan = raw.plan as unknown as ActionExecutionPlan;
    const journal = raw.journal as unknown as ActionExecutionJournal;
    const { sha256: planSha256, ...planMaterial } = plan;
    const { sha256: journalSha256, ...journalMaterial } = journal;
    if (
      plan.protocol !== "koni.action-execution-plan.v1" ||
      plan.invocationId !== invocationId ||
      !isSha256Digest(planSha256) ||
      canonicalHash(planMaterial) !== planSha256 ||
      plan.catalogSha256 !== run.behavior.actions.sha256 ||
      run.behavior.actions.actions[plan.actionId]?.sha256 !== plan.actionSha256 ||
      journal.protocol !== "koni.action-execution-journal.v1" ||
      journal.invocationId !== invocationId ||
      journal.planSha256 !== planSha256 ||
      !isSha256Digest(journalSha256) ||
      canonicalHash(journalMaterial) !== journalSha256
    ) {
      throw new Error(`invalid run action plan or journal: ${invocationId}`);
    }
    try {
      validateActionExecutionJournal(plan, journal);
    } catch {
      throw new Error(`impossible run action journal state: ${invocationId}`);
    }
    const compilerRetryHashes = new Set<string>();
    for (const [index, retry] of (raw.compilerRetryHistory ?? []).entries()) {
      if (
        !isRecord(retry) ||
        retry.protocol !== "koni.run-action-compiler-retry.v1" ||
        !isRecord(retry.journal) ||
        typeof retry.reason !== "string" ||
        retry.reason.length === 0 ||
        typeof retry.retriedAt !== "string" ||
        retry.retriedAt.length === 0 ||
        !isSha256Digest(retry.sha256)
      ) {
        throw new Error(`invalid compiler retry ${index} for run action: ${invocationId}`);
      }
      const { sha256, ...material } = retry;
      if (canonicalHash(material) !== sha256 || compilerRetryHashes.has(sha256)) {
        throw new Error(`invalid compiler retry identity ${index} for run action: ${invocationId}`);
      }
      compilerRetryHashes.add(sha256);
      const priorJournal = retry.journal as unknown as ActionExecutionJournal;
      if (priorJournal.status !== "failed") {
        throw new Error(`compiler retry did not retain a failed journal: ${invocationId}`);
      }
      try {
        validateActionExecutionJournal(plan, priorJournal);
      } catch {
        throw new Error(`compiler retry retained an impossible journal: ${invocationId}`);
      }
    }
    const effectEntries = Object.entries(raw.effects);
    if (effectEntries.length > plan.recipe.length + plan.compensation.length) {
      throw new Error(`run action has more effects than configured steps: ${invocationId}`);
    }
    for (const [effectKey, effect] of effectEntries) {
      assertRunActionEffectReceipt(effectKey, effect, plan);
    }
    if (raw.semanticResult !== undefined) assertRunActionSemanticResult(raw.semanticResult);
    if (raw.settlement !== undefined) {
      assertRunActionSettlement(raw.settlement, raw as unknown as RunActionExecutionRecord);
    }
    if (raw.settlement !== undefined && raw.settledAt !== raw.settlement.settledAt) {
      throw new Error(
        `run action settlement timestamp differs from legacy projection: ${invocationId}`,
      );
    }
    if (raw.boundary.kind === "lead_launch" && raw.settledAt !== undefined) {
      const attemptId = raw.boundary.attemptId;
      const attempt = typeof attemptId === "string" ? run.attempts[attemptId] : undefined;
      const abandonedBeforeLaunch =
        raw.settlement?.disposition === "abandoned" && attempt === undefined;
      if (
        !abandonedBeforeLaunch &&
        (attempt?.kind !== "lead" || attempt.launchActionInvocationId !== invocationId)
      ) {
        throw new Error(`settled Lead action has no exact admitted attempt: ${invocationId}`);
      }
    }
  }
}

export function assertRunActionTerminalArchiveAuthority(
  value: unknown,
): asserts value is RunActionTerminalArchiveAuthority {
  if (!isRecord(value)) throw new Error("run action terminal archive authority is invalid");
  const { sha256, ...material } = value;
  if (
    value.protocol !== "koni.run-action-terminal-archive-authority.v1" ||
    !isId(value.runId) ||
    !isId(value.invocationId) ||
    !isSha256Digest(value.boundarySha256) ||
    !isId(value.ticketId) ||
    !isId(value.stepId) ||
    !isId(value.attemptId) ||
    !isSha256Digest(value.actionPlanSha256) ||
    !isSha256Digest(value.actionSettlementSha256) ||
    !["completed", "failed", "abandoned"].includes(String(value.settlementDisposition)) ||
    !isSha256Digest(value.terminalOutputSha256) ||
    (value.terminalPolicySha256 !== undefined && !isSha256Digest(value.terminalPolicySha256)) ||
    (value.terminalProofSha256 !== undefined && !isSha256Digest(value.terminalProofSha256)) ||
    !isSha256Digest(sha256) ||
    canonicalHash(material) !== sha256
  ) {
    throw new Error("run action terminal archive authority is invalid");
  }
  const abandoned = value.settlementDisposition === "abandoned";
  if (
    abandoned !== (value.terminalPolicySha256 === undefined) ||
    abandoned !== (value.terminalProofSha256 === undefined)
  ) {
    throw new Error("run action terminal archive authority has invalid semantic closure");
  }
}

export function assertRunActionArchive(value: unknown, segments: unknown): void {
  if (value !== undefined) {
    if (!Array.isArray(value) || value.length > 8_192)
      throw new Error("run action archive is invalid");
    const ids = new Set<string>();
    for (const raw of value) {
      if (
        !isRecord(raw) ||
        (raw.protocol !== "koni.run-action-archive.v1" &&
          raw.protocol !== "koni.run-action-archive.v2") ||
        !isId(raw.invocationId) ||
        ids.has(raw.invocationId) ||
        ![
          "approved_plan_compile",
          "assignment_validation",
          "configured_stage",
          "lead_launch",
          "post_orchestration_report",
          "recovery",
        ].includes(String(raw.kind)) ||
        !isId(raw.actionId) ||
        !isSha256Digest(raw.planSha256) ||
        ![
          "running",
          "compensating",
          "completed",
          "failed",
          "compensated",
          "compensation_failed",
          "recovery_required",
        ].includes(String(raw.journalStatus)) ||
        (raw.settlementSha256 !== undefined && !isSha256Digest(raw.settlementSha256)) ||
        (raw.settlementDisposition !== undefined &&
          !["completed", "failed", "abandoned"].includes(String(raw.settlementDisposition))) ||
        typeof raw.artifactPath !== "string" ||
        !isProjectRelativePath(raw.artifactPath) ||
        !isSha256Digest(raw.artifactSha256) ||
        !isNonnegativeSafeInteger(raw.artifactSizeBytes) ||
        raw.artifactSizeBytes < 1 ||
        typeof raw.archivedAt !== "string" ||
        raw.archivedAt.length === 0
      ) {
        throw new Error("run action archive record is invalid");
      }
      if (
        (raw.journalStatus === "running" || raw.journalStatus === "compensating") &&
        raw.settlementDisposition !== "abandoned"
      ) {
        throw new Error("run action archive contains an unsettled nonterminal journal");
      }
      if (raw.terminalFailureProof !== undefined) {
        assertTerminalFailureSettlementProof(raw.terminalFailureProof);
        if (
          raw.terminalFailureProof.actionInvocationId !== raw.invocationId ||
          raw.terminalFailureProof.actionPlanSha256 !== raw.planSha256 ||
          raw.terminalFailureProof.actionSettlementSha256 !== raw.settlementSha256
        ) {
          throw new Error("run action archive terminal failure proof differs from its action");
        }
      }
      if (raw.terminalAuthority !== undefined) {
        assertRunActionTerminalArchiveAuthority(raw.terminalAuthority);
        if (
          raw.terminalAuthority.invocationId !== raw.invocationId ||
          raw.terminalAuthority.actionPlanSha256 !== raw.planSha256 ||
          raw.terminalAuthority.actionSettlementSha256 !== raw.settlementSha256 ||
          raw.terminalAuthority.settlementDisposition !== raw.settlementDisposition
        ) {
          throw new Error("run action archive terminal authority differs from its action row");
        }
        if (
          raw.terminalFailureProof !== undefined &&
          (raw.terminalAuthority.settlementDisposition !== "failed" ||
            raw.terminalAuthority.terminalProofSha256 !== raw.terminalFailureProof.sha256)
        ) {
          throw new Error("run action archive terminal failure differs from terminal authority");
        }
      } else if (
        raw.protocol === "koni.run-action-archive.v2" &&
        raw.terminalFailureProof !== undefined
      ) {
        throw new Error("run action archive terminal failure lacks non-evictable authority");
      }
      ids.add(raw.invocationId);
    }
  }
  if (segments !== undefined) {
    if (!Array.isArray(segments) || segments.length > 10_000)
      throw new Error("run action archive segments are invalid");
    for (const raw of segments) {
      if (
        !isRecord(raw) ||
        (raw.protocol !== "koni.run-action-archive-segment.v1" &&
          raw.protocol !== "koni.run-action-archive-segment.v2") ||
        !isId(raw.firstInvocationId) ||
        !isId(raw.lastInvocationId) ||
        !isNonnegativeSafeInteger(raw.count) ||
        raw.count < 1 ||
        typeof raw.artifactPath !== "string" ||
        !isProjectRelativePath(raw.artifactPath) ||
        !isSha256Digest(raw.artifactSha256) ||
        !isNonnegativeSafeInteger(raw.artifactSizeBytes) ||
        raw.artifactSizeBytes < 1 ||
        typeof raw.archivedAt !== "string" ||
        raw.archivedAt.length === 0
      ) {
        throw new Error("run action archive segment is invalid");
      }
      if (raw.terminalAuthorities !== undefined) {
        if (!Array.isArray(raw.terminalAuthorities) || raw.terminalAuthorities.length > raw.count) {
          throw new Error("run action archive segment terminal authorities are invalid");
        }
        const attempts = new Set<string>();
        const invocations = new Set<string>();
        for (const authority of raw.terminalAuthorities) {
          assertRunActionTerminalArchiveAuthority(authority);
          if (attempts.has(authority.attemptId) || invocations.has(authority.invocationId)) {
            throw new Error("run action archive segment repeats terminal authority");
          }
          attempts.add(authority.attemptId);
          invocations.add(authority.invocationId);
        }
      }
    }
  }
}

/** Validate one row against the exact serialized action artifact and return that action. */
export function validateRunActionArchiveArtifact(
  run: Readonly<RunRecord>,
  row: Readonly<RunActionExecutionArchiveRecord>,
  bytes: Buffer,
): RunActionExecutionRecord {
  if (bytes.byteLength !== row.artifactSizeBytes || rawSha256(bytes) !== row.artifactSha256) {
    throw new Error(`run action archive artifact digest differs from row: ${row.invocationId}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`run action archive artifact is not JSON: ${row.invocationId}`);
  }
  if (
    !isRecord(value) ||
    value.invocationId !== row.invocationId ||
    !bytes.equals(encodeRunActionArchiveArtifact(value))
  ) {
    throw new Error(`run action archive artifact is not the canonical action: ${row.invocationId}`);
  }
  assertRunActionExecutions({ [row.invocationId]: value }, run);
  const action = value as unknown as RunActionExecutionRecord;
  const expectedForProtocol =
    row.protocol === "koni.run-action-archive.v1"
      ? deriveLegacyRunActionExecutionArchive(
          run,
          action,
          row.archivedAt,
          bytes,
          row.terminalAuthority !== undefined,
        )
      : deriveRunActionExecutionArchive(run, action).row;
  if (canonicalHash(expectedForProtocol) !== canonicalHash(row)) {
    throw new Error(`run action archive row differs from action projection: ${row.invocationId}`);
  }
  return structuredClone(action);
}

/**
 * Explicit read-only compatibility for pre-v2 rows. The historical timestamp was caller wall
 * time, so it remains audit-only; every authority-bearing field is still derived from the exact
 * hash-bound action artifact. No new mutation may emit this protocol.
 */
export function deriveLegacyRunActionExecutionArchive(
  run: Readonly<RunRecord>,
  action: Readonly<RunActionExecutionRecord>,
  archivedAt: string,
  bytes: Buffer,
  retainTerminalAuthority = false,
): RunActionExecutionArchiveRecord {
  const terminalFailureProof = createTerminalFailureSettlementProof(run, action);
  const terminalAuthority = retainTerminalAuthority
    ? deriveRunActionTerminalArchiveAuthority(run, action)
    : undefined;
  return {
    protocol: "koni.run-action-archive.v1",
    invocationId: action.invocationId,
    kind: action.boundary.kind,
    actionId: action.plan.actionId,
    planSha256: action.plan.sha256,
    journalStatus: action.journal.status,
    ...(action.settlement === undefined ? {} : { settlementSha256: action.settlement.sha256 }),
    ...(action.settlement === undefined
      ? {}
      : {
          settlementDisposition: action.settlement.disposition,
        }),
    ...(terminalFailureProof === undefined ? {} : { terminalFailureProof }),
    ...(terminalAuthority === undefined ? {} : { terminalAuthority }),
    artifactPath: `runs/${run.id}/actions/archive/${action.invocationId}.json`,
    artifactSha256: rawSha256(bytes),
    artifactSizeBytes: bytes.byteLength,
    archivedAt,
  };
}

/** Validate one segment against its exact serialized canonical prefix. */
export function validateRunActionArchiveSegmentArtifact(
  runId: string,
  segment: Readonly<RunActionExecutionArchiveSegment>,
  bytes: Buffer,
): RunActionExecutionArchiveRecord[] {
  if (
    bytes.byteLength !== segment.artifactSizeBytes ||
    rawSha256(bytes) !== segment.artifactSha256
  ) {
    throw new Error("run action archive segment artifact digest differs from index");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("run action archive segment artifact is not JSON");
  }
  if (!Array.isArray(value) || !bytes.equals(encodeRunActionArchiveArtifact(value))) {
    throw new Error("run action archive segment is not a canonical row prefix");
  }
  assertRunActionArchive(value, undefined);
  const rows = value as unknown as RunActionExecutionArchiveRecord[];
  const expected = deriveRunActionExecutionArchiveSegment(runId, rows).segment;
  const expectedForProtocol =
    segment.protocol === "koni.run-action-archive-segment.v1"
      ? { ...expected, protocol: segment.protocol, archivedAt: segment.archivedAt }
      : expected;
  const comparableSegment =
    segment.protocol === "koni.run-action-archive-segment.v1"
      ? (() => {
          const { terminalAuthorities: _projectedAfterAuthentication, ...legacy } = segment;
          return legacy;
        })()
      : segment;
  const comparableExpected =
    segment.protocol === "koni.run-action-archive-segment.v1"
      ? (() => {
          const { terminalAuthorities: _notPresentInHistoricalRows, ...legacy } =
            expectedForProtocol;
          return legacy;
        })()
      : expectedForProtocol;
  if (canonicalHash(comparableExpected) !== canonicalHash(comparableSegment)) {
    throw new Error("run action archive segment differs from its exact prefix projection");
  }
  return structuredClone(rows);
}

/**
 * Compatibility projection for genuine v1 archives written before terminal-attempt links were
 * retained in run.json. Callers must first authenticate every supplied row and complete action
 * artifact. The resulting record is strict and can be persisted by a guarded journal migration;
 * v1 artifacts themselves remain immutable and read-only.
 */
export function hydrateLegacyRunActionTerminalArchiveAuthorities(
  run: Readonly<RunRecord>,
  archivedActions: ReadonlyMap<string, Readonly<RunActionExecutionRecord>>,
  segmentRows: ReadonlyMap<string, readonly RunActionExecutionArchiveRecord[]>,
): RunRecord {
  const projected = structuredClone(run);
  for (const row of projected.actionExecutionArchive ?? []) {
    if (row.protocol !== "koni.run-action-archive.v1" || row.terminalAuthority !== undefined)
      continue;
    const action = archivedActions.get(row.invocationId);
    const authority =
      action === undefined ? undefined : deriveRunActionTerminalArchiveAuthority(projected, action);
    if (authority !== undefined) row.terminalAuthority = authority;
  }
  for (const segment of projected.actionExecutionArchiveSegments ?? []) {
    if (
      segment.protocol !== "koni.run-action-archive-segment.v1" ||
      segment.terminalAuthorities !== undefined
    )
      continue;
    const rows = segmentRows.get(segment.artifactPath);
    if (rows === undefined)
      throw new Error("legacy action archive segment lacks authenticated rows");
    const authorities = rows.flatMap((row) => {
      const action = archivedActions.get(row.invocationId);
      const authority =
        action === undefined
          ? undefined
          : deriveRunActionTerminalArchiveAuthority(projected, action);
      return authority === undefined ? [] : [authority];
    });
    if (authorities.length !== 0) segment.terminalAuthorities = authorities;
  }
  return projected;
}

/**
 * Once archive artifacts have been loaded, require every non-evictable proof to resolve to the
 * exact live or archived settlement and prevent an invocation identity from appearing twice.
 */
export function validateRunActionArchiveSemanticAuthority(
  run: Readonly<RunRecord>,
  archivedActions: ReadonlyMap<string, Readonly<RunActionExecutionRecord>>,
): void {
  const liveIds = new Set(Object.keys(run.actionExecutions ?? {}));
  for (const invocationId of archivedActions.keys()) {
    if (liveIds.has(invocationId)) {
      throw new Error(`run action identity is both live and archived: ${invocationId}`);
    }
  }
  for (const proof of Object.values(run.terminalFailureProofs ?? {})) {
    const action =
      run.actionExecutions?.[proof.actionInvocationId] ??
      archivedActions.get(proof.actionInvocationId);
    const exact =
      action === undefined ? undefined : createTerminalFailureSettlementProof(run, action);
    if (exact === undefined || canonicalHash(exact) !== canonicalHash(proof)) {
      throw new Error(
        `terminal failure proof differs from live/archive action authority: ${proof.sha256}`,
      );
    }
  }
  for (const proof of Object.values(run.terminalSuccessProofs ?? {})) {
    const action =
      run.actionExecutions?.[proof.actionInvocationId] ??
      archivedActions.get(proof.actionInvocationId);
    const exact =
      action === undefined ? undefined : createTerminalSuccessSettlementProof(run, action);
    if (exact === undefined || canonicalHash(exact) !== canonicalHash(proof)) {
      throw new Error(
        `terminal success proof differs from live/archive action authority: ${proof.sha256}`,
      );
    }
  }
  const projections = terminalArchiveAuthorities(run);
  const projectionsByInvocation = new Map(
    projections.map((projection) => [projection.invocationId, projection] as const),
  );
  for (const projection of projections) {
    const action = archivedActions.get(projection.invocationId);
    const exact =
      action === undefined ? undefined : deriveRunActionTerminalArchiveAuthority(run, action);
    if (exact === undefined || canonicalHash(exact) !== canonicalHash(projection)) {
      throw new Error(
        `terminal archive projection differs from action authority: ${projection.invocationId}`,
      );
    }
  }
  for (const [invocationId, action] of archivedActions) {
    const exact = deriveRunActionTerminalArchiveAuthority(run, action);
    if (exact === undefined) continue;
    const projected = projectionsByInvocation.get(invocationId);
    if (projected === undefined || canonicalHash(projected) !== canonicalHash(exact)) {
      throw new Error(
        `archived terminal action lacks one exact non-evictable projection: ${invocationId}`,
      );
    }
  }
}

export function assertRunActionSettlement(
  value: unknown,
  action: Readonly<RunActionExecutionRecord>,
): asserts value is RunActionSettlementRecord {
  if (
    !isRecord(value) ||
    value.protocol !== "koni.run-action-settlement.v1" ||
    value.invocationId !== action.invocationId ||
    value.planSha256 !== action.plan.sha256 ||
    value.journalSha256 !== action.journal.sha256 ||
    value.semanticResultSha256 !==
      (action.semanticResult === undefined ? null : canonicalHash(action.semanticResult)) ||
    !["completed", "failed", "abandoned"].includes(String(value.disposition)) ||
    typeof value.reason !== "string" ||
    value.reason.trim().length === 0 ||
    Buffer.byteLength(value.reason, "utf8") > 64 * 1024 ||
    typeof value.settledAt !== "string" ||
    value.settledAt.length === 0 ||
    !isSha256Digest(value.sha256)
  ) {
    throw new Error(`invalid run action settlement: ${action.invocationId}`);
  }
  const { sha256, ...material } = value;
  if (canonicalHash(material) !== sha256) {
    throw new Error(`invalid run action settlement hash: ${action.invocationId}`);
  }
  if (value.disposition === "completed" && action.journal.status !== "completed") {
    throw new Error(`completed action settlement has noncompleted journal: ${action.invocationId}`);
  }
  if (action.boundary.kind === "assignment_validation") {
    if (
      value.disposition === "completed" &&
      (action.semanticResult?.kind !== "assignment" || action.semanticResult.status !== "completed")
    ) {
      throw new Error(
        `completed assignment settlement has no completed semantic result: ${action.invocationId}`,
      );
    }
    if (
      value.disposition === "failed" &&
      (action.semanticResult?.kind !== "assignment" || action.semanticResult.status !== "failed")
    ) {
      throw new Error(
        `failed assignment settlement has no failed semantic result: ${action.invocationId}`,
      );
    }
  }
}

export function assertTerminalFailureSettlementProof(
  value: unknown,
): asserts value is TerminalFailureSettlementProof {
  if (
    !isRecord(value) ||
    value.protocol !== "koni.terminal-failure-settlement.v1" ||
    !isId(value.runId) ||
    !isId(value.ticketId) ||
    !isId(value.stepId) ||
    !isId(value.attemptId) ||
    !isId(value.actionInvocationId) ||
    !isSha256Digest(value.actionPlanSha256) ||
    !isSha256Digest(value.actionSettlementSha256) ||
    !isRecord(value.semanticResult) ||
    value.semanticResult.kind !== "assignment" ||
    value.semanticResult.status !== "failed" ||
    typeof value.semanticResult.blocker !== "string" ||
    value.semanticResult.blocker.length === 0 ||
    canonicalHash(value.semanticResult) !== value.semanticResultSha256 ||
    !isSha256Digest(value.semanticResultSha256) ||
    !isSha256Digest(value.terminalPolicySha256) ||
    !isSha256Digest(value.terminalOutputSha256) ||
    !isSha256Digest(value.sha256)
  ) {
    throw new Error("invalid terminal failure settlement proof");
  }
  const { sha256, ...material } = value;
  if (canonicalHash(material) !== sha256)
    throw new Error("invalid terminal failure settlement proof hash");
}

export function assertTerminalFailureProofIndex(value: unknown, run: Readonly<RunRecord>): void {
  if (value === undefined) return;
  if (!isRecord(value) || Object.keys(value).length > 100_000) {
    throw new Error("run terminal failure proof index is invalid");
  }
  for (const [sha256, proof] of Object.entries(value)) {
    assertTerminalFailureSettlementProof(proof);
    if (sha256 !== proof.sha256) throw new Error("run terminal failure proof key is invalid");
    const ticket = run.tickets[proof.ticketId];
    const attempt = run.attempts[proof.attemptId];
    if (
      proof.runId !== run.id ||
      ticket === undefined ||
      !ticket.steps.some(
        (step) => step.id === proof.stepId && step.attemptIds.includes(proof.attemptId),
      ) ||
      attempt?.ticketId !== proof.ticketId ||
      attempt.stepId !== proof.stepId ||
      attempt.terminalPolicy?.sha256 !== proof.terminalPolicySha256 ||
      attempt.terminalOutputSha256 !== proof.terminalOutputSha256
    ) {
      throw new Error("run terminal failure proof differs from durable attempt");
    }
    const live = run.actionExecutions?.[proof.actionInvocationId];
    if (live !== undefined) {
      const exact = createTerminalFailureSettlementProof(run, live);
      if (exact === undefined || canonicalHash(exact) !== canonicalHash(proof)) {
        throw new Error("run terminal failure proof differs from live action settlement");
      }
    }
  }
}

export function assertTerminalSuccessProofIndex(value: unknown, run: Readonly<RunRecord>): void {
  if (value === undefined) return;
  if (!isRecord(value) || Object.keys(value).length > 100_000) {
    throw new Error("run terminal success proof index is invalid");
  }
  for (const [sha256, proof] of Object.entries(value)) {
    assertTerminalSuccessSettlementProof(proof);
    if (sha256 !== proof.sha256) throw new Error("run terminal success proof key is invalid");
    const ticket = run.tickets[proof.ticketId];
    const attempt = run.attempts[proof.attemptId];
    if (
      proof.runId !== run.id ||
      ticket === undefined ||
      !ticket.steps.some(
        (step) => step.id === proof.stepId && step.attemptIds.includes(proof.attemptId),
      ) ||
      attempt?.ticketId !== proof.ticketId ||
      attempt.stepId !== proof.stepId ||
      attempt.terminalPolicy?.sha256 !== proof.terminalPolicySha256 ||
      attempt.terminalOutputSha256 !== proof.terminalOutputSha256
    ) {
      throw new Error("run terminal success proof differs from durable attempt");
    }
    if (
      attempt.terminalPolicy?.mode === "semantic_upstream_change_control" &&
      proof.semanticResult.changeControlSha256 !== attempt.terminalPolicy.changeControlSha256
    ) {
      throw new Error(
        "upstream terminal policy differs from durable change-control settlement proof",
      );
    }
    const live = run.actionExecutions?.[proof.actionInvocationId];
    if (live !== undefined) {
      const exact = createTerminalSuccessSettlementProof(run, live);
      if (exact === undefined || canonicalHash(exact) !== canonicalHash(proof)) {
        throw new Error("run terminal success proof differs from live action settlement");
      }
    }
  }
}

export function assertTerminalSuccessSettlementProof(
  value: unknown,
): asserts value is TerminalSuccessSettlementProof {
  if (
    !isRecord(value) ||
    value.protocol !== "koni.terminal-success-settlement.v1" ||
    !isId(value.runId) ||
    !isId(value.ticketId) ||
    !isId(value.stepId) ||
    !isId(value.attemptId) ||
    !isId(value.actionInvocationId) ||
    !isSha256Digest(value.actionPlanSha256) ||
    !isSha256Digest(value.actionSettlementSha256) ||
    !isRecord(value.semanticResult) ||
    value.semanticResult.kind !== "assignment" ||
    value.semanticResult.status !== "completed" ||
    typeof value.semanticResult.summary !== "string" ||
    value.semanticResult.summary.length === 0 ||
    canonicalHash(value.semanticResult) !== value.semanticResultSha256 ||
    !isSha256Digest(value.semanticResultSha256) ||
    !isSha256Digest(value.terminalPolicySha256) ||
    !isSha256Digest(value.terminalOutputSha256) ||
    !isSha256Digest(value.sha256)
  ) {
    throw new Error("invalid terminal success settlement proof");
  }
  const { sha256, ...material } = value;
  if (canonicalHash(material) !== sha256)
    throw new Error("invalid terminal success settlement proof hash");
}

export function assertRunActionBoundary(
  value: Record<string, unknown>,
  run: Readonly<RunRecord>,
  invocationId: string,
): void {
  const { sha256, ...material } = value;
  if (
    value.protocol !== "koni.run-action-boundary.v1" ||
    ![
      "approved_plan_compile",
      "assignment_validation",
      "configured_stage",
      "lead_launch",
      "post_orchestration_report",
      "recovery",
    ].includes(String(value.kind)) ||
    !isId(value.boundaryId) ||
    value.runId !== run.id ||
    value.compiledConfigHash !== run.compiledConfigHash ||
    value.behaviorSha256 !== run.behavior?.sha256 ||
    !isNonnegativeSafeInteger(value.generation) ||
    !isNonnegativeSafeInteger(value.admittedRunRevision) ||
    !isId(value.stageId) ||
    (value.ticketId !== undefined && !isId(value.ticketId)) ||
    (value.stepId !== undefined && !isId(value.stepId)) ||
    (value.attemptId !== undefined && !isId(value.attemptId)) ||
    (value.cycleId !== undefined && !isId(value.cycleId)) ||
    (value.productSha256 !== undefined && !isSha256Digest(value.productSha256)) ||
    (value.parentInvocationId !== undefined && !isId(value.parentInvocationId)) ||
    !isSha256Digest(sha256) ||
    canonicalHash(material) !== sha256 ||
    invocationId.length === 0
  ) {
    throw new Error(`invalid run action boundary: ${invocationId}`);
  }
}

export function assertRunActionEffectReceipt(
  effectKey: string,
  value: unknown,
  plan: Readonly<ActionExecutionPlan>,
): void {
  if (!isRecord(value)) throw new Error(`invalid run action effect receipt: ${effectKey}`);
  const { sha256, ...material } = value;
  const phase =
    value.phase === "recipe" || value.phase === "compensation" ? value.phase : undefined;
  const configured =
    phase === undefined
      ? undefined
      : (phase === "recipe" ? plan.recipe : plan.compensation).find(
          (step) => step.id === value.stepId,
        );
  const expectedEffectKey =
    configured === undefined || phase === undefined
      ? undefined
      : `${plan.invocationId}:${phase}:${configured.id}:${plan.sha256}`;
  if (
    value.protocol !== "koni.run-action-effect-receipt.v1" ||
    value.effectKey !== effectKey ||
    value.planSha256 !== plan.sha256 ||
    value.actionId !== plan.actionId ||
    phase === undefined ||
    configured === undefined ||
    expectedEffectKey !== effectKey ||
    configured.primitive !== value.primitive ||
    canonicalHash(configured.arguments) !== value.argumentsSha256 ||
    canonicalHash(plan.context) !== value.contextSha256 ||
    !isId(value.stepId) ||
    typeof value.primitive !== "string" ||
    value.primitive.length === 0 ||
    !isSha256Digest(value.argumentsSha256) ||
    !isSha256Digest(value.contextSha256) ||
    !isSha256Digest(value.outputSha256) ||
    canonicalHash(value.output) !== value.outputSha256 ||
    typeof value.recordedAt !== "string" ||
    value.recordedAt.length === 0 ||
    !isSha256Digest(sha256) ||
    canonicalHash(material) !== sha256
  ) {
    throw new Error(`invalid run action effect receipt: ${effectKey}`);
  }
}

export function assertRunActionSemanticResult(value: unknown): void {
  if (!isRecord(value)) throw new Error("invalid run action semantic result");
  if (value.kind === "approved_plan") {
    if (
      !isNonnegativeSafeInteger(value.ticketCount) ||
      !isSha256Digest(value.graphHash) ||
      !isNonnegativeSafeInteger(value.graphRevision)
    )
      throw new Error("invalid approved-plan action result");
  } else if (value.kind === "assignment") {
    if (
      (value.status !== "completed" && value.status !== "failed") ||
      (value.summary !== undefined && typeof value.summary !== "string") ||
      (value.blocker !== undefined && typeof value.blocker !== "string") ||
      (value.changeControlSha256 !== undefined && !isSha256Digest(value.changeControlSha256)) ||
      (value.recurringAssetGrantRefreshSha256s !== undefined &&
        (!Array.isArray(value.recurringAssetGrantRefreshSha256s) ||
          value.recurringAssetGrantRefreshSha256s.length === 0 ||
          value.recurringAssetGrantRefreshSha256s.length > 64 ||
          value.recurringAssetGrantRefreshSha256s.some((digest) => !isSha256Digest(digest)))) ||
      (value.heldSourceGrantRefreshSha256s !== undefined &&
        (!Array.isArray(value.heldSourceGrantRefreshSha256s) ||
          value.heldSourceGrantRefreshSha256s.length === 0 ||
          value.heldSourceGrantRefreshSha256s.length > 64 ||
          value.heldSourceGrantRefreshSha256s.some((digest) => !isSha256Digest(digest)))) ||
      (value.status === "completed" &&
        (typeof value.summary !== "string" || value.summary.length === 0)) ||
      (value.status === "failed" &&
        (typeof value.blocker !== "string" || value.blocker.length === 0))
    ) {
      throw new Error("invalid assignment action result");
    }
  } else if (value.kind === "report") {
    if (!isId(value.reportId) || !isSha256Digest(value.bundleHash)) {
      throw new Error("invalid report action result");
    }
  } else {
    throw new Error("invalid run action semantic result kind");
  }
}

export function assertRunBehaviorSnapshot(
  value: unknown,
  runTypeId: string,
  git: unknown,
): asserts value is RunBehaviorSnapshot {
  if (
    !isRecord(value) ||
    value.protocol !== "koni.run-behavior.v1" ||
    !isSha256Digest(value.compiledBehaviorSha256) ||
    !isRecord(value.profile) ||
    !isRecord(value.runType) ||
    value.runType.id !== runTypeId ||
    !isSha256Digest(value.runType.sha256) ||
    !isRecord(value.runType.git) ||
    value.runType.git.policySha256 !== value.gitPolicySha256 ||
    !isRecord(value.actions) ||
    value.actions.protocol !== "koni.action-catalog.v1" ||
    !isSha256Digest(value.actions.sha256) ||
    !isSha256Digest(value.gitPolicySha256) ||
    !isSha256Digest(value.sha256)
  )
    throw new Error("run behavior snapshot is invalid");
  const { sha256: runTypeSha256, ...runTypeMaterial } = value.runType;
  if (canonicalHash(runTypeMaterial) !== runTypeSha256) {
    throw new Error("run behavior snapshot run-type hash is invalid");
  }
  const { sha256: actionCatalogSha256, ...actionCatalogMaterial } = value.actions;
  if (canonicalHash(actionCatalogMaterial) !== actionCatalogSha256) {
    throw new Error("run behavior snapshot action-catalog hash is invalid");
  }
  const { sha256: _sha256, ...material } = value;
  if (canonicalHash(material) !== value.sha256)
    throw new Error("run behavior snapshot hash is invalid");
  if (isRecord(git) && isRecord(git.policy) && git.policy.policySha256 !== value.gitPolicySha256) {
    throw new Error("run behavior snapshot Git policy differs from the pinned lifecycle policy");
  }
}
