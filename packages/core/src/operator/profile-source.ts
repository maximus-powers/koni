import { createRequire } from "node:module";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
  FileJournalError,
  FileTransactionStore,
  type TransactionWrite,
} from "../authority/file-journal.js";
import { discoverAuthorityEndpoint } from "../authority/endpoint.js";
import type { ProfilePackageManifest } from "../contracts/profile-package.js";
import { isSha256Digest, type Sha256Digest } from "../shared/canonical.js";
import {
  installProfile,
  loadProfilePackage,
  previewProfileInstall,
  type ProfileInstallPreview,
  type ProfileInstallResult,
} from "../profile/install.js";

export const KONI_PROFILE_DISCOVER_EVENT = "koni.profile.discover.v1" as const;
export const KONI_PROFILE_AVAILABLE_EVENT = "koni.profile.available.v1" as const;
export const KONI_PROFILE_SOURCE_PROTOCOL = "koni.profile-source.v1" as const;

const INSTALL_RECORD = ".koni/.managed/install.json";
const MAX_INSTALL_RECORD_BYTES = 8 * 1024 * 1024;
const KNOWN_PROFILE_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  coding: "@koni/coding-profile",
  software: "@koni/coding-profile",
  research: "@koni/research-profile",
});

export interface KoniProfileSourceDescriptor {
  protocol: typeof KONI_PROFILE_SOURCE_PROTOCOL;
  package: string;
  manifest_url: string;
}

export interface InstalledProfileReference {
  packageName: string;
  profileId: string;
  profileVersion: string;
  bundleSha256: string;
}

export interface PreparedProfilePackage {
  packageRoot: string;
  manifest: ProfilePackageManifest;
}

export type ProjectProfileInstallState = "empty" | "managed" | "unmanaged";

export class OperatorProfileError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "OperatorProfileError";
    this.code = code;
  }
}

/**
 * Session-local catalog of profile packages already loaded by Pi.
 *
 * Discovery uses Pi's public event bus and never scans or edits Pi package directories. Profiles
 * only announce immutable file URLs; Core validates every manifest and byte before use.
 */
export class PiProfileSourceCatalog {
  readonly #events: EventBus;
  readonly #sources = new Map<string, KoniProfileSourceDescriptor>();
  readonly #conflicts = new Map<string, Set<string>>();
  readonly #unsubscribe: () => void;

  public constructor(events: EventBus) {
    this.#events = events;
    this.#unsubscribe = events.on(KONI_PROFILE_AVAILABLE_EVENT, (value) => {
      const source = parseProfileSourceDescriptor(value);
      if (source === undefined) return;
      const existing = this.#sources.get(source.package);
      if (existing === undefined) {
        this.#sources.set(source.package, source);
      } else if (existing.manifest_url !== source.manifest_url) {
        const urls = this.#conflicts.get(source.package) ?? new Set([existing.manifest_url]);
        urls.add(source.manifest_url);
        this.#conflicts.set(source.package, urls);
      }
    });
  }

  public discover(): readonly KoniProfileSourceDescriptor[] {
    this.#events.emit(KONI_PROFILE_DISCOVER_EVENT, undefined);
    if (this.#conflicts.size > 0) {
      const packages = [...this.#conflicts.keys()].sort().join(", ");
      throw new OperatorProfileError(
        "profile_source_conflict",
        `multiple Pi packages announced different manifests for ${packages}; run \`pi list\`, remove the older Koni source with \`pi remove <older-koni-source> --local\`, preserve unrelated packages, then run \`/reload\``,
      );
    }
    return [...this.#sources.values()].sort((left, right) =>
      left.package.localeCompare(right.package),
    );
  }

  public find(packageName: string): KoniProfileSourceDescriptor | undefined {
    return this.discover().find((source) => source.package === packageName);
  }

  public dispose(): void {
    this.#unsubscribe();
    this.#sources.clear();
    this.#conflicts.clear();
  }
}

export function parseProfileSourceDescriptor(
  value: unknown,
): KoniProfileSourceDescriptor | undefined {
  if (!isRecord(value) || value.protocol !== KONI_PROFILE_SOURCE_PROTOCOL) return undefined;
  if (typeof value.package !== "string" || !isPackageName(value.package)) return undefined;
  if (typeof value.manifest_url !== "string") return undefined;
  let manifest: URL;
  try {
    manifest = new URL(value.manifest_url);
  } catch {
    return undefined;
  }
  if (
    manifest.protocol !== "file:" ||
    manifest.username !== "" ||
    manifest.password !== "" ||
    manifest.search !== "" ||
    manifest.hash !== "" ||
    path.basename(fileURLToPath(manifest)) !== "profile-manifest.json"
  )
    return undefined;
  return {
    protocol: KONI_PROFILE_SOURCE_PROTOCOL,
    package: value.package,
    manifest_url: manifest.href,
  };
}

export async function packageRootFromDescriptor(
  descriptor: KoniProfileSourceDescriptor,
): Promise<string> {
  const parsed = parseProfileSourceDescriptor(descriptor);
  if (parsed === undefined)
    throw new OperatorProfileError("profile_descriptor", "profile descriptor is invalid");
  const manifestPath = fileURLToPath(parsed.manifest_url);
  const packageRoot = path.dirname(path.dirname(manifestPath));
  const canonical = await realpath(packageRoot);
  await verifyNpmPackageIdentity(canonical, parsed.package);
  const baseline = await loadProfilePackage(canonical);
  if (baseline.manifest.package.name !== parsed.package) {
    throw new OperatorProfileError(
      "profile_identity",
      `profile descriptor announced ${parsed.package} but contains ${baseline.manifest.package.name}`,
    );
  }
  return canonical;
}

/** Resolve an explicit directory, a friendly built-in name, or an installed npm package name. */
export async function resolveProfilePackageRoot(
  input: string,
  sources: readonly KoniProfileSourceDescriptor[] = [],
): Promise<string> {
  const packageName = KNOWN_PROFILE_PACKAGES[input] ?? input;

  const asPath = path.resolve(input);
  try {
    const metadata = await lstat(asPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new OperatorProfileError(
        "profile_path",
        "profile package path must be a real directory",
      );
    }
    await loadProfilePackage(asPath);
    return await realpath(asPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  if (!isPackageName(packageName)) {
    throw new OperatorProfileError("profile_selector", `unknown profile selector: ${input}`);
  }
  try {
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve(`${packageName}/koni/profile-manifest.json`);
    const root = path.dirname(path.dirname(manifestPath));
    await verifyNpmPackageIdentity(root, packageName);
    await loadProfilePackage(root);
    return await realpath(root);
  } catch (error) {
    if (error instanceof OperatorProfileError) throw error;
  }

  const announced = sources.find((source) => source.package === packageName);
  if (announced !== undefined) return packageRootFromDescriptor(announced);
  throw new OperatorProfileError(
    "profile_unavailable",
    `profile package ${packageName} is not available; install it in Pi or pass --profile-package`,
  );
}

/**
 * Copy an already verified package into a hash-addressed authority cache.
 * Editable project files remain separate, and the cache never touches Pi's package installation.
 */
export async function cacheProfilePackage(
  projectRoot: string,
  profilePackageRoot: string,
): Promise<PreparedProfilePackage> {
  const source = await loadProfilePackage(profilePackageRoot);
  const target = await discoverAuthorityEndpoint(projectRoot);
  const digest = source.manifest.bundle_sha256.slice("sha256:".length);
  const cacheRoot = path.join(target.stateRoot, "profile-cache");
  const relativePackageRoot = `${digest}/package`;
  const packageRoot = path.join(cacheRoot, relativePackageRoot);
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const store = await FileTransactionStore.open(cacheRoot);
  await store.recoverPrepared();
  const existing = await tryLoadMatchingPackage(packageRoot, source.manifest.bundle_sha256);
  if (existing !== undefined) return { packageRoot, manifest: existing };

  const writes: TransactionWrite[] = [
    {
      path: `${relativePackageRoot}/koni/profile-manifest.json`,
      bytes: Buffer.from(`${JSON.stringify(source.manifest, null, 2)}\n`, "utf8"),
      expectedSha256: null,
    },
  ];
  for (const descriptor of source.manifest.baseline.files) {
    writes.push({
      path: `${relativePackageRoot}/koni/baseline/${descriptor.path}`,
      bytes: source.files.get(descriptor.path)!,
      expectedSha256: null,
    });
  }
  for (const descriptor of source.manifest.migrations ?? []) {
    writes.push({
      path: `${relativePackageRoot}/koni/${descriptor.path}`,
      bytes: source.migrationResources.get(descriptor.path)!,
      expectedSha256: null,
    });
  }
  const transactionId = `profile-${digest.slice(0, 48)}`;
  try {
    await store.prepare(transactionId, writes);
  } catch (error) {
    if (!(error instanceof FileJournalError && error.code === "transaction_exists")) throw error;
  }
  await store.recoverPrepared();
  try {
    await store.cleanupCommitted(transactionId);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const cached = await loadProfilePackage(packageRoot);
  if (cached.manifest.bundle_sha256 !== source.manifest.bundle_sha256) {
    throw new OperatorProfileError(
      "profile_cache_collision",
      "profile cache contains a different bundle",
    );
  }
  return { packageRoot, manifest: cached.manifest };
}

export async function installAndCacheProfile(
  options: {
    projectRoot: string;
    profilePackageRoot: string;
    expectedPreviewSha256?: Sha256Digest;
  },
  dependencies: {
    install?: typeof installProfile;
  } = {},
): Promise<ProfileInstallResult & { cachedPackageRoot: string }> {
  const endpoint = await discoverAuthorityEndpoint(options.projectRoot);
  const projectRoot = endpoint.identity.worktreeRoot;
  const installState = await inspectProjectProfileInstallState(projectRoot);
  if (installState !== "empty" && installState !== "managed") {
    throw new OperatorProfileError(
      "profile_not_managed",
      "project contains an unmanaged .koni directory; remove or rename it before installing",
    );
  }
  // Cache first: a successful project install is never left without its execution authority.
  const cached = await cacheProfilePackage(projectRoot, options.profilePackageRoot);
  // Publish only from the immutable verified cache. Re-reading an ambient Pi/npm package here
  // would reopen a package-update race after the cache identity was already chosen.
  const installed = await (dependencies.install ?? installProfile)(
    projectRoot,
    cached.packageRoot,
    {
      ...(options.expectedPreviewSha256 === undefined
        ? {}
        : { expectedPreviewSha256: options.expectedPreviewSha256 }),
    },
  );
  if (installed.bundleSha256 !== cached.manifest.bundle_sha256) {
    throw new OperatorProfileError(
      "profile_install_race",
      "installed profile differs from cached package",
    );
  }
  return { ...installed, cachedPackageRoot: cached.packageRoot };
}

/** Cache the authenticated source, then derive the exact no-write project update preview. */
export async function previewProfileUpdate(options: {
  projectRoot: string;
  profilePackageRoot: string;
}): Promise<ProfileInstallPreview> {
  const endpoint = await discoverAuthorityEndpoint(options.projectRoot);
  const projectRoot = endpoint.identity.worktreeRoot;
  const installState = await inspectProjectProfileInstallState(projectRoot);
  if (installState !== "empty" && installState !== "managed") {
    throw new OperatorProfileError(
      "profile_not_managed",
      "project configuration is not a managed Koni profile; remove or rename it before updating",
    );
  }
  // Preview reads the verified source directly and performs no cache, project, lock, or journal write.
  // Apply re-verifies and caches the source; any package/project drift changes the required digest.
  return previewProfileInstall(projectRoot, options.profilePackageRoot);
}

/** Classify only the project-owned profile roots; this never creates a cache, lock, or profile. */
export async function inspectProjectProfileInstallState(
  projectRoot: string,
): Promise<ProjectProfileInstallState> {
  const endpoint = await discoverAuthorityEndpoint(projectRoot);
  const project = endpoint.identity.worktreeRoot;
  const koni = await realDirectory(path.join(project, ".koni"));
  if (!koni) return "empty";
  const managed =
    koni && (await realFileUnder(path.join(project, ".koni"), [".managed", "install.json"]));
  if (managed) return "managed";
  return "unmanaged";
}

async function realDirectory(candidate: string): Promise<boolean> {
  try {
    const metadata = await lstat(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new OperatorProfileError("profile_path", `${candidate} must be a real directory`);
    }
    if ((await realpath(candidate)) !== candidate) {
      throw new OperatorProfileError(
        "profile_path",
        `profile path is redirected through a symlink: ${candidate}; restore a real project-owned directory`,
      );
    }
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function realFileUnder(root: string, components: readonly string[]): Promise<boolean> {
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]!);
    try {
      const metadata = await lstat(current);
      const terminal = index === components.length - 1;
      if (metadata.isSymbolicLink() || (terminal ? !metadata.isFile() : !metadata.isDirectory())) {
        throw new OperatorProfileError(
          "profile_not_managed",
          `managed profile marker is redirected or invalid: ${current}; repair it before installing`,
        );
      }
      if (!terminal && (await realpath(current)) !== current) {
        throw new OperatorProfileError(
          "profile_not_managed",
          `managed profile marker has a redirected ancestor: ${current}; repair it before installing`,
        );
      }
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
  return true;
}

async function verifyNpmPackageIdentity(packageRoot: string, expectedName: string): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  } catch {
    throw new OperatorProfileError(
      "profile_package_identity",
      "profile source has no readable npm package manifest",
    );
  }
  if (!isRecord(value) || value.name !== expectedName) {
    throw new OperatorProfileError(
      "profile_package_identity",
      `profile source does not belong to npm package ${expectedName}`,
    );
  }
}

export async function readInstalledProfileReference(
  projectRoot: string,
): Promise<InstalledProfileReference> {
  const endpoint = await discoverAuthorityEndpoint(projectRoot);
  const installPath = path.join(endpoint.identity.worktreeRoot, INSTALL_RECORD);
  const metadata = await lstat(installPath).catch((error: unknown) => {
    if (isMissing(error)) {
      throw new OperatorProfileError(
        "project_uninitialized",
        "project has no installed Koni profile; run koni init",
      );
    }
    throw error;
  });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_INSTALL_RECORD_BYTES) {
    throw new OperatorProfileError(
      "install_record",
      "Koni profile install record is not a safe bounded file",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(installPath, "utf8"));
  } catch {
    throw new OperatorProfileError(
      "install_record",
      "Koni profile install record is not valid JSON",
    );
  }
  if (
    !isRecord(value) ||
    !isRecord(value.package) ||
    !isRecord(value.profile) ||
    typeof value.package.name !== "string" ||
    !isPackageName(value.package.name) ||
    typeof value.profile.id !== "string" ||
    typeof value.profile.version !== "string" ||
    typeof value.bundleSha256 !== "string" ||
    !isSha256Digest(value.bundleSha256)
  )
    throw new OperatorProfileError(
      "install_record",
      "Koni profile install record has an invalid shape",
    );
  return {
    packageName: value.package.name,
    profileId: value.profile.id,
    profileVersion: value.profile.version,
    bundleSha256: value.bundleSha256,
  };
}

export async function loadCachedInstalledProfile(
  projectRoot: string,
): Promise<PreparedProfilePackage> {
  const target = await discoverAuthorityEndpoint(projectRoot);
  const installed = await readInstalledProfileReference(target.identity.worktreeRoot);
  const digest = installed.bundleSha256.slice("sha256:".length);
  const packageRoot = path.join(target.stateRoot, "profile-cache", digest, "package");
  let metadata;
  try {
    metadata = await lstat(packageRoot);
  } catch (error) {
    if (!isMissing(error)) throw error;
    throw new OperatorProfileError(
      "profile_cache_missing",
      `authenticated package ${installed.packageName}@${installed.profileVersion} is not cached; run koni update --profile-package <path>`,
    );
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new OperatorProfileError(
      "profile_cache_provenance",
      "cached profile root is not a real directory",
    );
  }
  const baseline = await loadProfilePackage(packageRoot);
  if (
    baseline.manifest.package.name !== installed.packageName ||
    baseline.manifest.profile.id !== installed.profileId ||
    baseline.manifest.profile.version !== installed.profileVersion ||
    baseline.manifest.bundle_sha256 !== installed.bundleSha256
  )
    throw new OperatorProfileError(
      "profile_cache_provenance",
      "cached profile differs from project install provenance",
    );
  return { packageRoot, manifest: baseline.manifest };
}

async function tryLoadMatchingPackage(
  packageRoot: string,
  expectedBundle: string,
): Promise<ProfilePackageManifest | undefined> {
  let metadata;
  try {
    metadata = await lstat(packageRoot);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new OperatorProfileError(
      "profile_cache_collision",
      "profile cache target is not a real directory",
    );
  }
  const loaded = await loadProfilePackage(packageRoot);
  if (loaded.manifest.bundle_sha256 !== expectedBundle) {
    throw new OperatorProfileError(
      "profile_cache_collision",
      "profile cache path contains a different bundle",
    );
  }
  return loaded.manifest;
}

function isPackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u.test(value);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
