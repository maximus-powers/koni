import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  FileTransactionStore,
  type TransactionDelete,
  type TransactionWrite,
} from "../authority/file-journal.js";
import type { ProfileBaselineFile, ProfileFileKind } from "../contracts/profile-package.js";
import { compileProjectConfiguration } from "../compiler/configuration.js";
import { compileProjectDirectory } from "../compiler/project-directory.js";
import { isNormalizedSafeRelativePath } from "../compiler/profile-package.js";
import {
  canonicalHash,
  compareUtf8,
  isSha256Digest,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import { parseStrictYamlObject } from "../shared/yaml.js";
import {
  loadProfilePackage,
  readProfileLifecycle,
  withProfileLifecycleLock,
  type InstalledProfileMetadata,
  type ProfileLifecycleMetadata,
  type ProjectOverlayEntry,
} from "./install.js";

export const PROJECT_CONFIG_CATALOG_PROTOCOL = "koni.project-config-catalog.v1" as const;
export const PROJECT_CONFIG_UPDATE_PROTOCOL = "koni.project-config-update.v1" as const;

const INSTALL_METADATA_PATH = ".managed/install.json";
const LIFECYCLE_METADATA_PATH = ".managed/lifecycle.json";
const MAX_AUTHORED_FILES = 16_384;
const MAX_AUTHORED_BYTES = 512 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_DOCUMENT_DEPTH = 64;
const MAX_DOCUMENT_NODES = 100_000;
const MAX_SCALAR_BYTES = 1024 * 1024;

export type ProjectConfigSemanticDomain =
  | "profile"
  | "project"
  | "run-type"
  | "agent"
  | "graph"
  | "rules"
  | "operations"
  | "workflows"
  | "actions"
  | "checks"
  | "personas"
  | "reports"
  | "cockpit"
  | "lifecycle"
  | "resource"
  | "other";

export interface ProjectConfigCatalogEntry {
  path: string;
  label: string;
  kind: ProfileFileKind;
  semanticDomain: ProjectConfigSemanticDomain;
  guidedEditable: boolean;
  sourceSha256: Sha256Digest;
  sizeBytes: number;
  topLevelKeys: string[];
}

export interface ProjectConfigCatalog {
  protocol: typeof PROJECT_CONFIG_CATALOG_PROTOCOL;
  profileId: string;
  profileVersion: string;
  bundleSha256: Sha256Digest;
  lifecycleGeneration: number;
  configurationSha256: Sha256Digest;
  effectiveBundleSha256: Sha256Digest;
  entries: ProjectConfigCatalogEntry[];
}

export interface ProjectAuthoredConfigDocument {
  catalog: ProjectConfigCatalog;
  entry: ProjectConfigCatalogEntry;
  source: string;
  document: Record<string, unknown>;
}

export interface UpdateProjectAuthoredConfigRequest {
  projectRoot: string;
  profilePackageRoot: string;
  path: string;
  expectedSourceSha256: Sha256Digest;
  document: Record<string, unknown>;
}

export interface UpdateProjectAuthoredConfigResult {
  protocol: typeof PROJECT_CONFIG_UPDATE_PROTOCOL;
  path: string;
  previousSourceSha256: Sha256Digest;
  sourceSha256: Sha256Digest;
  lifecycleGeneration: number;
  configurationSha256: Sha256Digest;
  effectiveBundleSha256: Sha256Digest;
  transactionId: string;
}

export interface BatchProjectAuthoredConfigDocumentUpdate {
  path: string;
  /** Null admits a new project-authored document only when the path is absent. */
  expectedSourceSha256: Sha256Digest | null;
  document: Record<string, unknown>;
}

export interface BatchProjectAuthoredConfigDocumentDelete {
  path: string;
  expectedSourceSha256: Sha256Digest;
}

export interface UpdateProjectAuthoredConfigDocumentsRequest {
  projectRoot: string;
  profilePackageRoot: string;
  documents: readonly BatchProjectAuthoredConfigDocumentUpdate[];
  deletes?: readonly BatchProjectAuthoredConfigDocumentDelete[];
  /** Durable same-filesystem completion witness used to close cross-store crash windows. */
  mutationMarker?: {
    id: string;
    requestSha256: Sha256Digest;
  };
}

export interface UpdateProjectAuthoredConfigDocumentsResult {
  protocol: "koni.project-config-batch-update.v1";
  documents: Array<{
    path: string;
    previousSourceSha256: Sha256Digest | null;
    sourceSha256: Sha256Digest;
  }>;
  deleted: Array<{ path: string; previousSourceSha256: Sha256Digest }>;
  lifecycleGeneration: number;
  configurationSha256: Sha256Digest;
  effectiveBundleSha256: Sha256Digest;
  transactionId: string;
}

export interface ProjectConfigMutationMarker {
  protocol: "koni.project-config-mutation-marker.v1";
  id: string;
  requestSha256: Sha256Digest;
}

export interface ResolveProfileUpstreamConflictRequest {
  projectRoot: string;
  profilePackageRoot: string;
  path: string;
  expectedLifecycleGeneration: number;
  expectedProjectSha256: Sha256Digest | null;
  resolution: "keep_project" | "accept_upstream";
}

export interface ResolveProfileUpstreamConflictResult {
  path: string;
  resolution: ResolveProfileUpstreamConflictRequest["resolution"];
  projectSha256: Sha256Digest | null;
  lifecycleGeneration: number;
  configurationSha256: Sha256Digest;
  effectiveBundleSha256: Sha256Digest;
  transactionId: string;
}

interface AuthoredTreeSnapshot {
  files: ProfileBaselineFile[];
  contents: Map<string, Uint8Array>;
  entries: ProjectConfigCatalogEntry[];
  snapshotSha256: Sha256Digest;
}

export class ProjectConfigMutationError extends Error {
  public readonly code: string;
  public readonly diagnostics?: readonly string[];

  public constructor(code: string, message: string, diagnostics?: readonly string[]) {
    super(message);
    this.name = "ProjectConfigMutationError";
    this.code = code;
    if (diagnostics !== undefined) this.diagnostics = diagnostics;
  }
}

/**
 * Return the compiler-authenticated, project-authored YAML catalog. Ambient Pi
 * settings/resources and compiler-owned `.managed` state never enter it.
 */
export async function catalogProjectAuthoredConfig(
  projectRoot: string,
  profilePackageRoot: string,
): Promise<ProjectConfigCatalog> {
  const project = await canonicalRealDirectory(projectRoot, "project_root");
  const baseline = await loadProfilePackage(profilePackageRoot);
  const compiled = await compileProjectDirectory(project, baseline);
  if (!compiled.ok) throw compilationError("current_configuration_invalid", compiled.diagnostics);
  const lifecycle = await requireMatchingLifecycle(project, baseline.manifest.bundle_sha256);
  const snapshot = await readStableAuthoredTree(path.join(project, ".koni"), baseline.manifest.baseline.files);
  return catalogFrom(snapshot, lifecycle, compiled.value);
}

/** Read one current YAML document by exact catalog path and source identity. */
export async function readProjectAuthoredConfigDocument(
  projectRoot: string,
  profilePackageRoot: string,
  relativePath: string,
): Promise<ProjectAuthoredConfigDocument> {
  validateEditablePath(relativePath);
  const project = await canonicalRealDirectory(projectRoot, "project_root");
  const baseline = await loadProfilePackage(profilePackageRoot);
  const compiled = await compileProjectDirectory(project, baseline);
  if (!compiled.ok) throw compilationError("current_configuration_invalid", compiled.diagnostics);
  const lifecycle = await requireMatchingLifecycle(project, baseline.manifest.bundle_sha256);
  const snapshot = await readStableAuthoredTree(path.join(project, ".koni"), baseline.manifest.baseline.files);
  const entry = snapshot.entries.find((candidate) => candidate.path === relativePath);
  if (entry === undefined || !entry.guidedEditable) {
    throw new ProjectConfigMutationError("config_not_editable", `${relativePath} is not a guided-editable YAML document`);
  }
  const source = decodeUtf8(snapshot.contents.get(relativePath)!, relativePath);
  const parsed = parseStrictYamlObject(source);
  if (!parsed.ok) throw compilationError("config_yaml_invalid", parsed.diagnostics);
  return {
    catalog: catalogFrom(snapshot, lifecycle, compiled.value),
    entry: structuredClone(entry),
    source,
    document: structuredClone(parsed.value),
  };
}

/**
 * Replace exactly one structured YAML document under a source-hash CAS,
 * compile the complete effective project candidate, and atomically publish the
 * document plus lifecycle bookkeeping. UI callers never write `.managed`.
 */
export async function updateProjectAuthoredConfigDocument(
  request: UpdateProjectAuthoredConfigRequest,
): Promise<UpdateProjectAuthoredConfigResult> {
  validateEditablePath(request.path);
  if (!isSha256Digest(request.expectedSourceSha256)) {
    throw new ProjectConfigMutationError("expected_source_hash", "expectedSourceSha256 is not a SHA-256 digest");
  }
  const normalizedDocument = normalizeStructuredDocument(request.document);
  const source = YAML.stringify(normalizedDocument, { lineWidth: 0 });
  const sourceBytes = Buffer.from(source, "utf8");
  if (sourceBytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new ProjectConfigMutationError("config_size", `structured YAML exceeds ${MAX_DOCUMENT_BYTES} bytes`);
  }
  const reparsed = parseStrictYamlObject(source);
  if (!reparsed.ok) throw compilationError("config_yaml_invalid", reparsed.diagnostics);

  const project = await canonicalRealDirectory(request.projectRoot, "project_root");
  const baseline = await loadProfilePackage(request.profilePackageRoot);
  const configRoot = path.join(project, ".koni");
  await assertCanonicalConfigRoot(project, configRoot);

  return withProfileLifecycleLock(configRoot, async () => {
    const store = await FileTransactionStore.open(configRoot);
    await store.recoverPrepared();

    const currentCompiled = await compileProjectDirectory(project, baseline);
    if (!currentCompiled.ok) {
      throw compilationError("current_configuration_invalid", currentCompiled.diagnostics);
    }
    const lifecycle = await requireMatchingLifecycle(project, baseline.manifest.bundle_sha256);
    const installRead = await readInstalledMetadata(configRoot, baseline.manifest.bundle_sha256);
    const snapshot = await readStableAuthoredTree(configRoot, baseline.manifest.baseline.files);
    const entry = snapshot.entries.find((candidate) => candidate.path === request.path);
    if (entry === undefined || !entry.guidedEditable) {
      throw new ProjectConfigMutationError("config_not_editable", `${request.path} is not a guided-editable YAML document`);
    }
    if (entry.sourceSha256 !== request.expectedSourceSha256) {
      throw new ProjectConfigMutationError(
        "config_source_changed",
        `${request.path} changed since it was opened`,
      );
    }

    const candidateContents = new Map(snapshot.contents);
    candidateContents.set(request.path, sourceBytes);
    const candidateFiles = inventory(candidateContents, baseline.manifest.baseline.files);
    const candidate = compileProjectConfiguration({
      manifest: baseline.manifest,
      files: candidateFiles,
      contents: candidateContents,
    });
    if (!candidate.ok) throw compilationError("candidate_configuration_invalid", candidate.diagnostics);

    const nextSourceSha256 = rawSha256(sourceBytes);
    const nextOverlay = computeOverlay(baseline.manifest.baseline.files, candidateFiles);
    const nextPending = lifecycle.pendingUpstream
      .filter((pending) => {
        if (pending.path !== request.path) return true;
        const baselineFile = baseline.manifest.baseline.files.find((file) => file.path === request.path);
        return baselineFile === undefined || baselineFile.sha256 !== nextSourceSha256;
      })
      .map((pending) => pending.path === request.path
        ? { ...pending, projectSha256: nextSourceSha256 }
        : pending);
    const nextLifecycle: ProfileLifecycleMetadata = {
      ...lifecycle,
      generation: lifecycle.generation + 1,
      overlay: nextOverlay,
      pendingUpstream: nextPending,
      updatedAt: new Date().toISOString(),
    };
    const nextInstall: InstalledProfileMetadata = {
      ...installRead.value,
      projectOverrides: Object.fromEntries(
        nextOverlay.map((overlay) => [overlay.path, overlay.projectSha256]),
      ),
      pendingUpstream: nextPending.map(({ path: pendingPath, proposedPath, reason }) => ({
        path: pendingPath,
        proposedPath,
        reason,
      })),
    };

    const lifecycleBytes = jsonBytes(nextLifecycle);
    const installBytes = jsonBytes(nextInstall);
    const transactionId = `config-${nextLifecycle.generation}-${randomUUID()}`;
    const writes: TransactionWrite[] = [
      {
        path: request.path,
        bytes: sourceBytes,
        expectedSha256: request.expectedSourceSha256,
      },
      {
        path: INSTALL_METADATA_PATH,
        bytes: installBytes,
        expectedSha256: installRead.sha256,
      },
      {
        path: LIFECYCLE_METADATA_PATH,
        bytes: lifecycleBytes,
        expectedSha256: rawSha256(await readFile(path.join(configRoot, LIFECYCLE_METADATA_PATH))),
      },
    ];
    await store.prepare(transactionId, writes);
    await store.commit(transactionId);
    await store.cleanupCommitted(transactionId);

    return {
      protocol: PROJECT_CONFIG_UPDATE_PROTOCOL,
      path: request.path,
      previousSourceSha256: request.expectedSourceSha256,
      sourceSha256: nextSourceSha256,
      lifecycleGeneration: nextLifecycle.generation,
      configurationSha256: candidate.value.configuration_sha256,
      effectiveBundleSha256: candidate.value.effective_bundle_sha256,
      transactionId,
    };
  });
}

/** Validate and publish all changed guided documents as one filesystem transaction. */
export async function updateProjectAuthoredConfigDocuments(
  request: UpdateProjectAuthoredConfigDocumentsRequest,
): Promise<UpdateProjectAuthoredConfigDocumentsResult> {
  const requestedDeletes = request.deletes ?? [];
  const effectCount = request.documents.length + requestedDeletes.length;
  if (effectCount < 1 || effectCount > MAX_AUTHORED_FILES) {
    throw new ProjectConfigMutationError("config_batch", "configuration update batch is empty or oversized");
  }
  const prepared = request.documents.map((update) => {
    validateEditablePath(update.path);
    if (update.expectedSourceSha256 !== null && !isSha256Digest(update.expectedSourceSha256)) {
      throw new ProjectConfigMutationError("expected_source_hash", `expected source digest is invalid for ${update.path}`);
    }
    const normalizedDocument = normalizeStructuredDocument(update.document);
    const source = YAML.stringify(normalizedDocument, { lineWidth: 0 });
    const bytes = Buffer.from(source, "utf8");
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
      throw new ProjectConfigMutationError("config_size", `${update.path} exceeds ${MAX_DOCUMENT_BYTES} bytes`);
    }
    const reparsed = parseStrictYamlObject(source);
    if (!reparsed.ok) throw compilationError("config_yaml_invalid", reparsed.diagnostics);
    return { ...update, document: normalizedDocument, bytes, sourceSha256: rawSha256(bytes) };
  });
  const deletes = requestedDeletes.map((entry) => {
    validateEditablePath(entry.path);
    if (!isSha256Digest(entry.expectedSourceSha256)) {
      throw new ProjectConfigMutationError("expected_source_hash", `expected source digest is invalid for ${entry.path}`);
    }
    return { ...entry };
  });
  const allPaths = [...prepared.map((update) => update.path), ...deletes.map((entry) => entry.path)];
  if (new Set(allPaths).size !== allPaths.length) {
    throw new ProjectConfigMutationError("config_batch", "configuration update batch contains duplicate paths");
  }
  const mutationMarker = request.mutationMarker;
  if (mutationMarker !== undefined &&
      (!/^[a-f0-9]{64}$/u.test(mutationMarker.id) || !isSha256Digest(mutationMarker.requestSha256))) {
    throw new ProjectConfigMutationError("config_mutation_marker", "configuration mutation marker is invalid");
  }

  const project = await canonicalRealDirectory(request.projectRoot, "project_root");
  const baseline = await loadProfilePackage(request.profilePackageRoot);
  const configRoot = path.join(project, ".koni");
  await assertCanonicalConfigRoot(project, configRoot);
  return withProfileLifecycleLock(configRoot, async () => {
    const store = await FileTransactionStore.open(configRoot);
    await store.recoverPrepared();
    const currentCompiled = await compileProjectDirectory(project, baseline);
    if (!currentCompiled.ok) {
      throw compilationError("current_configuration_invalid", currentCompiled.diagnostics);
    }
    const lifecycle = await requireMatchingLifecycle(project, baseline.manifest.bundle_sha256);
    const installRead = await readInstalledMetadata(configRoot, baseline.manifest.bundle_sha256);
    const snapshot = await readStableAuthoredTree(configRoot, baseline.manifest.baseline.files);
    const entries = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
    for (const update of prepared) {
      const entry = entries.get(update.path);
      if (update.expectedSourceSha256 === null) {
        if (entry !== undefined || snapshot.contents.has(update.path)) {
          throw new ProjectConfigMutationError("config_source_changed", `${update.path} already exists`);
        }
      } else if (entry === undefined || !entry.guidedEditable) {
        throw new ProjectConfigMutationError("config_not_editable", `${update.path} is not guided-editable`);
      } else if (entry.sourceSha256 !== update.expectedSourceSha256) {
        throw new ProjectConfigMutationError("config_source_changed", `${update.path} changed since it was opened`);
      }
    }
    for (const deletion of deletes) {
      const entry = entries.get(deletion.path);
      if (entry === undefined || !entry.guidedEditable) {
        throw new ProjectConfigMutationError("config_not_editable", `${deletion.path} is not guided-editable`);
      }
      if (entry.sourceSha256 !== deletion.expectedSourceSha256) {
        throw new ProjectConfigMutationError("config_source_changed", `${deletion.path} changed since it was opened`);
      }
    }

    const candidateContents = new Map(snapshot.contents);
    for (const update of prepared) candidateContents.set(update.path, update.bytes);
    for (const deletion of deletes) candidateContents.delete(deletion.path);
    const candidateFiles = inventory(candidateContents, baseline.manifest.baseline.files);
    const candidate = compileProjectConfiguration({
      manifest: baseline.manifest,
      files: candidateFiles,
      contents: candidateContents,
    });
    if (!candidate.ok) throw compilationError("candidate_configuration_invalid", candidate.diagnostics);

    const nextOverlay = computeOverlay(baseline.manifest.baseline.files, candidateFiles);
    let nextPending = lifecycle.pendingUpstream.map((entry) => ({ ...entry }));
    for (const update of prepared) {
      nextPending = nextPending
        .filter((pending) => {
          if (pending.path !== update.path) return true;
          const baselineFile = baseline.manifest.baseline.files.find((file) => file.path === update.path);
          return baselineFile === undefined || baselineFile.sha256 !== update.sourceSha256;
        })
        .map((pending) => pending.path === update.path
          ? { ...pending, projectSha256: update.sourceSha256 }
          : pending);
    }
    for (const deletion of deletes) {
      nextPending = nextPending.map((pending) => pending.path === deletion.path
        ? { ...pending, projectSha256: null }
        : pending);
    }
    const nextLifecycle: ProfileLifecycleMetadata = {
      ...lifecycle,
      generation: lifecycle.generation + 1,
      overlay: nextOverlay,
      pendingUpstream: nextPending,
      updatedAt: new Date().toISOString(),
    };
    const nextInstall: InstalledProfileMetadata = {
      ...installRead.value,
      projectOverrides: Object.fromEntries(
        nextOverlay.map((overlay) => [overlay.path, overlay.projectSha256]),
      ),
      pendingUpstream: nextPending.map(({ path: pendingPath, proposedPath, reason }) => ({
        path: pendingPath,
        proposedPath,
        reason,
      })),
    };
    const transactionId = `config-batch-${nextLifecycle.generation}-${randomUUID()}`;
    const writes: TransactionWrite[] = [
      ...prepared.map((update): TransactionWrite => ({
        path: update.path,
        bytes: update.bytes,
        expectedSha256: update.expectedSourceSha256,
      })),
      {
        path: INSTALL_METADATA_PATH,
        bytes: jsonBytes(nextInstall),
        expectedSha256: installRead.sha256,
      },
      {
        path: LIFECYCLE_METADATA_PATH,
        bytes: jsonBytes(nextLifecycle),
        expectedSha256: rawSha256(await readFile(path.join(configRoot, LIFECYCLE_METADATA_PATH))),
      },
      ...(mutationMarker === undefined ? [] : [{
        path: configMutationMarkerPath(mutationMarker.id),
        bytes: jsonBytes({
          protocol: "koni.project-config-mutation-marker.v1",
          id: mutationMarker.id,
          requestSha256: mutationMarker.requestSha256,
        } satisfies ProjectConfigMutationMarker),
        expectedSha256: null,
      }]),
    ];
    const transactionDeletes: TransactionDelete[] = deletes.map((entry) => ({
      path: entry.path,
      expectedSha256: entry.expectedSourceSha256,
    }));
    await store.prepare(transactionId, writes, transactionDeletes);
    await store.commit(transactionId);
    await store.cleanupCommitted(transactionId);
    return {
      protocol: "koni.project-config-batch-update.v1",
      documents: prepared.map((update) => ({
        path: update.path,
        previousSourceSha256: update.expectedSourceSha256,
        sourceSha256: update.sourceSha256,
      })),
      deleted: deletes.map((entry) => ({
        path: entry.path,
        previousSourceSha256: entry.expectedSourceSha256,
      })),
      lifecycleGeneration: nextLifecycle.generation,
      configurationSha256: candidate.value.configuration_sha256,
      effectiveBundleSha256: candidate.value.effective_bundle_sha256,
      transactionId,
    };
  });
}

/** Read the atomic completion witness for a collection mutation, if one exists. */
export async function readProjectConfigMutationMarker(
  projectRoot: string,
  id: string,
): Promise<ProjectConfigMutationMarker | undefined> {
  if (!/^[a-f0-9]{64}$/u.test(id)) {
    throw new ProjectConfigMutationError("config_mutation_marker", "configuration mutation marker identity is invalid");
  }
  const project = await canonicalRealDirectory(projectRoot, "project_root");
  const configRoot = path.join(project, ".koni");
  await assertCanonicalConfigRoot(project, configRoot);
  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(configRoot, configMutationMarkerPath(id)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (bytes.byteLength > 4096) {
    throw new ProjectConfigMutationError("config_mutation_marker", "configuration mutation marker is oversized");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ProjectConfigMutationError("config_mutation_marker", "configuration mutation marker is malformed");
  }
  if (!isRecord(value) || value.protocol !== "koni.project-config-mutation-marker.v1" ||
      value.id !== id || !isSha256Digest(value.requestSha256)) {
    throw new ProjectConfigMutationError("config_mutation_marker", "configuration mutation marker is invalid");
  }
  return value as unknown as ProjectConfigMutationMarker;
}

/**
 * Resolve one staged three-way upgrade conflict under lifecycle and project
 * source CAS. Keeping the project clears only the conflict; accepting upstream
 * writes/recreates the verified package byte or removes an upstream-orphaned
 * project file. The complete resulting project must compile either way.
 */
export async function resolveProfileUpstreamConflict(
  request: ResolveProfileUpstreamConflictRequest,
): Promise<ResolveProfileUpstreamConflictResult> {
  validateAuthoredPath(request.path);
  if (!Number.isSafeInteger(request.expectedLifecycleGeneration) || request.expectedLifecycleGeneration < 1) {
    throw new ProjectConfigMutationError("lifecycle_generation", "expected lifecycle generation is invalid");
  }
  if (request.expectedProjectSha256 !== null && !isSha256Digest(request.expectedProjectSha256)) {
    throw new ProjectConfigMutationError("expected_source_hash", "expected project source digest is invalid");
  }
  if (request.resolution !== "keep_project" && request.resolution !== "accept_upstream") {
    throw new ProjectConfigMutationError("conflict_resolution", "upstream conflict resolution is unsupported");
  }
  const project = await canonicalRealDirectory(request.projectRoot, "project_root");
  const baseline = await loadProfilePackage(request.profilePackageRoot);
  const configRoot = path.join(project, ".koni");
  await assertCanonicalConfigRoot(project, configRoot);

  return withProfileLifecycleLock(configRoot, async () => {
    const store = await FileTransactionStore.open(configRoot);
    await store.recoverPrepared();
    const lifecycle = await requireMatchingLifecycle(project, baseline.manifest.bundle_sha256);
    if (lifecycle.generation !== request.expectedLifecycleGeneration) {
      throw new ProjectConfigMutationError("lifecycle_changed", "profile lifecycle changed since the conflict was opened");
    }
    const pending = lifecycle.pendingUpstream.find((entry) => entry.path === request.path);
    if (pending === undefined) throw new ProjectConfigMutationError("conflict_missing", `${request.path} has no pending upstream conflict`);
    const installRead = await readInstalledMetadata(configRoot, baseline.manifest.bundle_sha256);
    const snapshot = await readStableAuthoredTree(configRoot, baseline.manifest.baseline.files);
    const currentBytes = snapshot.contents.get(request.path);
    const currentSha256 = currentBytes === undefined ? null : rawSha256(currentBytes);
    if (currentSha256 !== request.expectedProjectSha256) {
      throw new ProjectConfigMutationError("config_source_changed", `${request.path} changed since the conflict was opened`);
    }

    const candidateContents = new Map(snapshot.contents);
    let acceptedBytes: Uint8Array | undefined;
    if (request.resolution === "accept_upstream") {
      if (pending.reason === "orphaned") {
        candidateContents.delete(request.path);
      } else {
        const descriptor = baseline.manifest.baseline.files.find((file) => file.path === request.path);
        if (descriptor === undefined) throw new ProjectConfigMutationError("conflict_baseline", "pending upstream file is absent from the authenticated baseline");
        acceptedBytes = baseline.files.get(request.path)!;
        if (pending.newBaselineSha256 !== undefined && pending.newBaselineSha256 !== descriptor.sha256) {
          throw new ProjectConfigMutationError("conflict_baseline", "pending upstream digest differs from the authenticated baseline");
        }
        const proposed = await readFile(path.join(configRoot, pending.proposedPath));
        if (rawSha256(proposed) !== descriptor.sha256) {
          throw new ProjectConfigMutationError("conflict_proposal", "staged upstream proposal is missing or corrupt");
        }
        candidateContents.set(request.path, acceptedBytes);
      }
    }
    const candidateFiles = inventory(candidateContents, baseline.manifest.baseline.files);
    const candidate = compileProjectConfiguration({
      manifest: baseline.manifest,
      files: candidateFiles,
      contents: candidateContents,
    });
    if (!candidate.ok) throw compilationError("candidate_configuration_invalid", candidate.diagnostics);

    const resolvedProjectSha256 = candidateContents.has(request.path)
      ? rawSha256(candidateContents.get(request.path)!)
      : null;
    const nextOverlay = computeOverlay(baseline.manifest.baseline.files, candidateFiles);
    const resolvedAt = new Date().toISOString();
    const nextLifecycle: ProfileLifecycleMetadata = {
      ...lifecycle,
      generation: lifecycle.generation + 1,
      overlay: nextOverlay,
      pendingUpstream: lifecycle.pendingUpstream.filter((entry) => entry.path !== request.path),
      upstreamResolutions: [
        ...lifecycle.upstreamResolutions,
        {
          path: request.path,
          bundleSha256: lifecycle.installedBundleSha256,
          resolution: request.resolution,
          resolvedAt,
          projectSha256: resolvedProjectSha256,
        },
      ],
      updatedAt: resolvedAt,
    };
    const nextInstall: InstalledProfileMetadata = {
      ...installRead.value,
      projectOverrides: Object.fromEntries(nextOverlay.map((overlay) => [overlay.path, overlay.projectSha256])),
      pendingUpstream: nextLifecycle.pendingUpstream.map(({ path: pendingPath, proposedPath, reason }) => ({
        path: pendingPath,
        proposedPath,
        reason,
      })),
    };
    const writes: TransactionWrite[] = [
      {
        path: INSTALL_METADATA_PATH,
        bytes: jsonBytes(nextInstall),
        expectedSha256: installRead.sha256,
      },
      {
        path: LIFECYCLE_METADATA_PATH,
        bytes: jsonBytes(nextLifecycle),
        expectedSha256: rawSha256(await readFile(path.join(configRoot, LIFECYCLE_METADATA_PATH))),
      },
    ];
    const deletes: TransactionDelete[] = [];
    if (request.resolution === "accept_upstream") {
      if (acceptedBytes === undefined) {
        if (currentSha256 !== null) deletes.push({ path: request.path, expectedSha256: currentSha256 });
      } else if (currentSha256 !== rawSha256(acceptedBytes)) {
        writes.unshift({
          path: request.path,
          bytes: acceptedBytes,
          expectedSha256: currentSha256,
        });
      }
    }
    const transactionId = `conflict-${nextLifecycle.generation}-${randomUUID()}`;
    await store.prepare(transactionId, writes, deletes);
    await store.commit(transactionId);
    await store.cleanupCommitted(transactionId);
    return {
      path: request.path,
      resolution: request.resolution,
      projectSha256: resolvedProjectSha256,
      lifecycleGeneration: nextLifecycle.generation,
      configurationSha256: candidate.value.configuration_sha256,
      effectiveBundleSha256: candidate.value.effective_bundle_sha256,
      transactionId,
    };
  });
}

function catalogFrom(
  snapshot: AuthoredTreeSnapshot,
  lifecycle: ProfileLifecycleMetadata,
  compiled: { configuration_sha256: Sha256Digest; effective_bundle_sha256: Sha256Digest; package: { profile_id: string; profile_version: string } },
): ProjectConfigCatalog {
  return {
    protocol: PROJECT_CONFIG_CATALOG_PROTOCOL,
    profileId: compiled.package.profile_id,
    profileVersion: compiled.package.profile_version,
    bundleSha256: lifecycle.installedBundleSha256,
    lifecycleGeneration: lifecycle.generation,
    configurationSha256: compiled.configuration_sha256,
    effectiveBundleSha256: compiled.effective_bundle_sha256,
    entries: structuredClone(snapshot.entries),
  };
}

async function readStableAuthoredTree(
  configRoot: string,
  baselineFiles: readonly ProfileBaselineFile[],
): Promise<AuthoredTreeSnapshot> {
  const first = await readAuthoredTree(configRoot, baselineFiles);
  const second = await readAuthoredTree(configRoot, baselineFiles);
  if (first.snapshotSha256 !== second.snapshotSha256) {
    throw new ProjectConfigMutationError("config_changed", "project configuration changed while it was being read");
  }
  return second;
}

async function readAuthoredTree(
  configRoot: string,
  baselineFiles: readonly ProfileBaselineFile[],
): Promise<AuthoredTreeSnapshot> {
  const contents = new Map<string, Uint8Array>();
  let totalBytes = 0;
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 128) throw new ProjectConfigMutationError("config_depth", ".koni exceeds the directory depth limit");
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareUtf8(left.name, right.name))) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (!isNormalizedSafeRelativePath(relative)) throw new ProjectConfigMutationError("config_path", `unsafe config path: ${relative}`);
      if (prefix === "" && isCompilerOwnedRoot(entry.name)) {
        if (entry.isSymbolicLink()) throw new ProjectConfigMutationError("config_symlink", `compiler-owned root is a symlink: ${relative}`);
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new ProjectConfigMutationError("config_symlink", `project config contains a symlink: ${relative}`);
      if (entry.isDirectory()) await visit(absolute, relative, depth + 1);
      else if (entry.isFile()) {
        if (contents.size >= MAX_AUTHORED_FILES) throw new ProjectConfigMutationError("config_count", "project config contains too many files");
        const before = await lstat(absolute);
        const bytes = await readFile(absolute);
        const after = await lstat(absolute);
        if (!before.isFile() || before.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          throw new ProjectConfigMutationError("config_changed", `project config changed while reading ${relative}`);
        }
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_AUTHORED_BYTES) throw new ProjectConfigMutationError("config_size", "project config exceeds the total byte limit");
        contents.set(relative, bytes);
      } else throw new ProjectConfigMutationError("config_file_type", `unsupported project config entry: ${relative}`);
    }
  };
  await visit(configRoot, "", 0);
  const files = inventory(contents, baselineFiles);
  const entries = files.flatMap((file): ProjectConfigCatalogEntry[] => {
    if (!/\.ya?ml$/u.test(file.path)) return [];
    const parsed = parseStrictYamlObject(decodeUtf8(contents.get(file.path)!, file.path));
    const document = parsed.ok ? parsed.value : undefined;
    return [{
      path: file.path,
      label: configLabel(file.path, document),
      kind: file.kind,
      semanticDomain: semanticDomain(file.path),
      guidedEditable: parsed.ok && semanticDomain(file.path) !== "other",
      sourceSha256: file.sha256,
      sizeBytes: file.size_bytes,
      topLevelKeys: document === undefined ? [] : Object.keys(document).sort(compareUtf8),
    }];
  });
  return {
    files,
    contents,
    entries,
    snapshotSha256: canonicalHash(files),
  };
}

function inventory(
  contents: ReadonlyMap<string, Uint8Array>,
  baselineFiles: readonly ProfileBaselineFile[],
): ProfileBaselineFile[] {
  const baseline = new Map(baselineFiles.map((file) => [file.path, file] as const));
  return [...contents]
    .map(([relative, bytes]) => ({
      path: relative,
      sha256: rawSha256(bytes),
      size_bytes: bytes.byteLength,
      kind: baseline.get(relative)?.kind ?? classifyPath(relative),
    }))
    .sort((left, right) => compareUtf8(left.path, right.path));
}

function computeOverlay(
  baselineFiles: readonly ProfileBaselineFile[],
  candidateFiles: readonly ProfileBaselineFile[],
): ProjectOverlayEntry[] {
  const baseline = new Map(baselineFiles.map((file) => [file.path, file] as const));
  const candidate = new Map(candidateFiles.map((file) => [file.path, file] as const));
  const overlay: ProjectOverlayEntry[] = [];
  for (const descriptor of baselineFiles) {
    const current = candidate.get(descriptor.path);
    if (current === undefined) {
      overlay.push({ path: descriptor.path, disposition: "deleted", projectSha256: null, baselineSha256: descriptor.sha256 });
    } else if (current.sha256 !== descriptor.sha256) {
      overlay.push({ path: descriptor.path, disposition: "modified", projectSha256: current.sha256, baselineSha256: descriptor.sha256 });
    }
  }
  for (const descriptor of candidateFiles) {
    if (!baseline.has(descriptor.path)) overlay.push({ path: descriptor.path, disposition: "added", projectSha256: descriptor.sha256 });
  }
  return overlay.sort((left, right) => compareUtf8(left.path, right.path));
}

async function requireMatchingLifecycle(
  projectRoot: string,
  bundleSha256: Sha256Digest,
): Promise<ProfileLifecycleMetadata> {
  const lifecycle = await readProfileLifecycle(projectRoot);
  if (lifecycle === undefined) {
    throw new ProjectConfigMutationError("lifecycle_missing", "project profile lifecycle metadata is missing; run an explicit profile update first");
  }
  if (lifecycle.installedBundleSha256 !== bundleSha256) {
    throw new ProjectConfigMutationError("profile_package_mismatch", "profile package does not match the installed lifecycle baseline");
  }
  return lifecycle;
}

async function readInstalledMetadata(
  configRoot: string,
  expectedBundle: Sha256Digest,
): Promise<{ value: InstalledProfileMetadata; sha256: Sha256Digest }> {
  const bytes = await readFile(path.join(configRoot, INSTALL_METADATA_PATH));
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new ProjectConfigMutationError("install_metadata", "profile install metadata is not valid JSON"); }
  if (!isRecord(value) || value.protocol !== "koni.profile-install.v1" || value.bundleSha256 !== expectedBundle || !isRecord(value.projectOverrides) || !Array.isArray(value.pendingUpstream)) {
    throw new ProjectConfigMutationError("install_metadata", "profile install metadata does not match the authenticated package");
  }
  return { value: value as unknown as InstalledProfileMetadata, sha256: rawSha256(bytes) };
}

function normalizeStructuredDocument(document: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(document)) throw new ProjectConfigMutationError("config_document", "config document must be a plain mapping");
  let nodes = 0;
  const visit = (value: unknown, at: string, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_DOCUMENT_NODES) throw new ProjectConfigMutationError("config_nodes", "config document exceeds the node limit");
    if (depth > MAX_DOCUMENT_DEPTH) throw new ProjectConfigMutationError("config_depth", "config document exceeds the depth limit");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
        throw new ProjectConfigMutationError("config_number", `config document contains an unsafe number at ${at}`);
      }
      return value;
    }
    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") > MAX_SCALAR_BYTES) throw new ProjectConfigMutationError("config_scalar", `config scalar is too large at ${at}`);
      return value;
    }
    if (Array.isArray(value)) return value.map((item, index) => visit(item, `${at}/${index}`, depth + 1));
    if (!isRecord(value)) throw new ProjectConfigMutationError("config_value", `config document contains an unsupported value at ${at}`);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(value)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new ProjectConfigMutationError("config_key", `config document contains an unsafe key at ${at}`);
      }
      output[key] = visit(child, `${at}/${key}`, depth + 1);
    }
    return output;
  };
  return visit(document, "", 0) as Record<string, unknown>;
}

function semanticDomain(relative: string): ProjectConfigSemanticDomain {
  if (relative === "profile.yaml") return "profile";
  if (relative === "project.yaml") return "project";
  if (relative.startsWith("run-types/")) return "run-type";
  if (relative.startsWith("agents/")) return "agent";
  if (relative.startsWith("graph/" ) || relative === "graph.yaml") return "graph";
  if (relative.startsWith("rules/" ) || relative === "rules.yaml") return "rules";
  if (relative.startsWith("operations/" ) || relative === "operations.yaml") return "operations";
  if (relative.startsWith("workflows/" ) || relative === "workflows.yaml") return "workflows";
  if (relative.startsWith("actions/" ) || relative === "actions.yaml") return "actions";
  if (relative.startsWith("checks/" ) || relative === "checks.yaml") return "checks";
  if (relative.startsWith("personas/" ) || relative === "personas.yaml") return "personas";
  if (relative.startsWith("reports/" ) || relative === "reports.yaml") return "reports";
  if (relative.startsWith("cockpit/" ) || relative === "cockpit.yaml") return "cockpit";
  if (relative.startsWith("lifecycle/" ) || relative === "lifecycle.yaml") return "lifecycle";
  if (relative.startsWith("resources/")) return "resource";
  return "other";
}

function configLabel(relative: string, document?: Record<string, unknown>): string {
  for (const key of ["title", "display_name", "id"]) {
    if (typeof document?.[key] === "string" && document[key].trim().length > 0) return document[key].trim();
  }
  const basename = path.posix.basename(relative).replace(/\.ya?ml$/u, "");
  return basename.split(/[-_]/u).map((part) => part.length === 0 ? part : `${part[0]!.toUpperCase()}${part.slice(1)}`).join(" ");
}

function classifyPath(relative: string): ProfileFileKind {
  if (relative.startsWith("agents/") && /\.ya?ml$/u.test(relative)) return "agent";
  if (relative.startsWith("resources/skills/") && relative.endsWith("/SKILL.md")) return "skill";
  if (relative.includes("/prompts/") && relative.endsWith(".md")) return "prompt";
  if (/\.ya?ml$/u.test(relative)) return "config";
  return "other";
}

function validateEditablePath(relative: string): void {
  if (!/\.ya?ml$/u.test(relative)) {
    throw new ProjectConfigMutationError("config_path", `config document path is unsafe or not editable: ${relative}`);
  }
  validateAuthoredPath(relative);
}

function validateAuthoredPath(relative: string): void {
  if (!isNormalizedSafeRelativePath(relative) || isCompilerOwnedPath(relative)) {
    throw new ProjectConfigMutationError("config_path", `config document path is unsafe or not editable: ${relative}`);
  }
}

function isCompilerOwnedPath(relative: string): boolean {
  return isCompilerOwnedRoot(relative.split("/", 1)[0]!);
}

function isCompilerOwnedRoot(root: string): boolean {
  return root === ".managed" || root === ".transactions" || root === "runs";
}

function configMutationMarkerPath(id: string): string {
  return `.managed/config-mutations/${id}.json`;
}

async function assertCanonicalConfigRoot(projectRoot: string, configRoot: string): Promise<void> {
  const canonical = await realpath(configRoot);
  const metadata = await lstat(canonical);
  if (canonical !== configRoot || !metadata.isDirectory() || metadata.isSymbolicLink() || !canonical.startsWith(`${projectRoot}${path.sep}`)) {
    throw new ProjectConfigMutationError("config_root", ".koni is unavailable or escapes the project root");
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
    throw new ProjectConfigMutationError(code, `directory is unavailable or unsafe: ${absolute}: ${String(error)}`);
  }
}

function compilationError(code: string, diagnostics: readonly { path: string; code: string; message: string }[]): ProjectConfigMutationError {
  const rendered = diagnostics.map((diagnostic) => `${diagnostic.path}:${diagnostic.code}:${diagnostic.message}`);
  return new ProjectConfigMutationError(code, rendered.join("\n"), rendered);
}

function decodeUtf8(bytes: Uint8Array, relative: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ProjectConfigMutationError("config_utf8", `${relative} is not valid UTF-8`); }
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
