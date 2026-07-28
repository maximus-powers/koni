import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { CompiledConfiguration } from "../contracts/configuration.js";
import {
  PROFILE_PACKAGE_BASELINE_ROOT,
  PROFILE_PACKAGE_PROTOCOL,
  type ProfileBaselineFile,
  type ProfileFileKind,
  type ProfilePackageManifest,
} from "../contracts/profile-package.js";
import { canonicalHash, compareUtf8, isSha256Digest, rawSha256 } from "../shared/canonical.js";
import {
  DiagnosticBag,
  pointer,
  validationFailure,
  type ValidationResult,
} from "../shared/diagnostics.js";
import type { StrictYamlLimits } from "../shared/yaml.js";
import { currentContextOwnsProfileLifecycleLock } from "../profile/install.js";
import {
  compileProjectConfiguration,
  type AuthenticatedProjectConfigurationSource,
} from "./configuration.js";
import {
  isNormalizedSafeRelativePath,
  validateProfilePackageManifest,
  verifyProfileBaseline,
  type VerifiedProfileBaseline,
} from "./profile-package.js";

const INSTALL_PROTOCOL = "koni.profile-install.v1" as const;
const INSTALL_METADATA_PATH = ".managed/install.json";
const MAX_INSTALL_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_AUTHORED_FILES = 16_384;
const MAX_AUTHORED_ENTRIES = 65_536;
const MAX_AUTHORED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_AUTHORED_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_IGNORED_ENTRIES = 100_000;
const MAX_DIRECTORY_DEPTH = 128;
const PROFILE_LIFECYCLE_LOCK_PATH = ".managed/profile-lifecycle.lock";
const PROFILE_TRANSACTION_ROOT = ".transactions";

/**
 * These roots are compiler-owned state, not project-authored configuration.
 * `runs` is reserved for legacy/offline layouts; current authority state lives
 * beneath the Git common directory and therefore never enters `.koni`.
 */
export const COMPILER_OWNED_PROJECT_CONFIG_ROOTS: readonly string[] = Object.freeze([
  ".managed",
  ".transactions",
  "runs",
]);

export interface CompileProjectDirectoryOptions {
  yamlLimits?: Partial<StrictYamlLimits>;
}

interface InstalledProfileMetadata {
  manifest: ProfilePackageManifest;
  metadataSha256: ReturnType<typeof rawSha256>;
}

interface ProjectTreeSnapshot {
  files: readonly ProfileBaselineFile[];
  contents: ReadonlyMap<string, Uint8Array>;
  snapshotSha256: ReturnType<typeof canonicalHash>;
}

/**
 * Compile the editable `<project>/.koni` tree for execution.
 *
 * `packageBaseline` is mandatory execution authority and must come from a
 * trusted package resolver. This boundary reverifies its manifest and baseline
 * bytes, then requires the compiler-owned install record to describe that exact
 * package provenance. The install record is never sufficient authority by
 * itself. Current project files are read with no-follow containment checks and
 * a stable double snapshot before being passed to `compileProjectConfiguration`.
 */
export async function compileProjectDirectory(
  projectRoot: string,
  packageBaseline: VerifiedProfileBaseline,
  options: CompileProjectDirectoryOptions = {},
): Promise<ValidationResult<CompiledConfiguration>> {
  const packageSource = verifyProfileBaseline(packageBaseline.manifest, packageBaseline.files);
  if (!packageSource.ok) return packageSource;
  // Isolate execution provenance from caller mutation before the first await.
  const trustedManifest = structuredClone(packageSource.value.manifest);

  const bag = new DiagnosticBag();
  const roots = await resolveProjectRoots(projectRoot, bag);
  if (roots === undefined) return validationFailure(bag.sorted());

  await assertProfilePublicationIdle(roots.configRoot, bag);
  if (bag.hasErrors()) return validationFailure(bag.sorted());

  const initialInstall = await readInstalledProfileMetadata(roots.configRoot, bag);
  if (initialInstall === undefined) return validationFailure(bag.sorted());
  validateInstalledProvenance(initialInstall.manifest, trustedManifest, bag);
  if (bag.hasErrors()) return validationFailure(bag.sorted());

  const first = await snapshotProjectTree(roots.configRoot, trustedManifest.baseline.files, bag);
  if (first === undefined) return validationFailure(bag.sorted());
  await assertProfilePublicationIdle(roots.configRoot, bag);
  if (bag.hasErrors()) return validationFailure(bag.sorted());
  const second = await snapshotProjectTree(roots.configRoot, trustedManifest.baseline.files, bag);
  if (second === undefined) return validationFailure(bag.sorted());
  await assertProfilePublicationIdle(roots.configRoot, bag);
  if (first.snapshotSha256 !== second.snapshotSha256) {
    bag.error(
      "project_source.changed",
      "/project_files",
      "project configuration changed while its authenticated snapshot was being read",
    );
  }

  const finalInstall = await readInstalledProfileMetadata(roots.configRoot, bag);
  if (finalInstall === undefined) return validationFailure(bag.sorted());
  validateInstalledProvenance(finalInstall.manifest, trustedManifest, bag);
  if (initialInstall.metadataSha256 !== finalInstall.metadataSha256) {
    bag.error(
      "project_source.install_changed",
      "/install",
      "profile install provenance changed while project configuration was being read",
    );
  }
  await assertProfilePublicationIdle(roots.configRoot, bag);
  if (bag.hasErrors()) return validationFailure(bag.sorted());

  const source: AuthenticatedProjectConfigurationSource = {
    manifest: trustedManifest,
    files: second.files,
    contents: second.contents,
  };
  const compiled = compileProjectConfiguration(source, options);
  if (!compiled.ok) {
    bag.extend(compiled.diagnostics);
    return validationFailure(bag.sorted());
  }
  bag.extend(compiled.diagnostics);
  return { ok: true, value: compiled.value, diagnostics: bag.sorted() };
}

/**
 * Profile publication is a multi-file crash-forward transaction. Compilation
 * may proceed while the current async context owns the lifecycle lock (the
 * guided editor validates candidates there), but unrelated compilation must
 * never observe the publication window. Any transaction directory means
 * recovery/cleanup has not completed and therefore also fails closed.
 */
async function assertProfilePublicationIdle(configRoot: string, bag: DiagnosticBag): Promise<void> {
  const lockPath = path.join(configRoot, PROFILE_LIFECYCLE_LOCK_PATH);
  try {
    const metadata = await lstat(lockPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      bag.error(
        "project_source.profile_lock_unsafe",
        "/compiler_state/profile_lifecycle_lock",
        "profile lifecycle lock is not a regular file",
      );
    } else if (!currentContextOwnsProfileLifecycleLock(configRoot)) {
      bag.error(
        "project_source.profile_update_active",
        "/compiler_state/profile_lifecycle_lock",
        "profile configuration is being published; retry after the lifecycle operation finishes",
      );
    }
  } catch (error) {
    if (!isFilesystemCode(error, "ENOENT")) {
      addFilesystemDiagnostic(
        bag,
        "/compiler_state/profile_lifecycle_lock",
        "could not authenticate profile lifecycle state",
        error,
      );
    }
  }

  const transactionRoot = path.join(configRoot, PROFILE_TRANSACTION_ROOT);
  try {
    const metadata = await lstat(transactionRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      bag.error(
        "project_source.transaction_root_unsafe",
        "/compiler_state/transactions",
        "profile transaction root is not a regular directory",
      );
      return;
    }
    const entries = await readdir(transactionRoot, { withFileTypes: true });
    if (entries.length > 0) {
      bag.error(
        "project_source.transaction_pending",
        "/compiler_state/transactions",
        "profile transaction recovery or cleanup is required before configuration can be compiled",
      );
    }
  } catch (error) {
    if (!isFilesystemCode(error, "ENOENT")) {
      addFilesystemDiagnostic(
        bag,
        "/compiler_state/transactions",
        "could not authenticate profile transaction state",
        error,
      );
    }
  }
}

async function resolveProjectRoots(
  projectRoot: string,
  bag: DiagnosticBag,
): Promise<{ projectRoot: string; configRoot: string } | undefined> {
  if (
    typeof projectRoot !== "string" ||
    projectRoot.length === 0 ||
    projectRoot.includes("\u0000")
  ) {
    bag.error(
      "project_source.root",
      "/project_root",
      "project root must be a nonempty filesystem path",
    );
    return undefined;
  }
  try {
    const canonicalProjectRoot = await realpath(path.resolve(projectRoot));
    const projectMetadata = await lstat(canonicalProjectRoot);
    if (!projectMetadata.isDirectory() || projectMetadata.isSymbolicLink()) {
      bag.error("project_source.root_type", "/project_root", "project root is not a directory");
      return undefined;
    }
    const configRoot = path.join(canonicalProjectRoot, ".koni");
    const configMetadata = await lstat(configRoot);
    if (!configMetadata.isDirectory() || configMetadata.isSymbolicLink()) {
      bag.error(
        "project_source.config_type",
        "/project_root/.koni",
        ".koni is not a regular directory",
      );
      return undefined;
    }
    const canonicalConfigRoot = await realpath(configRoot);
    if (
      canonicalConfigRoot !== configRoot ||
      !isWithin(canonicalProjectRoot, canonicalConfigRoot)
    ) {
      bag.error(
        "project_source.config_escape",
        "/project_root/.koni",
        ".koni escapes the canonical project root",
      );
      return undefined;
    }
    return { projectRoot: canonicalProjectRoot, configRoot: canonicalConfigRoot };
  } catch (error) {
    addFilesystemDiagnostic(
      bag,
      "/project_root/.koni",
      "could not resolve the project configuration root",
      error,
    );
    return undefined;
  }
}

async function readInstalledProfileMetadata(
  configRoot: string,
  bag: DiagnosticBag,
): Promise<InstalledProfileMetadata | undefined> {
  const bytes = await readContainedFile(
    configRoot,
    INSTALL_METADATA_PATH,
    MAX_INSTALL_METADATA_BYTES,
    bag,
    "/install",
  );
  if (bytes === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    bag.error(
      "project_source.install_json",
      "/install",
      "profile install record is not valid JSON",
    );
    return undefined;
  }
  if (!isPlainRecord(value)) {
    bag.error(
      "project_source.install_shape",
      "/install",
      "profile install record must be an object",
    );
    return undefined;
  }
  const allowed = new Set([
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
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      bag.error(
        "project_source.install_field",
        pointer("/install", key),
        "profile install record contains an unknown field",
      );
    }
  }
  if (value.protocol !== INSTALL_PROTOCOL) {
    bag.error(
      "project_source.install_protocol",
      "/install/protocol",
      "profile install record protocol is not supported",
    );
  }
  if (typeof value.installedAt !== "string" || value.installedAt.length === 0) {
    bag.error(
      "project_source.install_timestamp",
      "/install/installedAt",
      "profile install timestamp is missing",
    );
  }
  validateInstallBookkeeping(value, bag);
  const candidate = {
    protocol: PROFILE_PACKAGE_PROTOCOL,
    package: value.package,
    profile: value.profile,
    compatibility: value.compatibility,
    baseline: {
      root: PROFILE_PACKAGE_BASELINE_ROOT,
      files: value.baselineFiles,
    },
    bundle_sha256: value.bundleSha256,
    ...(value.migrations === undefined ? {} : { migrations: value.migrations }),
  };
  const manifest = validateProfilePackageManifest(candidate);
  bag.extend(
    manifest.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      path: `/install/provenance${diagnostic.path}`,
    })),
  );
  if (!manifest.ok || bag.hasErrors()) return undefined;
  return { manifest: manifest.value, metadataSha256: rawSha256(bytes) };
}

function validateInstallBookkeeping(value: Record<string, unknown>, bag: DiagnosticBag): void {
  if (!isPlainRecord(value.projectOverrides)) {
    bag.error(
      "project_source.install_overrides",
      "/install/projectOverrides",
      "project overrides must be an object",
    );
  } else {
    for (const [relative, digest] of Object.entries(value.projectOverrides)) {
      if (!isNormalizedSafeRelativePath(relative) || (digest !== null && !isSha256Digest(digest))) {
        bag.error(
          "project_source.install_override",
          pointer("/install/projectOverrides", relative),
          "project override entry is invalid",
        );
      }
    }
  }
  if (!Array.isArray(value.pendingUpstream) || value.pendingUpstream.length > MAX_AUTHORED_FILES) {
    bag.error(
      "project_source.install_pending",
      "/install/pendingUpstream",
      "pending upstream entries are invalid or unbounded",
    );
    return;
  }
  for (const [index, entry] of value.pendingUpstream.entries()) {
    const location = pointer("/install/pendingUpstream", index);
    if (
      !isPlainRecord(entry) ||
      typeof entry.path !== "string" ||
      !isNormalizedSafeRelativePath(entry.path) ||
      typeof entry.proposedPath !== "string" ||
      (entry.proposedPath.length > 0 && !isNormalizedSafeRelativePath(entry.proposedPath)) ||
      !["modified", "deleted", "orphaned"].includes(String(entry.reason)) ||
      (entry.conflictPaths !== undefined &&
        (entry.reason !== "modified" || !validPendingConflictPaths(entry.conflictPaths)))
    ) {
      bag.error(
        "project_source.install_pending_entry",
        location,
        "pending upstream entry is invalid",
      );
    }
  }
}

function validPendingConflictPaths(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4_096) return false;
  let previous: string | undefined;
  for (const fieldPath of value) {
    if (
      typeof fieldPath !== "string" ||
      fieldPath.length === 0 ||
      Buffer.byteLength(fieldPath, "utf8") > 4_096 ||
      !fieldPath.startsWith("/") ||
      /~(?:[^01]|$)/u.test(fieldPath) ||
      (previous !== undefined && compareUtf8(previous, fieldPath) >= 0)
    )
      return false;
    previous = fieldPath;
  }
  return true;
}

function validateInstalledProvenance(
  installed: ProfilePackageManifest,
  expected: ProfilePackageManifest,
  bag: DiagnosticBag,
): void {
  const installedMaterial = profileProvenanceMaterial(installed);
  const expectedMaterial = profileProvenanceMaterial(expected);
  if (canonicalHash(installedMaterial) !== canonicalHash(expectedMaterial)) {
    bag.error(
      "project_source.provenance_mismatch",
      "/install/provenance",
      "installed profile provenance does not match the trusted package source",
    );
  }
}

function profileProvenanceMaterial(manifest: ProfilePackageManifest): object {
  return {
    protocol: manifest.protocol,
    package: manifest.package,
    profile: manifest.profile,
    compatibility: manifest.compatibility,
    baseline: manifest.baseline,
    ...(manifest.migrations === undefined ? {} : { migrations: manifest.migrations }),
    bundle_sha256: manifest.bundle_sha256,
  };
}

async function snapshotProjectTree(
  configRoot: string,
  baselineFiles: readonly ProfileBaselineFile[],
  bag: DiagnosticBag,
): Promise<ProjectTreeSnapshot | undefined> {
  const baseline = new Map(baselineFiles.map((file) => [file.path, file] as const));
  const files: ProfileBaselineFile[] = [];
  const contents = new Map<string, Uint8Array>();
  let totalBytes = 0;
  let authoredEntries = 0;
  let ignoredEntries = 0;
  let authoredEntryLimitReached = false;
  let ignoredEntryLimitReached = false;

  const validateIgnoredTree = async (
    directory: string,
    relative: string,
    depth: number,
  ): Promise<void> => {
    if (ignoredEntryLimitReached) return;
    if (depth > MAX_DIRECTORY_DEPTH) {
      bag.error(
        "project_source.state_depth",
        pointer("/compiler_state", relative),
        "compiler-owned state exceeds its directory depth bound",
      );
      return;
    }
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      compareUtf8(left.name, right.name),
    )) {
      ignoredEntries += 1;
      const childRelative = `${relative}/${entry.name}`;
      const childPath = path.join(directory, entry.name);
      if (ignoredEntries > MAX_IGNORED_ENTRIES) {
        bag.error(
          "project_source.state_count",
          pointer("/compiler_state", relative),
          "compiler-owned state exceeds its entry bound",
        );
        ignoredEntryLimitReached = true;
        return;
      }
      const metadata = await lstat(childPath);
      if (metadata.isSymbolicLink()) {
        bag.error(
          "project_source.symlink",
          pointer("/compiler_state", childRelative),
          "compiler-owned state contains a symbolic link",
        );
      } else if (metadata.isDirectory()) {
        await validateIgnoredTree(childPath, childRelative, depth + 1);
      } else if (!metadata.isFile()) {
        bag.error(
          "project_source.file_type",
          pointer("/compiler_state", childRelative),
          "compiler-owned state contains an unsupported file type",
        );
      }
    }
  };

  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (authoredEntryLimitReached) return;
    if (depth > MAX_DIRECTORY_DEPTH) {
      bag.error(
        "project_source.directory_depth",
        pointer("/project_files", prefix),
        "project configuration exceeds its directory depth bound",
      );
      return;
    }
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      compareUtf8(left.name, right.name),
    );
    for (const entry of entries) {
      authoredEntries += 1;
      if (authoredEntries > MAX_AUTHORED_ENTRIES) {
        bag.error(
          "project_source.entry_count",
          "/project_files",
          "project configuration exceeds its filesystem entry bound",
        );
        authoredEntryLimitReached = true;
        return;
      }
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (!isNormalizedSafeRelativePath(relative)) {
        bag.error(
          "project_source.path",
          pointer("/project_files", relative),
          "project configuration contains an unsafe path",
        );
        continue;
      }
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        bag.error(
          "project_source.symlink",
          pointer("/project_files", relative),
          "project configuration contains a symbolic link",
        );
        continue;
      }
      if (prefix.length === 0 && COMPILER_OWNED_PROJECT_CONFIG_ROOTS.includes(relative)) {
        if (!metadata.isDirectory()) {
          bag.error(
            "project_source.state_type",
            pointer("/compiler_state", relative),
            "compiler-owned state root is not a directory",
          );
        } else {
          await validateIgnoredTree(absolute, relative, 1);
        }
        continue;
      }
      if (metadata.isDirectory()) {
        await walk(absolute, relative, depth + 1);
        continue;
      }
      if (!metadata.isFile()) {
        bag.error(
          "project_source.file_type",
          pointer("/project_files", relative),
          "project configuration contains an unsupported file type",
        );
        continue;
      }
      if (files.length >= MAX_AUTHORED_FILES) {
        bag.error(
          "project_source.file_count",
          "/project_files",
          "project configuration exceeds its authored file bound",
        );
        continue;
      }
      const kind = baseline.get(relative)?.kind ?? classifyAuthoredFile(relative);
      if (kind === undefined) {
        bag.error(
          "project_source.untracked_file_kind",
          pointer("/project_files", relative),
          "untracked project file is not a configuration, agent, skill, or prompt resource",
        );
        continue;
      }
      const bytes = await readContainedFile(
        configRoot,
        relative,
        MAX_AUTHORED_FILE_BYTES,
        bag,
        pointer("/project_files", relative),
      );
      if (bytes === undefined) continue;
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_AUTHORED_TOTAL_BYTES) {
        bag.error(
          "project_source.total_size",
          "/project_files",
          "project configuration exceeds its total byte bound",
        );
        continue;
      }
      const copied = Uint8Array.from(bytes);
      files.push({
        path: relative,
        sha256: rawSha256(copied),
        size_bytes: copied.byteLength,
        kind,
      });
      contents.set(relative, copied);
    }
  };

  try {
    await walk(configRoot, "", 0);
  } catch (error) {
    addFilesystemDiagnostic(
      bag,
      "/project_files",
      "could not read the project configuration tree",
      error,
    );
    return undefined;
  }
  files.sort((left, right) => compareUtf8(left.path, right.path));
  if (bag.hasErrors()) return undefined;
  const snapshotSha256 = canonicalHash(files);
  return { files, contents, snapshotSha256 };
}

function classifyAuthoredFile(relative: string): ProfileFileKind | undefined {
  const lower = relative.toLowerCase();
  if (lower.startsWith("resources/skills/")) return "skill";
  if (
    lower.startsWith("resources/prompts/") ||
    lower.startsWith("personas/prompts/") ||
    lower.startsWith("agents/prompts/") ||
    lower.startsWith("prompts/")
  )
    return "prompt";
  if (lower.startsWith("agents/") && (lower.endsWith(".yaml") || lower.endsWith(".yml"))) {
    return "agent";
  }
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "config";
  return undefined;
}

async function readContainedFile(
  configRoot: string,
  relative: string,
  maximumBytes: number,
  bag: DiagnosticBag,
  diagnosticPath: string,
): Promise<Uint8Array | undefined> {
  if (!isNormalizedSafeRelativePath(relative)) {
    bag.error(
      "project_source.path",
      diagnosticPath,
      "file path is not a normalized safe relative path",
    );
    return undefined;
  }
  const absolute = path.join(configRoot, ...relative.split("/"));
  try {
    await assertNoSymlinkComponents(configRoot, relative);
    const canonical = await realpath(absolute);
    if (!isWithin(configRoot, canonical) || canonical !== absolute) {
      bag.error(
        "project_source.path_escape",
        diagnosticPath,
        "project configuration file escapes .koni",
      );
      return undefined;
    }
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) {
        bag.error(
          "project_source.file_type",
          diagnosticPath,
          "project configuration path is not a regular file",
        );
        return undefined;
      }
      if (before.size > BigInt(maximumBytes)) {
        bag.error(
          "project_source.file_size",
          diagnosticPath,
          "project configuration file exceeds its byte bound",
        );
        return undefined;
      }
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      await assertNoSymlinkComponents(configRoot, relative);
      const canonicalAfter = await realpath(absolute);
      const pathAfter = await lstat(absolute, { bigint: true });
      if (
        !sameFile(before, after) ||
        !sameFile(after, pathAfter) ||
        !pathAfter.isFile() ||
        canonicalAfter !== absolute ||
        !isWithin(configRoot, canonicalAfter) ||
        BigInt(bytes.byteLength) !== after.size
      ) {
        bag.error(
          "project_source.file_changed",
          diagnosticPath,
          "project configuration file changed while it was being read",
        );
        return undefined;
      }
      return Uint8Array.from(bytes);
    } finally {
      await handle.close();
    }
  } catch (error) {
    addFilesystemDiagnostic(
      bag,
      diagnosticPath,
      "could not safely read project configuration file",
      error,
    );
    return undefined;
  }
}

async function assertNoSymlinkComponents(configRoot: string, relative: string): Promise<void> {
  let current = configRoot;
  for (const component of relative.split("/")) {
    current = path.join(current, component);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      const error = new Error(
        `symbolic link is not permitted: ${relative}`,
      ) as NodeJS.ErrnoException;
      error.code = "ELOOP";
      throw error;
    }
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function addFilesystemDiagnostic(
  bag: DiagnosticBag,
  diagnosticPath: string,
  message: string,
  error: unknown,
): void {
  const code =
    error instanceof Error && "code" in error
      ? String((error as NodeJS.ErrnoException).code)
      : "unknown";
  bag.error("project_source.filesystem", diagnosticPath, `${message} (${code})`);
}

function isFilesystemCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    String((error as NodeJS.ErrnoException).code) === code
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
