import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { compileProjectDirectory } from "../compiler/project-directory.js";
import { isNormalizedSafeRelativePath } from "../compiler/profile-package.js";
import { GitClient } from "../git/client.js";
import {
  resolveProfileUpstreamConflict,
  type ResolveProfileUpstreamConflictResult,
} from "../profile/config-edit.js";
import {
  loadProfilePackage,
  readProfileLifecycle,
  type PendingUpstreamChange,
} from "../profile/install.js";
import {
  canonicalHash,
  compareUtf8,
  isSha256Digest,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";

export const PROFILE_UPSTREAM_CONFLICT_CATALOG_PROTOCOL =
  "koni.profile-upstream-conflict-catalog.v1" as const;
export const PROFILE_UPSTREAM_CONFLICT_INSPECTION_PROTOCOL =
  "koni.profile-upstream-conflict-inspection.v1" as const;

const PROFILE_DOCUMENT_FILE_LIMIT = 32 * 1024 * 1024;

export interface ProfileUpstreamConflictSummary {
  path: string;
  title: string;
  domain: string;
  reason: PendingUpstreamChange["reason"];
  /** Exact divergent YAML fields; `/` means the document could not be safely field-merged. */
  conflictPaths?: readonly string[];
  currentSha256: Sha256Digest | null;
  upstreamSha256: Sha256Digest | null;
}

export interface ProfileUpstreamConflictCatalog {
  protocol: typeof PROFILE_UPSTREAM_CONFLICT_CATALOG_PROTOCOL;
  lifecycleGeneration: number;
  profileVersion: string;
  conflicts: ProfileUpstreamConflictSummary[];
}

export interface ProfileUpstreamConflictInspection {
  protocol: typeof PROFILE_UPSTREAM_CONFLICT_INSPECTION_PROTOCOL;
  lifecycleGeneration: number;
  conflict: ProfileUpstreamConflictSummary;
  currentText: string | null;
  upstreamText: string | null;
}

export interface ResolveProjectProfileConflictOptions {
  projectRoot: string;
  profilePackageRoot: string;
  path: string;
  expectedLifecycleGeneration: number;
  expectedProjectSha256: Sha256Digest | null;
  resolution: "keep_project" | "accept_upstream";
  /** Internal authority request identity persisted for crash-gap reconstruction. */
  authorityRequestSha256?: Sha256Digest;
}

export interface RecoverProjectProfileConflictResolutionOptions extends ResolveProjectProfileConflictOptions {
  /** Hash of the exact authority method/params being reconstructed after a crash gap. */
  authorityRequestSha256: Sha256Digest;
}

export interface RecoveredProjectProfileConflictResolution {
  path: string;
  resolution: ResolveProjectProfileConflictOptions["resolution"];
  projectSha256: Sha256Digest | null;
  lifecycleGeneration: number;
  configurationSha256: Sha256Digest;
  effectiveBundleSha256: Sha256Digest;
  authorityRequestSha256: Sha256Digest;
  recovered: true;
}

export class ProjectProfileLifecycleError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ProjectProfileLifecycleError";
    this.code = code;
  }
}

/** List exact pending upstream changes without exposing compiler-owned proposal paths. */
export async function listProjectProfileConflicts(
  projectRoot: string,
  profilePackageRoot: string,
): Promise<ProfileUpstreamConflictCatalog> {
  const state = await loadConflictState(projectRoot, profilePackageRoot);
  return {
    protocol: PROFILE_UPSTREAM_CONFLICT_CATALOG_PROTOCOL,
    lifecycleGeneration: state.lifecycle.generation,
    profileVersion: state.lifecycle.installedProfileVersion,
    conflicts: state.conflicts.map(({ summary }) => structuredClone(summary)),
  };
}

/** Inspect one current/project and authenticated-upstream document pair. */
export async function inspectProjectProfileConflict(
  projectRoot: string,
  profilePackageRoot: string,
  relativePath: string,
): Promise<ProfileUpstreamConflictInspection> {
  const state = await loadConflictState(projectRoot, profilePackageRoot);
  const selected = state.conflicts.find(({ summary }) => summary.path === relativePath);
  if (selected === undefined) {
    throw new ProjectProfileLifecycleError(
      "profile_conflict_missing",
      `${relativePath} has no pending upstream change`,
    );
  }
  return {
    protocol: PROFILE_UPSTREAM_CONFLICT_INSPECTION_PROTOCOL,
    lifecycleGeneration: state.lifecycle.generation,
    conflict: structuredClone(selected.summary),
    currentText: selected.currentText,
    upstreamText: selected.upstreamText,
  };
}

/** Resolve one inspected conflict through the existing lifecycle/project-source CAS authority. */
export async function resolveProjectProfileConflict(
  options: ResolveProjectProfileConflictOptions,
): Promise<ResolveProfileUpstreamConflictResult> {
  return resolveProfileUpstreamConflict({
    projectRoot: options.projectRoot,
    profilePackageRoot: options.profilePackageRoot,
    path: options.path,
    expectedLifecycleGeneration: options.expectedLifecycleGeneration,
    expectedProjectSha256: options.expectedProjectSha256,
    resolution: options.resolution,
    ...(options.authorityRequestSha256 === undefined
      ? {}
      : { authorityRequestSha256: options.authorityRequestSha256 }),
  });
}

/**
 * Reconstruct only the one exact success state that can exist when the profile transaction was
 * committed but the authority receipt was not. This is deliberately much narrower than a generic
 * "conflict is gone" check: any later lifecycle mutation, other decision/path, source-CAS drift,
 * package drift, or current compilation drift rejects recovery.
 */
export async function recoverProjectProfileConflictResolution(
  options: RecoverProjectProfileConflictResolutionOptions,
): Promise<RecoveredProjectProfileConflictResolution> {
  const expectedRequestSha256 = canonicalHash({
    method: "profile.conflicts.resolve",
    params: {
      path: options.path,
      expectedLifecycleGeneration: options.expectedLifecycleGeneration,
      expectedProjectSha256: options.expectedProjectSha256,
      resolution: options.resolution,
    },
  });
  if (
    !isSha256Digest(options.authorityRequestSha256) ||
    options.authorityRequestSha256 !== expectedRequestSha256
  ) {
    throw new ProjectProfileLifecycleError(
      "profile_conflict_recovery_request",
      "profile conflict recovery request identity does not match its exact semantic parameters",
    );
  }
  if (
    !Number.isSafeInteger(options.expectedLifecycleGeneration) ||
    options.expectedLifecycleGeneration < 1 ||
    options.expectedLifecycleGeneration >= Number.MAX_SAFE_INTEGER ||
    (options.expectedProjectSha256 !== null && !isSha256Digest(options.expectedProjectSha256)) ||
    (options.resolution !== "keep_project" && options.resolution !== "accept_upstream")
  ) {
    throw new ProjectProfileLifecycleError(
      "profile_conflict_recovery_request",
      "profile conflict recovery parameters are invalid",
    );
  }

  const state = await loadConflictState(options.projectRoot, options.profilePackageRoot);
  if (state.lifecycle.generation !== options.expectedLifecycleGeneration + 1) {
    throw new ProjectProfileLifecycleError(
      "profile_conflict_recovery_ambiguous",
      "profile lifecycle did not advance by exactly one conflict-resolution generation",
    );
  }
  if (state.lifecycle.pendingUpstream.some((entry) => entry.path === options.path)) {
    throw new ProjectProfileLifecycleError(
      "profile_conflict_recovery_ambiguous",
      "the requested upstream conflict is still pending",
    );
  }
  const resolution = state.lifecycle.upstreamResolutions.at(-1);
  if (
    resolution === undefined ||
    resolution.path !== options.path ||
    resolution.bundleSha256 !== state.baseline.manifest.bundle_sha256 ||
    resolution.resolution !== options.resolution ||
    resolution.expectedProjectSha256 !== options.expectedProjectSha256 ||
    resolution.authorityRequestSha256 !== options.authorityRequestSha256 ||
    resolution.resolvedAt !== state.lifecycle.updatedAt
  ) {
    throw new ProjectProfileLifecycleError(
      "profile_conflict_recovery_ambiguous",
      "latest lifecycle mutation is not the exact requested conflict resolution",
    );
  }

  const expectedResolvedSha256 =
    options.resolution === "keep_project"
      ? options.expectedProjectSha256
      : state.baseline.files.get(options.path) === undefined
        ? null
        : rawSha256(state.baseline.files.get(options.path)!);
  const currentBytes = await readOptionalBounded(path.join(state.project, ".koni"), options.path);
  const currentSha256 = currentBytes === undefined ? null : rawSha256(currentBytes);
  if (
    resolution.projectSha256 !== expectedResolvedSha256 ||
    currentSha256 !== expectedResolvedSha256
  ) {
    throw new ProjectProfileLifecycleError(
      "profile_conflict_recovery_ambiguous",
      "resolved project source does not match the exact reviewed decision and source CAS",
    );
  }

  const compiled = await compileProjectDirectory(state.project, state.baseline);
  if (!compiled.ok) {
    throw new ProjectProfileLifecycleError(
      "profile_conflict_recovery_compile",
      `resolved project configuration no longer compiles: ${compiled.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("\n")}`,
    );
  }
  if (
    resolution.configurationSha256 !== compiled.value.configuration_sha256 ||
    resolution.effectiveBundleSha256 !== compiled.value.effective_bundle_sha256
  ) {
    throw new ProjectProfileLifecycleError(
      "profile_conflict_recovery_ambiguous",
      "current project configuration differs from the exact conflict-resolution transaction",
    );
  }
  return {
    path: options.path,
    resolution: options.resolution,
    projectSha256: currentSha256,
    lifecycleGeneration: state.lifecycle.generation,
    configurationSha256: compiled.value.configuration_sha256,
    effectiveBundleSha256: compiled.value.effective_bundle_sha256,
    authorityRequestSha256: options.authorityRequestSha256,
    recovered: true,
  };
}

async function loadConflictState(projectRoot: string, profilePackageRoot: string) {
  const identity = await GitClient.discover(projectRoot);
  const project = identity.worktreeRoot;
  const baseline = await loadProfilePackage(profilePackageRoot);
  const lifecycle = await readProfileLifecycle(project);
  if (
    lifecycle === undefined ||
    lifecycle.installedBundleSha256 !== baseline.manifest.bundle_sha256
  ) {
    throw new ProjectProfileLifecycleError(
      "profile_conflict_provenance",
      "installed profile lifecycle does not match the authority's authenticated package",
    );
  }
  const conflicts = await Promise.all(
    lifecycle.pendingUpstream.map(async (pending) => {
      const currentBytes = await readOptionalBounded(path.join(project, ".koni"), pending.path);
      const upstreamBytes =
        pending.reason === "orphaned" ? undefined : baseline.files.get(pending.path);
      const currentSha256 = currentBytes === undefined ? null : rawSha256(currentBytes);
      const upstreamSha256 = upstreamBytes === undefined ? null : rawSha256(upstreamBytes);
      if (pending.projectSha256 !== undefined && pending.projectSha256 !== currentSha256) {
        throw new ProjectProfileLifecycleError(
          "profile_conflict_changed",
          `${pending.path} changed after its upstream conflict was staged`,
        );
      }
      if (pending.newBaselineSha256 !== undefined && pending.newBaselineSha256 !== upstreamSha256) {
        throw new ProjectProfileLifecycleError(
          "profile_conflict_provenance",
          `${pending.path} no longer matches the authenticated upstream package`,
        );
      }
      return {
        summary: conflictSummary(pending, currentSha256, upstreamSha256),
        currentText: currentBytes === undefined ? null : decodeDocument(currentBytes, pending.path),
        upstreamText:
          upstreamBytes === undefined ? null : decodeDocument(upstreamBytes, pending.path),
      };
    }),
  );
  conflicts.sort((left, right) => compareUtf8(left.summary.path, right.summary.path));
  return { project, baseline, lifecycle, conflicts };
}

function conflictSummary(
  pending: PendingUpstreamChange,
  currentSha256: Sha256Digest | null,
  upstreamSha256: Sha256Digest | null,
): ProfileUpstreamConflictSummary {
  const basename = path.posix.basename(pending.path).replace(/\.[^.]+$/u, "");
  return {
    path: pending.path,
    title: basename.split(/[-_]+/u).filter(Boolean).map(capitalize).join(" ") || pending.path,
    domain: pending.path.split("/")[0] ?? "project",
    reason: pending.reason,
    ...(pending.conflictPaths === undefined ? {} : { conflictPaths: [...pending.conflictPaths] }),
    currentSha256,
    upstreamSha256,
  };
}

async function readOptionalBounded(
  root: string,
  relativePath: string,
): Promise<Buffer | undefined> {
  if (!isNormalizedSafeRelativePath(relativePath)) {
    throw new ProjectProfileLifecycleError(
      "profile_conflict_path",
      "profile conflict path is unsafe",
    );
  }
  const absolute = path.join(root, ...relativePath.split("/"));
  let handle;
  try {
    const rootMetadata = await lstat(root);
    if (
      !rootMetadata.isDirectory() ||
      rootMetadata.isSymbolicLink() ||
      (await realpath(root)) !== root
    ) {
      throw new ProjectProfileLifecycleError(
        "profile_conflict_path",
        "profile conflict root is not a canonical real directory",
      );
    }
    await assertNoSymlinkComponents(root, relativePath);
    if ((await realpath(absolute)) !== absolute) {
      throw new ProjectProfileLifecycleError(
        "profile_conflict_path",
        `${relativePath} escapes its profile root`,
      );
    }
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(absolute, constants.O_RDONLY | noFollow);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(PROFILE_DOCUMENT_FILE_LIMIT)) {
      throw new ProjectProfileLifecycleError(
        "profile_conflict_file",
        `${relativePath} is not a safe bounded profile document`,
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    await assertNoSymlinkComponents(root, relativePath);
    const pathAfter = await lstat(absolute, { bigint: true });
    if (
      (await realpath(absolute)) !== absolute ||
      !sameFile(before, after) ||
      !sameFile(after, pathAfter) ||
      BigInt(bytes.byteLength) !== after.size
    ) {
      throw new ProjectProfileLifecycleError(
        "profile_conflict_changed",
        `${relativePath} changed while it was inspected`,
      );
    }
    return bytes;
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function assertNoSymlinkComponents(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const component of relativePath.split("/")) {
    current = path.join(current, component);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new ProjectProfileLifecycleError(
        "profile_conflict_path",
        `${relativePath} contains a symbolic link`,
      );
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

function decodeDocument(bytes: Uint8Array, relativePath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProjectProfileLifecycleError(
      "profile_conflict_encoding",
      `${relativePath} is not UTF-8 text`,
    );
  }
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function isCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
