import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { compare, gtr, satisfies, valid } from "semver";
import {
  FileTransactionStore,
  type TransactionDelete,
  type TransactionWrite,
} from "../authority/file-journal.js";
import type {
  ProfileBaselineFile,
  ProfileFileKind,
  ProfileMigration,
  ProfilePackageManifest,
} from "../contracts/profile-package.js";
import { compileProjectConfiguration } from "../compiler/configuration.js";
import {
  isNormalizedSafeRelativePath,
  parseProfilePackageManifest,
  validateProfilePackageManifest,
  verifyProfileBaseline,
  type VerifiedProfileBaseline,
} from "../compiler/profile-package.js";
import {
  canonicalHash,
  compareUtf8,
  isSha256Digest,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import {
  isValidYamlConflictPaths,
  threeWayMergeYaml,
  type YamlThreeWayMergeResult,
} from "./yaml-three-way.js";
import {
  assertProfileRetirementResourcesNonOverlapping,
  parseProfileRetirementResource,
  planProfileRetirement,
  type ProfileRetirementPlan,
  type ProfileRetirementPreview,
} from "./semantic-retirement.js";

const INSTALL_PROTOCOL = "koni.profile-install.v1" as const;
const LIFECYCLE_PROTOCOL = "koni.profile-lifecycle.v1" as const;
const INSTALL_METADATA_PATH = ".managed/install.json";
const LIFECYCLE_METADATA_PATH = ".managed/lifecycle.json";
const PI_SETTINGS_OWNERSHIP_PATH = ".managed/pi-settings.json";
const PROFILE_LOCK_PATH = ".managed/profile-lifecycle.lock";
export const REQUIRED_SUPERPOWERS_PI_PACKAGE = "git:github.com/obra/superpowers" as const;
const PI_SETTINGS_OWNERSHIP_PROTOCOL = "koni.pi-settings-ownership.v1" as const;
const profileLifecycleContext = new AsyncLocalStorage<{
  configRoot: string;
  nonce: string;
}>();
const MAX_PROFILE_FILES = 16_384;
// Installation writes both the materialized tree and its immutable archive in
// one 64 MiB journal, leaving room for metadata and guarded migration evidence.
const MAX_PROFILE_BYTES = 16 * 1024 * 1024;
const MAX_MIGRATION_RESOURCE_BYTES = 4 * 1024 * 1024;

export interface LoadedProfilePackage extends VerifiedProfileBaseline {
  /** Hash-verified declarative migration resources keyed by manifest-relative path. */
  migrationResources: ReadonlyMap<string, Uint8Array>;
}

export type PendingUpstreamReason = "modified" | "deleted" | "orphaned";

export interface PendingUpstreamChange {
  path: string;
  proposedPath: string;
  reason: PendingUpstreamReason;
  /** Divergent YAML fields retained from the project after safe upstream-only fields were merged. */
  conflictPaths?: readonly string[];
  oldBaselineSha256?: Sha256Digest;
  newBaselineSha256?: Sha256Digest;
  projectSha256?: Sha256Digest | null;
}

/** Compatibility record consumed by the authenticated project-directory compiler. */
export interface InstalledProfileMetadata {
  protocol: typeof INSTALL_PROTOCOL;
  package: ProfilePackageManifest["package"];
  profile: ProfilePackageManifest["profile"];
  compatibility: ProfilePackageManifest["compatibility"];
  bundleSha256: Sha256Digest;
  installedAt: string;
  baselineFiles: ProfileBaselineFile[];
  /** Bundle-bound declarative migration descriptors; absent on historical packages. */
  migrations?: ProfileMigration[];
  projectOverrides: Record<string, Sha256Digest | null>;
  pendingUpstream: Array<
    Pick<PendingUpstreamChange, "path" | "proposedPath" | "reason" | "conflictPaths">
  >;
}

export interface ProjectOverlayEntry {
  path: string;
  disposition: "added" | "modified" | "deleted" | "orphaned";
  projectSha256: Sha256Digest | null;
  baselineSha256?: Sha256Digest;
}

export interface ProfileLifecycleMetadata {
  protocol: typeof LIFECYCLE_PROTOCOL;
  generation: number;
  lineage: string;
  installedBundleSha256: Sha256Digest;
  installedProfileVersion: string;
  immutableBaselines: Array<{
    bundleSha256: Sha256Digest;
    profileVersion: string;
    storedAt: string;
    root: string;
  }>;
  overlay: ProjectOverlayEntry[];
  pendingUpstream: PendingUpstreamChange[];
  upstreamResolutions: Array<{
    path: string;
    bundleSha256: Sha256Digest;
    resolution: "keep_project" | "accept_upstream";
    resolvedAt: string;
    projectSha256: Sha256Digest | null;
    /** Exact project source reviewed before this decision; absent on historical records. */
    expectedProjectSha256?: Sha256Digest | null;
    /** Exact authority method/params hash; absent for legacy/direct non-authority resolutions. */
    authorityRequestSha256?: Sha256Digest;
    /** Whole compiled configuration produced by this transaction; absent on historical records. */
    configurationSha256?: Sha256Digest;
    /** Exact authored-file inventory produced by this transaction; absent on historical records. */
    effectiveBundleSha256?: Sha256Digest;
  }>;
  migrations: Array<{
    id: string;
    appliedAt: string;
    artifactRoot: string;
  }>;
  semanticRetirements: Array<{
    id: string;
    sourceBundleSha256: Sha256Digest;
    targetBundleSha256: Sha256Digest;
    resourceSha256: Sha256Digest;
    planSha256: Sha256Digest;
    configurationSha256: Sha256Digest;
    effectiveBundleSha256: Sha256Digest;
    appliedAt: string;
    artifactRoot: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileInstallPreview {
  projectConfigRoot: string;
  packageName: string;
  profileVersion: string;
  bundleSha256: Sha256Digest;
  generation: number;
  added: string[];
  updated: string[];
  deleted: string[];
  unchanged: string[];
  preserved: string[];
  overlay: ProjectOverlayEntry[];
  pendingUpstream: PendingUpstreamChange[];
  mandatoryRetirements: ProfileRetirementPreview[];
  previewSha256: Sha256Digest;
}

export interface ProfileInstallResult extends ProfileInstallPreview {
  transactionId: string;
}

export interface ProfileInstallOptions {
  /** Explicit escape hatch for a guarded rollback; normal upgrades are monotonic. */
  allowDowngrade?: boolean;
  /** Internal migration overlay. Every entry replaces or deletes one baseline path atomically. */
  migrationOverlay?: ReadonlyMap<string, Uint8Array | null>;
  /** Required when `migrationOverlay` is present and included in lifecycle provenance. */
  migrationId?: string;
  /** Hash-pinned migration evidence archived beneath this migration's managed namespace. */
  migrationArtifacts?: ReadonlyMap<string, Uint8Array>;
  /** Exact no-write preview required before any manifest-declared semantic retirement. */
  expectedPreviewSha256?: Sha256Digest;
}

interface MaterializationPlan {
  preview: ProfileInstallPreview;
  writes: TransactionWrite[];
  deletes: TransactionDelete[];
  installMetadata: InstalledProfileMetadata;
  lifecycleMetadata: ProfileLifecycleMetadata;
}

interface PiSettingsMergePlan {
  readonly settingsPath: string;
  readonly expectedSettingsSha256: Sha256Digest | null;
  readonly settingsBytes?: Uint8Array;
  readonly ownershipWrite: TransactionWrite;
}

interface PreparedSemanticRetirement {
  readonly descriptor: ProfileMigration;
  readonly plan: ProfileRetirementPlan;
}

export class ProfileInstallError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ProfileInstallError";
    this.code = code;
  }
}

export async function loadProfilePackage(packageRoot: string): Promise<LoadedProfilePackage> {
  const canonicalPackageRoot = await canonicalRealDirectory(packageRoot, "profile_package_root");
  const manifestPath = path.join(canonicalPackageRoot, "koni", "profile-manifest.json");
  const parsed = parseProfilePackageManifest(
    (await readStableRegularFile(manifestPath)).toString("utf8"),
  );
  if (!parsed.ok) {
    throw new ProfileInstallError(
      "manifest_invalid",
      parsed.diagnostics
        .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`)
        .join("\n"),
    );
  }
  const baselineRoot = path.join(canonicalPackageRoot, "koni", "baseline");
  const canonicalBaselineRoot = await canonicalRealDirectory(baselineRoot, "profile_baseline_root");
  if (
    canonicalBaselineRoot !== baselineRoot ||
    !isWithin(canonicalPackageRoot, canonicalBaselineRoot)
  ) {
    throw new ProfileInstallError("baseline_escape", "profile baseline escapes its package root");
  }
  const files = await readAllRegularFiles(canonicalBaselineRoot);
  const verified = verifyProfileBaseline(parsed.value, files);
  if (!verified.ok) {
    throw new ProfileInstallError(
      "baseline_invalid",
      verified.diagnostics
        .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`)
        .join("\n"),
    );
  }
  const migrationResources = new Map<string, Uint8Array>();
  let migrationBytes = 0;
  const koniRoot = path.join(canonicalPackageRoot, "koni");
  for (const descriptor of parsed.value.migrations ?? []) {
    const candidate = path.join(koniRoot, descriptor.path);
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        throw new ProfileInstallError(
          "migration_resource_missing",
          `profile migration resource is missing: ${descriptor.path}`,
        );
      }
      throw error;
    }
    if (canonical !== candidate || !isWithin(koniRoot, canonical)) {
      throw new ProfileInstallError(
        "migration_resource_escape",
        `profile migration resource escapes its package: ${descriptor.path}`,
      );
    }
    const bytes = await readStableRegularFile(canonical);
    migrationBytes += bytes.byteLength;
    if (migrationBytes > MAX_MIGRATION_RESOURCE_BYTES) {
      throw new ProfileInstallError(
        "migration_resource_size",
        "profile migration resources exceed their aggregate byte budget",
      );
    }
    if (rawSha256(bytes) !== descriptor.sha256) {
      throw new ProfileInstallError(
        "migration_resource_sha256",
        `profile migration resource digest changed: ${descriptor.path}`,
      );
    }
    try {
      parseProfileRetirementResource(bytes, descriptor.id);
    } catch (error) {
      throw new ProfileInstallError(
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : "migration_resource_invalid",
        error instanceof Error ? error.message : String(error),
      );
    }
    migrationResources.set(descriptor.path, bytes);
  }
  return { ...verified.value, migrationResources };
}

/** Read-only three-way preview. It never creates `.koni`, locks, or transaction files. */
export async function previewProfileInstall(
  projectRoot: string,
  profilePackageRoot: string,
  options: ProfileInstallOptions = {},
): Promise<ProfileInstallPreview> {
  const project = await canonicalRealDirectory(projectRoot, "project_root");
  const baseline = await loadProfilePackage(profilePackageRoot);
  const configRoot = path.join(project, ".koni");
  await assertOptionalRealConfigRoot(configRoot);
  // Building the full transaction is still read-only; it gives the preview the
  // exact same projected tree and digest that an apply would use.
  const plan = await buildMaterializationPlan(configRoot, baseline, options, true);
  return structuredClone(plan.preview);
}

/**
 * Install or upgrade one verified profile as a crash-forward materialized overlay.
 * The installer mutates the managed `.koni` tree and merges only Koni's
 * required package entry into Pi's ordinary project settings.
 */
export async function installProfile(
  projectRoot: string,
  profilePackageRoot: string,
  options: ProfileInstallOptions = {},
): Promise<ProfileInstallResult> {
  const project = await canonicalRealDirectory(projectRoot, "project_root");
  const baseline = await loadProfilePackage(profilePackageRoot);
  const configRoot = path.join(project, ".koni");
  await assertOptionalRealConfigRoot(configRoot);
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  if ((await realpath(configRoot)) !== configRoot) {
    throw new ProfileInstallError("config_escape", ".koni is not a canonical project directory");
  }

  return withProfileLifecycleLock(configRoot, async () => {
    const store = await FileTransactionStore.open(configRoot);
    await store.recoverPrepared();
    const plan = await buildMaterializationPlan(configRoot, baseline, options, true);
    const piSettings = await preparePiSettingsMerge(project, configRoot);
    if (plan.preview.mandatoryRetirements.length > 0) {
      if (options.expectedPreviewSha256 === undefined) {
        throw new ProfileInstallError(
          "retirement_preview_required",
          `profile update retires configured semantics; review preview ${plan.preview.previewSha256} and apply that exact digest`,
        );
      }
      if (options.expectedPreviewSha256 !== plan.preview.previewSha256) {
        throw new ProfileInstallError(
          "retirement_preview_stale",
          "profile retirement preview changed; inspect the current preview before applying",
        );
      }
    }
    const transactionId = `profile-${plan.preview.generation}-${randomUUID()}`;
    await store.prepare(transactionId, [...plan.writes, piSettings.ownershipWrite], plan.deletes);
    await applyPiSettingsMerge(piSettings);
    await store.commit(transactionId);
    await store.cleanupCommitted(transactionId);
    return { ...structuredClone(plan.preview), transactionId };
  });
}

async function preparePiSettingsMerge(
  projectRoot: string,
  configRoot: string,
): Promise<PiSettingsMergePlan> {
  const piRoot = path.join(projectRoot, ".pi");
  await assertOptionalRealPiRoot(piRoot, projectRoot);
  const settingsPath = path.join(piRoot, "settings.json");
  const currentSettingsBytes = await readOptionalFile(settingsPath);
  const settings =
    currentSettingsBytes === undefined
      ? {}
      : parseJsonRecord(currentSettingsBytes, "pi_settings_invalid", "Pi settings");
  const packagesValue = settings.packages;
  if (packagesValue !== undefined && !Array.isArray(packagesValue)) {
    throw new ProfileInstallError("pi_settings_invalid", "Pi settings packages must be an array");
  }
  const packages = packagesValue === undefined ? [] : [...packagesValue];
  for (const entry of packages) assertValidPiPackageEntry(entry);

  const ownershipAbsolute = path.join(configRoot, PI_SETTINGS_OWNERSHIP_PATH);
  const currentOwnershipBytes = await readOptionalFile(ownershipAbsolute);
  const ownership = parsePiSettingsOwnership(currentOwnershipBytes);
  const matching = packages.filter(
    (entry) =>
      canonicalPiPackageIdentity(piPackageSource(entry)) ===
      canonicalPiPackageIdentity(REQUIRED_SUPERPOWERS_PI_PACKAGE),
  );
  const exact = matching.filter(isExactRequiredPiPackage);

  if (matching.length !== exact.length || exact.length > 1) {
    throw new ProfileInstallError(
      "pi_settings_conflict",
      `Pi package ${REQUIRED_SUPERPOWERS_PI_PACKAGE} is pinned, filtered, or duplicated; preserve that user choice or restore the Koni-managed entry before updating`,
    );
  }
  if (ownership !== undefined && exact.length !== 1) {
    throw new ProfileInstallError(
      "pi_settings_conflict",
      `Koni's required Pi package entry was removed or changed: ${REQUIRED_SUPERPOWERS_PI_PACKAGE}`,
    );
  }

  const managed = ownership?.managed ?? exact.length === 0;
  let settingsBytes: Uint8Array | undefined;
  if (exact.length === 0) {
    packages.push(REQUIRED_SUPERPOWERS_PI_PACKAGE);
    settings.packages = packages;
    settingsBytes = jsonBytes(settings);
  }
  const ownershipBytes = jsonBytes({
    protocol: PI_SETTINGS_OWNERSHIP_PROTOCOL,
    source: REQUIRED_SUPERPOWERS_PI_PACKAGE,
    managed,
  });
  return {
    settingsPath,
    expectedSettingsSha256:
      currentSettingsBytes === undefined ? null : rawSha256(currentSettingsBytes),
    ...(settingsBytes === undefined ? {} : { settingsBytes }),
    ownershipWrite: {
      path: PI_SETTINGS_OWNERSHIP_PATH,
      bytes: ownershipBytes,
      expectedSha256: currentOwnershipBytes === undefined ? null : rawSha256(currentOwnershipBytes),
    },
  };
}

async function applyPiSettingsMerge(plan: PiSettingsMergePlan): Promise<void> {
  if (plan.settingsBytes === undefined) return;
  const piRoot = path.dirname(plan.settingsPath);
  await mkdir(piRoot, { recursive: true, mode: 0o700 });
  const current = await readOptionalFile(plan.settingsPath);
  const currentSha256 = current === undefined ? null : rawSha256(current);
  if (currentSha256 !== plan.expectedSettingsSha256) {
    throw new ProfileInstallError(
      "pi_settings_changed",
      "Pi settings changed while the profile update was being prepared",
    );
  }
  const temporaryPath = path.join(piRoot, `.settings.json.koni-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(plan.settingsBytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, plan.settingsPath);
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
}

function parsePiSettingsOwnership(bytes: Uint8Array | undefined): { managed: boolean } | undefined {
  if (bytes === undefined) return undefined;
  const value = parseJsonRecord(bytes, "pi_settings_ownership_invalid", "Pi settings ownership");
  rejectUnknownFields(
    value,
    ["protocol", "source", "managed"],
    "pi_settings_ownership_invalid",
    "Pi settings ownership",
  );
  if (
    value.protocol !== PI_SETTINGS_OWNERSHIP_PROTOCOL ||
    value.source !== REQUIRED_SUPERPOWERS_PI_PACKAGE ||
    typeof value.managed !== "boolean"
  ) {
    throw new ProfileInstallError(
      "pi_settings_ownership_invalid",
      "Pi settings ownership has an invalid shape",
    );
  }
  return { managed: value.managed };
}

function assertValidPiPackageEntry(value: unknown): void {
  if (typeof value === "string" && value.length > 0) return;
  if (isRecord(value) && typeof value.source === "string" && value.source.length > 0) {
    return;
  }
  throw new ProfileInstallError(
    "pi_settings_invalid",
    "Pi settings contains an invalid package entry",
  );
}

function piPackageSource(value: unknown): string {
  return typeof value === "string" ? value : String((value as Record<string, unknown>).source);
}

function isExactRequiredPiPackage(value: unknown): boolean {
  if (typeof value === "string") return value === REQUIRED_SUPERPOWERS_PI_PACKAGE;
  const record = value as Record<string, unknown>;
  return record.source === REQUIRED_SUPERPOWERS_PI_PACKAGE && Object.keys(record).length === 1;
}

function canonicalPiPackageIdentity(source: string): string {
  return source
    .replace(/^git:/u, "")
    .replace(/^(?:https?|ssh):\/\//u, "")
    .replace(/^git@github\.com:/u, "github.com/")
    .replace(/\.git(?=@|$)/u, "")
    .replace(/@[^/]+$/u, "")
    .replace(/\/+$/u, "")
    .toLowerCase();
}

/** Return lifecycle metadata without trusting it as package authority. */
export async function readProfileLifecycle(
  projectRoot: string,
): Promise<ProfileLifecycleMetadata | undefined> {
  const project = await canonicalRealDirectory(projectRoot, "project_root");
  const configRoot = path.join(project, ".koni");
  await assertOptionalRealConfigRoot(configRoot);
  return readLifecycleMetadata(configRoot);
}

async function buildMaterializationPlan(
  configRoot: string,
  packageBaseline: LoadedProfilePackage,
  options: ProfileInstallOptions,
  includeWrites: boolean,
): Promise<MaterializationPlan> {
  if (
    (options.migrationOverlay === undefined && options.migrationArtifacts === undefined) !==
    (options.migrationId === undefined)
  ) {
    throw new ProfileInstallError(
      "migration_binding",
      "migration material and migration id must be supplied together",
    );
  }
  if (
    options.migrationId !== undefined &&
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(options.migrationId)
  ) {
    throw new ProfileInstallError("migration_id", "migration id is not safe");
  }
  const installed = await readInstalledMetadata(configRoot);
  const lifecycle = await readLifecycleMetadata(configRoot);
  if (
    installed !== undefined &&
    installed.profile.lineage !== packageBaseline.manifest.profile.lineage
  ) {
    throw new ProfileInstallError(
      "lineage_mismatch",
      `project uses ${installed.profile.lineage}; cannot upgrade it with ${packageBaseline.manifest.profile.lineage}`,
    );
  }
  if (
    installed !== undefined &&
    options.allowDowngrade !== true &&
    valid(installed.profile.version) !== null &&
    compare(packageBaseline.manifest.profile.version, installed.profile.version) < 0
  ) {
    throw new ProfileInstallError(
      "profile_downgrade",
      `refusing profile downgrade ${installed.profile.version} -> ${packageBaseline.manifest.profile.version}`,
    );
  }
  if (installed === undefined && (await directoryExists(configRoot))) {
    const unmanaged = (await listProjectFiles(configRoot)).filter((file) => !isCompilerOwned(file));
    if (unmanaged.length > 0 && options.migrationOverlay === undefined) {
      throw new ProfileInstallError(
        "unmanaged_project",
        ".koni already contains files but has no Koni profile install record",
      );
    }
    if (
      unmanaged.length > 0 &&
      unmanaged.some((relative) => !options.migrationOverlay!.has(relative))
    ) {
      throw new ProfileInstallError(
        "unmanaged_migration_incomplete",
        "migration overlay does not account for every unmanaged .koni file",
      );
    }
  }
  if (lifecycle !== undefined && installed === undefined) {
    throw new ProfileInstallError(
      "lifecycle_orphaned",
      "profile lifecycle exists without its install provenance",
    );
  }
  if (
    lifecycle !== undefined &&
    installed !== undefined &&
    (lifecycle.lineage !== installed.profile.lineage ||
      lifecycle.installedBundleSha256 !== installed.bundleSha256)
  ) {
    throw new ProfileInstallError(
      "lifecycle_mismatch",
      "profile lifecycle and install provenance disagree",
    );
  }

  const semanticRetirements = await prepareSemanticRetirements(
    configRoot,
    packageBaseline,
    installed,
    lifecycle,
  );
  const retirementCurrent = new Map<string, Uint8Array>();
  const retirementSourceClean = new Map<string, boolean>();
  for (const retirement of semanticRetirements) {
    for (const [relative, bytes] of retirement.plan.changedProjectFiles) {
      let sourceClean = retirementSourceClean.get(relative);
      if (sourceClean === undefined) {
        const sourceDescriptor = installed?.baselineFiles.find((file) => file.path === relative);
        const archivedProject = retirement.plan.preview.archives.find(
          (entry) => entry.file === relative,
        );
        sourceClean =
          sourceDescriptor !== undefined &&
          archivedProject?.projectSha256 === sourceDescriptor.sha256;
        retirementSourceClean.set(relative, sourceClean);
      }
      // If the project file exactly matched its authenticated source baseline, the
      // retirement is the only local delta. Adopt the authenticated target file as
      // a whole so selector-based array removals cannot hide target-side additions
      // from a positional YAML merge. Customized files retain the transformed
      // project bytes and continue through the ordinary merge/conflict path.
      retirementCurrent.set(relative, sourceClean ? packageBaseline.files.get(relative)! : bytes);
    }
  }

  const oldFiles = new Map(installed?.baselineFiles.map((file) => [file.path, file]) ?? []);
  const newFiles = new Map(
    packageBaseline.manifest.baseline.files.map((file) => [file.path, file]),
  );
  const writes: TransactionWrite[] = [];
  const deletes: TransactionDelete[] = [];
  const added: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];
  const unchanged: string[] = [];
  const preserved = new Set<string>();
  const pendingUpstream: PendingUpstreamChange[] = [];
  const overrides: Record<string, Sha256Digest | null> = Object.create(null) as Record<
    string,
    Sha256Digest | null
  >;
  const migrationOverlay = options.migrationOverlay ?? new Map<string, Uint8Array | null>();
  for (const overlayPath of migrationOverlay.keys()) {
    if (!isNormalizedSafeRelativePath(overlayPath) || isCompilerOwned(overlayPath)) {
      throw new ProfileInstallError(
        "migration_overlay_path",
        `migration overlay path is unsafe: ${overlayPath}`,
      );
    }
  }

  for (const descriptor of packageBaseline.manifest.baseline.files) {
    const upstreamBytes = packageBaseline.files.get(descriptor.path)!;
    const desired = migrationOverlay.has(descriptor.path)
      ? migrationOverlay.get(descriptor.path)
      : undefined;
    const currentOnDisk = await readOptionalFile(path.join(configRoot, descriptor.path));
    const current = retirementCurrent.get(descriptor.path) ?? currentOnDisk;
    const currentOnDiskHash = currentOnDisk === undefined ? null : rawSha256(currentOnDisk);
    const old = oldFiles.get(descriptor.path);

    if (desired !== undefined) {
      if (desired === null) {
        overrides[descriptor.path] = null;
        preserved.add(descriptor.path);
        if (currentOnDisk !== undefined && includeWrites) {
          deletes.push({ path: descriptor.path, expectedSha256: currentOnDiskHash! });
          deleted.push(descriptor.path);
        }
        continue;
      }
      const desiredHash = rawSha256(desired);
      if (desiredHash !== descriptor.sha256) {
        overrides[descriptor.path] = desiredHash;
        preserved.add(descriptor.path);
      }
      if (currentOnDisk === undefined) {
        if (includeWrites)
          writes.push({ path: descriptor.path, bytes: desired, expectedSha256: null });
        added.push(descriptor.path);
      } else if (currentOnDiskHash !== desiredHash) {
        if (includeWrites)
          writes.push({ path: descriptor.path, bytes: desired, expectedSha256: currentOnDiskHash });
        updated.push(descriptor.path);
      } else {
        unchanged.push(descriptor.path);
      }
      continue;
    }

    if (current === undefined) {
      if (old === undefined) {
        if (includeWrites)
          writes.push({ path: descriptor.path, bytes: upstreamBytes, expectedSha256: null });
        added.push(descriptor.path);
      } else {
        overrides[descriptor.path] = null;
        preserved.add(descriptor.path);
        if (old.sha256 !== descriptor.sha256) {
          await addUpstreamProposal(
            configRoot,
            packageBaseline.manifest,
            descriptor.path,
            upstreamBytes,
            "deleted",
            writes,
            pendingUpstream,
            includeWrites,
            old.sha256,
            descriptor.sha256,
            null,
          );
        }
      }
      continue;
    }
    const currentHash = rawSha256(current);
    if (old !== undefined && currentHash === old.sha256) {
      if (currentHash === descriptor.sha256) {
        unchanged.push(descriptor.path);
      } else {
        if (includeWrites)
          writes.push({
            path: descriptor.path,
            bytes: upstreamBytes,
            expectedSha256: currentOnDiskHash,
          });
        updated.push(descriptor.path);
      }
      continue;
    }
    if (old === undefined && currentHash === descriptor.sha256) {
      unchanged.push(descriptor.path);
      continue;
    }
    if (old !== undefined && old.sha256 !== descriptor.sha256) {
      const merged = await mergeProfileYamlUpgrade({
        configRoot,
        installed,
        lifecycle,
        descriptor,
        old,
        current,
        upstream: upstreamBytes,
      });
      if (merged !== undefined) {
        const mergedHash = rawSha256(merged.bytes);
        if (mergedHash !== currentOnDiskHash) {
          if (includeWrites)
            writes.push({
              path: descriptor.path,
              bytes: merged.bytes,
              expectedSha256: currentOnDiskHash,
            });
          updated.push(descriptor.path);
        } else {
          unchanged.push(descriptor.path);
        }
        if (mergedHash !== descriptor.sha256) {
          overrides[descriptor.path] = mergedHash;
          preserved.add(descriptor.path);
        }
        if (merged.conflictPaths.length > 0) {
          await addUpstreamProposal(
            configRoot,
            packageBaseline.manifest,
            descriptor.path,
            upstreamBytes,
            "modified",
            writes,
            pendingUpstream,
            includeWrites,
            old.sha256,
            descriptor.sha256,
            mergedHash,
            merged.conflictPaths,
          );
        }
        continue;
      }
    }
    overrides[descriptor.path] = currentHash;
    preserved.add(descriptor.path);
    if (old !== undefined && old.sha256 !== descriptor.sha256) {
      await addUpstreamProposal(
        configRoot,
        packageBaseline.manifest,
        descriptor.path,
        upstreamBytes,
        "modified",
        writes,
        pendingUpstream,
        includeWrites,
        old.sha256,
        descriptor.sha256,
        currentHash,
        ["/"],
      );
    }
  }

  for (const [overlayPath, desired] of migrationOverlay) {
    if (newFiles.has(overlayPath)) continue;
    const current = await readOptionalFile(path.join(configRoot, overlayPath));
    if (desired === null) {
      if (current !== undefined && includeWrites) {
        deletes.push({ path: overlayPath, expectedSha256: rawSha256(current) });
        deleted.push(overlayPath);
      }
      continue;
    }
    const desiredHash = rawSha256(desired);
    if (current === undefined) {
      if (includeWrites) writes.push({ path: overlayPath, bytes: desired, expectedSha256: null });
      added.push(overlayPath);
    } else if (rawSha256(current) !== desiredHash) {
      if (includeWrites)
        writes.push({ path: overlayPath, bytes: desired, expectedSha256: rawSha256(current) });
      updated.push(overlayPath);
    } else {
      unchanged.push(overlayPath);
    }
    preserved.add(overlayPath);
  }

  for (const old of oldFiles.values()) {
    if (newFiles.has(old.path) || migrationOverlay.has(old.path)) continue;
    const current = await readOptionalFile(path.join(configRoot, old.path));
    if (current === undefined) continue;
    const currentHash = rawSha256(current);
    if (currentHash === old.sha256) {
      if (includeWrites) deletes.push({ path: old.path, expectedSha256: currentHash });
      deleted.push(old.path);
    } else {
      overrides[old.path] = currentHash;
      preserved.add(old.path);
      pendingUpstream.push({
        path: old.path,
        proposedPath: "",
        reason: "orphaned",
        oldBaselineSha256: old.sha256,
        projectSha256: currentHash,
      });
    }
  }

  const effectiveContents = await projectedProjectContents(configRoot, writes, deletes);
  const effectiveFiles = new Map(
    [...effectiveContents].map(([relative, bytes]) => [relative, rawSha256(bytes)]),
  );
  const overlay = computeOverlay(packageBaseline.manifest.baseline.files, effectiveFiles);
  for (const entry of overlay) if (entry.disposition !== "deleted") preserved.add(entry.path);
  for (const prior of lifecycle?.pendingUpstream ?? []) {
    if (pendingUpstream.some((candidate) => candidate.path === prior.path)) continue;
    const projectSha256 = effectiveFiles.get(prior.path) ?? null;
    const baselineFile = newFiles.get(prior.path);
    const remainsUnresolved =
      baselineFile === undefined ? projectSha256 !== null : projectSha256 !== baselineFile.sha256;
    if (!remainsUnresolved) continue;
    const proposal =
      prior.proposedPath === ""
        ? undefined
        : await readOptionalFile(path.join(configRoot, prior.proposedPath));
    if (prior.proposedPath !== "" && proposal === undefined) {
      throw new ProfileInstallError(
        "proposal_missing",
        `pending upstream proposal is missing: ${prior.proposedPath}`,
      );
    }
    pendingUpstream.push({
      ...prior,
      projectSha256,
      ...(baselineFile === undefined ? {} : { newBaselineSha256: baselineFile.sha256 }),
    });
  }

  const now = new Date().toISOString();
  const compactPending = pendingUpstream
    .map(({ path, proposedPath, reason, conflictPaths }) => ({
      path,
      proposedPath,
      reason,
      ...(conflictPaths === undefined ? {} : { conflictPaths: [...conflictPaths] }),
    }))
    .sort((left, right) => compareUtf8(left.path, right.path));
  const installMetadata: InstalledProfileMetadata = {
    protocol: INSTALL_PROTOCOL,
    package: structuredClone(packageBaseline.manifest.package),
    profile: structuredClone(packageBaseline.manifest.profile),
    compatibility: structuredClone(packageBaseline.manifest.compatibility),
    bundleSha256: packageBaseline.manifest.bundle_sha256,
    installedAt: now,
    baselineFiles: structuredClone([...packageBaseline.manifest.baseline.files]),
    ...((packageBaseline.manifest.migrations?.length ?? 0) === 0
      ? {}
      : { migrations: structuredClone([...packageBaseline.manifest.migrations!]) }),
    projectOverrides: sortRecord(overrides),
    pendingUpstream: compactPending,
  };
  const baselineRoot = baselineStorageRoot(packageBaseline.manifest.bundle_sha256);
  const immutableBaselines = [
    ...(lifecycle?.immutableBaselines ?? []),
    {
      bundleSha256: packageBaseline.manifest.bundle_sha256,
      profileVersion: packageBaseline.manifest.profile.version,
      storedAt: now,
      root: baselineRoot,
    },
  ]
    .filter(
      (entry, index, all) =>
        all.findIndex((candidate) => candidate.bundleSha256 === entry.bundleSha256) === index,
    )
    .sort((left, right) => compareUtf8(left.bundleSha256, right.bundleSha256));
  let retirementCompilation:
    | Readonly<{
        configurationSha256: Sha256Digest;
        effectiveBundleSha256: Sha256Digest;
      }>
    | undefined;
  if (semanticRetirements.length > 0) {
    const candidate = compileProjectConfiguration({
      manifest: packageBaseline.manifest,
      files: inventoryProjectFiles(effectiveContents, packageBaseline.manifest.baseline.files),
      contents: effectiveContents,
    });
    if (!candidate.ok) {
      throw new ProfileInstallError(
        "retirement_candidate_invalid",
        candidate.diagnostics
          .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`)
          .join("\n"),
      );
    }
    retirementCompilation = {
      configurationSha256: candidate.value.configuration_sha256,
      effectiveBundleSha256: candidate.value.effective_bundle_sha256,
    };
  }
  const lifecycleMetadata: ProfileLifecycleMetadata = {
    protocol: LIFECYCLE_PROTOCOL,
    generation: (lifecycle?.generation ?? 0) + 1,
    lineage: packageBaseline.manifest.profile.lineage,
    installedBundleSha256: packageBaseline.manifest.bundle_sha256,
    installedProfileVersion: packageBaseline.manifest.profile.version,
    immutableBaselines,
    overlay,
    pendingUpstream: [...pendingUpstream].sort((left, right) => compareUtf8(left.path, right.path)),
    upstreamResolutions: [...(lifecycle?.upstreamResolutions ?? [])],
    migrations: [
      ...(lifecycle?.migrations ?? []),
      ...(options.migrationId === undefined
        ? []
        : [
            {
              id: options.migrationId,
              appliedAt: now,
              artifactRoot: `.managed/migrations/${options.migrationId}`,
            },
          ]),
    ].filter(
      (entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index,
    ),
    semanticRetirements: [
      ...(lifecycle?.semanticRetirements ?? []),
      ...semanticRetirements.map(({ descriptor, plan }) => ({
        id: descriptor.id,
        sourceBundleSha256: plan.preview.sourceBundleSha256,
        targetBundleSha256: plan.preview.targetBundleSha256,
        resourceSha256: plan.preview.resourceSha256,
        planSha256: plan.preview.planSha256,
        configurationSha256: retirementCompilation!.configurationSha256,
        effectiveBundleSha256: retirementCompilation!.effectiveBundleSha256,
        appliedAt: now,
        artifactRoot: retirementArtifactRoot(packageBaseline.manifest.bundle_sha256, descriptor.id),
      })),
    ].sort((left, right) => compareUtf8(left.id, right.id)),
    createdAt: lifecycle?.createdAt ?? now,
    updatedAt: now,
  };

  const previewMaterial = {
    packageName: packageBaseline.manifest.package.name,
    profileVersion: packageBaseline.manifest.profile.version,
    bundleSha256: packageBaseline.manifest.bundle_sha256,
    generation: lifecycleMetadata.generation,
    added: [...new Set(added)].sort(compareUtf8),
    updated: [...new Set(updated)].sort(compareUtf8),
    deleted: [...new Set(deleted)].sort(compareUtf8),
    unchanged: [...new Set(unchanged)].sort(compareUtf8),
    preserved: [...preserved].sort(compareUtf8),
    overlay,
    pendingUpstream: lifecycleMetadata.pendingUpstream,
    mandatoryRetirements: semanticRetirements.map(({ plan }) => structuredClone(plan.preview)),
  };
  const preview: ProfileInstallPreview = {
    projectConfigRoot: configRoot,
    ...previewMaterial,
    previewSha256: canonicalHash(previewMaterial),
  };
  if (includeWrites) {
    await addImmutableBaselineWrites(configRoot, packageBaseline, baselineRoot, writes);
    for (const [relative, bytes] of options.migrationArtifacts ?? []) {
      const requiredPrefix = `.managed/migrations/${options.migrationId}/`;
      if (!isNormalizedSafeRelativePath(relative) || !relative.startsWith(requiredPrefix)) {
        throw new ProfileInstallError(
          "migration_artifact_path",
          `migration artifact path is outside ${requiredPrefix}`,
        );
      }
      await addImmutableWrite(configRoot, relative, bytes, writes);
    }
    for (const { descriptor, plan } of semanticRetirements) {
      const artifactRoot = retirementArtifactRoot(
        packageBaseline.manifest.bundle_sha256,
        descriptor.id,
      );
      await addImmutableWrite(
        configRoot,
        `${artifactRoot}/resource.json`,
        packageBaseline.migrationResources.get(descriptor.path)!,
        writes,
      );
      await addImmutableWrite(
        configRoot,
        `${artifactRoot}/plan.json`,
        jsonBytes(plan.preview),
        writes,
      );
      for (const [relative, bytes] of plan.archivedProjectFiles) {
        await addImmutableWrite(configRoot, `${artifactRoot}/project/${relative}`, bytes, writes);
      }
      await addImmutableWrite(
        configRoot,
        `${artifactRoot}/receipt.json`,
        jsonBytes({
          protocol: "koni.profile-retirement-receipt.v1",
          id: descriptor.id,
          sourceBundleSha256: plan.preview.sourceBundleSha256,
          targetBundleSha256: plan.preview.targetBundleSha256,
          resourceSha256: plan.preview.resourceSha256,
          planSha256: plan.preview.planSha256,
          installPreviewSha256: preview.previewSha256,
          configurationSha256: retirementCompilation!.configurationSha256,
          effectiveBundleSha256: retirementCompilation!.effectiveBundleSha256,
          archives: plan.preview.archives,
          appliedAt: now,
        }),
        writes,
      );
    }
    await addMetadataWrite(configRoot, INSTALL_METADATA_PATH, installMetadata, writes);
    await addMetadataWrite(configRoot, LIFECYCLE_METADATA_PATH, lifecycleMetadata, writes);
  }
  return { preview, writes, deletes, installMetadata, lifecycleMetadata };
}

async function prepareSemanticRetirements(
  configRoot: string,
  target: LoadedProfilePackage,
  installed: InstalledProfileMetadata | undefined,
  lifecycle: ProfileLifecycleMetadata | undefined,
): Promise<PreparedSemanticRetirement[]> {
  if (installed === undefined || installed.bundleSha256 === target.manifest.bundle_sha256)
    return [];
  const descriptors = target.manifest.migrations ?? [];
  if (descriptors.length === 0) return [];

  const rangeMatches = descriptors.filter((descriptor) =>
    satisfies(installed.profile.version, descriptor.from_profile_range),
  );
  const exact = rangeMatches.filter((descriptor) =>
    descriptor.from_bundle_sha256.includes(installed.bundleSha256),
  );
  const digestMatches = descriptors.filter((descriptor) =>
    descriptor.from_bundle_sha256.includes(installed.bundleSha256),
  );
  if (digestMatches.length > 0 && exact.length === 0) {
    throw new ProfileInstallError(
      "retirement_source_version",
      `bundle ${installed.bundleSha256} is named by a retirement whose source profile range excludes ${installed.profile.version}`,
    );
  }
  if (
    exact.length === 0 &&
    rangeMatches.length === 0 &&
    descriptors.every((descriptor) => gtr(installed.profile.version, descriptor.from_profile_range))
  ) {
    return [];
  }
  if (exact.length === 0) {
    throw new ProfileInstallError(
      "retirement_source_bundle",
      `profile ${installed.profile.version} bundle ${installed.bundleSha256} is not an authorized source for this semantic-retirement release`,
    );
  }
  if (lifecycle === undefined) {
    throw new ProfileInstallError(
      "retirement_lifecycle",
      "semantic retirement requires authenticated lifecycle history",
    );
  }
  for (const descriptor of exact) {
    const prior = lifecycle.semanticRetirements.find((entry) => entry.id === descriptor.id);
    if (prior !== undefined) {
      throw new ProfileInstallError(
        "retirement_replay",
        `semantic retirement ${descriptor.id} was already applied to ${prior.targetBundleSha256}`,
      );
    }
  }

  const sourceArchive = lifecycle.immutableBaselines.find(
    (entry) => entry.bundleSha256 === installed.bundleSha256,
  );
  if (sourceArchive === undefined) {
    throw new ProfileInstallError(
      "baseline_store_corrupt",
      "retirement source baseline is absent from immutable history",
    );
  }
  const resources = exact.map((descriptor) => {
    const bytes = target.migrationResources.get(descriptor.path);
    if (bytes === undefined || rawSha256(bytes) !== descriptor.sha256) {
      throw new ProfileInstallError(
        "migration_resource_sha256",
        `retirement resource is absent or corrupt: ${descriptor.path}`,
      );
    }
    return parseProfileRetirementResource(bytes, descriptor.id);
  });
  try {
    assertProfileRetirementResourcesNonOverlapping(resources);
  } catch (error) {
    throw new ProfileInstallError(
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "retirement_operation_overlap",
      error instanceof Error ? error.message : String(error),
    );
  }

  const sourceFiles = new Map<string, Uint8Array>();
  const projectFiles = new Map<string, Uint8Array | undefined>();
  const targetFiles = new Map<string, Uint8Array>();
  const operationFiles = new Set(
    resources.flatMap((resource) => resource.operations.map((operation) => operation.file)),
  );
  for (const relative of [...operationFiles].sort(compareUtf8)) {
    const sourceDescriptor = installed.baselineFiles.find((file) => file.path === relative);
    const targetDescriptor = target.manifest.baseline.files.find((file) => file.path === relative);
    if (
      sourceDescriptor === undefined ||
      targetDescriptor === undefined ||
      sourceDescriptor.kind !== "config" ||
      targetDescriptor.kind !== "config" ||
      !/\.ya?ml$/u.test(relative)
    ) {
      throw new ProfileInstallError(
        "retirement_config_inventory",
        `retirement file must be a source-and-target authenticated YAML config: ${relative}`,
      );
    }
    const source = await readOptionalFile(
      path.join(configRoot, sourceArchive.root, "files", relative),
    );
    if (source === undefined || rawSha256(source) !== sourceDescriptor.sha256) {
      throw new ProfileInstallError(
        "baseline_store_corrupt",
        `retirement source baseline changed: ${relative}`,
      );
    }
    const targetBytes = target.files.get(relative);
    if (targetBytes === undefined || rawSha256(targetBytes) !== targetDescriptor.sha256) {
      throw new ProfileInstallError(
        "baseline_store_corrupt",
        `retirement target baseline changed: ${relative}`,
      );
    }
    sourceFiles.set(relative, source);
    projectFiles.set(relative, await readOptionalFile(path.join(configRoot, relative)));
    targetFiles.set(relative, targetBytes);
  }

  const prepared: PreparedSemanticRetirement[] = [];
  for (const descriptor of [...exact].sort((left, right) => compareUtf8(left.id, right.id))) {
    const resourceBytes = target.migrationResources.get(descriptor.path)!;
    let plan: ProfileRetirementPlan;
    try {
      plan = planProfileRetirement({
        resourceBytes,
        expectedId: descriptor.id,
        sourceBundleSha256: installed.bundleSha256,
        targetBundleSha256: target.manifest.bundle_sha256,
        sourceBaselineFiles: sourceFiles,
        projectFiles,
        targetBaselineFiles: targetFiles,
      });
    } catch (error) {
      throw new ProfileInstallError(
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : "retirement_plan_invalid",
        error instanceof Error ? error.message : String(error),
      );
    }
    prepared.push({ descriptor, plan });
    for (const [relative, bytes] of plan.changedProjectFiles) projectFiles.set(relative, bytes);
  }
  return prepared;
}

async function mergeProfileYamlUpgrade(
  input: Readonly<{
    configRoot: string;
    installed: InstalledProfileMetadata | undefined;
    lifecycle: ProfileLifecycleMetadata | undefined;
    descriptor: ProfileBaselineFile;
    old: ProfileBaselineFile;
    current: Uint8Array;
    upstream: Uint8Array;
  }>,
): Promise<YamlThreeWayMergeResult | undefined> {
  if (
    input.descriptor.kind !== "config" ||
    !/\.ya?ml$/u.test(input.descriptor.path) ||
    input.installed === undefined ||
    input.lifecycle === undefined
  )
    return undefined;
  const archived = input.lifecycle.immutableBaselines.find(
    (entry) => entry.bundleSha256 === input.installed!.bundleSha256,
  );
  if (archived === undefined) {
    throw new ProfileInstallError(
      "baseline_store_corrupt",
      `installed baseline archive is absent for ${input.descriptor.path}`,
    );
  }
  const base = await readOptionalFile(
    path.join(input.configRoot, archived.root, "files", input.descriptor.path),
  );
  if (base === undefined || rawSha256(base) !== input.old.sha256) {
    throw new ProfileInstallError(
      "baseline_store_corrupt",
      `installed baseline bytes changed: ${input.descriptor.path}`,
    );
  }
  return threeWayMergeYaml(base, input.current, input.upstream);
}

async function addUpstreamProposal(
  configRoot: string,
  manifest: ProfilePackageManifest,
  sourcePath: string,
  bytes: Uint8Array,
  reason: "modified" | "deleted",
  writes: TransactionWrite[],
  pending: PendingUpstreamChange[],
  includeWrites: boolean,
  oldBaselineSha256: Sha256Digest | undefined,
  newBaselineSha256: Sha256Digest,
  projectSha256: Sha256Digest | null,
  conflictPaths?: readonly string[],
): Promise<void> {
  const bundleSuffix = manifest.bundle_sha256.slice("sha256:".length, "sha256:".length + 16);
  const proposedPath = `.managed/upstream/${manifest.profile.version}-${bundleSuffix}/${sourcePath}`;
  const current = await readOptionalFile(path.join(configRoot, proposedPath));
  if (current === undefined) {
    if (includeWrites) writes.push({ path: proposedPath, bytes, expectedSha256: null });
  } else if (rawSha256(current) !== rawSha256(bytes)) {
    throw new ProfileInstallError(
      "proposal_collision",
      `upstream proposal changed unexpectedly: ${proposedPath}`,
    );
  }
  pending.push({
    path: sourcePath,
    proposedPath,
    reason,
    ...(oldBaselineSha256 === undefined ? {} : { oldBaselineSha256 }),
    newBaselineSha256,
    projectSha256,
    ...(conflictPaths === undefined ? {} : { conflictPaths: [...conflictPaths] }),
  });
}

async function addImmutableBaselineWrites(
  configRoot: string,
  baseline: LoadedProfilePackage,
  storageRoot: string,
  writes: TransactionWrite[],
): Promise<void> {
  const manifestBytes = Buffer.from(`${JSON.stringify(baseline.manifest, null, 2)}\n`, "utf8");
  await addImmutableWrite(
    configRoot,
    `${storageRoot}/profile-manifest.json`,
    manifestBytes,
    writes,
  );
  for (const descriptor of baseline.manifest.baseline.files) {
    await addImmutableWrite(
      configRoot,
      `${storageRoot}/files/${descriptor.path}`,
      baseline.files.get(descriptor.path)!,
      writes,
    );
  }
  for (const descriptor of baseline.manifest.migrations ?? []) {
    await addImmutableWrite(
      configRoot,
      `${storageRoot}/migration-resources/${descriptor.path}`,
      baseline.migrationResources.get(descriptor.path)!,
      writes,
    );
  }
}

async function addImmutableWrite(
  configRoot: string,
  relative: string,
  bytes: Uint8Array,
  writes: TransactionWrite[],
): Promise<void> {
  const current = await readOptionalFile(path.join(configRoot, relative));
  if (current === undefined) {
    writes.push({ path: relative, bytes, expectedSha256: null });
  } else if (rawSha256(current) !== rawSha256(bytes)) {
    throw new ProfileInstallError(
      "baseline_store_corrupt",
      `immutable baseline bytes changed: ${relative}`,
    );
  }
}

async function addMetadataWrite(
  configRoot: string,
  relative: string,
  value: unknown,
  writes: TransactionWrite[],
): Promise<void> {
  const existing = writes.find((write) => write.path === relative);
  if (existing !== undefined)
    throw new ProfileInstallError("duplicate_metadata", `duplicate write: ${relative}`);
  const current = await readOptionalFile(path.join(configRoot, relative));
  writes.push({
    path: relative,
    bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
    expectedSha256: current === undefined ? null : rawSha256(current),
  });
}

function computeOverlay(
  baselineFiles: readonly ProfileBaselineFile[],
  effective: ReadonlyMap<string, Sha256Digest>,
): ProjectOverlayEntry[] {
  const baseline = new Map(baselineFiles.map((file) => [file.path, file] as const));
  const entries: ProjectOverlayEntry[] = [];
  for (const descriptor of baselineFiles) {
    const current = effective.get(descriptor.path);
    if (current === undefined) {
      entries.push({
        path: descriptor.path,
        disposition: "deleted",
        projectSha256: null,
        baselineSha256: descriptor.sha256,
      });
    } else if (current !== descriptor.sha256) {
      entries.push({
        path: descriptor.path,
        disposition: "modified",
        projectSha256: current,
        baselineSha256: descriptor.sha256,
      });
    }
  }
  for (const [relative, digest] of effective) {
    if (!baseline.has(relative))
      entries.push({ path: relative, disposition: "added", projectSha256: digest });
  }
  return entries.sort((left, right) => compareUtf8(left.path, right.path));
}

async function projectedProjectContents(
  configRoot: string,
  writes: readonly TransactionWrite[],
  deletes: readonly TransactionDelete[],
): Promise<Map<string, Uint8Array>> {
  const projected = new Map<string, Uint8Array>();
  if (await directoryExists(configRoot)) {
    for (const relative of await listProjectFiles(configRoot)) {
      if (isCompilerOwned(relative)) continue;
      const bytes = await readOptionalFile(path.join(configRoot, relative));
      if (bytes !== undefined) projected.set(relative, bytes);
    }
  }
  for (const entry of deletes) if (!isCompilerOwned(entry.path)) projected.delete(entry.path);
  for (const write of writes)
    if (!isCompilerOwned(write.path)) projected.set(write.path, write.bytes);
  return projected;
}

function inventoryProjectFiles(
  contents: ReadonlyMap<string, Uint8Array>,
  baselineFiles: readonly ProfileBaselineFile[],
): ProfileBaselineFile[] {
  const baseline = new Map(baselineFiles.map((file) => [file.path, file] as const));
  return [...contents]
    .map(([relative, bytes]) => ({
      path: relative,
      sha256: rawSha256(bytes),
      size_bytes: bytes.byteLength,
      kind: baseline.get(relative)?.kind ?? classifyProfilePath(relative),
    }))
    .sort((left, right) => compareUtf8(left.path, right.path));
}

function classifyProfilePath(relative: string): ProfileFileKind {
  if (relative.startsWith("agents/") && /\.ya?ml$/u.test(relative)) return "agent";
  if (relative.startsWith("resources/skills/") && relative.endsWith("/SKILL.md")) return "skill";
  if (relative.includes("/prompts/") && relative.endsWith(".md")) return "prompt";
  if (/\.ya?ml$/u.test(relative)) return "config";
  return "other";
}

async function readInstalledMetadata(
  configRoot: string,
): Promise<InstalledProfileMetadata | undefined> {
  const bytes = await readOptionalFile(path.join(configRoot, INSTALL_METADATA_PATH));
  if (bytes === undefined) return undefined;
  const value = parseJsonRecord(bytes, "install_record_invalid", "profile install record");
  rejectUnknownFields(
    value,
    [
      "protocol",
      "package",
      "profile",
      "compatibility",
      "bundleSha256",
      "installedAt",
      "baselineFiles",
      "migrations",
      "projectOverrides",
      "pendingUpstream",
    ],
    "install_record_invalid",
    "profile install record",
  );
  if (
    value.protocol !== INSTALL_PROTOCOL ||
    typeof value.installedAt !== "string" ||
    value.installedAt.length === 0 ||
    !isRecord(value.projectOverrides) ||
    !Array.isArray(value.pendingUpstream)
  ) {
    throw new ProfileInstallError(
      "install_record_invalid",
      "profile install record has an invalid shape",
    );
  }
  const manifest = validateProfilePackageManifest({
    protocol: "koni.profile-package.v1",
    package: value.package,
    profile: value.profile,
    compatibility: value.compatibility,
    baseline: { root: "./baseline", files: value.baselineFiles },
    bundle_sha256: value.bundleSha256,
    ...(value.migrations === undefined ? {} : { migrations: value.migrations }),
  });
  if (!manifest.ok) {
    throw new ProfileInstallError(
      "install_record_invalid",
      manifest.diagnostics
        .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`)
        .join("\n"),
    );
  }
  const projectOverrides: Record<string, Sha256Digest | null> = Object.create(null) as Record<
    string,
    Sha256Digest | null
  >;
  for (const [relative, digest] of Object.entries(value.projectOverrides)) {
    if (
      !isAuthoredPath(relative) ||
      (digest !== null && (typeof digest !== "string" || !isSha256Digest(digest)))
    ) {
      throw new ProfileInstallError(
        "install_record_invalid",
        `profile override is invalid: ${relative}`,
      );
    }
    projectOverrides[relative] = digest;
  }
  const pendingUpstream = value.pendingUpstream.map((entry) => parseCompactPending(entry));
  assertUniquePaths(pendingUpstream, "install_record_invalid", "pending upstream changes");
  return {
    protocol: INSTALL_PROTOCOL,
    package: manifest.value.package,
    profile: manifest.value.profile,
    compatibility: manifest.value.compatibility,
    bundleSha256: manifest.value.bundle_sha256,
    installedAt: value.installedAt,
    baselineFiles: [...manifest.value.baseline.files],
    ...((manifest.value.migrations?.length ?? 0) === 0
      ? {}
      : { migrations: [...manifest.value.migrations!] }),
    projectOverrides: sortRecord(projectOverrides),
    pendingUpstream,
  };
}

async function readLifecycleMetadata(
  configRoot: string,
): Promise<ProfileLifecycleMetadata | undefined> {
  const bytes = await readOptionalFile(path.join(configRoot, LIFECYCLE_METADATA_PATH));
  if (bytes === undefined) return undefined;
  const value = parseJsonRecord(bytes, "lifecycle_invalid", "profile lifecycle record");
  rejectUnknownFields(
    value,
    [
      "protocol",
      "generation",
      "lineage",
      "installedBundleSha256",
      "installedProfileVersion",
      "immutableBaselines",
      "overlay",
      "pendingUpstream",
      "upstreamResolutions",
      "migrations",
      "semanticRetirements",
      "createdAt",
      "updatedAt",
    ],
    "lifecycle_invalid",
    "profile lifecycle record",
  );
  if (
    value.protocol !== LIFECYCLE_PROTOCOL ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1 ||
    typeof value.lineage !== "string" ||
    value.lineage.length === 0 ||
    typeof value.installedBundleSha256 !== "string" ||
    !isSha256Digest(value.installedBundleSha256) ||
    typeof value.installedProfileVersion !== "string" ||
    valid(value.installedProfileVersion) === null ||
    !Array.isArray(value.immutableBaselines) ||
    !Array.isArray(value.overlay) ||
    !Array.isArray(value.pendingUpstream) ||
    (value.upstreamResolutions !== undefined && !Array.isArray(value.upstreamResolutions)) ||
    (value.migrations !== undefined && !Array.isArray(value.migrations)) ||
    (value.semanticRetirements !== undefined && !Array.isArray(value.semanticRetirements)) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new ProfileInstallError(
      "lifecycle_invalid",
      "profile lifecycle record has an invalid shape",
    );
  }
  const immutableBaselines = value.immutableBaselines.map((entry) => {
    if (!isRecord(entry))
      throw new ProfileInstallError(
        "lifecycle_invalid",
        "immutable baseline entry is not an object",
      );
    rejectUnknownFields(
      entry,
      ["bundleSha256", "profileVersion", "storedAt", "root"],
      "lifecycle_invalid",
      "immutable baseline entry",
    );
    if (
      typeof entry.bundleSha256 !== "string" ||
      !isSha256Digest(entry.bundleSha256) ||
      typeof entry.profileVersion !== "string" ||
      valid(entry.profileVersion) === null ||
      typeof entry.storedAt !== "string" ||
      entry.root !== baselineStorageRoot(entry.bundleSha256)
    ) {
      throw new ProfileInstallError(
        "lifecycle_invalid",
        "immutable baseline entry has an invalid shape",
      );
    }
    return {
      bundleSha256: entry.bundleSha256,
      profileVersion: entry.profileVersion,
      storedAt: entry.storedAt,
      root: entry.root,
    };
  });
  if (!immutableBaselines.some((entry) => entry.bundleSha256 === value.installedBundleSha256)) {
    throw new ProfileInstallError(
      "lifecycle_invalid",
      "installed bundle is absent from immutable baseline history",
    );
  }
  assertUnique(
    immutableBaselines.map((entry) => entry.bundleSha256),
    "lifecycle_invalid",
    "immutable baseline digest",
  );
  const overlay = value.overlay.map((entry) => parseOverlayEntry(entry));
  assertUniquePaths(overlay, "lifecycle_invalid", "overlay entries");
  const pendingUpstream = value.pendingUpstream.map((entry) => parsePending(entry));
  assertUniquePaths(pendingUpstream, "lifecycle_invalid", "pending upstream changes");
  const upstreamResolutions = (
    Array.isArray(value.upstreamResolutions) ? value.upstreamResolutions : []
  ).map((entry: unknown) => {
    if (!isRecord(entry))
      throw new ProfileInstallError("lifecycle_invalid", "upstream resolution is not an object");
    rejectUnknownFields(
      entry,
      [
        "path",
        "bundleSha256",
        "resolution",
        "resolvedAt",
        "projectSha256",
        "expectedProjectSha256",
        "authorityRequestSha256",
        "configurationSha256",
        "effectiveBundleSha256",
      ],
      "lifecycle_invalid",
      "upstream resolution",
    );
    const hasConfigurationWitness = entry.configurationSha256 !== undefined;
    const hasEffectiveBundleWitness = entry.effectiveBundleSha256 !== undefined;
    if (
      typeof entry.path !== "string" ||
      !isAuthoredPath(entry.path) ||
      typeof entry.bundleSha256 !== "string" ||
      !isSha256Digest(entry.bundleSha256) ||
      !["keep_project", "accept_upstream"].includes(String(entry.resolution)) ||
      typeof entry.resolvedAt !== "string" ||
      (entry.projectSha256 !== null &&
        (typeof entry.projectSha256 !== "string" || !isSha256Digest(entry.projectSha256))) ||
      (entry.expectedProjectSha256 !== undefined &&
        entry.expectedProjectSha256 !== null &&
        (typeof entry.expectedProjectSha256 !== "string" ||
          !isSha256Digest(entry.expectedProjectSha256))) ||
      (entry.authorityRequestSha256 !== undefined &&
        (typeof entry.authorityRequestSha256 !== "string" ||
          !isSha256Digest(entry.authorityRequestSha256))) ||
      hasConfigurationWitness !== hasEffectiveBundleWitness ||
      (hasConfigurationWitness &&
        (typeof entry.configurationSha256 !== "string" ||
          !isSha256Digest(entry.configurationSha256))) ||
      (hasEffectiveBundleWitness &&
        (typeof entry.effectiveBundleSha256 !== "string" ||
          !isSha256Digest(entry.effectiveBundleSha256)))
    ) {
      throw new ProfileInstallError(
        "lifecycle_invalid",
        "upstream resolution has an invalid shape",
      );
    }
    return {
      path: entry.path,
      bundleSha256: entry.bundleSha256,
      resolution: entry.resolution as "keep_project" | "accept_upstream",
      resolvedAt: entry.resolvedAt,
      projectSha256: entry.projectSha256,
      ...(entry.expectedProjectSha256 === undefined
        ? {}
        : { expectedProjectSha256: entry.expectedProjectSha256 }),
      ...(entry.authorityRequestSha256 === undefined
        ? {}
        : { authorityRequestSha256: entry.authorityRequestSha256 }),
      ...(entry.configurationSha256 === undefined
        ? {}
        : { configurationSha256: entry.configurationSha256 as Sha256Digest }),
      ...(entry.effectiveBundleSha256 === undefined
        ? {}
        : { effectiveBundleSha256: entry.effectiveBundleSha256 as Sha256Digest }),
    };
  });
  const migrations = (value.migrations ?? []).map((entry: unknown) => {
    if (!isRecord(entry))
      throw new ProfileInstallError("lifecycle_invalid", "migration entry is not an object");
    rejectUnknownFields(
      entry,
      ["id", "appliedAt", "artifactRoot"],
      "lifecycle_invalid",
      "migration entry",
    );
    if (
      typeof entry.id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(entry.id) ||
      typeof entry.appliedAt !== "string" ||
      entry.artifactRoot !== `.managed/migrations/${entry.id}`
    ) {
      throw new ProfileInstallError("lifecycle_invalid", "migration entry has an invalid shape");
    }
    return { id: entry.id, appliedAt: entry.appliedAt, artifactRoot: entry.artifactRoot };
  });
  assertUnique(
    migrations.map((entry) => entry.id),
    "lifecycle_invalid",
    "migration id",
  );
  const semanticRetirements = (value.semanticRetirements ?? []).map((entry: unknown) => {
    if (!isRecord(entry))
      throw new ProfileInstallError(
        "lifecycle_invalid",
        "semantic retirement entry is not an object",
      );
    rejectUnknownFields(
      entry,
      [
        "id",
        "sourceBundleSha256",
        "targetBundleSha256",
        "resourceSha256",
        "planSha256",
        "configurationSha256",
        "effectiveBundleSha256",
        "appliedAt",
        "artifactRoot",
      ],
      "lifecycle_invalid",
      "semantic retirement entry",
    );
    if (
      typeof entry.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(entry.id) ||
      typeof entry.sourceBundleSha256 !== "string" ||
      !isSha256Digest(entry.sourceBundleSha256) ||
      typeof entry.targetBundleSha256 !== "string" ||
      !isSha256Digest(entry.targetBundleSha256) ||
      typeof entry.resourceSha256 !== "string" ||
      !isSha256Digest(entry.resourceSha256) ||
      typeof entry.planSha256 !== "string" ||
      !isSha256Digest(entry.planSha256) ||
      typeof entry.configurationSha256 !== "string" ||
      !isSha256Digest(entry.configurationSha256) ||
      typeof entry.effectiveBundleSha256 !== "string" ||
      !isSha256Digest(entry.effectiveBundleSha256) ||
      typeof entry.appliedAt !== "string" ||
      entry.appliedAt.length === 0 ||
      entry.artifactRoot !== retirementArtifactRoot(entry.targetBundleSha256, entry.id)
    ) {
      throw new ProfileInstallError(
        "lifecycle_invalid",
        "semantic retirement entry has an invalid shape",
      );
    }
    return {
      id: entry.id,
      sourceBundleSha256: entry.sourceBundleSha256,
      targetBundleSha256: entry.targetBundleSha256,
      resourceSha256: entry.resourceSha256,
      planSha256: entry.planSha256,
      configurationSha256: entry.configurationSha256,
      effectiveBundleSha256: entry.effectiveBundleSha256,
      appliedAt: entry.appliedAt,
      artifactRoot: entry.artifactRoot,
    };
  });
  assertUnique(
    semanticRetirements.map((entry) => entry.id),
    "lifecycle_invalid",
    "semantic retirement id",
  );
  return {
    protocol: LIFECYCLE_PROTOCOL,
    generation: value.generation as number,
    lineage: value.lineage,
    installedBundleSha256: value.installedBundleSha256,
    installedProfileVersion: value.installedProfileVersion,
    immutableBaselines,
    overlay,
    pendingUpstream,
    upstreamResolutions,
    migrations,
    semanticRetirements,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseCompactPending(value: unknown): InstalledProfileMetadata["pendingUpstream"][number] {
  if (!isRecord(value))
    throw new ProfileInstallError(
      "install_record_invalid",
      "pending upstream entry is not an object",
    );
  rejectUnknownFields(
    value,
    ["path", "proposedPath", "reason", "conflictPaths"],
    "install_record_invalid",
    "pending upstream entry",
  );
  validatePendingCore(value, "install_record_invalid");
  return {
    path: value.path as string,
    proposedPath: value.proposedPath as string,
    reason: value.reason as PendingUpstreamReason,
    ...(value.conflictPaths === undefined
      ? {}
      : { conflictPaths: [...(value.conflictPaths as string[])] }),
  };
}

function parsePending(value: unknown): PendingUpstreamChange {
  if (!isRecord(value))
    throw new ProfileInstallError("lifecycle_invalid", "pending upstream entry is not an object");
  rejectUnknownFields(
    value,
    [
      "path",
      "proposedPath",
      "reason",
      "conflictPaths",
      "oldBaselineSha256",
      "newBaselineSha256",
      "projectSha256",
    ],
    "lifecycle_invalid",
    "pending upstream entry",
  );
  validatePendingCore(value, "lifecycle_invalid");
  for (const field of ["oldBaselineSha256", "newBaselineSha256"] as const) {
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "string" || !isSha256Digest(value[field]))
    ) {
      throw new ProfileInstallError("lifecycle_invalid", `pending upstream ${field} is invalid`);
    }
  }
  if (
    value.projectSha256 !== undefined &&
    value.projectSha256 !== null &&
    (typeof value.projectSha256 !== "string" || !isSha256Digest(value.projectSha256))
  ) {
    throw new ProfileInstallError(
      "lifecycle_invalid",
      "pending upstream project digest is invalid",
    );
  }
  return {
    path: value.path as string,
    proposedPath: value.proposedPath as string,
    reason: value.reason as PendingUpstreamReason,
    ...(value.conflictPaths === undefined
      ? {}
      : { conflictPaths: [...(value.conflictPaths as string[])] }),
    ...(value.oldBaselineSha256 === undefined
      ? {}
      : { oldBaselineSha256: value.oldBaselineSha256 as Sha256Digest }),
    ...(value.newBaselineSha256 === undefined
      ? {}
      : { newBaselineSha256: value.newBaselineSha256 as Sha256Digest }),
    ...(value.projectSha256 === undefined ? {} : { projectSha256: value.projectSha256 }),
  };
}

function validatePendingCore(value: Record<string, unknown>, code: string): void {
  if (
    typeof value.path !== "string" ||
    !isAuthoredPath(value.path) ||
    !["modified", "deleted", "orphaned"].includes(String(value.reason)) ||
    typeof value.proposedPath !== "string"
  ) {
    throw new ProfileInstallError(code, "pending upstream entry has an invalid shape");
  }
  if (value.reason === "orphaned") {
    if (value.proposedPath !== "")
      throw new ProfileInstallError(code, "orphaned upstream entry must not name proposal bytes");
  } else if (
    !value.proposedPath.startsWith(".managed/upstream/") ||
    !isNormalizedSafeRelativePath(value.proposedPath)
  ) {
    throw new ProfileInstallError(code, "pending upstream proposal path is unsafe");
  }
  if (value.conflictPaths !== undefined && !isValidYamlConflictPaths(value.conflictPaths)) {
    throw new ProfileInstallError(code, "pending upstream conflict paths are invalid");
  }
  if (value.reason !== "modified" && value.conflictPaths !== undefined) {
    throw new ProfileInstallError(code, "only modified YAML conflicts may name field paths");
  }
}

function parseOverlayEntry(value: unknown): ProjectOverlayEntry {
  if (!isRecord(value))
    throw new ProfileInstallError("lifecycle_invalid", "overlay entry is not an object");
  rejectUnknownFields(
    value,
    ["path", "disposition", "projectSha256", "baselineSha256"],
    "lifecycle_invalid",
    "overlay entry",
  );
  if (
    typeof value.path !== "string" ||
    !isAuthoredPath(value.path) ||
    !["added", "modified", "deleted", "orphaned"].includes(String(value.disposition)) ||
    (value.projectSha256 !== null &&
      (typeof value.projectSha256 !== "string" || !isSha256Digest(value.projectSha256))) ||
    (value.baselineSha256 !== undefined &&
      (typeof value.baselineSha256 !== "string" || !isSha256Digest(value.baselineSha256)))
  ) {
    throw new ProfileInstallError("lifecycle_invalid", "overlay entry has an invalid shape");
  }
  if (value.disposition === "deleted" && value.projectSha256 !== null)
    throw new ProfileInstallError(
      "lifecycle_invalid",
      "deleted overlay entry must have a null project digest",
    );
  if (value.disposition !== "deleted" && value.projectSha256 === null)
    throw new ProfileInstallError(
      "lifecycle_invalid",
      "materialized overlay entry must have a project digest",
    );
  return {
    path: value.path,
    disposition: value.disposition as ProjectOverlayEntry["disposition"],
    projectSha256: value.projectSha256,
    ...(value.baselineSha256 === undefined ? {} : { baselineSha256: value.baselineSha256 }),
  };
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
  label: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0)
    throw new ProfileInstallError(code, `${label} has unknown fields: ${unexpected.join(", ")}`);
}

function assertUniquePaths(values: readonly { path: string }[], code: string, label: string): void {
  assertUnique(
    values.map((value) => value.path),
    code,
    label,
  );
}

function assertUnique(values: readonly string[], code: string, label: string): void {
  if (new Set(values).size !== values.length)
    throw new ProfileInstallError(code, `${label} contains duplicates`);
}

function isAuthoredPath(relative: string): boolean {
  return isNormalizedSafeRelativePath(relative) && !isCompilerOwned(relative);
}

/**
 * Serialize lifecycle-owned profile effects. Callers must pass the canonical
 * `<project>/.koni` root and still use compare-and-swap writes for every
 * affected file. This is exported only so sibling profile authority modules
 * share the installer's lock domain.
 */
export async function withProfileLifecycleLock<T>(
  configRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(configRoot, PROFILE_LOCK_PATH);
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  const handle = await acquireProfileLock(lockPath, nonce);
  try {
    return await profileLifecycleContext.run({ configRoot, nonce }, operation);
  } finally {
    await handle.close();
    const current = await readOptionalFile(lockPath);
    if (current !== undefined) {
      const value = parseJsonRecord(current, "profile_lock_changed", "profile lifecycle lock");
      if (value.nonce !== nonce || value.pid !== process.pid) {
        // Lock theft invalidates any operation result, including a successful result or prior error.
        // eslint-disable-next-line no-unsafe-finally
        throw new ProfileInstallError(
          "profile_lock_changed",
          "profile lifecycle lock ownership changed during the operation",
        );
      }
      await rm(lockPath, { force: true });
    }
  }
}

/**
 * True only inside the async operation that owns this exact profile lock.
 *
 * The compiler uses this to distinguish internal candidate validation from an
 * unrelated run creation racing in the same process. A PID check cannot make
 * that distinction because independent async operations share a PID.
 */
export function currentContextOwnsProfileLifecycleLock(configRoot: string): boolean {
  return profileLifecycleContext.getStore()?.configRoot === configRoot;
}

async function acquireProfileLock(
  lockPath: string,
  nonce: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      const staleBytes = await readOptionalFile(lockPath);
      if (staleBytes === undefined) continue;
      const stale = parseJsonRecord(staleBytes, "profile_lock_invalid", "profile lifecycle lock");
      if (
        stale.protocol !== "koni.profile-lock.v1" ||
        !Number.isSafeInteger(stale.pid) ||
        typeof stale.nonce !== "string"
      ) {
        throw new ProfileInstallError(
          "profile_lock_invalid",
          "profile lifecycle lock is malformed",
        );
      }
      if (processIsAlive(stale.pid as number)) {
        throw new ProfileInstallError(
          "profile_locked",
          "another profile lifecycle operation is active",
        );
      }
      const quarantine = `${lockPath}.stale-${randomUUID()}`;
      try {
        await rename(lockPath, quarantine);
      } catch (renameError) {
        if (isCode(renameError, "ENOENT")) continue;
        throw renameError;
      }
      const quarantined = await readStableRegularFile(quarantine);
      if (rawSha256(quarantined) !== rawSha256(staleBytes)) {
        throw new ProfileInstallError(
          "profile_lock_race",
          "profile lifecycle lock changed during stale-lock recovery",
        );
      }
      await rm(quarantine, { force: true });
      continue;
    }
    try {
      await handle.writeFile(
        `${JSON.stringify({
          protocol: "koni.profile-lock.v1",
          pid: process.pid,
          nonce,
          createdAt: new Date().toISOString(),
        })}\n`,
      );
      await handle.sync();
      return handle;
    } catch (error) {
      await handle.close();
      await rm(lockPath, { force: true });
      throw error;
    }
  }
  throw new ProfileInstallError("profile_locked", "could not acquire the profile lifecycle lock");
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isCode(error, "ESRCH")) return false;
    return true;
  }
}

async function readAllRegularFiles(root: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  let totalBytes = 0;
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 128)
      throw new ProfileInstallError(
        "package_depth",
        "profile baseline exceeds directory depth bound",
      );
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      compareUtf8(a.name, b.name),
    )) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (!isNormalizedSafeRelativePath(relative))
        throw new ProfileInstallError("package_path", `unsafe profile path: ${relative}`);
      if (entry.isSymbolicLink())
        throw new ProfileInstallError(
          "package_symlink",
          `profile baseline contains a symlink: ${relative}`,
        );
      if (entry.isDirectory()) await walk(absolute, relative, depth + 1);
      else if (entry.isFile()) {
        if (files.size >= MAX_PROFILE_FILES)
          throw new ProfileInstallError(
            "package_count",
            "profile baseline contains too many files",
          );
        const bytes = await readStableRegularFile(absolute);
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_PROFILE_BYTES)
          throw new ProfileInstallError("package_size", "profile baseline is too large");
        files.set(relative, bytes);
      } else
        throw new ProfileInstallError(
          "package_file_type",
          `profile baseline has an unsupported file: ${relative}`,
        );
    }
  };
  await walk(root, "", 0);
  return files;
}

async function listProjectFiles(root: string): Promise<string[]> {
  if (!(await directoryExists(root))) return [];
  const files: string[] = [];
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 128)
      throw new ProfileInstallError("project_depth", ".koni exceeds directory depth bound");
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      compareUtf8(a.name, b.name),
    )) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new ProfileInstallError(
          "unsafe_project_file",
          `project config contains a symlink: ${relative}`,
        );
      if (entry.isDirectory()) await walk(absolute, relative, depth + 1);
      else if (entry.isFile()) files.push(relative);
      else
        throw new ProfileInstallError(
          "unsafe_project_file",
          `project config contains an unsupported file: ${relative}`,
        );
    }
  };
  await walk(root, "", 0);
  return files;
}

async function readOptionalFile(filePath: string): Promise<Buffer | undefined> {
  try {
    return await readStableRegularFile(filePath);
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function readStableRegularFile(filePath: string): Promise<Buffer> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollow);
    const before = await handle.stat();
    if (!before.isFile())
      throw new ProfileInstallError(
        "unsafe_project_file",
        `path is not a regular file: ${filePath}`,
      );
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new ProfileInstallError(
        "project_file_changed",
        `file changed while it was read: ${filePath}`,
      );
    }
    return bytes;
  } finally {
    await handle?.close();
  }
}

async function assertOptionalRealConfigRoot(configRoot: string): Promise<void> {
  try {
    const metadata = await lstat(configRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ProfileInstallError("unsafe_config_root", ".koni must be a real directory");
    }
    if ((await realpath(configRoot)) !== configRoot) {
      throw new ProfileInstallError("config_escape", ".koni escapes the canonical project root");
    }
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}

async function assertOptionalRealPiRoot(piRoot: string, projectRoot: string): Promise<void> {
  try {
    const metadata = await lstat(piRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ProfileInstallError("unsafe_pi_root", ".pi must be a real directory");
    }
    const canonical = await realpath(piRoot);
    if (canonical !== piRoot || !isWithin(projectRoot, canonical)) {
      throw new ProfileInstallError("pi_root_escape", ".pi escapes the canonical project root");
    }
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}

async function canonicalRealDirectory(input: string, code: string): Promise<string> {
  const absolute = path.resolve(input);
  let canonical: string;
  try {
    canonical = await realpath(absolute);
    const metadata = await lstat(canonical);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("not a real directory");
  } catch (error) {
    throw new ProfileInstallError(
      code,
      `directory is unavailable or unsafe: ${absolute}: ${String(error)}`,
    );
  }
  return canonical;
}

function baselineStorageRoot(digest: Sha256Digest): string {
  return `.managed/baselines/${digest.slice("sha256:".length)}`;
}

function retirementArtifactRoot(targetBundleSha256: Sha256Digest, id: string): string {
  return `.managed/retirements/${targetBundleSha256.slice("sha256:".length)}/${id}`;
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isCompilerOwned(relative: string): boolean {
  const root = relative.split("/", 1)[0];
  return (
    root === ".managed" ||
    root === ".transactions" ||
    root === "runs" ||
    relative === PROFILE_LOCK_PATH
  );
}

function parseJsonRecord(bytes: Uint8Array, code: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new ProfileInstallError(code, `${label} is not valid JSON`);
  }
  if (!isRecord(value)) throw new ProfileInstallError(code, `${label} is not an object`);
  return value;
}

function sortRecord<T>(input: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => compareUtf8(left, right)),
  );
}

async function directoryExists(input: string): Promise<boolean> {
  try {
    const metadata = await lstat(input);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
