import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, type Stats } from "node:fs";
import { lstat, open, readFile, readdir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { ProfileBaselineFile } from "../contracts/profile-package.js";
import { compileProjectConfiguration } from "../compiler/configuration.js";
import { isNormalizedSafeRelativePath } from "../compiler/profile-package.js";
import { GitClient } from "../git/client.js";
import {
  canonicalHash,
  compareUtf8,
  isSha256Digest,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import {
  installProfile,
  loadProfilePackage,
  type ProfileInstallResult,
} from "./install.js";

export const LEGACY_PROJECT_MIGRATION_PROTOCOL = "koni.legacy-project-migration.v1" as const;
export const LEGACY_RUN_COMPATIBILITY_PROTOCOL = "koni.legacy-run-compatibility.v1" as const;
export const LEGACY_RUN_BARRIER_PROTOCOL = "koni.legacy-run-barrier.v1" as const;

const MAX_LEGACY_FILES = 200_000;
const MAX_LEGACY_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_LEGACY_CONFIG_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_LEGACY_RUN_FILE_BYTES = 512 * 1024 * 1024;
const MAX_LEGACY_RUN_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const LEGACY_IGNORED_CONFIG_FILES = new Set([
  "native-codex-resources.json",
  "resource-manifest.json",
  "migration-receipt.json",
]);

export type LegacyConfigKind = "codex_schema1" | "unmanaged_koni";
export type LegacyRunStatus =
  | "planning"
  | "approved"
  | "active"
  | "paused"
  | "concluded"
  | "stopped"
  | "failed";

export interface HashedLegacyFile {
  path: string;
  sha256: Sha256Digest;
  sizeBytes: number;
}

export interface LegacyConfigurationSnapshot {
  kind: LegacyConfigKind;
  sourceRoot: ".codex/koni" | ".koni";
  files: HashedLegacyFile[];
  externalAgents: HashedLegacyFile[];
  snapshotSha256: Sha256Digest;
}

export interface LegacyRunSnapshot {
  id: string;
  status: LegacyRunStatus;
  goal: string;
  profileId: string;
  profileVersion: string;
  profileHash?: string;
  runTypeId?: string;
  runTypeTitle?: string;
  runTypeHash?: string;
  questionPolicy?: string;
  targetBranch?: string;
  baseCommit: string;
  configSnapshotHash: string;
  configSnapshotPath?: string;
  planningWorktree?: string;
  planningReadOnly?: boolean;
  integrationBranch?: string;
  integrationWorktree?: string;
  createdAt: string;
  updatedAt: string;
  sourceRoot: string;
  treeSha256: Sha256Digest;
  fileCount: number;
  resumeDisposition:
    | "planning_paused"
    | "execution_paused"
    | "completed"
    | "stopped"
    | "failed";
}

export interface LegacyRunInspection {
  commonDirectory?: string;
  stateRoot?: string;
  registryPath?: string;
  registrySha256: Sha256Digest | null;
  selectedRunId?: string;
  runs: LegacyRunSnapshot[];
  requiresBarrier: boolean;
  snapshotSha256: Sha256Digest;
}

export interface LegacyProjectMigrationPlan {
  protocol: typeof LEGACY_PROJECT_MIGRATION_PROTOCOL;
  migrationId: string;
  projectRoot: string;
  profilePackageName: string;
  profileVersion: string;
  targetBundleSha256: Sha256Digest;
  configuration: LegacyConfigurationSnapshot;
  runs: LegacyRunInspection;
  transformedFiles: HashedLegacyFile[];
  createdAt: string;
  planSha256: Sha256Digest;
}

export interface LegacyRunBarrierRequest {
  protocol: typeof LEGACY_RUN_BARRIER_PROTOCOL;
  migrationId: string;
  projectRoot: string;
  commonDirectory?: string;
  registrySha256: Sha256Digest | null;
  runBindings: Array<{ id: string; status: LegacyRunStatus; treeSha256: Sha256Digest }>;
}

export interface LegacyRunBarrierEvidence extends LegacyRunBarrierRequest {
  quiescedAt: string;
  quiescedRunIds: string[];
  evidenceSha256: Sha256Digest;
}

/**
 * The runtime owns the actual pause/process/registry lock. This interface keeps
 * that lock held while the profile transaction executes.
 */
export interface LegacyRunMigrationAuthority {
  withQuiescedRuns<T>(
    request: LegacyRunBarrierRequest,
    publishWhileHeld: (evidence: LegacyRunBarrierEvidence) => Promise<T>,
  ): Promise<T>;
}

export interface LegacyRunCompatibilityIndex {
  protocol: typeof LEGACY_RUN_COMPATIBILITY_PROTOCOL;
  migrationId: string;
  projectRoot: string;
  sourceRegistrySha256: Sha256Digest | null;
  selectedRunId?: string;
  runs: LegacyRunSnapshot[];
  barrierEvidenceSha256?: Sha256Digest;
  generatedAt: string;
  sourceRetained: true;
}

export interface LegacyProjectMigrationResult {
  migrationId: string;
  install: ProfileInstallResult;
  receiptPath: string;
  compatibilityPath: string;
  sourceRetained: true;
}

export interface PlanLegacyProjectMigrationOptions {
  projectRoot: string;
  profilePackageRoot: string;
  migrationId?: string;
  /** Tests/non-Git imports may explicitly disable Git-side run inspection. */
  inspectRuns?: boolean;
}

export interface ApplyLegacyProjectMigrationOptions {
  profilePackageRoot: string;
  runAuthority?: LegacyRunMigrationAuthority;
}

/**
 * Test/diagnostic observer for deterministic filesystem-race proofs. It can only add work between
 * identity capture and traversal; it cannot skip or weaken any production verification.
 */
export interface LegacyTreeVerificationObserver {
  afterDirectoryIdentity?(input: Readonly<{ directory: string; depth: number }>): void | Promise<void>;
}

export class LegacyProjectMigrationError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "LegacyProjectMigrationError";
    this.code = code;
  }
}

/** Inspect and compile a completely read-only, hash-bound migration plan. */
export async function planLegacyProjectMigration(
  options: PlanLegacyProjectMigrationOptions,
): Promise<LegacyProjectMigrationPlan> {
  return planLegacyProjectMigrationWithId(options, options.migrationId ?? randomUUID());
}

/**
 * Publish a guarded migration. Legacy config and run state are retained in
 * place; exact source bytes and compatibility bindings are archived in the
 * same `.koni` transaction as the new managed profile.
 */
export async function applyLegacyProjectMigration(
  plan: LegacyProjectMigrationPlan,
  options: ApplyLegacyProjectMigrationOptions,
): Promise<LegacyProjectMigrationResult> {
  assertMigrationPlanShape(plan);
  const baseline = await loadProfilePackage(options.profilePackageRoot);
  if (baseline.manifest.bundle_sha256 !== plan.targetBundleSha256) {
    throw new LegacyProjectMigrationError("profile_package_changed", "profile package differs from the migration plan");
  }
  const sourceSnapshot = await inspectLegacyConfiguration(plan.projectRoot);
  if (sourceSnapshot.snapshotSha256 !== plan.configuration.snapshotSha256) {
    throw new LegacyProjectMigrationError(
      "migration_source_changed",
      "legacy configuration changed after migration planning",
    );
  }
  const runSnapshot = plan.runs.commonDirectory === undefined
    ? emptyRunInspection()
    : await inspectLegacyRuns(plan.projectRoot, true);
  if (runSnapshot.snapshotSha256 !== plan.runs.snapshotSha256) {
    throw new LegacyProjectMigrationError("migration_source_changed", "legacy run state changed after migration planning");
  }
  const current = await planLegacyProjectMigrationWithId(
    {
      projectRoot: plan.projectRoot,
      profilePackageRoot: options.profilePackageRoot,
      migrationId: plan.migrationId,
      inspectRuns: plan.runs.commonDirectory !== undefined,
    },
    plan.migrationId,
  );
  if (current.planSha256 !== plan.planSha256) {
    throw new LegacyProjectMigrationError(
      "migration_source_changed",
      "legacy configuration, package, or run state changed after migration planning",
    );
  }

  const publish = async (barrier?: LegacyRunBarrierEvidence): Promise<LegacyProjectMigrationResult> => {
    if (plan.runs.requiresBarrier) {
      if (barrier === undefined) throw new LegacyProjectMigrationError("run_barrier_required", "legacy run state requires a held migration barrier");
      assertLegacyRunBarrierEvidence(plan, barrier);
      const held = await inspectLegacyRuns(plan.projectRoot, true);
      if (held.snapshotSha256 !== plan.runs.snapshotSha256) {
        throw new LegacyProjectMigrationError("legacy_runs_changed", "legacy run registry changed before profile publication");
      }
    }
    const transformed = await transformLegacyConfiguration(plan, options.profilePackageRoot);
    const compatibility = createCompatibilityIndex(plan, barrier);
    const migrationRoot = `.managed/migrations/${plan.migrationId}`;
    const artifacts = new Map<string, Uint8Array>();
    const sourceRoot = path.join(plan.projectRoot, plan.configuration.sourceRoot);
    for (const descriptor of plan.configuration.files) {
      artifacts.set(`${migrationRoot}/legacy-config/${descriptor.path}`, await readVerified(sourceRoot, descriptor));
    }
    const codexRoot = path.join(plan.projectRoot, ".codex");
    for (const descriptor of plan.configuration.externalAgents) {
      artifacts.set(`${migrationRoot}/legacy-agents/${descriptor.path}`, await readVerified(codexRoot, descriptor));
    }
    artifacts.set(`${migrationRoot}/plan.json`, jsonBytes(plan));
    artifacts.set(`${migrationRoot}/legacy-runs.json`, jsonBytes(compatibility));
    if (barrier !== undefined) artifacts.set(`${migrationRoot}/run-barrier.json`, jsonBytes(barrier));
    const receipt = {
      protocol: "koni.legacy-project-migration-receipt.v1",
      migrationId: plan.migrationId,
      planSha256: plan.planSha256,
      sourceSnapshotSha256: plan.configuration.snapshotSha256,
      runSnapshotSha256: plan.runs.snapshotSha256,
      targetBundleSha256: plan.targetBundleSha256,
      sourceRetained: true,
      appliedAt: new Date().toISOString(),
    } as const;
    artifacts.set(`${migrationRoot}/receipt.json`, jsonBytes(receipt));
    const install = await installProfile(plan.projectRoot, options.profilePackageRoot, {
      migrationId: plan.migrationId,
      migrationOverlay: transformed,
      migrationArtifacts: artifacts,
    });
    return {
      migrationId: plan.migrationId,
      install,
      receiptPath: `.koni/${migrationRoot}/receipt.json`,
      compatibilityPath: `.koni/${migrationRoot}/legacy-runs.json`,
      sourceRetained: true,
    };
  };

  if (!plan.runs.requiresBarrier) return publish();
  if (options.runAuthority === undefined) {
    throw new LegacyProjectMigrationError(
      "run_authority_required",
      "pause/quiesce the legacy runs through the owning authority before applying this migration",
    );
  }
  return options.runAuthority.withQuiescedRuns(createBarrierRequest(plan), publish);
}

/** Verify a migrated legacy run tree immediately before a compatibility resume. */
export async function verifyLegacyRunCompatibility(
  index: LegacyRunCompatibilityIndex,
  runId: string,
  observer: LegacyTreeVerificationObserver = {},
): Promise<LegacyRunSnapshot> {
  if (index.protocol !== LEGACY_RUN_COMPATIBILITY_PROTOCOL) {
    throw new LegacyProjectMigrationError("compatibility_protocol", "legacy run compatibility protocol is unsupported");
  }
  const run = index.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) throw new LegacyProjectMigrationError("legacy_run_missing", `legacy run is not indexed: ${runId}`);
  const root = path.resolve(run.sourceRoot);
  const actual = await hashTree(root, root, () => true, undefined, observer);
  if (actual.treeSha256 !== run.treeSha256 || actual.files.length !== run.fileCount) {
    throw new LegacyProjectMigrationError("legacy_run_changed", `legacy run state changed after migration: ${runId}`);
  }
  return structuredClone(run);
}

/** Validate compatibility bytes before an authority treats them as adoption evidence. */
export function assertLegacyRunCompatibilityIndex(
  value: unknown,
): asserts value is LegacyRunCompatibilityIndex {
  if (
    !isRecord(value) ||
    value.protocol !== LEGACY_RUN_COMPATIBILITY_PROTOCOL ||
    typeof value.migrationId !== "string" ||
    !isSafeMigrationId(value.migrationId) ||
    typeof value.projectRoot !== "string" ||
    !path.isAbsolute(value.projectRoot) ||
    (value.sourceRegistrySha256 !== null && !isSha256Digest(value.sourceRegistrySha256)) ||
    (value.selectedRunId !== undefined && typeof value.selectedRunId !== "string") ||
    !Array.isArray(value.runs) ||
    (value.barrierEvidenceSha256 !== undefined && !isSha256Digest(value.barrierEvidenceSha256)) ||
    typeof value.generatedAt !== "string" ||
    value.generatedAt.length === 0 ||
    value.sourceRetained !== true
  ) {
    throw new LegacyProjectMigrationError(
      "compatibility_shape",
      "legacy run compatibility index has an invalid shape",
    );
  }
  const ids = new Set<string>();
  for (const run of value.runs) {
    assertLegacyRunSnapshot(run);
    if (ids.has(run.id)) {
      throw new LegacyProjectMigrationError(
        "compatibility_shape",
        `legacy run compatibility index repeats ${run.id}`,
      );
    }
    ids.add(run.id);
  }
  if (value.selectedRunId !== undefined && !ids.has(value.selectedRunId)) {
    throw new LegacyProjectMigrationError(
      "compatibility_shape",
      "legacy run compatibility selection is not present in the index",
    );
  }
}

/** Validate the exact archived migration plan and its self-authenticating digest. */
export function assertLegacyProjectMigrationPlan(
  value: unknown,
): asserts value is LegacyProjectMigrationPlan {
  if (
    !isRecord(value) ||
    value.protocol !== LEGACY_PROJECT_MIGRATION_PROTOCOL ||
    typeof value.migrationId !== "string" ||
    !isSafeMigrationId(value.migrationId) ||
    typeof value.projectRoot !== "string" ||
    !path.isAbsolute(value.projectRoot) ||
    typeof value.profilePackageName !== "string" ||
    value.profilePackageName.length === 0 ||
    typeof value.profileVersion !== "string" ||
    value.profileVersion.length === 0 ||
    !isSha256Digest(value.targetBundleSha256) ||
    !isRecord(value.configuration) ||
    !isRecord(value.runs) ||
    !Array.isArray(value.transformedFiles) ||
    typeof value.createdAt !== "string" ||
    value.createdAt.length === 0 ||
    !isSha256Digest(value.planSha256)
  ) {
    throw new LegacyProjectMigrationError("migration_plan", "legacy migration plan has an invalid shape");
  }
  assertLegacyRunInspection(value.runs);
  const descriptors = value.transformedFiles;
  for (const descriptor of descriptors) assertHashedLegacyFile(descriptor, "transformed file");
  const { createdAt: _createdAt, planSha256: _planSha256, ...material } = value;
  if (canonicalHash(material) !== value.planSha256) {
    throw new LegacyProjectMigrationError("migration_plan_hash", "legacy migration plan was modified");
  }
}

async function planLegacyProjectMigrationWithId(
  options: PlanLegacyProjectMigrationOptions,
  migrationId: string,
): Promise<LegacyProjectMigrationPlan> {
  validateMigrationId(migrationId);
  const projectRoot = await canonicalRealDirectory(options.projectRoot, "project_root");
  const baseline = await loadProfilePackage(options.profilePackageRoot);
  const configuration = await inspectLegacyConfiguration(projectRoot);
  const transformed = await transformLegacyConfigurationMaterial(configuration, projectRoot, baseline);
  verifyProfileIdentity(transformed, baseline.manifest.profile.id, baseline.manifest.profile.version);
  validateTransformedConfiguration(transformed, baseline);
  const runs = options.inspectRuns === false
    ? emptyRunInspection()
    : await inspectLegacyRuns(projectRoot, false);
  const transformedFiles = [...transformed]
    .flatMap(([relative, bytes]) => bytes === null
      ? []
      : [{ path: relative, sha256: rawSha256(bytes), sizeBytes: bytes.byteLength }])
    .sort((left, right) => compareUtf8(left.path, right.path));
  const material = {
    protocol: LEGACY_PROJECT_MIGRATION_PROTOCOL,
    migrationId,
    projectRoot,
    profilePackageName: baseline.manifest.package.name,
    profileVersion: baseline.manifest.profile.version,
    targetBundleSha256: baseline.manifest.bundle_sha256,
    configuration,
    runs,
    transformedFiles,
  } as const;
  return {
    ...material,
    createdAt: new Date().toISOString(),
    planSha256: canonicalHash(material),
  };
}

async function inspectLegacyConfiguration(projectRoot: string): Promise<LegacyConfigurationSnapshot> {
  const codex = path.join(projectRoot, ".codex", "koni");
  const koni = path.join(projectRoot, ".koni");
  const codexExists = await realDirectoryExists(codex);
  const koniExists = await realDirectoryExists(koni);
  const managedInstallExists = koniExists && await regularFileExists(path.join(koni, ".managed", "install.json"));
  if (managedInstallExists) throw new LegacyProjectMigrationError("already_managed", "project already has a managed Pi-native profile");
  if (codexExists && koniExists) {
    throw new LegacyProjectMigrationError("ambiguous_config", "both legacy .codex/koni and unmanaged .koni exist; resolve the duplicate source explicitly");
  }
  if (!codexExists && !koniExists) throw new LegacyProjectMigrationError("legacy_config_missing", "project has no legacy Koni configuration");
  const kind: LegacyConfigKind = codexExists ? "codex_schema1" : "unmanaged_koni";
  const sourceRoot = codexExists ? ".codex/koni" as const : ".koni" as const;
  const root = codexExists ? codex : koni;
  const tree = await hashTree(
    root,
    root,
    (relative) =>
      !LEGACY_IGNORED_CONFIG_FILES.has(relative) &&
      !relative.startsWith(".managed/") &&
      !relative.startsWith(".transactions/") &&
      !relative.startsWith("runs/"),
    { maxFileBytes: MAX_LEGACY_CONFIG_BYTES, maxTotalBytes: MAX_LEGACY_CONFIG_TOTAL_BYTES },
  );
  if (tree.files.length === 0 || !tree.files.some((file) => file.path === "profile.yaml")) {
    throw new LegacyProjectMigrationError("legacy_config_invalid", "legacy configuration is empty or lacks profile.yaml");
  }
  const externalAgents = kind === "codex_schema1"
    ? await discoverReferencedLegacyAgents(projectRoot, root)
    : [];
  const totalConfigBytes = [...tree.files, ...externalAgents]
    .reduce((total, file) => total + file.sizeBytes, 0);
  if (!Number.isSafeInteger(totalConfigBytes) || totalConfigBytes > MAX_LEGACY_CONFIG_TOTAL_BYTES) {
    throw new LegacyProjectMigrationError("legacy_config_size", "legacy configuration exceeds the total byte limit");
  }
  return {
    kind,
    sourceRoot,
    files: tree.files,
    externalAgents,
    snapshotSha256: canonicalHash({ kind, sourceRoot, files: tree.files, externalAgents }),
  };
}

async function transformLegacyConfiguration(
  plan: LegacyProjectMigrationPlan,
  profilePackageRoot: string,
): Promise<Map<string, Uint8Array | null>> {
  const baseline = await loadProfilePackage(profilePackageRoot);
  if (baseline.manifest.bundle_sha256 !== plan.targetBundleSha256) {
    throw new LegacyProjectMigrationError("profile_package_changed", "profile package differs from the migration plan");
  }
  return transformLegacyConfigurationMaterial(plan.configuration, plan.projectRoot, baseline);
}

async function transformLegacyConfigurationMaterial(
  snapshot: LegacyConfigurationSnapshot,
  projectRoot: string,
  baseline: Awaited<ReturnType<typeof loadProfilePackage>>,
): Promise<Map<string, Uint8Array | null>> {
  const root = path.join(projectRoot, snapshot.sourceRoot);
  const output = new Map<string, Uint8Array | null>();
  for (const descriptor of snapshot.files) {
    const bytes = await readVerified(root, descriptor);
    if (snapshot.kind === "codex_schema1" && /\.ya?ml$/u.test(descriptor.path)) {
      output.set(
        descriptor.path,
        transformYaml(
          bytes,
          descriptor.path,
          baseline.manifest.profile.version,
          baseline.files.get(descriptor.path),
        ),
      );
    } else {
      output.set(descriptor.path, bytes);
    }
  }
  if (snapshot.kind === "codex_schema1") {
    const codexRoot = path.join(projectRoot, ".codex");
    for (const descriptor of snapshot.externalAgents) {
      const bytes = await readVerified(codexRoot, descriptor);
      const resource = convertLegacyAgentToml(Buffer.from(bytes).toString("utf8"), descriptor.path);
      const destination = `agents/${resource.id}.yaml`;
      if (output.has(destination)) throw new LegacyProjectMigrationError("agent_collision", `legacy agent collides with config path: ${destination}`);
      output.set(destination, Buffer.from(YAML.stringify(resource), "utf8"));
    }
  }
  return output;
}

function transformYaml(
  bytes: Uint8Array,
  relative: string,
  targetProfileVersion: string,
  baselineBytes?: Uint8Array,
): Uint8Array {
  let value: unknown;
  try {
    value = YAML.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new LegacyProjectMigrationError("legacy_yaml", `invalid legacy YAML ${relative}: ${String(error)}`);
  }
  if (!isRecord(value)) return bytes;
  if (value.schema_version === "1.0") value.schema_version = "2.0";
  else if (value.schema_version !== undefined && value.schema_version !== "2.0") {
    throw new LegacyProjectMigrationError("legacy_schema", `${relative} has unsupported schema_version`);
  }
  if (relative === "profile.yaml" && isRecord(value.profile)) {
    value.profile.version = targetProfileVersion;
  }
  if (isRecord(value.profile) && typeof value.profile.source === "string") {
    value.profile.source = value.profile.source.replace(/^\.codex\/koni\//u, ".koni/");
  }
  if (Array.isArray(value.personas)) {
    for (const persona of value.personas) {
      if (!isRecord(persona)) throw new LegacyProjectMigrationError("legacy_persona", `${relative} contains a non-object persona`);
      renameKey(persona, "codex_agent", "agent", relative);
      renameKey(persona, "reasoning_effort", "thinking_level", relative);
      if (persona.sandbox !== undefined) {
        if (persona.capabilities !== undefined || !isRecord(persona.sandbox)) {
          throw new LegacyProjectMigrationError("legacy_sandbox", `${relative} contains an ambiguous sandbox/capability policy`);
        }
        persona.capabilities = convertSandbox(persona.sandbox, relative);
        delete persona.sandbox;
      }
    }
  }
  if (isRecord(value.agents) && isRecord(value.agents.roles)) {
    for (const role of Object.values(value.agents.roles)) {
      if (isRecord(role)) renameKey(role, "reasoning_effort", "thinking_level", relative);
    }
  }
  if (baselineBytes !== undefined) {
    let baselineValue: unknown;
    try { baselineValue = YAML.parse(Buffer.from(baselineBytes).toString("utf8")); }
    catch (error) { throw new LegacyProjectMigrationError("baseline_yaml", `invalid package YAML ${relative}: ${String(error)}`); }
    if (isRecord(baselineValue)) {
      const merged = mergeLegacyOntoBaseline(baselineValue, value);
      normalizeMergedPipelineOrder(merged, baselineValue);
      value = merged;
    }
  }
  return Buffer.from(YAML.stringify(value), "utf8");
}

function mergeLegacyOntoBaseline(
  baseline: Record<string, unknown>,
  legacy: Record<string, unknown>,
): Record<string, unknown> {
  const merged = structuredClone(baseline);
  for (const [key, legacyValue] of Object.entries(legacy)) {
    const baselineValue = merged[key];
    if (isRecord(baselineValue) && isRecord(legacyValue)) {
      merged[key] = mergeLegacyOntoBaseline(baselineValue, legacyValue);
    } else if (isIdentifiedRecordArray(baselineValue) && isIdentifiedRecordArray(legacyValue)) {
      merged[key] = mergeIdentifiedRecordArrays(baselineValue, legacyValue);
    } else {
      merged[key] = structuredClone(legacyValue);
    }
  }
  return merged;
}

function isIdentifiedRecordArray(value: unknown): value is Array<Record<string, unknown> & { id: string }> {
  return Array.isArray(value) && value.every((entry) => isRecord(entry) && typeof entry.id === "string");
}

function mergeIdentifiedRecordArrays(
  baseline: Array<Record<string, unknown> & { id: string }>,
  legacy: Array<Record<string, unknown> & { id: string }>,
): Array<Record<string, unknown>> {
  const legacyById = new Map(legacy.map((entry) => [entry.id, entry] as const));
  const merged = baseline.map((entry) => {
    const override = legacyById.get(entry.id);
    if (override === undefined) return structuredClone(entry);
    legacyById.delete(entry.id);
    return mergeLegacyOntoBaseline(entry, override);
  });
  for (const entry of legacy) if (legacyById.has(entry.id)) merged.push(structuredClone(entry));
  return merged;
}

function normalizeMergedPipelineOrder(
  merged: Record<string, unknown>,
  baseline: Record<string, unknown>,
): void {
  if (!isRecord(merged.pipeline) || !isRecord(merged.pipeline.stages) || !Array.isArray(merged.pipeline.order)) return;
  const order = merged.pipeline.order.filter((entry): entry is string => typeof entry === "string");
  const baselineOrder = isRecord(baseline.pipeline) && Array.isArray(baseline.pipeline.order)
    ? baseline.pipeline.order.filter((entry): entry is string => typeof entry === "string")
    : [];
  const stageIds = Object.keys(merged.pipeline.stages);
  for (const stage of [...baselineOrder, ...stageIds]) if (!order.includes(stage)) order.push(stage);
  merged.pipeline.order = order;
}

function convertSandbox(sandbox: Record<string, unknown>, source: string): Record<string, unknown> {
  const mode = sandbox.mode ?? "workspace-write";
  if (mode !== "read-only" && mode !== "read_only" && mode !== "workspace-write" && mode !== "workspace_write") {
    throw new LegacyProjectMigrationError("legacy_sandbox", `${source} uses unsupported sandbox mode ${String(mode)}`);
  }
  if (sandbox.approval_policy !== undefined && sandbox.approval_policy !== "never") {
    throw new LegacyProjectMigrationError("legacy_approval", `${source} delegates approval to the provider`);
  }
  if (sandbox.writable_roots !== undefined && !Array.isArray(sandbox.writable_roots)) {
    throw new LegacyProjectMigrationError("legacy_writable_roots", `${source} has invalid writable_roots`);
  }
  return {
    workspace_access: mode === "read-only" || mode === "read_only" ? "read_only" : "workspace_write",
    commands: mode === "read-only" || mode === "read_only" ? "read_only" : "workspace_write",
    network_access: sandbox.network_access === true,
    ...(Array.isArray(sandbox.writable_roots) && sandbox.writable_roots.length > 0
      ? { writable_roots: sandbox.writable_roots }
      : {}),
  };
}

async function discoverReferencedLegacyAgents(projectRoot: string, configRoot: string): Promise<HashedLegacyFile[]> {
  const personasPath = path.join(configRoot, "personas.yaml");
  if (!await regularFileExists(personasPath)) return [];
  const value = YAML.parse(await readFile(personasPath, "utf8")) as unknown;
  if (!isRecord(value) || !Array.isArray(value.personas)) return [];
  const ids = new Set<string>();
  for (const persona of value.personas) {
    if (!isRecord(persona)) continue;
    const id = persona.codex_agent ?? persona.agent;
    if (typeof id === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(id)) ids.add(id);
  }
  const results: HashedLegacyFile[] = [];
  for (const id of [...ids].sort(compareUtf8)) {
    const relative = `agents/${id}.toml`;
    const absolute = path.join(projectRoot, ".codex", relative);
    if (!await regularFileExists(absolute)) continue;
    const hashed = await hashFile(absolute, MAX_LEGACY_CONFIG_BYTES);
    results.push({ path: relative, sha256: hashed.sha256, sizeBytes: hashed.sizeBytes });
  }
  return results;
}

function convertLegacyAgentToml(source: string, sourcePath: string): Record<string, unknown> {
  const values = parseFlatLegacyToml(source, sourcePath);
  const id = values.name;
  const description = values.description;
  const instructions = values.developer_instructions;
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(id) || typeof description !== "string" || typeof instructions !== "string") {
    throw new LegacyProjectMigrationError("legacy_agent", `${sourcePath} lacks a valid name, description, or developer_instructions`);
  }
  const mode = values.sandbox_mode;
  if (mode !== undefined && mode !== "read-only" && mode !== "workspace-write") {
    throw new LegacyProjectMigrationError("legacy_agent_sandbox", `${sourcePath} uses unsupported sandbox_mode`);
  }
  return {
    schema_version: "2.0",
    id,
    description,
    instructions: { source: "inline", text: instructions },
    ...(Array.isArray(values.nickname_candidates) && values.nickname_candidates.length > 0
      ? { aliases: values.nickname_candidates }
      : {}),
    provider: "openai-codex",
    ...(typeof values.model === "string" ? { model: values.model } : {}),
    ...(typeof values.model_reasoning_effort === "string"
      ? { thinking_level: migrateThinkingLevel(values.model_reasoning_effort, sourcePath) }
      : {}),
    capabilities: {
      workspace_access: mode === "read-only" ? "read_only" : "workspace_write",
      commands: mode === "read-only" ? "read_only" : "workspace_write",
      network_access: false,
    },
  };
}

function parseFlatLegacyToml(source: string, sourcePath: string): Record<string, unknown> {
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let cursor = 0;
  const lines = source.split(/\r?\n/u);
  while (cursor < lines.length) {
    const raw = lines[cursor++]!;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/u.exec(line);
    if (match === null) throw new LegacyProjectMigrationError("legacy_agent_toml", `${sourcePath} contains unsupported TOML at line ${cursor}`);
    const key = match[1]!;
    let encoded = match[2]!;
    if (encoded.startsWith('"""')) {
      encoded = encoded.slice(3);
      const chunks: string[] = [];
      const immediateEnd = encoded.indexOf('"""');
      if (immediateEnd >= 0) {
        chunks.push(encoded.slice(0, immediateEnd));
      } else {
        if (encoded.length > 0) chunks.push(encoded);
        let closed = false;
        while (cursor < lines.length) {
          const continuation = lines[cursor++]!;
          const end = continuation.indexOf('"""');
          if (end >= 0) {
            chunks.push(continuation.slice(0, end));
            closed = true;
            break;
          }
          chunks.push(continuation);
        }
        if (!closed) throw new LegacyProjectMigrationError("legacy_agent_toml", `${sourcePath} has an unterminated multiline string`);
      }
      values[key] = chunks.join("\n").replace(/^\n/u, "");
    } else if (encoded.startsWith('"')) {
      try { values[key] = JSON.parse(encoded); }
      catch { throw new LegacyProjectMigrationError("legacy_agent_toml", `${sourcePath} has an invalid string for ${key}`); }
    } else if (encoded.startsWith("[")) {
      try { values[key] = JSON.parse(encoded); }
      catch { throw new LegacyProjectMigrationError("legacy_agent_toml", `${sourcePath} has an invalid array for ${key}`); }
    } else if (encoded === "true" || encoded === "false") {
      values[key] = encoded === "true";
    } else {
      throw new LegacyProjectMigrationError("legacy_agent_toml", `${sourcePath} uses unsupported TOML value for ${key}`);
    }
  }
  return values;
}

async function inspectLegacyRuns(projectRoot: string, required: boolean): Promise<LegacyRunInspection> {
  let identity;
  try {
    identity = await GitClient.discover(projectRoot);
  } catch (error) {
    if (!required) return emptyRunInspection();
    throw error;
  }
  const stateRoot = path.join(identity.commonDirectory, "koni");
  const registryPath = path.join(stateRoot, "project.yaml");
  if (!await regularFileExists(registryPath)) {
    const requiresBarrier = await realDirectoryExists(stateRoot);
    const material = {
      commonDirectory: identity.commonDirectory,
      stateRoot,
      registryPath,
      registrySha256: null,
      runs: [] as LegacyRunSnapshot[],
      requiresBarrier,
    };
    return { ...material, snapshotSha256: canonicalHash(material) };
  }
  const registryBytes = await readStableLegacyFile(
    registryPath,
    MAX_LEGACY_CONFIG_TOTAL_BYTES,
    "legacy_registry_changed",
  );
  let registry: unknown;
  try { registry = YAML.parse(registryBytes.toString("utf8")); }
  catch (error) { throw new LegacyProjectMigrationError("legacy_registry_yaml", `legacy run registry is invalid: ${String(error)}`); }
  if (!isRecord(registry) || !isRecord(registry.runs)) {
    throw new LegacyProjectMigrationError("legacy_registry_shape", "legacy run registry has an invalid shape");
  }
  const runs: LegacyRunSnapshot[] = [];
  for (const [runId, value] of Object.entries(registry.runs).sort(([left], [right]) => compareUtf8(left, right))) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId) || !isRecord(value)) {
      throw new LegacyProjectMigrationError("legacy_run_shape", `legacy run registry entry is invalid: ${runId}`);
    }
    const status = parseLegacyRunStatus(value.status, runId);
    const sourceRoot = path.join(stateRoot, "runs", runId);
    const tree = await hashTree(sourceRoot, sourceRoot);
    runs.push({
      id: runId,
      status,
      goal: requiredString(value.goal, runId, "goal"),
      profileId: requiredString(value.profile_id, runId, "profile_id"),
      profileVersion: requiredString(value.profile_version, runId, "profile_version"),
      ...(typeof value.profile_hash === "string" ? { profileHash: value.profile_hash } : {}),
      ...(typeof value.run_type_id === "string" ? { runTypeId: value.run_type_id } : {}),
      ...(typeof value.run_type_title === "string" ? { runTypeTitle: value.run_type_title } : {}),
      ...(typeof value.run_type_hash === "string" ? { runTypeHash: value.run_type_hash } : {}),
      ...(typeof value.question_policy === "string" ? { questionPolicy: value.question_policy } : {}),
      ...(typeof value.target_branch === "string" ? { targetBranch: value.target_branch } : {}),
      baseCommit: requiredString(value.base_commit, runId, "base_commit"),
      configSnapshotHash: requiredString(value.config_snapshot_hash, runId, "config_snapshot_hash"),
      ...(typeof value.config_snapshot_path === "string"
        ? { configSnapshotPath: value.config_snapshot_path }
        : {}),
      ...(typeof value.planning_worktree === "string"
        ? { planningWorktree: value.planning_worktree }
        : {}),
      ...(typeof value.planning_read_only === "boolean"
        ? { planningReadOnly: value.planning_read_only }
        : {}),
      ...(typeof value.integration_branch === "string"
        ? { integrationBranch: value.integration_branch }
        : {}),
      ...(typeof value.integration_worktree === "string"
        ? { integrationWorktree: value.integration_worktree }
        : {}),
      createdAt: requiredString(value.created_at, runId, "created_at"),
      updatedAt: requiredString(value.updated_at, runId, "updated_at"),
      sourceRoot,
      treeSha256: tree.treeSha256,
      fileCount: tree.files.length,
      resumeDisposition: resumeDisposition(status),
    });
  }
  const material = {
    commonDirectory: identity.commonDirectory,
    stateRoot,
    registryPath,
    registrySha256: rawSha256(registryBytes),
    ...(typeof registry.selected_run === "string" ? { selectedRunId: registry.selected_run } : {}),
    runs,
    requiresBarrier: true,
  };
  return { ...material, snapshotSha256: canonicalHash(material) };
}

function emptyRunInspection(): LegacyRunInspection {
  const material = { registrySha256: null, runs: [] as LegacyRunSnapshot[], requiresBarrier: false };
  return { ...material, snapshotSha256: canonicalHash(material) };
}

function validateTransformedConfiguration(
  transformed: ReadonlyMap<string, Uint8Array | null>,
  baseline: Awaited<ReturnType<typeof loadProfilePackage>>,
): void {
  const contents = new Map<string, Uint8Array>();
  for (const [relative, bytes] of baseline.files) contents.set(relative, Uint8Array.from(bytes));
  for (const [relative, bytes] of transformed) {
    if (bytes === null) contents.delete(relative);
    else contents.set(relative, Uint8Array.from(bytes));
  }
  const baselineByPath = new Map(baseline.manifest.baseline.files.map((file) => [file.path, file] as const));
  const files: ProfileBaselineFile[] = [...contents]
    .map(([relative, bytes]) => ({
      path: relative,
      sha256: rawSha256(bytes),
      size_bytes: bytes.byteLength,
      kind: baselineByPath.get(relative)?.kind ?? classifyMigratedPath(relative),
    }))
    .sort((left, right) => compareUtf8(left.path, right.path));
  const result = compileProjectConfiguration({ manifest: baseline.manifest, files, contents });
  if (!result.ok) {
    throw new LegacyProjectMigrationError(
      "migration_compile",
      result.diagnostics.map((diagnostic) => `${diagnostic.path}:${diagnostic.code}:${diagnostic.message}`).join("\n"),
    );
  }
}

function verifyProfileIdentity(
  transformed: ReadonlyMap<string, Uint8Array | null>,
  profileId: string,
  profileVersion: string,
): void {
  const bytes = transformed.get("profile.yaml");
  if (bytes === undefined || bytes === null) throw new LegacyProjectMigrationError("profile_missing", "migrated profile.yaml is missing");
  const value = YAML.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  if (!isRecord(value) || !isRecord(value.profile) || value.profile.id !== profileId || value.profile.version !== profileVersion) {
    throw new LegacyProjectMigrationError("profile_identity", "legacy profile lineage does not match the selected profile package");
  }
}

function createBarrierRequest(plan: LegacyProjectMigrationPlan): LegacyRunBarrierRequest {
  return {
    protocol: LEGACY_RUN_BARRIER_PROTOCOL,
    migrationId: plan.migrationId,
    projectRoot: plan.projectRoot,
    ...(plan.runs.commonDirectory === undefined ? {} : { commonDirectory: plan.runs.commonDirectory }),
    registrySha256: plan.runs.registrySha256,
    runBindings: plan.runs.runs.map((run) => ({ id: run.id, status: run.status, treeSha256: run.treeSha256 })),
  };
}

export function assertLegacyRunBarrierEvidence(
  plan: LegacyProjectMigrationPlan,
  evidence: unknown,
): asserts evidence is LegacyRunBarrierEvidence {
  if (
    !isRecord(evidence) ||
    evidence.protocol !== LEGACY_RUN_BARRIER_PROTOCOL ||
    typeof evidence.migrationId !== "string" ||
    typeof evidence.projectRoot !== "string" ||
    (evidence.commonDirectory !== undefined && typeof evidence.commonDirectory !== "string") ||
    (evidence.registrySha256 !== null && !isSha256Digest(evidence.registrySha256)) ||
    !Array.isArray(evidence.runBindings) ||
    typeof evidence.quiescedAt !== "string" ||
    !Array.isArray(evidence.quiescedRunIds) ||
    evidence.quiescedRunIds.some((id) => typeof id !== "string") ||
    !isSha256Digest(evidence.evidenceSha256)
  ) {
    throw new LegacyProjectMigrationError(
      "run_barrier_invalid",
      "legacy run barrier evidence has an invalid shape",
    );
  }
  for (const binding of evidence.runBindings) {
    if (
      !isRecord(binding) ||
      typeof binding.id !== "string" ||
      !["planning", "approved", "active", "paused", "concluded", "stopped", "failed"]
        .includes(String(binding.status)) ||
      !isSha256Digest(binding.treeSha256)
    ) {
      throw new LegacyProjectMigrationError(
        "run_barrier_invalid",
        "legacy run barrier contains an invalid run binding",
      );
    }
  }
  const request = createBarrierRequest(plan);
  const material = { ...evidence };
  delete (material as { evidenceSha256?: unknown }).evidenceSha256;
  if (
    evidence.protocol !== request.protocol ||
    evidence.migrationId !== request.migrationId ||
    evidence.projectRoot !== request.projectRoot ||
    evidence.commonDirectory !== request.commonDirectory ||
    evidence.registrySha256 !== request.registrySha256 ||
    canonicalHash(evidence.runBindings) !== canonicalHash(request.runBindings) ||
    canonicalHash([...evidence.quiescedRunIds].sort(compareUtf8)) !== canonicalHash(request.runBindings.map((run) => run.id).sort(compareUtf8)) ||
    canonicalHash(material) !== evidence.evidenceSha256
  ) {
    throw new LegacyProjectMigrationError("run_barrier_invalid", "legacy run barrier evidence does not bind the migration plan");
  }
}

function createCompatibilityIndex(
  plan: LegacyProjectMigrationPlan,
  barrier?: LegacyRunBarrierEvidence,
): LegacyRunCompatibilityIndex {
  return {
    protocol: LEGACY_RUN_COMPATIBILITY_PROTOCOL,
    migrationId: plan.migrationId,
    projectRoot: plan.projectRoot,
    sourceRegistrySha256: plan.runs.registrySha256,
    ...(plan.runs.selectedRunId === undefined ? {} : { selectedRunId: plan.runs.selectedRunId }),
    runs: structuredClone(plan.runs.runs),
    ...(barrier === undefined ? {} : { barrierEvidenceSha256: barrier.evidenceSha256 }),
    generatedAt: new Date().toISOString(),
    sourceRetained: true,
  };
}

async function hashTree(
  root: string,
  directory: string,
  include: (relative: string) => boolean = () => true,
  limits: { maxFileBytes: number; maxTotalBytes: number } | undefined = undefined,
  observer: LegacyTreeVerificationObserver = {},
): Promise<{ files: HashedLegacyFile[]; treeSha256: Sha256Digest }> {
  const effectiveLimits = limits ?? {
    maxFileBytes: MAX_LEGACY_RUN_FILE_BYTES,
    maxTotalBytes: MAX_LEGACY_RUN_TOTAL_BYTES,
  };
  const canonicalRoot = await canonicalRealDirectory(root, "legacy_tree");
  if (canonicalRoot !== root) throw new LegacyProjectMigrationError("legacy_tree_escape", `legacy tree is noncanonical: ${root}`);
  const files: HashedLegacyFile[] = [];
  let totalBytes = 0;
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 128) throw new LegacyProjectMigrationError("legacy_tree_depth", "legacy tree exceeds depth bound");
    const directoryIdentity = await stableDirectoryIdentity(current);
    await observer.afterDirectoryIdentity?.({ directory: current, depth });
    await assertDirectoryIdentityCurrent(current, directoryIdentity);
    const names = (await readdir(current)).sort(compareUtf8);
    await assertDirectoryIdentityCurrent(current, directoryIdentity);
    for (const name of names) {
      await assertDirectoryIdentityCurrent(current, directoryIdentity);
      const absolute = path.join(current, name);
      const relative = path.relative(directory, absolute).split(path.sep).join("/");
      if (!isNormalizedSafeRelativePath(relative)) throw new LegacyProjectMigrationError("legacy_path", `unsafe legacy path: ${relative}`);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new LegacyProjectMigrationError("legacy_symlink", `legacy tree contains a symlink: ${relative}`);
      if (metadata.isDirectory()) await walk(absolute, depth + 1);
      else if (metadata.isFile() && include(relative)) {
        if (files.length >= MAX_LEGACY_FILES) throw new LegacyProjectMigrationError("legacy_file_count", "legacy tree contains too many files");
        const hashed = await hashFile(absolute, effectiveLimits.maxFileBytes);
        totalBytes += hashed.sizeBytes;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > effectiveLimits.maxTotalBytes) {
          throw new LegacyProjectMigrationError("legacy_tree_size", "legacy tree exceeds the total byte limit");
        }
        files.push({ path: relative, sha256: hashed.sha256, sizeBytes: hashed.sizeBytes });
      } else if (!metadata.isFile()) throw new LegacyProjectMigrationError("legacy_file_type", `legacy tree contains an unsupported file: ${relative}`);
      await assertDirectoryIdentityCurrent(current, directoryIdentity);
    }
    await assertDirectoryIdentityCurrent(current, directoryIdentity);
  };
  await walk(root, 0);
  files.sort((left, right) => compareUtf8(left.path, right.path));
  return { files, treeSha256: canonicalHash(files) };
}

interface LegacyDirectoryIdentity {
  canonicalPath: string;
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

async function stableDirectoryIdentity(directory: string): Promise<LegacyDirectoryIdentity> {
  let before: Stats;
  let after: Stats;
  let canonicalPath: string;
  try {
    before = await lstat(directory);
    if (before.isSymbolicLink()) {
      throw new LegacyProjectMigrationError(
        "legacy_symlink",
        `legacy tree contains a symlinked directory: ${directory}`,
      );
    }
    if (!before.isDirectory()) {
      throw new LegacyProjectMigrationError(
        "legacy_file_type",
        `legacy tree descent is not a directory: ${directory}`,
      );
    }
    canonicalPath = await realpath(directory);
    after = await lstat(directory);
  } catch (error) {
    if (error instanceof LegacyProjectMigrationError) throw error;
    throw new LegacyProjectMigrationError(
      "legacy_directory_changed",
      `legacy directory changed while authenticating it: ${directory}: ${String(error)}`,
    );
  }
  if (
    canonicalPath !== directory ||
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    !sameDirectoryIdentity(before, after)
  ) {
    throw new LegacyProjectMigrationError(
      canonicalPath === directory ? "legacy_directory_changed" : "legacy_tree_escape",
      `legacy directory was redirected or changed during traversal: ${directory}`,
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
  expected: LegacyDirectoryIdentity,
): Promise<void> {
  const actual = await stableDirectoryIdentity(directory);
  if (
    actual.canonicalPath !== expected.canonicalPath ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.mode !== expected.mode ||
    actual.size !== expected.size ||
    actual.mtimeMs !== expected.mtimeMs ||
    actual.ctimeMs !== expected.ctimeMs
  ) {
    throw new LegacyProjectMigrationError(
      "legacy_directory_changed",
      `legacy directory changed during traversal: ${directory}`,
    );
  }
}

function sameDirectoryIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

async function hashFile(
  filePath: string,
  maxBytes: number,
): Promise<{ sha256: Sha256Digest; sizeBytes: number }> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  const hash = createHash("sha256");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) {
      throw new LegacyProjectMigrationError("legacy_file_size", `legacy file is unsafe or too large: ${filePath}`);
    }
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath, { fd: handle.fd, autoClose: false });
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new LegacyProjectMigrationError("legacy_file_changed", `legacy file changed while hashing: ${filePath}`);
    }
    return { sha256: `sha256:${hash.digest("hex")}`, sizeBytes: before.size };
  } finally {
    await handle.close();
  }
}

async function readVerified(root: string, descriptor: HashedLegacyFile): Promise<Buffer> {
  const absolute = path.join(root, descriptor.path);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(absolute, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== descriptor.sizeBytes || before.size > MAX_LEGACY_CONFIG_BYTES) {
      throw new LegacyProjectMigrationError("legacy_file_changed", `legacy file changed: ${descriptor.path}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || rawSha256(bytes) !== descriptor.sha256) {
      throw new LegacyProjectMigrationError("legacy_file_changed", `legacy file changed: ${descriptor.path}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readStableLegacyFile(
  filePath: string,
  maxBytes: number,
  code: string,
): Promise<Buffer> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollow);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) {
      throw new LegacyProjectMigrationError(code, `legacy file is empty or oversized: ${filePath}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileIdentity(before, after) || bytes.byteLength !== before.size) {
      throw new LegacyProjectMigrationError(code, `legacy file changed while reading: ${filePath}`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof LegacyProjectMigrationError) throw error;
    throw new LegacyProjectMigrationError(code, `legacy file is unavailable or unsafe: ${filePath}: ${String(error)}`);
  } finally {
    await handle?.close();
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function assertMigrationPlanShape(plan: LegacyProjectMigrationPlan): void {
  assertLegacyProjectMigrationPlan(plan);
}

function assertLegacyRunInspection(value: unknown): asserts value is LegacyRunInspection {
  if (
    !isRecord(value) ||
    (value.commonDirectory !== undefined &&
      (typeof value.commonDirectory !== "string" || !path.isAbsolute(value.commonDirectory))) ||
    (value.stateRoot !== undefined &&
      (typeof value.stateRoot !== "string" || !path.isAbsolute(value.stateRoot))) ||
    (value.registryPath !== undefined &&
      (typeof value.registryPath !== "string" || !path.isAbsolute(value.registryPath))) ||
    (value.registrySha256 !== null && !isSha256Digest(value.registrySha256)) ||
    (value.selectedRunId !== undefined && typeof value.selectedRunId !== "string") ||
    !Array.isArray(value.runs) ||
    typeof value.requiresBarrier !== "boolean" ||
    !isSha256Digest(value.snapshotSha256)
  ) {
    throw new LegacyProjectMigrationError("migration_plan", "legacy run inspection has an invalid shape");
  }
  const ids = new Set<string>();
  for (const run of value.runs) {
    assertLegacyRunSnapshot(run);
    if (ids.has(run.id)) {
      throw new LegacyProjectMigrationError("migration_plan", `legacy run inspection repeats ${run.id}`);
    }
    ids.add(run.id);
  }
  if (value.selectedRunId !== undefined && !ids.has(value.selectedRunId)) {
    throw new LegacyProjectMigrationError("migration_plan", "legacy run selection is not in the plan");
  }
  const material = { ...value };
  delete (material as { snapshotSha256?: unknown }).snapshotSha256;
  if (canonicalHash(material) !== value.snapshotSha256) {
    throw new LegacyProjectMigrationError(
      "migration_plan",
      "legacy run inspection digest does not match its material",
    );
  }
}

function assertLegacyRunSnapshot(value: unknown): asserts value is LegacyRunSnapshot {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.id) ||
    !["planning", "approved", "active", "paused", "concluded", "stopped", "failed"]
      .includes(String(value.status)) ||
    typeof value.goal !== "string" ||
    value.goal.length === 0 ||
    typeof value.profileId !== "string" ||
    value.profileId.length === 0 ||
    typeof value.profileVersion !== "string" ||
    value.profileVersion.length === 0 ||
    typeof value.baseCommit !== "string" ||
    value.baseCommit.length === 0 ||
    typeof value.configSnapshotHash !== "string" ||
    value.configSnapshotHash.length === 0 ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.sourceRoot !== "string" ||
    !path.isAbsolute(value.sourceRoot) ||
    !isSha256Digest(value.treeSha256) ||
    !Number.isSafeInteger(value.fileCount) ||
    Number(value.fileCount) < 0 ||
    value.resumeDisposition !== resumeDisposition(value.status as LegacyRunStatus)
  ) {
    throw new LegacyProjectMigrationError("compatibility_shape", "legacy run snapshot has an invalid shape");
  }
  for (const field of [
    "profileHash",
    "runTypeId",
    "runTypeTitle",
    "runTypeHash",
    "questionPolicy",
    "targetBranch",
    "configSnapshotPath",
    "planningWorktree",
    "integrationBranch",
    "integrationWorktree",
  ] as const) {
    if (value[field] !== undefined && (typeof value[field] !== "string" || value[field].length === 0)) {
      throw new LegacyProjectMigrationError(
        "compatibility_shape",
        `legacy run snapshot has invalid ${field}`,
      );
    }
  }
  if (value.planningReadOnly !== undefined && typeof value.planningReadOnly !== "boolean") {
    throw new LegacyProjectMigrationError(
      "compatibility_shape",
      "legacy run snapshot has invalid planningReadOnly",
    );
  }
}

function assertHashedLegacyFile(value: unknown, label: string): asserts value is HashedLegacyFile {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !isNormalizedSafeRelativePath(value.path) ||
    !isSha256Digest(value.sha256) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    Number(value.sizeBytes) < 0
  ) {
    throw new LegacyProjectMigrationError("migration_plan", `legacy ${label} descriptor is invalid`);
  }
}

function resumeDisposition(status: LegacyRunStatus): LegacyRunSnapshot["resumeDisposition"] {
  if (status === "planning") return "planning_paused";
  if (status === "approved" || status === "active" || status === "paused") return "execution_paused";
  if (status === "concluded") return "completed";
  return status;
}

function parseLegacyRunStatus(value: unknown, runId: string): LegacyRunStatus {
  if (["planning", "approved", "active", "paused", "concluded", "stopped", "failed"].includes(String(value))) {
    return value as LegacyRunStatus;
  }
  throw new LegacyProjectMigrationError("legacy_run_status", `legacy run ${runId} has unsupported status ${String(value)}`);
}

function migrateThinkingLevel(value: string, source: string): string {
  const aliases: Record<string, string> = { none: "off", extra_high: "xhigh", extra_highest: "max", ultra: "max" };
  const migrated = aliases[value] ?? value;
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(migrated)) {
    throw new LegacyProjectMigrationError("legacy_thinking", `${source} uses unsupported reasoning effort ${value}`);
  }
  return migrated;
}

function classifyMigratedPath(relative: string): ProfileBaselineFile["kind"] {
  if (/^agents\/[^/]+\.ya?ml$/u.test(relative)) return "agent";
  if (/^resources\/skills\/[^/]+\/SKILL\.md$/u.test(relative) || relative.includes("/skills/")) return "skill";
  if (relative.includes("/prompts/") && relative.endsWith(".md")) return "prompt";
  if (/\.ya?ml$/u.test(relative)) return "config";
  return "other";
}

function requiredString(value: unknown, runId: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new LegacyProjectMigrationError("legacy_run_shape", `legacy run ${runId} lacks ${field}`);
  return value;
}

function renameKey(record: Record<string, unknown>, oldKey: string, newKey: string, source: string): void {
  if (record[oldKey] === undefined) return;
  if (record[newKey] !== undefined) throw new LegacyProjectMigrationError("legacy_key_conflict", `${source} defines both ${oldKey} and ${newKey}`);
  record[newKey] = record[oldKey];
  delete record[oldKey];
}

function verifyPathBeneath(root: string, candidate: string): void {
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new LegacyProjectMigrationError("path_escape", `path escapes root: ${candidate}`);
  }
}

async function canonicalRealDirectory(input: string, code: string): Promise<string> {
  const absolute = path.resolve(input);
  try {
    const canonical = await realpath(absolute);
    const metadata = await lstat(canonical);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("not a real directory");
    return canonical;
  } catch (error) {
    throw new LegacyProjectMigrationError(code, `directory is unavailable or unsafe: ${absolute}: ${String(error)}`);
  }
}

async function realDirectoryExists(input: string): Promise<boolean> {
  try {
    const metadata = await lstat(input);
    if (metadata.isSymbolicLink()) throw new LegacyProjectMigrationError("legacy_symlink", `legacy directory is a symlink: ${input}`);
    return metadata.isDirectory();
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function regularFileExists(input: string): Promise<boolean> {
  try {
    const metadata = await lstat(input);
    if (metadata.isSymbolicLink()) throw new LegacyProjectMigrationError("legacy_symlink", `legacy file is a symlink: ${input}`);
    return metadata.isFile();
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

function validateMigrationId(value: string): void {
  if (!isSafeMigrationId(value)) throw new LegacyProjectMigrationError("migration_id", "migration id is not safe");
}

function isSafeMigrationId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
