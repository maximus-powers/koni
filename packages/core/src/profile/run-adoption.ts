import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { GitClient } from "../git/client.js";
import {
  canonicalHash,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import type { LegacyRunAdoptionRecord } from "../state/legacy-run-adoption.js";
import { readProfileLifecycle } from "./install.js";
import {
  assertLegacyProjectMigrationPlan,
  assertLegacyRunBarrierEvidence,
  assertLegacyRunCompatibilityIndex,
  LEGACY_PROJECT_MIGRATION_PROTOCOL,
  LegacyProjectMigrationError,
  verifyLegacyRunCompatibility,
  type LegacyProjectMigrationPlan,
  type LegacyRunBarrierEvidence,
  type LegacyRunCompatibilityIndex,
  type LegacyRunSnapshot,
} from "./migration.js";

const MAX_MIGRATION_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_LEGACY_REGISTRY_BYTES = 32 * 1024 * 1024;

export const LEGACY_RUN_ADOPTION_PREVIEW_PROTOCOL =
  "koni.legacy-run-adoption-preview.v1" as const;

export interface LegacyRunAdoptionBlocker {
  code:
    | "legacy_run_missing"
    | "legacy_run_changed"
    | "legacy_registry_changed"
    | "terminal_history_only"
    | "migration_barrier_missing"
    | "run_type_missing"
    | "target_ref_missing"
    | "target_ref_unsafe"
    | "target_ref_missing_from_repository"
    | "base_commit_missing"
    | "target_history_rewritten"
    | "source_worktree_missing"
    | "source_worktree_unsafe"
    | "source_worktree_unregistered"
    | "source_branch_missing"
    | "source_branch_mismatch"
    | "source_worktree_dirty"
    | "source_history_invalid"
    | "project_identity_mismatch"
    | "current_run_type_incompatible"
    | "fresh_successor_unavailable";
  message: string;
}

export interface LegacyRunAdoptionStart {
  targetRef: string;
  targetSelectedOid: string;
  planningBaseOid: string;
  sourceGit: LegacyRunAdoptionRecord["sourceGit"];
}

export interface LegacyRunAdoptionAssessment {
  protocol: typeof LEGACY_RUN_ADOPTION_PREVIEW_PROTOCOL;
  migrationId: string;
  runId: string;
  sourceStatus: LegacyRunSnapshot["status"];
  objective: string;
  runTypeId: string | undefined;
  targetRef: string | undefined;
  disposition: "ready" | "blocked";
  blockers: LegacyRunAdoptionBlocker[];
  start: LegacyRunAdoptionStart | undefined;
}

export interface LoadedLegacyRunMigrationEvidence {
  migrationId: string;
  projectRoot: string;
  plan: LegacyProjectMigrationPlan;
  planBytesSha256: Sha256Digest;
  compatibility: LegacyRunCompatibilityIndex;
  compatibilityIndexSha256: Sha256Digest;
  receiptSha256: Sha256Digest;
  barrier?: LegacyRunBarrierEvidence;
}

interface ArchivedMigrationReceipt {
  protocol: "koni.legacy-project-migration-receipt.v1";
  migrationId: string;
  planSha256: Sha256Digest;
  sourceSnapshotSha256: Sha256Digest;
  runSnapshotSha256: Sha256Digest;
  targetBundleSha256: Sha256Digest;
  sourceRetained: true;
  appliedAt: string;
}

export class LegacyRunAdoptionError extends Error {
  public readonly code: string;
  public readonly blockers: readonly LegacyRunAdoptionBlocker[];

  public constructor(
    code: string,
    message: string,
    blockers: readonly LegacyRunAdoptionBlocker[] = [],
  ) {
    super(message);
    this.name = "LegacyRunAdoptionError";
    this.code = code;
    this.blockers = structuredClone(blockers);
  }
}

/**
 * Load only the compiler-archived migration bundle. The editable source tree is separately
 * re-hashed immediately before assessment/resume.
 */
export async function loadLegacyRunMigrationEvidence(
  projectRoot: string,
  migrationId: string,
): Promise<LoadedLegacyRunMigrationEvidence> {
  if (!isId(migrationId)) {
    throw new LegacyRunAdoptionError("migration_id", "legacy migration ID is unsafe");
  }
  const project = await canonicalDirectory(projectRoot, "project_root");
  const lifecycle = await readProfileLifecycle(project);
  const migration = lifecycle?.migrations.find((candidate) => candidate.id === migrationId);
  if (migration === undefined) {
    throw new LegacyRunAdoptionError(
      "migration_missing",
      `managed profile does not contain migration ${migrationId}`,
    );
  }
  const root = path.join(project, ".koni", migration.artifactRoot);
  const canonicalRoot = await canonicalDirectory(root, "migration_artifacts");
  if (canonicalRoot !== root) {
    throw new LegacyRunAdoptionError(
      "migration_artifacts_redirected",
      "legacy migration evidence root is redirected",
    );
  }

  const planFile = await readStableJson(path.join(root, "plan.json"));
  const compatibilityFile = await readStableJson(path.join(root, "legacy-runs.json"));
  const receiptFile = await readStableJson(path.join(root, "receipt.json"));
  assertLegacyProjectMigrationPlan(planFile.value);
  assertLegacyRunCompatibilityIndex(compatibilityFile.value);
  const plan = planFile.value;
  const compatibility = compatibilityFile.value;
  const receipt = parseReceipt(receiptFile.value);
  if (
    plan.protocol !== LEGACY_PROJECT_MIGRATION_PROTOCOL ||
    plan.migrationId !== migrationId ||
    compatibility.migrationId !== migrationId ||
    receipt.migrationId !== migrationId ||
    plan.projectRoot !== project ||
    compatibility.projectRoot !== project ||
    receipt.planSha256 !== plan.planSha256 ||
    receipt.sourceSnapshotSha256 !== plan.configuration.snapshotSha256 ||
    receipt.runSnapshotSha256 !== plan.runs.snapshotSha256 ||
    receipt.targetBundleSha256 !== plan.targetBundleSha256 ||
    compatibility.sourceRegistrySha256 !== plan.runs.registrySha256 ||
    canonicalHash(compatibility.runs) !== canonicalHash(plan.runs.runs) ||
    compatibility.selectedRunId !== plan.runs.selectedRunId
  ) {
    throw new LegacyRunAdoptionError(
      "migration_evidence_mismatch",
      "legacy migration plan, compatibility index, and receipt disagree",
    );
  }

  // Authenticate every archived source pathname against Git before reading the barrier or allowing
  // any caller to open a run.sourceRoot. Coherently re-hashed archive tampering therefore cannot
  // redirect adoption to an attacker-selected tree.
  await authenticateLegacyRunPaths(project, plan, compatibility);

  let barrier: LegacyRunBarrierEvidence | undefined;
  if (plan.runs.requiresBarrier) {
    if (compatibility.barrierEvidenceSha256 === undefined) {
      throw new LegacyRunAdoptionError(
        "migration_barrier_missing",
        "legacy run migration lacks its held quiescence evidence",
      );
    }
    const barrierFile = await readStableJson(path.join(root, "run-barrier.json"));
    assertLegacyRunBarrierEvidence(plan, barrierFile.value);
    if (barrierFile.value.evidenceSha256 !== compatibility.barrierEvidenceSha256) {
      throw new LegacyRunAdoptionError(
        "migration_barrier_mismatch",
        "legacy run barrier does not match the compatibility index",
      );
    }
    barrier = barrierFile.value;
  } else if (compatibility.barrierEvidenceSha256 !== undefined) {
    throw new LegacyRunAdoptionError(
      "migration_barrier_unexpected",
      "legacy compatibility index has an unexpected barrier binding",
    );
  }
  return {
    migrationId,
    projectRoot: project,
    plan: structuredClone(plan),
    planBytesSha256: rawSha256(planFile.bytes),
    compatibility: structuredClone(compatibility),
    compatibilityIndexSha256: rawSha256(compatibilityFile.bytes),
    receiptSha256: rawSha256(receiptFile.bytes),
    ...(barrier === undefined ? {} : { barrier: structuredClone(barrier) }),
  };
}

/** Build a read-only, typed adoption decision from current Git and exact archived state. */
export async function assessLegacyRunAdoption(
  evidence: LoadedLegacyRunMigrationEvidence,
  runId: string,
): Promise<LegacyRunAdoptionAssessment> {
  const indexed = evidence.compatibility.runs.find((candidate) => candidate.id === runId);
  if (indexed === undefined) {
    return blockedAssessment(evidence.migrationId, {
      id: runId,
      status: "failed",
      goal: "Unknown legacy run",
      profileId: "unknown",
      profileVersion: "unknown",
      baseCommit: "unknown",
      configSnapshotHash: "unknown",
      createdAt: "unknown",
      updatedAt: "unknown",
      sourceRoot: evidence.projectRoot,
      treeSha256: `sha256:${"0".repeat(64)}`,
      fileCount: 0,
      resumeDisposition: "failed",
    }, blocker("legacy_run_missing", `legacy run is not indexed: ${runId}`));
  }

  let identity: Awaited<ReturnType<typeof GitClient.discover>>;
  let registryBefore: Sha256Digest;
  try {
    identity = await authenticateLegacyRunPaths(
      evidence.projectRoot,
      evidence.plan,
      evidence.compatibility,
    );
    registryBefore = await verifyLiveLegacyRegistry(evidence, identity);
  } catch (error) {
    return blockedAssessment(
      evidence.migrationId,
      indexed,
      blockerForLiveEvidence(error),
    );
  }
  let run: LegacyRunSnapshot;
  try {
    run = await verifyLegacyRunCompatibility(evidence.compatibility, runId);
  } catch (error) {
    const code = error instanceof LegacyProjectMigrationError
      ? error.code
      : "legacy_run_changed";
    return blockedAssessment(
      evidence.migrationId,
      indexed,
      blocker(
        code === "legacy_run_missing" ? "legacy_run_missing" : "legacy_run_changed",
        errorMessage(error),
      ),
    );
  }

  try {
    const registryAfter = await verifyLiveLegacyRegistry(evidence, identity);
    if (registryAfter !== registryBefore) {
      return blockedAssessment(
        evidence.migrationId,
        indexed,
        blocker(
          "legacy_registry_changed",
          "legacy run registry changed while the source run tree was being verified",
        ),
      );
    }
  } catch (error) {
    return blockedAssessment(
      evidence.migrationId,
      indexed,
      blockerForLiveEvidence(error),
    );
  }

  const blockers: LegacyRunAdoptionBlocker[] = [];
  if (!new Set(["planning", "approved", "active", "paused"]).has(run.status)) {
    blockers.push(blocker(
      "terminal_history_only",
      `legacy ${run.status} run is retained as immutable history and does not need a successor`,
    ));
  }
  if (evidence.compatibility.barrierEvidenceSha256 === undefined) {
    blockers.push(blocker(
      "migration_barrier_missing",
      "legacy run was not migrated under a held quiescence barrier",
    ));
  }
  if (run.runTypeId === undefined) {
    blockers.push(blocker(
      "run_type_missing",
      "legacy run has no pinned run type and cannot be recompiled safely",
    ));
  }
  if (run.targetBranch === undefined) {
    blockers.push(blocker(
      "target_ref_missing",
      "legacy run has no operator-selected target branch",
    ));
  } else if (!isUserTargetRef(run.targetBranch)) {
    blockers.push(blocker(
      "target_ref_unsafe",
      `legacy target is not a safe user branch: ${run.targetBranch}`,
    ));
  }
  if (blockers.length > 0 || run.targetBranch === undefined) {
    return assessment(evidence.migrationId, run, blockers, undefined);
  }

  const repository = new GitClient(identity.worktreeRoot);
  const [targetOid, baseOid] = await Promise.all([
    repository.tryResolveRef(run.targetBranch),
    repository.tryResolveRef(run.baseCommit),
  ]);
  if (targetOid === undefined) {
    blockers.push(blocker(
      "target_ref_missing_from_repository",
      `legacy target no longer resolves: ${run.targetBranch}`,
    ));
  }
  if (baseOid !== run.baseCommit) {
    blockers.push(blocker(
      "base_commit_missing",
      `legacy base commit no longer resolves: ${run.baseCommit}`,
    ));
  }
  if (
    targetOid !== undefined &&
    baseOid === run.baseCommit &&
    !await repository.isAncestor(run.baseCommit, targetOid)
  ) {
    blockers.push(blocker(
      "target_history_rewritten",
      "legacy base commit is no longer an ancestor of the selected target branch",
    ));
  }
  if (blockers.length > 0) return assessment(evidence.migrationId, run, blockers, undefined);

  if (run.status === "planning") {
    const start: LegacyRunAdoptionStart = {
      targetRef: run.targetBranch,
      targetSelectedOid: run.baseCommit,
      planningBaseOid: run.baseCommit,
      sourceGit: { kind: "legacy_base", headOid: run.baseCommit },
    };
    return assessment(evidence.migrationId, run, [], start);
  }
  return assessIntegrationSource(evidence, run, identity, repository);
}

/** Hash the exact successful pre-resume proof stored atomically with the lifecycle transition. */
export function legacyRunResumeVerificationSha256(
  evidence: LoadedLegacyRunMigrationEvidence,
  assessment: LegacyRunAdoptionAssessment,
  verifiedAt: string,
): Sha256Digest {
  if (assessment.disposition !== "ready" || assessment.start === undefined) {
    throw new LegacyRunAdoptionError(
      "legacy_adoption_blocked",
      "cannot bind a blocked legacy run assessment",
      assessment.blockers,
    );
  }
  return canonicalHash({
    migrationId: evidence.migrationId,
    migrationPlanBytesSha256: evidence.planBytesSha256,
    migrationPlanSha256: evidence.plan.planSha256,
    compatibilityIndexSha256: evidence.compatibilityIndexSha256,
    migrationReceiptSha256: evidence.receiptSha256,
    sourceRegistrySha256: evidence.compatibility.sourceRegistrySha256,
    barrierEvidenceSha256: evidence.compatibility.barrierEvidenceSha256,
    runId: assessment.runId,
    start: assessment.start,
    verifiedAt,
  });
}

async function assessIntegrationSource(
  evidence: LoadedLegacyRunMigrationEvidence,
  run: LegacyRunSnapshot,
  identity: Awaited<ReturnType<typeof GitClient.discover>>,
  repository: GitClient,
): Promise<LegacyRunAdoptionAssessment> {
  const blockers: LegacyRunAdoptionBlocker[] = [];
  if (run.integrationWorktree === undefined) {
    blockers.push(blocker(
      "source_worktree_missing",
      `legacy ${run.status} run has no integration worktree`,
    ));
  }
  if (run.integrationBranch === undefined) {
    blockers.push(blocker(
      "source_branch_missing",
      `legacy ${run.status} run has no integration branch`,
    ));
  } else if (!isKoniRunRef(run.integrationBranch)) {
    blockers.push(blocker(
      "source_branch_mismatch",
      "legacy integration branch is outside the Koni run namespace",
    ));
  }
  if (blockers.length > 0 || run.integrationWorktree === undefined || run.integrationBranch === undefined) {
    return assessment(evidence.migrationId, run, blockers, undefined);
  }

  const worktree = path.resolve(run.integrationWorktree);
  const ownedWorktreeRoot = path.join(identity.commonDirectory, "koni", "worktrees");
  let metadata;
  try {
    metadata = await lstat(worktree);
  } catch (error) {
    return assessment(evidence.migrationId, run, [blocker(
      "source_worktree_missing",
      `legacy integration worktree is unavailable: ${errorMessage(error)}`,
    )], undefined);
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !isWithin(ownedWorktreeRoot, worktree) ||
    await realpath(worktree) !== worktree
  ) {
    return assessment(evidence.migrationId, run, [blocker(
      "source_worktree_unsafe",
      "legacy integration worktree is redirected or outside the Koni worktree namespace",
    )], undefined);
  }

  const worktrees = await repository.worktrees();
  const byPath = worktrees.filter((entry) => path.resolve(entry.path) === worktree);
  const byBranch = worktrees.filter((entry) => entry.branch === run.integrationBranch);
  if (byPath.length !== 1 || byBranch.length !== 1 || byPath[0] !== byBranch[0]) {
    return assessment(evidence.migrationId, run, [blocker(
      "source_worktree_unregistered",
      "legacy integration checkout registration is absent or ambiguous",
    )], undefined);
  }
  const branchOid = await repository.tryResolveRef(run.integrationBranch);
  if (branchOid === undefined) {
    return assessment(evidence.migrationId, run, [blocker(
      "source_branch_missing",
      `legacy integration branch no longer resolves: ${run.integrationBranch}`,
    )], undefined);
  }
  const checkout = new GitClient(worktree);
  const headOid = await checkout.resolveRef("HEAD");
  if (byPath[0]!.branch !== run.integrationBranch || byPath[0]!.head !== branchOid || headOid !== branchOid) {
    blockers.push(blocker(
      "source_branch_mismatch",
      "legacy integration branch, registration, and checkout HEAD disagree",
    ));
  }
  if ((await checkout.statusEntries()).length !== 0) {
    blockers.push(blocker(
      "source_worktree_dirty",
      "legacy integration worktree has uncommitted changes and remains untouched",
    ));
  }
  if (!await repository.isAncestor(run.baseCommit, branchOid)) {
    blockers.push(blocker(
      "source_history_invalid",
      "legacy integration branch is not descended from the pinned run base",
    ));
  }
  if (blockers.length > 0) return assessment(evidence.migrationId, run, blockers, undefined);

  const start: LegacyRunAdoptionStart = {
    targetRef: run.targetBranch!,
    targetSelectedOid: run.baseCommit,
    planningBaseOid: branchOid,
    sourceGit: {
      kind: "legacy_integration",
      branchRef: run.integrationBranch,
      worktree,
      headOid: branchOid,
    },
  };
  return assessment(evidence.migrationId, run, [], start);
}

function assessment(
  migrationId: string,
  run: LegacyRunSnapshot,
  blockers: LegacyRunAdoptionBlocker[],
  start: LegacyRunAdoptionStart | undefined,
): LegacyRunAdoptionAssessment {
  return {
    protocol: LEGACY_RUN_ADOPTION_PREVIEW_PROTOCOL,
    migrationId,
    runId: run.id,
    sourceStatus: run.status,
    objective: run.goal,
    runTypeId: run.runTypeId,
    targetRef: run.targetBranch,
    disposition: blockers.length === 0 && start !== undefined ? "ready" : "blocked",
    blockers: structuredClone(blockers),
    start: start === undefined ? undefined : structuredClone(start),
  };
}

function blockedAssessment(
  migrationId: string,
  run: LegacyRunSnapshot,
  entry: LegacyRunAdoptionBlocker,
): LegacyRunAdoptionAssessment {
  return assessment(migrationId, run, [entry], undefined);
}

function blocker(
  code: LegacyRunAdoptionBlocker["code"],
  message: string,
): LegacyRunAdoptionBlocker {
  return { code, message };
}

function blockerForLiveEvidence(error: unknown): LegacyRunAdoptionBlocker {
  if (error instanceof LegacyRunAdoptionError && error.code === "legacy_registry_changed") {
    return blocker("legacy_registry_changed", error.message);
  }
  return blocker(
    "project_identity_mismatch",
    `legacy migration no longer matches the authenticated repository: ${errorMessage(error)}`,
  );
}

async function authenticateLegacyRunPaths(
  projectRoot: string,
  plan: LegacyProjectMigrationPlan,
  compatibility: LegacyRunCompatibilityIndex,
): Promise<Awaited<ReturnType<typeof GitClient.discover>>> {
  let identity: Awaited<ReturnType<typeof GitClient.discover>>;
  try {
    identity = await GitClient.discover(projectRoot);
  } catch (error) {
    throw new LegacyRunAdoptionError(
      "project_identity_mismatch",
      `cannot discover the migration repository: ${errorMessage(error)}`,
    );
  }
  const expectedStateRoot = path.join(identity.commonDirectory, "koni");
  const expectedRegistryPath = path.join(expectedStateRoot, "project.yaml");
  const hasArchivedNamespace = plan.runs.commonDirectory !== undefined ||
    plan.runs.stateRoot !== undefined ||
    plan.runs.registryPath !== undefined ||
    plan.runs.runs.length > 0 ||
    compatibility.runs.length > 0;
  if (identity.worktreeRoot !== projectRoot) {
    throw new LegacyRunAdoptionError(
      "project_identity_mismatch",
      "legacy migration belongs to a different Git worktree",
    );
  }
  if (!hasArchivedNamespace) return identity;

  // Compare all untrusted archived strings before canonicalizing or opening any of them.
  if (
    plan.runs.commonDirectory !== identity.commonDirectory ||
    plan.runs.stateRoot !== expectedStateRoot ||
    plan.runs.registryPath !== expectedRegistryPath
  ) {
    throw new LegacyRunAdoptionError(
      "migration_evidence_path_mismatch",
      "legacy migration state paths do not match the authenticated Git common directory",
    );
  }
  for (const collection of [plan.runs.runs, compatibility.runs]) {
    for (const run of collection) {
      const expectedSourceRoot = path.join(expectedStateRoot, "runs", run.id);
      if (run.sourceRoot !== expectedSourceRoot) {
        throw new LegacyRunAdoptionError(
          "migration_evidence_path_mismatch",
          `legacy run ${run.id} source root does not match its authenticated run namespace`,
        );
      }
    }
  }

  if (
    plan.runs.runs.length > 0 ||
    plan.runs.registrySha256 !== null ||
    plan.runs.requiresBarrier
  ) {
    const canonicalStateRoot = await canonicalDirectory(
      expectedStateRoot,
      "migration_evidence_path_mismatch",
    );
    if (canonicalStateRoot !== expectedStateRoot) {
      throw new LegacyRunAdoptionError(
        "migration_evidence_path_mismatch",
        "legacy migration state root is redirected outside the authenticated Git common directory",
      );
    }
  }
  return identity;
}

async function verifyLiveLegacyRegistry(
  evidence: LoadedLegacyRunMigrationEvidence,
  identity: Awaited<ReturnType<typeof GitClient.discover>>,
): Promise<Sha256Digest> {
  const expected = evidence.compatibility.sourceRegistrySha256;
  if (expected === null) {
    throw new LegacyRunAdoptionError(
      "legacy_registry_changed",
      "legacy run migration does not bind a source registry",
    );
  }
  const stateRoot = path.join(identity.commonDirectory, "koni");
  const registryPath = path.join(stateRoot, "project.yaml");
  const stateIdentity = await stableDirectoryIdentity(stateRoot, "legacy_registry_changed");
  const bytes = await readStableLegacyRegistry(registryPath);
  await assertDirectoryIdentityCurrent(stateRoot, stateIdentity, "legacy_registry_changed");
  const actual = rawSha256(bytes);
  if (actual !== expected) {
    throw new LegacyRunAdoptionError(
      "legacy_registry_changed",
      "live legacy run registry bytes differ from the migration binding",
    );
  }
  return actual;
}

interface StableDirectoryIdentity {
  canonicalPath: string;
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

async function stableDirectoryIdentity(
  directory: string,
  code: string,
): Promise<StableDirectoryIdentity> {
  let before: Stats;
  let after: Stats;
  let canonicalPath: string;
  try {
    before = await lstat(directory);
    if (before.isSymbolicLink() || !before.isDirectory()) throw new Error("not a real directory");
    canonicalPath = await realpath(directory);
    after = await lstat(directory);
  } catch (error) {
    throw new LegacyRunAdoptionError(
      code,
      `legacy state directory is unavailable or unsafe: ${directory}: ${errorMessage(error)}`,
    );
  }
  if (
    canonicalPath !== directory ||
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    !sameIdentity(before, after)
  ) {
    throw new LegacyRunAdoptionError(
      code,
      `legacy state directory changed or was redirected: ${directory}`,
    );
  }
  return {
    canonicalPath,
    dev: before.dev,
    ino: before.ino,
    mode: before.mode,
    size: before.size,
    mtimeMs: before.mtimeMs,
    ctimeMs: before.ctimeMs,
  };
}

async function assertDirectoryIdentityCurrent(
  directory: string,
  expected: StableDirectoryIdentity,
  code: string,
): Promise<void> {
  const actual = await stableDirectoryIdentity(directory, code);
  if (
    actual.canonicalPath !== expected.canonicalPath ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.mode !== expected.mode ||
    actual.size !== expected.size ||
    actual.mtimeMs !== expected.mtimeMs ||
    actual.ctimeMs !== expected.ctimeMs
  ) {
    throw new LegacyRunAdoptionError(
      code,
      `legacy state directory changed while reading its registry: ${directory}`,
    );
  }
}

async function readStableLegacyRegistry(file: string): Promise<Buffer> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | noFollow);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_LEGACY_REGISTRY_BYTES) {
      throw new Error("registry is empty or oversized");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameIdentity(before, after) || bytes.byteLength !== before.size) {
      throw new Error("registry changed while reading");
    }
    return bytes;
  } catch (error) {
    throw new LegacyRunAdoptionError(
      "legacy_registry_changed",
      `live legacy run registry is unavailable or unstable: ${file}: ${errorMessage(error)}`,
    );
  } finally {
    await handle?.close();
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

async function readStableJson(file: string): Promise<{ value: unknown; bytes: Buffer }> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(file, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_MIGRATION_ARTIFACT_BYTES) {
      throw new LegacyRunAdoptionError(
        "migration_artifact_size",
        `legacy migration artifact is empty or oversized: ${file}`,
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new LegacyRunAdoptionError(
        "migration_artifact_changed",
        `legacy migration artifact changed while reading: ${file}`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new LegacyRunAdoptionError(
        "migration_artifact_json",
        `legacy migration artifact is not valid JSON: ${file}`,
      );
    }
    return { value, bytes };
  } finally {
    await handle.close();
  }
}

function parseReceipt(value: unknown): ArchivedMigrationReceipt {
  if (
    !isRecord(value) ||
    value.protocol !== "koni.legacy-project-migration-receipt.v1" ||
    typeof value.migrationId !== "string" ||
    typeof value.planSha256 !== "string" ||
    typeof value.sourceSnapshotSha256 !== "string" ||
    typeof value.runSnapshotSha256 !== "string" ||
    typeof value.targetBundleSha256 !== "string" ||
    value.sourceRetained !== true ||
    typeof value.appliedAt !== "string"
  ) {
    throw new LegacyRunAdoptionError(
      "migration_receipt_shape",
      "legacy migration receipt has an invalid shape",
    );
  }
  return value as unknown as ArchivedMigrationReceipt;
}

async function canonicalDirectory(input: string, code: string): Promise<string> {
  const absolute = path.resolve(input);
  try {
    const canonical = await realpath(absolute);
    const metadata = await lstat(canonical);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("not a real directory");
    return canonical;
  } catch (error) {
    throw new LegacyRunAdoptionError(code, `directory is unavailable or unsafe: ${absolute}: ${errorMessage(error)}`);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function isUserTargetRef(value: string): boolean {
  return value.startsWith("refs/heads/") &&
    !value.startsWith("refs/heads/koni/") &&
    value.length <= 1_024 &&
    !/[\u0000-\u0020~^:?*\\[\]]/u.test(value);
}

function isKoniRunRef(value: string): boolean {
  return value.startsWith("refs/heads/koni/runs/") &&
    value.length <= 1_024 &&
    !/[\u0000-\u0020~^:?*\\[\]]/u.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
