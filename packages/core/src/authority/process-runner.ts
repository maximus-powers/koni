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
} from "node:fs/promises";
import path from "node:path";
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
  const walk = async (relative: string, explicitlyNamed: boolean): Promise<void> => {
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
        if (!explicitlyNamed && relative === "." && [".git", ".koni", "node_modules"].includes(child.name)) {
          continue;
        }
        const childRelative = relative === "." ? child.name : `${relative}/${child.name}`;
        await walk(childRelative, true);
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
    await walk(root, root !== ".");
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
  const scratch = await createScratch(projectRoot, stateRoot);
  try {
    const sandboxed = await sandboxCommand({
      projectRoot,
      stateRoot,
      cwd,
      semanticArgv,
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

async function sandboxCommand(input: {
  projectRoot: string;
  stateRoot: string;
  cwd: string;
  semanticArgv: string[];
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
  const writable = await resolveGrantedPaths(input.projectRoot, input.writePaths, true);
  const runtimeRoots = [
    "/System", "/usr", "/bin", "/sbin", "/Library", "/etc", "/private/etc",
    "/private/var/db/timezone", "/opt/homebrew", "/usr/local",
  ];
  const metadata = ancestorPaths([
    ...runtimeRoots,
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
  const mounted = minimalRoots([...readable, ...writable]);
  const runtimeRoots = await existingPaths([
    "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt/homebrew", "/usr/local",
  ]);
  const targets = [...new Set([...runtimeRoots, ...mounted, input.scratch, input.cwd])];
  const directories = ancestorPaths(targets)
    .filter((entry) => entry !== "/" && !targets.includes(entry));
  const protectedMounts = await linuxProtectedMounts(input.projectRoot, input.cwd);
  const policy = {
    network: input.networkAccess,
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
