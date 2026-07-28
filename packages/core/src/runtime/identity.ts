import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Sha256Digest } from "../shared/canonical.js";
import { KONI_PI_PACKAGE_ROOT_ENV } from "./pi-peer-runtime.js";
import {
  assertRuntimeExecutableCurrent,
  captureRuntimeExecutable,
  isRuntimeExecutableIdentity,
  resolveRuntimeExecutable,
  type RuntimeExecutableIdentity,
} from "./executable.js";

export const KONI_RUNTIME_IDENTITY_PROTOCOL = "koni.runtime-identity.v1" as const;
export const KONI_RUNTIME_CLOSURE_ENV = "KONI_RUNTIME_CLOSURE_SHA256" as const;
export const KONI_RUNTIME_PIN_PATH_ENV = "KONI_RUNTIME_PIN_PATH" as const;
export const KONI_RUNTIME_PIN_SHA256_ENV = "KONI_RUNTIME_PIN_SHA256" as const;
export const KONI_RUNTIME_STAGE_PROTOCOL = "koni.runtime-stage.v1" as const;
const CORE_BUILD_IDENTITY_PLACEHOLDER = `sha256:${"0".repeat(64)}`;
/** Replaced in `dist` after compilation; source-mode tests deliberately retain the placeholder. */
export const KONI_EMBEDDED_CORE_BUILD_SHA256 =
  "sha256:0000000000000000000000000000000000000000000000000000000000000000" as Sha256Digest;

const CORE_PACKAGE = "@koni/core";
const MAX_RUNTIME_PACKAGES = 2_048;
const MAX_RUNTIME_FILES = 500_000;
const MAX_RUNTIME_DIRECTORIES = 100_000;
const MAX_RUNTIME_RESOLUTIONS = 100_000;
const MAX_RUNTIME_PIN_BYTES = 64 * 1024 * 1024;

export interface CoreRuntimeIdentity {
  protocol: typeof KONI_RUNTIME_IDENTITY_PROTOCOL;
  packageName: typeof CORE_PACKAGE;
  packageVersion: string;
  buildSha256: Sha256Digest;
}

export interface LatchedCoreRuntimeIdentity {
  /** Identity of the bytes that were present when this module/session loaded. */
  identity(): Promise<CoreRuntimeIdentity>;
  /** Fail when the installed files no longer match those already executing in memory. */
  assertCurrent(): Promise<void>;
}

export interface RuntimePackageIdentity {
  name: string;
  version: string;
  contentSha256: Sha256Digest;
  fileCount: number;
}

export interface RuntimeClosureIdentity extends CoreRuntimeIdentity {
  closureSha256: Sha256Digest;
  nodeVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  packages: readonly RuntimePackageIdentity[];
  executables: readonly RuntimeExecutableIdentity[];
  files: readonly RuntimeFileIdentity[];
  directories: readonly RuntimeDirectoryIdentity[];
  resolutions: readonly RuntimeDependencyResolutionIdentity[];
}

export interface RuntimeFileIdentity {
  path: string;
  kind: "file" | "symlink";
  size: number;
  device: string;
  inode: string;
  mode: number;
  modifiedNs: string;
  changedNs: string;
  /** Exact raw bytes returned by the authenticated loader for regular runtime files. */
  contentSha256?: Sha256Digest;
  linkTarget?: string;
}

export interface RuntimeDirectoryIdentity {
  path: string;
  inventorySha256: Sha256Digest;
}

/** Exact Node package-resolution edge recreated inside the immutable runtime stage. */
export interface RuntimeDependencyResolutionIdentity {
  parentPackageRoot: string;
  dependency: string;
  packageRoot: string;
}

export interface RuntimeClosurePinReference {
  path: string;
  pinSha256: Sha256Digest;
  closureSha256: Sha256Digest;
}

export class RuntimeIdentityError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "RuntimeIdentityError";
    this.code = code;
  }
}

/** Hash the exact Core source tree executing this process, independent of its install path. */
export async function captureCoreRuntimeIdentity(
  anchorUrl: string | URL = import.meta.url,
): Promise<CoreRuntimeIdentity> {
  const anchor = await realpath(fileURLToPath(anchorUrl));
  const packageRoot = await findPackageRoot(anchor, CORE_PACKAGE);
  const manifest = await readPackageManifest(packageRoot, CORE_PACKAGE);
  const relativeAnchor = path.relative(packageRoot, anchor).split(path.sep);
  const runtimeDirectoryName = relativeAnchor[0];
  if (runtimeDirectoryName !== "src" && runtimeDirectoryName !== "dist") {
    throw new RuntimeIdentityError(
      "core_runtime_root",
      `Koni Core is executing outside its src/dist runtime tree: ${anchor}`,
    );
  }
  const hash = createHash("sha256");
  hash.update(`${KONI_RUNTIME_IDENTITY_PROTOCOL}\0${manifest.name}\0${manifest.version}\0`, "utf8");
  await hashFileInto(hash, path.join(packageRoot, "package.json"), "package.json");
  const tree = await hashTree(
    path.join(packageRoot, runtimeDirectoryName),
    runtimeDirectoryName,
    hash,
  );
  const bin = await hashOptionalTree(path.join(packageRoot, "bin"), "bin", hash);
  if (tree.fileCount + bin.fileCount === 0) {
    throw new RuntimeIdentityError("core_runtime_empty", "Koni Core runtime tree is empty");
  }
  return {
    protocol: KONI_RUNTIME_IDENTITY_PROTOCOL,
    packageName: CORE_PACKAGE,
    packageVersion: manifest.version,
    buildSha256: digest(hash),
  };
}

/**
 * Start capturing immediately and retain that result for the lifetime of the loaded module.
 * This prevents old in-memory extension code from advertising a newer build merely because an
 * installer replaced the files beneath an active Pi session.
 */
export function latchCoreRuntimeIdentity(
  anchorUrl: string | URL = import.meta.url,
  embeddedBuildSha256?: Sha256Digest,
): LatchedCoreRuntimeIdentity {
  const captured = captureCoreRuntimeIdentity(anchorUrl);
  const shippedRuntime = runtimeDirectoryName(anchorUrl) === "dist";
  const embedded =
    embeddedBuildSha256 ?? (shippedRuntime ? KONI_EMBEDDED_CORE_BUILD_SHA256 : undefined);
  const missingEmbeddedIdentity = shippedRuntime && embedded === CORE_BUILD_IDENTITY_PLACEHOLDER;
  return {
    identity: async () => {
      if (missingEmbeddedIdentity) {
        throw new RuntimeIdentityError(
          "core_build_identity_unembedded",
          "shipped Koni Core has no embedded build identity; reinstall the exact package archive",
        );
      }
      const identity = await captured;
      return structuredClone(
        embedded === undefined ? identity : { ...identity, buildSha256: embedded },
      );
    },
    assertCurrent: async () => {
      if (missingEmbeddedIdentity) {
        throw new RuntimeIdentityError(
          "core_build_identity_unembedded",
          "shipped Koni Core has no embedded build identity; reinstall the exact package archive",
        );
      }
      const diskAtLoad = await captured;
      const expected =
        embedded === undefined ? diskAtLoad : { ...diskAtLoad, buildSha256: embedded };
      const current = await captureCoreRuntimeIdentity(anchorUrl);
      if (
        current.protocol !== expected.protocol ||
        current.packageName !== expected.packageName ||
        current.packageVersion !== expected.packageVersion ||
        current.buildSha256 !== expected.buildSha256
      ) {
        throw new RuntimeIdentityError(
          "core_runtime_changed",
          "Koni Core changed beneath this active Pi session; stop active authorities if needed, reload Pi, then reconnect",
        );
      }
    },
  };
}

const executingCoreRuntime = latchCoreRuntimeIdentity();

export function executingCoreRuntimeIdentity(): Promise<CoreRuntimeIdentity> {
  return executingCoreRuntime.identity();
}

export function assertExecutingCoreRuntimeCurrent(): Promise<void> {
  return executingCoreRuntime.assertCurrent();
}

/**
 * Capture every resolved runtime package byte used by Core and Pi.
 *
 * Paths are intentionally excluded from the digest: two byte-identical npm/Pi installations have
 * the same identity. Nested dependency roots remain separate entries, so duplicated packages with
 * different bytes cannot collapse into one apparent closure.
 */
export async function captureRuntimeClosure(
  anchorUrl: string | URL = import.meta.url,
  piPackageRoot?: string,
): Promise<RuntimeClosureIdentity> {
  const core = await captureCoreRuntimeIdentity(anchorUrl);
  const anchor = await realpath(fileURLToPath(anchorUrl));
  const coreRoot = await findPackageRoot(anchor, CORE_PACKAGE);
  const pending = [coreRoot];
  const seenRoots = new Set<string>();
  const packages: RuntimePackageIdentity[] = [];
  const packagesByRoot = new Map<string, RuntimePackageIdentity>();
  const files: RuntimeFileIdentity[] = [];
  const directories: RuntimeDirectoryIdentity[] = [];
  const resolutions: RuntimeDependencyResolutionIdentity[] = [];
  const executables = await captureAuthorityExecutables();
  let totalFiles = 0;

  while (pending.length > 0) {
    if (seenRoots.size >= MAX_RUNTIME_PACKAGES) {
      throw new RuntimeIdentityError(
        "runtime_package_limit",
        `runtime closure exceeds ${MAX_RUNTIME_PACKAGES} packages`,
      );
    }
    const packageRoot = await realpath(pending.shift()!);
    if (seenRoots.has(packageRoot)) continue;
    seenRoots.add(packageRoot);
    const manifest = await readPackageManifest(packageRoot);
    const content =
      manifest.name === CORE_PACKAGE
        ? await hashCorePackageContent(packageRoot, anchor, files, directories)
        : await hashPackageContent(packageRoot, files, directories);
    totalFiles += content.fileCount;
    if (totalFiles > MAX_RUNTIME_FILES) {
      throw new RuntimeIdentityError(
        "runtime_file_limit",
        `runtime closure exceeds ${MAX_RUNTIME_FILES} files`,
      );
    }
    const packageIdentity: RuntimePackageIdentity = {
      name: manifest.name,
      version: manifest.version,
      contentSha256: content.sha256,
      fileCount: content.fileCount,
    };
    packages.push(packageIdentity);
    packagesByRoot.set(packageRoot, packageIdentity);

    const required = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
    };
    const optional = {
      ...(manifest.optionalDependencies ?? {}),
      ...Object.fromEntries(
        Object.entries(manifest.peerDependenciesMeta ?? {})
          .filter(([, metadata]) => metadata?.optional === true)
          .map(([name]) => [name, "*"]),
      ),
    };
    for (const dependency of Object.keys({ ...required, ...optional }).sort(compareUtf8)) {
      const resolved = await resolveDependencyPackageRoot(packageRoot, dependency, piPackageRoot);
      if (resolved === undefined) {
        if (Object.hasOwn(optional, dependency)) continue;
        throw new RuntimeIdentityError(
          "runtime_dependency_missing",
          `${manifest.name}@${manifest.version} cannot resolve required runtime package ${dependency}`,
        );
      }
      resolutions.push({
        parentPackageRoot: packageRoot,
        dependency,
        packageRoot: resolved,
      });
      pending.push(resolved);
    }
  }

  packages.sort(
    (left, right) =>
      compareUtf8(left.name, right.name) ||
      compareUtf8(left.version, right.version) ||
      compareUtf8(left.contentSha256, right.contentSha256),
  );
  files.sort((left, right) => compareUtf8(left.path, right.path));
  directories.sort((left, right) => compareUtf8(left.path, right.path));
  resolutions.sort(
    (left, right) =>
      compareUtf8(left.parentPackageRoot, right.parentPackageRoot) ||
      compareUtf8(left.dependency, right.dependency) ||
      compareUtf8(left.packageRoot, right.packageRoot),
  );
  if (directories.length > MAX_RUNTIME_DIRECTORIES) {
    throw new RuntimeIdentityError(
      "runtime_directory_limit",
      `runtime closure exceeds ${MAX_RUNTIME_DIRECTORIES} directories`,
    );
  }
  const closure = createHash("sha256");
  closure.update(
    `${KONI_RUNTIME_IDENTITY_PROTOCOL}\0node\0${process.versions.node}\0${process.platform}\0${process.arch}\0`,
    "utf8",
  );
  for (const item of packages) {
    closure.update(
      `${item.name}\0${item.version}\0${item.contentSha256}\0${item.fileCount}\0`,
      "utf8",
    );
  }
  for (const executable of executables) {
    closure.update(`${executable.role}\0${executable.sha256}\0${executable.size}\0`, "utf8");
  }
  const topology = normalizedRuntimeTopology(coreRoot, packagesByRoot, resolutions);
  for (const instance of topology.instances) {
    closure.update(
      `instance\0${instance.locator}\0${instance.identity.name}\0${instance.identity.version}\0` +
        `${instance.identity.contentSha256}\0${instance.identity.fileCount}\0`,
      "utf8",
    );
  }
  for (const resolution of topology.resolutions) {
    closure.update(
      `resolution\0${resolution.parentLocator}\0${resolution.dependency}\0${resolution.packageLocator}\0`,
      "utf8",
    );
  }
  return {
    ...core,
    closureSha256: digest(closure),
    nodeVersion: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    packages,
    executables,
    files,
    directories,
    resolutions,
  };
}

interface NormalizedRuntimeTopology {
  instances: Array<{ locator: string; identity: RuntimePackageIdentity }>;
  resolutions: Array<{
    parentLocator: string;
    dependency: string;
    packageLocator: string;
  }>;
}

/**
 * Give every installed package instance a shortest dependency-path locator rooted at Core.
 * Paths on disk never enter the closure digest, while duplicate byte-identical instances remain
 * distinguishable whenever they occupy different positions in the executable resolution graph.
 */
function normalizedRuntimeTopology(
  coreRoot: string,
  packagesByRoot: ReadonlyMap<string, RuntimePackageIdentity>,
  resolutions: readonly RuntimeDependencyResolutionIdentity[],
): NormalizedRuntimeTopology {
  interface Location {
    segments: readonly string[];
    locator: string;
  }
  const outgoing = new Map<string, RuntimeDependencyResolutionIdentity[]>();
  for (const resolution of resolutions) {
    const values = outgoing.get(resolution.parentPackageRoot) ?? [];
    values.push(resolution);
    outgoing.set(resolution.parentPackageRoot, values);
  }
  for (const values of outgoing.values()) {
    values.sort(
      (left, right) =>
        compareUtf8(left.dependency, right.dependency) ||
        compareUtf8(left.packageRoot, right.packageRoot),
    );
  }

  const locations = new Map<string, Location>();
  const frontier: Array<{ root: string; location: Location }> = [
    {
      root: coreRoot,
      location: { segments: [], locator: "root" },
    },
  ];
  locations.set(coreRoot, frontier[0]!.location);
  while (frontier.length > 0) {
    frontier.sort(
      (left, right) =>
        left.location.segments.length - right.location.segments.length ||
        compareUtf8(left.location.locator, right.location.locator),
    );
    const current = frontier.shift()!;
    if (locations.get(current.root)?.locator !== current.location.locator) continue;
    for (const edge of outgoing.get(current.root) ?? []) {
      const segments = [...current.location.segments, edge.dependency];
      const candidate: Location = {
        segments,
        locator: runtimeTopologyLocator(segments),
      };
      const existing = locations.get(edge.packageRoot);
      if (
        existing !== undefined &&
        (existing.segments.length < candidate.segments.length ||
          (existing.segments.length === candidate.segments.length &&
            compareUtf8(existing.locator, candidate.locator) <= 0))
      ) {
        continue;
      }
      locations.set(edge.packageRoot, candidate);
      frontier.push({ root: edge.packageRoot, location: candidate });
    }
  }

  if (locations.size !== packagesByRoot.size) {
    throw new RuntimeIdentityError(
      "runtime_resolution_topology",
      "runtime closure contains a package outside Core's normalized dependency graph",
    );
  }
  const instances = [...packagesByRoot]
    .map(([root, identity]) => {
      const location = locations.get(root);
      if (location === undefined) {
        throw new RuntimeIdentityError(
          "runtime_resolution_topology",
          `runtime package is unreachable: ${identity.name}`,
        );
      }
      return { locator: location.locator, identity };
    })
    .sort((left, right) => compareUtf8(left.locator, right.locator));
  const normalizedResolutions = resolutions
    .map((resolution) => {
      const parent = locations.get(resolution.parentPackageRoot);
      const target = locations.get(resolution.packageRoot);
      if (parent === undefined || target === undefined) {
        throw new RuntimeIdentityError(
          "runtime_resolution_topology",
          "runtime resolution has an unreachable endpoint",
        );
      }
      return {
        parentLocator: parent.locator,
        dependency: resolution.dependency,
        packageLocator: target.locator,
      };
    })
    .sort(
      (left, right) =>
        compareUtf8(left.parentLocator, right.parentLocator) ||
        compareUtf8(left.dependency, right.dependency) ||
        compareUtf8(left.packageLocator, right.packageLocator),
    );
  return { instances, resolutions: normalizedResolutions };
}

function runtimeTopologyLocator(segments: readonly string[]): string {
  return segments.length === 0
    ? "root"
    : `root/${segments.map((segment) => Buffer.from(segment, "utf8").toString("base64url")).join("/")}`;
}

/** Re-hash the complete closure immediately before a provider-capable child is admitted. */
export async function assertRuntimeClosureCurrent(expected: RuntimeClosureIdentity): Promise<void> {
  await mapLimit(expected.executables, 3, async (executable) => {
    try {
      await assertRuntimeExecutableCurrent(executable);
    } catch (error) {
      throw runtimeChanged(error instanceof Error ? error.message : String(error));
    }
  });
  await assertRuntimeDirectoriesCurrent(expected.directories);
  await mapLimit(expected.files, 128, assertRuntimeFileCurrent);
}

export function runtimeExecutable(
  identity: RuntimeClosureIdentity,
  role: RuntimeExecutableIdentity["role"],
): RuntimeExecutableIdentity {
  const executable = identity.executables.find((candidate) => candidate.role === role);
  if (executable === undefined) {
    throw new RuntimeIdentityError(
      "runtime_executable_missing",
      `runtime closure has no ${role} executable`,
    );
  }
  return executable;
}

/** Child-side defense: verify the parent's immutable pin before importing Pi. */
export async function assertRuntimeClosureFromEnvironment(
  anchorUrl: string | URL = import.meta.url,
): Promise<RuntimeClosureIdentity> {
  const expectedClosure = process.env[KONI_RUNTIME_CLOSURE_ENV];
  const pinPath = process.env[KONI_RUNTIME_PIN_PATH_ENV];
  const expectedPin = process.env[KONI_RUNTIME_PIN_SHA256_ENV];
  if (!isSha256Digest(expectedClosure) || !isSha256Digest(expectedPin) || pinPath === undefined) {
    throw new RuntimeIdentityError(
      "runtime_closure_unbound",
      "contained Pi child has no valid authority-issued runtime closure identity",
    );
  }
  const bytes = await readBoundedFile(pinPath, MAX_RUNTIME_PIN_BYTES);
  if (sha256(bytes) !== expectedPin) {
    throw new RuntimeIdentityError(
      "runtime_pin_changed",
      "contained Pi child refused a changed runtime pin manifest",
    );
  }
  const identity = parseRuntimeClosureIdentity(bytes);
  if (identity.closureSha256 !== expectedClosure) {
    throw new RuntimeIdentityError(
      "runtime_pin_identity",
      "runtime pin does not match the authority closure",
    );
  }
  await assertRuntimeStageCurrent(pinPath, expectedPin, identity, anchorUrl);
  return identity;
}

/**
 * Verify the immutable, content-addressed mirror created by the first-byte Pi preload.
 *
 * The child deliberately does not re-check original package paths here: doing so would restore the
 * verify-to-import race that staging removes and would make an already authenticated generation
 * unusable merely because an installer replaced the mutable package tree.
 */
export async function assertRuntimeStageCurrent(
  pinPath: string,
  pinSha256: Sha256Digest,
  identity: RuntimeClosureIdentity,
  anchorUrl: string | URL = import.meta.url,
): Promise<void> {
  const stageRoot = runtimeStageRoot(pinPath, pinSha256);
  const stage = await lstat(stageRoot).catch(() => undefined);
  if (
    stage === undefined ||
    !stage.isDirectory() ||
    stage.isSymbolicLink() ||
    (stage.mode & 0o777) !== 0o500
  ) {
    throw new RuntimeIdentityError(
      "runtime_stage_missing",
      "contained Pi runtime stage is missing or unsafe",
    );
  }
  const canonicalStage = await realpath(stageRoot);
  if (canonicalStage !== stageRoot) {
    throw new RuntimeIdentityError(
      "runtime_stage_path",
      "contained Pi runtime stage is not canonical",
    );
  }
  await assertStagedDirectoryModes(stageRoot);
  const anchor = await realpath(fileURLToPath(anchorUrl));
  if (!isPathWithin(stageRoot, anchor)) {
    throw new RuntimeIdentityError(
      "runtime_stage_entry",
      "contained Pi verifier did not execute from the authenticated runtime stage",
    );
  }

  const sealPath = path.join(stageRoot, ".koni-runtime-stage.json");
  const sealMetadata = await lstat(sealPath).catch(() => undefined);
  if (
    sealMetadata === undefined ||
    !sealMetadata.isFile() ||
    sealMetadata.isSymbolicLink() ||
    sealMetadata.size > 16 * 1024 ||
    (sealMetadata.mode & 0o777) !== 0o400
  ) {
    throw new RuntimeIdentityError(
      "runtime_stage_seal",
      "contained Pi runtime stage seal is unsafe",
    );
  }
  const sealBytes = await readBoundedRegularFile(sealPath, sealMetadata.size);
  let seal: unknown;
  try {
    seal = JSON.parse(sealBytes.toString("utf8"));
  } catch {
    throw new RuntimeIdentityError(
      "runtime_stage_seal",
      "contained Pi runtime stage seal is invalid JSON",
    );
  }
  if (
    !isRecord(seal) ||
    seal.protocol !== KONI_RUNTIME_STAGE_PROTOCOL ||
    seal.pinSha256 !== pinSha256 ||
    seal.closureSha256 !== identity.closureSha256 ||
    seal.fileCount !== identity.files.length ||
    seal.directoryCount !== identity.directories.length ||
    seal.resolutionCount !== identity.resolutions.length
  ) {
    throw new RuntimeIdentityError(
      "runtime_stage_seal",
      "contained Pi runtime stage seal is not authority-bound",
    );
  }

  await mapLimit(identity.directories, 64, async (directory) => {
    const staged = stagedRuntimePath(stageRoot, directory.path);
    const metadata = await lstat(staged).catch(() => undefined);
    if (
      metadata === undefined ||
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== 0o500
    ) {
      throw new RuntimeIdentityError(
        "runtime_stage_directory",
        `staged runtime directory is unsafe: ${directory.path}`,
      );
    }
  });
  await mapLimit(identity.files, 128, async (file) => {
    const staged = stagedRuntimePath(stageRoot, file.path);
    if (file.kind === "symlink") {
      const metadata = await lstat(staged).catch(() => undefined);
      const expectedTarget = stagedSymlinkTarget(stageRoot, file.path, file.linkTarget!);
      if (
        metadata === undefined ||
        !metadata.isSymbolicLink() ||
        (await readlink(staged).catch(() => undefined)) !== expectedTarget
      ) {
        throw new RuntimeIdentityError(
          "runtime_stage_symlink",
          `staged runtime symlink changed: ${file.path}`,
        );
      }
      return;
    }
    const bytes = await readBoundedRegularFile(staged, file.size);
    if (file.contentSha256 === undefined || sha256(bytes) !== file.contentSha256) {
      throw new RuntimeIdentityError(
        "runtime_stage_file",
        `staged runtime bytes changed: ${file.path}`,
      );
    }
  });
  await mapLimit(identity.resolutions, 128, async (resolution) => {
    const link = stagedDependencyLink(stageRoot, resolution);
    const packageRoot = stagedRuntimePath(stageRoot, resolution.packageRoot);
    if (path.normalize(link) === path.normalize(packageRoot)) {
      const metadata = await lstat(packageRoot).catch(() => undefined);
      if (
        metadata === undefined ||
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o777) !== 0o500
      ) {
        throw new RuntimeIdentityError(
          "runtime_stage_resolution",
          `staged runtime dependency root changed: ${resolution.dependency}`,
        );
      }
      return;
    }
    const expectedTarget = path.relative(path.dirname(link), packageRoot);
    const metadata = await lstat(link).catch(() => undefined);
    if (
      metadata === undefined ||
      !metadata.isSymbolicLink() ||
      (await readlink(link).catch(() => undefined)) !== expectedTarget
    ) {
      throw new RuntimeIdentityError(
        "runtime_stage_resolution",
        `staged runtime dependency resolution changed: ${resolution.dependency}`,
      );
    }
  });
}

/** Deterministic stage locator shared with the standalone first-byte loader. */
export function runtimeStageRoot(pinPath: string, pinSha256: Sha256Digest): string {
  if (!path.isAbsolute(pinPath) || !isSha256Digest(pinSha256)) {
    throw new RuntimeIdentityError("runtime_stage_binding", "runtime stage binding is invalid");
  }
  return path.join(
    path.dirname(path.dirname(pinPath)),
    "runtime-stages",
    pinSha256.slice("sha256:".length),
  );
}

/** Mirror one absolute runtime path without retaining any reference to its mutable root. */
export function stagedRuntimePath(stageRoot: string, originalPath: string): string {
  if (!path.isAbsolute(stageRoot) || !path.isAbsolute(originalPath)) {
    throw new RuntimeIdentityError("runtime_stage_path", "runtime stage paths must be absolute");
  }
  const parsed = path.parse(originalPath);
  const rootKey = Buffer.from(parsed.root, "utf8").toString("base64url");
  const relative = path.relative(parsed.root, originalPath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new RuntimeIdentityError(
      "runtime_stage_path",
      `cannot mirror runtime path ${originalPath}`,
    );
  }
  return path.join(stageRoot, "fs", rootKey, relative);
}

/** Persist the content-hashed closure pin beneath authority-owned state for child verification. */
export async function persistRuntimeClosurePin(
  stateRoot: string,
  identity: RuntimeClosureIdentity,
): Promise<RuntimeClosurePinReference> {
  const requestedDirectory = path.join(stateRoot, "authority", "runtime-pins");
  await mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
  const directory = await realpath(requestedDirectory);
  const bytes = Buffer.from(`${JSON.stringify(identity)}\n`, "utf8");
  if (bytes.byteLength > MAX_RUNTIME_PIN_BYTES) {
    throw new RuntimeIdentityError(
      "runtime_pin_size",
      "runtime pin manifest exceeds its byte bound",
    );
  }
  const pinSha256 = sha256(bytes);
  const target = path.join(directory, `${pinSha256.slice("sha256:".length)}.json`);
  try {
    const existing = await readBoundedFile(target, MAX_RUNTIME_PIN_BYTES);
    if (sha256(existing) !== pinSha256) {
      throw new RuntimeIdentityError(
        "runtime_pin_collision",
        "runtime pin path contains different bytes",
      );
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return { path: target, pinSha256, closureSha256: identity.closureSha256 };
}

interface PackageManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

async function captureAuthorityExecutables(): Promise<RuntimeExecutableIdentity[]> {
  const executables: RuntimeExecutableIdentity[] = [
    await captureRuntimeExecutable("node", process.execPath),
    await resolveRuntimeExecutable("git", "git", process.env.PATH),
  ];
  if (process.platform === "darwin") {
    executables.push(
      await captureRuntimeExecutable("sandbox", "/usr/bin/sandbox-exec", {
        requireRootOwned: true,
      }),
    );
  } else if (process.platform === "linux") {
    executables.push(
      await resolveRuntimeExecutable("sandbox", "bwrap", process.env.PATH, {
        requireRootOwned: true,
      }),
    );
  }
  return executables.sort((left, right) => compareUtf8(left.role, right.role));
}

async function findPackageRoot(start: string, expectedName: string): Promise<string> {
  let current = path.dirname(start);
  for (;;) {
    try {
      const manifest = await readPackageManifest(current);
      if (manifest.name === expectedName) return current;
    } catch (error) {
      if (!(error instanceof RuntimeIdentityError && error.code === "runtime_package_manifest"))
        throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new RuntimeIdentityError(
    "core_package_root",
    `cannot locate ${expectedName} from ${start}`,
  );
}

async function readPackageManifest(
  packageRoot: string,
  expectedName?: string,
): Promise<PackageManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  } catch {
    throw new RuntimeIdentityError(
      "runtime_package_manifest",
      `cannot read ${packageRoot}/package.json`,
    );
  }
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.version !== "string" ||
    (expectedName !== undefined && value.name !== expectedName)
  ) {
    throw new RuntimeIdentityError(
      "runtime_package_manifest",
      `invalid package identity at ${packageRoot}`,
    );
  }
  return value as unknown as PackageManifest;
}

async function resolveDependencyPackageRoot(
  parentPackageRoot: string,
  dependency: string,
  explicitPiPackageRoot?: string,
): Promise<string | undefined> {
  const local = await resolveDependencyFromAncestors(parentPackageRoot, dependency);
  if (local !== undefined) return local;
  const piRootValue = explicitPiPackageRoot ?? process.env[KONI_PI_PACKAGE_ROOT_ENV];
  if (piRootValue === undefined) return undefined;
  const piRoot = await realpath(piRootValue).catch(() => undefined);
  if (piRoot === undefined) return undefined;
  if (dependency === "@earendil-works/pi-coding-agent") {
    const manifest = await readPackageManifest(piRoot);
    return manifest.name === dependency ? piRoot : undefined;
  }
  if (piRoot === parentPackageRoot) return undefined;
  return resolveDependencyFromAncestors(piRoot, dependency);
}

async function resolveDependencyFromAncestors(
  parentPackageRoot: string,
  dependency: string,
): Promise<string | undefined> {
  const segments = dependency.startsWith("@") ? dependency.split("/") : [dependency];
  let current = parentPackageRoot;
  for (;;) {
    const candidate = path.join(current, "node_modules", ...segments);
    try {
      const canonical = await realpath(candidate);
      const manifest = await readPackageManifest(canonical);
      if (manifest.name !== dependency) {
        throw new RuntimeIdentityError(
          "runtime_dependency_identity",
          `${dependency} resolved to package ${manifest.name}`,
        );
      }
      return canonical;
    } catch (error) {
      if (
        !isMissing(error) &&
        !(error instanceof RuntimeIdentityError && error.code === "runtime_package_manifest")
      ) {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function hashCorePackageContent(
  packageRoot: string,
  anchor: string,
  files: RuntimeFileIdentity[],
  directories: RuntimeDirectoryIdentity[],
): Promise<{ sha256: Sha256Digest; fileCount: number }> {
  const relativeAnchor = path.relative(packageRoot, anchor).split(path.sep);
  const runtimeDirectoryName = relativeAnchor[0];
  if (runtimeDirectoryName !== "src" && runtimeDirectoryName !== "dist") {
    throw new RuntimeIdentityError(
      "core_runtime_root",
      "cannot identify the active Core runtime directory",
    );
  }
  const hash = createHash("sha256");
  hash.update(`${CORE_PACKAGE}\0`, "utf8");
  await hashFileInto(hash, path.join(packageRoot, "package.json"), "package.json", files);
  const tree = await hashTree(
    path.join(packageRoot, runtimeDirectoryName),
    runtimeDirectoryName,
    hash,
    new Set(),
    files,
    directories,
  );
  const bin = await hashOptionalTree(
    path.join(packageRoot, "bin"),
    "bin",
    hash,
    files,
    directories,
  );
  return { sha256: digest(hash), fileCount: tree.fileCount + bin.fileCount + 1 };
}

async function hashPackageContent(
  packageRoot: string,
  files: RuntimeFileIdentity[],
  directories: RuntimeDirectoryIdentity[],
): Promise<{ sha256: Sha256Digest; fileCount: number }> {
  const hash = createHash("sha256");
  const tree = await hashTree(
    packageRoot,
    "",
    hash,
    new Set(["node_modules", ".git"]),
    files,
    directories,
  );
  return { sha256: digest(hash), fileCount: tree.fileCount };
}

async function hashTree(
  root: string,
  logicalRoot: string,
  hash: ReturnType<typeof createHash>,
  excludedDirectories = new Set<string>(),
  files?: RuntimeFileIdentity[],
  directories?: RuntimeDirectoryIdentity[],
): Promise<{ fileCount: number }> {
  let fileCount = 0;
  const visit = async (directory: string, logicalDirectory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    if (directories !== undefined) {
      directories.push({
        path: directory,
        inventorySha256: directoryInventorySha256(entries),
      });
    }
    for (const entry of entries) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const logical =
        logicalDirectory.length === 0 ? entry.name : `${logicalDirectory}/${entry.name}`;
      const metadata = await lstat(absolute);
      if (metadata.isDirectory()) {
        hash.update(`directory\0${logical}\0`, "utf8");
        await visit(absolute, logical);
      } else if (metadata.isFile()) {
        await hashFileInto(hash, absolute, logical, files, metadata);
        fileCount += 1;
      } else if (metadata.isSymbolicLink()) {
        const linkTarget = await readlink(absolute);
        hash.update(`symlink\0${logical}\0${linkTarget}\0`, "utf8");
        files?.push(runtimeFileIdentity(absolute, metadata, "symlink", linkTarget));
        fileCount += 1;
      } else {
        throw new RuntimeIdentityError(
          "runtime_file_type",
          `runtime closure contains unsupported file type: ${absolute}`,
        );
      }
    }
  };
  await visit(root, logicalRoot);
  return { fileCount };
}

async function hashOptionalTree(
  root: string,
  logicalRoot: string,
  hash: ReturnType<typeof createHash>,
  files?: RuntimeFileIdentity[],
  directories?: RuntimeDirectoryIdentity[],
): Promise<{ fileCount: number }> {
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new RuntimeIdentityError(
        "runtime_file_type",
        `runtime path is not a real directory: ${root}`,
      );
    }
  } catch (error) {
    if (isMissing(error)) return { fileCount: 0 };
    throw error;
  }
  return hashTree(root, logicalRoot, hash, new Set(), files, directories);
}

async function hashFileInto(
  hash: ReturnType<typeof createHash>,
  absolute: string,
  logical: string,
  files?: RuntimeFileIdentity[],
  knownMetadata?: Stats,
): Promise<void> {
  const pathMetadata = knownMetadata ?? (await lstat(absolute));
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    throw new RuntimeIdentityError(
      "runtime_file_type",
      `runtime file is not a regular file: ${absolute}`,
    );
  }
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  let metadata: Stats;
  let bytes: Buffer;
  try {
    metadata = await handle.stat();
    if (!sameFileIdentity(pathMetadata, metadata) || !metadata.isFile()) {
      throw runtimeChanged(`runtime file changed while opening: ${absolute}`);
    }
    bytes = await handle.readFile();
    const afterHandle = await handle.stat();
    const afterPath = await lstat(absolute);
    if (!sameFileIdentity(metadata, afterHandle) || !sameFileIdentity(metadata, afterPath)) {
      throw runtimeChanged(`runtime file changed while hashing: ${absolute}`);
    }
  } finally {
    await handle.close();
  }
  hash.update(`file\0${logical}\0${metadata.size}\0`, "utf8");
  hash.update(
    logical === "dist/runtime/identity.js" ? normalizeEmbeddedCoreBuildIdentity(bytes) : bytes,
  );
  hash.update("\0", "utf8");
  files?.push(runtimeFileIdentity(absolute, metadata, "file", undefined, sha256(bytes)));
}

function normalizeEmbeddedCoreBuildIdentity(bytes: Buffer): Buffer {
  const text = bytes.toString("utf8");
  const pattern = /export const KONI_EMBEDDED_CORE_BUILD_SHA256 =\s*"sha256:[0-9a-f]{64}";/gu;
  const matches = text.match(pattern);
  if (matches?.length !== 1) {
    throw new RuntimeIdentityError(
      "core_build_identity_marker",
      "compiled Koni Core identity module has an invalid embedded-build marker",
    );
  }
  return Buffer.from(
    text.replace(
      pattern,
      `export const KONI_EMBEDDED_CORE_BUILD_SHA256 = "${CORE_BUILD_IDENTITY_PLACEHOLDER}";`,
    ),
    "utf8",
  );
}

function runtimeDirectoryName(anchorUrl: string | URL): string {
  const anchor = fileURLToPath(anchorUrl);
  return path.basename(path.dirname(path.dirname(anchor)));
}

function runtimeFileIdentity(
  absolute: string,
  metadata: Stats,
  kind: RuntimeFileIdentity["kind"],
  linkTarget?: string,
  contentSha256?: Sha256Digest,
): RuntimeFileIdentity {
  const precise = metadata as typeof metadata & {
    atimeNs?: bigint;
    mtimeNs?: bigint;
    ctimeNs?: bigint;
  };
  return {
    path: absolute,
    kind,
    size: metadata.size,
    device: String(metadata.dev),
    inode: String(metadata.ino),
    mode: metadata.mode,
    modifiedNs: precise.mtimeNs?.toString() ?? String(Math.trunc(metadata.mtimeMs * 1_000_000)),
    changedNs: precise.ctimeNs?.toString() ?? String(Math.trunc(metadata.ctimeMs * 1_000_000)),
    ...(contentSha256 === undefined ? {} : { contentSha256 }),
    ...(linkTarget === undefined ? {} : { linkTarget }),
  };
}

async function assertRuntimeDirectoriesCurrent(
  directories: readonly RuntimeDirectoryIdentity[],
): Promise<void> {
  await mapLimit(directories, 64, async (expected) => {
    let entries;
    try {
      entries = await readdir(expected.path, { withFileTypes: true });
    } catch {
      throw runtimeChanged(`runtime directory disappeared: ${expected.path}`);
    }
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    if (directoryInventorySha256(entries) !== expected.inventorySha256) {
      throw runtimeChanged(`runtime directory inventory changed: ${expected.path}`);
    }
  });
}

async function assertRuntimeFileCurrent(expected: RuntimeFileIdentity): Promise<void> {
  if (expected.kind === "file") {
    const bytes = await readAuthenticatedRuntimeFile(expected);
    if (expected.contentSha256 === undefined || sha256(bytes) !== expected.contentSha256) {
      throw runtimeChanged(`runtime file bytes changed: ${expected.path}`);
    }
    return;
  }
  let metadata;
  try {
    metadata = await lstat(expected.path);
  } catch {
    throw runtimeChanged(`runtime file disappeared: ${expected.path}`);
  }
  const current = runtimeFileIdentity(
    expected.path,
    metadata,
    metadata.isSymbolicLink() ? "symlink" : "file",
    metadata.isSymbolicLink() ? await readlink(expected.path) : undefined,
  );
  if (
    current.kind !== expected.kind ||
    current.size !== expected.size ||
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    current.mode !== expected.mode ||
    current.modifiedNs !== expected.modifiedNs ||
    current.changedNs !== expected.changedNs ||
    current.contentSha256 !== expected.contentSha256 ||
    current.linkTarget !== expected.linkTarget
  ) {
    throw runtimeChanged(`runtime file identity changed: ${expected.path}`);
  }
}

function directoryInventorySha256(
  entries: readonly {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }[],
): Sha256Digest {
  const hash = createHash("sha256");
  for (const entry of entries) {
    const kind = entry.isDirectory()
      ? "directory"
      : entry.isFile()
        ? "file"
        : entry.isSymbolicLink()
          ? "symlink"
          : "other";
    hash.update(`${kind}\0${entry.name}\0`, "utf8");
  }
  return digest(hash);
}

function runtimeChanged(detail: string): RuntimeIdentityError {
  return new RuntimeIdentityError(
    "runtime_closure_changed",
    [
      "Koni's executable runtime changed while this authority was running.",
      detail,
      "The run was preserved without starting another agent; restart the Koni authority, then resume it.",
    ].join(" "),
  );
}

async function mapLimit<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      await operation(values[index]!);
    }
  });
  await Promise.all(workers);
}

function parseRuntimeClosureIdentity(bytes: Buffer): RuntimeClosureIdentity {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new RuntimeIdentityError("runtime_pin_json", "runtime pin is not valid JSON");
  }
  if (
    !isRecord(value) ||
    value.protocol !== KONI_RUNTIME_IDENTITY_PROTOCOL ||
    value.packageName !== CORE_PACKAGE ||
    typeof value.packageVersion !== "string" ||
    !isSha256Digest(value.buildSha256) ||
    !isSha256Digest(value.closureSha256) ||
    value.nodeVersion !== process.versions.node ||
    value.platform !== process.platform ||
    value.architecture !== process.arch ||
    !Array.isArray(value.packages) ||
    !Array.isArray(value.executables) ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.directories) ||
    !Array.isArray(value.resolutions) ||
    value.packages.length > MAX_RUNTIME_PACKAGES ||
    value.executables.length > 3 ||
    value.files.length > MAX_RUNTIME_FILES ||
    value.directories.length > MAX_RUNTIME_DIRECTORIES ||
    value.resolutions.length > MAX_RUNTIME_RESOLUTIONS ||
    !value.files.every(isRuntimeFileIdentity) ||
    !value.executables.every(isRuntimeExecutableIdentity) ||
    !value.directories.every(isRuntimeDirectoryIdentity) ||
    !value.resolutions.every(isRuntimeDependencyResolutionIdentity)
  ) {
    throw new RuntimeIdentityError(
      "runtime_pin_shape",
      "runtime pin has an invalid or incompatible shape",
    );
  }
  const executableRoles = value.executables.map((entry) => entry.role);
  if (
    new Set(executableRoles).size !== executableRoles.length ||
    !executableRoles.includes("node") ||
    !executableRoles.includes("git") ||
    ((process.platform === "darwin" || process.platform === "linux") &&
      !executableRoles.includes("sandbox"))
  ) {
    throw new RuntimeIdentityError(
      "runtime_pin_shape",
      "runtime pin executable closure is incomplete",
    );
  }
  const resolutionKeys = value.resolutions.map(
    (entry) => `${entry.parentPackageRoot}\0${entry.dependency}`,
  );
  if (new Set(resolutionKeys).size !== resolutionKeys.length) {
    throw new RuntimeIdentityError(
      "runtime_pin_shape",
      "runtime pin dependency resolutions are ambiguous",
    );
  }
  return value as unknown as RuntimeClosureIdentity;
}

function isRuntimeFileIdentity(value: unknown): value is RuntimeFileIdentity {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    path.isAbsolute(value.path) &&
    (value.kind === "file" || value.kind === "symlink") &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    typeof value.device === "string" &&
    typeof value.inode === "string" &&
    typeof value.mode === "number" &&
    Number.isSafeInteger(value.mode) &&
    typeof value.modifiedNs === "string" &&
    typeof value.changedNs === "string" &&
    (value.kind === "file"
      ? isSha256Digest(value.contentSha256)
      : value.contentSha256 === undefined) &&
    (value.linkTarget === undefined || typeof value.linkTarget === "string")
  );
}

function isRuntimeDirectoryIdentity(value: unknown): value is RuntimeDirectoryIdentity {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    path.isAbsolute(value.path) &&
    isSha256Digest(value.inventorySha256)
  );
}

function isRuntimeDependencyResolutionIdentity(
  value: unknown,
): value is RuntimeDependencyResolutionIdentity {
  return (
    isRecord(value) &&
    typeof value.parentPackageRoot === "string" &&
    path.isAbsolute(value.parentPackageRoot) &&
    typeof value.packageRoot === "string" &&
    path.isAbsolute(value.packageRoot) &&
    typeof value.dependency === "string" &&
    isPackageName(value.dependency)
  );
}

async function readBoundedFile(filePath: string, maximum: number): Promise<Buffer> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximum) {
      throw new RuntimeIdentityError("runtime_pin_file", "runtime pin is not a safe bounded file");
    }
    const bytes = await handle.readFile();
    const after = await lstat(filePath);
    if (!sameFileIdentity(metadata, after)) {
      throw new RuntimeIdentityError("runtime_pin_file", "runtime pin changed while it was read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readBoundedRegularFile(filePath: string, expectedSize: number): Promise<Buffer> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== expectedSize || (metadata.mode & 0o777) !== 0o400) {
      throw new RuntimeIdentityError(
        "runtime_stage_file",
        `staged runtime file is unsafe: ${filePath}`,
      );
    }
    const bytes = await handle.readFile();
    const after = await lstat(filePath);
    if (!sameFileIdentity(metadata, after)) {
      throw new RuntimeIdentityError(
        "runtime_stage_file",
        `staged runtime file changed while read: ${filePath}`,
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readAuthenticatedRuntimeFile(expected: RuntimeFileIdentity): Promise<Buffer> {
  const handle = await open(expected.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    () => undefined,
  );
  if (handle === undefined) throw runtimeChanged(`runtime file disappeared: ${expected.path}`);
  try {
    const metadata = await handle.stat();
    const current = runtimeFileIdentity(
      expected.path,
      metadata,
      "file",
      undefined,
      expected.contentSha256,
    );
    if (!sameRuntimeFileIdentity(current, expected)) {
      throw runtimeChanged(`runtime file identity changed: ${expected.path}`);
    }
    const bytes = await handle.readFile();
    const afterHandle = await handle.stat();
    const afterPath = await lstat(expected.path).catch(() => undefined);
    if (
      afterPath === undefined ||
      !sameFileIdentity(metadata, afterHandle) ||
      !sameFileIdentity(metadata, afterPath)
    ) {
      throw runtimeChanged(`runtime file changed while checking: ${expected.path}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function sameRuntimeFileIdentity(left: RuntimeFileIdentity, right: RuntimeFileIdentity): boolean {
  return (
    left.path === right.path &&
    left.kind === right.kind &&
    left.size === right.size &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.modifiedNs === right.modifiedNs &&
    left.changedNs === right.changedNs &&
    left.contentSha256 === right.contentSha256 &&
    left.linkTarget === right.linkTarget
  );
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function stagedSymlinkTarget(stageRoot: string, originalPath: string, linkTarget: string): string {
  const originalTarget = path.resolve(path.dirname(originalPath), linkTarget);
  return path.relative(
    path.dirname(stagedRuntimePath(stageRoot, originalPath)),
    stagedRuntimePath(stageRoot, originalTarget),
  );
}

function stagedDependencyLink(
  stageRoot: string,
  resolution: RuntimeDependencyResolutionIdentity,
): string {
  return path.join(
    stagedRuntimePath(stageRoot, resolution.parentPackageRoot),
    "node_modules",
    ...resolution.dependency.split("/"),
  );
}

async function assertStagedDirectoryModes(directory: string): Promise<void> {
  const metadata = await lstat(directory).catch(() => undefined);
  if (
    metadata === undefined ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o500
  ) {
    throw new RuntimeIdentityError(
      "runtime_stage_directory",
      `staged runtime directory is writable or unsafe: ${directory}`,
    );
  }
  const entries = await readdir(directory, { withFileTypes: true });
  await mapLimit(
    entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()),
    32,
    async (entry) => assertStagedDirectoryModes(path.join(directory, entry.name)),
  );
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function sha256(bytes: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digest(hash: ReturnType<typeof createHash>): Sha256Digest {
  return `sha256:${hash.digest("hex")}`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isPackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u.test(value);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
