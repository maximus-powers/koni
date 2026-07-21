import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  constants,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { rcompare, satisfies, valid, validRange } from "semver";
import { parse as parseYaml } from "yaml";
import type { ResolvedAgentCheckCommand } from "./run-engine.js";
import { canonicalHash, rawSha256, type Sha256Digest } from "../shared/canonical.js";
import {
  assertRuntimeExecutableCurrent,
  captureRuntimeExecutable,
  resolveRuntimeExecutable,
  type RuntimeExecutableIdentity,
} from "../runtime/executable.js";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_ARG_BYTES = 1024 * 1024;
const TERMINATE_GRACE_MS = 2_000;
const MAX_MANIFEST_FILES = 100_000;
const MAX_MANIFEST_BYTES = 1024 * 1024 * 1024;

export interface ContainedProcessResult {
  resolvedExecutable: string;
  argv: string[];
  environmentSha256: Sha256Digest;
  exitCode: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: Buffer;
  sandbox: {
    kind: string;
    profileSha256: Sha256Digest;
    executableSha256: Sha256Digest;
  };
}

export interface ContainedProcessOptions {
  projectRoot: string;
  stateRoot: string;
  check: ResolvedAgentCheckCommand;
  readPaths: readonly string[];
  writePaths: readonly string[];
  signal?: AbortSignal;
  now?: () => number;
  /** Authority-startup authenticated sandbox launcher. */
  sandboxExecutable?: RuntimeExecutableIdentity;
}

export class ContainedProcessError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ContainedProcessError";
    this.code = code;
  }
}

export interface ContainedPathManifest {
  protocol: "koni.contained-path-manifest.v1";
  roots: string[];
  entries: Array<{
    path: string;
    kind: "file" | "directory" | "missing";
    mode?: number;
    sizeBytes?: number;
    sha256?: Sha256Digest;
  }>;
  manifestSha256: Sha256Digest;
}

/**
 * Capture the exact non-symlink workspace inputs/outputs around one configured command. Authority
 * metadata and ambient dependency caches are excluded from a root-wide scan, but are included when
 * a compiler explicitly names them (and should normally be rejected before reaching this helper).
 */
export async function snapshotContainedPaths(
  projectRootInput: string,
  rootsInput: readonly string[],
): Promise<ContainedPathManifest> {
  const projectRoot = await canonicalDirectory(projectRootInput, "project root");
  const roots = [...new Set(rootsInput.length === 0 ? ["."] : rootsInput)].sort();
  const entries: ContainedPathManifest["entries"] = [];
  let totalBytes = 0;
  const add = (entry: ContainedPathManifest["entries"][number]) => {
    entries.push(entry);
    if (entries.length > MAX_MANIFEST_FILES) {
      throw new ContainedProcessError("manifest_limit", "configured check manifest contains too many files");
    }
    totalBytes += entry.sizeBytes ?? 0;
    if (totalBytes > MAX_MANIFEST_BYTES) {
      throw new ContainedProcessError("manifest_limit", "configured check manifest contains too many bytes");
    }
  };
  const walk = async (relative: string, skipIgnoredDependencies: boolean): Promise<void> => {
    const absolute = relative === "." ? projectRoot : path.resolve(projectRoot, relative);
    if (absolute !== projectRoot && !absolute.startsWith(`${projectRoot}${path.sep}`)) {
      throw new ContainedProcessError("manifest_path", `manifest path escapes the worktree: ${relative}`);
    }
    const metadata = await lstat(absolute).catch((error: unknown) => {
      if (isMissingPathError(error)) return undefined;
      throw error;
    });
    if (metadata === undefined) {
      add({ path: relative, kind: "missing" });
      return;
    }
    if (metadata.isSymbolicLink()) {
      throw new ContainedProcessError("manifest_symlink", `manifest path is a symbolic link: ${relative}`);
    }
    const canonical = await realpath(absolute);
    if (canonical !== projectRoot && !canonical.startsWith(`${projectRoot}${path.sep}`)) {
      throw new ContainedProcessError("manifest_path", `manifest path resolves outside the worktree: ${relative}`);
    }
    if (metadata.isDirectory()) {
      add({ path: relative, kind: "directory", mode: metadata.mode & 0o7777 });
      const children = await readdir(absolute, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        if (child.name.includes("\0") || child.name.includes("/") || child.name.includes("\\")) {
          throw new ContainedProcessError("manifest_path", "manifest contains an unsafe directory entry");
        }
        if (skipIgnoredDependencies && [".git", ".koni", "node_modules"].includes(child.name)) {
          continue;
        }
        const childRelative = relative === "." ? child.name : `${relative}/${child.name}`;
        await walk(childRelative, skipIgnoredDependencies);
      }
      return;
    }
    if (!metadata.isFile()) {
      throw new ContainedProcessError("manifest_type", `manifest path is not a regular file: ${relative}`);
    }
    const bytes = await readFile(absolute);
    if (bytes.byteLength !== metadata.size) {
      throw new ContainedProcessError("manifest_race", `manifest path changed while hashing: ${relative}`);
    }
    add({
      path: relative,
      kind: "file",
      mode: metadata.mode & 0o7777,
      sizeBytes: bytes.byteLength,
      sha256: rawSha256(bytes),
    });
  };
  for (const root of roots) {
    validateRelativeGrant(root);
    await walk(root, root === ".");
  }
  entries.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
  const material = { protocol: "koni.contained-path-manifest.v1" as const, roots, entries };
  return { ...material, manifestSha256: canonicalHash(material) };
}

/**
 * Execute one compiler-resolved argv without a shell. On macOS the complete process group is
 * enclosed by Seatbelt; on Linux bwrap is required. Unsupported containment fails closed.
 */
export async function runContainedProcess(
  options: ContainedProcessOptions,
): Promise<ContainedProcessResult> {
  validateCheck(options.check);
  const projectRoot = await canonicalDirectory(options.projectRoot, "project root");
  const stateRoot = await canonicalDirectory(options.stateRoot, "state root");
  const cwd = await containedDirectory(projectRoot, options.check.cwd);
  const environment = resolveEnvironment(options.check.environment);
  const executable = await resolveExecutable(options.check.argv[0]!, cwd, environment.PATH);
  const semanticArgv = [executable, ...options.check.argv.slice(1)];
  const runtimeRoots = await resolveRuntimeReadRoots({
    projectRoot,
    stateRoot,
    cwd,
    executable,
    pathValue: environment.PATH,
    environment,
  });
  const scratch = await createScratch(projectRoot, stateRoot);
  try {
    const sandboxed = await sandboxCommand({
      projectRoot,
      stateRoot,
      cwd,
      semanticArgv,
      runtimeReadRoots: runtimeRoots.read,
      runtimeWriteRoots: runtimeRoots.write,
      scratch,
      readPaths: options.readPaths,
      writePaths: options.check.effect === "workspace_write" ? options.writePaths : [],
      networkAccess: options.check.networkAccess,
      sandboxExecutable: options.sandboxExecutable ?? await defaultSandboxExecutable(),
    });
    await assertRuntimeExecutableCurrent(sandboxed.executable);
    const result = await spawnBounded({
      argv: sandboxed.argv,
      cwd,
      env: { ...environment, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
      timeoutMs: options.check.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      executable: sandboxed.executable,
    });
    return {
      resolvedExecutable: executable,
      argv: semanticArgv,
      environmentSha256: canonicalHash(environment),
      ...result,
      sandbox: {
        kind: sandboxed.kind,
        profileSha256: sandboxed.profileSha256,
        executableSha256: sandboxed.executable.sha256,
      },
    };
  } finally {
    await safeRemoveScratch(scratch);
  }
}

function validateCheck(check: ResolvedAgentCheckCommand): void {
  if (
    check.checkId.length === 0 ||
    !/^sha256:[0-9a-f]{64}$/u.test(check.definitionHash) ||
    check.argv.length === 0 ||
    check.argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    Buffer.byteLength(JSON.stringify(check.argv), "utf8") > MAX_ARG_BYTES ||
    !Number.isSafeInteger(check.timeoutMs) ||
    check.timeoutMs < 1 ||
    check.timeoutMs > 24 * 60 * 60 * 1_000
  ) {
    throw new ContainedProcessError("check_contract", "configured check process contract is invalid");
  }
}

function resolveEnvironment(source: ResolvedAgentCheckCommand["environment"]): Record<string, string> {
  const output = Object.create(null) as Record<string, string>;
  for (const key of [...new Set(source.inherit)].sort()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new ContainedProcessError("environment", `unsafe inherited environment key ${key}`);
    }
    const value = process.env[key];
    if (value !== undefined) output[key] = boundedEnvironmentValue(key, value);
  }
  for (const [key, value] of Object.entries(source.set).sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new ContainedProcessError("environment", `unsafe configured environment key ${key}`);
    }
    output[key] = boundedEnvironmentValue(key, value);
  }
  return output;
}

function boundedEnvironmentValue(key: string, value: string): string {
  if (value.includes("\0") || Buffer.byteLength(value, "utf8") > 64 * 1024) {
    throw new ContainedProcessError("environment", `environment value ${key} is unsafe or oversized`);
  }
  return value;
}

async function resolveExecutable(command: string, cwd: string, pathValue: string | undefined): Promise<string> {
  const candidates = command.includes("/")
    ? [path.isAbsolute(command) ? command : path.resolve(cwd, command)]
    : (pathValue ?? "").split(path.delimiter).filter(Boolean).map((entry) => path.resolve(entry, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const resolved = await realpath(candidate);
      const metadata = await lstat(resolved);
      if (metadata.isFile() && !metadata.isSymbolicLink()) return resolved;
    } catch {
      // Keep searching the exact compiled PATH.
    }
  }
  throw new ContainedProcessError("executable", `configured executable is unavailable: ${command}`);
}

/**
 * Materialize only dependency-cache links that already exist in the repository's primary
 * checkout, then grant the configured process read-only access to its exact runtime closure.
 * Managed worktrees intentionally do not duplicate ignored dependency trees; without this seam a
 * repository-native test command resolves correctly but cannot load the dependencies it was
 * installed against. The links are derivable cache state, never Git/source evidence, and a
 * pre-existing path is reused only when it is the exact expected directory or link target.
 */
async function resolveRuntimeReadRoots(input: {
  projectRoot: string;
  stateRoot: string;
  cwd: string;
  executable: string;
  pathValue: string | undefined;
  environment: Record<string, string>;
}): Promise<{ read: string[]; write: string[] }> {
  const roots = new Set<string>();
  const writeRoots = new Set<string>();
  const addTo = async (target: Set<string>, candidate: string): Promise<void> => {
    const metadata = await lstat(candidate).catch((error: unknown) => {
      if (isMissingPathError(error)) return undefined;
      throw error;
    });
    if (metadata === undefined) return;
    const resolved = await realpath(candidate);
    const resolvedMetadata = await lstat(resolved);
    if (!resolvedMetadata.isDirectory() && !resolvedMetadata.isFile()) return;
    target.add(candidate);
    target.add(resolved);
  };
  const add = (candidate: string): Promise<void> => addTo(roots, candidate);
  const addWritable = (candidate: string): Promise<void> => addTo(writeRoots, candidate);

  const executableRoot = externalExecutableRuntimeRoot(input.executable, input.projectRoot);
  if (executableRoot !== undefined) await add(executableRoot);
  const interpreter = await executableInterpreter(input.executable, input.cwd, input.pathValue);
  if (interpreter !== undefined) {
    await add(path.dirname(interpreter.logicalPath));
    const interpreterRoot = externalExecutableRuntimeRoot(interpreter.resolvedPath, input.projectRoot);
    if (interpreterRoot !== undefined) await add(interpreterRoot);
    // `/usr/bin/env` must be able to reach the exact interpreter we authenticated above even when
    // a version manager exposes it through a logical symlink that Seatbelt canonicalizes away.
    // Prepending the real directory preserves the remaining compiled PATH order while preventing
    // a sandbox-only "command not found" from changing the configured command's meaning.
    const realInterpreterDirectory = path.dirname(interpreter.resolvedPath);
    const currentPath = input.environment.PATH ?? "";
    if (!currentPath.split(path.delimiter).includes(realInterpreterDirectory)) {
      input.environment.PATH = currentPath.length === 0
        ? realInterpreterDirectory
        : `${realInterpreterDirectory}${path.delimiter}${currentPath}`;
    }
  }

  for (const dependencyRoot of await ensureSharedNodeDependencyLinks(input)) await add(dependencyRoot);

  // Corepack is part of the authenticated executable closure, but its selected package-manager
  // bytes live in a separate cache. Corepack materializes a temporary folder inside that cache on
  // every invocation — even when the manager is already installed — so a read-only grant fails
  // closed with EPERM before the real command (e.g. vitest) ever runs. Grant only that cache (and
  // PNPM_HOME) writable, never HOME generally; the cache is content-addressed shared state that
  // the operator's own package manager already mutates additively.
  if (input.executable.includes(`${path.sep}corepack${path.sep}`)) {
    const configured = input.environment.COREPACK_HOME;
    if (configured !== undefined && path.isAbsolute(configured)) await addWritable(configured);
    const home = input.environment.HOME;
    if (home !== undefined && path.isAbsolute(home)) {
      await addWritable(path.join(home, ".cache", "node", "corepack"));
    }
  }
  const pnpmHome = input.environment.PNPM_HOME;
  if (pnpmHome !== undefined && path.isAbsolute(pnpmHome)) await addWritable(pnpmHome);
  return { read: [...roots].sort(), write: [...writeRoots].sort() };
}

async function ensureSharedNodeDependencyLinks(input: {
  projectRoot: string;
  stateRoot: string;
  cwd: string;
}): Promise<string[]> {
  const gitCommonDirectory = path.dirname(input.stateRoot);
  if (path.basename(gitCommonDirectory) !== ".git") return existingNodeDependencyRoots(input.projectRoot, input.cwd);
  const primaryRoot = path.dirname(gitCommonDirectory);
  if (primaryRoot === input.projectRoot) return existingNodeDependencyRoots(input.projectRoot, input.cwd);
  const relativeCwd = path.relative(input.projectRoot, input.cwd);
  if (relativeCwd === ".." || relativeCwd.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCwd)) {
    throw new ContainedProcessError("dependency_root", "configured check cwd escapes its managed worktree");
  }
  const relativeAncestors = [relativeCwd];
  let cursor = relativeCwd;
  while (cursor !== "") {
    cursor = path.dirname(cursor);
    if (cursor === ".") cursor = "";
    relativeAncestors.push(cursor);
  }
  for (const relative of await workspaceNodeDependencyRelatives(primaryRoot)) {
    relativeAncestors.push(relative);
  }
  const roots: string[] = [];
  for (const relative of [...new Set(relativeAncestors)].sort()) {
    const source = path.join(primaryRoot, relative, "node_modules");
    const sourceMetadata = await lstat(source).catch((error: unknown) => {
      if (isMissingPathError(error)) return undefined;
      throw error;
    });
    if (sourceMetadata === undefined) continue;
    const sourceResolved = await realpath(source);
    if (!(await lstat(sourceResolved)).isDirectory()) {
      throw new ContainedProcessError("dependency_root", `shared dependency root is not a directory: ${source}`);
    }
    const destination = path.join(input.projectRoot, relative, "node_modules");
    const destinationMetadata = await lstat(destination).catch((error: unknown) => {
      if (isMissingPathError(error)) return undefined;
      throw error;
    });
    let materialized = destinationMetadata;
    if (materialized?.isSymbolicLink() === true) {
      if (await realpath(destination) !== sourceResolved) {
        throw new ContainedProcessError("dependency_root", `managed dependency link has an unexpected target: ${destination}`);
      }
      await rm(destination);
      materialized = undefined;
    }
    if (materialized === undefined) {
      await mkdir(destination, { recursive: true });
    } else if (!materialized.isDirectory()) {
      throw new ContainedProcessError("dependency_root", `managed dependency path is not a directory: ${destination}`);
    }
    await populateSharedNodeDependencyDirectory(
      sourceResolved,
      destination,
      primaryRoot,
      input.projectRoot,
    );
    roots.push(destination, sourceResolved);
  }
  await reconcileManagedManifestDependencies({
    managedRoot: input.projectRoot,
    primaryRoot,
    relativeWorkspaces: [...new Set(relativeAncestors)].sort(),
  });
  return roots;
}

interface DependencyIntent {
  name: string;
  specifier: string;
  lockedReference?: string;
  version?: string;
}

interface InstalledDependencyCandidate {
  path: string;
  version: string;
  pnpmEntry?: string;
}

/**
 * A managed worktree can target a branch whose dependency manifest differs from the user's
 * primary checkout. Copying only the primary checkout's direct links is then subtly wrong: the
 * package bytes may still exist in pnpm's immutable store, but the target workspace cannot resolve
 * them. Reconcile only direct manifest entries for the command workspace/ancestors, using the
 * target lockfile when available and never installing, downloading, or executing package scripts.
 */
async function reconcileManagedManifestDependencies(input: {
  managedRoot: string;
  primaryRoot: string;
  relativeWorkspaces: readonly string[];
}): Promise<void> {
  const lockfile = await readPnpmLockfile(input.managedRoot);
  const primaryWorkspaceRelatives = await workspaceNodeDependencyRelatives(input.primaryRoot);
  const managedWorkspacePackages = await workspacePackageCatalog(input.managedRoot);
  for (const relative of input.relativeWorkspaces) {
    const manifestPath = path.join(input.managedRoot, relative, "package.json");
    const manifest = await readPackageManifest(manifestPath);
    if (manifest === undefined) continue;
    const dependencies = packageManifestDependencies(manifest);
    const importer = pnpmImporter(lockfile, relative);
    for (const [name, specifier] of Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right))) {
      if (!isSafePackageName(name) || typeof specifier !== "string") continue;
      const destination = path.join(input.managedRoot, relative, "node_modules", ...name.split("/"));
      if (specifier.startsWith("workspace:") || specifier.startsWith("link:")) {
        const workspaceTarget = await managedWorkspaceDependencyTarget({
          managedRoot: input.managedRoot,
          relative,
          name,
          specifier,
          managedWorkspacePackages,
        });
        if (workspaceTarget !== undefined) {
          await replaceManagedWorkspaceDependencyLink(destination, workspaceTarget);
        }
        continue;
      }
      if (specifier.startsWith("file:")) {
        continue;
      }
      const lockedReference = pnpmDependencyReference(importer, name);
      const intent: DependencyIntent = {
        name,
        specifier,
        ...(lockedReference === undefined ? {} : { lockedReference }),
        ...(dependencyVersion(lockedReference ?? specifier) === undefined
          ? {}
          : { version: dependencyVersion(lockedReference ?? specifier)! }),
      };
      if (await installedDependencySatisfies(destination, intent)) continue;
      const candidate = await resolveInstalledDependencyCandidate({
        primaryRoot: input.primaryRoot,
        primaryWorkspaceRelatives,
        intent,
      });
      if (candidate === undefined) continue;
      await replaceManagedDependencyLink(destination, candidate.path, intent);
    }
  }
}

async function workspacePackageCatalog(root: string): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  const queue = [""];
  let visited = 0;
  const skipped = new Set([
    ".git", ".koni", ".next", ".turbo", ".cache", "node_modules", "coverage", "dist", "build", "target",
  ]);
  while (queue.length > 0) {
    const relative = queue.shift()!;
    visited += 1;
    if (visited > 50_000) {
      throw new ContainedProcessError("dependency_root", "workspace package discovery exceeded its directory bound");
    }
    const absolute = relative.length === 0 ? root : path.join(root, relative);
    const manifest = await readPackageManifest(path.join(absolute, "package.json"));
    if (typeof manifest?.name === "string" && isSafePackageName(manifest.name)) {
      const prior = output.get(manifest.name);
      if (prior !== undefined && prior !== absolute) {
        throw new ContainedProcessError(
          "dependency_root",
          `target workspace contains duplicate package name ${manifest.name}`,
        );
      }
      output.set(manifest.name, absolute);
    }
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory() || skipped.has(entry.name) || entry.name.startsWith(".")) continue;
      queue.push(relative.length === 0 ? entry.name : path.join(relative, entry.name));
    }
  }
  return output;
}

async function managedWorkspaceDependencyTarget(input: {
  managedRoot: string;
  relative: string;
  name: string;
  specifier: string;
  managedWorkspacePackages: ReadonlyMap<string, string>;
}): Promise<string | undefined> {
  if (input.specifier.startsWith("workspace:")) return input.managedWorkspacePackages.get(input.name);
  const linked = path.resolve(input.managedRoot, input.relative, input.specifier.slice("link:".length));
  if (!isWithinRoot(linked, input.managedRoot)) {
    throw new ContainedProcessError("dependency_root", `workspace dependency link escapes the worktree: ${input.name}`);
  }
  const manifest = await readPackageManifest(path.join(linked, "package.json"));
  return manifest?.name === input.name ? linked : undefined;
}

async function replaceManagedWorkspaceDependencyLink(destination: string, target: string): Promise<void> {
  const existing = await lstat(destination).catch((error: unknown) => {
    if (isMissingPathError(error)) return undefined;
    throw error;
  });
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) return;
    if (await realpath(destination) === await realpath(target)) return;
    await rm(destination);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(target, destination, "dir").catch(async (error: unknown) => {
    if (!isAlreadyExistsError(error) || await realpath(destination) !== await realpath(target)) throw error;
  });
}

async function readPnpmLockfile(root: string): Promise<unknown> {
  const bytes = await readFile(path.join(root, "pnpm-lock.yaml"), "utf8").catch((error: unknown) => {
    if (isMissingPathError(error)) return undefined;
    throw error;
  });
  if (bytes === undefined) return undefined;
  try {
    return parseYaml(bytes);
  } catch (error) {
    throw new ContainedProcessError(
      "dependency_root",
      `target pnpm lockfile is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function pnpmImporter(lockfile: unknown, relative: string): unknown {
  if (!isObject(lockfile) || !isObject(lockfile.importers)) return undefined;
  const normalized = relative.length === 0 ? "." : relative.split(path.sep).join("/");
  return lockfile.importers[normalized];
}

function pnpmDependencyReference(importer: unknown, name: string): string | undefined {
  if (!isObject(importer)) return undefined;
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const entries = importer[section];
    if (!isObject(entries)) continue;
    const entry = entries[name];
    if (typeof entry === "string") return entry;
    if (isObject(entry) && typeof entry.version === "string") return entry.version;
  }
  return undefined;
}

async function readPackageManifest(manifestPath: string): Promise<Record<string, unknown> | undefined> {
  const bytes = await readFile(manifestPath, "utf8").catch((error: unknown) => {
    if (isMissingPathError(error)) return undefined;
    throw error;
  });
  if (bytes === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(bytes);
    if (!isObject(parsed)) {
      throw new Error("manifest root is not an object");
    }
    return parsed;
  } catch (error) {
    throw new ContainedProcessError(
      "dependency_root",
      `target package manifest is invalid (${manifestPath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function packageManifestDependencies(manifest: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const entries = manifest[section];
    if (!isObject(entries)) continue;
    for (const [name, specifier] of Object.entries(entries)) {
      if (typeof specifier === "string") output[name] = specifier;
    }
  }
  return output;
}

async function installedDependencySatisfies(
  candidatePath: string,
  intent: DependencyIntent,
): Promise<boolean> {
  const metadata = await lstat(candidatePath).catch((error: unknown) => {
    if (isMissingPathError(error)) return undefined;
    throw error;
  });
  if (metadata === undefined) return false;
  const manifest = await readPackageManifest(path.join(await realpath(candidatePath), "package.json"));
  return manifest !== undefined
    && manifest.name === intent.name
    && typeof manifest.version === "string"
    && dependencyVersionMatches(manifest.version, intent);
}

async function resolveInstalledDependencyCandidate(input: {
  primaryRoot: string;
  primaryWorkspaceRelatives: readonly string[];
  intent: DependencyIntent;
}): Promise<InstalledDependencyCandidate | undefined> {
  const candidates = new Map<string, InstalledDependencyCandidate>();
  const inspect = async (candidatePath: string, pnpmEntry?: string): Promise<void> => {
    const resolved = await realpath(candidatePath).catch((error: unknown) => {
      if (isMissingPathError(error)) return undefined;
      throw error;
    });
    if (resolved === undefined || candidates.has(resolved)) return;
    const manifest = await readPackageManifest(path.join(resolved, "package.json"));
    if (manifest?.name !== input.intent.name || typeof manifest.version !== "string") return;
    if (!dependencyVersionMatches(manifest.version, input.intent)) return;
    candidates.set(resolved, {
      path: resolved,
      version: manifest.version,
      ...(pnpmEntry === undefined ? {} : { pnpmEntry }),
    });
  };

  for (const relative of ["", ...input.primaryWorkspaceRelatives]) {
    await inspect(path.join(input.primaryRoot, relative, "node_modules", ...input.intent.name.split("/")));
  }
  const pnpmRoot = await realpath(path.join(input.primaryRoot, "node_modules", ".pnpm")).catch(
    (error: unknown) => {
      if (isMissingPathError(error)) return undefined;
      throw error;
    },
  );
  if (pnpmRoot !== undefined) {
    const prefix = `${input.intent.name.replace("/", "+")}@`;
    for (const entry of await readdir(pnpmRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      await inspect(path.join(pnpmRoot, entry.name, "node_modules", ...input.intent.name.split("/")), entry.name);
    }
  }
  const qualifier = input.intent.lockedReference?.match(/patch_hash=([0-9a-f]+)/u)?.[1];
  return [...candidates.values()].sort((left, right) => {
    if (qualifier !== undefined) {
      const leftPinned = left.pnpmEntry?.includes(qualifier) === true;
      const rightPinned = right.pnpmEntry?.includes(qualifier) === true;
      if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    }
    return rcompare(left.version, right.version) || left.path.localeCompare(right.path);
  })[0];
}

async function replaceManagedDependencyLink(
  destination: string,
  target: string,
  intent: DependencyIntent,
): Promise<void> {
  const existing = await lstat(destination).catch((error: unknown) => {
    if (isMissingPathError(error)) return undefined;
    throw error;
  });
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) return;
    await rm(destination);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(target, destination, "dir").catch(async (error: unknown) => {
    if (!isAlreadyExistsError(error) || !(await installedDependencySatisfies(destination, intent))) throw error;
  });
}

function dependencyVersionMatches(version: string, intent: DependencyIntent): boolean {
  if (intent.version !== undefined) return version === intent.version;
  const range = validRange(intent.specifier);
  return range !== null && valid(version) !== null && satisfies(version, range);
}

function dependencyVersion(reference: string): string | undefined {
  const exact = valid(reference);
  if (exact !== null) return exact;
  const match = reference.match(/(?:^|[^0-9])([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/u);
  return match?.[1] !== undefined && valid(match[1]) !== null ? match[1] : undefined;
}

function isSafePackageName(name: string): boolean {
  return /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/iu.test(name) && !name.includes("..");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function workspaceNodeDependencyRelatives(primaryRoot: string): Promise<string[]> {
  const output: string[] = [];
  const queue = [""];
  let visited = 0;
  const skipped = new Set([
    ".git", ".koni", ".next", ".turbo", ".cache", "node_modules", "coverage", "dist", "build", "target",
  ]);
  while (queue.length > 0) {
    const relative = queue.shift()!;
    visited += 1;
    if (visited > 50_000) {
      throw new ContainedProcessError("dependency_root", "workspace dependency discovery exceeded its directory bound");
    }
    const absolute = relative.length === 0 ? primaryRoot : path.join(primaryRoot, relative);
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory() || skipped.has(entry.name) || entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const childRelative = relative.length === 0 ? entry.name : path.join(relative, entry.name);
      const dependencyRoot = path.join(primaryRoot, childRelative, "node_modules");
      const dependencyMetadata = await lstat(dependencyRoot).catch((error: unknown) => {
        if (isMissingPathError(error)) return undefined;
        throw error;
      });
      if (dependencyMetadata?.isDirectory() === true) output.push(childRelative);
      queue.push(childRelative);
    }
  }
  return output.sort();
}

async function populateSharedNodeDependencyDirectory(
  source: string,
  destination: string,
  primaryRoot: string,
  managedRoot: string,
  depth = 0,
): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourceEntry = path.join(source, entry.name);
    const destinationEntry = path.join(destination, entry.name);
    let existing = await lstat(destinationEntry).catch((error: unknown) => {
      if (isMissingPathError(error)) return undefined;
      throw error;
    });
    const sourceMetadata = await lstat(sourceEntry);
    const sourceResolved = await realpath(sourceEntry).catch((error: unknown) => {
      if (isMissingPathError(error)) return undefined;
      throw error;
    });
    // Package managers can leave broken optional/filtered workspace links in an otherwise valid
    // installation. They are not usable dependency authority and must not prevent unrelated checks.
    if (sourceResolved === undefined) continue;
    const materializeNamespace = sourceMetadata.isDirectory() && entry.name.startsWith("@") && depth < 2;
    if (materializeNamespace && existing?.isSymbolicLink() === true) {
      if (await realpath(destinationEntry) !== sourceResolved) {
        throw new ContainedProcessError(
          "dependency_root",
          `managed dependency namespace has an unexpected target: ${destinationEntry}`,
        );
      }
      await rm(destinationEntry);
      existing = undefined;
    }
    if (materializeNamespace) {
      if (existing === undefined) await mkdir(destinationEntry);
      else if (!existing.isDirectory()) {
        throw new ContainedProcessError(
          "dependency_root",
          `managed dependency namespace is not a directory: ${destinationEntry}`,
        );
      }
      await populateSharedNodeDependencyDirectory(
        sourceResolved,
        destinationEntry,
        primaryRoot,
        managedRoot,
        depth + 1,
      );
      continue;
    }
    const managedTarget = await dependencyTargetForManagedWorktree(sourceResolved, primaryRoot, managedRoot);
    if (existing === undefined) {
      const targetMetadata = await lstat(managedTarget);
      await symlink(managedTarget, destinationEntry, targetMetadata.isDirectory() ? "dir" : "file");
      continue;
    }
    if (existing.isSymbolicLink()) {
      const resolved = await realpath(destinationEntry);
      if (resolved !== await realpath(managedTarget)) {
        if (!isWithinRoot(resolved, primaryRoot) && !isWithinRoot(resolved, managedRoot)) {
          throw new ContainedProcessError(
            "dependency_root",
            `managed dependency entry has an unexpected target: ${destinationEntry}`,
          );
        }
        // A prior manifest reconciliation may deliberately retain the target branch's package
        // version rather than the primary checkout's current link. The target manifest/lock pass
        // below re-authenticates direct entries; never overwrite that branch-correct cache state.
      }
    }
    // Preserve existing real directories such as runner caches and already materialized packages.
  }
}

async function dependencyTargetForManagedWorktree(
  sourceResolved: string,
  primaryRoot: string,
  managedRoot: string,
): Promise<string> {
  if (sourceResolved !== primaryRoot && !sourceResolved.startsWith(`${primaryRoot}${path.sep}`)) {
    return sourceResolved;
  }
  const relative = path.relative(primaryRoot, sourceResolved);
  const candidate = path.join(managedRoot, relative);
  const metadata = await lstat(candidate).catch((error: unknown) => {
    if (isMissingPathError(error)) return undefined;
    throw error;
  });
  return metadata === undefined ? sourceResolved : candidate;
}

async function existingNodeDependencyRoots(projectRoot: string, cwd: string): Promise<string[]> {
  const roots: string[] = [];
  let cursor = cwd;
  for (;;) {
    const candidate = path.join(cursor, "node_modules");
    const metadata = await lstat(candidate).catch((error: unknown) => {
      if (isMissingPathError(error)) return undefined;
      throw error;
    });
    if (metadata !== undefined) roots.push(candidate, await realpath(candidate));
    if (cursor === projectRoot) break;
    const parent = path.dirname(cursor);
    if (parent === cursor || !parent.startsWith(`${projectRoot}${path.sep}`)) break;
    cursor = parent;
  }
  return roots;
}

function externalExecutableRuntimeRoot(executable: string, projectRoot: string): string | undefined {
  if (executable === projectRoot || executable.startsWith(`${projectRoot}${path.sep}`)) return undefined;
  const parsed = path.parse(executable);
  const segments = executable.slice(parsed.root.length).split(path.sep);
  const marker = segments.findIndex((segment) => segment === "bin" || segment === "lib" || segment === "libexec");
  if (marker >= 1) return path.join(parsed.root, ...segments.slice(0, marker));
  return path.dirname(executable);
}

async function executableInterpreter(
  executable: string,
  cwd: string,
  pathValue: string | undefined,
): Promise<{ logicalPath: string; resolvedPath: string } | undefined> {
  const metadata = await lstat(executable);
  if (!metadata.isFile() || metadata.size > 64 * 1024) return undefined;
  const firstLine = (await readFile(executable, "utf8")).split(/\r?\n/u, 1)[0] ?? "";
  if (!firstLine.startsWith("#!")) return undefined;
  const words = firstLine.slice(2).trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return undefined;
  if (path.basename(words[0]!) !== "env") {
    return words[0]!.includes("/")
      ? resolveExecutableWithLogicalPath(words[0]!, cwd, pathValue)
      : undefined;
  }
  let index = 1;
  if (words[index] === "-S") index += 1;
  while (words[index]?.includes("=") === true) index += 1;
  const command = words[index];
  return command === undefined ? undefined : resolveExecutableWithLogicalPath(command, cwd, pathValue);
}

async function resolveExecutableWithLogicalPath(
  command: string,
  cwd: string,
  pathValue: string | undefined,
): Promise<{ logicalPath: string; resolvedPath: string }> {
  const candidates = command.includes("/")
    ? [path.isAbsolute(command) ? command : path.resolve(cwd, command)]
    : (pathValue ?? "").split(path.delimiter).filter(Boolean).map((entry) => path.resolve(entry, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const resolvedPath = await realpath(candidate);
      const metadata = await lstat(resolvedPath);
      if (metadata.isFile() && !metadata.isSymbolicLink()) return { logicalPath: candidate, resolvedPath };
    } catch {
      // Keep searching the exact compiled PATH.
    }
  }
  throw new ContainedProcessError("executable", `configured executable is unavailable: ${command}`);
}

async function sandboxCommand(input: {
  projectRoot: string;
  stateRoot: string;
  cwd: string;
  semanticArgv: string[];
  runtimeReadRoots: readonly string[];
  runtimeWriteRoots: readonly string[];
  scratch: string;
  readPaths: readonly string[];
  writePaths: readonly string[];
  networkAccess: boolean;
  sandboxExecutable: RuntimeExecutableIdentity;
}): Promise<{ argv: string[]; kind: string; profileSha256: Sha256Digest; executable: RuntimeExecutableIdentity }> {
  if (process.platform === "darwin") return macOsSandboxCommand(input);
  if (process.platform === "linux") return linuxBubblewrapCommand(input);
  throw new ContainedProcessError(
    "sandbox_unavailable",
    `configured commands are unsupported without an OS sandbox on ${process.platform}`,
  );
}

async function macOsSandboxCommand(input: {
  projectRoot: string;
  stateRoot: string;
  cwd: string;
  semanticArgv: string[];
  runtimeReadRoots: readonly string[];
  runtimeWriteRoots: readonly string[];
  scratch: string;
  readPaths: readonly string[];
  writePaths: readonly string[];
  networkAccess: boolean;
  sandboxExecutable: RuntimeExecutableIdentity;
}): Promise<{ argv: string[]; kind: string; profileSha256: Sha256Digest; executable: RuntimeExecutableIdentity }> {
  if (input.sandboxExecutable.role !== "sandbox") {
    throw new ContainedProcessError("sandbox_identity", "authority supplied a non-sandbox executable");
  }
  await assertRuntimeExecutableCurrent(input.sandboxExecutable);
  const launcher = input.sandboxExecutable.path;
  const readable = await resolveGrantedPaths(input.projectRoot, input.readPaths, true);
  const writable = [
    ...await resolveGrantedPaths(input.projectRoot, input.writePaths, true),
    // Runtime write roots (corepack cache, PNPM_HOME) the package-manager shim must mutate.
    ...input.runtimeWriteRoots,
  ];
  const runtimeRoots = [
    "/System", "/usr", "/bin", "/sbin", "/Library", "/etc", "/private/etc",
    "/private/var/db/timezone", "/private/var/select", "/opt/homebrew", "/usr/local",
    ...input.runtimeReadRoots,
  ];
  const metadata = ancestorPaths([
    ...runtimeRoots,
    input.projectRoot,
    ...readable,
    ...writable,
    input.cwd,
    input.scratch,
    input.semanticArgv[0]!,
  ]);
  const rules = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow signal)",
    "(allow sysctl-read)",
    "(allow file-read-data (literal \"/\"))",
    ...metadata.map((entry) => `(allow file-read-metadata (literal "${seatbelt(entry)}"))`),
    ...runtimeRoots.map((entry) => `(allow file-read* (literal "${seatbelt(entry)}") (subpath "${seatbelt(entry)}"))`),
    `(allow file-read* (literal "${seatbelt(input.projectRoot)}") (subpath "${seatbelt(input.projectRoot)}"))`,
    `(allow file-read* (literal "${seatbelt(input.cwd)}"))`,
    `(allow file-read* (literal "${seatbelt(input.semanticArgv[0]!)}"))`,
    ...readable.map((entry) => `(allow file-read* (literal "${seatbelt(entry)}") (subpath "${seatbelt(entry)}"))`),
    `(allow file-read* file-write* (literal "${seatbelt(input.scratch)}") (subpath "${seatbelt(input.scratch)}"))`,
    ...writable.map((entry) => `(allow file-read* file-write* (literal "${seatbelt(entry)}") (subpath "${seatbelt(entry)}"))`),
    '(allow file-read* (literal "/dev/null") (literal "/dev/urandom"))',
    '(allow file-write* (literal "/dev/null"))',
    ...(input.networkAccess ? ["(allow network*)"] : []),
    ...secretPaths(input.projectRoot, input.cwd).map((entry) =>
      `(deny file-read* (literal "${seatbelt(entry)}") (subpath "${seatbelt(entry)}"))`
    ),
    ...[input.stateRoot, path.join(input.projectRoot, ".git"), path.join(input.projectRoot, ".koni")].map((entry) =>
      `(deny file-read* file-write* (literal "${seatbelt(entry)}") (subpath "${seatbelt(entry)}"))`
    ),
  ];
  const profile = rules.join(" ");
  return {
    argv: [launcher, "-p", profile, "--", ...input.semanticArgv],
    kind: "macos-seatbelt.v1",
    profileSha256: canonicalHash({ profile }),
    executable: input.sandboxExecutable,
  };
}

async function linuxBubblewrapCommand(input: {
  projectRoot: string;
  stateRoot: string;
  cwd: string;
  semanticArgv: string[];
  runtimeReadRoots: readonly string[];
  runtimeWriteRoots: readonly string[];
  scratch: string;
  readPaths: readonly string[];
  writePaths: readonly string[];
  networkAccess: boolean;
  sandboxExecutable: RuntimeExecutableIdentity;
}): Promise<{ argv: string[]; kind: string; profileSha256: Sha256Digest; executable: RuntimeExecutableIdentity }> {
  if (input.sandboxExecutable.role !== "sandbox") {
    throw new ContainedProcessError("sandbox_identity", "authority supplied a non-sandbox executable");
  }
  await assertRuntimeExecutableCurrent(input.sandboxExecutable);
  const bwrap = input.sandboxExecutable.path;
  const readable = await resolveGrantedPaths(input.projectRoot, input.readPaths, false);
  const writable = await resolveGrantedPaths(input.projectRoot, input.writePaths, false);
  // The compiler authorizes an exact repository-native command. Its transitive module/config
  // reads cannot be soundly enumerated from the model's narrower file grant, so mount the source
  // worktree read-only and overlay only explicit writable paths. Secrets and Koni/Git authority
  // paths are masked below. This does not broaden the agent's own file tools.
  const mounted = minimalRoots([input.projectRoot, ...readable, ...writable]);
  const runtimeRoots = await existingPaths([
    "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt/homebrew", "/usr/local",
    ...input.runtimeReadRoots,
  ]);
  const targets = [...new Set([...runtimeRoots, ...mounted, input.scratch, input.cwd])];
  const directories = ancestorPaths(targets)
    .filter((entry) => entry !== "/" && !targets.includes(entry));
  const protectedMounts = await linuxProtectedMounts(input.projectRoot, input.cwd);
  const policy = {
    network: input.networkAccess,
    projectReadRoot: input.projectRoot,
    readable,
    writable,
    stateRoot: input.stateRoot,
    protected: protectedMounts.map((entry) => ({ path: entry.path, kind: entry.kind })),
  };
  const argv = [
    bwrap,
    "--die-with-parent",
    "--new-session",
    ...(input.networkAccess ? [] : ["--unshare-net"]),
    "--tmpfs", "/",
    "--proc", "/proc",
    "--dev", "/dev",
    ...directories.flatMap((entry) => ["--dir", entry]),
    ...runtimeRoots.flatMap((entry) => ["--ro-bind", entry, entry]),
    ...mounted.flatMap((entry) => ["--ro-bind", entry, entry]),
    "--bind", input.scratch, input.scratch,
    ...writable.flatMap((entry) => ["--bind", entry, entry]),
    ...protectedMounts.flatMap((entry) => entry.kind === "directory"
      ? ["--tmpfs", entry.path, "--chmod", "000", entry.path]
      : ["--ro-bind", "/dev/null", entry.path]),
    "--chdir", input.cwd,
    "--",
    ...input.semanticArgv,
  ];
  return {
    argv,
    kind: "linux-bwrap.v1",
    profileSha256: canonicalHash(policy),
    executable: input.sandboxExecutable,
  };
}

async function existingPaths(entries: readonly string[]): Promise<string[]> {
  const output = [];
  for (const entry of entries) {
    const metadata = await lstat(entry).catch((error: unknown) => {
      if (isMissingPathError(error)) return undefined;
      throw error;
    });
    if (metadata !== undefined) output.push(await realpath(entry));
  }
  return minimalRoots(output);
}

function minimalRoots(entries: readonly string[]): string[] {
  const sorted = [...new Set(entries)].sort((left, right) =>
    left.split(path.sep).length - right.split(path.sep).length || left.localeCompare(right));
  return sorted.filter((entry, index) => !sorted.some((other, otherIndex) =>
    otherIndex < index && (entry === other || entry.startsWith(`${other}${path.sep}`))));
}

async function linuxProtectedMounts(
  projectRoot: string,
  cwd: string,
): Promise<Array<{ path: string; kind: "file" | "directory" }>> {
  const candidates = [...new Set([
    path.join(projectRoot, ".git"),
    path.join(projectRoot, ".koni"),
    ...secretPaths(projectRoot, cwd),
  ])].sort();
  const output: Array<{ path: string; kind: "file" | "directory" }> = [];
  for (const candidate of candidates) {
    const metadata = await lstat(candidate).catch((error: unknown) => {
      if (isMissingPathError(error)) return undefined;
      throw error;
    });
    if (metadata === undefined) continue;
    if (metadata.isSymbolicLink()) {
      throw new ContainedProcessError("sandbox_secret", `protected path is a symbolic link: ${candidate}`);
    }
    if (metadata.isFile()) output.push({ path: candidate, kind: "file" });
    else if (metadata.isDirectory()) output.push({ path: candidate, kind: "directory" });
    else throw new ContainedProcessError("sandbox_secret", `protected path has unsafe type: ${candidate}`);
  }
  return output;
}

async function resolveGrantedPaths(
  root: string,
  entries: readonly string[],
  allowMissing: boolean,
): Promise<string[]> {
  const output = new Set<string>();
  for (const entry of entries) {
    validateRelativeGrant(entry);
    const absolute = entry === "." ? root : path.resolve(root, entry);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      throw new ContainedProcessError("path_grant", "command path grant escapes the worktree");
    }
    try {
      const resolved = await realpath(absolute);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new ContainedProcessError("path_grant", "command path grant resolves outside the worktree");
      }
      output.add(resolved);
    } catch (error) {
      if (!allowMissing || !isMissingPathError(error)) throw error;
      output.add(absolute);
    }
  }
  return [...output].sort();
}

function validateRelativeGrant(entry: string): void {
  if (entry !== "." && (path.isAbsolute(entry) || entry.includes("\\") || entry.includes("\0") ||
    entry.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))) {
    throw new ContainedProcessError("path_grant", `unsafe command path grant ${entry}`);
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function canonicalDirectory(input: string, label: string): Promise<string> {
  const resolved = await realpath(input);
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ContainedProcessError("directory", `${label} is not a real directory`);
  }
  return resolved;
}

async function containedDirectory(root: string, relative: string): Promise<string> {
  const absolute = relative === "." ? root : path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new ContainedProcessError("cwd", "configured check cwd escapes the worktree");
  }
  return canonicalDirectory(absolute, "configured check cwd");
}

async function createScratch(projectRoot: string, stateRoot: string): Promise<string> {
  const base = process.platform === "darwin" ? "/private/tmp" : "/tmp";
  const scratch = path.join(base, `.koni-check-${randomUUID()}`);
  if (
    scratch.startsWith(projectRoot) || projectRoot.startsWith(scratch) ||
    scratch.startsWith(stateRoot) || stateRoot.startsWith(scratch)
  ) throw new ContainedProcessError("scratch", "private scratch overlaps Koni authority paths");
  await mkdir(scratch, { mode: 0o700 });
  return scratch;
}

async function safeRemoveScratch(scratch: string): Promise<void> {
  const metadata = await lstat(scratch).catch(() => undefined);
  if (metadata === undefined) return;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ContainedProcessError("scratch", "refusing to remove an unsafe command scratch path");
  }
  await rm(scratch, { recursive: true, force: true });
}

async function spawnBounded(input: {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  executable: RuntimeExecutableIdentity;
}): Promise<Pick<ContainedProcessResult, "exitCode" | "signal" | "stdout" | "stderr">> {
  if (input.signal?.aborted === true) throw new ContainedProcessError("aborted", "check was aborted before launch");
  await assertRuntimeExecutableCurrent(input.executable);
  return new Promise((resolve, reject) => {
    const child = spawn(input.argv[0]!, input.argv.slice(1), {
      cwd: input.cwd,
      env: input.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalError: Error | undefined;
    let closed = false;
    const terminate = () => {
      if (child.pid === undefined || closed) return;
      signalProcessGroup(child.pid, "SIGTERM");
      const escalation = setTimeout(() => {
        if (!closed && child.pid !== undefined) signalProcessGroup(child.pid, "SIGKILL");
      }, TERMINATE_GRACE_MS);
      escalation.unref();
    };
    const abort = () => {
      terminalError ??= new ContainedProcessError("aborted", "configured check was aborted");
      terminate();
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      terminalError ??= new ContainedProcessError("timeout", `configured check exceeded ${input.timeoutMs}ms`);
      terminate();
    }, input.timeoutMs);
    timeout.unref();
    const collect = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
      if (stream === "stdout") stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
      if (stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES) {
        terminalError ??= new ContainedProcessError("output_limit", `configured check ${stream} exceeded ${MAX_OUTPUT_BYTES} bytes`);
        terminate();
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk, "stderr"));
    child.once("error", (error) => { terminalError ??= error; });
    child.once("close", (code, signal) => {
      closed = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      if (terminalError !== undefined) reject(terminalError);
      else resolve({ exitCode: code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

const initialSandboxPath = process.env.PATH;
let sandboxExecutable: Promise<RuntimeExecutableIdentity> | undefined;

function defaultSandboxExecutable(): Promise<RuntimeExecutableIdentity> {
  sandboxExecutable ??= process.platform === "darwin"
    ? captureRuntimeExecutable("sandbox", "/usr/bin/sandbox-exec", { requireRootOwned: true })
    : process.platform === "linux"
      ? resolveRuntimeExecutable("sandbox", "bwrap", initialSandboxPath, { requireRootOwned: true })
      : Promise.reject(new ContainedProcessError(
        "sandbox_unavailable",
        `configured commands are unsupported without an OS sandbox on ${process.platform}`,
      ));
  return sandboxExecutable;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

function ancestorPaths(entries: readonly string[]): string[] {
  const output = new Set<string>();
  for (const entry of entries) {
    let cursor: string | undefined = entry;
    while (cursor !== undefined) {
      output.add(cursor);
      const parent = path.dirname(cursor);
      cursor = parent === cursor ? undefined : parent;
    }
  }
  return [...output].sort();
}

function secretPaths(projectRoot: string, cwd: string): string[] {
  const names = [".env", ".env.local", ".env.development", ".env.test", ".env.production", ".npmrc", ".yarnrc.yml"];
  return [...new Set([projectRoot, cwd].flatMap((root) => names.map((name) => path.join(root, name))))].sort();
}

function seatbelt(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
