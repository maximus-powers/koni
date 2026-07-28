import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { GitClient, type GitWorktreeEntry } from "../git/client.js";
import {
  GIT_LIFECYCLE_PROTOCOL,
  type RunGitLifecycleRecord,
  type TargetPromotionRecord,
} from "../git/lifecycle.js";
import { canonicalHash, isSha256Digest, type Sha256Digest } from "../shared/canonical.js";
import type { RunLifecycleState, RunPhase, ResumableRunPhase } from "./run-lifecycle.js";
import type { RunRecord } from "./run-record.js";

export const LEGACY_RUN_GIT_MIGRATION_PROTOCOL = "koni.legacy-run-git-migration.v1" as const;
export const LEGACY_RUN_RELOCATION_PROTOCOL = "koni.legacy-run-relocation.v1" as const;

/** Exact persisted shape emitted by the pre-isolation TypeScript runtime. */
export interface LegacyFlatRunGitRecord {
  targetRef: string;
  targetBaseOid: string;
  runBranch: string;
  runWorktree: string;
  candidateOid?: string;
  promotionTargetOid?: string;
  mergeReadyAt?: string;
  mergedOid?: string;
  namespaceStatus?: "planned" | "ready" | "cleaned";
  materializedAt?: string;
}

/**
 * A proof-only handoff for a future journaled relocation effect.
 *
 * The adapter never executes this plan. The executor must re-prove every OID,
 * path, registration, absence, and cleanliness predicate under the authority
 * mutation lane before moving the checkout through the staging path.
 */
export interface LegacyRunRelocationPlan {
  protocol: typeof LEGACY_RUN_RELOCATION_PROTOCOL;
  runId: string;
  sourceGitSha256: Sha256Digest;
  projectRoot: string;
  commonDirectory: string;
  target: {
    ref: string;
    selectedOid: string;
    observedOid: string | undefined;
  };
  source: {
    branchRef: string;
    worktree: string;
    expectedHeadOid: string;
    registered: true;
    clean: true;
  };
  destination: {
    namespaceRoot: string;
    stagingWorktree: string;
    planningWorktree: string;
    runWorktree: string;
    ticketRoot: string;
  };
  expectedAbsentPaths: string[];
  ticketProjectionIds: string[];
  priorPhase: RunPhase;
  plannedAt: string;
}

/** Durable audit/binding retained beside the migrated lifecycle record. */
export interface LegacyRunGitMigrationRecord {
  protocol: typeof LEGACY_RUN_GIT_MIGRATION_PROTOCOL;
  status: "migrated" | "relocation_required" | "relocated" | "preserved" | "retired";
  sourceGitSha256: Sha256Digest;
  source: LegacyFlatRunGitRecord;
  migratedAt: string;
  reason: string | undefined;
  relocation: LegacyRunRelocationPlan | undefined;
  relocationIntentId: string | undefined;
  relocatedAt: string | undefined;
  retirementIntentId: string | undefined;
  retiredAt: string | undefined;
}

export type LegacyRunGitMigrationResult =
  | { status: "not_legacy" }
  | { status: "blocked"; reason: string }
  | {
      status: "migrated" | "relocation_required" | "preserved";
      record: RunRecord;
      migration: LegacyRunGitMigrationRecord;
      relocation: LegacyRunRelocationPlan | undefined;
    };

export interface LegacyRunGitMigrationOptions {
  projectRoot: string;
  commonDirectory: string;
  migratedAt?: string;
}

interface LegacyEvidence {
  identityRoot: string;
  commonDirectory: string;
  targetOid: string | undefined;
  baseExists: boolean;
  branchRef: string;
  branchOid: string | undefined;
  candidateExists: boolean;
  promotionTargetExists: boolean;
  mergedExists: boolean;
  targetContainsMerged: boolean;
  targetCheckout: string | undefined;
  worktreeExists: boolean;
  canonicalPath: boolean;
  registeredAtPath: GitWorktreeEntry | undefined;
  branchRegistrations: GitWorktreeEntry[];
  sameRepository: boolean;
  clean: boolean;
  absentDestinationPaths: string[];
  occupiedDestinationPaths: string[];
}

/**
 * Detect and migrate only the legacy flat Git field. Every non-Git field is
 * subsequently subjected to the ordinary RunRecord validator by the store.
 */
export async function migrateLegacyRunGitRecord(
  value: unknown,
  options: LegacyRunGitMigrationOptions,
): Promise<LegacyRunGitMigrationResult> {
  if (!hasLegacyFlatRunGitRecord(value)) return { status: "not_legacy" };
  if (!isRecord(value) || value.protocol !== "koni.run-record.v1") {
    return { status: "blocked", reason: "legacy run envelope protocol is invalid" };
  }
  if (
    !isNamespaceId(value.id) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0
  ) {
    return { status: "blocked", reason: "legacy run identity or revision is invalid" };
  }
  if (!path.isAbsolute(options.projectRoot) || !path.isAbsolute(options.commonDirectory)) {
    return { status: "blocked", reason: "authority repository identity is not absolute" };
  }
  if (typeof value.projectRoot !== "string" || !path.isAbsolute(value.projectRoot)) {
    return { status: "blocked", reason: "legacy run project root is invalid" };
  }
  const legacy = parseLegacyGit(value.git);
  if (typeof legacy === "string") return { status: "blocked", reason: legacy };

  let identity: Awaited<ReturnType<typeof GitClient.discover>>;
  try {
    identity = await GitClient.discover(options.projectRoot);
  } catch (error) {
    return {
      status: "blocked",
      reason: `cannot discover legacy Git repository: ${message(error)}`,
    };
  }
  const expectedProjectRoot = await canonicalExistingPath(options.projectRoot);
  const expectedCommon = await canonicalExistingPath(options.commonDirectory);
  if (
    expectedProjectRoot === undefined ||
    expectedCommon === undefined ||
    identity.worktreeRoot !== expectedProjectRoot ||
    identity.commonDirectory !== expectedCommon
  ) {
    return {
      status: "blocked",
      reason: "authority repository identity does not match Git discovery",
    };
  }
  const persistedProjectRoot = await canonicalExistingPath(value.projectRoot);
  if (persistedProjectRoot !== expectedProjectRoot) {
    return { status: "blocked", reason: "legacy run belongs to a different project root" };
  }

  const migratedAt = options.migratedAt ?? new Date().toISOString();
  if (!isTimestamp(migratedAt)) {
    return { status: "blocked", reason: "migration timestamp is invalid" };
  }
  const sourceGitSha256 = canonicalHash(legacy);
  const runId = value.id;
  let evidence: LegacyEvidence;
  try {
    evidence = await inspectLegacyEvidence(
      identity.worktreeRoot,
      identity.commonDirectory,
      runId,
      legacy,
    );
  } catch (error) {
    return { status: "blocked", reason: `legacy Git proof failed: ${message(error)}` };
  }

  const evaluation = evaluateEvidence(runId, legacy, evidence);
  const priorPhase = readPhase(value.lifecycle);
  if (priorPhase === undefined) {
    return { status: "blocked", reason: "legacy run lifecycle phase is invalid" };
  }
  const ticketProjectionIds = legacyTicketProjectionIds(value.tickets, legacy);
  const namespace = standardNamespace(evidence.commonDirectory, runId);
  let relocation: LegacyRunRelocationPlan | undefined;
  if (
    evaluation.kind === "live_exact" &&
    priorPhase !== "deleting" &&
    (!isTerminalPhase(priorPhase) ||
      priorPhase === "failed" ||
      (priorPhase === "completed" &&
        legacy.mergedOid !== undefined &&
        evidence.targetContainsMerged))
  ) {
    relocation = {
      protocol: LEGACY_RUN_RELOCATION_PROTOCOL,
      runId,
      sourceGitSha256,
      projectRoot: evidence.identityRoot,
      commonDirectory: evidence.commonDirectory,
      target: {
        ref: legacy.targetRef,
        selectedOid: legacy.targetBaseOid,
        observedOid: evidence.targetOid,
      },
      source: {
        branchRef: evidence.branchRef,
        worktree: legacy.runWorktree,
        expectedHeadOid: evidence.branchOid!,
        registered: true,
        clean: true,
      },
      destination: {
        namespaceRoot: namespace.root,
        stagingWorktree: stagingWorktree(evidence.commonDirectory, runId),
        planningWorktree: namespace.planningWorktree,
        runWorktree: namespace.runWorktree,
        ticketRoot: namespace.ticketRoot,
      },
      expectedAbsentPaths: [...new Set(evidence.absentDestinationPaths)].sort(),
      ticketProjectionIds,
      priorPhase,
      plannedAt: migratedAt,
    };
  }

  let status: LegacyRunGitMigrationRecord["status"];
  let reason: string | undefined;
  if (relocation !== undefined) {
    status = "relocation_required";
    reason = "legacy live checkout requires journaled relocation into the canonical namespace";
  } else if (evaluation.kind === "planned_empty" && priorPhase === "draft") {
    status = "migrated";
  } else if (evaluation.kind === "cleaned_empty" && isTerminalPhase(priorPhase)) {
    status = "migrated";
  } else {
    status = "preserved";
    if (priorPhase === "deleting" && evaluation.kind === "live_exact") {
      reason = "legacy run deletion requires a journaled legacy-source cleanup";
    } else if (priorPhase === "deleted" && evaluation.kind === "live_exact") {
      reason = "deleted legacy run still owns a live checkout and requires operator recovery";
    } else if (evaluation.kind === "preserved") {
      reason = evaluation.reason;
    } else if (evaluation.kind === "planned_empty") {
      reason = "only a draft run may own an unmaterialized legacy namespace";
    } else if (evaluation.kind === "cleaned_empty") {
      reason = "only a terminal run may own a cleaned legacy namespace";
    } else {
      reason = "legacy terminal checkout lacks exact publication evidence";
    }
  }

  const lifecycle = buildLifecycle({
    runId,
    legacy,
    evidence,
    namespace,
    status,
    reason,
    migratedAt,
    terminal: isTerminalPhase(priorPhase),
  });
  const migration: LegacyRunGitMigrationRecord = {
    protocol: LEGACY_RUN_GIT_MIGRATION_PROTOCOL,
    status,
    sourceGitSha256,
    source: legacy,
    migratedAt,
    reason,
    relocation,
    relocationIntentId: undefined,
    relocatedAt: undefined,
    retirementIntentId: undefined,
    retiredAt: undefined,
  };
  const record = structuredClone(value) as unknown as RunRecord;
  record.projectRoot = evidence.identityRoot;
  record.git = lifecycle;
  record.pendingGitIntents = {};
  record.gitReceipts = [];
  record.legacyGitMigration = migration;
  record.revision += 1;
  record.updatedAt = migratedAt;
  if (status !== "migrated") {
    record.lifecycle = preserveLifecycle(record.lifecycle, reason!, migratedAt);
  }
  return { status, record, migration, relocation };
}

export function assertLegacyRunGitMigrationRecord(
  value: unknown,
  runId: string,
  projectRoot: string,
  lifecycle: RunGitLifecycleRecord,
): asserts value is LegacyRunGitMigrationRecord {
  if (
    !isRecord(value) ||
    value.protocol !== LEGACY_RUN_GIT_MIGRATION_PROTOCOL ||
    !new Set(["migrated", "relocation_required", "relocated", "preserved", "retired"]).has(
      String(value.status),
    ) ||
    !isSha256Digest(value.sourceGitSha256) ||
    !isTimestamp(value.migratedAt) ||
    (value.reason !== undefined &&
      (typeof value.reason !== "string" || value.reason.length === 0)) ||
    (value.relocationIntentId !== undefined &&
      (typeof value.relocationIntentId !== "string" || value.relocationIntentId.length === 0)) ||
    (value.relocatedAt !== undefined && !isTimestamp(value.relocatedAt)) ||
    (value.retirementIntentId !== undefined &&
      (typeof value.retirementIntentId !== "string" || value.retirementIntentId.length === 0)) ||
    (value.retiredAt !== undefined && !isTimestamp(value.retiredAt))
  ) {
    throw new Error("legacy Git migration record is invalid");
  }
  const source = parseLegacyGit(value.source);
  if (typeof source === "string" || canonicalHash(source) !== value.sourceGitSha256) {
    throw new Error("legacy Git migration source binding is invalid");
  }
  if (
    source.targetRef !== lifecycle.target.ref ||
    source.targetBaseOid !== lifecycle.target.selectedOid ||
    lifecycle.runId !== runId ||
    lifecycle.projectRoot !== projectRoot
  ) {
    throw new Error("legacy Git migration disagrees with the migrated lifecycle");
  }
  if (
    (value.status === "migrated" || value.status === "relocated" || value.status === "retired") &&
    value.reason !== undefined
  ) {
    throw new Error("successful legacy Git migration has a blocker reason");
  }
  if (
    (value.status === "relocation_required" || value.status === "preserved") &&
    value.reason === undefined
  ) {
    throw new Error("preserved legacy Git migration is missing its blocker reason");
  }
  if (
    value.status === "relocation_required" ||
    value.status === "relocated" ||
    ((value.status === "preserved" || value.status === "retired") && value.relocation !== undefined)
  ) {
    assertLegacyRunRelocationPlan(
      value.relocation,
      runId,
      projectRoot,
      lifecycle.commonDirectory,
      value.sourceGitSha256,
    );
    if (
      value.relocation.source.branchRef !== `refs/heads/${source.runBranch}` ||
      value.relocation.source.worktree !== source.runWorktree ||
      value.relocation.target.ref !== source.targetRef ||
      value.relocation.target.selectedOid !== source.targetBaseOid ||
      value.relocation.destination.namespaceRoot !== lifecycle.namespace.root ||
      value.relocation.destination.planningWorktree !== lifecycle.namespace.planningWorktree ||
      value.relocation.destination.ticketRoot !== lifecycle.namespace.ticketRoot
    ) {
      throw new Error("legacy Git relocation plan disagrees with its source or lifecycle");
    }
    if (value.status === "relocated") {
      if (value.relocationIntentId === undefined || value.relocatedAt === undefined) {
        throw new Error("completed legacy Git relocation is missing its intent settlement");
      }
    } else if (value.relocationIntentId !== undefined || value.relocatedAt !== undefined) {
      throw new Error("pending legacy Git relocation has completion metadata");
    }
  } else if (
    value.relocation !== undefined ||
    value.relocationIntentId !== undefined ||
    value.relocatedAt !== undefined
  ) {
    throw new Error("legacy Git relocation exists for a non-relocation migration");
  }
  if (value.status === "retired") {
    if (value.retirementIntentId === undefined || value.retiredAt === undefined) {
      throw new Error("retired legacy Git migration is missing its intent settlement");
    }
  } else if (value.retirementIntentId !== undefined || value.retiredAt !== undefined) {
    throw new Error("legacy Git retirement metadata exists before retirement");
  }
}

export function assertLegacyRunRelocationPlan(
  value: unknown,
  runId: string,
  projectRoot: string,
  commonDirectory: string,
  sourceGitSha256: Sha256Digest,
): asserts value is LegacyRunRelocationPlan {
  if (
    !isRecord(value) ||
    value.protocol !== LEGACY_RUN_RELOCATION_PROTOCOL ||
    value.runId !== runId ||
    value.sourceGitSha256 !== sourceGitSha256 ||
    value.projectRoot !== projectRoot ||
    value.commonDirectory !== commonDirectory ||
    !isRecord(value.target) ||
    !isSafeTargetRef(value.target.ref) ||
    !isOid(value.target.selectedOid) ||
    (value.target.observedOid !== undefined && !isOid(value.target.observedOid)) ||
    !isRecord(value.source) ||
    value.source.branchRef !== `refs/heads/koni/runs/${runId}` ||
    !path.isAbsolute(String(value.source.worktree)) ||
    !isOid(value.source.expectedHeadOid) ||
    value.source.registered !== true ||
    value.source.clean !== true ||
    !isRecord(value.destination) ||
    !Array.isArray(value.expectedAbsentPaths) ||
    !Array.isArray(value.ticketProjectionIds) ||
    !isRunPhase(value.priorPhase) ||
    !isTimestamp(value.plannedAt)
  ) {
    throw new Error("legacy Git relocation plan is invalid");
  }
  const expected = standardNamespace(commonDirectory, runId);
  const expectedAbsentPaths = [
    expected.planningWorktree,
    expected.runWorktree,
    expected.ticketRoot,
    stagingWorktree(commonDirectory, runId),
  ].sort();
  if (
    value.destination.namespaceRoot !== expected.root ||
    value.destination.planningWorktree !== expected.planningWorktree ||
    value.destination.runWorktree !== expected.runWorktree ||
    value.destination.ticketRoot !== expected.ticketRoot ||
    value.destination.stagingWorktree !== stagingWorktree(commonDirectory, runId) ||
    value.expectedAbsentPaths.some((item) => typeof item !== "string" || !path.isAbsolute(item)) ||
    new Set(value.expectedAbsentPaths).size !== value.expectedAbsentPaths.length ||
    JSON.stringify([...value.expectedAbsentPaths].sort()) !== JSON.stringify(expectedAbsentPaths) ||
    value.ticketProjectionIds.some((item) => !isNamespaceId(item)) ||
    new Set(value.ticketProjectionIds).size !== value.ticketProjectionIds.length
  ) {
    throw new Error("legacy Git relocation namespace or preconditions are invalid");
  }
}

export function hasLegacyFlatRunGitRecord(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.git)) return false;
  return (
    value.git.protocol === undefined &&
    typeof value.git.targetRef === "string" &&
    typeof value.git.targetBaseOid === "string" &&
    typeof value.git.runBranch === "string" &&
    typeof value.git.runWorktree === "string"
  );
}

async function inspectLegacyEvidence(
  projectRoot: string,
  commonDirectory: string,
  runId: string,
  legacy: LegacyFlatRunGitRecord,
): Promise<LegacyEvidence> {
  const repository = new GitClient(projectRoot);
  const branchRef = `refs/heads/${legacy.runBranch}`;
  const [targetOid, base, branchOid, candidate, promotionTarget, merged, worktrees] =
    await Promise.all([
      repository.tryResolveRef(legacy.targetRef),
      repository.tryResolveRef(legacy.targetBaseOid),
      repository.tryResolveRef(branchRef),
      legacy.candidateOid === undefined
        ? Promise.resolve(undefined)
        : repository.tryResolveRef(legacy.candidateOid),
      legacy.promotionTargetOid === undefined
        ? Promise.resolve(undefined)
        : repository.tryResolveRef(legacy.promotionTargetOid),
      legacy.mergedOid === undefined
        ? Promise.resolve(undefined)
        : repository.tryResolveRef(legacy.mergedOid),
      repository.worktrees(),
    ]);
  const expected = standardNamespace(commonDirectory, runId);
  const registeredAtPath = worktrees.find(
    (entry) => path.resolve(entry.path) === path.resolve(legacy.runWorktree),
  );
  const branchRegistrations = worktrees.filter((entry) => entry.branch === branchRef);
  const stat = await optionalLstat(legacy.runWorktree);
  let canonicalPath = path.resolve(legacy.runWorktree) === expected.root;
  let sameRepository = false;
  let clean = false;
  if (stat !== undefined) {
    const real = await canonicalExistingPath(legacy.runWorktree);
    canonicalPath =
      canonicalPath && !stat.isSymbolicLink() && stat.isDirectory() && real === expected.root;
    try {
      const discovered = await GitClient.discover(legacy.runWorktree);
      sameRepository = discovered.commonDirectory === commonDirectory;
      clean =
        sameRepository && (await new GitClient(legacy.runWorktree).statusEntries()).length === 0;
    } catch {
      sameRepository = false;
      clean = false;
    }
  }
  const candidatePaths = [
    expected.planningWorktree,
    expected.runWorktree,
    expected.ticketRoot,
    stagingWorktree(commonDirectory, runId),
  ];
  const pathStates = await Promise.all(
    candidatePaths.map(async (item) => ({
      item,
      exists: (await optionalLstat(item)) !== undefined,
    })),
  );
  const targetCheckoutEntries = worktrees.filter((entry) => entry.branch === legacy.targetRef);
  const targetCheckout =
    targetCheckoutEntries.length === 1 ? targetCheckoutEntries[0]!.path : undefined;
  const targetContainsMerged =
    targetOid !== undefined &&
    merged !== undefined &&
    (await repository.isAncestor(merged, targetOid));
  return {
    identityRoot: projectRoot,
    commonDirectory,
    targetOid,
    baseExists: base === legacy.targetBaseOid,
    branchRef,
    branchOid,
    candidateExists: legacy.candidateOid === undefined || candidate === legacy.candidateOid,
    promotionTargetExists:
      legacy.promotionTargetOid === undefined || promotionTarget === legacy.promotionTargetOid,
    mergedExists: legacy.mergedOid === undefined || merged === legacy.mergedOid,
    targetContainsMerged,
    targetCheckout,
    worktreeExists: stat !== undefined,
    canonicalPath,
    registeredAtPath,
    branchRegistrations,
    sameRepository,
    clean,
    absentDestinationPaths: pathStates.filter((item) => !item.exists).map((item) => item.item),
    occupiedDestinationPaths: pathStates.filter((item) => item.exists).map((item) => item.item),
  };
}

function evaluateEvidence(
  runId: string,
  legacy: LegacyFlatRunGitRecord,
  evidence: LegacyEvidence,
):
  | { kind: "planned_empty" | "cleaned_empty" | "live_exact" }
  | { kind: "preserved"; reason: string } {
  if (!evidence.baseExists) {
    return { kind: "preserved", reason: "legacy selected target commit no longer resolves" };
  }
  if (evidence.targetOid === undefined) {
    return { kind: "preserved", reason: "legacy target ref no longer resolves" };
  }
  if (legacy.runBranch !== `koni/runs/${runId}`) {
    return {
      kind: "preserved",
      reason: "legacy run branch is outside the canonical run namespace",
    };
  }
  if (!promotionFieldsCoherent(legacy)) {
    return { kind: "preserved", reason: "legacy promotion fields are incomplete or contradictory" };
  }
  if (!evidence.candidateExists || !evidence.promotionTargetExists || !evidence.mergedExists) {
    return { kind: "preserved", reason: "one or more legacy promotion commits no longer resolve" };
  }
  if (legacy.mergedOid !== undefined && !evidence.targetContainsMerged) {
    return {
      kind: "preserved",
      reason: "legacy published commit is not contained by the current target",
    };
  }
  const noResources =
    evidence.branchOid === undefined &&
    evidence.branchRegistrations.length === 0 &&
    evidence.registeredAtPath === undefined &&
    !evidence.worktreeExists;
  if (noResources && legacy.namespaceStatus === "cleaned") return { kind: "cleaned_empty" };
  if (
    noResources &&
    (legacy.namespaceStatus === "planned" || legacy.namespaceStatus === undefined)
  ) {
    if (
      legacy.candidateOid !== undefined ||
      legacy.promotionTargetOid !== undefined ||
      legacy.mergeReadyAt !== undefined ||
      legacy.mergedOid !== undefined
    ) {
      return {
        kind: "preserved",
        reason: "unmaterialized legacy namespace contains promotion state",
      };
    }
    return { kind: "planned_empty" };
  }
  const exactLive =
    evidence.canonicalPath &&
    evidence.worktreeExists &&
    evidence.registeredAtPath !== undefined &&
    evidence.registeredAtPath.branch === evidence.branchRef &&
    evidence.branchRegistrations.length === 1 &&
    evidence.branchOid !== undefined &&
    evidence.registeredAtPath.head === evidence.branchOid &&
    evidence.sameRepository &&
    evidence.clean &&
    evidence.occupiedDestinationPaths.length === 0;
  if (exactLive) return { kind: "live_exact" };
  const reasons: string[] = [];
  if (!evidence.canonicalPath)
    reasons.push("recorded worktree path is not the canonical legacy namespace");
  if (!evidence.worktreeExists) reasons.push("recorded worktree is missing");
  if (evidence.registeredAtPath === undefined) reasons.push("recorded worktree is not registered");
  if (evidence.branchRegistrations.length !== 1) reasons.push("run ref registration is ambiguous");
  if (evidence.branchOid === undefined) reasons.push("run ref is missing");
  if (
    evidence.registeredAtPath !== undefined &&
    evidence.branchOid !== evidence.registeredAtPath.head
  ) {
    reasons.push("run ref and worktree HEAD disagree");
  }
  if (!evidence.sameRepository) reasons.push("recorded worktree belongs to another repository");
  if (evidence.worktreeExists && !evidence.clean)
    reasons.push("recorded worktree has local changes");
  if (evidence.occupiedDestinationPaths.length > 0)
    reasons.push("relocation destination is occupied");
  if (legacy.namespaceStatus === "cleaned") reasons.push("cleaned state still has live resources");
  return { kind: "preserved", reason: reasons.join("; ") || "legacy Git evidence is ambiguous" };
}

function buildLifecycle(input: {
  runId: string;
  legacy: LegacyFlatRunGitRecord;
  evidence: LegacyEvidence;
  namespace: ReturnType<typeof standardNamespace>;
  status: LegacyRunGitMigrationRecord["status"];
  reason: string | undefined;
  migratedAt: string;
  terminal: boolean;
}): RunGitLifecycleRecord {
  const liveExact =
    input.evidence.branchOid !== undefined &&
    input.evidence.registeredAtPath !== undefined &&
    input.evidence.canonicalPath &&
    input.evidence.sameRepository;
  const empty = !input.evidence.worktreeExists && input.evidence.branchOid === undefined;
  const cleaned = empty && input.legacy.namespaceStatus === "cleaned";
  const planned = empty && !cleaned && input.status === "migrated";
  const blocker = input.status === "migrated" ? undefined : input.reason;
  const promotion = legacyPromotion(input, blocker);
  return {
    protocol: GIT_LIFECYCLE_PROTOCOL,
    runId: input.runId,
    projectRoot: input.evidence.identityRoot,
    commonDirectory: input.evidence.commonDirectory,
    target: { ref: input.legacy.targetRef, selectedOid: input.legacy.targetBaseOid },
    namespace: {
      root: input.namespace.root,
      runRef: input.namespace.runRef,
      planningWorktree: input.namespace.planningWorktree,
      runWorktree: input.namespace.runWorktree,
      ticketRoot: input.namespace.ticketRoot,
    },
    planning: {
      status: planned ? "planned" : cleaned || liveExact ? "retired" : "preserved",
      baseOid: input.legacy.targetBaseOid,
      worktree: input.namespace.planningWorktree,
      createdAt: undefined,
      retiredAt:
        cleaned || liveExact ? (input.legacy.materializedAt ?? input.migratedAt) : undefined,
      blocker: planned || cleaned || liveExact ? undefined : blocker,
    },
    run: {
      status: planned
        ? "unmaterialized"
        : cleaned
          ? "retired"
          : liveExact && input.status === "migrated" && input.terminal
            ? "ready"
            : "preserved",
      branchRef: input.namespace.runRef,
      // The lifecycle is always a projection of the compiler-owned destination.
      // A still-live flat checkout remains authority-bound exclusively through
      // LegacyRunGitMigrationRecord.source and its immutable relocation plan.
      worktree: input.namespace.runWorktree,
      headOid: input.evidence.branchOid,
      materializedAt: input.legacy.materializedAt,
      retiredAt: cleaned ? input.migratedAt : undefined,
      blocker:
        planned || cleaned || (liveExact && input.status === "migrated" && input.terminal)
          ? undefined
          : blocker,
    },
    ticketCycles: {},
    ticketCycleOrder: [],
    promotion,
  };
}

function legacyPromotion(
  input: Parameters<typeof buildLifecycle>[0],
  blocker: string | undefined,
): TargetPromotionRecord | undefined {
  const legacy = input.legacy;
  if (legacy.candidateOid === undefined || legacy.promotionTargetOid === undefined)
    return undefined;
  if (input.evidence.branchOid === undefined) return undefined;
  const published = legacy.mergedOid === legacy.candidateOid && input.evidence.targetContainsMerged;
  return {
    status: published && input.status === "migrated" ? "published" : "preserved",
    expectedTargetOid: legacy.promotionTargetOid,
    runOid: input.evidence.branchOid,
    candidateOid: legacy.candidateOid,
    targetCheckout: input.evidence.targetCheckout,
    preparedAt: legacy.mergeReadyAt ?? input.migratedAt,
    publishedAt: published ? input.migratedAt : undefined,
    blocker:
      published && input.status === "migrated"
        ? undefined
        : (blocker ?? "legacy promotion requires operator review"),
  };
}

function preserveLifecycle(
  lifecycle: RunLifecycleState,
  reason: string,
  migratedAt: string,
): RunLifecycleState {
  const next = structuredClone(lifecycle);
  const prior = next.phase;
  if (isTerminalPhase(prior)) return next;
  // Preserve an already-durable deletion intent. Engine recovery will route
  // its exact legacy source through the dedicated retirement journal.
  if (prior === "deleting") return next;
  const nowMs = Date.parse(migratedAt);
  if (next.activeSinceMs !== undefined && Number.isSafeInteger(next.activeSinceMs)) {
    next.accumulatedActiveMs += Math.max(0, nowMs - next.activeSinceMs);
  }
  next.revision += 1;
  next.phase = "blocked";
  next.resumePhase = migrationResumePhase(next, prior);
  next.runningIntent = false;
  next.activeSinceMs = undefined;
  next.blocker = reason;
  return next;
}

function migrationResumePhase(
  lifecycle: RunLifecycleState,
  prior: RunPhase,
): ResumableRunPhase | undefined {
  if (isResumablePhase(prior)) return prior;
  if (prior === "paused" || prior === "pausing") {
    return lifecycle.resumePhase;
  }
  return undefined;
}

function parseLegacyGit(value: unknown): LegacyFlatRunGitRecord | string {
  if (!isRecord(value)) return "legacy Git field is not an object";
  if (!isSafeTargetRef(value.targetRef)) return "legacy target ref is unsafe";
  if (!isOid(value.targetBaseOid)) return "legacy selected target OID is invalid";
  if (typeof value.runBranch !== "string" || value.runBranch.length === 0) {
    return "legacy run branch is invalid";
  }
  if (typeof value.runWorktree !== "string" || !path.isAbsolute(value.runWorktree)) {
    return "legacy run worktree is invalid";
  }
  for (const key of ["candidateOid", "promotionTargetOid", "mergedOid"] as const) {
    if (value[key] !== undefined && !isOid(value[key])) return `legacy ${key} is invalid`;
  }
  for (const key of ["mergeReadyAt", "materializedAt"] as const) {
    if (value[key] !== undefined && !isTimestamp(value[key])) return `legacy ${key} is invalid`;
  }
  if (
    value.namespaceStatus !== undefined &&
    !new Set(["planned", "ready", "cleaned"]).has(String(value.namespaceStatus))
  )
    return "legacy namespace status is invalid";
  return {
    targetRef: value.targetRef,
    targetBaseOid: value.targetBaseOid,
    runBranch: value.runBranch,
    runWorktree: value.runWorktree,
    ...(value.candidateOid === undefined ? {} : { candidateOid: value.candidateOid as string }),
    ...(value.promotionTargetOid === undefined
      ? {}
      : { promotionTargetOid: value.promotionTargetOid as string }),
    ...(value.mergeReadyAt === undefined ? {} : { mergeReadyAt: value.mergeReadyAt as string }),
    ...(value.mergedOid === undefined ? {} : { mergedOid: value.mergedOid as string }),
    ...(value.namespaceStatus === undefined
      ? {}
      : {
          namespaceStatus: value.namespaceStatus as NonNullable<
            LegacyFlatRunGitRecord["namespaceStatus"]
          >,
        }),
    ...(value.materializedAt === undefined
      ? {}
      : { materializedAt: value.materializedAt as string }),
  };
}

function promotionFieldsCoherent(legacy: LegacyFlatRunGitRecord): boolean {
  const candidate = legacy.candidateOid !== undefined;
  const target = legacy.promotionTargetOid !== undefined;
  const readyAt = legacy.mergeReadyAt !== undefined;
  if (candidate !== target || candidate !== readyAt) return false;
  return legacy.mergedOid === undefined || (candidate && legacy.mergedOid === legacy.candidateOid);
}

function legacyTicketProjectionIds(tickets: unknown, legacy: LegacyFlatRunGitRecord): string[] {
  if (!isRecord(tickets)) return [];
  return Object.entries(tickets)
    .filter(
      ([id, ticket]) =>
        isNamespaceId(id) &&
        isRecord(ticket) &&
        (ticket.worktreePath === legacy.runWorktree || ticket.branch === legacy.runBranch),
    )
    .map(([id]) => id)
    .sort();
}

function standardNamespace(commonDirectory: string, runId: string) {
  const root = path.join(commonDirectory, "koni", "worktrees", "runs", runId);
  return {
    root,
    runRef: `refs/heads/koni/runs/${runId}`,
    planningWorktree: path.join(root, "planning"),
    runWorktree: path.join(root, "integration"),
    ticketRoot: path.join(root, "tickets"),
  };
}

function stagingWorktree(commonDirectory: string, runId: string): string {
  return path.join(commonDirectory, "koni", "worktrees", "migrations", runId, "integration");
}

function readPhase(value: unknown): RunPhase | undefined {
  if (!isRecord(value) || !isRunPhase(value.phase)) return undefined;
  return value.phase;
}

function isRunPhase(value: unknown): value is RunPhase {
  return (
    typeof value === "string" &&
    new Set<RunPhase>([
      "draft",
      "planning",
      "awaiting_questions",
      "awaiting_approval",
      "approving",
      "executing",
      "pausing",
      "paused",
      "verifying",
      "merge_ready",
      "merging",
      "blocked",
      "completed",
      "failed",
      "deleting",
      "deleted",
    ]).has(value as RunPhase)
  );
}

function isTerminalPhase(value: RunPhase): boolean {
  return value === "completed" || value === "failed" || value === "deleted";
}

function isResumablePhase(value: RunPhase): value is ResumableRunPhase {
  return !new Set<RunPhase>(["pausing", "paused", "deleting", "deleted"]).has(value);
}

function isSafeTargetRef(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("refs/heads/") ||
    value.length > 1_024 ||
    /[\u0000-\u0020~^:?*\\[\]]/u.test(value)
  )
    return false;
  const branch = value.slice("refs/heads/".length);
  return !(
    branch === "koni" ||
    branch.startsWith("koni/") ||
    branch.includes("..") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch
      .split("/")
      .some(
        (component) => component.length === 0 || component === "." || component.endsWith(".lock"),
      )
  );
}

function isOid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/u.test(value);
}

function isNamespaceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(value) &&
    value !== "." &&
    value !== ".." &&
    !value.endsWith(".lock")
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

async function canonicalExistingPath(value: string): Promise<string | undefined> {
  try {
    return await realpath(path.resolve(value));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function optionalLstat(value: string) {
  try {
    return await lstat(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
