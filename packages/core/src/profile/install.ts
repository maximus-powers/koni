import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { FileTransactionStore, type TransactionDelete, type TransactionWrite } from "../authority/file-journal.js";
import type { ProfileBaselineFile, ProfilePackageManifest } from "../contracts/profile-package.js";
import {
  parseProfilePackageManifest,
  verifyProfileBaseline,
  type VerifiedProfileBaseline,
} from "../compiler/profile-package.js";
import { rawSha256, type Sha256Digest } from "../shared/canonical.js";

const INSTALL_PROTOCOL = "koni.profile-install.v1" as const;
const INSTALL_METADATA_PATH = ".managed/install.json";

interface InstalledProfileMetadata {
  protocol: typeof INSTALL_PROTOCOL;
  package: ProfilePackageManifest["package"];
  profile: ProfilePackageManifest["profile"];
  compatibility: ProfilePackageManifest["compatibility"];
  bundleSha256: Sha256Digest;
  installedAt: string;
  baselineFiles: ProfileBaselineFile[];
  projectOverrides: Record<string, Sha256Digest | null>;
  pendingUpstream: { path: string; proposedPath: string; reason: "modified" | "deleted" | "orphaned" }[];
}

export interface ProfileInstallResult {
  projectConfigRoot: string;
  packageName: string;
  profileVersion: string;
  bundleSha256: Sha256Digest;
  added: string[];
  updated: string[];
  deleted: string[];
  preserved: string[];
  pendingUpstream: InstalledProfileMetadata["pendingUpstream"];
}

export class ProfileInstallError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ProfileInstallError";
    this.code = code;
  }
}

export async function loadProfilePackage(packageRoot: string): Promise<VerifiedProfileBaseline> {
  const manifestPath = path.join(packageRoot, "koni", "profile-manifest.json");
  const parsed = parseProfilePackageManifest(await readFile(manifestPath, "utf8"));
  if (!parsed.ok) {
    throw new ProfileInstallError(
      "manifest_invalid",
      parsed.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("\n"),
    );
  }
  const baselineRoot = path.join(packageRoot, "koni", "baseline");
  const files = await readAllRegularFiles(baselineRoot);
  const verified = verifyProfileBaseline(parsed.value, files);
  if (!verified.ok) {
    throw new ProfileInstallError(
      "baseline_invalid",
      verified.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("\n"),
    );
  }
  return verified.value;
}

export async function installProfile(
  projectRoot: string,
  profilePackageRoot: string,
): Promise<ProfileInstallResult> {
  const packageBaseline = await loadProfilePackage(profilePackageRoot);
  const configRoot = path.join(projectRoot, ".koni");
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  const store = await FileTransactionStore.open(configRoot);
  const installed = await readInstalledMetadata(configRoot);
  if (installed !== undefined && installed.profile.lineage !== packageBaseline.manifest.profile.lineage) {
    throw new ProfileInstallError(
      "lineage_mismatch",
      `project uses ${installed.profile.lineage}; cannot upgrade it with ${packageBaseline.manifest.profile.lineage}`,
    );
  }
  if (installed === undefined) {
    const unmanaged = (await listProjectFiles(configRoot)).filter(
      (file) => file !== ".transactions" && !file.startsWith(".transactions/"),
    );
    if (unmanaged.length > 0) {
      throw new ProfileInstallError(
        "unmanaged_project",
        ".koni already contains files but has no Koni profile install record",
      );
    }
  }

  const oldFiles = new Map(installed?.baselineFiles.map((file) => [file.path, file]) ?? []);
  const newFiles = new Map(packageBaseline.manifest.baseline.files.map((file) => [file.path, file]));
  const writes: TransactionWrite[] = [];
  const deletes: TransactionDelete[] = [];
  const added: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];
  const preserved: string[] = [];
  const pendingUpstream: InstalledProfileMetadata["pendingUpstream"] = [];
  const overrides: Record<string, Sha256Digest | null> = Object.create(null) as Record<
    string,
    Sha256Digest | null
  >;

  for (const descriptor of packageBaseline.manifest.baseline.files) {
    const bytes = packageBaseline.files.get(descriptor.path)!;
    const current = await readOptionalFile(path.join(configRoot, descriptor.path));
    const old = oldFiles.get(descriptor.path);
    if (current === undefined) {
      if (old === undefined) {
        writes.push({ path: descriptor.path, bytes, expectedSha256: null });
        added.push(descriptor.path);
      } else {
        overrides[descriptor.path] = null;
        preserved.push(descriptor.path);
        await addUpstreamProposal(
          configRoot,
          packageBaseline.manifest,
          descriptor.path,
          bytes,
          "deleted",
          writes,
          pendingUpstream,
        );
      }
      continue;
    }
    const currentHash = rawSha256(current);
    if (currentHash === descriptor.sha256) {
      continue;
    }
    if (old !== undefined && currentHash === old.sha256) {
      writes.push({ path: descriptor.path, bytes, expectedSha256: currentHash });
      updated.push(descriptor.path);
      continue;
    }
    overrides[descriptor.path] = currentHash;
    preserved.push(descriptor.path);
    await addUpstreamProposal(
      configRoot,
      packageBaseline.manifest,
      descriptor.path,
      bytes,
      "modified",
      writes,
      pendingUpstream,
    );
  }

  for (const old of oldFiles.values()) {
    if (newFiles.has(old.path)) {
      continue;
    }
    const current = await readOptionalFile(path.join(configRoot, old.path));
    if (current === undefined) {
      continue;
    }
    const currentHash = rawSha256(current);
    if (currentHash === old.sha256) {
      deletes.push({ path: old.path, expectedSha256: currentHash });
      deleted.push(old.path);
    } else {
      overrides[old.path] = currentHash;
      preserved.push(old.path);
      pendingUpstream.push({
        path: old.path,
        proposedPath: "",
        reason: "orphaned",
      });
    }
  }

  const metadata: InstalledProfileMetadata = {
    protocol: INSTALL_PROTOCOL,
    package: packageBaseline.manifest.package,
    profile: packageBaseline.manifest.profile,
    compatibility: packageBaseline.manifest.compatibility,
    bundleSha256: packageBaseline.manifest.bundle_sha256,
    installedAt: new Date().toISOString(),
    baselineFiles: [...packageBaseline.manifest.baseline.files],
    projectOverrides: overrides,
    pendingUpstream,
  };
  const priorMetadata = await readOptionalFile(path.join(configRoot, INSTALL_METADATA_PATH));
  writes.push({
    path: INSTALL_METADATA_PATH,
    bytes: Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
    expectedSha256: priorMetadata === undefined ? null : rawSha256(priorMetadata),
  });

  const transactionId = `profile-${Date.now()}-${process.pid}`;
  await store.prepare(transactionId, writes, deletes);
  await store.commit(transactionId);
  await store.cleanupCommitted(transactionId);
  return {
    projectConfigRoot: configRoot,
    packageName: packageBaseline.manifest.package.name,
    profileVersion: packageBaseline.manifest.profile.version,
    bundleSha256: packageBaseline.manifest.bundle_sha256,
    added: added.sort(),
    updated: updated.sort(),
    deleted: deleted.sort(),
    preserved: preserved.sort(),
    pendingUpstream: [...pendingUpstream].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

async function addUpstreamProposal(
  configRoot: string,
  manifest: ProfilePackageManifest,
  sourcePath: string,
  bytes: Uint8Array,
  reason: "modified" | "deleted",
  writes: TransactionWrite[],
  pending: InstalledProfileMetadata["pendingUpstream"],
): Promise<void> {
  const bundleSuffix = manifest.bundle_sha256.slice("sha256:".length, "sha256:".length + 12);
  const proposedPath = `.managed/upstream/${manifest.profile.version}-${bundleSuffix}/${sourcePath}`;
  const current = await readOptionalFile(path.join(configRoot, proposedPath));
  if (current === undefined) {
    writes.push({ path: proposedPath, bytes, expectedSha256: null });
  } else if (rawSha256(current) !== rawSha256(bytes)) {
    throw new ProfileInstallError("proposal_collision", `upstream proposal changed unexpectedly: ${proposedPath}`);
  }
  pending.push({ path: sourcePath, proposedPath, reason });
}

async function readInstalledMetadata(configRoot: string): Promise<InstalledProfileMetadata | undefined> {
  const bytes = await readOptionalFile(path.join(configRoot, INSTALL_METADATA_PATH));
  if (bytes === undefined) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ProfileInstallError("install_record_invalid", "profile install record is not valid JSON");
  }
  if (
    !isRecord(value) ||
    value.protocol !== INSTALL_PROTOCOL ||
    !isRecord(value.profile) ||
    typeof value.profile.lineage !== "string" ||
    !Array.isArray(value.baselineFiles)
  ) {
    throw new ProfileInstallError("install_record_invalid", "profile install record has an invalid shape");
  }
  return value as unknown as InstalledProfileMetadata;
}

async function readAllRegularFiles(root: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new ProfileInstallError("package_symlink", `profile baseline contains a symlink: ${relative}`);
      }
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        files.set(relative, await readFile(absolute));
      } else {
        throw new ProfileInstallError("package_file_type", `profile baseline has an unsupported file: ${relative}`);
      }
    }
  };
  await walk(root, "");
  return files;
}

async function listProjectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
      else files.push(relative);
    }
  };
  await walk(root, "");
  return files;
}

async function readOptionalFile(filePath: string): Promise<Buffer | undefined> {
  try {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new ProfileInstallError("unsafe_project_file", `project config path is not a regular file: ${filePath}`);
    }
    return await readFile(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
