import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthorityClient, AuthorityClientError } from "../authority/client.js";
import { discoverAuthorityEndpoint } from "../authority/endpoint.js";
import type { ProtocolHandshake, RpcSuccess } from "../authority/protocol.js";
import { RunAuthorityEngine } from "../authority/run-engine.js";
import { NativeRunCompilerProgram } from "../compiler/run-program.js";
import { compileProjectDirectory } from "../compiler/project-directory.js";
import { parseControlCatalog } from "../control-center/protocol.js";
import {
  assertSealedModelAdmission,
  loadSealedPiModelCatalog,
} from "../pi/model-catalog.js";
import type { CompilerDiagnostic } from "../shared/diagnostics.js";
import {
  loadCachedInstalledProfile,
  type InstalledProfileReference,
  readInstalledProfileReference,
} from "./profile-source.js";
import { loadProfilePackage } from "../profile/install.js";
import { PiAttemptProcessSupervisor } from "../pi/attempt-process-pool.js";
import {
  assertRuntimeClosureCurrent,
  captureRuntimeClosure,
  persistRuntimeClosurePin,
  runtimeExecutable,
} from "../runtime/identity.js";
import { pinAuthorityGitExecutable } from "../git/client.js";
import { resolvePiPeerRuntime } from "../runtime/pi-peer-runtime.js";

const DEFAULT_START_TIMEOUT_MS = 15_000;

export interface EnsureAuthorityOptions {
  projectRoot: string;
  version: string;
  client: ProtocolHandshake["client"];
  timeoutMs?: number;
  launch?: AuthorityDaemonLauncher;
  /** Provider-free tests may inject the exact host authenticator; production never bypasses it. */
  resolvePiRuntime?: typeof resolvePiPeerRuntime;
}

export interface AuthorityDaemonLauncher {
  (input: { projectRoot: string; version: string }): Promise<AuthorityDaemonLaunch>;
}

export interface AuthorityDaemonLaunch {
  pid?: number;
  exited?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface ProjectAuthorityStatus {
  running: boolean;
  projectRoot: string;
  commonDirectory: string;
  stateRoot: string;
  endpoint: string;
  profile?: InstalledProfileReference;
  authority?: {
    version: string;
    revision: number;
    runCount: number;
  };
}

export interface ProjectAuthorityStopResult {
  wasRunning: boolean;
  projectRoot: string;
  pausedRunIds: readonly string[];
}

export interface ProjectConfigurationStatus {
  ok: boolean;
  projectRoot: string;
  profile: InstalledProfileReference;
  diagnostics: readonly CompilerDiagnostic[];
  configuration?: {
    sha256: string;
    effectiveBundleSha256: string;
    runTypes: readonly string[];
    agents: readonly string[];
  };
}

export class AuthorityBootstrapError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "AuthorityBootstrapError";
    this.code = code;
  }
}

/** Connect to the repository authority, starting its detached daemon only when absent. */
export async function ensureProjectAuthority(options: EnsureAuthorityOptions): Promise<AuthorityClient> {
  // Authenticate the active Pi + TypeBox host before even reusing an existing authority. A Pi
  // upgrade must therefore fail identically in `/koni`, `koni run`, and standalone operation.
  await (options.resolvePiRuntime ?? resolvePiPeerRuntime)();
  const existing = await connectIfRunning(options);
  if (existing !== undefined) return existing;

  const endpoint = await discoverAuthorityEndpoint(options.projectRoot);
  const projectRoot = endpoint.identity.worktreeRoot;
  // Loading the cache before spawning gives the operator an immediate, actionable error and
  // prevents a detached process from ever treating mutable install metadata as package authority.
  await loadCachedInstalledProfile(projectRoot);
  const launch = await (options.launch ?? launchAuthorityDaemon)({
    projectRoot,
    version: options.version,
  });
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS);
  let delay = 25;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  launch.exited?.then((value) => { exit = value; }).catch(() => undefined);
  while (Date.now() < deadline) {
    const connected = await connectIfRunning(options);
    if (connected !== undefined) return connected;
    if (exit !== undefined) {
      throw new AuthorityBootstrapError(
        "authority_start_failed",
        `Koni authority exited before startup (code ${String(exit.code)}, signal ${String(exit.signal)})`,
      );
    }
    await wait(delay);
    delay = Math.min(400, delay * 2);
  }
  throw new AuthorityBootstrapError(
    "authority_start_timeout",
    `Koni authority did not become ready within ${options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS}ms`,
  );
}

/** Read status without causing startup or any other mutation. */
export async function inspectProjectAuthority(options: {
  projectRoot: string;
  version: string;
}): Promise<ProjectAuthorityStatus> {
  const endpoint = await discoverAuthorityEndpoint(options.projectRoot);
  const profile = await readInstalledProfileReference(endpoint.identity.worktreeRoot).catch(() => undefined);
  const client = await connectIfRunning({ ...options, client: "cli", connectTimeoutMs: 500 });
  if (client === undefined) {
    return {
      running: false,
      projectRoot: endpoint.identity.worktreeRoot,
      commonDirectory: endpoint.identity.commonDirectory,
      stateRoot: endpoint.stateRoot,
      endpoint: endpoint.endpoint,
      ...(profile === undefined ? {} : { profile }),
    };
  }
  try {
    const response = await client.request("project.status");
    const status = parseProjectStatus(response);
    return {
      running: true,
      projectRoot: endpoint.identity.worktreeRoot,
      commonDirectory: endpoint.identity.commonDirectory,
      stateRoot: endpoint.stateRoot,
      endpoint: endpoint.endpoint,
      ...(profile === undefined ? {} : { profile }),
      authority: status,
    };
  } finally {
    client.close();
  }
}

/**
 * Durably quiesce and stop the authority, even when the caller's Core build is
 * newer than the running daemon. The compatibility connection is restricted
 * by the server to this one method and relies on the owner-only local endpoint;
 * no PID signal or reusable process identity is trusted.
 */
export async function stopProjectAuthority(options: {
  projectRoot: string;
  version: string;
  timeoutMs?: number;
}): Promise<ProjectAuthorityStopResult> {
  const endpoint = await discoverAuthorityEndpoint(options.projectRoot);
  let client: AuthorityClient;
  try {
    client = await AuthorityClient.connect({
      projectRoot: endpoint.identity.worktreeRoot,
      client: "compat-control",
      version: options.version,
      compatibilityControl: true,
      connectTimeoutMs: 750,
    });
  } catch (error) {
    if (authorityUnavailable(error)) {
      return {
        wasRunning: false,
        projectRoot: endpoint.identity.worktreeRoot,
        pausedRunIds: [],
      };
    }
    throw error;
  }

  let pausedRunIds: string[] = [];
  try {
    const response = await client.request("authority.quiesce", undefined, {
      expectedRevision: client.revision,
      idempotencyKey: `operator-authority-quiesce:${randomUUID()}`,
    });
    pausedRunIds = parseQuiesceResult(response);
  } finally {
    client.close();
  }

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS);
  while (Date.now() < deadline) {
    try {
      const probe = await AuthorityClient.connect({
        projectRoot: endpoint.identity.worktreeRoot,
        client: "compat-control",
        version: options.version,
        compatibilityControl: true,
        connectTimeoutMs: 250,
      });
      probe.close();
    } catch (error) {
      if (authorityUnavailable(error)) {
        return {
          wasRunning: true,
          projectRoot: endpoint.identity.worktreeRoot,
          pausedRunIds,
        };
      }
      throw error;
    }
    await wait(25);
  }
  throw new AuthorityBootstrapError(
    "authority_stop_timeout",
    `Koni authority did not stop within ${options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS}ms`,
  );
}

export async function validateProjectConfiguration(
  projectRoot: string,
): Promise<ProjectConfigurationStatus> {
  const endpoint = await discoverAuthorityEndpoint(projectRoot);
  const profile = await readInstalledProfileReference(endpoint.identity.worktreeRoot);
  const cached = await loadCachedInstalledProfile(endpoint.identity.worktreeRoot);
  const baseline = await loadProfilePackage(cached.packageRoot);
  const result = await compileProjectDirectory(endpoint.identity.worktreeRoot, baseline);
  if (!result.ok) {
    return {
      ok: false,
      projectRoot: endpoint.identity.worktreeRoot,
      profile,
      diagnostics: result.diagnostics,
    };
  }
  return {
    ok: true,
    projectRoot: endpoint.identity.worktreeRoot,
    profile,
    diagnostics: result.diagnostics,
    configuration: {
      sha256: result.value.configuration_sha256,
      effectiveBundleSha256: result.value.effective_bundle_sha256,
      runTypes: [...result.value.run_type_order],
      agents: Object.keys(result.value.agents).sort(),
    },
  };
}

/** Internal foreground entry used only by the detached `koni authority serve` child. */
export async function serveProjectAuthority(options: {
  projectRoot: string;
  version: string;
  shutdown?: Promise<void>;
  /**
   * Provider-free packaged-release evidence only: construct the exact production Pi child and
   * persist its session mapping, but require the test to pause/delete it before activation.
   */
  providerFreeAdmissionProbe?: true;
}): Promise<void> {
  const piPeerRuntime = await resolvePiPeerRuntime();
  const runtimeClosure = await captureRuntimeClosure();
  const gitExecutable = runtimeExecutable(runtimeClosure, "git");
  await pinAuthorityGitExecutable(gitExecutable);
  const endpoint = await discoverAuthorityEndpoint(options.projectRoot);
  const runtimeClosurePin = await persistRuntimeClosurePin(endpoint.stateRoot, runtimeClosure);
  const runtimeGuard = () => assertRuntimeClosureCurrent(runtimeClosure);
  const cached = await loadCachedInstalledProfile(endpoint.identity.worktreeRoot);
  const baseline = await loadProfilePackage(cached.packageRoot);
  const program = await NativeRunCompilerProgram.create({
    projectRoot: endpoint.identity.worktreeRoot,
    packageBaseline: baseline,
    packageBaselineLoader: async () => {
      const current = await loadCachedInstalledProfile(endpoint.identity.worktreeRoot);
      return loadProfilePackage(current.packageRoot);
    },
  });
  const requestedShutdown = deferred<void>();
  const engine = await RunAuthorityEngine.open({
    projectRoot: endpoint.identity.worktreeRoot,
    version: options.version,
    program,
    runtimeGuard,
    runtimeClosureSha256: runtimeClosure.closureSha256,
    gitExecutableSha256: gitExecutable.sha256,
    sandboxExecutable: runtimeExecutable(runtimeClosure, "sandbox"),
    activateProviderAttempts: options.providerFreeAdmissionProbe !== true,
    requestAuthorityShutdown: () => requestedShutdown.resolve(undefined),
    supervisor: new PiAttemptProcessSupervisor({
      beforeLaunch: runtimeGuard,
      runtime: { piPeerRuntime, runtimeClosurePin },
      deferActivationUntilAuthorityCommit: true,
    }),
    profilePackageRootLoader: async () =>
      (await loadCachedInstalledProfile(endpoint.identity.worktreeRoot)).packageRoot,
  });
  await engine.start();
  try {
    await Promise.race([
      options.shutdown ?? processShutdown(),
      requestedShutdown.promise,
    ]);
  } finally {
    await engine.stop();
  }
}

export async function launchAuthorityDaemon(input: {
  projectRoot: string;
  version: string;
}): Promise<AuthorityDaemonLaunch> {
  const endpoint = await discoverAuthorityEndpoint(input.projectRoot);
  const piPeerRuntime = await resolvePiPeerRuntime();
  const logDirectory = path.join(endpoint.stateRoot, "authority");
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const log = await open(path.join(logDirectory, "daemon.log"), "a", 0o600);
  let child: ChildProcess;
  try {
    child = spawn(
      process.execPath,
      [
        ...piPeerRuntime.nodeArguments,
        fileURLToPath(new URL("../cli.js", import.meta.url)),
        "authority",
        "serve",
        "--root",
        endpoint.identity.worktreeRoot,
      ],
      {
        cwd: endpoint.identity.worktreeRoot,
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        env: authorityDaemonEnvironment(piPeerRuntime.environment),
      },
    );
  } finally {
    await log.close();
  }
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.unref();
  return { ...(child.pid === undefined ? {} : { pid: child.pid }), exited };
}

function authorityDaemonEnvironment(
  piEnvironment: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...piEnvironment,
    KONI_AUTHORITY_DAEMON: "1",
  };
  // The exact peer bridge is an argv preload above. Never forward ambient Node injection into the
  // authority process, even when the interactive launcher itself was started through NODE_OPTIONS.
  for (const name of ["NODE_OPTIONS", "NODE_PATH", "NPM_CONFIG_NODE_OPTIONS", "NODE_INSPECT_RESUME_ON_START"]) {
    delete environment[name];
  }
  return environment;
}

export async function createProjectRun(options: {
  projectRoot: string;
  version: string;
  objective: string;
  runTypeId: string;
  targetRef: string;
  intake?: Record<string, string>;
}, dependencies: {
  ensure?: typeof ensureProjectAuthority;
  loadModels?: typeof loadSealedPiModelCatalog;
} = {}): Promise<{ runId: string; status: string }> {
  const client = await (dependencies.ensure ?? ensureProjectAuthority)({
    projectRoot: options.projectRoot,
    version: options.version,
    client: "cli",
  });
  try {
    const catalogResponse = await client.request("control.catalog");
    const catalog = parseControlCatalog(catalogResponse.result);
    const runType = catalog.runTypes.find((candidate) => candidate.id === options.runTypeId);
    if (runType === undefined) {
      throw new AuthorityBootstrapError(
        "run_type",
        `configured run type ${options.runTypeId} is not available`,
      );
    }
    const models = await (dependencies.loadModels ?? loadSealedPiModelCatalog)();
    assertSealedModelAdmission(runType.roles, models);
    const response = await client.request(
      "run.create",
      {
        objective: options.objective,
        runTypeId: options.runTypeId,
        targetRef: normalizeTargetRef(options.targetRef),
        intake: options.intake ?? { goal: options.objective },
      },
      {
        expectedRevision: client.revision,
        idempotencyKey: `operator-run-create:${randomUUID()}`,
      },
    );
    return parseRunCreation(response);
  } finally {
    client.close();
  }
}

export interface LegacyRunAdoptionCatalog {
  protocol: "koni.legacy-run-adoption-catalog.v1";
  migrationId: string;
  projectRoot: string;
  sourceRetained: true;
  runs: Array<Record<string, unknown>>;
}

export interface LegacyRunAdoptionResult {
  migrationId: string;
  sourceRunId: string;
  successorRunId: string;
  status: "adopted_paused" | "already_adopted";
  phase: string;
  sourceRetained: true;
}

/** Preview exact legacy evidence without mutating source, Git, or authority state. */
export async function previewProjectLegacyRunAdoption(options: {
  projectRoot: string;
  version: string;
  migrationId: string;
  runId?: string;
}): Promise<LegacyRunAdoptionCatalog> {
  const client = await ensureProjectAuthority({
    projectRoot: options.projectRoot,
    version: options.version,
    client: "cli",
  });
  try {
    const response = await client.request("migration.legacy.preview", {
      migrationId: options.migrationId,
      ...(options.runId === undefined ? {} : { runId: options.runId }),
    });
    return parseLegacyRunAdoptionCatalog(response);
  } finally {
    client.close();
  }
}

/** Atomically register one paused current successor. This does not start a provider turn. */
export async function adoptProjectLegacyRun(options: {
  projectRoot: string;
  version: string;
  migrationId: string;
  runId: string;
}): Promise<LegacyRunAdoptionResult> {
  const client = await ensureProjectAuthority({
    projectRoot: options.projectRoot,
    version: options.version,
    client: "cli",
  });
  try {
    const response = await client.request(
      "migration.legacy.adopt",
      { migrationId: options.migrationId, runId: options.runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: `operator-legacy-adopt:${options.migrationId}:${options.runId}`,
      },
    );
    return parseLegacyRunAdoptionResult(response);
  } finally {
    client.close();
  }
}

/** Explicitly resume a paused current run, including a newly adopted successor. */
export async function resumeProjectRun(options: {
  projectRoot: string;
  version: string;
  runId: string;
}): Promise<{ runId: string; status: string }> {
  const client = await ensureProjectAuthority({
    projectRoot: options.projectRoot,
    version: options.version,
    client: "cli",
  });
  try {
    const response = await client.request(
      "run.resume",
      { runId: options.runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: `operator-run-resume:${options.runId}:${randomUUID()}`,
      },
    );
    return parseRunCreation(response);
  } finally {
    client.close();
  }
}

async function connectIfRunning(options: {
  projectRoot: string;
  version: string;
  client: ProtocolHandshake["client"];
  connectTimeoutMs?: number;
}): Promise<AuthorityClient | undefined> {
  try {
    return await AuthorityClient.connect({
      projectRoot: options.projectRoot,
      client: options.client,
      version: options.version,
      connectTimeoutMs: options.connectTimeoutMs ?? 750,
    });
  } catch (error) {
    if (authorityUnavailable(error)) return undefined;
    throw error;
  }
}

function authorityUnavailable(error: unknown): boolean {
  if (error instanceof AuthorityClientError) {
    return error.code === "connect_timeout" || error.code === "closed";
  }
  if (error instanceof Error && "code" in error) {
    return new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"]).has(
      String((error as NodeJS.ErrnoException).code),
    );
  }
  return false;
}

function parseProjectStatus(response: RpcSuccess): NonNullable<ProjectAuthorityStatus["authority"]> {
  if (!isRecord(response.result)) throw new AuthorityBootstrapError("authority_status", "authority returned invalid status");
  const result = response.result as unknown as Record<string, unknown>;
  const { version, revision, runCount } = result;
  if (
    typeof version !== "string" ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    typeof runCount !== "number" ||
    !Number.isSafeInteger(runCount)
  ) throw new AuthorityBootstrapError("authority_status", "authority returned invalid status");
  return { version, revision, runCount };
}

function parseRunCreation(response: RpcSuccess): { runId: string; status: string } {
  const result = response.result as unknown;
  if (
    !isRecord(result) ||
    typeof result.runId !== "string" ||
    typeof result.status !== "string"
  ) throw new AuthorityBootstrapError("run_create", "authority returned an invalid run creation response");
  return { runId: result.runId, status: result.status };
}

function parseLegacyRunAdoptionCatalog(response: RpcSuccess): LegacyRunAdoptionCatalog {
  const result = response.result as unknown;
  if (
    !isRecord(result) ||
    result.protocol !== "koni.legacy-run-adoption-catalog.v1" ||
    typeof result.migrationId !== "string" ||
    typeof result.projectRoot !== "string" ||
    result.sourceRetained !== true ||
    !Array.isArray(result.runs) ||
    !result.runs.every(isRecord)
  ) {
    throw new AuthorityBootstrapError(
      "legacy_adoption_preview",
      "authority returned an invalid legacy adoption catalog",
    );
  }
  return result as unknown as LegacyRunAdoptionCatalog;
}

function parseLegacyRunAdoptionResult(response: RpcSuccess): LegacyRunAdoptionResult {
  const result = response.result as unknown;
  if (
    !isRecord(result) ||
    typeof result.migrationId !== "string" ||
    typeof result.sourceRunId !== "string" ||
    typeof result.successorRunId !== "string" ||
    (result.status !== "adopted_paused" && result.status !== "already_adopted") ||
    typeof result.phase !== "string" ||
    result.sourceRetained !== true
  ) {
    throw new AuthorityBootstrapError(
      "legacy_adoption_apply",
      "authority returned an invalid legacy adoption result",
    );
  }
  return result as unknown as LegacyRunAdoptionResult;
}

function parseQuiesceResult(response: RpcSuccess): string[] {
  if (!isRecord(response.result) || response.result.status !== "quiesced" ||
      !Array.isArray(response.result.pausedRunIds) ||
      !response.result.pausedRunIds.every((value) => typeof value === "string")) {
    throw new AuthorityBootstrapError("authority_quiesce", "authority returned an invalid quiesce response");
  }
  return [...response.result.pausedRunIds];
}

function normalizeTargetRef(value: string): string {
  if (value.startsWith("refs/heads/")) return value;
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,255}$/u.test(value) || value.includes("..")) {
    throw new AuthorityBootstrapError("target_ref", "target branch is not a safe branch name");
  }
  return `refs/heads/${value}`;
}

function processShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("SIGHUP", stop);
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; });
  return { promise, resolve };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
